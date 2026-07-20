// Policy for reclaiming a plain (no-Option) mouse drag in the terminal as a TEXT SELECTION
// instead of forwarding it to a mouse-tracking TUI (Claude Code).
//
// While a TUI has xterm mouse reporting on, xterm disables its SelectionService and forwards drags
// to the PTY, so a plain drag can't select and the actions popup never fires. The stock escape
// hatch is Option-drag (xterm's `macOptionClickForcesSelection` + altKey). This policy widens that:
// when the composer is OPEN we reclaim any plain drag as a selection ("Sparkle mode"); when the
// composer is CLOSED we leave drags alone so they reach the TUI ("closed = working with the TUI").
// Option-drag still force-selects in either state — that path is handled by xterm itself, so this
// function only needs to describe the *extra* no-Option reclaim.
//
// Consumed by the `shouldForceSelection` monkey-patch in Terminal.tsx.
export function shouldReclaimPlainDrag(
  composerFeatureOn: boolean,
  composerMinimized: boolean,
): boolean {
  return composerFeatureOn && !composerMinimized;
}
