import { useState, type CSSProperties } from "react";
import { TbMicrophone, TbMicrophoneOff } from "react-icons/tb";
import { C, DANGER } from "../theme/colors";
import { useDictationStore } from "../stores/dictationStore";

// Shared microphone control. The top waveform ring (LogoWaveform) and the composer-left mic must
// behave IDENTICALLY, so the whole behavior — state derivation, click cycle, icon/color mapping —
// lives here and both render sites consume it. Keeping it in one place means the two mics can't
// drift.
//
// The mic has three user-facing states, all derived from the existing dictation store (no new
// state added):
//   off    = !enabled                       — mic released, nothing captured
//   paused = enabled && !liveActive          — on, but waiting for the wake word (or focus-paused)
//   active = enabled && status listening && phase active — actively dictating right now
//
// A click never jumps straight from active to off: it PAUSES first. The full cycle:
//   off → setEnabled(true) → paused
//   active → setPhase("passive") → paused   (stays on; stops dictating)
//   paused → setEnabled(false) → off

export type MicState = "off" | "paused" | "active";

/** The icon shape the glyph should draw. `open` = live mic, `slash` = muted mic, `pause` = the
 *  orange "mic + two pause bars" affordance. */
export type MicVariant = "open" | "slash" | "pause";

/** Reads the dictation store and exposes the mic's current state plus the tri-state click cycle.
 *  Both mics call this, so the click actions and semantics are guaranteed the same. */
export function useMicToggle(): {
  state: MicState;
  onClick: () => void;
  ariaLabel: string;
  title: string;
} {
  const enabled = useDictationStore((s) => s.enabled);
  const status = useDictationStore((s) => s.status);
  const phase = useDictationStore((s) => s.phase);
  const setEnabled = useDictationStore((s) => s.setEnabled);
  const setPhase = useDictationStore((s) => s.setPhase);

  // liveActive mirrors LogoWaveform: capture is genuinely live AND we're in the active phase.
  // phase alone isn't enough — we can be in the active phase while focus-paused (status idle).
  const liveActive = status === "listening" && phase === "active";
  const state: MicState = !enabled ? "off" : liveActive ? "active" : "paused";

  const onClick = () => {
    if (state === "off")
      setEnabled(true); // off → paused (arm the mic; it resumes wake-word listening)
    else if (state === "active")
      setPhase("passive"); // active → paused (stop dictating, stay listening — never turn off)
    else setEnabled(false); // paused → off
  };

  const ariaLabel =
    state === "off"
      ? "Turn on microphone"
      : state === "active"
      ? "Pause listening"
      : "Turn off microphone";
  const title = state === "off" ? "Turn on" : state === "active" ? "Pause" : "Turn off";

  return { state, onClick, ariaLabel, title };
}

/** Map (state, hover) → the icon variant to draw and the color to draw it in. The hover cue is
 *  direction-aware and matches what the click does:
 *   - off:    gray slash at rest → teal on hover ("click to turn on")
 *   - paused: orange mic+pause at rest → red slash on hover ("click to turn off")
 *   - active: live open mic at rest → orange mic+pause on hover ("click to pause")
 *  Exported so the ring can also color its BORDER to match the glyph. */
export function micVisual(state: MicState, hovered: boolean): { color: string; variant: MicVariant } {
  if (state === "off") return { color: hovered ? C.teal : C.muted, variant: "slash" };
  if (state === "paused")
    return hovered ? { color: DANGER, variant: "slash" } : { color: C.amber, variant: "pause" };
  // active
  return hovered ? { color: C.amber, variant: "pause" } : { color: C.accentInk, variant: "open" };
}

/** A microphone with two vertical pause bars overlaid through its center — the "paused / click to
 *  pause" affordance, the pause-symbol counterpart to the slashed mute glyph. Both the mic and the
 *  bars inherit `currentColor`, so the parent's `color` tints the whole glyph (amber in practice).
 *  The bars are drawn taller than the mic body and separated from it by a thin ring in the caller's
 *  SURFACE color so they read as bars IN FRONT OF the mic even though they share its color. The ring
 *  must match whatever the glyph sits on (each render site passes its own backdrop), so it reads as
 *  a clean cut-out rather than a faint outline of the wrong color. */
export function MicPauseIcon({ size = 20, surfaceColor = C.forest }: { size?: number; surfaceColor?: string }) {
  const barW = Math.max(2, Math.round(size * 0.13));
  const barH = Math.round(size * 0.86);
  const gap = Math.max(2, Math.round(size * 0.16));
  const bar: CSSProperties = {
    width: barW,
    height: barH,
    borderRadius: barW,
    background: "currentColor",
    // Thin ring in the caller's surface color so each bar separates from the same-colored mic.
    boxShadow: `0 0 0 1.25px ${surfaceColor}`,
  };
  return (
    <span
      style={{
        position: "relative",
        display: "inline-flex",
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <TbMicrophone size={size} />
      <span
        aria-hidden
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          display: "flex",
          gap,
          alignItems: "center",
        }}
      >
        <span style={bar} />
        <span style={bar} />
      </span>
    </span>
  );
}

/** Renders the mic icon for a given variant. Color is inherited from the parent's CSS `color`
 *  (set from micVisual), so this component stays purely about SHAPE. `surfaceColor` is the backdrop
 *  the glyph sits on (only the pause variant uses it — for its bar-separation ring). */
export function MicGlyph({
  variant,
  size = 20,
  surfaceColor,
}: {
  variant: MicVariant;
  size?: number;
  surfaceColor?: string;
}) {
  if (variant === "slash") return <TbMicrophoneOff size={size} />;
  if (variant === "pause") return <MicPauseIcon size={size} surfaceColor={surfaceColor} />;
  return <TbMicrophone size={size} />;
}

/** The bare mic button that sits to the LEFT of the composer input box — just the glyph, no ring,
 *  no waveform. It shares useMicToggle + micVisual with the top ring, so a click here takes the
 *  exact same action. It is only shown while the mic is ON (paused or active); when the mic is off
 *  it renders nothing, so it disappears from beside the composer. */
export function ComposerMic() {
  const { state, onClick, ariaLabel, title } = useMicToggle();
  const [hover, setHover] = useState(false);

  // Off → not rendered at all (the whole point: it disappears when the mic is off).
  if (state === "off") return null;

  const { color, variant } = micVisual(state, hover);
  return (
    <button
      type="button"
      data-hint="composer-mic"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-label={ariaLabel}
      title={title}
      style={{
        // Top-aligned: when the composer grows to multiple lines, the mic stays pinned to the TOP
        // of the box (beside the first line), not the bottom.
        alignSelf: "flex-start",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 32,
        height: 40,
        background: "transparent",
        border: "none",
        cursor: "pointer",
        color,
        padding: 0,
        transition: "color 120ms ease",
      }}
    >
      {/* The composer mic sits on the composer's forest row background (to the LEFT of the
          barSurface input box), so the pause-bar separation ring is forest. */}
      <MicGlyph variant={variant} size={20} surfaceColor={C.forest} />
    </button>
  );
}
