// Orchestrates "open this project" — routes to focus-existing / new-window / replace-current.
// The Tauri surface is injected via ProjectWindowDeps so the routing logic unit-tests without
// a webview. defaultDeps() wires the real Tauri APIs.
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { projectWindowUrl } from "./projectWindows.url";
import { clearWindowProject, findWindowForProject, setWindowProject } from "./windowRegistry";
import { flushProjectsPersist, useProjectStore } from "../stores/projectStore";

export type OpenMode = "replace" | "new";

/** Optional LOGICAL-pixel geometry for a newly created window. Used by session restore to reopen a
 *  window where the user left it (); omitted for a normal "open in new window", which
 *  takes the default size/position. */
export interface WindowGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Prefix for runtime-created (secondary) window labels. MUST stay covered by a glob in
 *  src-tauri/capabilities/default.json's `windows` list — a window whose label matches no
 *  capability gets ZERO permissions in Tauri v2, so invoke()/listen() silently fail (mic +
 *  PTY/agent break). The label is otherwise opaque (decoupled from the project id). */
export const WINDOW_LABEL_PREFIX = "win-";

/** Title for a window showing this project: the trimmed name, falling back to "Sparkle" when
 *  absent or blank so the macOS Window menu never gets an unlabeled entry. Shared by the
 *  initial-title path below and Workspace's setTitle effect so the fallback can't drift. */
export function windowTitleFor(name?: string | null): string {
  return name?.trim() || "Sparkle";
}

interface FocusableWindow {
  show(): Promise<void>;
  unminimize(): Promise<void>;
  setFocus(): Promise<void>;
}

export interface ProjectWindowDeps {
  getByLabel(label: string): Promise<FocusableWindow | null>;
  /** Create a fresh window for the project. Owns generating the window's opaque label and
   *  registering it (labels are decoupled from project ids — see projectWindows.url). When
   *  `agentId` is given, the new window deep-links to that agent on mount. When `geometry` is given
   *  (session restore), the window opens at that logical size/position instead of the default. */
  createWindow(projectId: string, agentId?: string, geometry?: WindowGeometry): void;
  currentLabel(): string;
  registry: {
    find(projectId: string): string | null;
    set(label: string, projectId: string): void;
    clear(label: string): void;
  };
  replaceCurrent(projectId: string): void;
  touchOpened(projectId: string): void;
}

export async function openProjectInWindow(
  projectId: string,
  mode: OpenMode,
  deps: ProjectWindowDeps,
  agentId?: string,
): Promise<"focused" | "replaced" | "created"> {
  // 1) Already open somewhere? Focus that window regardless of mode.
  const existingLabel = deps.registry.find(projectId);
  if (existingLabel) {
    const win = await deps.getByLabel(existingLabel);
    if (win) {
      // The target may be a hidden last window (kept alive on "keep agents running"):
      // show() first so a hidden window is actually revealed, then unminimize + focus.
      await win.show().catch(() => {});
      await win.unminimize().catch(() => {});
      await win.setFocus().catch(() => {});
      // Bringing it to the front counts as opening it — keep Recent ordering consistent with
      // the new/replace paths (which also bump lastOpenedAt).
      deps.touchOpened(projectId);
      return "focused";
    }
    // Stale registry entry (window gone, e.g. crash/force-quit bypassed our close handler) —
    // evict it so we don't pay a dead getByLabel round-trip on every future open, then fall
    // through to open the project fresh.
    deps.registry.clear(existingLabel);
  }

  // 2) New window. createWindow owns the opaque label + registry.set, so the "new" path can
  // never collide with an existing label (a window's label is independent of its project).
  if (mode === "new") {
    deps.createWindow(projectId, agentId);
    // Opening in a new window is still opening it — bump recency like the focus/replace paths.
    // (Recency is intentionally NOT broadcast cross-window — see crossWindowSync's signature():
    // lastOpenedAt is excluded, so other windows' Recent ordering stays put until their next
    // structural change. Liveness-only, acceptable.)
    deps.touchOpened(projectId);
    return "created";
  }

  // 3) Replace the current window's project in place.
  deps.replaceCurrent(projectId);
  deps.registry.set(deps.currentLabel(), projectId);
  deps.touchOpened(projectId);
  return "replaced";
}

/** Create a fresh project window (real Tauri path). Owns generating the opaque label + registering
 *  it, flushing the projects blob so the child hydrates synchronously, and titling the window. Used
 *  by both the normal "open in new window" flow (defaultDeps) and session restore, which passes
 *  `geometry` to reopen where the user left it and `suppressFocus` for every window except the one
 *  it will explicitly focus. */
export function createProjectWindow(
  projectId: string,
  agentId?: string,
  geometry?: WindowGeometry,
  suppressFocus = false,
): void {
  // Opaque, collision-proof label (decoupled from the project id). Register it before/with
  // creation so a concurrent open finds it; on a creation failure ('tauri://error') evict the
  // entry so a later open doesn't focus a window that never came up.
  const label = `${WINDOW_LABEL_PREFIX}${crypto.randomUUID()}`;
  setWindowProject(label, projectId);
  // Flush the debounced projects blob to real localStorage BEFORE the child boots, so its
  // zustand `persist` hydration reads a snapshot that already contains this just-created project
  // and resolves synchronously — otherwise the child can hydrate a stale blob and briefly (or,
  // pre-recovery-effect, permanently) show "No project open" under its project-named title.
  flushProjectsPersist();
  // Title the window after its project so the macOS Window menu is navigable with several
  // windows open. Workspace keeps the title in sync after mount (rename/Replace); this just
  // avoids a "Sparkle" flash before that effect runs.
  const projectName = useProjectStore.getState().projects.find((p) => p.id === projectId)?.name;
  const win = new WebviewWindow(label, {
    url: projectWindowUrl(projectId, label, agentId, suppressFocus),
    title: windowTitleFor(projectName),
    // Session restore supplies logical geometry so the window reopens where the user left it
    // (WebviewWindow options are logical pixels); otherwise fall back to the default size. The
    // position is only set when restoring — a default-opened window centers via the OS.
    width: geometry?.width ?? 1200,
    height: geometry?.height ?? 800,
    ...(geometry ? { x: geometry.x, y: geometry.y } : {}),
    minWidth: 900,
    minHeight: 600,
  });
  win
    .once("tauri://error", (e) => {
      console.error("Failed to create project window", label, e.payload);
      clearWindowProject(label);
    })
    // A rejected once() registration (ACL/teardown race) must not surface as an uncaught
    // rejection. Swallow + debug-log: worst case we miss the creation-failure eviction for
    // this label, which a later open self-heals — far better than an unhandled rejection.
    .catch((err) => console.debug("project-window error-listener registration failed", label, err));
}

/** Real Tauri-backed deps. `replaceCurrent`/`touchOpened`/`currentLabel` come from the caller
 *  (they need the window context + store). */
export function defaultDeps(
  replaceCurrent: (projectId: string) => void,
  touchOpened: (projectId: string) => void,
  currentLabel: string,
): ProjectWindowDeps {
  return {
    getByLabel: (label) => WebviewWindow.getByLabel(label),
    createWindow: (projectId, agentId, geometry) => createProjectWindow(projectId, agentId, geometry),
    currentLabel: () => currentLabel,
    registry: {
      find: (pid) => findWindowForProject(pid),
      set: (label, pid) => setWindowProject(label, pid),
      clear: (label) => clearWindowProject(label),
    },
    replaceCurrent,
    touchOpened,
  };
}
