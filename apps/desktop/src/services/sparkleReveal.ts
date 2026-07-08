// Route "Improve Sparkle" clicks to the ONE window that can host the Sparkle self-improvement pane.
//
// The pane is a main-window-only singleton: Workspace gates it on `isMainWindow` so the app-owned
// `claude` (which clones + works on the OSS Sparkle repo in a single shared worktree) never
// double-mounts across windows. But the "Improve Sparkle" sidebar row is rendered in EVERY window.
// Clicking it from a secondary/project window used to set `activeSpecial="sparkle"` locally, where
// no gated-in pane honors it — a silent no-op that reads as "the button is dead" (bead sparkle-l7kp).
//
// Instead: the main window reveals the pane in place; any other window focuses the main window and
// broadcasts a reveal request, which the main window's listener (onRevealSparkle) acts on. Mirrors
// the broadcast-emit + self-filter idiom of services/attention.ts (emitFocusAgent/onFocusAgent) —
// there is no addressed `emitTo` in this codebase.
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

const hasTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Tauri label of the initial/main window. The initial window in tauri.conf.json declares no
 *  explicit label, so Tauri v2 defaults it to "main" — which is also the windowContext-derived
 *  label (paramLabel ?? "main") and the window-registry key. Secondary windows are "win-<uuid>". */
export const MAIN_WINDOW_LABEL = "main";

/** Broadcast asking the main window to reveal the Sparkle pane. Delivered to every window (incl. the
 *  emitter); only the main window's listener acts on it (see onRevealSparkle + its isMainWindow gate). */
export const SPARKLE_REVEAL_EVENT = "sparkle://reveal-improve";

/** Raise + focus the main window by label: show a hidden last-window, unminimize, then focus — the
 *  same sequence openProjectInWindow uses to surface an existing window. Best-effort (each step is
 *  caught). No-op outside Tauri, or if the main window can't be resolved (never happens in practice:
 *  the initial window is hidden on close, never destroyed). */
export async function focusMainWindow(): Promise<void> {
  if (!hasTauri) return;
  const win = await WebviewWindow.getByLabel(MAIN_WINDOW_LABEL).catch(() => null);
  if (!win) return;
  await win.show().catch(() => {});
  await win.unminimize().catch(() => {});
  await win.setFocus().catch(() => {});
}

/** Ask the main window to reveal the Sparkle pane (global broadcast). No-op outside Tauri. */
export function emitRevealSparkle(): void {
  if (!hasTauri) return;
  void emit(SPARKLE_REVEAL_EVENT).catch((e) => console.debug("emit reveal-sparkle failed", e));
}

/** Subscribe to reveal requests. Gate the callback to the main window at the call site (like
 *  startControlListener) since emit() also reaches the emitter. Returns an unlisten fn (no-op
 *  outside Tauri). */
export function onRevealSparkle(cb: () => void): Promise<UnlistenFn> {
  if (!hasTauri) return Promise.resolve(() => {});
  return listen(SPARKLE_REVEAL_EVENT, () => cb());
}

export interface ImproveSparkleClickDeps {
  /** Whether the clicked row is in the main window (where the singleton pane lives). */
  isMainWindow: boolean;
  /** Reveal the pane in THIS (main) window: setActiveSpecial("sparkle") + open(SPARKLE_AGENT_ID). */
  activateLocal: () => void;
  /** Raise the main window (fire-and-forget wrapper over focusMainWindow). */
  focusMain: () => void;
  /** Broadcast the reveal request (emitRevealSparkle). */
  emitReveal: () => void;
}

/** Route an "Improve Sparkle" sidebar click. Main window → reveal locally. Any other window → the
 *  pane is gated off here, so focus the main window and ask it to reveal Sparkle instead of no-oping. */
export function handleImproveSparkleClick(deps: ImproveSparkleClickDeps): void {
  if (deps.isMainWindow) {
    deps.activateLocal();
    return;
  }
  deps.focusMain();
  deps.emitReveal();
}
