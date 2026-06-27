import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { TbMicrophone, TbMicrophoneOff } from "react-icons/tb";
// Themed tokens (muted/forest/cream flip on data-theme); brand teal/accent pass through as
// constants. Import from ../theme/colors — like Composer — so the waveform stays legible in
// light mode (the @sparkle/ui C.muted is a dark-mode-only literal).
import { C, DANGER } from "../theme/colors";
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
 * Compute the next bar-history array for one animation frame. Pure (rAF passes the random
 * `jitterFactor` in) so the gating is unit-testable.
 *
 * The meter animates ONLY while the user is actually speaking — `speaking` is the backend
 * Silero VAD's real-time voice-activity flag (`dictation://speaking`), not a raw-loudness
 * guess, so ambient noise never makes it wiggle:
 *  - Not speaking → decay any residual wave toward a flat, static line. Once already flat we
 *    return the SAME array reference so React bails out of re-rendering and the line is truly
 *    still (no per-frame churn while you're silent).
 *  - Speaking → scroll left one slot and append the current gain-curved level. `level` (raw
 *    RMS loudness) still drives bar HEIGHT; `speaking` only gates the MOTION.
 */
export function nextBars(
  prev: number[],
  speaking: boolean,
  level: number,
  jitterFactor: number,
): number[] {
  if (!speaking) {
    if (prev.every((h) => h === 0)) return prev; // already flat → stable ref, no re-render
    // Snap small residuals to exactly 0 so the decay actually reaches (and holds) flat.
    return prev.map((h) => (h < 0.02 ? 0 : h * 0.55));
  }
  // Per-bar DOWNWARD jitter scaled by the level: because `gained` saturates by ~0.1 (the
  // punchy GAIN), an *additive* jitter would pin every bar to the ceiling during speech — a
  // flat block. Pulling each bar down by a random fraction keeps loud frames spread out so
  // neighboring bars spike apart and the meter visibly jumps the louder the user talks.
  const gained = barFraction(level);
  const next = prev.slice(1);
  next.push(Math.min(1, gained * jitterFactor));
  return next;
}

/**
 * The hint caption under the waveform.
 *  - Muted (mic released) → null.
 *  - Armed AND actually capturing → the passive/active wake hints.
 *  - Armed but NOT capturing (focus-paused) → an honest "Listening paused…" that tells
 *    the user it auto-resumes on re-focus — we must not claim "Just say Hey Sparkle…"
 *    when the backend isn't hearing anything.
 */
export function captionFor(
  phase: Phase,
  enabled: boolean,
  listening: boolean,
): string | null {
  if (!enabled) return null;
  if (!listening)
    return "Listening paused: Will auto-resume when you re-focus on this project.";
  return phase === "passive"
    ? "Listening for the wake word: Just say Hey Sparkle to talk to me"
    : "Actively listening: Just say Sparkle, stop to finish";
}

/**
 * Always-listening waveform pinned under the Sparkle logo (column-one width).
 * Gray bars while PASSIVE ("I hear you, not typing"); an animated blue→cyan
 * gradient sweep while ACTIVE. Click toggles phase; the mic icon mutes.
 */
export function LogoWaveform() {
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

  const [micHover, setMicHover] = useState(false);
  const raf = useRef(0);
  // Live audio level + the VAD `speaking` flag held in refs, fed by a TRANSIENT store
  // subscription. The `dictation://level` stream emits once per audio frame; subscribing to it
  // (and to `speaking`) as render state would re-render this whole component dozens of times a
  // second purely to copy a number/bool. The rAF loop reads the refs directly instead.
  const levelRef = useRef(0);
  const speakingRef = useRef(false);
  useEffect(() => {
    const s0 = useDictationStore.getState();
    levelRef.current = s0.level;
    speakingRef.current = s0.speaking;
    return useDictationStore.subscribe((s) => {
      levelRef.current = s.level;
      speakingRef.current = s.speaking;
    });
  }, []);

  // Bar heights (and the orb glow) are driven by DIRECT DOM writes from the rAF loop, NOT
  // React state: at 140 bars, routing every frame through setState re-rendered the entire
  // component (and re-diffed 140 <span>s) 60×/sec while merely focused. `heightsRef` is the
  // rolling buffer (newest on the right); `barsRef` holds the span nodes; `orbRef` the glow.
  const heightsRef = useRef<number[]>(Array(BAR_COUNT).fill(0));
  const barsRef = useRef<(HTMLSpanElement | null)[]>([]);
  const orbRef = useRef<HTMLDivElement | null>(null);

  const paintBar = (i: number, h: number) => {
    const el = barsRef.current[i];
    if (el) el.style.height = `${Math.max(6, h * 100)}%`;
  };
  const paintOrb = (energy: number) => {
    const el = orbRef.current;
    if (!el) return;
    // The glow is purely audio-driven: at energy 0 (silence) opacity is exactly 0 — NO glow
    // behind the mic without sound. The louder the audio, the brighter and larger it swells,
    // so the orb "pops open" as you speak. (The blobs' cloud-drift motion is owned by CSS
    // keyframes; this only scales/fades the whole composite.)
    el.style.transform = `translate(-50%, -50%) scale(${0.85 + energy * 0.9})`;
    el.style.opacity = `${Math.min(0.9, energy * 1.5)}`;
  };

  // useLayoutEffect (not useEffect): the initial flat paint must land BEFORE the browser paints,
  // otherwise the height-less <span>s collapse to ~0 for one frame (a brief flash) on first mount.
  useLayoutEffect(() => {
    // Only animate while armed AND capture is actually live. When paused (armed but not
    // capturing) or muted, flatten the bars and bail — a frozen or animating snapshot would
    // dishonestly read as "still listening", and it saves CPU/battery. Gating on `enabled`
    // too (not just `listening`) avoids the transient where a just-muted mic dims to opacity
    // 0.4 while `status` hasn't flipped off yet. This branch also paints the initial flat
    // state on mount (status starts idle), so the bars have a height before the loop runs.
    if (!(enabled && listening)) {
      heightsRef.current = Array(BAR_COUNT).fill(0);
      for (let i = 0; i < BAR_COUNT; i++) paintBar(i, 0);
      paintOrb(0);
      return;
    }
    const tick = () => {
      // VAD-gated animation (nextBars: scroll while the user talks, decay to a flat static line
      // in silence) applied via DIRECT DOM writes, NOT setState. The random jitter is generated
      // here so nextBars stays pure/testable. When silent and already flat, nextBars returns the
      // SAME ref — skip the paint loop so the meter is genuinely idle (no per-frame DOM churn).
      const prev = heightsRef.current;
      const next = nextBars(prev, speakingRef.current, levelRef.current, 1 - Math.random() * 0.55);
      if (next !== prev) {
        heightsRef.current = next;
        for (let i = 0; i < BAR_COUNT; i++) paintBar(i, next[i] ?? 0);
        // Recent waveform energy (newest 12 bars) drives the pulsating glow behind the mic.
        let energy = 0;
        for (let i = BAR_COUNT - 12; i < BAR_COUNT; i++) {
          const h = next[i] ?? 0;
          if (h > energy) energy = h;
        }
        paintOrb(energy);
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
    // paintBar/paintOrb are stable for the component's life; only re-arm on gating change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // Muted → gray. The HOVER cue is direction-aware: an ENABLED mic goes RED (destructive "click to
  // mute"), a MUTED mic goes TEAL (constructive "click to turn on") — matching what the click does
  // and the aria-label. Color animates back to gray/teal on leave.
  const hoverColor = enabled ? DANGER : C.teal;
  const micColor = micHover ? hoverColor : !enabled ? C.muted : active ? C.accentInk : C.teal;
  const micBorder = micHover ? hoverColor : !enabled ? C.muted : active ? C.accent : C.teal;
  // Show the slashed "mute" glyph whenever the click would turn the mic OFF on hover (enabled),
  // or when it's already muted. Only the resting, enabled mic shows the open-mic glyph.
  const showMutedIcon = micHover || !enabled;
  // The pulsating orb glow is driven directly by the rAF loop (paintOrb), so there's no
  // render-time energy to compute here.
  // Orb blob colors track the WAVEFORM: brand cyan/blue while ACTIVELY dictating, but SHADES OF
  // GRAY while merely listening for the wake word (passive) — matching the gray bars, so the glow
  // doesn't imply "active" before the wake word is heard. The grays are derived from the themed
  // muted token (the same color the bars use) so they flip correctly in light/dark mode.
  const grayLight = `color-mix(in srgb, ${C.muted} 60%, white)`;
  const grayDark = `color-mix(in srgb, ${C.muted} 70%, black)`;
  const orbColors = active
    ? [C.accent, C.teal, C.accent]
    : [C.muted, grayLight, grayDark];

  return (
    <div style={{ padding: "0 14px 8px", userSelect: "none" }}>
      {/* Waveform stage. Bars mirror about the vertical center (grow up + down); a
          mic ring floats in the middle with the bars popping behind it. */}
      <div style={{ position: "relative", height: WAVE_HEIGHT }}>
        {/* Pulsating Siri-orb glow behind the mic: three soft, amoeba-like blobs across the
            teal→cyan spectrum. Each blob slowly ORBITS the center on its own period/phase
            (CSS keyframes below), so the mixed color wanders like slow clouds rather than
            sitting in a fixed corner — and because the orbits are small and centered, the
            glow stays even on all sides of the mic instead of pooling to one side. The whole
            composite swells with live audio `energy` and is pinned to opacity 0 in silence by
            the rAF loop (`paintOrb`), so there is NO glow without sound. zIndex 0 keeps it
            behind the Sparkle.ai logo (which the sidebar lifts above it). Only while actually
            listening. */}
        {enabled && listening && (
          <div
            ref={orbRef}
            aria-hidden
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              width: 160,
              height: 132,
              zIndex: 0,
              // Initial values only; the rAF loop drives transform/opacity per frame via
              // `paintOrb` (no CSS transition — it would smear against 60fps direct writes).
              // Starts at opacity 0 so a freshly-mounted, still-silent orb shows no glow.
              transform: "translate(-50%, -50%) scale(0.85)",
              opacity: 0,
              pointerEvents: "none",
              filter: "blur(18px)",
            }}
          >
            {/* Each blob is a centered radial circle that the keyframes nudge around the
                middle. closest-side keeps the colored core well inside the box as it drifts. */}
            <span
              aria-hidden
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: "50%",
                background: `radial-gradient(closest-side, ${orbColors[0]}, transparent 72%)`,
                animation: "-drift-a 7.5s ease-in-out infinite",
              }}
            />
            <span
              aria-hidden
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: "50%",
                background: `radial-gradient(closest-side, ${orbColors[1]}, transparent 72%)`,
                animation: "-drift-b 9.5s ease-in-out infinite",
              }}
            />
            <span
              aria-hidden
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: "50%",
                background: `radial-gradient(closest-side, ${orbColors[2]}, transparent 74%)`,
                animation: "-drift-c 12s ease-in-out infinite",
              }}
            />
          </div>
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
          {Array.from({ length: BAR_COUNT }, (_, i) => (
            <span
              key={i}
              ref={(el) => {
                barsRef.current[i] = el;
              }}
              style={{
                flex: 1,
                // height is intentionally NOT set here — the rAF loop owns it via `paintBar`
                // (direct DOM write). Omitting it from the inline style means a React re-render
                // (e.g. a phase change flipping the gradient) never clobbers the live height.
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
            // when muted. Hover → red when enabled ("click to mute") or teal when muted ("click to
            // turn on"). See micColor/hoverColor above.
            border: `1.5px solid ${micBorder}`,
            boxShadow:
              enabled && liveActive ? "0 0 12px rgba(52,224,240,0.6)" : "none",
            cursor: "pointer",
            color: micColor,
            padding: 0,
            transition: "box-shadow 120ms ease, border-color 120ms ease, color 120ms ease",
          }}
        >
          {showMutedIcon ? <TbMicrophoneOff size={20} /> : <TbMicrophone size={20} />}
        </button>
      </div>

      {error ? (
        <div style={{ marginTop: 4, color: C.muted, fontSize: 10, textAlign: "center" }}>
          Mic unavailable — check System Settings → Privacy → Microphone.
        </div>
      ) : enabled && modelProgress !== null ? (
        <div style={{ marginTop: 4, color: C.muted, fontSize: 11, textAlign: "center" }}>
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
            textAlign: "center",
            marginTop: 4,
            padding: 0,
            background: "transparent",
            border: "none",
            cursor: "pointer",
            color: C.muted,
            fontSize: 11,
          }}
        >
          {/* Line 1 — current status. Same slot/styling in both phases. */}
          <span style={{ display: "block", fontWeight: 600 }}>
            {phase === "passive" ? "Listening for the wake word" : "Actively listening"}
          </span>
          {/* Line 2 — the spoken command, with the key phrase in the waveform gradient. */}
          <span style={{ display: "block" }}>
            Just say{" "}
            <span
              style={{
                fontWeight: 600,
                // Solid brand blue (C.teal #2f6bff) — no gradient fade (matches the composer's
                // "Hey Sparkle"). The cyan→blue fade was dropped per design feedback.
                color: C.teal,
              }}
            >
              {phase === "passive" ? "Hey Sparkle" : "Sparkle, stop"}
            </span>{" "}
            {phase === "passive" ? "to talk to me" : "to finish"}
          </span>
        </button>
      ) : caption ? (
        // Armed but paused (focus lost): show the honest caption as plain text — not a
        // wake hint, since saying "Hey Sparkle" right now wouldn't be heard.
        <div style={{ marginTop: 4, color: C.muted, fontSize: 11, textAlign: "center" }}>{caption}</div>
      ) : null}
    </div>
  );
}
