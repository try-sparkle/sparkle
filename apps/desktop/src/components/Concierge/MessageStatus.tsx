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
// THE TEXT CARRIES THE COLOUR — there is no dot and no badge. The founder's words: *"the status text
// itself carries the colour, not a separate indicator."* The inks are ThinkingIndicator's own —
// gray → amber → sienna — READ FROM THE SAME PALETTE rather than imported from it, because that
// component's map is keyed by `ConciergeLiveness` (which has an `idle` this ladder has no use for)
// and coupling to it would make either file's state list the other's problem.
//
// THERE IS A GLYPH NOW, and it is the ONE thing deliberately shared with the rail. *"I like how on
// the left side it gives me a little icon, I'd like to see that icon on the right side as well."*
// It is not a second indicator of the same fact — it names the tool DOMAIN the line came from
// (terminal, agents, workflow, workspace), which the phrase does not. Drawn from ./activityIcons,
// the single map both surfaces read, so the two can never draw different glyphs for one domain.
// It does NOT vary with tone; the ink is still the entire age signal.
//
// NOTHING BUT THE INK CHANGES BETWEEN TONES. Same size, same weight, same position, same layout —
// so a message going slow costs a GLANCE and not a re-read. That rule is inherited rather than
// invented: ThinkingIndicator's header records the founder rejecting a version whose row reflowed
// between states, and MessageStatus.test.tsx asserts it programmatically across all four tones
// rather than one case at a time, because "only the colour differs" is a claim about the SET.
//
// NO STATUS, NO ROW. A status sits on the message being worked on and on every message queued behind
// it — one plus the queue depth, which is a handful in a hundred-message thread and still zero on the
// overwhelming majority of bubbles. Every other one renders `null`: not an empty box and not a
// reserved height, because reserving it would push the whole transcript down by a line per message
// for a surface that is absent almost everywhere. (This used to say "approximately one bubble", which
// was true only before the turn queue — see {@link ConciergeMessageStatusText.live}.)
//
// NOT A LIVE REGION, deliberately, and this is the third time that conclusion has been reached the
// hard way. The column owns exactly ONE announcer (ConciergeColumn), and a second region in this
// subtree double-announces — `ConciergeThread.roleLabels` asserts that and has caught it. This text
// also changes several times per turn, per message, which is precisely the flooding the thread
// itself is kept off a live region for. It is a plain readable text node: a sighted reader gets it
// from the screen, and an assistive-tech reader gets the same information from the column's
// announcer, once, in the place every other thing this column says goes through.
import type {
  ConciergeActivityIcon,
  ConciergeActivityLine,
} from "../../engine/conciergeActivityLine";
import { useConciergeLiveness } from "../../services/conciergeLiveness";
import { C } from "../../theme/colors";
import { TYPE } from "../../theme/scale";
import { ACTIVITY_ICONS } from "./activityIcons";
import { AgentPill } from "./AgentPill";

export const MESSAGE_STATUS_TESTID = "concierge-message-status";

export interface ConciergeMessageStatus {
  /** The phrase, ALREADY COMPOSED by the producer — "Checking git", "Reading your message",
   *  "Composing", "Answered". This component NEVER invents or derives wording. */
  text: string;
  /** The age ladder. Drives the ink only — nothing else about the row changes between tones. */
  tone: "waiting" | "slow" | "stalled" | "settled";
  /** The tool domain the phrase came from, drawn as the rail's own glyph (see the header).
   *
   *  OPTIONAL because not every status has one: a queue position ("Next up", "3rd in line") is a
   *  fact about the queue rather than an observed tool call, so it has no domain and gets no mark.
   *  Deriving one from the words would be this component inventing a signal the producer never
   *  gave it — the same rule that keeps the wording out of here. */
  icon?: ConciergeActivityIcon;
  /** The agent the phrase NAMES, when it names one — the pieces either side of the subject plus the
   *  id, exactly as `conciergeActivityLine` hands them to the rail.
   *
   *  IT TRAVELS WITH THE WORDS, and that is the whole reason it is here. The subject used to be a
   *  live `AgentPill` because the rail drew it: a status dot, the agent's CURRENT name re-read from
   *  the roster, and a click that opens it — the founder's ask being *"as it renames, I would see it
   *  rename."* When sparkle-9ciay moved the sentence under the bubble, rendering `text` alone would
   *  have silently dropped all three and frozen the name at the value it had when the call was
   *  recorded (see ConciergeActivityLine.agentRef's doc). The same component draws it here, from
   *  inside the same `AgentPillProvider` the rail sat in, so the move costs nothing.
   *
   *  ABSENT is the ordinary case — a phase line, a queue position, or a subject that did not resolve
   *  to an agent — and then the phrase renders as the plain words it always was. */
  agentRef?: ConciergeActivityLine["agentRef"];
  /** Is this the OBSERVED activity line for the running turn, rather than a queue position?
   *
   *  Reaches the DOM as `data-live` and changes nothing visual — the same job `tone` does, and for
   *  the same reason its doc gives: a caller needs to name which line this is without reading a
   *  phrase back out and matching it. It matters more than a convenience since sparkle-9ciay,
   *  because this is now the ONLY place the observed line renders while a turn is running, so the
   *  suites that used to read it off the rail read it here. */
  live?: boolean;
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
  /** The tool domain behind the phrase — see {@link ConciergeMessageStatus.icon}. Absent for a
   *  queue position, which is not an observed call. */
  icon?: ConciergeActivityIcon;
  /** The agent the phrase names, so the subject stays a LIVE pill under the bubble — see
   *  {@link ConciergeMessageStatus.agentRef}. Carried rather than re-derived: slicing the name back
   *  out of `text` is the fragile answer the engine already refused to give. */
  agentRef?: ConciergeActivityLine["agentRef"];
  /**
   * Does this line describe something IN PROGRESS, whose ink should age?
   *
   * ══ WHY THIS DISCRIMINATOR EXISTS: 50 TICKERS ══════════════════════════════════════════════════
   * Only one bubble could ever carry a status until the turn queue landed, so `MessageStatusLive`'s
   * header could say "exactly one of these exists" and put `useConciergeLiveness` in the leaf on
   * that basis. A queue changes the arithmetic: every WAITING message carries a line too, up to
   * {@link MAX_QUEUED_TURNS} = 50 of them, and routing all of those through the live component would
   * mount 50 tickers — each re-rendering at 1 Hz for the whole of every turn, and each subscribed to
   * the liveness store WITHOUT a selector, so each also wakes on every `noteConciergeProgress`, i.e.
   * once per token chunk. That is the exact cost the leaf placement was chosen to avoid, multiplied
   * by the queue depth.
   *
   * ══ AND IT IS A CORRECTNESS FIX, NOT ONLY A COST ONE ═══════════════════════════════════════════
   * The clock those tickers read is the RUNNING turn's. A waiting message has no turn, so ageing its
   * ink says the wrong thing twice over: a queued question would go amber at 30s and sienna at 60s —
   * the app's two alarm inks — because a DIFFERENT message is taking a long time. Nothing is wrong
   * with the queued one; it simply has not started.
   *
   * So `false`/absent means STATIC: drawn once, quiet ink, no clock. True means the running message,
   * where the age ladder is exactly the signal the founder asked for.
   */
  live?: boolean;
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
  const Icon = status.icon ? ACTIVITY_ICONS[status.icon] : null;
  return (
    <div
      data-testid={MESSAGE_STATUS_TESTID}
      // The tone is on the DOM as well as in the ink so a test (and a screenshot diff) can say which
      // rung it is on without reading a colour back out of a style attribute.
      data-tone={status.tone}
      // Present only on the observed line — see `live`. Absent (not `"no"`) on a queue position, so
      // a `[data-live]` selector picks out the one status that is the activity line.
      data-live={status.live ? "yes" : undefined}
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
      {/* INLINE, not a flex item, and that is what keeps every rule above intact. This box owes the
          entry a single truncating line: `text-overflow: ellipsis` acts on a block's INLINE content,
          so a glyph in the same inline run is clipped and ellipsised with the words it belongs to,
          and `text-align: right` still ends the whole run — mark and phrase together — on the
          column's right edge. Making this a flex row would have moved the ellipsis onto an inner
          span and quietly retired the four declarations above that produce it.

          `aria-hidden`: the domain is decoration beside a phrase that already names the work, and
          this surface is deliberately not a second announcer (see the header). */}
      {Icon && (
        <Icon size={12} aria-hidden style={{ verticalAlign: "-2px", marginRight: 4 }} />
      )}
      {/* THE SUBJECT IS A LIVE CONTROL WHEN IT IS AN AGENT — the same three-piece split
          `ThinkingIndicator` draws, moved here with the sentence it belongs to (see `agentRef`).
          Rendering `text` alone would have frozen the agent's name at the value it had when the call
          was recorded and dropped the click that opens it, which is the founder's *"as it renames, I
          would see it rename"* undone by a refactor rather than by a decision.

          NO `onOpen`: the pill takes the column's context opener, exactly as it does in the rail —
          this row sits inside the same `AgentPillProvider` (ConciergeColumn wraps ConciergeThread,
          which renders the message rows). Without a ref the phrase is plain words, unchanged. */}
      {status.agentRef ? (
        <>
          {status.agentRef.before}
          <AgentPill agentId={status.agentRef.agentId} fallbackName={status.agentRef.name} />
          {status.agentRef.after}
        </>
      ) : (
        status.text
      )}
    </div>
  );
}

/**
 * The clock read, in the smallest thing that can hold it.
 *
 * Mounted ONLY when there is a status, which is why the hook can live here at all: `useConciergeLiveness`
 * keeps `now` in state and re-renders its caller at 1 Hz for the duration of every turn, and it
 * subscribes to the liveness store WITHOUT a selector — so it also re-renders on every
 * `noteConciergeProgress`, i.e. per token chunk. Both of those re-render paths stop at this `div`.
 *
 * ══ HOW MANY OF THESE EXIST — AND WHY THE NUMBER IS ASSERTED SOMEWHERE ═════════════════════════
 * ONE PER MESSAGE OF THE RUNNING RUN, not one full stop. This header used to say "exactly one of
 * these exists"; that was true when only one bubble could carry a status, and a later feature made
 * it false without anyone re-reading the sentence that a cost was justified by — `RunningRun` lets
 * one turn answer a run of messages, and the producer puts the SAME live line on every one of them.
 * So the ticker count is the run's length.
 *
 * A comment cannot fail, which is the whole finding (bead sparkle-vfqhm). The bound now has a test:
 * `services/conciergeMessageStatuses.tickerCount.test.ts` counts the `live` statuses the producer
 * emits for a full 50-deep queue and for an absorbed run. Change what a run absorbs, or route a
 * waiter through here, and a number moves rather than a docstring going quietly stale.
 *
 * THE STATIC/LIVE SPLIT IS A PROPERTY OF THE FLAG, NOT OF THE THREAD, and that distinction is what
 * keeps the count small. Every WAITING message carries a status too, up to {@link MAX_QUEUED_TURNS}
 * = 50 of them. Routing a waiter through here — by setting `live: true` on it in the producer —
 * re-creates precisely the per-bubble ticker cost this placement exists to avoid, multiplied by the
 * queue depth, and ages its ink off a clock that belongs to a different message. See
 * {@link ConciergeMessageStatusText.live}.
 *
 * Calling the hook one level up — in `MessageStatus`, which every row renders — would mount a ticker
 * per bubble; calling it in the producer put it in the host.
 */
function LiveMessageStatus({
  text,
  icon,
  agentRef,
}: {
  text: string;
  icon?: ConciergeActivityIcon;
  agentRef?: ConciergeActivityLine["agentRef"];
}) {
  const { liveness } = useConciergeLiveness();
  return (
    <MessageStatus
      status={{
        text,
        icon,
        agentRef,
        live: true,
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
  // A STATIC line takes the plain component and never mounts the ticker — see `live`'s doc for why
  // that matters at queue depth, and why a waiting message must not age into an alarm ink.
  if (!status.live)
    return (
      // `agentRef` forwarded here too, though today nothing sets it on a static line — a queue
      // position names no agent, which the producer's suite pins. Dropping a field on ONE of two
      // branches is how a surface silently loses a feature later: the day a static line does carry a
      // subject, it would render as frozen words here and as a live pill three lines down, and
      // nothing would say so. Forwarding costs nothing and cannot be wrong.
      <MessageStatus
        status={{
          text: status.text,
          icon: status.icon,
          agentRef: status.agentRef,
          tone: "waiting",
        }}
      />
    );
  return <LiveMessageStatus text={status.text} icon={status.icon} agentRef={status.agentRef} />;
}
