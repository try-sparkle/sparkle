// Whether the single recommended-action pill should be shown over the composer.
//
// It shows only while the composer is EMPTY (no typed text, no attachments) and there is no
// live interim-speech preview. Crucially it does NOT gate on the mic being hot (`liveActive`):
// a parked cursor with the mic listening but nothing said yet must still show the button — it
// should vanish only on ACTUAL content (interim speech, which sets `interimActive`, or typed
// text, which flips `composerEmptyNow` false).
export function suggestionRowVisible(composerEmptyNow: boolean, interimActive: boolean): boolean {
  return composerEmptyNow && !interimActive;
}
