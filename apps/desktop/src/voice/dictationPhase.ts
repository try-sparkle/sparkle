// IS THE MICROPHONE ROUTING SPEECH RIGHT NOW — the one bit every voice surface reads, and the one
// the send tray writes.
//
// ── WHAT THIS USED TO MEAN, AND WHY THE NAME SURVIVED THE WAKE WORD ─────────────────────────────
// This type lived in `voice/wakeMachine.ts`, and "active" meant *the wake word was heard*. The wake
// word is gone (the founder: "We're no longer doing the wake word. We now have push to talk or
// speak buttons; SPEAK SHOULD BE ALWAYS ON"), so the phase has exactly one writer left: the mic
// intent the three-position send tray applies (`voice/sendMode` micIntentForMode / pttHeldIntent,
// via components/MicButton `useMicActions`).
//
//   Speak            → setActive() → ACTIVE for as long as the tray sits there. That IS "always on".
//   Push to talk     → setMuted()  → PASSIVE at rest, ACTIVE for the duration of a hold.
//   Send             → setOff()    → the mic is released; the phase is irrelevant.
//
// THE VALUES ARE DELIBERATELY UNCHANGED. `phase` is a PERSISTED, CROSS-WINDOW-SYNCED slice of
// `stores/dictationStore`, so renaming the strings would strand every installed client's stored
// value on an identifier nothing reads. The meaning is re-documented here instead — which is the
// whole reason this module exists rather than the type being inlined somewhere: several files
// (MicButton, micPresentation, dictationStore, inputFreezeTrace) imported it from the wake machine,
// and they need a home that is about the microphone rather than about a matcher that is gone.
//
// ── THE PROPERTY THIS BUYS ──────────────────────────────────────────────────────────────────────
// Nothing moves the phase behind the user's back any more. The wake matcher used to flip it from a
// spoken phrase with no gesture anywhere, which is the root of the whole family of "the ring says
// one thing and the caption beside it says the opposite" defects that voice/micPresentation was
// written to delete — saying "Hey Sparkle" in Push to talk turned the mic glyph green under a tray
// that still read "Push to talk". With the tray as the only writer, the position and the phase
// cannot disagree, because one is computed from the other.

/** Is the armed microphone actually routing speech right now?
 *
 *  - `"active"`  — speech is being transcribed into a destination (composer or focused terminal).
 *  - `"passive"` — the mic is armed but routing nothing: Push to talk between holds.
 *
 *  A DISARMED mic (`dictationStore.enabled === false`) has no meaningful phase; surfaces ask
 *  `enabled` first. See `voice/micPresentation` for the precedence every surface renders from. */
export type Phase = "passive" | "active";
