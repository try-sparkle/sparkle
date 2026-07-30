// The auto-send rail (PRD §4d) — the arming toggle, the target name, the draining fill, and Send.
//
// ONE OBJECT, not two. Arming and counting live in the same strip because they are the same
// decision seen at two moments: "should this go on its own?" and "this is going on its own, now".
// Splitting the toggle away from the countdown would put the off switch somewhere other than where
// the user is looking when they want it.
//
// A FULL-WIDTH ROW BENEATH THE TEXTAREA, with the Send button moved into it. The rail cannot sit
// beside the textarea: the concierge column's minimum is 320px, and a ~190px rail there would leave
// ~120px of typing room. So the compose row keeps the textarea alone and this strip runs under it.
//
// THE FILL IS ANCHORED RIGHT, so it shrinks INTO the Send button. That is a correction to the
// source mockup, which anchored it left — draining it AWAY from Send, which contradicts what the
// animation is for. The fill is a promise about where this is going; it should collapse into the
// thing it is about to become.
//
// NO DIGITS ANYWHERE. No seconds readout, no numerals, in any state. A countdown that shows "3…2…1"
// invites the user to race it, and the number is not the information — the TARGET is. What the
// label carries is the agent's name, which is PRD §4's mis-route safety net: the seconds before an
// auto-send are your chance to notice you are about to dictate into the wrong agent. (An agent
// literally NAMED "Build 4" of course keeps its numeral; the ban is on a readout, not on a name.)
//
// THE LABEL IS THE SAME SHAPE IN BOTH ARMED STATES — `→ <target>` whether or not a countdown is
// running. Only the DISARMED state says the bare "Auto-send". It used to drop the arrow the moment
// counting began, so the row went "→ Build 4" → "Build 4", and the mis-route safety net changed
// shape at the exact moment it mattered most. Users read that as the target having VANISHED: two
// screenshots six seconds apart showed one rail with an arrow and a name and one with, apparently,
// neither an arrow nor a destination — and could not work out what distinguished them. The thing a
// state change must never do is subtract information the other state was showing.
//
// COUNTING IS SIGNALLED BY STRUCTURE, NOT BY TEXTURE. There are two independent facts on this strip
// and they get two independent channels:
//
//   • counting vs armed-idle → the TRACK. A faint bounded plate behind the fill, present only while
//     counting. Counting reads as a bar draining inside a track; armed-idle reads as bare chrome.
//   • the confidence TIER → the fill's texture (hatched at very-low, solid otherwise), unchanged.
//
// They used to be smeared onto one channel: the fill's mere PRESENCE meant counting, while its
// TEXTURE meant tier — so the rail rendered "sometimes solid and sometimes hatched" with nothing
// on screen explaining which fact had changed. Two states that differ only by texture, where one
// of them also HIDES information the other shows, are not legible: there is nothing to compare, so
// the difference reads as a rendering bug rather than as a state. Keep the two channels separate —
// if a new fact needs showing, give it its own channel rather than another texture.
//
// PRESENTATIONAL, like everything else in this directory: it takes a `model` and callbacks and
// reads no store. The host owns the timer, the routing and the announcements.
//
// IT CARRIES NO LIVE REGION. Arm and fire are announced through the concierge column's single
// `role="status" aria-live="polite"` node via the host's `announce()`. A second region makes a
// screen reader read every send twice — the contract is stated in ./types.ts, ./ConciergeColumn.tsx
// and ./ComposeBox.tsx, and breaking it produced roborev findings 52648/53010/53088.
import { useEffect, useRef, useState } from "react";

import { C, FONT_WEIGHT, ON_GOLD_FILL } from "../../theme/colors";
import { BLUEPRINT } from "../../theme/blueprintSpec";
import { useResolvedTheme } from "../../theme/theme";
import type { AutoSendPhase } from "../../voice/autoSendTimer";
import type { Confidence } from "../../voice/confidence";

/**
 * How long the fill takes to EASE to a new remaining fraction after the threshold moves (PRD §4d).
 *
 * A receding deadline has to read as "that just got longer", not as a glitch. Without the ease the
 * bar teleports from (say) half-drained back to nearly-full between two frames, which reads as the
 * component breaking rather than as the rail changing its mind.
 *
 * Applied ONLY on a tier change. The ordinary per-frame drain must NOT be transitioned: the model
 * republishes a slightly smaller fraction ~60×/second, and a 250ms transition on each of those
 * smears every step into the next and makes the bar lag visibly behind the real deadline.
 */
export const THRESHOLD_EASE_MS = 250;

/** matchMedia is absent under jsdom — treat "can't ask" as "no reduction requested".
 *  Same helper, same reasoning, as SparkleOverlay's. */
function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Everything the rail draws. Supplied by the host from voice/autoSendTimer. */
export interface SendRailModel {
  phase: AutoSendPhase;
  /**
   * The agent this send would reach — "Concierge" or a build agent's name.
   *
   * THE MIS-ROUTE SAFETY NET, and the only thing the label ever says. It comes from the same
   * routing the @-mention work uses (./mentions + the host's router), so the countdown names the
   * destination the send will actually take rather than a guess made here.
   */
  targetName: string;
  /** The confidence tier the current transcript earns — drives the very-low fill treatment only. */
  tier: Confidence;
  /** How much of the fill is left, in [0, 1]. 1 = just started, 0 = firing. */
  remainingFraction: number;
}

export interface SendRailProps {
  model: SendRailModel;
  /** The user flipped the arming switch. */
  onToggleArmed: (armed: boolean) => void;
  /** The user pressed Send. ALWAYS overrides a countdown, at any confidence (PRD §4c). */
  onSend: () => void;
  /** Whether there is anything to send (text or attachments) — greys the button, as before. */
  canSend: boolean;
  /**
   * The composer around this rail is PATCHED to a terminal, so the strip is drawn on the terminal
   * flood rather than on `inputSurface` — the same flag, from the same source, that already swaps
   * ComposeBox's own border (see its `wired` prop).
   *
   * It exists for ONE reason: the counting track's edge. `C.hairline` is the CHROME seam and is
   * deliberately not a token the terminal plane accepts — theme/chromeContrast.test.ts pairs edges
   * to the planes they are drawn on precisely because light `hairline` on `forest` measures 1.195
   * against a 1.2 floor, and `termHair` is the token the spec draws there instead. Painting the
   * track with the chrome token on the terminal plane would make the counting cue invisible in
   * wired + light — i.e. it would put counting and armed-idle back to being indistinguishable,
   * which is the entire defect this track exists to remove (roborev 55244).
   */
  wired?: boolean;
}

/** The strip's height. Matches the Send button so the row has no slack above or below it. */
const RAIL_HEIGHT = 42;

export function SendRail({ model, onToggleArmed, onSend, canSend, wired = false }: SendRailProps) {
  const { phase, targetName, tier, remainingFraction } = model;
  // The ground this strip is drawn on decides the track's edge token — see `wired`. Read here (not
  // taken as a second prop) exactly as ComposeBox reads it for its own border, so the two cannot
  // pick different modes for the same paint.
  const mode = useResolvedTheme();
  const trackEdge = wired ? BLUEPRINT[mode].termHair : C.hairline;
  const armed = phase !== "disarmed";
  const counting = phase === "counting";
  const veryLow = counting && tier === "verylow";

  // ── The one-shot ease on a threshold change ────────────────────────────────────────────────
  // See THRESHOLD_EASE_MS: the transition is armed by a TIER change and withdrawn 250ms later, so
  // the ordinary per-frame drain is never transitioned. Reduced motion skips it entirely — the bar
  // still moves to the right place, it just gets there without an animation to watch.
  const reduceMotion = prefersReducedMotion();
  const lastTier = useRef(tier);
  const [easing, setEasing] = useState(false);

  // ARMED DURING RENDER, not in an effect — React's "adjust state when a prop changes" pattern.
  //
  // In an effect this is one render too late to do anything: render N commits the new `width` with
  // `transition: "none"`, and only afterwards does the passive effect set `easing`, producing a
  // render N+1 that changes nothing but the `transition` declaration. A CSS transition fires when
  // an animatable property changes WHILE a transition is declared; here the declaration arrived
  // after the change had already been committed and painted, so the fill teleported every time —
  // the exact thing THRESHOLD_EASE_MS exists to prevent.
  //
  // It also passed its test, which is the part worth remembering: the test asserted the inline
  // `style.transition` string, and a one-render-late arming still produces that string. See the
  // test that now pins the transition and the new width to the SAME rendered output.
  if (lastTier.current !== tier) {
    lastTier.current = tier;
    setEasing(!reduceMotion);
  }

  // Withdraw it 250ms later so the ordinary ~60fps drain is never transitioned — a permanently
  // transitioned width smears every frame of the drain into the next.
  //
  // Keyed on `easing`, NOT on `[tier, reduceMotion]`. With those deps a reduced-motion flip during
  // the window ran the previous cleanup and then early-returned on the unchanged tier, leaving
  // `easing` stuck true forever — and a stuck-true transition is precisely the smearing above.
  useEffect(() => {
    if (!easing) return;
    const id = setTimeout(() => setEasing(false), THRESHOLD_EASE_MS);
    return () => clearTimeout(id);
  }, [easing]);

  // IDENTICAL IN SHAPE ACROSS BOTH ARMED STATES — see the header. The arrow is not decoration; it
  // is what makes the word after it read as a DESTINATION rather than as a caption, and dropping it
  // mid-countdown made the target look like it had gone away.
  const label = armed ? `→ ${targetName}` : "Auto-send";

  return (
    <div
      data-testid="concierge-send-rail"
      data-phase={phase}
      // The tier is exposed only while it is DOING something. A `data-tier` on a disarmed rail
      // would let a test (or a stylesheet) key off a tier the user cannot see.
      data-tier={counting ? tier : undefined}
      // Counting is assertable WITHOUT reading styles. `data-phase` already carries it, but only by
      // way of knowing which of the phase names count as counting; this states the fact the visual
      // treatment keys off, so a test can pin the cue rather than the enum behind it.
      data-counting={counting ? "true" : undefined}
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        gap: 8,
        height: RAIL_HEIGHT,
        marginTop: 8,
        borderRadius: 6,
        // No border and no fill of its own when idle: the strip is chrome for the Send button, not
        // a panel. The track and the wash below are the only things that ever paint it, and both
        // are drawn only while counting — which is exactly what makes their presence the cue.
        overflow: "hidden",
      }}
    >
      {/* THE TRACK — the counting cue, and the ONLY thing that distinguishes counting from
          armed-idle. A faint bounded plate spanning the strip, drawn only while counting, so the
          fill has visible walls to drain between: counting reads as a bar inside a track, and
          armed-idle reads as the bare chrome it is.

          STRUCTURAL, NOT TEXTURAL, on purpose. The fill's texture is spoken for — it carries the
          confidence tier — and a second fact on the same channel is what made this rail unreadable
          (header). An outline is a different channel entirely, so the two never collide.

          THE EDGE TOKEN IS PICKED BY THE GROUND, not fixed. `C.hairline` is the CHROME seam; on the
          terminal flood a wired composer sits on, the spec draws `termHair` instead. That is not a
          preference — theme/chromeContrast.test.ts pairs edges to planes because light `hairline`
          on `forest` measures 1.195 against a 1.2 floor, so a hardcoded `hairline` here would be
          BELOW the project's own visibility floor in wired + light and the counting cue would
          vanish exactly where it is needed (roborev 55244). Same choice, same two tokens, that
          ComposeBox already makes for its own border one component up.

          Held to a whisper either way (a 1px edge and an ~8% wash) so it reads as a boundary and
          not as a panel, and so `cream` over it is the same text on the same ground it was before —
          the label's contrast is set by the fill above it, which is unchanged. */}
      {counting && (
        <div
          data-testid="send-rail-track"
          aria-hidden
          style={{
            position: "absolute",
            // Spelled out rather than `inset: 0` — same reason the fill spells its anchors out, and
            // the shorthand does not round-trip through a style declaration as four readable edges.
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
            zIndex: 0,
            borderRadius: 6,
            // LONGHAND, not the `border` shorthand: the value is a CSS variable, and a shorthand
            // carrying a `var()` cannot be decomposed into its longhands — the whole declaration
            // stays an opaque string, so nothing (a test, a devtools inspector) can read the edge
            // back off the node. The paint is identical either way.
            borderWidth: 1,
            borderStyle: "solid",
            borderColor: trackEdge,
            background: `color-mix(in srgb, ${trackEdge} 8%, transparent)`,
          }}
        />
      )}

      {/* THE FILL. Absolutely placed and anchored RIGHT (`right: 0`, no `left`), so shrinking its
          width walks its left edge rightward — into the Send button. Behind everything else in the
          row (`zIndex` 0 vs the controls' 1), so it washes the strip rather than covering it.
          After the track in DOM order and at the same `zIndex`, so it paints INSIDE it.

          Rendered only while counting: a full-width wash on an idle rail would read as a countdown
          that is stuck rather than one that has not started. */}
      {counting && (
        <div
          data-testid="send-rail-fill"
          aria-hidden
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            right: 0,
            width: `${Math.round(Math.min(1, Math.max(0, remainingFraction)) * 100)}%`,
            zIndex: 0,
            // VERY LOW IS VISUALLY UNMISTAKABLE. In motion it reads on its own — the fill is very
            // nearly static, because ten seconds of drain is imperceptible frame to frame. But a
            // still frame cannot show motion, so the tier also gets ONE non-numeric cue: a hatched,
            // dimmed track instead of a solid one. Still no numerals.
            background: veryLow
              ? `repeating-linear-gradient(135deg, color-mix(in srgb, ${C.goldFill} 14%, transparent) 0 6px, transparent 6px 12px)`
              : `color-mix(in srgb, ${C.goldFill} 18%, transparent)`,
            borderLeft: `1px solid color-mix(in srgb, ${C.goldFill} ${veryLow ? 35 : 70}%, transparent)`,
            transition: easing ? `width ${THRESHOLD_EASE_MS}ms ease-out` : "none",
          }}
        />
      )}

      {/* THE ARMING TOGGLE, in the rail. `role="switch"` rather than a checkbox: this is an on/off
          state of the surface, not a value being collected, and a switch is what assistive tech
          announces as "on"/"off" instead of "checked".

          The name is STABLY PREFIXED rather than constant. A constant "Auto-send" was the original
          intent — a control whose name changes under you reads as a different control — but
          `aria-label` REPLACES the subtree for name computation, so it also made the target name
          unreachable: a screen-reader user heard "Auto-send, switch, on" in every state and had no
          way to learn which agent a pending send was aimed at. That is the mis-route safety net,
          and it is the only reason the label exists at all.

          It was a WCAG 2.5.3 (Label in Name) failure too — visible text "Build 4", accessible name
          "Auto-send", so a voice-control user saying "click Build 4" could not hit it.

          The "Auto-send" prefix keeps the control recognisable across state changes AND contains
          the visible text, which satisfies Label-in-Name. */}
      <button
        type="button"
        role="switch"
        aria-checked={armed}
        aria-label={armed ? `Auto-send to ${targetName}` : "Auto-send"}
        onClick={() => onToggleArmed(!armed)}
        style={{
          position: "relative",
          zIndex: 1,
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          flex: 1,
          minWidth: 0,
          height: "100%",
          padding: "0 4px",
          border: "none",
          background: "transparent",
          color: armed ? C.cream : C.conciergeMuted,
          font: "inherit",
          fontSize: 12,
          textAlign: "left",
          cursor: "pointer",
        }}
      >
        {/* ○ / ◉ — the prototype's own glyphs, drawn rather than typed so they scale with the row
            and don't depend on a font having them. aria-hidden: `aria-checked` above already
            carries this state, and a second reading of it is noise. */}
        <span
          data-testid="send-rail-toggle-dot"
          aria-hidden
          style={{
            flex: "none",
            width: 12,
            height: 12,
            borderRadius: "50%",
            border: `1.5px solid ${armed ? C.goldFill : C.conciergeMuted}`,
            background: armed
              ? `radial-gradient(circle, ${C.goldFill} 0 45%, transparent 45%)`
              : "transparent",
          }}
        />
        <span
          data-testid="send-rail-label"
          style={{ overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}
        >
          {label}
        </span>
      </button>

      {/* SEND — the same gold rounded rect it has always been, moved here from beside the textarea.
          Identical styling and identical accessible name, so nothing that reaches for it by label
          or by shortcut has to learn a new one. */}
      <button
        type="button"
        onClick={onSend}
        disabled={!canSend}
        aria-label="Send"
        title="Send (⌘↩)"
        aria-keyshortcuts="Meta+Enter Control+Enter"
        style={{
          position: "relative",
          zIndex: 1,
          flex: "none",
          fontSize: 13,
          fontWeight: FONT_WEIGHT.bold,
          color: ON_GOLD_FILL,
          background: C.goldFill,
          border: "none",
          borderRadius: 6,
          padding: "10px 15px",
          cursor: canSend ? "pointer" : "default",
          opacity: canSend ? 1 : 0.45,
          height: RAIL_HEIGHT,
        }}
      >
        Send
      </button>
    </div>
  );
}
