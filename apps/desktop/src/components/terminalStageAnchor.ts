// Geometry for things that float over an agent's terminal stage (AgentPane's `position: relative`
// wrapper around the xterm canvas). Pure and separately importable so the concierge-owned action
// pill can anchor itself into that stage without importing AgentPane — the pane pulls in the whole
// spawn/worktree/preflight tree, which has no business in the concierge's module graph.

import type { CSSProperties } from "react";

/** Inner padding of the terminal stage (AgentPane renders the terminal inset by this much). */
export const TERMINAL_STAGE_PADDING = 6;

/** Breathing room between the pill and the terminal's own text, on top of the stage padding. */
export const TERMINAL_OVERLAY_GAP = 8;

/**
 * Where the recommended-action pill sits: bottom-right of the terminal stage, so it lands on the
 * CLI's own input line rather than in the middle of the transcript.
 *
 * Returns a ZERO-HEIGHT rail, not a box, and that is load-bearing. `SuggestionRow`'s "overlay"
 * layout pins itself with `right: 8; top: 50%; translateY(-50%)` — it vertically CENTERS on its
 * positioned ancestor. Against a full-height ancestor that would park the pill in the middle of the
 * terminal; against a rail of height 0 the percentage resolves to 0 and the transform centers the
 * pill on the rail's own line. So we place the rail at the height the pill's centre should have and
 * let the row's existing (and tested) positioning do the rest — no second layout variant to keep in
 * sync with the first two.
 *
 * `pointerEvents: none` matches what the row already does with its own wrapper: the rail spans the
 * full width of the stage, and it must never intercept a click or a selection drag meant for the
 * terminal underneath. The pill itself re-enables pointer events.
 *
 * @param pillHeight rendered height of the pill (SUGGESTION_PILL_HEIGHT), so the bottom EDGE — not
 *        the centre — ends up the intended distance from the stage floor.
 */
export function terminalSuggestionAnchorStyle(pillHeight: number): CSSProperties {
  return {
    position: "absolute",
    left: 0,
    right: TERMINAL_STAGE_PADDING,
    bottom: TERMINAL_STAGE_PADDING + TERMINAL_OVERLAY_GAP + pillHeight / 2,
    height: 0,
    // Above the terminal canvas and its loading/failed overlays (5 and 10 inside the Terminal
    // component) but BELOW the AccountBadge's layer (20), and that ceiling is load-bearing — it is
    // not about the badge button, which is pinned top-right and could never overlap this.
    //
    // When the badge's menu is open it lays a full-screen click-away backdrop (`position: fixed;
    // inset: 0`) INSIDE its own z-20 box, so the backdrop effectively paints at 20 out here. At an
    // equal 20 the tie would be broken by DOM order, and this rail is a PORTAL child appended to
    // the stage — so in the common case it lands last and paints ON TOP of the backdrop with
    // pointer events live. Clicking the pill would then dispatch the recommended action instead of
    // dismissing the menu, and because a click here runs immediately (no countdown, no confirm,
    // destructive commands included) that is not a recoverable misfire. It also made paint order
    // depend on when `accounts` resolved, i.e. nondeterministic. Staying under 20 fixes both.
    zIndex: 15,
    pointerEvents: "none",
  };
}
