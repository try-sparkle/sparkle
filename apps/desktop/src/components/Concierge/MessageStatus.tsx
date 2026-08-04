// WHAT THE CONCIERGE IS DOING ABOUT *THIS* MESSAGE — one quiet line under the bubble that asked.
//
// THE COMPLAINT: *"I usually send multiple messages to the Concierge and I would like to see a
// status below each chat message that I send, showing what it's doing about that specific message.
// … Maybe it's just in the bottom right corner."*
//
// ThinkingIndicator answers a DIFFERENT question and stays exactly where it is. It is the column's
// "what is happening right now" line, singular, at the foot of the thread. When four messages are in
// flight it can only ever describe one of them, and the founder's whole point is that he wants to
// know which of HIS FOUR questions the answer belongs to. So this is a per-message surface added
// beside that one, not a replacement for it.
//
// THIS COMPONENT INVENTS NO WORDING. `text` arrives already composed by the producer — "Checking
// git", "Reading your message", "Composing", "Answered". Deriving a phrase here from a tone (or from
// a store) would put the vocabulary in two places, and the half that reached the screen would be the
// one nobody was reading when the wording changed. One producer, one phrase; this draws it.
//
// THE TEXT CARRIES THE COLOUR, and there is no dot, badge or icon. The founder's words: *"the status
// text itself carries the colour, not a separate indicator."* The inks are ThinkingIndicator's own —
// gray → amber → sienna — READ FROM THE SAME PALETTE rather than imported from it, because that
// component's map is keyed by `ConciergeLiveness` (which has an `idle` this ladder has no use for)
// and coupling to it would make either file's state list the other's problem.
//
// NOTHING BUT THE INK CHANGES BETWEEN TONES. Same size, same weight, same position, same layout —
// so a message going slow costs a GLANCE and not a re-read. That rule is inherited rather than
// invented: ThinkingIndicator's header records the founder rejecting a version whose row reflowed
// between states, and MessageStatus.test.tsx asserts it programmatically across all four tones
// rather than one case at a time, because "only the colour differs" is a claim about the SET.
//
// NO STATUS, NO ROW. A hundred-message thread has a status on approximately one bubble; every other
// one renders `null` — not an empty box and not a reserved height. Reserving the height would push
// the whole transcript down by a line per message for a surface that is almost always absent.
//
// NOT A LIVE REGION, deliberately, and this is the third time that conclusion has been reached the
// hard way. The column owns exactly ONE announcer (ConciergeColumn), and a second region in this
// subtree double-announces — `ConciergeThread.roleLabels` asserts that and has caught it. This text
// also changes several times per turn, per message, which is precisely the flooding the thread
// itself is kept off a live region for. It is a plain readable text node: a sighted reader gets it
// from the screen, and an assistive-tech reader gets the same information from the column's
// announcer, once, in the place every other thing this column says goes through.
import { useConciergeLiveness } from "../../services/conciergeLiveness";
import { C } from "../../theme/colors";
import { TYPE } from "../../theme/scale";

export const MESSAGE_STATUS_TESTID = "concierge-message-status";

export interface ConciergeMessageStatus {
  /** The phrase, ALREADY COMPOSED by the producer — "Checking git", "Reading your message",
   *  "Composing", "Answered". This component NEVER invents or derives wording. */
  text: string;
  /** The age ladder. Drives the ink only — nothing else about the row changes between tones. */
  tone: "waiting" | "slow" | "stalled" | "settled";
}

/**
 * WHAT TRAVELS DOWN THE TREE: the phrase, and nothing else.
 *
 * The tone is deliberately NOT here (roborev 57889-M2). It is a reading of a clock, so whoever
 * computes it re-renders once a second for the whole of every turn — and the producer is called from
 * `ConciergeHost`, which is the one component in this column that must never subscribe to that
 * ticker (neither `ConciergeColumn` nor `ConciergeThread` is memoised, so a 1 Hz host render
 * reconciles the entire transcript; `LivenessAnnouncer` was extracted for exactly this reason, and
 * services/conciergeActivity's idempotence guard cites the same invariant). {@link MessageStatusLive}
 * reads the clock instead, in a leaf that is mounted only for the one bubble carrying a status.
 */
export interface ConciergeMessageStatusText {
  text: string;
}

/**
 * The whole signal: one ink per tone.
 *
 * `waiting` and `settled` are the SAME gray on purpose, and that is not a gap waiting to be filled
 * with a fifth colour. A turn that is a few seconds old and a turn that has been answered are both
 * states with nothing to report — quiet is the correct rendering of "normal", and spending an ink on
 * "done" would make a settled thread the loudest thing in the column. Amber and sienna are the app's
 * two existing alarm inks (per PRD/sparkle/concierge-status-bands); no third alarm colour is
 * invented here.
 */
const INK: Record<ConciergeMessageStatus["tone"], string> = {
  waiting: C.conciergeMuted,
  slow: C.amberInk,
  stalled: C.sienna,
  settled: C.conciergeMuted,
};

export function MessageStatus({ status }: { status?: ConciergeMessageStatus | null }) {
  // Rendering nothing is the COMMON case, not the edge case — see the header.
  if (!status) return null;
  return (
    <div
      data-testid={MESSAGE_STATUS_TESTID}
      // The tone is on the DOM as well as in the ink so a test (and a screenshot diff) can say which
      // rung it is on without reading a colour back out of a style attribute.
      data-tone={status.tone}
      style={{
        // Every property below is identical in all four tones on purpose. `color` is the only line
        // in this object that reads `status.tone`; if a second one ever does, the invariance test
        // above this file's name will say so.
        color: INK[status.tone],
        // `TYPE.small` (12), not a hand-picked 11. The type scale is a RATCHET with a ceiling of
        // zero off-scale values (theme/scale.test.ts), so a bespoke size here is a fleet-wide red,
        // not a local style choice — and `small` is the register this line belongs to anyway: the
        // scale documents it as "secondary UI: chips, hints, metadata", which is exactly what a
        // status under a message is.
        fontSize: TYPE.small,
        // RIGHT-ALIGNED — "bottom right corner", under a right-aligned bubble. `marginLeft: auto`
        // rather than only `textAlign`, so the box itself ends on the column's right edge and the
        // ellipsis (below) therefore eats the LEFT-over end of a long phrase rather than leaving a
        // truncated line floating away from the edge it belongs to.
        textAlign: "right",
        marginLeft: "auto",
        marginTop: 2,
        // The column is 360px and a composed phrase can be long, so it TRUNCATES rather than
        // wrapping to a second line — a status that reflows the transcript every time the phrase
        // gets longer is the reflow this whole surface is supposed to avoid. `minWidth: 0` because
        // this sits inside a flex column, where the default `min-width: auto` would let the content
        // push the box wider than its `maxWidth` and defeat the ellipsis entirely.
        //
        // `100%`, NOT the `92%` ThinkingIndicator uses, and the difference is the PARENT rather
        // than a different intention (roborev 57853-M1). That component is a direct child of the
        // thread's scroller, so 92% is 92% OF THE COLUMN. This one sits inside the per-message
        // entry, which is `alignSelf: "flex-end"` in a flex column and therefore SHRINK-TO-FIT: its
        // width is its own contents' max-content width, already capped at 92% of the column by the
        // entry itself. A percentage max-width contributes nothing while that intrinsic width is
        // being computed and is then resolved against the result — so a second 92% would measure
        // this box against a box THIS BOX JUST SIZED, and clip 8% off every status long enough to
        // be the widest thing in its entry. "Checking git · 12s" under a two-character message
        // would ellipsise with the column half empty. 100% keeps it inside its own row and lets the
        // entry own the only cap there should be.
        maxWidth: "100%",
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {status.text}
    </div>
  );
}

/**
 * The clock read, in the smallest thing that can hold it.
 *
 * Mounted ONLY when there is a status, which is why the hook can live here at all: `useConciergeLiveness`
 * keeps `now` in state and re-renders its caller at 1 Hz for the duration of every turn, and it
 * subscribes to the liveness store WITHOUT a selector — so it also re-renders on every
 * `noteConciergeProgress`, i.e. per token chunk. In a hundred-message thread exactly one bubble ever
 * carries a status (see this file's header), so exactly one of these exists, and both of those
 * re-render paths stop at this `div`. Calling the hook one level up — in `MessageStatus`, which every
 * row renders — would mount a ticker per bubble; calling it in the producer put it in the host.
 */
function LiveMessageStatus({ text }: { text: string }) {
  const { liveness } = useConciergeLiveness();
  return (
    <MessageStatus
      status={{
        text,
        // `idle` cannot occur while a status is showing (a turn is being awaited, so the clock is
        // running), but it maps to the same quiet ink as `waiting` rather than being asserted away:
        // a wrong ink is cosmetic, and a thrown error in a render path is not.
        tone: liveness === "idle" ? "waiting" : liveness,
      }}
    />
  );
}

/**
 * What a row renders: the status for this bubble, or nothing.
 *
 * The null check is HERE rather than inside {@link LiveMessageStatus} because a hook cannot be
 * conditional — returning early from a component that has already called `useConciergeLiveness` is
 * not an option, and the whole point is that the ticker must not mount for the ninety-nine bubbles
 * that have no status.
 */
export function MessageStatusLive({ status }: { status?: ConciergeMessageStatusText | null }) {
  if (!status) return null;
  return <LiveMessageStatus text={status.text} />;
}
