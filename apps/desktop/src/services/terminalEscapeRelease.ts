// THE CABLE'S RESPONSE TO AN ESCAPE TYPED INSIDE A LIVE TERMINAL.
//
// Called from `Terminal.tsx`'s `attachCustomKeyEventHandler`, which is the ONLY layer that sees such a
// press: xterm's own keydown handler calls `cancel(ev, true)` for Escape — `preventDefault()` +
// `stopPropagation()` — so the event never reaches `Workspace`'s `window` listener. The first version
// of this feature lived in that listener and was therefore unreachable (roborev 55722); the policy
// itself is unchanged, only the layer that drives it.
//
// THE BYTE STILL GOES TO THE PTY. The caller returns `true` after this, so xterm proceeds exactly as
// before and vim still leaves insert mode, `less` still dismisses, Claude Code still interrupts. This
// module decides only what the CABLE does alongside that.
//
// Module state rather than a React ref, because the caller is a long-lived xterm callback rather than a
// component body, and because the toll is a property of the WINDOW's gesture rather than of any one
// pane — moving the caret between two terminals should not hand the user a free press.
import { releaseStillArmed, unbindsOnKey } from "../engine/cable";
import { terminalEscapeAction } from "../engine/terminalEscape";
import { useCableStore } from "../stores/cableStore";
import { terminalFocusWasDeliberate } from "./terminalFocusIntent";

/** When the one-press toll was paid, or null. A timestamp so it EXPIRES — see `releaseStillArmed`. */
let tollPaidAt: number | null = null;

/** End the in-terminal gesture. Called for the same events that end the cable's own release ladder. */
export function clearTerminalEscapeToll(): void {
  tollPaidAt = null;
}

/** Test seam. */
export function terminalEscapeTollPaid(now: number): boolean {
  return releaseStillArmed(tollPaidAt, now);
}

export interface TerminalEscapeContext {
  /** Is a surface that treats Escape as "close me" open? Same probe the `window` path uses. */
  dismissibleOpen?: boolean;
  /** Injectable clock, for tests. */
  now?: number;
}

/**
 * Handle an Escape pressed inside a live terminal. Returns what it did, for tests and callers that want
 * to log it; the caller must still let the key through to the PTY.
 *
 * ══ ONE PREDICATE, NOT TWO ══════════════════════════════════════════════════════════════════════
 * `unbindsOnKey` — and ONLY `unbindsOnKey`, exactly as rung 1 does. An earlier version also declined on
 * `defaultPrevented`, which re-forked the rule it was added to unify: the `window` path unbinds
 * regardless of that flag and gates only rung 2's ARMING on it ("Unbinding still happens either way:
 * rung 1's reach is behavior the founder has confirmed"). It was also unreachable here — this runs from
 * xterm's textarea keydown listener, in the TARGET phase, before every bubble-phase listener that could
 * have prevented it — so the branch could never be true and no test could falsify it. A guard that
 * cannot fire is the vacuous shape this branch has spent three rounds removing, so it is gone.
 *
 * Skipping the shared predicate forked the
 * rule: this path released on ANY Escape reaching a focused xterm, while the other declined for an open
 * dialog/menu or an already-claimed press. That divergence is worse in a terminal than anywhere else,
 * because xterm cancels propagation — so a surface's own window-level Escape handler never fires, and an
 * Escape aimed at an open menu silently dropped the cable while leaving the menu up. `engine/cable`'s
 * header says the rule lives in the reducer and nowhere else; sharing only the ACTION and not the
 * PREDICATE was not honouring that.
 *
 * NO-OP WHEN NOTHING IS PATCHED. With no cable there is nothing to release, so the press is purely the
 * process's and the toll must not be charged either — otherwise a user who pressed Escape in a terminal
 * while unwired would find their FIRST press after patching already spent.
 */
export function noteTerminalEscape(
  ctx: TerminalEscapeContext = {},
): "process-only" | "release" | "inert" {
  const { dismissibleOpen = false, now = Date.now() } = ctx;
  const cable = useCableStore.getState();
  // THE SHARED PREDICATE. `unbindsOnKey` already answers "is there a cable, and is this press ours" —
  // including the unwired case, so this one test replaces the separate `wired === "off"` branch.
  if (!unbindsOnKey(cable, "Escape", { dismissibleOpen })) {
    tollPaidAt = null;
    return "inert";
  }
  const action = terminalEscapeAction({
    deliberate: terminalFocusWasDeliberate(),
    tollPaid: releaseStillArmed(tollPaidAt, now),
  });
  if (action === "process-only") {
    tollPaidAt = now;
    return "process-only";
  }
  tollPaidAt = null;
  // The store's own action, not a hand-rolled `setState`: both unbind gestures already go through
  // exactly this, and `engine/cable`'s header is explicit that every rule lives in the reducer and
  // nowhere else. A second way to unbind is a second place for the rule to drift.
  cable.unbind();
  return "release";
}
