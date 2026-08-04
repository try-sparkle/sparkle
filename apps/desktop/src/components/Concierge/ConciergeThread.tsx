// The long chat thread: right-aligned user bubbles, left plain Sparkle replies (no
// "You"/"Sparkle" labels, no left-side glow — alignment and chrome carry authorship), batch
// dividers, and nudge cards. Auto-follows the newest message.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FiCheck } from "react-icons/fi";
import { useAutoFollow } from "../../hooks/useAutoFollow";
import { C } from "../../theme/colors";
import { TYPE } from "../../theme/scale";
import { useCopyOnSelection } from "./useCopyOnSelection";
import { useSelectionStableThread } from "./useSelectionStableThread";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { ConciergeMessageRow } from "./ConciergeMessageRow";
import type { ConciergeMessageStatusText } from "./MessageStatus";
import { answeredByIndex } from "./replyAnchors";
import { ANCHOR_HIGHLIGHT_MS } from "./ReplyAnchorViews";
// THE collapsed-text modal — the same component the BUILD-AGENT composer draws (via
// components/composer/AttachmentRow), reused here rather than copied into a transcript-shaped twin (see
// TextPill's header for why there is only one). The concierge's own compose box is NOT on this
// primitive yet, so do not read this import as evidence that surface is already wired — it still
// needs doing (roborev 55746).
import { TextPillModal } from "../composer/TextPillModal";
import { CONCIERGE_THREAD_TESTID } from "../../engine/composeBoxHeight";
import type {
  ConciergeCopyKind,
  ConciergeDigestMessage,
  ConciergeMessage,
  ConciergeNudge,
  ConciergeSparkleMessage,
} from "./types";

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
  wired = false,
  statuses,
  turnFloor,
}: {
  messages: ConciergeMessage[];
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
   *  reasoning behind `shownAsText` being a boolean). Resolved per row, a bubble with no status gets
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
  const onAnswerCopied = useCallback(() => handlers.current.onCopied?.("answer"), []);
  // The user's own bubble reports a DIFFERENT kind, so the live region can say "Message copied"
  // rather than telling him his own words were an answer. Stabilised exactly like the one above —
  // it reaches every memoised row, so an unstable identity here would re-render the whole transcript
  // on every feed tick and bring back the drag-stutter this file's memo exists to kill.
  const onMessageCopied = useCallback(() => handlers.current.onCopied?.("message"), []);
  const nudgeClick = useCallback((n: ConciergeNudge) => handlers.current.onNudgeClick(n), []);
  const nudgeAction = useCallback(
    (n: ConciergeNudge, a: string) => handlers.current.onNudgeAction(n, a),
    [],
  );
  const revealAgent = useCallback((id: string) => handlers.current.onRevealAgent?.(id), []);
  const redirect = useCallback((id: string) => handlers.current.onRedirect?.(id), []);
  const digestClick = useCallback(
    (d: ConciergeDigestMessage) => handlers.current.onDigestClick?.(d),
    [],
  );
  // ── A relayed payload, collapsed (see ConciergeSparkleMessage.collapsed) ──────────────────────
  //
  // Both bits of state are LOCAL and KEYED BY MESSAGE ID, deliberately. Neither is a fact about the
  // conversation: which modal is open and which payload the reader has expanded are properties of
  // this reading session, and the thread is persisted — writing them onto the message would restore
  // a thread tomorrow with a brief already spilled open, which is the flood coming back by the other
  // door. Keyed by id rather than held per-bubble because a bubble is not a component here (the map
  // returns plain JSX), and because the modal is portaled to `document.body` and only ever wants ONE
  // instance on screen.
  /** Which message's payload has its full-text modal open, or null. */
  const [openPayloadId, setOpenPayloadId] = useState<string | null>(null);
  /** Messages whose payload the reader asked to see as regular text, IN PLACE — the founder's
   *  literal ask ("show as regular text" puts it back in the bubble, not in a panel). */
  const [shownAsText, setShownAsText] = useState<ReadonlySet<string>>(() => new Set());
  const openPayload =
    openPayloadId === null
      ? undefined
      : visible.find(
          (m): m is ConciergeSparkleMessage =>
            m.id === openPayloadId && m.kind === "sparkle" && m.collapsed !== undefined,
        );
  /** Open the full-text modal for a payload. Stable, so it does not un-memoise every row. */
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
    const target = Array.from(root.querySelectorAll<HTMLElement>("[data-message-id]")).find(
      (el) => el.dataset.messageId === id,
    );
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
  const totalLength = visible.reduce((n, m) => n + ("text" in m ? m.text.length : 0), 0);
  const contentKey = `${visible.length}:${last?.id ?? ""}:${totalLength}:${typing ? 1 : 0}`;
  // The re-arm key is the newest message the USER sent — never "a user message exists". A thread the
  // user has ever typed in contains a `you` bubble forever, and the host hands this component a fresh
  // array several times a second; a presence test would re-arm on every feed tick and restore bead
  // sparkle-y4ft's "clicking an item scrolls the column" in full.
  const { onScroll } = useAutoFollow({
    contentKey,
    rearmKey: newestUserMessageId(visible),
    scrollRef,
  });

  return (
    // THE POSITIONED ANCESTOR THE TOAST HANGS OFF, and the reason there is a wrapper at all. The
    // confirmation must not shift the layout by a pixel (PRD 1 §1), which rules out a flow element;
    // an absolutely-positioned one needs a positioned ancestor, and it must NOT be the scroller
    // itself or the toast would slide away with the content. This div is a pure box: it takes the
    // `flex: 1` the scroller used to have and hands it straight back, so the column's geometry — and
    // ComposeBox's measurement of it, which finds the thread by testid from the section — is
    // unchanged.
    <div
      style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
    >
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
        {visible.map((m) => (
          // KEYED BY MESSAGE ID, and memoised (./ConciergeMessageRow). Every prop below either is
          // the message itself — stable identity for anything that is not the bubble currently
          // being streamed into — or a callback stabilised above, so a settled entry re-renders
          // exactly never. That inertness is the point: see the row's header for why a transcript
          // that re-diffs itself on every token makes a click-drag selection stutter.
          <ConciergeMessageRow
            key={m.id}
            message={m}
            wired={wired}
            shownAsText={shownAsText.has(m.id)}
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
        ))}
        {/* The pulse, plus what the concierge is actually doing when it is doing something the app
            observed — see ThinkingIndicator. It falls back to exactly the bare "…" this used to be. */}
        <ThinkingIndicator typing={typing} floor={turnFloor ?? Number.POSITIVE_INFINITY} />
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
      {/* The full text behind a collapsed payload: read it, copy it verbatim, or put it back into the
          bubble as regular text. ONE instance for the whole thread — the overlay portals to
          `document.body`, so a per-bubble copy would stack identical dialogs.
          "Show as regular text" EXPANDS IN PLACE and closes the modal; it does not remove the block
          the way the composer's does, because there is nothing here to remove it from — the payload is
          a record of what was sent, and the reader is choosing how to look at it. */}
      {openPayload?.collapsed && (
        <TextPillModal
          block={openPayload.collapsed}
          onClose={() => setOpenPayloadId(null)}
          onShowAsText={() => {
            const id = openPayload.id;
            setShownAsText((prev) => new Set(prev).add(id));
            setOpenPayloadId(null);
          }}
        />
      )}
    </div>
  );
}
