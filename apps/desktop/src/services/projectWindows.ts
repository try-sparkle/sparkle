// Orchestrates "open this project" — routes to focus-existing / new-window / replace-current.
// The Tauri surface is injected via ProjectWindowDeps so the routing logic unit-tests without
// a webview. defaultDeps() wires the real Tauri APIs.
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { projectWindowUrl } from "./projectWindows.url";
import { clearWindowProject, findWindowForProject, setWindowProject } from "./windowRegistry";

export type OpenMode = "replace" | "new";

/** Prefix for runtime-created (secondary) window labels. MUST stay covered by a glob in
 *  src-tauri/capabilities/default.json's `windows` list — a window whose label matches no
 *  capability gets ZERO permissions in Tauri v2, so invoke()/listen() silently fail (mic +
 *  PTY/agent break). The label is otherwise opaque (decoupled from the project id). */
export const WINDOW_LABEL_PREFIX = "win-";

interface FocusableWindow {
  show(): Promise<void>;
  unminimize(): Promise<void>;
  setFocus(): Promise<void>;
}

export interface ProjectWindowDeps {
  getByLabel(label: string): Promise<FocusableWindow | null>;
  /** Create a fresh window for the project. Owns generating the window's opaque label and
   *  registering it (labels are decoupled from project ids — see projectWindows.url). When
   *  `agentId` is given, the new window deep-links to that agent on mount. */
  createWindow(projectId: string, agentId?: string): void;
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

/** Real Tauri-backed deps. `replaceCurrent`/`touchOpened`/`currentLabel` come from the caller
 *  (they need the window context + store). */
export function defaultDeps(
  replaceCurrent: (projectId: string) => void,
  touchOpened: (projectId: string) => void,
  currentLabel: string,
): ProjectWindowDeps {
  return {
    getByLabel: (label) => WebviewWindow.getByLabel(label),
    createWindow: (projectId, agentId) => {
      // Opaque, collision-proof label (decoupled from the project id). Register it before/with
      // creation so a concurrent open finds it; on a creation failure ('tauri://error') evict the
      // entry so a later open doesn't focus a window that never came up.
      const label = `${WINDOW_LABEL_PREFIX}${crypto.randomUUID()}`;
      setWindowProject(label, projectId);
      const win = new WebviewWindow(label, {
        url: projectWindowUrl(projectId, label, agentId),
        title: "Sparkle",
        width: 1200,
        height: 800,
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
    },
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
