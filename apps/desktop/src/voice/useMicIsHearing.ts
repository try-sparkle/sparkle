// "Is the mic actually hearing the user right now?", read the way every surface must read it.
//
// The two device-name surfaces (BoundDeviceCaption under the waveform, and the picker's own caption
// in the mic menu) both need this one bit to choose a verb — "Listening: Yeti" vs "Mic: Yeti". Each
// subscribing to `status === "listening"` on its own is precisely what micPresentation.ts warns
// against: `status` is optimistic and per-window, and it stays "listening" through the `error` and
// `preparing` presentations. That produced a caption asserting a live capture directly beneath a
// notice saying voice had failed (roborev 55289).
//
// A hook rather than a second pure function because the inputs are a store snapshot, and the whole
// point is that both surfaces read the SAME snapshot through the SAME derivation. The pure half
// (deriveMicPresentation / micIsHearing) stays in micPresentation.ts and is unit-tested there.
import { useDictationStore } from "../stores/dictationStore";
import { useDictationPauseReason } from "./useDictationPauseReason";
import { deriveMicPresentation, micIsHearing } from "./micPresentation";
import { voiceErrorNotice } from "./dictationCopy";

export function useMicIsHearing(): boolean {
  const enabled = useDictationStore((s) => s.enabled);
  const status = useDictationStore((s) => s.status);
  const phase = useDictationStore((s) => s.phase);
  const modelProgress = useDictationStore((s) => s.modelProgress);
  const error = useDictationStore((s) => s.error);
  const outOfCreditsNotice = useDictationStore((s) => s.outOfCreditsNotice);
  const pauseReason = useDictationPauseReason();
  // `hasError` is "is there a notice to show", not "is the string non-empty" — the same test the
  // rendering surfaces apply, so an unrenderable error can't silently count as one here.
  return micIsHearing(
    deriveMicPresentation({
      enabled,
      status,
      phase,
      modelProgress,
      hasError: voiceErrorNotice(error) !== null,
      outOfCreditsNotice,
      // The device caption's verb hangs off this, and it is rendered two lines under the sidebar's
      // own caption — so without the pause term it printed "Listening: Yeti" beneath a freshly
      // demoted "Listening paused", the exact re-assertion its own doc forbids (roborev 57117/55289).
      pauseReason,
    }),
  );
}
