// Vimium-style keyboard hints: the trigger state machine for a "tap a modifier" gesture.
//
// The overlay toggles on a CLEAN tap of the configured modifier (default Control) — pressed and
// released with no other key in between. Holding the modifier and pressing any other key (a chord
// like ⌘J / Ctrl+C / Cmd+Tab) is NOT a tap, so it must never toggle the overlay. This reducer
// isolates exactly that distinction; it is pure (no DOM, no timers) so the gnarly tap-vs-chord
// logic is unit-tested directly. The target modifier is a parameter so it works for any of
// Control/Meta/Alt/Shift (the configurable hint trigger).

export type TriggerState = {
  // The target modifier is currently held down.
  modDown: boolean;
  // The modifier went down and nothing else has been pressed since — a tap is still possible.
  tapCandidate: boolean;
};

export const INITIAL_TRIGGER: TriggerState = { modDown: false, tapCandidate: false };

export type TriggerEvent =
  | { type: "keydown"; key: string }
  | { type: "keyup"; key: string };

export type TriggerOutput = {
  state: TriggerState;
  // True exactly when a clean tap of `modifier` just completed (caller toggles the overlay).
  tapped: boolean;
};

/** `modifier` is the target key's `KeyboardEvent.key` ("Control" | "Meta" | "Alt" | "Shift"). */
export function reduceTrigger(s: TriggerState, e: TriggerEvent, modifier: string = "Meta"): TriggerOutput {
  if (e.type === "keydown") {
    if (e.key === modifier) {
      // Arm a fresh tap candidate. (Auto-repeat keydowns while held keep it armed — harmless.)
      return { state: { modDown: true, tapCandidate: true }, tapped: false };
    }
    // Any other key cancels the candidate: with the modifier held it's a chord; without, typing.
    return { state: { ...s, tapCandidate: false }, tapped: false };
  }
  // keyup
  if (e.key === modifier) {
    const tapped = s.modDown && s.tapCandidate;
    return { state: INITIAL_TRIGGER, tapped };
  }
  return { state: s, tapped: false };
}
