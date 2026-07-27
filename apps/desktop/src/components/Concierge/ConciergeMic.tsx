// The concierge compose box's microphone — the REAL one.
//
// The box shipped with a local `micLive` boolean that a click flipped and nothing else read: the
// button had two visual states and no effect on audio whatsoever. Everything needed already
// existed for the removed AgentPane composer (dictationStore, the wake machine, useMicToggle,
// MicGlyph/micVisual), so this is a wiring component, not a new feature.
//
// The three stages the founder asked for are exactly the ones useMicToggle already implements:
//   1. OFF        — mic disarmed, no audio captured
//   2. PAUSED     — armed and listening for the wake word ("Hey Sparkle") but not transcribing
//   3. ACTIVE     — transcribing into the compose box
// (plus PREPARING, a transient fourth while the voice model downloads on first arm).
//
// WHY NOT `ComposerMic`. That component returns null when the state is "off" — deliberate there,
// because the composer had a separate always-present top ring to re-arm from. The concierge column
// has no such ring, so an invisible-when-off mic would be unreachable: the user could turn it off
// and never get it back. This renders in every state and shares the same hook, glyph and colours,
// so the two surfaces still agree about what each state looks like.
import { useState } from "react";
import { MicGlyph, micVisual, useMicToggle } from "../MicButton";
import { C } from "../../theme/colors";

export function ConciergeMic({
  surfaceColor,
  /** Called before the toggle runs: this mic is the one the user clicked, so the compose box it
   *  belongs to should own the transcript. Without it, a Sparkle pane visible at the same time
   *  keeps the single global insert slot and the dictation lands there (roborev 53262). */
  onArm,
}: {
  surfaceColor: string;
  onArm?: () => void;
}) {
  const { state, onClick, ariaLabel, title } = useMicToggle();
  const [hover, setHover] = useState(false);
  const { color, variant } = micVisual(state, hover);

  return (
    <button
      type="button"
      data-testid="concierge-mic"
      // The STATE, exposed for tests and for anything that needs to know without re-deriving it.
      data-mic-state={state}
      onClick={() => {
        onArm?.();
        onClick();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-label={ariaLabel}
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        height: 42,
        width: 38,
        flex: "none",
        borderRadius: 8,
        background: "transparent",
        border: `1px solid color-mix(in srgb, ${C.muted} 25%, transparent)`,
        color,
        cursor: "pointer",
      }}
    >
      <MicGlyph variant={variant} size={16} surfaceColor={surfaceColor} />
    </button>
  );
}
