// "Listening: MacBook Pro Microphone" — the device line under the sidebar waveform.
//
// This is the answer to the question the nine-minute silent capture left a user unable to ask: the
// mic surfaces all said "listening", and not one of them said WHAT to. It renders from
// `dictation://device` (audioInputStore.bound), which Rust emits on every actual bind — never from
// the user's chosen uid, because an intent that failed to bind is exactly the state that looked
// healthy for nine minutes.
//
// It sits alongside captionFor's output in LogoWaveform rather than replacing it: captionFor
// answers "what is the mic DOING" (paused / actively listening / auto-resuming) and this answers
// "what is it POINTED AT". Two different facts, deliberately not folded into one string — the
// existing caption is a click target that toggles phase, and the device name is not something you
// should be able to click a phase change out of.
//
// Renders nothing until a bind has been reported, so it never claims a device on faith.
import { FiAlertTriangle, FiVolume2 } from "react-icons/fi";
import { C, FONT_WEIGHT } from "../theme/colors";
import { TYPE } from "../theme/scale";
import { useAudioInputStore } from "../stores/audioInputStore";
import { BOUND_VIRTUAL_WARNING, boundDeviceCaption } from "../services/audioInputs";
import { useMicIsHearing } from "../voice/useMicIsHearing";

export function BoundDeviceCaption() {
  const bound = useAudioInputStore((s) => s.bound);
  // Picks the VERB. Read through the SHARED presentation, never off raw `status`: this line sits
  // directly under the waveform's own caption and must never re-assert a capture that line just
  // retracted — including the error and preparing states, where `status` stays "listening" while
  // the notice above says voice failed (roborev 55289).
  const live = useMicIsHearing();
  const caption = boundDeviceCaption(bound, live);
  if (!caption || !bound) return null;

  // A non-microphone bind is amber and carries the consequence sentence, because at this point the
  // user is no longer choosing — it is already what Sparkle is hearing.
  const virtual = bound.isVirtual;
  return (
    <div
      style={{
        marginTop: 3,
        textAlign: "center",
        fontSize: TYPE.micro,
        lineHeight: 1.3,
        color: virtual ? C.amber : C.muted,
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, justifyContent: "center" }}>
        {virtual ? <FiVolume2 size={10} aria-hidden style={{ flexShrink: 0 }} /> : null}
        <span style={{ fontWeight: virtual ? FONT_WEIGHT.semibold : undefined }}>{caption}</span>
      </span>
      {virtual ? (
        <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 4, marginTop: 1 }}>
          <FiAlertTriangle size={10} aria-hidden style={{ flexShrink: 0 }} />
          {BOUND_VIRTUAL_WARNING}
        </span>
      ) : null}
    </div>
  );
}
