// The ONE store-reading step behind "why is the mic paused", for the surfaces that render words
// about it. Same shape and same reasoning as useVoicePlaceholder: every surface reads the reason
// HERE, from the store, through the one pure decision (dictationPauseReason) — never by
// re-deriving it locally. A second derivation path is exactly how the "sidebar says one thing, the
// composer says another" desync comes back, and this state is now the thing they'd disagree about.
//
// It reads only; it decides nothing.
import { useDictationStore } from "../stores/dictationStore";
import { dictationPauseReason, type PauseReason } from "./dictationFocus";

/** WHY dictation is paused for this window right now, or null when it isn't. Reactive: the focus
 *  tracker (voice/dictationFocusTracker) writes the two observations this reduces. */
export function useDictationPauseReason(): PauseReason | null {
  const windowFocused = useDictationStore((s) => s.windowFocused);
  const focusOwner = useDictationStore((s) => s.focusOwner);
  // `enabled`, not `status`: a mic the user switched OFF is off, not paused — see
  // dictationPauseReason. Which of "off" vs "paused" a surface actually paints is
  // deriveMicPresentation's call; this only supplies the reason for the paused case.
  const enabled = useDictationStore((s) => s.enabled);
  return dictationPauseReason({ windowFocused, focusOwner, enabled });
}
