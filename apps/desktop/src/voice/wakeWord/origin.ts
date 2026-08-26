// WHERE A TRANSCRIPT CAME FROM — the fact the wake-word module was missing, and the reason its
// on-device guarantee was previously an argument rather than a control (bead `sparkle-uz87.3`).
//
// ══ THE HOLE THIS CLOSES ════════════════════════════════════════════════════════════════════════
// `detector.ts` argues that "listens in the background without sending audio to the cloud" is
// STRUCTURAL, because that file performs no I/O: no microphone, no socket, no model call. Every
// clause of that is true and none of it establishes the guarantee. The detector's only input is
// TEXT, and in this app text is produced by two entirely different machines:
//
//   • ON-DEVICE — sherpa-onnx, running in the Rust process (`src-tauri/src/dictation.rs`,
//     `transcribe.rs`, `model.rs`). Audio never leaves the machine.
//   • CLOUD — Deepgram, reached over a websocket (`useDictation.ts`, `stores/dictationEngineStore.ts`,
//     the `/ai/deepgram` handshake). Raw audio is streamed off the machine to get that text.
//
// So for the detector to hear anything by way of the second path, the audio has ALREADY been sent to
// the cloud before `feed` is ever called. "This file sends no audio" is not "no audio was sent" — the
// sending happened upstream, and a downstream module auditing only itself cannot see it. That is the
// whole defect: the guarantee was being made by the one component structurally unable to check it.
//
// ══ WHAT REPLACES THE ARGUMENT ══════════════════════════════════════════════════════════════════
// A discriminator that travels WITH the text, so the question "was this heard on-device?" has an
// answer at the moment the detector is deciding whether to wake, instead of being inferred from a
// comment three files away. The gate lives in `./onDeviceDetector`; this file is only the vocabulary
// and the one predicate that reads it.
//
// ══ WHY THE PREDICATE IS AN ALLOWLIST OF EXACTLY ONE ════════════════════════════════════════════
// `isOnDeviceOrigin` asks "is this the permitted value", never "is this one of the forbidden ones".
// The two look interchangeable while the union has three members and stop being interchangeable the
// moment someone adds a fourth: a denylist (`origin !== "cloud"`) silently ADMITS every variant
// invented after it was written, which is precisely how a privacy gate rots without a test going
// red. Asking for the single permitted value fails closed against the entire open set of everything
// else — present, future, absent and malformed alike — with no maintenance.
//
// ABSENCE IS NOT PERMISSION. `undefined`, `null`, `""` and a caller who simply forgot the argument
// are all refused, and this is the case that matters most in practice: a call site that never
// considered the question is exactly the call site most likely to be feeding cloud text. The
// TypeScript signature makes the argument mandatory so that omission is a compile error, and the
// runtime predicate refuses it anyway, because types are erased and this module's whole job is to
// hold a guarantee that survives an untyped caller.

/**
 * Which machine turned audio into this text.
 *
 * - `"on-device"` — a local ASR (this repo's sherpa-onnx path). Audio never left the machine.
 * - `"cloud"` — a hosted ASR (this repo's Deepgram path). Raw audio was streamed off the machine.
 * - `"unknown"` — nobody established which. Deliberately NOT a synonym for on-device: an
 *   unanswered question about where audio went is a "no" for a privacy gate, and naming the state
 *   is better than letting callers express it by omitting the argument.
 */
export type TranscriptOrigin = "on-device" | "cloud" | "unknown";

/**
 * The only origin an origin-gated detector will ever act on.
 *
 * Exported so a call site can name the value rather than retyping the string literal — a typo in a
 * hand-written `"on-device"` is refused (correctly, fails closed) but presents as "the wake word
 * silently does nothing", which is an expensive way to learn about a typo.
 */
export const ON_DEVICE_ORIGIN = "on-device" as const;

/**
 * Every origin the union can express, for tests and for any surface that needs to enumerate them.
 *
 * This is NOT what the gate consults — see the header on why the gate is an allowlist of one rather
 * than a membership test against this array.
 */
export const TRANSCRIPT_ORIGINS: readonly TranscriptOrigin[] = ["on-device", "cloud", "unknown"];

/**
 * Is this text safe for a wake-word detector that promises the cloud never heard it?
 *
 * Takes `unknown` on purpose: the interesting callers are the ones TypeScript cannot vouch for —
 * a value parsed off the wire, a JS call site, a caller who passed nothing. Everything that is not
 * exactly {@link ON_DEVICE_ORIGIN} is refused, including `"cloud"`, `"unknown"`, `undefined`,
 * `null`, `"on device"`, `"On-Device"` and any object.
 */
export function isOnDeviceOrigin(value: unknown): value is typeof ON_DEVICE_ORIGIN {
  return value === ON_DEVICE_ORIGIN;
}
