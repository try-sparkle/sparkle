// Route "Improve Sparkle" clicks. Improve Sparkle used to be a main-window-only singleton pane, so
// a click from any other window had to focus the main window and broadcast a reveal request there —
// yanking the user out of whatever project they were in. It is now PER-WINDOW: every window runs its
// own independent copy (its own worktree/branch/conversation off the single app-owned OSS clone, keyed
// by sparkleAgentIdFor(windowLabel)), so a click simply reveals the pane IN PLACE in the current
// window. No cross-window focus or broadcast is involved anymore.

export interface ImproveSparkleClickDeps {
  /** Reveal the pane in THIS window: setActiveSpecial("sparkle") + open(sparkleAgentIdFor(label)). */
  activateLocal: () => void;
}

/** Route an "Improve Sparkle" sidebar click: reveal this window's own Sparkle copy in place. */
export function handleImproveSparkleClick(deps: ImproveSparkleClickDeps): void {
  deps.activateLocal();
}
