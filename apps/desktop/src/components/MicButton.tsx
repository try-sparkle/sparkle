import { useEffect, useRef, useState, type CSSProperties } from "react";
import { TbMicrophone, TbMicrophoneOff } from "react-icons/tb";
import { FiDownloadCloud } from "react-icons/fi";
import { C, DANGER } from "../theme/colors";
import { useDictationStore } from "../stores/dictationStore";
import { useAuthStore } from "../stores/authStore";
import { hasAiCredits } from "../services/aiGate";
import type { Me } from "../services/entitlement";
import type { Phase } from "../voice/wakeMachine";

/** Should an attempt to ARM the mic be refused because the user is out of credits? Voice spends
 *  credits, so arming (turning the mic on / setting a listening intent) with an empty balance is
 *  blocked and the out-of-credits notice is shown instead. Pure so the decision is unit-testable;
 *  the caller pairs it with dictationStore.showOutOfCreditsNotice for the effect. */
export function shouldBlockMicArm(me: Me | null): boolean {
  return !hasAiCredits(me);
}

// Shared microphone control. The top waveform ring (LogoWaveform) and the composer-left mic must
// behave IDENTICALLY, so the whole behavior — state derivation, click cycle, icon/color mapping —
// lives here and both render sites consume it. Keeping it in one place means the two mics can't
// drift.
//
// The mic has four user-facing states, all derived from the existing dictation store (no new
// state added):
//   off       = !enabled                      — mic released, nothing captured
//   preparing = enabled && a model download in flight — armed, but voice can't work YET
//   paused    = enabled && !liveActive         — on, but waiting for the wake word (or focus-paused)
//   active    = enabled && status listening && phase active — actively dictating right now
//
// A click never jumps straight from active to off: it PAUSES first. The full cycle:
//   off → setEnabled(true) → paused
//   active → setPhase("passive") → paused   (stays on; stops dictating)
//   paused → setEnabled(false) → off
// Preparing clicks like paused (→ off), so the user can always back out of a long first-run
// download rather than being stuck watching it.

export type MicState = "off" | "preparing" | "paused" | "active";

/** What the user ASKED for, as offered by the hover pill: the three states they can choose between.
 *  Deliberately narrower than MicState — "preparing" is something the app reports, never something
 *  a user can pick, so the pill's options can't accidentally grow a fourth entry. */
export type MicIntent = Exclude<MicState, "preparing">;

/** THE single source of truth for the mic's state, derived purely from the dictation-store
 *  fields. Every mic surface — the top ring (LogoWaveform), the composer-left mic (ComposerMic), and
 *  any status text — MUST route through this so they can never disagree about what state the mic is
 *  in. Keeping the derivation in one pure, tested function (rather than re-inlining `!enabled ? …`
 *  at each call site) is the guardrail that keeps the two controls in lockstep.
 *
 *  liveActive (capture genuinely live AND active phase) is the only "active" — phase alone isn't
 *  enough, since we can sit in the active phase while focus-paused (status idle).
 *
 *  `modelProgress` (the store field; non-null ONLY while the backend is fetching the voice model)
 *  is what makes the first-run wait honest. useDictation sets status "listening" optimistically,
 *  BEFORE start_dictation — which on a cold start blocks for minutes on a ~482 MB download — so
 *  without this the mic drew the healthy "paused" glyph for the whole wait and the composer invited
 *  the user to say the wake word at a model that wasn't on disk yet. It outranks "active" because a
 *  missing model can't dictate no matter what phase the user selects. Optional (defaults to null)
 *  so a WARM start — model already present, no progress events, every existing call site — derives
 *  exactly what it always did.
 *
 *  Deliberately NOT handled here: `status === "error"`. A failed mic derives "paused", and the
 *  failure is surfaced by the caption (LogoWaveform) and the composer notice instead — both of
 *  which name the actual cause and offer the remedy, which a glyph cannot. Adding an error VARIANT
 *  would be a reasonable follow-up (the glyph still rests amber during a failure), but it would
 *  also change what a click does in that state, so it is out of scope here rather than overlooked. */
export function deriveMicState(
  enabled: boolean,
  status: "idle" | "listening" | "error",
  phase: Phase,
  modelProgress: { done: number; total: number | null } | null = null,
): MicState {
  if (!enabled) return "off";
  if (modelProgress !== null) return "preparing";
  const liveActive = status === "listening" && phase === "active";
  return liveActive ? "active" : "paused";
}

/** The icon shape the glyph should draw. `open` = live mic, `slash` = muted mic, `pause` = the
 *  orange "mic + two pause bars" affordance, `loading` = the mic is armed but the voice model is
 *  still coming down (a cloud-download glyph, deliberately NOT a mic shape — the point is that it
 *  cannot be mistaken for a ready mic at a glance). */
export type MicVariant = "open" | "slash" | "pause" | "loading";

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
  const modelProgress = useDictationStore((s) => s.modelProgress);
  const setEnabled = useDictationStore((s) => s.setEnabled);
  const setPhase = useDictationStore((s) => s.setPhase);
  const showOutOfCreditsNotice = useDictationStore((s) => s.showOutOfCreditsNotice);
  const clearOutOfCreditsNotice = useDictationStore((s) => s.clearOutOfCreditsNotice);

  // Single source of truth (deriveMicState) so this control and every other mic surface agree.
  const state: MicState = deriveMicState(enabled, status, phase, modelProgress);

  const onClick = () => {
    if (state === "off") {
      // Arming the mic spends credits — refuse it while out of credits, showing the notice instead
      // of enabling. Read the balance at click time (no reactive subscription needed here).
      if (shouldBlockMicArm(useAuthStore.getState().me)) {
        showOutOfCreditsNotice();
        return;
      }
      // A successful arm cancels any pending refuse-timer + clears a stale notice, so a
      // refill-then-rearm within the 5s window can't be force-disarmed (and the notice can't
      // linger next to an armed mic).
      clearOutOfCreditsNotice();
      setEnabled(true); // off → paused (arm the mic; it resumes wake-word listening)
    } else if (state === "active")
      setPhase("passive"); // active → paused (stop dictating, stay listening — never turn off)
    else setEnabled(false); // paused (or preparing) → off
  };

  // Preparing gets its own label rather than reusing the paused one: to a screen reader (and to
  // anyone hovering) an armed-but-still-downloading mic must not sound like a ready one. It still
  // names the action it performs ("turn off microphone") since that's what a click does.
  const ariaLabel =
    state === "off"
      ? "Turn on microphone"
      : state === "active"
      ? "Pause listening"
      : state === "preparing"
      ? "Setting up voice — turn off microphone"
      : "Turn off microphone";
  const title =
    state === "off"
      ? "Turn on"
      : state === "active"
      ? "Pause"
      : state === "preparing"
      ? "Setting up voice…"
      : "Turn off";

  return { state, onClick, ariaLabel, title };
}

/** The hover-pill's model: the user's chosen INTENT plus the three direct "jump straight to this
 *  state" setters. Unlike useMicToggle (a single cycling click), each setter lands one explicit
 *  state, so the pill's three options map 1:1 to the store.
 *
 *  `intent` is derived from enabled + phase (NOT status), so it reflects what the user picked even
 *  while focus-paused — click "listening" and the pill keeps that option checked even if capture
 *  hasn't resumed yet (the resting mic glyph still honestly shows paused until it does). */
export function useMicActions(): {
  intent: MicIntent;
  setActive: () => void;
  setMuted: () => void;
  setOff: () => void;
} {
  const enabled = useDictationStore((s) => s.enabled);
  const phase = useDictationStore((s) => s.phase);
  const setEnabled = useDictationStore((s) => s.setEnabled);
  const setPhase = useDictationStore((s) => s.setPhase);
  const showOutOfCreditsNotice = useDictationStore((s) => s.showOutOfCreditsNotice);
  const clearOutOfCreditsNotice = useDictationStore((s) => s.clearOutOfCreditsNotice);

  const intent: MicIntent = !enabled ? "off" : phase === "active" ? "active" : "paused";

  return {
    intent,
    // Arm the mic AND route speech to the box (green "listening"). If focus-paused, phase-active
    // takes effect once capture resumes — same contract as togglePhase-while-paused. Refused (notice
    // instead) while out of credits, since arming spends credits.
    setActive: () => {
      if (shouldBlockMicArm(useAuthStore.getState().me)) {
        showOutOfCreditsNotice();
        return;
      }
      // Cancel any pending refuse-timer + clear a stale notice on a successful arm (see useMicToggle).
      clearOutOfCreditsNotice();
      setEnabled(true);
      setPhase("active");
    },
    // Arm but don't dictate (orange "muted" — on, waiting for the wake word). Same out-of-credits
    // refusal as setActive.
    setMuted: () => {
      if (shouldBlockMicArm(useAuthStore.getState().me)) {
        showOutOfCreditsNotice();
        return;
      }
      clearOutOfCreditsNotice();
      setEnabled(true);
      setPhase("passive");
    },
    // Release the mic entirely (red "off"). Always allowed — turning OFF never spends credits.
    setOff: () => setEnabled(false),
  };
}

/** Hover-intent open/close for the mic pill. Opening is immediate; closing waits `closeDelayMs` so
 *  the pointer can travel from the mic to the pill (both spread `hoverProps`) without the pill
 *  vanishing mid-move. `close()` dismisses immediately (used right after a pick). */
export function useHoverMenu(closeDelayMs = 220): {
  open: boolean;
  hoverProps: { onMouseEnter: () => void; onMouseLeave: () => void };
  close: () => void;
} {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  useEffect(() => clear, []);
  return {
    open,
    hoverProps: {
      onMouseEnter: () => {
        clear();
        setOpen(true);
      },
      onMouseLeave: () => {
        clear();
        timer.current = setTimeout(() => setOpen(false), closeDelayMs);
      },
    },
    close: () => {
      clear();
      setOpen(false);
    },
  };
}

/** Map (state, hover) → the icon variant to draw and the color to draw it in. The hover cue is
 *  direction-aware and matches what the click does:
 *   - off:    gray slash at rest → teal on hover ("click to turn on")
 *   - paused: orange mic+pause at rest → red slash on hover ("click to turn off")
 *   - active: live open mic at rest → orange mic+pause on hover ("click to pause")
 *  The active rest color is the left-column "working" GREEN (successInk: #34c759 dark / #15803d
 *  light) — the same green the sidebar paints a running agent — so an actively-listening mic reads
 *  green, not the old brand cyan. It is a glyph/text color, so we use the themed successInk (not the
 *  constant BRAND.success) for light-mode legibility, mirroring statusInk("working").
 *  Exported so the ring can also color its BORDER to match the glyph. */
export function micVisual(state: MicState, hovered: boolean): { color: string; variant: MicVariant } {
  if (state === "off") return { color: hovered ? C.teal : C.muted, variant: "slash" };
  // preparing: a muted download glyph at rest — muted (not amber) and not a mic shape, so it can't
  // be mistaken for the ready/paused mic it used to be drawn as. Hover matches what a click does
  // (turn off), same as paused.
  if (state === "preparing")
    return hovered ? { color: DANGER, variant: "slash" } : { color: C.muted, variant: "loading" };
  if (state === "paused")
    return hovered ? { color: DANGER, variant: "slash" } : { color: C.amber, variant: "pause" };
  // active
  return hovered ? { color: C.amber, variant: "pause" } : { color: C.successInk, variant: "open" };
}

/** A microphone with two vertical pause bars overlaid through its center — the "paused / click to
 *  pause" affordance, the pause-symbol counterpart to the slashed mute glyph. Both the mic and the
 *  bars inherit `currentColor`, so the parent's `color` tints the whole glyph (amber in practice).
 *  The bars are drawn taller than the mic body and separated from it by a thin ring in the caller's
 *  SURFACE color so they read as bars IN FRONT OF the mic even though they share its color. The ring
 *  must match whatever the glyph sits on (each render site passes its own backdrop), so it reads as
 *  a clean cut-out rather than a faint outline of the wrong color. */
export function MicPauseIcon({ size = 20, surfaceColor = C.forest }: { size?: number; surfaceColor?: string }) {
  // Bars are deliberately hair-thin and a touch short so they read as a pause hint sitting IN FRONT
  // of the mic without masking it. Held at ~1.5px (not rounded up to 2) and ~0.69 of the height, so
  // the mic body clearly shows through between and around them.
  const barW = Math.max(1.5, size * 0.072);
  const barH = Math.round(size * 0.69);
  const gap = Math.max(2, Math.round(size * 0.16));
  const bar: CSSProperties = {
    width: barW,
    height: barH,
    borderRadius: barW,
    background: "currentColor",
    // Hair-thin ring in the caller's surface color so each bar just cleanly cuts out of the
    // same-colored mic (0.5px) — minimal blanking of the mic behind the bars.
    boxShadow: `0 0 0 0.5px ${surfaceColor}`,
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
  // The one-time voice-model fetch. `sparkle-pulse` (index.css) is the app's existing "working on
  // it" opacity breathe — reused rather than invented so the glyph reads as in-progress, and so it
  // stays a plain opacity fade (no motion) for anyone sensitive to movement.
  if (variant === "loading")
    return <FiDownloadCloud size={size} className="sparkle-pulse" aria-hidden />;
  return <TbMicrophone size={size} />;
}

// The three pill options, TOP → BOTTOM as the user reads them: green listening, orange muted, red
// off. Each carries the glyph shape, its identity color, and the action key into useMicActions.
// (Colors mirror micVisual's resting palette: successInk green / amber / DANGER red.)
const MIC_OPTIONS: {
  key: MicIntent;
  variant: MicVariant;
  color: string;
  label: string;
  title: string;
}[] = [
  { key: "active", variant: "open", color: C.successInk, label: "Set microphone to listening", title: "Listening" },
  { key: "paused", variant: "pause", color: C.amber, label: "Set microphone to muted", title: "Muted" },
  { key: "off", variant: "slash", color: DANGER, label: "Set microphone to off", title: "Off" },
];

/** The vertical hover pill. Shows the three explicit mic modes stacked top→bottom (green listening
 *  / orange muted / red off); clicking one drives the store straight to that state. The option
 *  matching the current intent is outlined + tinted. Rendered by each mic on hover (both the
 *  composer-left mic and the top ring), so the pill behaves identically in both places.
 *
 *  Positioned absolutely inside the caller's `position: relative` box; `placement` picks whether it
 *  grows UP (composer mic, anchored at window bottom) or DOWN (top ring). `hoverProps` is threaded
 *  from the caller's useHoverMenu so hovering the pill itself keeps it open. `surfaceColor` is the
 *  pill's own background — the pause glyph's bar-separation ring must match it. */
export function MicMenu({
  placement = "up",
  surfaceColor = C.deepForest,
  glyphSize = 18,
  onChoose,
  hoverProps,
}: {
  placement?: "up" | "down";
  surfaceColor?: string;
  glyphSize?: number;
  onChoose?: () => void;
  hoverProps?: { onMouseEnter: () => void; onMouseLeave: () => void };
}) {
  const { intent, setActive, setMuted, setOff } = useMicActions();
  const run: Record<MicIntent, () => void> = { active: setActive, paused: setMuted, off: setOff };
  return (
    <div
      role="menu"
      aria-label="Microphone mode"
      {...hoverProps}
      style={{
        position: "absolute",
        left: "50%",
        transform: "translateX(-50%)",
        ...(placement === "up"
          ? { bottom: "calc(100% + 6px)" }
          : { top: "calc(100% + 6px)" }),
        zIndex: 60,
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: 5,
        borderRadius: 999,
        background: `color-mix(in srgb, ${surfaceColor} 94%, transparent)`,
        border: `1px solid color-mix(in srgb, ${C.muted} 32%, transparent)`,
        boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
      }}
    >
      {MIC_OPTIONS.map((opt) => {
        const selected = intent === opt.key;
        return (
          <button
            key={opt.key}
            type="button"
            role="menuitemradio"
            aria-checked={selected}
            aria-label={opt.label}
            title={opt.title}
            onClick={() => {
              run[opt.key]();
              onChoose?.();
            }}
            style={{
              width: 30,
              height: 30,
              display: "grid",
              placeItems: "center",
              borderRadius: "50%",
              cursor: "pointer",
              padding: 0,
              color: opt.color,
              background: selected ? `color-mix(in srgb, ${opt.color} 22%, transparent)` : "transparent",
              border: `1.5px solid ${selected ? opt.color : "transparent"}`,
              transition: "background 120ms ease, border-color 120ms ease",
            }}
          >
            <MicGlyph variant={opt.variant} size={glyphSize} surfaceColor={surfaceColor} />
          </button>
        );
      })}
    </div>
  );
}

/** The bare mic button that sits to the LEFT of the composer input box — just the glyph, no ring,
 *  no waveform. It shares useMicToggle + micVisual with the top ring, so a click here takes the
 *  exact same action. It is only shown while the mic is ON (paused or active); when the mic is off
 *  it renders nothing, so it disappears from beside the composer. */
export function ComposerMic() {
  const { state, onClick, ariaLabel, title } = useMicToggle();
  const [hover, setHover] = useState(false);
  // Hovering the mic reveals the three-option pill (see MicMenu). The pill opens UP because the
  // composer sits at the window bottom — there's room above (the message list), none below.
  const menu = useHoverMenu();

  // Off → not rendered at all (the whole point: it disappears when the mic is off). The mic is then
  // re-enabled from the always-present top ring, whose pill also offers "listening".
  if (state === "off") return null;

  const { color, variant } = micVisual(state, hover);
  return (
    <span
      {...menu.hoverProps}
      style={{
        // Top-aligned: when the composer grows to multiple lines, the mic stays pinned to the TOP
        // of the box (beside the first line), not the bottom.
        alignSelf: "flex-start",
        position: "relative",
        display: "inline-flex",
      }}
    >
      <button
        type="button"
        data-hint="composer-mic"
        onClick={onClick}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        aria-label={ariaLabel}
        title={title}
        style={{
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
      {menu.open && (
        <MicMenu placement="up" onChoose={menu.close} hoverProps={menu.hoverProps} />
      )}
    </span>
  );
}
