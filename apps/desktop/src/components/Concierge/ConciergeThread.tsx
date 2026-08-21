// The long chat thread: right-aligned user bubbles, left plain Sparkle replies (no
// "You"/"Sparkle" labels, no left-side glow — alignment and chrome carry authorship), batch
// dividers, and nudge cards. Auto-follows the newest message.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FiCheck } from "react-icons/fi";
import { useAutoFollow } from "../../hooks/useAutoFollow";
import { C } from "../../theme/colors";
import { TYPE } from "../../theme/scale";
import { useCopyOnSelection } from "./useCopyOnSelection";
import { useQuoteOnSelection, type PendingQuote } from "./useQuoteOnSelection";
import { QuoteChiclet } from "./QuoteChiclet";
import { useSelectionStableThread } from "./useSelectionStableThread";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { ConciergeMessageRow } from "./ConciergeMessageRow";
import type { ConciergeMessageStatusText } from "./MessageStatus";
import { answeredByIndex } from "./replyAnchors";
import { ANCHOR_HIGHLIGHT_MS } from "./ReplyAnchorViews";
// THE collapsed-text modal — the same component the BUILD-AGENT composer draws (via
// components/composer/AttachmentRow), reused here rather than copied into a transcript-shaped twin (see
// TextPill's header for why there is only one). All three surfaces are on this primitive now: both
// compose boxes and this transcript, on BOTH sides of it (the concierge's relayed brief and the
// founder's own paste). The note that used to sit here — "the concierge's own compose box is NOT on
// this primitive yet" — was stale by the time anyone read it (roborev 55746 landed).
import { TextPillModal } from "../composer/TextPillModal";
// WHICH BLOCKS AN ENTRY CARRIES — one rule, shared with the row that draws them (./collapsedBlocks).
import { blockKey, collapsedBlocksOf, shownIdsFor } from "./collapsedBlocks";
// A RUN OF IDENTICAL RECEIPTS, folded to one row — the rule in ./receiptRuns, the drawing in
// ./ReceiptRunRow. Sixteen "Sent to @X's terminal." rows were one fact costing the whole column.
import { foldReceiptRuns } from "./receiptRuns";
import { ReceiptRunRow } from "./ReceiptRunRow";
import { CONCIERGE_THREAD_TESTID } from "../../engine/composeBoxHeight";
import type {
  ConciergeCopyKind,
  ConciergeDigestMessage,
  ConciergeMessage,
  ConciergeNudge,
} from "./types";

/** The "Earlier — loaded from history" seam between paged-in turns and the live window. */
export const BACKLOG_DIVIDER_TESTID = "concierge-backlog-divider";

/** The column to the right of the scroller that the caller fills (the scrubber rail lands here). */
export const THREAD_RAIL_TESTID = "concierge-thread-rail";

// Re-exported: these ids named this module before the per-message rendering moved into its own
// component, and the thread is still where a reader looks for them.
export {
  COLLAPSED_TEXT_TESTID,
  FAILURE_BUBBLE_TESTID,
  FAILURE_EVIDENCE_TESTID,
} from "./ConciergeMessageRow";

/** The id of the NEWEST message the user themselves sent, or "" when the thread has none.
 *
 *  Scanned backwards rather than read off `messages.at(-1)`: ConciergeHost builds the array as
 *  [...chat, ...nudges], so the bubble the user just sent is only last while nothing is surfaced —
 *  and "something is surfaced" is the state the column normally lives in. Same reasoning the
 *  content key's total-length term is written against. */
function newestUserMessageId(messages: ConciergeMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.kind === "you") return m.id;
  }
  return "";
}

export function ConciergeThread({
  messages,
  typing = false,
  onNudgeClick,
  onRevealAgent,
  onNudgeAction,
  onRedirect,
  onDigestClick,
  copyOnSelection = true,
  onCopied,
  onQuote,
  wired = false,
  statuses,
  turnFloor,
  backlog,
  rail,
  jumpRequest,
}: {
  messages: ConciergeMessage[];
  /**
   * Older turns paged in from durable history, rendered ABOVE `messages` with a quiet divider
   * ("Earlier — loaded from history") so the reader can see where the live window begins.
   *
   * WHY IT IS A SEPARATE PROP RATHER THAN PREPENDED INTO `messages` BY THE HOST. Three things here
   * read `messages` and would be wrong if it silently grew by a few hundred paged-in entries: the
   * auto-follow `contentKey` (a prepend is not new content and must not scroll anyone), the reply-
   * anchor index (a restored-window anchor would start claiming backlog bubbles), and
   * `useSelectionStableThread`'s structure hold. Keeping the two arrays apart means every existing
   * rule keeps applying to exactly the set it was written for.
   *
   * OPTIONAL, and absent means nothing changes — every existing caller and suite renders what it did
   * before, which is the same contract `statuses` has.
   */
  backlog?: ConciergeMessage[];
  /** A fixed-width column rendered to the RIGHT of the scroller, full height. The thread owns the
   *  layout; the caller owns what goes in it. (The scrubber rail lands here.) */
  rail?: ReactNode;
  /**
   * Scroll to this message id.
   *
   * `{ id, seq }` RATHER THAN A BARE ID BECAUSE PICKING THE SAME DOT TWICE MUST SCROLL TWICE. A
   * second pick of the same marker sets state to an `Object.is`-equal value, which React bails out
   * of — no re-render, no effect, no scroll — so the reader clicks a dot, scrolls away, clicks it
   * again and nothing happens. That is the exact bug `ConciergeAnnouncement`'s seq counter exists to
   * prevent in `ConciergeHost`; the same counter is the same fix here.
   */
  jumpRequest?: { id: string; seq: number };
  typing?: boolean;
  /** What the concierge is doing about each message the user sent, KEYED BY MESSAGE ID and already
   *  phrased by the producer (see ./MessageStatus).
   *
   *  OPTIONAL, and absent means the feature is simply not on — every existing caller and every
   *  existing suite renders exactly what it did before. Sparse by nature: a thread of a hundred
   *  bubbles normally has an entry for one of them.
   *
   *  THE MAP STOPS HERE. Each row is handed `statuses?.[m.id]` — the resolved entry — and never this
   *  object or a `statusFor` callback, either of which would change identity on every tick and
   *  re-render all hundred memoised rows for a fact about one (see the row's header, and the same
   *  reasoning behind `shownBlockIds` being a primitive). Resolved per row, a bubble with no status gets
   *  `undefined` on both renders and stays inert. */
  statuses?: Record<string, ConciergeMessageStatusText>;
  /**
   * The ONE turn boundary the column reports against — see ThinkingIndicator.
   *
   * REQUIRED, and the `?? -1` this replaces was a lie that failed OPEN (roborev 57941-M2): floor
   * -1 passes every entry, so an unwired hop did not degrade to the honest pulse — it narrated the
   * PREVIOUS turn's last line under the new bubble, which is the exact falsehood the boundary
   * exists to remove. Before the floor moved out of the indicator an unwired consumer was
   * self-correcting on the typing edge; now it would be maximally wrong and silently so, so the
   * invariant is carried by the DEFAULT instead: an absent boundary means "we do not know which
   * turn this is", and the honest rendering of that is the bare pulse — which is what an infinite
   * floor produces, since no entry can ever exceed it. Optional so the dozens of thread tests that
   * do not care about the boundary keep working; wrong-by-omission is what changed, not the shape.
   */
  turnFloor?: number;
  /** The column around this thread is PATCHED to a terminal and has taken its colour. The user's
   *  bubble then paints a wash of the terminal's own ink instead of `--k-bubble`, which is a SHELL
   *  surface and would read as a foreign blue rectangle sitting on the flood. Purely
   *  presentational; the column decides (see ConciergeColumn's `data-wired`). */
  wired?: boolean;
  onNudgeClick: (nudge: ConciergeNudge) => void;
  onRevealAgent?: (agentId: string) => void;
  onNudgeAction: (nudge: ConciergeNudge, actionId: string) => void;
  /** Redirect the message with this id the other way (see RoutingReceipt). */
  onRedirect?: (messageId: string) => void;
  /** A digest line was clicked: open that project and reveal its lead agent. */
  onDigestClick?: (digest: ConciergeDigestMessage) => void;
  /** The user's "Copy on selection" preference — the SELECTION affordance only. Defaults ON. */
  copyOnSelection?: boolean;
  /** Something was copied. Routed up so the integration layer announces it through the column's ONE
   *  live region; this component adds no `aria-live` node (see ./types ConciergeController). */
  onCopied?: (what: ConciergeCopyKind) => void;
  /** A highlighted fragment was sent to the compose box via the "Quote in response" chiclet. Absent
   *  → the affordance is not mounted at all (the hook listens for nothing), which is how a thread
   *  with no composer under it opts out. */
  onQuote?: (quote: PendingQuote) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // GUARD 4 — WHAT THE READER ACTUALLY SEES, which is `messages` except while a selection is being
  // dragged out, when the thread's STRUCTURE is held still (./useSelectionStableThread).
  //
  // The founder's report is that the start of a drag "often gets reset". The two guards that already
  // defend a gesture do not cover it: `useCopyOnSelection` below stops a mid-gesture clipboard write
  // tearing the selection down, and `useAutoFollow`'s guard 3 stops the follow scrolling the
  // container out from under him. Both protect the viewport and the Selection object; neither stops
  // the DOCUMENT reflowing. Alert cards are interleaved into the MIDDLE of the conversation by
  // arrival (engine/conciergeStreamOrder) and come and go as agents enter and leave `needs_you`, so
  // one disappearing between his two endpoints shifts everything below it up by a card's height
  // while his mouse is held still — and the browser re-extends the highlight to whatever is now
  // under the pointer. Memoising cannot help: those entries genuinely changed.
  //
  // EVERYTHING DOWNSTREAM READS `visible`, not `messages` — the rows, the auto-follow keys, and the
  // payload lookup. A key computed from the live array while the held one is on screen would make
  // the follow chase content the reader cannot see.
  //
  // It takes the SAME scroll container `useCopyOnSelection` watches, because it arms on a live
  // selection reaching into the thread rather than on a bare press — the app has several long
  // press-and-hold gestures (a column resize, a terminal drag) that must not freeze this column.
  const visible = useSelectionStableThread(messages, scrollRef);
  // Copy-on-selection, mounted ONCE on the scroll container — never per message. See the hook's
  // header for why the selection path copies plain text while the per-answer button copies source.
  const selectionCopied = useCopyOnSelection(scrollRef, {
    enabled: copyOnSelection,
    onCopied: useCallback(() => onCopied?.("selection"), [onCopied]),
  });
  // "Quote in response", mounted BESIDE the copy hook on the same scroller rather than folded into
  // it. The two are independent answers to one gesture — copy writes the clipboard, this stages a
  // reply — and they can both fire on the same `mouseup` without either knowing about the other.
  // Gated on `onQuote` so a thread with no compose box under it listens for nothing.
  const { pending: pendingQuote, dismiss: dismissQuote } = useQuoteOnSelection(scrollRef, {
    enabled: !!onQuote,
  });
  // ── Handlers, STABILISED ───────────────────────────────────────────────────────────────────────
  //
  // Every callback below is handed to a memoised row (./ConciergeMessageRow), and a memo is only
  // worth having if its props actually hold still. These arrive as props from the column, which gets
  // them from the host — several of them inline — so the identity of what we are given changes on
  // every tick and cannot be relied on. Kept in refs and re-exposed as `useCallback`s with empty
  // deps, so a row's props are identical across a tick that changed nothing about that row, and the
  // memo bites regardless of how a caller upstream chooses to build its handlers.
  //
  // `onCopied` IS ONE OF THEM. It was left as `useCallback(…, [onCopied])` at first, which happens to
  // be stable today only because the host builds its `onCopied` over a `useCallback(…, [])`
  // `announce`. That is a property of one caller, not of this component's contract: any future
  // caller passing an inline `onCopied` would silently re-render every row on every feed tick and
  // undo the whole of this change, with nothing failing.
  const handlers = useRef({
    onNudgeClick,
    onNudgeAction,
    onRevealAgent,
    onRedirect,
    onDigestClick,
    onCopied,
  });
  handlers.current = {
    onNudgeClick,
    onNudgeAction,
    onRevealAgent,
    onRedirect,
    onDigestClick,
    onCopied,
  };
  const onAnswerCopied = useCallback(
    () => handlers.current.onCopied?.("answer"),
    [],
  );
  // The user's own bubble reports a DIFFERENT kind, so the live region can say "Message copied"
  // rather than telling him his own words were an answer. Stabilised exactly like the one above —
  // it reaches every memoised row, so an unstable identity here would re-render the whole transcript
  // on every feed tick and bring back the drag-stutter this file's memo exists to kill.
  const onMessageCopied = useCallback(
    () => handlers.current.onCopied?.("message"),
    [],
  );
  const nudgeClick = useCallback(
    (n: ConciergeNudge) => handlers.current.onNudgeClick(n),
    [],
  );
  const nudgeAction = useCallback(
    (n: ConciergeNudge, a: string) => handlers.current.onNudgeAction(n, a),
    [],
  );
  const revealAgent = useCallback(
    (id: string) => handlers.current.onRevealAgent?.(id),
    [],
  );
  const redirect = useCallback(
    (id: string) => handlers.current.onRedirect?.(id),
    [],
  );
  const digestClick = useCallback(
    (d: ConciergeDigestMessage) => handlers.current.onDigestClick?.(d),
    [],
  );
  // ── A collapsed payload, on EITHER side of the thread ─────────────────────────────────────────
  //
  // A relayed brief under a sparkle line (ConciergeSparkleMessage.collapsed) and the founder's own
  // paste in a `you` bubble (ConciergeUserMessage.collapsed) are the same object drawn the same way,
  // so one modal and one expanded-set serve both. That sameness is the founder's ask, not a
  // coincidence: *"I want that same functionality when I'M the one sending big blocks of text."*
  //
  // KEYED BY THE (MESSAGE, BLOCK) PAIR. A message-keyed set would expand a paste's siblings along
  // with it; a BLOCK-keyed one would confuse two pastes that happen to share an id, which is not
  // hypothetical — the id counter restarts at 0 every launch and a restored block keeps its original
  // one (roborev 58639). See ./collapsedBlocks' header.
  //
  // Both bits of state are LOCAL, deliberately. Neither is a fact about the conversation: which
  // modal is open and which payload the reader has expanded are properties of this reading session,
  // and the thread is persisted — writing them onto the message would restore a thread tomorrow with
  // a brief already spilled open, which is the flood coming back by the other door. Held here rather
  // than per-bubble because the modal is portaled to `document.body` and only ever wants ONE
  // instance on screen.
  /** Which payload has its full-text modal open, as a `blockKey` pair, or null. */
  const [openPayloadId, setOpenPayloadId] = useState<string | null>(null);
  /** Blocks the reader asked to see as regular text, IN PLACE — the founder's literal ask ("show as
   *  regular text" puts it back in the bubble, not in a panel). */
  const [shownAsText, setShownAsText] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // Only walked while a modal is actually open, so the common render costs nothing. The message is
  // held through the flatMap because the identity being matched is the pair, not the block.
  const openPayload =
    openPayloadId === null
      ? undefined
      : visible
          .flatMap((m) =>
            collapsedBlocksOf(m).map((b) => ({
              key: blockKey(m.id, b.id),
              block: b,
            })),
          )
          .find((e) => e.key === openPayloadId)?.block;
  /** Open the full-text modal for a block. Stable, so it does not un-memoise every row. */
  const openPayloadFor = useCallback((id: string) => setOpenPayloadId(id), []);
  // ── Reply anchoring: the jump, and the flash that says where you landed ────────────────────────
  //
  // Which message a reply answers is recorded ON the reply (`ConciergeSparkleMessage.answers`, filled
  // by ConciergeHost from the rule in ./replyAnchors). The BACK direction is derived here rather than
  // written onto the `you` bubble, so the reply's array stays the single record and the two can never
  // disagree about which message an answer belongs to.
  //
  // The lookup is rebuilt on every tick and that is fine: it walks the array once and yields plain
  // strings, so a settled row's props are unchanged and the memo still bites. Handing rows the MAP
  // itself would defeat it — a new container every tick re-renders the whole transcript.
  //
  // BUILT FROM `visible`, NOT THE RAW PROP (guard 4). These two features landed independently and
  // only interact here. Indexed off `messages`, a reply arriving mid-drag would give the `you` bubble
  // above it an "answered" affordance while the reply itself is still withheld — which both changes
  // that bubble's HEIGHT under the reader's pointer (the reflow guard 4 exists to prevent) and aims
  // `onJump` at a message id that is not currently rendered, so `jumpTo`'s scan finds nothing and the
  // click does nothing. Indexed off what is on screen, the affordance and its target appear together.
  const answeredBy = useMemo(() => answeredByIndex(visible), [visible]);
  // ── THE FOLD, COMPUTED ONCE PER THREAD RATHER THAN ONCE PER RENDER ───────────────────────────
  // `foldReceiptRuns` walks the WHOLE transcript and allocates a fresh `ThreadRow[]`, and it used to
  // do it inline in the JSX below — so it ran on every render of this component, including the ones
  // that have nothing to do with the transcript. Typing is the case that matters: the draft is
  // lifted into the host's state on every character, which re-renders this container, and the fold
  // was redoing a full pass over every message in the conversation for each one.
  //
  // The message ROWS were already memoized and bail out, so this was never row cost — it is this
  // container's own, and it grows with the length of the conversation rather than with anything the
  // keystroke changed. `visible` is the only thing the fold reads, and it is itself memoized
  // upstream (`useSelectionStableThread`), so it is the whole dependency.
  const rows = useMemo(() => foldReceiptRuns(visible), [visible]);

  /**
   * IS A BUBBLE ALREADY SAYING WHAT THE RAIL WOULD SAY? (sparkle-9ciay)
   *
   * The founder: *"you're giving me an update in the left side of the chat window but then ALSO
   * below the message itself… I don't need to see it twice."* Two surfaces render the same
   * `conciergeActivityLine`: `ThinkingIndicator` recomputes it from the activity store, and the
   * producer behind `statuses` pins that same global entry onto the awaited bubble. Neither can see
   * the other. THIS component renders both, so this is the only place the "never in both" rule can
   * be a guarantee instead of a convention — which is why the decision is made here and handed down,
   * rather than each surface being trusted to stay in step.
   *
   * `live` IS THE CLAIM, and it is exactly the right flag: it marks the one status that is the
   * observed activity line for the running turn (see MessageStatus's `live` doc). A queued message's
   * "3rd in line" is a fact about the queue that the rail never says, so it claims nothing and the
   * rail keeps its own line — asserted in ConciergeThread.statusOwnership.test.tsx.
   *
   * Memoised on the map's identity, which the producer already keeps stable (`NONE` for the common
   * empty case) — so the common thread does not walk this object on every render.
   */
  const activityClaimed = useMemo(
    () => Object.values(statuses ?? {}).some((s) => s.live === true),
    [statuses],
  );
  /** The message the reader just jumped to, lit for {@link ANCHOR_HIGHLIGHT_MS}. */
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (highlightTimer.current !== null) clearTimeout(highlightTimer.current);
    },
    [],
  );
  /**
   * Scroll a message into view and light it up.
   *
   * FOUND BY SCANNING, not by `querySelector`. Message ids are minted from several producers
   * (`you-1`, `brain-7`, `restored:0`) and one of them contains a colon; building a selector string
   * out of user-facing data is how a lookup starts depending on escaping rules nobody checks. The
   * thread is capped at 200 entries, so a linear scan of its own scroller costs nothing.
   *
   * `scrollIntoView` is called optionally because jsdom does not implement it — the guard keeps every
   * suite that renders this thread from throwing on a click, without any of them having to know.
   */
  const jumpTo = useCallback((id: string) => {
    const root = scrollRef.current;
    if (!root) return;
    const target = Array.from(
      root.querySelectorAll<HTMLElement>("[data-message-id]"),
    ).find((el) => el.dataset.messageId === id);
    if (!target) return;
    target.scrollIntoView?.({ block: "center", behavior: "smooth" });
    setHighlightId(id);
    if (highlightTimer.current !== null) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => {
      highlightTimer.current = null;
      setHighlightId(null);
    }, ANCHOR_HIGHLIGHT_MS);
  }, []);
  // Auto-follow lives in `hooks/useAutoFollow`, shared with the mounted-agent transcript thread.
  // All three guards — the content key, the stick-to-bottom read, and the live-selection deferral —
  // moved with it, so both threads behave identically and neither can drift from the other. What
  // stays here is the pair of KEYS, because only this component knows what "the content changed"
  // and "the reader just sent something" mean for a concierge message array.
  //
  // The content key includes TOTAL text length because the brain streams: `onConciergeDelta` upserts
  // the same `brain-<id>` bubble with more text, so count and last id both stay put while the reply
  // grows below the fold. Keyed on those alone, the thread stopped following mid-answer. Total, not
  // the LAST message's length: ConciergeHost builds `messages` as [...chat, ...nudges], so the moment
  // any agent is surfaced the growing bubble is no longer last and a per-last-message length tracks a
  // static nudge instead — which is the state the column normally lives in.
  //
  // `typing` is folded into the key rather than passed separately: the hook re-runs its follow on any
  // change to the key, which is exactly what a third dependency did before the extraction.
  //
  // Computed from `visible` (guard 4), never from the raw prop: while a drag holds the structure
  // still, a key built from the live array would change for content that is not on screen and send
  // the follow chasing it. Guard 3 defers the scroll for the length of the gesture and guard 4
  // releases on the same `mouseup`, so the catch-up happens once, from the truth.
  const last = visible.length > 0 ? visible[visible.length - 1]! : undefined;
  const totalLength = visible.reduce(
    (n, m) => n + ("text" in m ? m.text.length : 0),
    0,
  );
  const contentKey = `${visible.length}:${last?.id ?? ""}:${totalLength}:${typing ? 1 : 0}`;
  // The re-arm key is the newest message the USER sent — never "a user message exists". A thread the
  // user has ever typed in contains a `you` bubble forever, and the host hands this component a fresh
  // array several times a second; a presence test would re-arm on every feed tick and restore bead
  // sparkle-y4ft's "clicking an item scrolls the column" in full.
  //
  // `backlog` IS DELIBERATELY ABSENT FROM BOTH KEYS. Paging older turns in is a PREPEND — it adds
  // nothing below the reader and answers a request they just made — so folding its length into
  // `contentKey` would fire the follow and slam the column to the bottom at the exact moment the
  // scrubber was taking them three days back. That is the most likely way this whole feature ships
  // looking broken, and it is asserted in ConciergeThread.scrubber.test.tsx.
  const { onScroll, releaseFollow } = useAutoFollow({
    contentKey,
    rearmKey: newestUserMessageId(visible),
    scrollRef,
  });

  /**
   * THE RAIL'S PICK, ROUTED THROUGH THE EXISTING `jumpTo`.
   *
   * There is exactly one scroll-to-message path in this component and this is not a second one: a
   * reply anchor and a scrubber dot are the same gesture ("take me to that message") and must land
   * the same way, flash included.
   *
   * KEYED ON `seq`, NOT ON `id` — see the prop's doc. And the follow is RELEASED as part of the
   * jump: the reader asked to be moved, so new content must not undo it before their own scroll
   * event has had a chance to demote anything (see useAutoFollow's `releaseFollow`).
   *
   * A plain effect, so it runs AFTER the commit that painted the backlog. The host awaits `loadBack`
   * before it bumps `seq`, but both updates can still batch into one render — and `jumpTo` scans the
   * DOM, so a jump issued before that paint would find nothing and silently do nothing.
   */
  const jumpSeq = jumpRequest?.seq;
  const jumpId = jumpRequest?.id;
  useEffect(() => {
    if (jumpSeq === undefined || jumpId === undefined) return;
    releaseFollow();
    jumpTo(jumpId);
    // `jumpId` is read, not depended on: a repeat pick of the SAME dot must re-run this, and the seq
    // is what says so. Listing the id as well would be harmless today and wrong the moment two
    // requests share a seq.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpSeq]);

  // ONE MESSAGE, DRAWN — extracted so the transcript and a folded run's expanded members go through
  // the SAME call rather than two prop lists that drift. A receipt inside a fold must render exactly
  // as it does outside one; the fold is a display grouping, not a different kind of row.
  //
  // NOT memoised, and it does not need to be: every prop below is either the message itself or a
  // callback already stabilised above, and `ConciergeMessageRow` is `memo`'d on those props — so a
  // settled entry still re-renders exactly never. See the row's header for why that inertness
  // matters (a transcript that re-diffs on every token makes a click-drag selection stutter).
  const renderRow = (m: ConciergeMessage) => (
    // KEYED BY MESSAGE ID.
    <ConciergeMessageRow
      key={m.id}
      message={m}
      wired={wired}
      shownBlockIds={shownIdsFor(m, shownAsText)}
      onOpenPayload={openPayloadFor}
      onNudgeClick={nudgeClick}
      onNudgeAction={nudgeAction}
      onRevealAgent={revealAgent}
      onRedirect={redirect}
      onDigestClick={digestClick}
      onAnswerCopied={onAnswerCopied}
      onMessageCopied={onMessageCopied}
      answeredBy={m.kind === "you" ? answeredBy.get(m.id) : undefined}
      // RESOLVED HERE, so the row never sees the map. See the `statuses` prop doc: handing
      // down the container (or a closure over it) would defeat the memo for the whole
      // transcript on every tick, which is what this component's stabilisation work is for.
      status={m.kind === "you" ? statuses?.[m.id] : undefined}
      highlighted={highlightId === m.id}
      onJump={jumpTo}
    />
  );

  return (
    // THE POSITIONED ANCESTOR THE TOAST HANGS OFF, and the reason there is a wrapper at all. The
    // confirmation must not shift the layout by a pixel (PRD 1 §1), which rules out a flow element;
    // an absolutely-positioned one needs a positioned ancestor, and it must NOT be the scroller
    // itself or the toast would slide away with the content. This div is a pure box: it takes the
    // `flex: 1` the scroller used to have and hands it straight back, so the column's geometry — and
    // ComposeBox's measurement of it, which finds the thread by testid from the section — is
    // unchanged.
    <div
      style={{
        position: "relative",
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* THE ROW. The rail sits BESIDE the scroller, full height, so a drag on it is never a scroll
          of the transcript. This wrapper takes the `flex: 1` the scroller had and hands it back, so
          the column's geometry is unchanged — and `CONCIERGE_THREAD_TESTID` /
          `data-concierge-scroller` stay on the SCROLLER itself, where ComposeBox measures its drag
          ceiling and `threadScrollerMarker.test.tsx` looks for them. */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "row" }}>
      <div
        ref={scrollRef}
        data-testid={CONCIERGE_THREAD_TESTID}
        // The marker ComposeBox measures its drag ceiling against. BOTH threads carry it — see
        // MountedAgentThread — so the composer asks for "the thread" and never has to know which one
        // is on screen. Dropped once already, by a merge that took the other side's JSX verbatim;
        // `threadScrollerMarker.test.tsx` now asserts both scrollers have it so that cannot recur.
        data-concierge-scroller="yes"
        onScroll={onScroll}
        // NOT a live region (roborev 53010). Putting one here looked right — `role="log"` is the
        // standard for an append-only transcript — but this transcript is not append-only: the host
        // appends each brain delta into the LAST message's text, so a polite region over the thread
        // re-announces the growing reply on every chunk. That is the same flooding the interim
        // dictation preview was silenced for, moved one component over. The announcements live in
        // the hidden status node below, which only ever receives FINISHED lines.
        aria-label="Conversation with Sparkle"
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "8px 16px",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        {/* PAGED-IN HISTORY, ABOVE THE LIVE WINDOW. Older turns the live thread no longer holds —
            `conciergeThreadStore` caps it at 200 and trims from the front — fetched back out of
            SQLite by the scrubber rail. Drawn with the SAME `renderRow` as everything else, because
            a turn from three days ago is not a different kind of message; only the divider says
            where the live window begins. Rendered outside the receipt fold on purpose: folding is a
            display grouping over the CURRENT conversation, and a run spanning the seam between
            history and live would be a group that changes shape as the backlog grows. */}
        {backlog && backlog.length > 0 && (
          <>
            {backlog.map((m) => renderRow(m))}
            <div
              data-testid={BACKLOG_DIVIDER_TESTID}
              aria-hidden
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                margin: "4px 0",
                fontSize: TYPE.small,
                color: C.muted,
                whiteSpace: "nowrap",
              }}
            >
              <span style={{ flex: 1, height: 1, background: C.hairline }} />
              Earlier — loaded from history
              <span style={{ flex: 1, height: 1, background: C.hairline }} />
            </div>
          </>
        )}
        {/* FOLDED FIRST, DRAWN SECOND. `foldReceiptRuns` decides which rows collapse; every message
            it does not fold comes through exactly as it always did, and the folded ones are the
            SAME rows rendered inside a disclosure rather than different ones. A refused or partly
            refused send is never foldable, so it keeps its own row here by construction rather than
            by anything this JSX has to remember. */}
        {rows.map((row) =>
          row.type === "message" ? (
            renderRow(row.message)
          ) : (
            // KEYED BY THE RUN'S FIRST MEMBER — a message id, so it is unique in the thread and
            // stable while the run is.
            <ReceiptRunRow key={row.id} run={row}>
              {row.members.map((m) => renderRow(m))}
            </ReceiptRunRow>
          ),
        )}
        {/* The pulse, plus what the concierge is actually doing when it is doing something the app
            observed AND no bubble is already saying it — see ThinkingIndicator and `activityClaimed`
            above. It falls back to exactly the bare "…" this used to be. */}
        <ThinkingIndicator
          typing={typing}
          floor={turnFloor ?? Number.POSITIVE_INFINITY}
          activityClaimed={activityClaimed}
        />
      </div>
        {/* The caller's column. Not rendered at all when there is nothing to put in it, so a thread
            with no rail has exactly the DOM it had before this prop existed. */}
        {rail !== undefined && rail !== null && (
          <div
            data-testid={THREAD_RAIL_TESTID}
            style={{ flexShrink: 0, display: "flex", alignItems: "stretch" }}
          >
            {rail}
          </div>
        )}
      </div>
      {/* "It's on your clipboard." A check mark, no words, gone in ~1.2s.
          THREE THINGS IT MUST NOT DO, all of them structural rather than stylistic:
            • shift the layout — hence `position: absolute` against the wrapper above, not a flow
              element in the scroller;
            • take focus — it is a `<div>` with nothing focusable in it and nothing calls focus() on
              it, so the caret stays wherever the user left it;
            • speak — it is `aria-hidden`. The confirmation reaches a screen reader through the
              column's ONE live region, via `onCopied` (see ./types). A second `aria-live` node here
              is exactly the double-announcement roborev 52648/53010/53088 were about.
          `pointerEvents: none` so it can never eat the click that lands under it. */}
      {selectionCopied && (
        <div
          data-testid="concierge-copy-toast"
          aria-hidden
          style={{
            position: "absolute",
            right: 14,
            bottom: 10,
            display: "flex",
            alignItems: "center",
            gap: 4,
            pointerEvents: "none",
            background: `color-mix(in srgb, ${C.teal} 20%, ${C.conciergeSurface})`,
            border: `1px solid color-mix(in srgb, ${C.teal} 45%, transparent)`,
            borderRadius: 6,
            padding: "3px 7px",
            fontSize: TYPE.small,
            color: C.cream,
          }}
        >
          <FiCheck size={12} />
          Copied
        </div>
      )}
      {/* THE CHICLET. Portalled to `document.body`, so it is outside this scroller's `overflow-y`
          and cannot be clipped near the bottom edge where most selections end.
          It hands back the SNAPSHOT taken when the selection finished, never a fresh read of the
          live Selection — by the time this fires, `useCopyOnSelection` may already have torn the
          selection down and rebuilt it, and Tab-ing to the button has cleared it outright. */}
      {onQuote && pendingQuote && (
        <QuoteChiclet
          x={pendingQuote.x}
          y={pendingQuote.y}
          onQuote={() => {
            onQuote(pendingQuote);
            dismissQuote();
          }}
          onDismiss={dismissQuote}
        />
      )}
      {/* The full text behind a collapsed payload: read it, copy it verbatim, or put it back into the
          bubble as regular text. ONE instance for the whole thread — the overlay portals to
          `document.body`, so a per-bubble copy would stack identical dialogs.
          "Show as regular text" EXPANDS IN PLACE and closes the modal; it does not remove the block
          the way the composer's does, because there is nothing here to remove it from — the payload is
          a record of what was sent, and the reader is choosing how to look at it. */}
      {openPayload && (
        <TextPillModal
          block={openPayload}
          onClose={() => setOpenPayloadId(null)}
          onShowAsText={() => {
            // The KEY that is open, not the block's own id — the set is keyed on the pair too, or
            // expanding one paste would expand every same-id block in the thread.
            const key = openPayloadId;
            setShownAsText((prev) =>
              key === null ? prev : new Set(prev).add(key),
            );
            setOpenPayloadId(null);
          }}
        />
      )}
    </div>
  );
}
