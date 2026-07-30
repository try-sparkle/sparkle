// The send tray — Send · Push to talk · Speak — the composer's full-width bottom bar.
//
// IT REPLACES ./SendRail, which was a Send button with an auto-send arming switch beside it. Two
// controls asking one question. This is that question as ONE three-position control, and **the tray
// is the only press target**: there is no separate send button, no destination dot, no label.
//
// WHY A SLIDER AND NOT A TOGGLE. The old rail could say "auto-send is on" but had no way to say
// what the microphone was doing, so the mic's state lived in a different control entirely (the
// mic glyph) and the two could contradict each other on screen. Here the mode IS the mic state:
// picking a position sets the mic, and there is exactly one place that says what happens when you
// stop talking. See voice/sendMode for the mapping, which both this and the host read.
//
// PRESENTATIONAL, like everything else in this directory: it takes a model and callbacks and reads
// no store. The host owns the timer, the mic, the routing and the announcements.
//
// IT CARRIES NO LIVE REGION. Mode changes and fires are announced through the concierge column's
// single `role="status" aria-live="polite"` node via the host's `announce()`. A second region makes
// a screen reader read every send twice — the contract is stated in ./types.ts, ./ConciergeColumn.tsx
// and ./ComposeBox.tsx, and breaking it produced roborev findings 52648/53010/53088.
import { useEffect, useRef, useState } from "react";

import { C, FONT_WEIGHT, ON_GOLD_FILL } from "../../theme/colors";
import { BLUEPRINT } from "../../theme/blueprintSpec";
import { RADIUS, TYPE } from "../../theme/scale";
import { useResolvedTheme } from "../../theme/theme";
import type { AutoSendPhase } from "../../voice/autoSendTimer";
import type { Confidence } from "../../voice/confidence";
import {
  SEND_MODES,
  SEND_MODE_LABEL,
  chicletFor,
  modeCountsDown,
  stepSendMode,
  type SendChord,
  type SendMode,
} from "../../voice/sendMode";

/**
 * How long the sweep takes to EASE to a new remaining fraction after the threshold moves.
 *
 * A receding deadline has to read as "that just got longer", not as a glitch. Without the ease the
 * fill teleports from (say) half-swept back to nearly-full between two frames, which reads as the
 * component breaking rather than as the tray changing its mind.
 *
 * Applied ONLY on a tier change. The ordinary per-frame sweep must NOT be transitioned: the model
 * republishes a slightly smaller fraction many times a second, and a 250ms transition on each of
 * those smears every step into the next and makes the fill lag visibly behind the real deadline.
 *
 * Carried over verbatim from ./SendRail, whose fill this one replaces — same mechanic, same
 * direction, same number, so there is nothing new to learn.
 */
export const THRESHOLD_EASE_MS = 250;

/** matchMedia is absent under jsdom — treat "can't ask" as "no reduction requested". */
function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Everything the tray draws about the countdown. Supplied by the host from voice/autoSendTimer,
 *  unchanged from ./SendRail's model. */
export interface SendTrayModel {
  phase: AutoSendPhase;
  /**
   * The agent this send would reach — "Concierge" or a build agent's name.
   *
   * THE MIS-ROUTE SAFETY NET (PRD §4). **The prototype has no such thing and the app does, so the
   * app wins.** A standalone mock has one destination and could honestly say "no destination dot or
   * label"; this composer routes by @-mention to any agent in the fleet, and the seconds before an
   * auto-send are the user's only chance to notice they are about to dictate into the wrong one.
   * Dropping it to match a drawing would delete a safety feature that exists because a real
   * misroute happened.
   *
   * Shown on the Speak pill WHENEVER Speak is selected — not only while a clock is running. See the
   * render site: dropping it the moment counting began is a mistake ./SendRail made and corrected.
   */
  targetName: string;
  /** The confidence tier the current transcript earns — drives the very-low fill treatment only. */
  tier: Confidence;
  /** How much of the sweep is left, in [0, 1]. 1 = just started, 0 = firing. */
  remainingFraction: number;
}

export interface SendModeTrayProps {
  /** Which position the tray is parked at. */
  mode: SendMode;
  /** The user picked a different position. */
  onModeChange: (next: SendMode) => void;
  /** The user pressed the ALREADY-SELECTED position and that position sends on press. */
  onSend: () => void;
  /** Whether there is anything to send (text or attachments) — dims the press affordance. */
  canSend: boolean;
  /** The countdown's live state. Absent → nothing is counting. */
  model?: SendTrayModel;
  /**
   * A live PTY owns the keyboard, so this control is NOT BEING ADDRESSED.
   *
   * Decided by the host from voice/dictationFocus (`classifyFocusOwner`), never re-derived here —
   * see voice/sendMode `trayInert` for why "is the composer focused" is not the same question.
   */
  inert?: boolean;
  /** Which keystroke sends, so the chiclets can follow the setting rather than assert a default. */
  chord: SendChord;
  /**
   * The composer around this tray is PATCHED to a terminal, so the strip is drawn on the terminal
   * flood rather than on `inputSurface` — the same flag, from the same source, that already swaps
   * ComposeBox's own border (see its `wired` prop).
   *
   * `C.hairline` is the CHROME seam and is deliberately not a token the terminal plane accepts —
   * theme/chromeContrast.test.ts pairs edges to the planes they are drawn on because light
   * `hairline` on `forest` measures 1.195 against a 1.2 floor, and `termHair` is the token the spec
   * draws there instead (roborev 55244).
   */
  wired?: boolean;
}

/** The strip's height. Matches what the Send button used to be, so the row has no slack. */
const TRAY_HEIGHT = 42;

/** The identity colour of each position. Send is the app's PRIMARY fill (the pair every other
 *  primary button uses); the two voice positions are amber and green, matching the mic glyph's own
 *  resting palette (components/MicButton `micVisual`) so the tray and the mic never disagree about
 *  what colour "armed" and "live" are. */
const MODE_INK: Record<SendMode, string> = {
  send: C.goldFill,
  ptt: C.amber,
  speak: C.successInk,
};

/** The width reserved for a keycap chiclet AT REST, so nothing shifts when one appears on hover or
 *  focus. Reserving the space rather than letting the pill grow is the whole reason the reveal is
 *  usable — a label that jumps sideways under the pointer is a label you cannot read. */
const CHICLET_SLOT = 30;

export function SendModeTray({
  mode,
  onModeChange,
  onSend,
  canSend,
  model,
  inert = false,
  chord,
  wired = false,
}: SendModeTrayProps) {
  const themeMode = useResolvedTheme();
  const edge = wired ? BLUEPRINT[themeMode].termHair : C.hairline;

  // The sweep runs in Speak ONLY, and only while the timer is actually counting. Both halves
  // matter: `modeCountsDown` is the design rule (Send sends on press, Push to talk sends on
  // release — a timer in either would make the deliberate mode feel laggier than the automatic
  // one), and `phase` is whether a clock is running right now.
  const counting = modeCountsDown(mode) && model?.phase === "counting";
  const veryLow = counting && model?.tier === "verylow";
  const remaining = Math.min(1, Math.max(0, model?.remainingFraction ?? 1));

  // ── The one-shot ease on a threshold change ────────────────────────────────────────────────
  // Armed DURING RENDER (React's "adjust state when a prop changes"), not in an effect. In an
  // effect it is one render too late to do anything: render N commits the new width with
  // `transition: "none"`, and only afterwards does the passive effect set `easing`, producing a
  // render N+1 that changes nothing but the `transition` declaration. A CSS transition fires when
  // an animatable property changes WHILE a transition is declared, so the fill teleported every
  // time — the exact thing THRESHOLD_EASE_MS exists to prevent. (./SendRail learned this the hard
  // way, and its test passed throughout, because the test asserted the `transition` string alone.)
  const reduceMotion = prefersReducedMotion();
  const tier = model?.tier;
  const lastTier = useRef(tier);
  const [easing, setEasing] = useState(false);
  if (lastTier.current !== tier) {
    lastTier.current = tier;
    setEasing(!reduceMotion);
  }
  useEffect(() => {
    if (!easing) return;
    const id = setTimeout(() => setEasing(false), THRESHOLD_EASE_MS);
    return () => clearTimeout(id);
  }, [easing]);

  // Which pill is showing its keycap. Hover OR keyboard focus, never at rest — a chiclet on every
  // pill all the time is three keycaps competing with the three labels that are the actual content.
  const [revealed, setRevealed] = useState<SendMode | null>(null);

  // The pill nodes, so an arrow step can move DOM focus with the selection. Selection and focus have
  // to stay the same fact — see the arrow handler.
  const pills = useRef<Partial<Record<SendMode, HTMLButtonElement | null>>>({});

  return (
    <div
      data-testid="send-mode-tray"
      // A GROUP of toggle buttons, not a `radiogroup`. The Send position is BOTH the mode selector
      // and the submit control — pressing it while selected sends — and a `radio` that submits is a
      // lie to assistive tech about what activating it does. `aria-pressed` says the same "this one
      // is on" without claiming the activation is only a selection. It also keeps the position
      // reachable as `getByRole("button", { name: "Send" })`, which is how every keybinding, voice
      // command and existing test in this repo already addresses it.
      role="group"
      aria-label="Send mode"
      data-mode={mode}
      // Assertable WITHOUT reading styles, and named for what it MEANS rather than for the filter
      // that draws it: the control is not disabled, it is not being addressed.
      data-inert={inert ? "true" : undefined}
      data-counting={counting ? "true" : undefined}
      data-tier={counting ? model?.tier : undefined}
      style={{
        position: "relative",
        display: "flex",
        alignItems: "stretch",
        gap: 4,
        height: TRAY_HEIGHT,
        marginTop: 8,
        padding: 3,
        borderRadius: RADIUS.modal,
        // LONGHAND, not the `border` shorthand: the value is a CSS variable, and a shorthand
        // carrying a `var()` cannot be decomposed into its longhands — the whole declaration stays
        // an opaque string, so nothing (a test, a devtools inspector) can read the edge back off the
        // node. The paint is identical either way. ./SendRail carried the same note for the same
        // reason; losing it in the port cost one red test.
        borderWidth: 1,
        borderStyle: "solid",
        borderColor: edge,
        background: `color-mix(in srgb, ${edge} 8%, transparent)`,
        overflow: "hidden",
        // INERT = GREY, and grey by DESATURATION rather than by opacity — the PlanBuildToggle
        // precedent. Opacity would make the tray read as fading out of the interface (i.e. as
        // failing); grayscale keeps every edge and every label at full strength and removes only
        // the one channel that was carrying "this mode is live". It still shows WHICH mode is
        // selected: the mode has not been reset, it is merely not receiving you, and colour returns
        // the instant focus leaves the terminal.
        filter: inert ? "grayscale(1)" : undefined,
      }}
    >
      {/* THE TRAY SWEEP. The whole tray fills as one surface: anchored RIGHT (`right: 0`, no
          `left`), width = the remaining fraction, so the leading edge walks left-to-right and the
          mass converges on Speak — the position that is doing the counting.

          THE DIRECTION CARRIES MEANING, which is why this treatment won over five others. Every
          alternative showed only how much time was left; this one also shows where it is going.
          Draining toward Send would point at a position that never counts. */}
      {counting && (
        <div
          data-testid="send-tray-sweep"
          aria-hidden
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            right: 0,
            width: `${Math.round(remaining * 100)}%`,
            zIndex: 0,
            // VERY LOW IS VISUALLY UNMISTAKABLE. In motion it reads on its own — ten seconds of
            // sweep is imperceptible frame to frame — but a still frame cannot show motion, so the
            // tier also gets ONE non-numeric cue: a hatched, dimmed fill instead of a solid one.
            // Still no numerals anywhere: a countdown that shows "3…2…1" invites the user to race
            // it, and the number is not the information.
            background: veryLow
              ? `repeating-linear-gradient(135deg, color-mix(in srgb, ${C.successInk} 14%, transparent) 0 6px, transparent 6px 12px)`
              : `color-mix(in srgb, ${C.successInk} 18%, transparent)`,
            borderLeft: `1px solid color-mix(in srgb, ${C.successInk} ${veryLow ? 35 : 70}%, transparent)`,
            transition: easing ? `width ${THRESHOLD_EASE_MS}ms ease-out` : "none",
          }}
        />
      )}

      {SEND_MODES.map((m) => {
        const selected = m === mode;
        const ink = MODE_INK[m];
        // PRESSING THE SELECTED POSITION SENDS — except in Push to talk, where releasing the hold
        // already sends and a press would be a second, competing way to do the same thing.
        const pressSends = selected && m !== "ptt";
        const showCap = revealed === m;
        // THE MIS-ROUTE SAFETY NET (see SendTrayModel.targetName). Two rules carried over from
        // ./SendRail verbatim, both of which it learned the hard way:
        //
        //  • SHOWN WHENEVER SPEAK IS SELECTED, counting or not — NOT only while a clock runs. The
        //    rail used to drop the destination the moment counting began, so the label went
        //    "→ Build 4" → "Build 4" and users read it as the target having VANISHED at exactly the
        //    moment it mattered most. A state change must never subtract information the other
        //    state was showing.
        //  • PREFIXED, not substituted. "Speak → Build 4" keeps the control recognisable across
        //    state changes AND keeps the visible text inside the accessible name, without which
        //    this is a WCAG 2.5.3 (Label in Name) failure — a voice-control user saying "click
        //    Build 4" could not hit it.
        const showTarget = selected && m === "speak" && Boolean(model?.targetName);
        const label = showTarget
          ? `${SEND_MODE_LABEL[m]} → ${model?.targetName}`
          : SEND_MODE_LABEL[m];
        return (
          <button
            key={m}
            type="button"
            aria-pressed={selected}
            data-mode-pill={m}
            // The Send position keeps the accessible name "Send" in EVERY mode, not only when it is
            // selected. It is the name every keybinding, every voice-control user and every test in
            // this repo already reaches for, and a control that renames itself as the surface
            // changes state is a control nobody can address twice the same way.
            aria-label={m === "send" ? "Send" : label}
            aria-keyshortcuts={pressSends ? "Meta+Enter Control+Enter" : undefined}
            title={pressSends ? `${label} (${chicletFor(m, chord)})` : label}
            disabled={pressSends && !canSend}
            // Three outcomes, and the third is DOING NOTHING: pressing the already-selected Push
            // to talk is neither a send (the release is what sends) nor a mode change (you are
            // already there). Falling through to `onModeChange` instead would fire a same-value
            // change on every stray click, which the host cannot tell from a real one — and the
            // host's mode setter drives the MICROPHONE.
            onClick={() => {
              if (pressSends) onSend();
              else if (!selected) onModeChange(m);
            }}
            // ← / → step the tray one position — the standard gesture for a segmented control, and
            // the only way to reach Push to talk without a pointer.
            //
            // IT STEPS FROM *THIS* PILL, not from the selected one, and focus follows the move
            // (the roving-tabindex pattern). Stepping from `mode` while focus sat elsewhere was
            // incoherent AND unsafe: with Send selected and the focus ring on Speak, `←` was
            // swallowed by the clamp while `→` armed the microphone at a position two pills from
            // what the user was looking at, and a screen reader announced nothing because
            // `aria-pressed` changed on an unfocused element (roborev 56071).
            //
            // CLAMPED, NEVER WRAPPING (voice/sendMode `stepSendMode`): wrapping would put `send`
            // (microphone off, nothing listening) one keypress from `speak` (microphone live,
            // auto-sending) with the overshoot invisible. Bound per-pill rather than on the group so
            // the textarea's own arrow keys — where `→` already accepts a ghost completion — are
            // untouched.
            onKeyDown={(e) => {
              if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
              e.preventDefault();
              const next = stepSendMode(m, e.key === "ArrowRight" ? 1 : -1);
              if (next === m) return; // clamped at an end — visibly inert, nothing moves
              onModeChange(next);
              pills.current[next]?.focus();
            }}
            ref={(el) => {
              pills.current[m] = el;
            }}
            // ROVING TABINDEX: one stop for the whole tray, on the selected position, so Tab moves
            // THROUGH this control rather than into three separate stops — and so the pill the
            // arrows start from is the one Tab lands on.
            tabIndex={selected ? 0 : -1}
            onMouseEnter={() => setRevealed(m)}
            onMouseLeave={() => setRevealed((r) => (r === m ? null : r))}
            onFocus={() => setRevealed(m)}
            onBlur={() => setRevealed((r) => (r === m ? null : r))}
            style={{
              position: "relative",
              zIndex: 1,
              flex: 1,
              minWidth: 0,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              height: "100%",
              padding: "0 8px",
              borderRadius: RADIUS.input,
              font: "inherit",
              fontSize: TYPE.small,
              fontWeight: selected ? FONT_WEIGHT.bold : FONT_WEIGHT.semibold,
              cursor: pressSends && !canSend ? "default" : "pointer",
              opacity: pressSends && !canSend ? 0.45 : 1,
              transition: "background 120ms ease, border-color 120ms ease, color 120ms ease",
              // SEND IS FILLED; the two voice positions are TINTED. That asymmetry is the design,
              // not an oversight: Send is an off state for the MICROPHONE ONLY, never for the
              // control, so in Send the pill is the most actionable this tray ever gets — the same
              // primary fill every other primary button in the app uses. In Push to talk and Speak
              // the action is your voice, and a second hot button next to a live microphone is a
              // second thing claiming to be the way to send. Mic dead, button hot; mic hot, button
              // quiet.
              ...(selected && m === "send"
                ? { background: ink, color: ON_GOLD_FILL, border: `1.5px solid ${ink}` }
                : selected
                ? {
                    background: `color-mix(in srgb, ${ink} 22%, transparent)`,
                    color: ink,
                    border: `1.5px solid ${ink}`,
                  }
                : { background: "transparent", color: C.conciergeMuted, border: "1.5px solid transparent" }),
            }}
          >
            <span
              data-testid={`send-mode-label-${m}`}
              style={{ overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}
            >
              {label}
            </span>
            {/* THE KEYCAP CHICLET. Hover or keyboard focus only, never at rest, at the pill's right
                inside edge. The slot is reserved in BOTH states so nothing shifts when it appears.
                What it says comes from voice/sendMode `chicletFor`, which is the same function the
                keystroke handler asks — a chip that advertises a chord the handler does not honour
                is worse than no chip at all. */}
            <span
              data-testid={showCap ? `send-chiclet-${m}` : undefined}
              aria-hidden
              style={{
                flex: "none",
                width: CHICLET_SLOT,
                textAlign: "right",
                // TYPE.micro (10), not an off-scale 11: a keycap IS a badge — the rung this scale
                // names for tracked labels, badges and ticks. theme/scale.test.ts ratchets off-scale
                // fontSize at zero, so an eyeballed 11 here is a hard red, not a nit.
                fontSize: TYPE.micro,
                opacity: showCap ? 0.85 : 0,
              }}
            >
              {chicletFor(m, chord)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
