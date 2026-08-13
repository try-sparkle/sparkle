import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { FiAlertTriangle } from "react-icons/fi";
// Themed tokens (muted/forest/cream flip on data-theme); brand teal/accent pass through as
// constants. Import from ../theme/colors — like Composer — so the waveform stays legible in
// light mode (the @sparkle/ui C.muted is a dark-mode-only literal).
import { C, FONT_WEIGHT } from "../theme/colors";
import { terminalRoutingArmed } from "../voice/dictationFocus";
import { trayInert } from "../voice/sendMode";
import {
  deriveMicPresentation,
  micCaptionKind,
  micIndicatorFor,
} from "../voice/micPresentation";
import { useDictationStore } from "../stores/dictationStore";
import { useUiStore } from "../stores/uiStore";
import {
  modelPercent,
  preparingCaption,
  voiceErrorNotice,
  pausedCaption,
  MICROPHONE_SETTINGS_URL,
} from "../voice/dictationCopy";
import { voiceStatusLine } from "../voice/voiceStatusLine";
import { VoiceStatusLine } from "./VoiceStatusLine";
import { useDictationPauseReason } from "../voice/useDictationPauseReason";
import type { PauseReason } from "../voice/dictationFocus";
import { openUrl } from "@tauri-apps/plugin-opener";
import { micVisual, MicGlyph } from "./MicButton";
import { useHasAiCredits } from "../services/aiGate";
import { SidebarOutOfCreditsNotice } from "./OutOfCreditsNotice";
import { useAudioInputSync } from "../services/audioInputs";
import { BoundDeviceCaption } from "./BoundDeviceCaption";

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
 * The FOCUS-PAUSED caption under the waveform — "armed, but the backend is not capturing".
 *
 * ── WHAT THIS FUNCTION LOST, AND WHY THAT IS THE FIX ────────────────────────────────────────────
 * It used to answer for the LIVE states too, keyed on `phase`: passive returned "Mic paused. Say
 * <wake> to activate" and active returned "Actively listening… <stop> to finish". That was a SECOND
 * derivation of a caption the render already computes from `micCaptionKind(sendMode)` — two paths to
 * one sentence, which is exactly the shape voice/useVoicePlaceholder's header warns about, and the
 * live branch here answered from `phase` while the render answered from the TRAY. Both are now gone
 * with the wake and stop words they named, leaving this with the one job the render genuinely
 * delegates to it.
 *
 * `null` when the mic is released: a disarmed mic makes no promise. WHICH paused line is chosen by
 * the CAUSE (`pauseReason`), not by this function — a window and a terminal pause for different
 * reasons and resume by different gestures, so one sentence cannot be true of both.
 *
 * `listening` is the caller's ALREADY-DEMOTED capture fact (`status === "listening" && no pause`),
 * not raw status. Kept as a parameter rather than read here so this stays pure and unit-testable.
 */
export function captionFor(
  enabled: boolean,
  listening: boolean,
  pauseReason: PauseReason | null = null,
): string | null {
  if (!enabled) return null;
  if (!listening) return pausedCaption(pauseReason);
  // Capture is live: the live caption is the render's, from the tray position. Nothing to say here.
  return null;
}

/**
 * Always-listening waveform pinned under the Sparkle logo (column-one width).
 * Gray bars while PASSIVE ("I hear you, not typing"); an animated blue→cyan
 * gradient sweep while ACTIVE.
 *
 * NOTHING HERE IS A MIC CONTROL ANY MORE. The three-position send tray is the only one, and every
 * surface in this component derives from its position (voice/micPresentation `micIndicatorFor` /
 * `micCaptionKind`). The mic ring, the waveform strip and the caption all used to be click
 * targets that moved `enabled`/`phase` behind the tray's back — three ways to put the tray and the
 * microphone into states that contradicted each other, which is exactly what this change deletes.
 * They are now read-outs: no onClick, no hover pill, no toggle.
 */
export interface LogoWaveformProps {
  /**
   * Is the push-to-talk key DOWN right now (`useSendMode.held`)? Decides which of the status line's
   * two states shows (sparkle-bbfsx).
   *
   * ── A PROP, THOUGH EVERY OTHER INPUT HERE IS A STORE READ ─────────────────────────────────────
   * The gesture is React state owned by `useSendMode`, which `ConciergeHost` mounts exactly once and
   * already threads down this column (the tray's own held treatment reads the same value). Copying
   * it into a store to save one prop would create a SECOND source for a fact whose whole hazard is
   * two sources disagreeing — the failure `voice/micPresentation`'s header is written about.
   *
   * Defaults to false, which is right for the CAPTURE WINDOW: it renders this component too, and
   * the hold gesture is bound in the main window (`usePushToTalk` claims `voiceSurface:
   * "concierge"`), so a capture overlay has no hold of its own to report.
   */
  pttHeld?: boolean;
}

export function LogoWaveform({ pttHeld = false }: LogoWaveformProps = {}) {
  const phase = useDictationStore((s) => s.phase);
  const enabled = useDictationStore((s) => s.enabled);
  const status = useDictationStore((s) => s.status);
  const error = useDictationStore((s) => s.error);
  const modelProgress = useDictationStore((s) => s.modelProgress);
  // Map the raw backend payload to honest copy. `error` was previously used here as a BOOLEAN and
  // its payload thrown away — this is the only consumer of it in the app, so the real cause of
  // every voice failure was unreachable to the user (see the render branch below).
  const errorNotice = useMemo(() => voiceErrorNotice(error), [error]);
  // THE state this indicator and the send tray share: the tray's own position. Reading `phase` for
  // it — as this component used to — is what let the glyph go green under a tray parked on "Push to
  // talk", because the wake matcher moves `phase` with no gesture anywhere. The tray writes this
  // value and drives the microphone from it, so there is exactly one thing to read.
  const sendMode = useUiStore((s) => s.conciergeSendMode);
  // The out-of-credits notice is shared transient state, so it shows here AND in the composer at
  // once. When set, it takes priority over the normal mic caption below.
  const outOfCreditsNotice = useDictationStore((s) => s.outOfCreditsNotice);
  const setEnabled = useDictationStore((s) => s.setEnabled);
  const clearOutOfCreditsNotice = useDictationStore((s) => s.clearOutOfCreditsNotice);
  const hasCredits = useHasAiCredits();
  // NO `setVoiceSurface` CALL HERE ANY MORE, and its absence is deliberate. This ring used to claim
  // the concierge as the surface that owns dictated speech on every gesture, because it WAS a
  // control — arming from here had to say where the transcript lands or it would follow whichever
  // agent pane last mounted. It no longer arms anything, and a read-out has no gesture to hang the
  // claim on. The tray makes it instead, on the same action that drives the microphone
  // (voice/useSendMode `applyIntent`), which is the only place it can be made in step with the arm.
  // Keep audioInputStore.bound current from `dictation://device`. Mounted HERE because this ring is
  // the app's primary mic control and is always present, so the device line has a live value the
  // moment anything binds — not only after someone opens the menu.
  useAudioInputSync();

  // Safety net: if the mic is somehow armed while the balance is empty (e.g. credits ran out mid
  // session), force it off so voice detection can't keep running without credits. The primary
  // block is at the arm attempt (MicButton), which never enables the mic in the first place.
  // Conversely, once credits arrive, drop any lingering refuse-notice so it can't sit next to a
  // now-usable mic waiting out its 5s timer.
  useEffect(() => {
    if (!hasCredits && enabled) setEnabled(false);
    else if (hasCredits && outOfCreditsNotice) clearOutOfCreditsNotice();
  }, [hasCredits, enabled, outOfCreditsNotice, setEnabled, clearOutOfCreditsNotice]);

  // `enabled` is the user's intent (armed). `listening` is whether capture is
  // ACTUALLY live — the backend only records while a Sparkle window is focused, so
  // armed can be true while paused. Drive the LIVE presentation off `listening` so we
  // never animate/claim "listening" when nothing is being heard.
  const listening = status === "listening";

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
  }, [enabled, listening]);

  // WHICH "Listening paused" sentence the caption uses is decided by the CAUSE, not by this
  // component: a lost window auto-resumes and a terminal does not, so one sentence cannot be true
  // of both. Same hook, same pure decision, as the routing gate that actually stopped the audio.
  const pauseReason = useDictationPauseReason();
  // ── THE CAPTION TAKES THE SAME PAUSE FACT THE RING DOES (roborev 56775) ──────────────────────
  // `listening` is `status === "listening"`, and the per-window blur path deliberately does NOT
  // demote `status` — `tearDownOwnedStream` touches interim/level/speaking and leaves status alone.
  // So in a background window this stayed true, `captionFor` took its live branch, and the caption
  // read "Actively listening: just say <stop> to finish" directly beneath the ring that the window
  // term had just correctly painted grey "Microphone: off". Fixing the ring alone re-created the
  // very contradiction it was fixing, one axis over — a ring denying the sentence printed under it.
  //
  // `pauseReason` is the honest fact and was already being computed here and then discarded on this
  // path: `useDictationPauseReason` returns "window" for exactly this snapshot. Feeding it in sends
  // the state to `pausedCaption("window")`. The routing-terminal case is unaffected, because
  // `pauseReason` is already null there.
  const capturing = listening && pauseReason === null;
  const caption = captionFor(enabled, capturing, pauseReason);
  // The ONE voice-state decision, shared with the composer (deriveMicPresentation). Both surfaces
  // switch their caption/placeholder on this, so the top-left mic and the composer mic can never
  // disagree about which state we're in. The wording each renders is still surface-local; only the
  // STATE is shared. `errorNotice != null` is this surface's `hasError`.
  const presentation = deriveMicPresentation({
    enabled,
    status,
    // The pause travels as its OWN input now, rather than being pre-baked into `status` here
    // (roborev 57117). Demoting at this one call site left the ring, the bound-device caption and
    // the composer on raw `status` — so the contradiction simply moved to whichever surface was not
    // patched. `deriveMicPresentation` takes the term itself, so no caller can opt out of it.
    phase,
    modelProgress,
    hasError: errorNotice !== null,
    outOfCreditsNotice,
    pauseReason,
  });
  // Visual "active sweep" only when capture is genuinely live; phase alone isn't
  // enough (we could be in active phase but focus-paused). Still a HARDWARE fact, deliberately not
  // derived from the tray: a push-to-talk hold routes speech without moving the tray, and a
  // waveform that went flat mid-sentence because the position had not changed would be lying about
  // the audio it is a meter for.
  // Same term: a meter animating for audio this window is not consuming is the same lie the caption
  // was telling, in motion rather than words.
  const liveActive = capturing && phase === "active";
  // The orb's colour follows the same in-flight dictation as the bars, for the same reason.
  const active = phase === "active";
  // WHICH sentence the live caption shows — from the tray position, the same single input the glyph
  // above takes, so the two can never argue. See voice/micPresentation `micCaptionKind`.
  const captionKind = micCaptionKind(sendMode);
  // …and WHAT that one line says, plus whether it is resting grey or live blue. The rule is pure
  // (voice/voiceStatusLine) and takes the GESTURE rather than the mic, so the words track his finger
  // instead of the capture start-up — see that module. Null means "nothing true to claim here", and
  // the arms below then render NOTHING rather than an empty row: the founder asked for the space to
  // be reclaimed, and a reserved blank line is the thing he was removing.
  const statusLine = voiceStatusLine({ captionKind, pttHeld });

  // The tray position, demoted by what the hardware is actually doing (voice/micPresentation
  // `micIndicatorFor` — its precedence note is the whole story). The position alone was not enough:
  // it cannot know that a model is still downloading, that capture is focus-paused, or that a mic
  // armed from another surface is on while the tray reads Send.
  //   speak → live open mic, successInk GREEN   (only while capture is genuinely live)
  //   ptt   → mic + pause bars, amber ORANGE
  //   send  → slashed mic, muted GREY           (unless a mic the tray does not govern is on)
  // …plus WHO HOLDS THE CARET. A terminal is not quieter capture, it is none for this box, so the
  // ring draws the same grey struck-through glyph Send does. The store's MIRROR is the right source
  // here (unlike routing, which re-reads the DOM): this is paint, and the mirror is what re-renders
  // the indicator when the caret moves.
  const focusOwner = useDictationStore((s) => s.focusOwner);
  const windowFocused = useDictationStore((s) => s.windowFocused);
  const indicator = micIndicatorFor(sendMode, {
    enabled,
    // The SAME demoted fact the presentation gets. `indicatorState` has no window term and no
    // pauseReason term — its only pause path is `status === "listening" ? intent : "paused"` — so on
    // raw `status` it painted a green "Microphone: actively listening" above a caption reading
    // "Listening paused", in the NON-terminal case, which is the common one (roborev 57117).
    status: capturing ? status : "idle",
    phase,
    modelProgress,
    focusOwner,
    // …and whether that terminal is RECEIVING the phrase, through the shipped predicate rather than
    // a re-spelled `&&`. A terminal being typed into is not a pause, and a ring reading
    // "Microphone: off" under the live "Actively listening" caption would be the mic denying
    // hardware that is transcribing (roborev 56699).
    // THE WINDOW TERM IS PART OF THIS (roborev 56706). `terminalRoutingArmed` is only the
    // MIC-STATE half — its own doc says "with the caret half left to the caller" — and the shipped
    // decision is `isTerminalRoutable()` = window active AND caret in a terminal AND that predicate.
    // The other two consumers get away without it because `dictationPauseReason` checks
    // `windowFocused` itself and returns "window" before it ever reaches the terminal branch;
    // `micIndicatorFor` has no window term anywhere, so nothing would restore it here.
    //
    // Without it: two Sparkle windows, caret parked in a terminal in window A, mic enabled and
    // phase "active" (cross-window synced). Click window B. A's per-window blur only tears down the
    // owned stream — it does not touch `status` — and the app-level `dictation://focus(false)` that
    // would never fires, because a Sparkle window is still active. So A computed `terminalRoutes:
    // true` and painted a green "actively listening" ring for a window where `isTerminalRoutable()`
    // is false and not one word is being typed into that terminal.
    terminalRoutes:
      windowFocused &&
      terminalRoutingArmed({
        enabled,
        errored: status === "error",
        woken: phase === "active",
      }),
  });
  // Colour + glyph from the shared mapping (MicButton.micVisual) — the same table the send tray
  // paints its own pills from, which is what makes "Speak" and the mic the identical green. `false`
  // for hover is not a placeholder: this is an INDICATOR, so there is no hover cue to give, because
  // there is nothing a click would do. The ring paints its glyph color AND its border from it.
  const micVis = micVisual(indicator.state, false);
  const micColor = micVis.color;
  const micBorder = micVis.color;
  // The pulsating orb glow is driven directly by the rAF loop (paintOrb), so there's no
  // render-time energy to compute here.
  // Orb blob colors track the WAVEFORM: brand cyan/blue while ACTIVELY dictating, but SHADES OF
  // GRAY while armed but not routing (passive — Push to talk between holds) — matching the gray
  // bars, so the glow doesn't imply "active" before speech is actually being routed. The grays are derived from the themed
  // muted token (the same color the bars use) so they flip correctly in light/dark mode. (Only the
  // mic GLYPH goes green when active — the waveform + orb stay blue by design.)
  const grayLight = `color-mix(in srgb, ${C.muted} 60%, white)`;
  const grayDark = `color-mix(in srgb, ${C.muted} 70%, black)`;
  const orbColors = active
    ? [C.accent, C.teal, C.accent]
    : [C.muted, grayLight, grayDark];

  return (
    // `data-mic-presentation` is the RENDERED read of the state every caption on this surface is
    // derived from — the `data-wired` / `data-mode` equivalent for the microphone. The visual
    // harness's `mic` step seeds the store's observations, and its own read-back happens INSIDE that
    // `setState`: before React commits and before the app's own derivation, which demonstrably
    // rewrites the same fields (`useDictation`'s `enabled` effect overwrites `status` via
    // `armedStatus`). So the step could only ever observe its own write, and the mic surfaces were
    // right by accident. Waiting on this attribute makes them wait on what the app actually
    // concluded (roborev 57798).
    <div
      data-testid="logo-waveform"
      data-mic-presentation={presentation}
      style={{ padding: "0 14px 8px", userSelect: "none" }}
    >
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
            behind the sidebar's header row (which the sidebar lifts above it). Only while
            actually listening. */}
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
        {/* Waveform. A METER, not a control — it used to be a button that toggled phase, i.e. a
            second way to start/stop dictating that the send tray knew nothing about. `aria-hidden`
            rather than a labelled region: it carries no information a screen reader can use that
            the caption directly below it does not already say in words. */}
        <div
          aria-hidden
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
                borderRadius: 3,
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
        </div>

        {/* Mic ring — floats over the center of the waveform. AN INDICATOR: it reports the send
            tray's position and does nothing when clicked, because the tray is the only mic control.
            `role="img"` with a state-naming label (voice/micPresentation MIC_INDICATOR_LABEL) is
            what a screen reader gets; there is no button to announce because there is no action.
            `data-hint="mic"` stays — it is still the mic ANCHOR (coach marks point at it, and
            ConciergeColumn's one-mic guard counts it). */}
        <span
          data-hint="mic"
          role="img"
          aria-label={indicator.label}
          title={indicator.label}
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
            // Border tracks the glyph color from the shared tri-state mapping (see micVis above):
            // green in Speak, orange in Push to talk, grey in Send. No hover state — see micVis.
            border: `1.5px solid ${micBorder}`,
            boxShadow:
              enabled && liveActive ? "0 0 12px rgba(52,224,240,0.6)" : "none",
            // `default`, not `pointer`. A pointer cursor on a thing that does nothing when clicked
            // is the affordance promising the control this change removed.
            cursor: "default",
            color: micColor,
            padding: 0,
            transition: "box-shadow 120ms ease, border-color 120ms ease, color 120ms ease",
          }}
        >
          {/* The ring's disc is a forest-tinted translucent surface, so the pause bars separate
              against forest here too. */}
          <MicGlyph variant={micVis.variant} size={20} surfaceColor={C.forest} />
        </span>
      </div>

      {presentation === "outOfCredits" ? (
        // Out of credits: an arm attempt was refused. Show the two-line notice in place of the
        // normal caption (auto-clears after 5s via dictationStore).
        <SidebarOutOfCreditsNotice />
      ) : presentation === "error" && errorNotice ? (
        // The REAL error, not a guess. This slot used to render one hardcoded sentence — "Mic
        // unavailable — check System Settings → Privacy → Microphone" — for every failure, using
        // `error` as a mere boolean and discarding the payload that was carefully plumbed here. So
        // an offline first-run user, whose actual failure was the model download, was sent to check
        // mic permissions they'd already granted, with no way to ever discover the true cause.
        // voiceErrorNotice maps the payload to an honest headline + remedy (raw string when
        // unrecognized). Styled to match the sibling notices in this slot: bold headline line, muted
        // detail line, 11px (the old 10px was the smallest type in the app for the most important
        // thing it had to say).
        <div style={{ marginTop: 4, color: C.muted, fontSize: 12, textAlign: "center" }}>
          <span
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              fontWeight: FONT_WEIGHT.semibold,
              color: C.amber,
            }}
          >
            <FiAlertTriangle size={11} aria-hidden style={{ flexShrink: 0 }} />
            {errorNotice.headline}
          </span>
          <span style={{ display: "block" }}>{errorNotice.detail}</span>
          {errorNotice.kind === "permission" ? (
            // The one remedy in this slot that is a place rather than an act. macOS never
            // re-prompts once it has recorded a denial, so the detail line's "Allow it in System
            // Settings → …" is the user's only way out — and making them navigate four levels of
            // System Settings by hand is where they give up. Mirrors the composer's button (the
            // same notice renders in both surfaces; neither may be the only one that's actionable).
            <button
              type="button"
              onClick={() => {
                void openUrl(MICROPHONE_SETTINGS_URL).catch((e) =>
                  console.warn("voice: open microphone settings failed", e),
                );
              }}
              // Not shared with Composer's VOICE_ERROR_ACTION, deliberately (roborev 37737). Each
              // button matches the notice it sits in, and those notices differ: Composer's is an
              // inline run of text inside a pointerEvents:none placeholder overlay (hence bold, and
              // hence that file's `pointerEvents: auto`), this one is a centered block under the
              // sidebar caption (hence display/margin, and semibold to match the headline directly
              // above it). Hoisting one object into a shared module to hold two buttons that agree
              // on nothing but "transparent, teal, clickable" would couple the surfaces without
              // making either follow the other.
              style={{
                display: "block",
                margin: "4px auto 0",
                background: "transparent",
                border: "none",
                padding: 0,
                cursor: "pointer",
                font: "inherit",
                fontWeight: FONT_WEIGHT.semibold,
                color: C.tealInk,
              }}
            >
              Open System Settings
            </button>
          ) : null}
        </div>
      ) : presentation === "preparing" ? (
        // The one-time model fetch. "Setting up" rather than "Downloading" because the percentage
        // tracks the COMPRESSED byte stream — it hits 100% with an unpack still to run, and
        // "Downloading… 100%" sitting there would read as a hang.
        <div style={{ marginTop: 4, color: C.muted, fontSize: 12, textAlign: "center" }}>
          {preparingCaption(modelPercent(modelProgress))}
        </div>
      ) : (presentation === "activeListening" || presentation === "passiveWaiting") &&
        statusLine !== null ? (
        // Live. ONE LINE (sparkle-bbfsx) — blue while the mic is live, and for Push to talk keyed on
        // whether the KEY is down rather than on the presentation, so the words change with his
        // finger rather than with the capture start-up. Plain text, not a button: it used to toggle
        // phase on click, which is the same second mic control the waveform strip was.
        //
        // This block used to be TWO lines — a grey headline naming the mode and a blue action line
        // under it — plus a device caption below. All three were the founder's complaint; see
        // voice/voiceStatusLine for his words and for the colour roles swapping.
        //
        // A null model (the tray is on Send) suppresses it entirely, even though the presentation
        // says the mic is live: that happens when the mic was armed from a surface this column does
        // not govern — an agent composer's own mic — and promising anything here would claim speech
        // that is routed to that one.
        <VoiceStatusLine model={statusLine} />
      ) : presentation === "off" &&
        captionKind === "pushToTalk" &&
        statusLine !== null &&
        !trayInert(focusOwner) ? (
        // PUSH TO TALK AT REST — a RELEASED mic, since sparkle-u81cz (see voice/sendMode
        // `micIntentForMode`). This arm exists because that fix moved this position out of the live
        // states above: without it, closing the mic would also have deleted "Hold ⌘ to talk", which
        // is the one sentence that says how to reopen it. A shut mic with no instructions is a
        // worse surface than the always-on one this replaced.
        //
        // `!trayInert` IS REQUIRED, not defensive. A live PTY owning the keyboard makes
        // `usePushToTalk` UNBIND the gesture, and `deriveMicPresentation` returns "off" on
        // `!enabled` before it ever consults `pauseReason` — so without this term a terminal caret
        // would render "Hold ⌘ to talk" over a ⌘ that does nothing. AGENTS.md is explicit that a
        // remedy string is an instruction the user will follow, so it has to be true under the same
        // conditions that produced it. Before this fix that state was `enabled: true` and reached
        // the honest `focusPaused` arm; now it falls through to silence, which claims nothing.
        //
        // THE SAME COMPONENT AND THE SAME MODEL as the live arm, which is what makes the hold
        // transition a colour change rather than a relayout: the line is in the same slot, at the
        // same size, and only its text and tone move when the key goes down. Rendered for
        // `pushToTalk` ONLY — an `off` mic under Send or master mute still claims nothing.
        //
        // THIS IS ALSO THE AUTO-SEND-OFF RESTING STATE. With the push-to-talk Auto-send switch off,
        // a release leaves the words in the composer and drops the mic, so this arm is what the user
        // reads with unsent text above it. The founder chose that deliberately over a third string:
        // the line is true (holding ⌘ does talk again) and his words are visible in the box a few
        // pixels up, so a "press Send" instruction would be telling him what he can already see.
        <VoiceStatusLine model={statusLine} />
      ) : presentation === "focusPaused" ? (
        // Armed but paused (focus lost): show the honest caption as plain text — not a
        // wake hint, since saying "Hey Sparkle" right now wouldn't be heard. `caption` here is
        // captionFor's "Listening paused…" string (non-null because focusPaused ⇒ enabled).
        <div style={{ marginTop: 4, color: C.muted, fontSize: 12, textAlign: "center" }}>{caption}</div>
      ) : null /* "off" (disarmed) — or live but the tray is on Send, i.e. a mic this column does
                  not govern. Either way there is nothing true for this surface to claim. */}

      {/* THE DEVICE LINE IS GONE IN THE ORDINARY CASE (sparkle-bbfsx): *"take out the listening
          MacBook Pro microphone completely… We shouldn't have that line on either push to talk or
          speak. Let's just recapture the space."*

          What survives is the AMBER VIRTUAL-DEVICE WARNING, which this component now renders alone
          — see its own header. That is a different fact from the chrome he cut: "Listening ·
          MacBook Pro Microphone" tells him something he already knows, while "Sparkle is bound to a
          virtual audio device" is the guard against the nine-minute silent capture that put this
          component here. Confirmed with him rather than assumed.

          Still gated on `enabled` only, so it shows while focus-paused too: the device is still the
          one that will be re-bound when focus returns, and hiding a wrong device exactly when the
          mic looks idle is how it stays invisible. A disarmed mic hears nothing, so it claims
          nothing. */}
      {enabled ? <BoundDeviceCaption /> : null}
    </div>
  );
}
