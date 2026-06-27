import { useEffect, useRef, useState } from "react";
import { TbMicrophone, TbMicrophoneOff } from "react-icons/tb";
// Themed tokens (muted/forest/cream flip on data-theme); brand teal/accent pass through as
// constants. Import from ../theme/colors — like Composer — so the waveform stays legible in
// light mode (the @sparkle/ui C.muted is a dark-mode-only literal).
import { C } from "../theme/colors";
import type { Phase } from "../voice/wakeMachine";
import { useDictationStore } from "../stores/dictationStore";

const BAR_COUNT = 28;
// Overall height of the waveform strip. Bars are mirrored about the vertical center
// (they grow up AND down from the middle), so a single bar can reach this full height.
const WAVE_HEIGHT = 56;

/**
 * Map a raw RMS audio level → bar-height fraction in [0,1].
 *
 * The backend emits `rms_level` where 0 = silence and 1 = full-scale clip
 * (see src-tauri/src/audio.rs). Normal speech RMS only reaches ~0.03–0.15, so a
 * linear 1:1 map leaves every bar pinned at the idle floor — the meter reads as
 * static dotted lines even while the mic is working (it was). We apply a
 * perceptual sqrt curve (loudness perception is roughly logarithmic) plus a healthy
 * gain so ordinary speech sweeps most of the bar's height, then clamp to [0,1]. The
 * gain is deliberately punchy so the meter reads as vibrant and alive, not timid.
 */
export function barFraction(level: number): number {
  const GAIN = 2.6;
  return Math.min(1, Math.sqrt(Math.max(0, level)) * GAIN);
}

/** The hint caption under the waveform. Null when muted (mic released). */
export function captionFor(phase: Phase, enabled: boolean): string | null {
  if (!enabled) return null;
  return phase === "passive"
    ? "Just say Sparkle to talk to me"
    : "Just say Send It to stop";
}

/**
 * Always-listening waveform pinned under the Sparkle logo (column-one width).
 * Gray bars while PASSIVE ("I hear you, not typing"); an animated blue→cyan
 * gradient sweep while ACTIVE. Click toggles phase; the mic icon mutes.
 */
export function LogoWaveform() {
  const level = useDictationStore((s) => s.level);
  const phase = useDictationStore((s) => s.phase);
  const enabled = useDictationStore((s) => s.enabled);
  const error = useDictationStore((s) => s.error);
  const modelProgress = useDictationStore((s) => s.modelProgress);
  const togglePhase = useDictationStore((s) => s.togglePhase);
  const setEnabled = useDictationStore((s) => s.setEnabled);

  // Rolling history of recent levels → bar heights (newest on the right).
  const [bars, setBars] = useState<number[]>(() => Array(BAR_COUNT).fill(0));
  const raf = useRef(0);
  // Hold level in a ref so the rAF closure always reads the latest value without
  // restarting the loop on every store update.
  const levelRef = useRef(level);
  useEffect(() => { levelRef.current = level; }, [level]);

  useEffect(() => {
    // Only run the animation loop while the mic is enabled; stop when muted to
    // avoid continuous CPU/battery drain when the user isn't using voice.
    // Reset bars to flat when muting so the waveform doesn't freeze mid-wave
    // (a frozen snapshot could read as "still listening").
    if (!enabled) {
      setBars(Array(BAR_COUNT).fill(0));
      return;
    }
    const tick = () => {
      setBars((prev) => {
        const next = prev.slice(1);
        next.push(Math.min(1, levelRef.current));
        return next;
      });
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [enabled]);

  const caption = captionFor(phase, enabled);
  const active = phase === "active";

  return (
    <div style={{ padding: "0 14px 8px", userSelect: "none" }}>
      {/* Waveform stage. Bars mirror about the vertical center (grow up + down); a
          mic ring floats in the middle with the bars popping behind it. */}
      <div style={{ position: "relative", height: WAVE_HEIGHT }}>
        {/* Waveform — clicking anywhere on the strip toggles phase (start/stop). */}
        <button
          type="button"
          onClick={togglePhase}
          aria-label={active ? "Stop listening" : "Activate Sparkle voice"}
          disabled={!enabled}
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            // Center alignment is what mirrors each bar around the midline.
            alignItems: "center",
            gap: 2,
            padding: 0,
            background: "transparent",
            border: "none",
            cursor: enabled ? "pointer" : "default",
            opacity: enabled ? 1 : 0.4,
            // A soft cyan halo makes the live waveform feel vibrant and alive.
            filter: active
              ? "drop-shadow(0 0 5px rgba(52,224,240,0.55))"
              : "none",
          }}
        >
          {bars.map((h, i) => (
            <span
              key={i}
              style={{
                flex: 1,
                height: `${Math.max(6, barFraction(h) * 100)}%`,
                borderRadius: 3,
                // Gray when passive; brand blue→cyan fade across the row when active.
                background: active
                  ? `linear-gradient(90deg, ${C.teal}, ${C.accent})`
                  : C.muted,
                backgroundSize: active ? `${BAR_COUNT * 100}% 100%` : undefined,
                backgroundPosition: active ? `${(i / (BAR_COUNT - 1)) * 100}% 0` : undefined,
                transition: "height 80ms linear",
              }}
            />
          ))}
        </button>

        {/* Mic ring — floats over the center of the waveform. Click = mute toggle. */}
        <button
          type="button"
          onClick={() => setEnabled(!enabled)}
          aria-label={enabled ? "Mute microphone" : "Unmute microphone"}
          title={enabled ? "Mute" : "Unmute"}
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            transform: "translate(-50%, -50%)",
            width: 40,
            height: 40,
            display: "grid",
            placeItems: "center",
            borderRadius: "50%",
            // Themed translucent disc so the mic stays legible while bars glow behind it.
            background: `color-mix(in srgb, ${C.forest} 62%, transparent)`,
            backdropFilter: "blur(2px)",
            WebkitBackdropFilter: "blur(2px)",
            border: `1.5px solid ${enabled ? C.accent : C.muted}`,
            boxShadow:
              enabled && active ? "0 0 12px rgba(52,224,240,0.6)" : "none",
            cursor: "pointer",
            color: enabled ? C.accentInk : C.muted,
            padding: 0,
            transition: "box-shadow 120ms ease, border-color 120ms ease",
          }}
        >
          {enabled ? <TbMicrophone size={20} /> : <TbMicrophoneOff size={20} />}
        </button>
      </div>

      {error ? (
        <div style={{ marginTop: 4, color: C.muted, fontSize: 10 }}>
          Mic unavailable — check System Settings → Privacy → Microphone.
        </div>
      ) : enabled && modelProgress !== null ? (
        <div style={{ marginTop: 4, color: C.muted, fontSize: 11 }}>
          {(() => {
            const pct = modelProgress.total
              ? Math.round((modelProgress.done / modelProgress.total) * 100)
              : null;
            return pct !== null
              ? `Downloading voice model… ${pct}%`
              : "Downloading voice model…";
          })()}
        </div>
      ) : caption ? (
        // The caption doubles as a click target: clicking anywhere on it toggles
        // phase (start/stop), mirroring the waveform's behavior.
        <button
          type="button"
          onClick={togglePhase}
          aria-label={active ? "Stop listening" : "Activate Sparkle voice"}
          style={{
            display: "block",
            width: "100%",
            textAlign: "left",
            marginTop: 4,
            padding: 0,
            background: "transparent",
            border: "none",
            cursor: "pointer",
            color: C.muted,
            fontSize: 11,
          }}
        >
          Just say{" "}
          <span
            style={{
              fontWeight: 600,
              background: `linear-gradient(90deg, ${C.teal}, ${C.accent})`,
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
            }}
          >
            {phase === "passive" ? "Sparkle" : "Send It"}
          </span>{" "}
          {phase === "passive" ? "to talk to me" : "to stop"}
        </button>
      ) : null}
    </div>
  );
}
