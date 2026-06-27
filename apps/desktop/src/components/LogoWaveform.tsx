import { useEffect, useRef, useState } from "react";
import { TbMicrophone, TbMicrophoneOff } from "react-icons/tb";
// Themed tokens (muted/forest/cream flip on data-theme); brand teal/accent pass through as
// constants. Import from ../theme/colors — like Composer — so the waveform stays legible in
// light mode (the @sparkle/ui C.muted is a dark-mode-only literal).
import { C } from "../theme/colors";
import type { Phase } from "../voice/wakeMachine";
import { useDictationStore } from "../stores/dictationStore";

// Many thin slivers (was 28 fat bars) so the meter reads as a dense, lively waveform
// rather than a row of chunky blocks. The rAF loop stays cheap even at this count —
// it shifts one number per frame and React diffs flat <span>s.
const BAR_COUNT = 140;
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
  const GAIN = 3.2;
  return Math.min(1, Math.sqrt(Math.max(0, level)) * GAIN);
}

/**
 * The hint caption under the waveform.
 *  - Muted (mic released) → null.
 *  - Armed AND actually capturing → the passive/active wake hints.
 *  - Armed but NOT capturing (focus-paused) → an honest "Mic paused" — we must not
 *    claim "Just say Hey Sparkle…" when the backend isn't hearing anything.
 */
export function captionFor(
  phase: Phase,
  enabled: boolean,
  listening: boolean,
): string | null {
  if (!enabled) return null;
  if (!listening) return "Mic paused";
  return phase === "passive"
    ? "Listening for wake word: Just say Hey Sparkle to talk to me"
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
  const status = useDictationStore((s) => s.status);
  const error = useDictationStore((s) => s.error);
  const modelProgress = useDictationStore((s) => s.modelProgress);
  const togglePhase = useDictationStore((s) => s.togglePhase);
  const setEnabled = useDictationStore((s) => s.setEnabled);

  // `enabled` is the user's intent (armed). `listening` is whether capture is
  // ACTUALLY live — the backend only records while a Sparkle window is focused, so
  // armed can be true while paused. Drive the LIVE presentation off `listening` so we
  // never animate/claim "listening" when nothing is being heard.
  const listening = status === "listening";

  // Rolling history of recent levels → bar heights (newest on the right).
  const [bars, setBars] = useState<number[]>(() => Array(BAR_COUNT).fill(0));
  const [micHover, setMicHover] = useState(false);
  const raf = useRef(0);
  // Hold level in a ref so the rAF closure always reads the latest value without
  // restarting the loop on every store update.
  const levelRef = useRef(level);
  useEffect(() => { levelRef.current = level; }, [level]);

  useEffect(() => {
    // Only run the animation loop while armed AND capture is actually live. When paused
    // (armed but not capturing) or muted, reset bars to flat and bail — a frozen or
    // animating snapshot would dishonestly read as "still listening", and it saves
    // CPU/battery. Gating on `enabled` too (not just `listening`) avoids the transient
    // where a just-muted mic dims to opacity 0.4 while `status` hasn't flipped off yet.
    if (!(enabled && listening)) {
      setBars(Array(BAR_COUNT).fill(0));
      return;
    }
    const tick = () => {
      setBars((prev) => {
        // Gained, perceptual level for this frame (barFraction applied ONCE here so
        // render can use the value verbatim — no double-application).
        const gained = barFraction(levelRef.current);
        // A faint idle shimmer so the meter reads as "listening closely" even in
        // near-silence. Plus a per-bar DOWNWARD jitter scaled by the level: because
        // `gained` saturates by ~0.1 (the punchy GAIN), an *additive* jitter would pin
        // every bar to the ceiling during speech — a flat block. Pulling each bar down
        // by a random fraction of `gained` keeps loud frames spread out so neighboring
        // bars spike apart and the meter visibly jumps the louder the user talks.
        const shimmer = 0.06 + Math.random() * 0.06;
        const jitterFactor = 1 - Math.random() * 0.55;
        const next = prev.slice(1);
        next.push(Math.min(1, shimmer + gained * jitterFactor));
        return next;
      });
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [enabled, listening]);

  const caption = captionFor(phase, enabled, listening);
  // Visual "active sweep" only when capture is genuinely live; phase alone isn't
  // enough (we could be in active phase but focus-paused).
  const liveActive = listening && phase === "active";
  // Toggle/aria semantics still follow phase — toggling phase while paused is fine
  // and takes effect once capture resumes.
  const active = phase === "active";

  // Mic tint by mode: the DARK BLUE of the logo "eye" (C.teal = #2f6bff) while we're
  // listening for the wake word (passive), the lighter teal/cyan while ACTIVELY dictating.
  // Muted → gray, with a cyan hover affordance signalling "click to turn audio on".
  const micColor = !enabled ? (micHover ? C.accent : C.muted) : active ? C.accentInk : C.teal;
  const micBorder = !enabled ? (micHover ? C.accent : C.muted) : active ? C.accent : C.teal;
  // Recent waveform energy (newest bars) drives the pulsating glow behind the mic. The idle
  // shimmer keeps it faintly alive even in silence; it swells as the user gets louder.
  const energy = enabled && listening ? Math.max(0, ...bars.slice(-12)) : 0;

  return (
    <div style={{ padding: "0 14px 8px", userSelect: "none" }}>
      {/* Waveform stage. Bars mirror about the vertical center (grow up + down); a
          mic ring floats in the middle with the bars popping behind it. */}
      <div style={{ position: "relative", height: WAVE_HEIGHT }}>
        {/* Pulsating Siri-orb glow behind the mic: soft, amoeba-like blobs across the teal→blue
            spectrum that swell with the live audio `energy` (and breathe gently in silence via the
            idle shimmer baked into `energy`). Sits behind everything; the mic's translucent disc
            keeps the glyph legible over it. Only while actually listening. */}
        {enabled && listening && (
          <div
            aria-hidden
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              width: 132,
              height: 132,
              transform: `translate(-50%, -50%) scale(${1 + energy * 0.95})`,
              opacity: 0.32 + energy * 0.55,
              transition: "transform 140ms ease-out, opacity 220ms ease-out",
              pointerEvents: "none",
              borderRadius: "50%",
              filter: "blur(16px)",
              background:
                `radial-gradient(40% 46% at 37% 41%, ${C.accent}, transparent 70%),` +
                `radial-gradient(44% 40% at 67% 61%, ${C.teal}, transparent 70%),` +
                `radial-gradient(30% 34% at 57% 31%, ${C.accent}, transparent 72%)`,
            }}
          />
        )}
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
            gap: 1,
            padding: 0,
            background: "transparent",
            border: "none",
            cursor: enabled ? "pointer" : "default",
            opacity: enabled ? 1 : 0.4,
            // A soft cyan halo makes the live waveform feel vibrant and alive.
            filter: liveActive
              ? "drop-shadow(0 0 5px rgba(52,224,240,0.55))"
              : "none",
          }}
        >
          {bars.map((h, i) => (
            <span
              key={i}
              style={{
                flex: 1,
                // `h` is already gain-curved (barFraction applied in the rAF tick), so
                // use it verbatim — no double-application. No CSS height transition: the
                // rAF loop drives the heights directly so spikes snap instantly.
                height: `${Math.max(6, h * 100)}%`,
                borderRadius: 1,
                // Gray when passive/paused; brand teal→blue fade across the row when live+active
                // (cyan/teal on the LEFT, dark blue C.teal #2f6bff on the RIGHT).
                background: liveActive
                  ? `linear-gradient(90deg, ${C.accent}, ${C.teal})`
                  : C.muted,
                backgroundSize: liveActive ? `${BAR_COUNT * 100}% 100%` : undefined,
                backgroundPosition: liveActive ? `${(i / (BAR_COUNT - 1)) * 100}% 0` : undefined,
              }}
            />
          ))}
        </button>

        {/* Mic ring — floats over the center of the waveform. Click = mute toggle. */}
        <button
          type="button"
          onClick={() => setEnabled(!enabled)}
          onMouseEnter={() => setMicHover(true)}
          onMouseLeave={() => setMicHover(false)}
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
            // Dark-blue while listening for the wake word, lighter teal while dictating; gray
            // (cyan on hover) when muted. See micColor/micBorder above.
            border: `1.5px solid ${micBorder}`,
            boxShadow:
              enabled && liveActive ? "0 0 12px rgba(52,224,240,0.6)" : "none",
            cursor: "pointer",
            color: micColor,
            padding: 0,
            transition: "box-shadow 120ms ease, border-color 120ms ease, color 120ms ease",
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
      ) : caption && listening ? (
        // Live: the caption doubles as a click target — clicking it toggles phase
        // (start/stop), mirroring the waveform's behavior.
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
          {phase === "passive" ? "Listening for wake word: Just say " : "Just say "}
          <span
            style={{
              fontWeight: 600,
              // Teal/cyan on the left → dark blue on the right (matches the waveform).
              background: `linear-gradient(90deg, ${C.accent}, ${C.teal})`,
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
            }}
          >
            {phase === "passive" ? "Hey Sparkle" : "Send It"}
          </span>{" "}
          {phase === "passive" ? "to talk to me" : "to stop"}
        </button>
      ) : caption ? (
        // Armed but paused (focus lost): show the honest caption as plain text — not a
        // wake hint, since saying "Hey Sparkle" right now wouldn't be heard.
        <div style={{ marginTop: 4, color: C.muted, fontSize: 11 }}>{caption}</div>
      ) : null}
    </div>
  );
}
