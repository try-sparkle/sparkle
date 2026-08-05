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
// IT IS THE ONLY PRESS TARGET, BUT NO LONGER THE ONLY CONTROL IN THE BAR. Speak carries one
// modifier beneath this tray — the Auto-send switch (./AutoSendToggle), rendered by ComposeBox
// directly below and right-aligned. It does NOT change what this component draws: the sweep runs
// and resolves identically either way, because it is showing when the dictated utterance ENDS,
// which happens whether or not the message then goes. Only the dispatch differs.
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
  chicletClearancePx,
  wordPillMinPx,
  speakLeftFraction,
} from "./trayGeometry";

import { C, FONT_WEIGHT, ON_GOLD_FILL } from "../../theme/colors";
import { KeyPill } from "./KeyPill";
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
  trayDensityFor,
  trayLabelFor,
  trayShowsChiclet,
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

/**
 * How long a CLICK-driven send keeps its filled state.
 *
 * The hold and the countdown have durations of their own; a click does not — `onSend` returns
 * synchronously, so "fill while the action lasts" would be a fill nobody can see. This is the
 * minimum time the acknowledgement stays legible, and it is a STATE with a duration rather than an
 * animation: the fill appears at the click, holds, and goes. No transition, no easing, no glow —
 * the founder's spec is the border colour moved to the background and nothing else.
 */
export const ACTING_FLASH_MS = 220;

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
  /**
   * Monotonic count of auto-sends that have actually FIRED.
   *
   * Speak's green fill keys on a CHANGE to this, not on `remainingFraction` reaching 0 — that value
   * is never rendered as 0 while the countdown is still live (the fire branch returns without
   * scheduling a repaint), so reading it was a sub-millisecond race that produced a random flicker
   * instead of a state (roborev 57314). Optional so existing callers and fixtures are unaffected.
   */
  firedSeq?: number;
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
  /**
   * Is the push-to-talk key DOWN right now — i.e. is the microphone actually capturing?
   *
   * THE THIRD STATE. `mode === "ptt"` says only that the position is SELECTED; this says the user is
   * holding the key and being heard. They painted identically until now, which is the founder's
   * report: "it should show as a fully pressed button … it doesn't look any different than it does
   * when it's in standby mode." He speaks while looking elsewhere, so the difference has to read
   * from peripheral vision, not on inspection.
   */
  pttHeld?: boolean;
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

// ── THE TRAY DECLARES NO HEIGHT ────────────────────────────────────────────────────────────────
// There used to be a `TRAY_HEIGHT = 42` here, applied as `minHeight` on the strip while the pills
// asked for `height: "100%"`. Two numbers for one measurement, and they disagreed: a percentage
// height resolved against an auto-height flex parent is not a stretch instruction, so the pills sized
// to their own content and the tray held itself open at 42 — the dead band under the words that the
// founder reported three separate times. Neither value is here now. The pills' `pillPadY` is the only
// input, and the strip hugs whatever that produces, so "the tray is the same height as the button" is
// structural rather than a number someone has to keep in step. See trayGeometry `pillPadY`.

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
  chicletClearancePx,
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
  pttHeld = false,
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
  /** The pill whose CLICK-send is still being acknowledged — see {@link ACTING_FLASH_MS}. */
  const [flashing, setFlashing] = useState<SendMode | null>(null);
  // THE FIRE EVENT LIGHTS SPEAK. One clock: the same `firedSeq` bump the send itself produces.
  const firedSeq = model?.firedSeq;
  const lastFired = useRef(firedSeq);
  useEffect(() => {
    if (firedSeq === undefined || firedSeq === lastFired.current) return;
    lastFired.current = firedSeq;
    setFlashing("speak");
  }, [firedSeq]);
  useEffect(() => {
    if (flashing === null) return;
    const id = setTimeout(() => setFlashing(null), ACTING_FLASH_MS);
    return () => clearTimeout(id);
  }, [flashing]);

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
        // WRAPS RATHER THAN OVERFLOWS. With every column width ceiling removed the concierge can be
        // dragged to 50px, where three pills cannot share a line however tight their padding is.
        // Wrapping turns that into two rows and then three; clipping would put the send control
        // half outside the column, which is the founder's report one level down.
        flexWrap: "wrap",
        minWidth: 0,
        // NO `height` AND NO `minHeight` — see the note above the palette. The strip's height is
        // whatever its pills come to plus `trayPad` and the border, which is the only arrangement in
        // which there is provably no space below the buttons. A wrapped tray still grows into its
        // second and third rows for the same reason: nothing here is holding a size open.
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
        // PRESSED = selected AND the key is actually down. Scoped to Push to talk because it is the
        // only position with a held gesture: Send fires on a click and Speak on a countdown, so
        // neither has a "currently capturing" state to draw. `!inert` because an inert tray is not
        // being heard at all — painting it pressed would be the same lie in the other direction.
        const pressed = selected && m === "ptt" && pttHeld && !inert;
        // ── SPEAK FILLS WHEN THE SEND ACTUALLY GOES ───────────────────────────────────────────
        // The founder's requirement stands unchanged — sweep arrival, fill and send are ONE event —
        // but it is met by the fire EVENT rather than by a shared `remaining` value. An earlier
        // revision derived this from `remaining <= 0` and said so here; that comment is gone because
        // it was false in a way that specifically indicted its replacement. `remaining` never
        // RENDERS as 0 while the countdown is live: useAutoSend's fire branch applies its state and
        // returns without scheduling a repaint, so the only renders during a countdown come from
        // ticks that just measured remaining > 0. Reading it was a sub-millisecond race.
        //
        // `firedSeq` is bumped inside useAutoSend's CONFIRMED-DISPATCH branch, so the fill and the
        // "Sent to …" announcement have one trigger and cannot disagree about whether anything left
        // the box. Speak's countdown fill and its click fill are therefore one mechanism: both light
        // the pill through `flashing`.
        const clicked = flashing === m;
        const firing = clicked && m === "speak";
        const acting = pressed || clicked;
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
        // ONE ordered decision for the whole ladder (see `trayDensityFor`), because independent
        // width comparisons is how a pill ends up drawing a word AND reserving a keycap slot for
        // it — which is exactly what produced the founder's "Se… Pu… Sp…".
        const density = trayDensityFor(trayWidth);
        const label = trayLabelFor(m, density);
        // The narrowest tier: the pills WRAP so the words stay whole, rather than dropping to icons.
        const atFloor = density === "floor";
        // Hoisted out of the style object because the CHICLET needs it too: the keycap is positioned
        // against the pill's padding box (that is what `position: absolute` resolves to), so insetting
        // it by the same padding the label answers to is what puts the two on one right-hand margin.
        // Padding is one of the things the ladder spends to keep WHOLE WORDS, so it is tier-dependent.
        const padX = atFloor
          ? TRAY_GEOMETRY.pillPadXFloor
          : density === "shortTight"
          ? TRAY_GEOMETRY.pillPadXTight
          : TRAY_GEOMETRY.pillPadX;
        const showsChiclet = trayShowsChiclet(density);
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
            data-held={pressed ? "true" : undefined}
            data-firing={firing ? "true" : undefined}
            // ONE attribute for the shared rule, so a test can assert "is this pill acting" without
            // knowing which position it is looking at.
            data-acting={acting ? "true" : undefined}
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
                // Light it BEFORE sending, so the acknowledgement cannot be lost if `onSend`
                // synchronously unmounts or re-renders the tray.
                setFlashing(m);
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
              // `1 1 auto` with a real floor in the icon tier, so a pill can drop to the next line
              // instead of being squeezed narrower than its own glyph. Unchanged (`flex: 1`,
              // floor 0) in both label tiers, where the pills share the line equally as before.
              // `1 1 auto` with a real floor at the FLOOR TIER, so a pill drops to the next line
              // instead of being squeezed narrower than its own word — which is what keeps all
              // three words WHOLE at a 50px column (they stack onto three rows). Unchanged in every
              // wider tier, where the pills share one line equally as before.
              flex: atFloor ? "1 1 auto" : 1,
              minWidth: atFloor ? wordPillMinPx() : 0,
              display: "inline-flex",
              alignItems: "center",
              // THE WORD IS CENTRED IN THE PILL, and it is centred ALONE. The keycap used to be an
              // in-flow sibling, so this rule centred the PAIR — which is exactly what the founder
              // diagnosed: "I think you probably have it so that the words and the keyboard shortcut
              // chiclet is what is centering." The word came out left of centre by half the slot, and
              // at rest — no hover, no chiclet — the word is the only thing on the pill. The keycap is
              // now out of flow (below), so this centres the one thing the user actually reads.
              //
              // NO `gap`: with a single in-flow child it would have nothing to separate, and leaving
              // it here would imply the keycap is still a sibling. The distance between word and
              // keycap is `chicletClearancePx`, spent as the label's `maxWidth` below.
              justifyContent: "center",
              // NO `height: "100%"` — that percentage, resolved against an auto-height flex parent,
              // is what left the pills short of the tray they sit in. Height comes from `pillPadY`
              // alone, and `alignItems: "stretch"` on the tray levels the three pills to the tallest.
              padding: `${TRAY_GEOMETRY.pillPadY}px ${padX}px`,
              borderRadius: RADIUS.input,
              font: "inherit",
              // One step down at the two tightest tiers — a smaller WHOLE word beats a truncated
              // large one. A SCALE MEMBER, not a ratio: the type ratchet reads numeric literals
              // from the value expression, so a ratio in another module routes around it.
              fontSize: density === "shortTight" || atFloor ? TYPE.micro : TYPE.small,
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
              // ── HELD READS AS A PHYSICALLY DEPRESSED BUTTON ──────────────────────────────
              // A FILL, not a brighter outline. The armed state is already an outline, and the
              // founder's complaint is precisely that the two were indistinguishable — so the
              // difference has to be a change of KIND (hollow → solid), not of degree. This is the
              // same solid treatment the selected Send pill wears, which is the one thing in this
              // tray users already read as "this is the hot control".
              //
              // Listed FIRST so it wins over the armed branch below for the same pill.
              // ── FILL MATCHES STROKE = ACTING RIGHT NOW ────────────────────────────────────────
              // The founder's rule, and it is ONE rule across the whole tray rather than a treatment
              // per position: "when the background of the button is a different color than the
              // stroke, I would consider that to be inactive status. But when I'm actually pushing on
              // the button … then the button should be the same color as the stroke."
              //
              //   fill DIFFERS from stroke -> selected, but not acting
              //   fill MATCHES stroke      -> acting THIS INSTANT
              //
              // Push to talk fills AMBER while the gesture is held; Speak fills GREEN at the instant
              // the sweep reaches it and the send goes. Each takes ITS OWN existing stroke colour
              // (`ink`) as the background — no new token, no glow, no animation, nothing but the
              // border colour moved to the fill. An earlier revision added an inset shadow here; it
              // is removed, because the spec is deliberately exactly this and nothing else.
              //
              // The label inverts to `ON_GOLD_FILL` (dark) so it stays readable on a saturated fill —
              // it is amber/green text on dark at rest, which would be unreadable on its own colour.
              // The icon tier inherits this automatically: `color` is what the glyph is drawn in.
              ...(acting
                ? {
                    background: ink,
                    color: ON_GOLD_FILL,
                    // LONGHANDS, not the `border` shorthand — the same reason the tray root states
                    // at its own `borderColor`: a shorthand carrying a `var()` cannot be decomposed
                    // into its longhands, so the whole declaration stays an opaque string and
                    // nothing can read the edge colour back off the node. That matters more here
                    // than anywhere else in this file, because the FOUNDER'S RULE IS A COMPARISON
                    // between the fill and the stroke — a test that cannot read the stroke cannot
                    // assert the rule at all, and would have to fall back to a colour literal.
                    borderWidth: TRAY_GEOMETRY.pillBorder,
                    borderStyle: "solid",
                    borderColor: ink,
                  }
                // SEND NO LONGER SHIPS PRE-FILLED. It used to wear the solid treatment at REST,
                // which under the unified rule reads as "sending right now" the whole time the tray
                // is parked there — the one position that was permanently lying. The founder asked
                // for it explicitly: "the send button should also be a lighter color than the stroke
                // until I hit the send button". It now falls through to the shared selected branch
                // below and fills only via `acting`, exactly like Push to talk and Speak.
                : selected
                ? {
                    // LONGHANDS for the same reason the acting branch above gives: the founder's
                    // rule is a COMPARISON of fill against stroke, so a test must be able to read
                    // the stroke. With the `border` shorthand carrying a `var()`, `borderColor` read
                    // back as "" — which made "fill DIFFERS from stroke" pass for the wrong reason
                    // (a colour is never equal to an empty string) rather than because the tint
                    // genuinely differs from the edge.
                    background: `color-mix(in srgb, ${ink} 22%, transparent)`,
                    color: ink,
                    borderWidth: TRAY_GEOMETRY.pillBorder,
                    borderStyle: "solid",
                    borderColor: ink,
                  }
                : {
                    background: "transparent",
                    color: C.conciergeMuted,
                    borderWidth: TRAY_GEOMETRY.pillBorder,
                    borderStyle: "solid",
                    borderColor: "transparent",
                  }),
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
              style={{
                overflow: "hidden",
                whiteSpace: "nowrap",
                textOverflow: "ellipsis",
                // ── THE SAME INEQUALITY `fullLabelsFitAtPx` ENFORCES, RESTATED AS CSS ────────────
                // The keycap is out of flow, so nothing in the layout stops a centred label growing
                // under it. This is what does: capping the label at the pill minus the clearance on
                // BOTH sides keeps its right edge clear of the keycap while leaving it centred, since
                // a symmetric cap does not move a centred box. At the bottom of the `full` tier the
                // two agree exactly (the cap resolves to WIDEST_LABEL_PX), and above it the cap is
                // slack — so this is a floor under the derivation, not a second opinion about it.
                // It matters because the derivation governs a THRESHOLD someone could lower without
                // touching this file.
                maxWidth: showsChiclet ? `calc(100% - ${2 * chicletClearancePx}px)` : undefined,
              }}
            >
              {label}
            </span>
            {/* THE KEYCAP CHICLET — JUSTIFIED RIGHT, OUT OF FLOW, HOVER/FOCUS ONLY.
                What it says comes from voice/sendMode `chicletFor`, which is the same function the
                keystroke handler asks — a chip that advertises a chord the handler does not honour
                is worse than no chip at all.

                ── WHY IT IS ABSOLUTELY POSITIONED ────────────────────────────────────────────────
                It was an in-flow sibling of the label, and the two were centred as one unit. That is
                the founder's third complaint and his own diagnosis of it: the word ends up left of
                centre, and the word is all there is to see at rest. Taking the keycap out of flow is
                what lets the label be centred alone.

                IT ALSO PINS THE PROPERTY THAT MATTERS MORE THAN EITHER: the label MUST NOT MOVE when
                the keycap appears. An out-of-flow box contributes nothing to its siblings' layout in
                any state, so the reveal cannot shift the word — not by construction of a matching
                reservation that someone could later unbalance, but because there is no flow
                contribution to balance. Only `opacity` changes on hover; the box is laid out
                identically at rest, and `SendModeTray.geometry.test.tsx` holds that.

                `pointerEvents: "none"` because it now overlays the pill: a chip that swallowed the
                pointer would make the button's own right-hand end unclickable, and — worse — a
                mouseleave onto it would flicker the very hover state that summoned it. */}
            {/* NOT RENDERED AT ALL below the `full` tier. A 30px keycap per pill is the first thing
                to go when the column is tight, and the words never give way for it. */}
            {!showsChiclet ? null : (
            <span
              data-testid={showCap ? `send-chiclet-${m}` : undefined}
              aria-hidden
              style={{
                position: "absolute",
                // The pill's own horizontal padding, so the keycap's right edge lands on the same
                // margin the label answers to rather than flush against the border.
                right: padX,
                top: 0,
                bottom: 0,
                pointerEvents: "none",
                width: TRAY_GEOMETRY.chicletSlot,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "flex-end",
                // TYPE.micro (10), not an off-scale 11: a keycap IS a badge — the rung this scale
                // names for tracked labels, badges and ticks. theme/scale.test.ts ratchets off-scale
                // fontSize at zero, so an eyeballed 11 here is a hard red, not a nit.
                fontSize: TYPE.micro,
                // ── THE BOX IS ALWAYS LAID OUT; ONLY ITS CONTENTS APPEAR ─────────────────────
                // `opacity`, never a conditional render — and the reason has outlived the mechanism
                // it was written for. It used to be that a chip MATERIALISING would widen the flow
                // and shove the label into the "Se…" ellipsis the founder had already complained
                // about. Out of flow that particular harm is gone, but the rule stays for the
                // stronger version of the requirement: hovering must not change the pill AT ALL, and
                // `opacity` is the only reveal that touches neither layout nor paint order. It also
                // keeps the reveal cheap — no mount, no reflow, on a per-frame hover path.
                opacity: showCap ? 1 : 0,
              }}
            >
              {/* THE APP'S ONE KEYCAP (./KeyPill), not a bare glyph. The founder asked for the tray's
                  shortcuts to look exactly like Search's: "a little pill around like the command K
                  and it's gray". Sharing the component rather than restyling here is what stops the
                  two drifting — which is the defect KeyPill was extracted to fix in the first place,
                  when the palette's two copies had already diverged on padding. */}
              <KeyPill>{chicletFor(m, chord)}</KeyPill>
            </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
