// One agent talking to another, drawn in the concierge log — "● @Orchestrator → ● @Rust Half".
//
// WHY IT LOOKS LIKE THIS. Peer traffic is the only thing in this column that is not addressed to the
// human: he is reading someone else's mail, on purpose, because otherwise he cannot see it at all
// (services/peerMessageLog's header). So the row has to be legible without competing with the
// conversation it sits inside. Three consequences, and each is a decision rather than a default:
//
//   GRAY, NOT A BAND COLOUR. Every other quiet row in this column earns its tint from a status band
//   (./NudgeCard, the digest line in ./ConciergeMessageRow) and a colour here would claim an urgency
//   this row does not have — a peer CANNOT place an obligation on anyone, which is the rule the
//   channel itself enforces (services/peerMessaging: always `fyi`). Muted ink on a muted ground is
//   the visual form of "this is FYI".
//
//   CLAMPED TO TWO LINES. Agents are wordier than people and a busy fan-out can produce a dozen of
//   these in a minute. Unclamped, one hand-off would push the human's own conversation off the
//   screen — which would make the feature a net loss for the person it is for.
//
//   EXPANDS IN PLACE. The full text opens in this row rather than a modal or a jump, because the
//   reader's question is almost always "what did that one say" while scrolling past — and a surface
//   that takes over the column to answer it costs a return trip to the place they were reading.
//
// THE PILLS ARE REUSED, NEVER RESTYLED — the rule ./SentToAgentRow states at length and for the same
// reason: `AgentPill` carries the live status dot, tracks a rename, and is already wired to open the
// agent. Anything that merely LOOKED like a pill would be a dead label in a new costume, which is
// precisely the bug that made the founder work out routing by hand.
import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { FiChevronDown, FiChevronRight } from "react-icons/fi";
import { C } from "../../theme/colors";
import { TYPE } from "../../theme/scale";
import { AgentPill } from "./AgentPill";
import { CopyAnswerButton } from "./CopyAnswerButton";
import {
  PEER_GIST_FALLBACK_LINES,
  type ConciergePeerMessage,
  type PeerParty,
} from "../../services/peerMessageLog";

export const PEER_ROW_TESTID = "concierge-peer";
export const PEER_BODY_TESTID = "concierge-peer-body";
export const PEER_EXPAND_TESTID = "concierge-peer-expand";

/**
 * The clamp.
 *
 * WHAT THE TEST CAN AND CANNOT PROVE. React writes these through to the inline style attribute, so
 * jsdom does report `-webkit-line-clamp` back and the line count is a real assertion (verified by
 * mutation: changing it to 3 reds the suite). What no unit test here can prove is that a browser
 * HONOURS the clamp — jsdom performs no layout at all (docs/jsdom-test-caveats.md), so "the property
 * is set" is the whole of the guarantee. Seeing two lines actually hold is what the preview is for.
 *
 * THE LINE COUNT IS THE FALLBACK'S CONSTANT, not a second literal. `peerMessageEntry` builds the
 * no-gist clamp from exactly this many of the message's own lines; two numbers here would let the
 * fallback hand the clamp a third line it can never draw.
 */
export const PEER_CLAMP_STYLE: CSSProperties = {
  display: "-webkit-box",
  WebkitBoxOrient: "vertical",
  WebkitLineClamp: PEER_GIST_FALLBACK_LINES,
  overflow: "hidden",
  // Belt and braces for the one case the clamp cannot handle on its own: a single unbroken token
  // (a path, a branch name, a uuid) longer than the column, which `-webkit-box` will happily let
  // overflow horizontally rather than wrapping into the second line it is allowed.
  overflowWrap: "anywhere",
};

/** The expanded body: verbatim, wrapped, and never through `<Markdown>`. A peer message is a machine
 *  string written for another machine — a `_` or a `*` in it is a character, not an instruction. The
 *  same contract the failure bubble's evidence follows in ./ConciergeMessageRow. */
const EXPANDED_STYLE: CSSProperties = {
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};

/**
 * Is there anything behind the clamp? ASK THE LAYOUT ENGINE — DO NOT MODEL IT.
 *
 * THIS IS THE FOURTH ANSWER TO ONE QUESTION, and the first three were all wrong in the SAME
 * direction — the one that hides text from the reader with no way to reach it. The history is the
 * argument for the shape, so it is recorded rather than summarised:
 *
 *   1. `text !== gist` (roborev 68628). A one-line message with no gist derives a gist equal to
 *      itself, so the compare said "nothing hidden" while the clamp ate everything past line two.
 *   2. An AGGREGATE character budget (roborev 68649). A hard newline costs a whole rendered line
 *      however short the other line is, so 64 + 7 characters cleared an 80-character total while
 *      line one alone wrapped past the clamp.
 *   3. `ceil(len / PER_LINE)` per source line (roborev 68701). Characters do not pack into lines —
 *      CSS breaks at WORD boundaries, so the count is a LOWER bound on rendered lines, not the
 *      upper bound its "deliberately pessimistic" comment claimed. `taking <44-char path> and its
 *      test` is 63 characters, computes 2, and wraps to 3.
 *
 * The pattern is not three bugs, it is one: **whether the clamp hid something is a LAYOUT fact**,
 * and every attempt to predict it from the string was optimistic somewhere. Each round's tests
 * missed the next shape because they were built from the same model as the code — round 3's cases
 * are all `"a".repeat(n)`, the single input for which character packing and word wrap coincide.
 *
 * So this asks the element. `scrollHeight > clientHeight` is the browser's own answer, after its own
 * wrapping, at the reader's actual column width, zoom and font — the facts no constant can carry.
 *
 * AND IT FAILS SAFE WHERE THERE IS NO ANSWER. jsdom performs no layout and reports 0 for both
 * (docs/jsdom-test-caveats.md), and a real element has not been measured on the first paint either.
 * `null` means NOT MEASURED, and it is deliberately NOT the same as "it fits": only a positive,
 * affirmative measurement can retire the control. Anything else keeps it, because showing a control
 * that reveals nothing is a shrug and hiding a message is the bug this feature exists to remove.
 */
function useClampFits(gist: string, open: boolean) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // `null` = no answer yet (or no layout engine). `true` ONLY on an affirmative measurement.
  const [fits, setFits] = useState<boolean | null>(null);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    // While expanded there is no clamp to measure, and the answer for the collapsed state is the
    // one already held — re-measuring here would record the expanded body as "fitting".
    if (!el || open) return;
    const measure = () => {
      // A real layout engine gives a positive scrollHeight. Zero means nothing laid out, which must
      // never read as "it fits" — that is the whole safety property.
      if (el.scrollHeight <= 0) {
        setFits(null);
        return;
      }
      // The +1 absorbs sub-pixel rounding, which reports a 1px overflow on a body that visibly fits.
      setFits(el.scrollHeight <= el.clientHeight + 1);
    };
    measure();
    // RE-MEASURE ON RESIZE, because the answer is only true of the width it was taken at. The
    // concierge column is user-resizable, so a measurement from a wide column goes STALE the moment
    // the reader drags it narrower — and stale in the familiar direction: the text starts being
    // clamped while the control that would reveal it has already been retired. Same bug as the three
    // character heuristics, arriving through time rather than through arithmetic.
    //
    // GUARDED, because `ResizeObserver` does not exist in every environment this renders in and a
    // bare `new` would throw during render setup. Its absence is not a fallback to anything: the
    // initial measurement above still stands, and `null` still fails safe.
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [gist, open]);
  return { bodyRef, fits };
}

/**
 * Does this row need an expand control?
 *
 * TWO INDEPENDENT REASONS, either sufficient. The gist and the message being DIFFERENT text means
 * expanding certainly shows something new, whatever the layout did — that is knowable from the
 * strings and needs no measurement. Otherwise it comes down to the clamp, where only an affirmative
 * "it fits" retires the control.
 */
export function peerRowExpandable(m: ConciergePeerMessage, fits: boolean | null): boolean {
  if (m.text.trim() !== m.gist.trim()) return true;
  return fits !== true;
}

export const PEER_APP_PARTY_TESTID = "concierge-peer-app-party";

/**
 * One end of the row: a real `AgentPill`, or plain prose for an app-global agent.
 *
 * THE APP-GLOBAL BRANCH IS A CORRECTNESS FIX, NOT A STYLE CHOICE (roborev 68628). `AgentPill` reads
 * "I was handed a roster and this id is not in it" as evidence the agent is GONE and renders
 * `"<name> is closed."` — right for a worker that has been spun down, and a flat lie about the
 * concierge, whose id is deliberately not a roster row at all. Every peer row with the concierge at
 * either end would have announced that the assistant the human is mid-conversation with is closed,
 * and `logPeerMessage`'s `appGlobal` rule guarantees those rows are always drawn. It is exactly the
 * false-closed claim `AgentPill.deadEnd.test.tsx` and roborev 55590/55548 exist to forbid.
 *
 * PROSE RATHER THAN A SYNTHETIC ROSTER ROW, of the two repairs available. A pill is a promise that
 * clicking it goes somewhere, and there is nowhere to go: the concierge is a headless `claude -p`
 * child with no pane to reveal, which is the same reason `resolveSpecialAddressee` handles these ids
 * outside the project search entirely. Injecting a fake row would buy a clickable pill by making a
 * different false promise — the dead link in a new costume ./SentToAgentRow warns about. This says
 * who it was and stops there, which is all that is true.
 */
function PartyLabel({ party }: { party: PeerParty }) {
  if (party.appGlobal) {
    return (
      <span
        data-testid={PEER_APP_PARTY_TESTID}
        data-agent-id={party.id}
        style={{ fontWeight: 500 }}
      >
        {party.name}
      </span>
    );
  }
  return <AgentPill agentId={party.id} fallbackName={party.name} />;
}

export function PeerMessageRow({ message }: { message: ConciergePeerMessage }) {
  const [expanded, setExpanded] = useState(false);
  const { bodyRef, fits } = useClampFits(message.gist, expanded);
  const canExpand = peerRowExpandable(message, fits);
  // A row with nothing behind the clamp is never "expanded", whatever the state says — the flag can
  // only have been set while the control existed, and the control cannot exist here.
  const open = expanded && canExpand;

  return (
    <div
      data-testid={PEER_ROW_TESTID}
      data-expanded={open ? "true" : "false"}
      data-from-agent-id={message.from.id}
      data-to-agent-id={message.to.id}
      style={{
        alignSelf: "stretch",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        fontSize: TYPE.small,
        color: C.conciergeMuted,
        // Structure is DRAWN, not filled (theme/blueprintSpec) — a hairline and a left edge, both in
        // the muted token, so this row reads as an aside at any zoom and in either theme. The very
        // faint ground is what separates two consecutive peer rows from one another.
        background: `color-mix(in srgb, ${C.muted} 6%, transparent)`,
        border: `1px solid color-mix(in srgb, ${C.muted} 22%, transparent)`,
        borderLeft: `3px solid color-mix(in srgb, ${C.muted} 45%, transparent)`,
        borderRadius: 6,
        padding: "6px 9px",
      }}
    >
      {/* WHO → WHOM, and the copy control. The arrow points from sender to recipient and is the
          row's only piece of ornament; it earns its place because the two pills are otherwise
          indistinguishable in role, and "who said it" is the first thing the reader needs. */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <PartyLabel party={message.from} />
        <span aria-hidden style={{ opacity: 0.7 }}>→</span>
        <PartyLabel party={message.to} />
        {/* Pushes the copy button to the trailing edge without a second flex container. */}
        <span style={{ flex: "1 1 auto" }} />
        {/* COPIES THE WHOLE MESSAGE, NOT WHAT IS ON SCREEN — see `text` below. The founder's use for
            this is pasting what one agent told another into a PR or a note to a person, and handing
            him the two-line clamp instead would be a summary wearing a transcript's clothes. It is
            deliberately available while the row is COLLAPSED: needing to expand first would make the
            icon a two-step control for the one thing it does. */}
        <CopyAnswerButton text={message.text} kind="peer" />
      </div>

      <div
        ref={bodyRef}
        data-testid={PEER_BODY_TESTID}
        style={open ? EXPANDED_STYLE : PEER_CLAMP_STYLE}
      >
        {open ? message.text : message.gist}
      </div>

      {canExpand && (
        <button
          type="button"
          data-testid={PEER_EXPAND_TESTID}
          aria-expanded={open}
          // NAMES WHAT IT REVEALS. "Show more", repeated down a column of these, is a screen-reader
          // list of identical buttons — the same reasoning ./CopyAnswerButton's labels record.
          aria-label={open ? "Collapse the peer message" : "Show the full peer message"}
          onClick={() => setExpanded((v) => !v)}
          style={{
            alignSelf: "flex-start",
            display: "flex",
            alignItems: "center",
            gap: 3,
            background: "none",
            border: "none",
            padding: 0,
            margin: 0,
            font: "inherit",
            fontSize: TYPE.small,
            color: C.conciergeMuted,
            opacity: 0.75,
            cursor: "pointer",
          }}
        >
          {open ? <FiChevronDown size={11} aria-hidden /> : <FiChevronRight size={11} aria-hidden />}
          {open ? "Less" : "Full message"}
        </button>
      )}
    </div>
  );
}
