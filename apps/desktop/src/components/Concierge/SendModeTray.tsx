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

import {
  DEFAULT_SPEAK_LEFT_FRAC,
  TRAY_GEOMETRY,
  speakLeftFraction,
} from "./trayGeometry";

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
  trayLabelFor,
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

// The keycap slot's width lives in ./trayGeometry (`chicletSlot`) — it is one of the inputs to the
// short-label threshold's derivation, so it must not have a second definition here.

// The tray's horizontal geometry and the two decisions derived from it live in ./trayGeometry — a
// leaf module with no React, so a NODE-environment unit test can read the constants without pulling
// this component (and its store/Tauri graph) in behind them (roborev 56223). Re-exported here
// because existing call sites and tests import them from this module.
export {
  TRAY_GEOMETRY,
  WIDEST_LABEL_PX,
  DEFAULT_SPEAK_LEFT_FRAC,
  fullLabelsFitAtPx,
  speakLeftFraction,
} from "./trayGeometry";

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
  // NO `veryLow` DERIVATION ANY MORE. It existed only to switch the sweep to a hatched fill and to
  // dim the leading edge — the founder's "shaded candy cane", which he could not interpret. The tier
  // is still communicated, by how FAST the sweep travels (see the fill's comment below), so nothing
  // downstream needs to know which rung it is on.
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

  // ── HOW WIDE THE TRAY ACTUALLY IS ────────────────────────────────────────────────────────────
  // Measured, not inferred from the window: this control lives in the concierge COLUMN, which the
  // user resizes independently of the window (and which can be torn out into its own window), so
  // window width is not its width. A ResizeObserver on the tray's own box is the only honest
  // source.
  //
  // 0 means "not measured yet" and `trayLabelFor` reads that as the full labels — see its doc. The
  // observer is created lazily so the (observer-less) jsdom test env simply stays at 0 rather than
  // throwing; the label RULE is tested directly against `trayLabelFor`, which is the part that
  // carries the behaviour. jsdom has no layout engine, so a test that rendered this and measured
  // would read 0 for every width and pass without proving anything.
  const trayRoot = useRef<HTMLDivElement | null>(null);
  const [trayWidth, setTrayWidth] = useState(0);
  /**
   * Where the Speak pill's LEFT EDGE sits, as a fraction of the tray — the point the sweep stops at.
   *
   * Defaults to the geometric answer for evenly-shared pills ((n-1)/n = 2/3 for three), which is
   * within a few pixels of the measured value and, crucially, is CORRECT IN JSDOM — `offsetLeft` is
   * always 0 there, so a 0 default would collapse the sweep to a no-op in every test.
   */
  const [speakLeftFrac, setSpeakLeftFrac] = useState(DEFAULT_SPEAK_LEFT_FRAC);
  useEffect(() => {
    const el = trayRoot.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      // Only real, changed measurements. A 0 from a hidden/unmounted box would flip the labels back
      // to full width for a frame on the way out, which is a visible flicker for no information.
      if (typeof w === "number" && w > 0) setTrayWidth((prev) => (prev === w ? prev : w));
      // WHERE THE SWEEP STOPS. Measured off the Speak pill rather than assumed, because the pills
      // are `flex: 1` but not exactly equal thirds once padding, gaps and the chiclet slot are in.
      // `offsetLeft` is relative to the tray (which is `position: relative`), so this is already the
      // fraction we want. Guarded on both being real numbers so an unmeasurable layout keeps the
      // geometric default below instead of collapsing the sweep to nothing.
      // PADDING BOX, not contentRect. `offsetLeft` is measured from the padding edge and the
      // sweep's percentage resolves against the padding box, so `contentRect.width` (which excludes
      // padding) is the wrong denominator — see `speakLeftFraction`. `clientWidth` IS the padding
      // box, which puts both terms in one coordinate system.
      const speakEl = pills.current.speak;
      const box = el.clientWidth;
      if (speakEl && box > 0) {
        const frac = speakLeftFraction(speakEl.offsetLeft, box);
        setSpeakLeftFrac((prev) => (Math.abs(prev - frac) < 0.001 ? prev : frac));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={trayRoot}
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
        gap: TRAY_GEOMETRY.trayGap,
        height: TRAY_HEIGHT,
        marginTop: 8,
        padding: TRAY_GEOMETRY.trayPad,
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
            // ── THE SWEEP STOPS AT SPEAK'S LEFT EDGE ────────────────────────────────────────────
            // It used to be `remaining * 100`, draining to ZERO width — i.e. straight THROUGH the
            // Speak pill to the tray's right edge. The founder wants the leading edge to travel only
            // as far as the button's left edge and to fire the send the instant it arrives:
            // "it shouldn't drain all the way through the speak button. Once it hits the left side
            // of the speak button, then it sends."
            //
            // Anchored RIGHT, so the LEADING (left) edge sits at `100 - width`. Walking that edge
            // from 0 to `speakLeftFrac` gives width = 100 - speakLeftFrac × (1 - remaining):
            //   remaining 1 -> 100%                    (leading edge at the tray's left edge)
            //   remaining 0 -> 100 - speakLeftFrac%    (leading edge exactly at Speak's left edge)
            //
            // ONE CLOCK, NOT TWO. `remaining` is the same value the countdown fires on, so the fill
            // arriving and the message going are the same event by construction — there is no second
            // timer that could land a beat early or late and read as broken.
            width: `${Math.round(100 - speakLeftFrac * 100 * (1 - remaining))}%`,
            zIndex: 0,
            // ── THE HATCH IS GONE (the founder's "shaded candy cane") ───────────────────────────
            // `verylow` used to paint a 135° repeating-linear-gradient instead of a solid fill. The
            // founder hit it repeatedly and could not read it: "it also just did the shaded candy
            // cane again, and I don't know why, I don't know when it does that, but I don't want
            // that." A cue nobody can decode is not a cue — it is noise that makes the control feel
            // broken, which is worse than the state going unmarked.
            //
            // THE STATE IT ENCODED IS REAL AND IS STILL COMMUNICATED. `verylow` means "that sounded
            // unfinished" (./confidence — an empty transcript, a trailing conjunction, or an
            // unclosed question), and it buys 12s of silence instead of 3.6s. That is now carried by
            // the thing already on screen and already legible: THE SPEED OF THE SWEEP. A fill
            // crawling over twelve seconds against one that crosses in under four is a difference
            // you read without a legend.
            //
            // The original justification for the hatch was explicitly that "a still frame cannot
            // show motion" — true of a screenshot, and irrelevant to a person watching a live
            // countdown, which is the only way this is ever encountered.
            //
            // Still no numerals anywhere: a countdown that shows "3…2…1" invites the user to race
            // it, and the number is not the information.
            background: `color-mix(in srgb, ${C.successInk} 18%, transparent)`,
            // Uniform across tiers, for the same reason the hatch went (above): the dimmed leading
            // edge was the OTHER half of the illegible `verylow` signalling, and two cues nobody can
            // decode are not better than one. The sweep's speed carries the tier.
            borderLeft: `1px solid color-mix(in srgb, ${C.successInk} 70%, transparent)`,
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
        // THE VISIBLE LABEL IS THE POSITION'S NAME, AND NOTHING ELSE.
        //
        // It used to be `${SEND_MODE_LABEL[m]} → ${targetName}` whenever Speak was selected — the
        // mis-route safety net carried over from ./SendRail. The founder asked for it gone: the
        // pill is to read exactly "Speak", with no arrow, no destination and no ellipsis. Two
        // things made the composed label actively harmful in the shipped tray:
        //
        //  • IT DID NOT FIT. The pills are `flex: 1`, so the longest label sets the pressure for
        //    all three. "Speak → Concierge" in a narrow concierge column truncated the WHOLE tray
        //    to "S… P… S…" — the destination was unreadable AND it took the three position names
        //    down with it. The safety net was costing more legibility than it bought.
        //  • IT WAS ALREADY REDUNDANT. The countdown announces where the send is going as it fires,
        //    which is the moment the information is actionable.
        //
        // THE DESTINATION IS NOT DELETED, ONLY UNPINNED FROM THE VISIBLE TEXT: it stays in `title`
        // and in the accessible name below, so the hover tooltip and a screen reader still name the
        // target. That ordering also keeps WCAG 2.5.3 (Label in Name) satisfied — the accessible
        // name "Speak → Concierge" CONTAINS the visible string "Speak", which is the direction the
        // rule requires; it is the reverse (visible text absent from the name) that fails.
        const showTarget = selected && m === "speak" && Boolean(model?.targetName);
        // Width-driven, decided by the pure `trayLabelFor` (voice/sendMode) rather than by CSS
        // truncation — see its doc for why this cannot be proven by measuring in jsdom.
        const label = trayLabelFor(m, trayWidth);
        // ── THE ACCESSIBLE NAME DOES NOT MOVE WITH THE WIDTH ───────────────────────────────────
        // Built from the FULL label, never from the rendered one. An earlier revision derived it
        // from `label`, so a narrow tray silently renamed the Push-to-talk pill to "Push" — the
        // control renaming itself as the surface resizes, which is the exact thing the `aria-label`
        // comment on the Send pill below forbids, and which made "click Push to talk" hit in a wide
        // column and miss in a narrow one (roborev 56198).
        //
        // WCAG 2.5.3 never asked for that shrinkage: it requires the visible string to be CONTAINED
        // IN the accessible name, and "Push to talk" contains "Push". Holding the name at the full
        // label satisfies the rule in BOTH width states and keeps the control addressable by one
        // stable name — see `shortLabelsAreContainedInFullLabels`, which pins the containment.
        const fullLabel = SEND_MODE_LABEL[m];
        const spokenLabel = showTarget ? `${fullLabel} → ${model?.targetName}` : fullLabel;
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
            aria-label={m === "send" ? "Send" : spokenLabel}
            aria-keyshortcuts={pressSends ? "Meta+Enter Control+Enter" : undefined}
            title={pressSends ? `${spokenLabel} (${chicletFor(m, chord)})` : spokenLabel}
            // `aria-disabled`, NOT `disabled`. A disabled button is neither focusable nor a keydown
            // target, and the roving tabindex below puts the tray's ONLY tab stop on the selected
            // pill — which in the default launch state (Send selected, empty composer) is exactly
            // the pill this would disable. The tray then had ZERO tab stops: a keyboard-only user
            // could not reach the composer's sole send/voice control at all, nor the arrow keys this
            // component calls "the only way to reach Push to talk without a pointer" (WCAG 2.1.1).
            // Every pill used to be a natural tab stop, so the roving stop is what turned this into
            // a regression rather than a pre-existing gap (roborev 56087).
            aria-disabled={pressSends && !canSend ? true : undefined}
            // Three outcomes, and the third is DOING NOTHING: pressing the already-selected Push
            // to talk is neither a send (the release is what sends) nor a mode change (you are
            // already there). Falling through to `onModeChange` instead would fire a same-value
            // change on every stray click, which the host cannot tell from a real one — and the
            // host's mode setter drives the MICROPHONE.
            onClick={() => {
              if (pressSends) {
                if (!canSend) return; // nothing to send: the press is inert, the PILL is not
                onSend();
              } else if (!selected) onModeChange(m);
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
              gap: TRAY_GEOMETRY.pillGap,
              height: "100%",
              padding: `0 ${TRAY_GEOMETRY.pillPadX}px`,
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
                ? { background: ink, color: ON_GOLD_FILL, border: `${TRAY_GEOMETRY.pillBorder}px solid ${ink}` }
                : selected
                ? {
                    background: `color-mix(in srgb, ${ink} 22%, transparent)`,
                    color: ink,
                    border: `${TRAY_GEOMETRY.pillBorder}px solid ${ink}`,
                  }
                : { background: "transparent", color: C.conciergeMuted, border: `${TRAY_GEOMETRY.pillBorder}px solid transparent` }),
            }}
          >
            {/* The narrow state is handled by CHOOSING a shorter word (voice/sendMode
                `trayLabelFor`) — a decision the user can read — rather than by clipping one they
                cannot. `nowrap` stays so a pill never becomes two lines and changes tray height.

                `textOverflow: ellipsis` is kept as a LAST-RESORT BACKSTOP, not as the mechanism.
                It was briefly removed outright, which left the range between the threshold and the
                true fit width hard-clipping mid-word — "Push to tal", with nothing signalling the
                truncation, strictly worse than the "P…" being replaced (roborev 56198). The
                threshold is an ESTIMATE of text metrics, so a residual error is possible in either
                direction; with `TRAY_SHORT_LABEL_MAX_PX` at its pessimistic value this should never
                paint, and if it does an ellipsis beats a word cut mid-stroke. */}
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
                width: TRAY_GEOMETRY.chicletSlot,
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
