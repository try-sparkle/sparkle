// The long chat thread: right-aligned user bubbles, left plain Sparkle replies (no
// "You"/"Sparkle" labels, no left-side glow — alignment and chrome carry authorship), batch
// dividers, and nudge cards. Auto-follows the newest message.
import { useCallback, useEffect, useRef, useState } from "react";
import { FiCheck } from "react-icons/fi";
import { C } from "../../theme/colors";
import { TYPE } from "../../theme/scale";
import { useCopyOnSelection } from "./useCopyOnSelection";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { ConciergeMessageRow } from "./ConciergeMessageRow";
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

/** How close to the bottom still counts as "following", measured when the READER scrolls.
 *
 *  Small on purpose. The old 150px slack existed because the measurement happened after layout and
 *  had to cover one just-appended message; nothing is unlaid-out at scroll time, so the only slack
 *  needed is for rounding. At 150px a reader who scrolled up a line to re-read it still counted as
 *  "following" and got yanked back on the next feed tick — the founder's original complaint, at
 *  small amplitude. Not smaller than this, though: macOS rubber-band settling and fractional
 *  clientHeight/scrollHeight under non-integral zoom can leave a genuinely-bottomed container a few
 *  px off, and each such miss silently costs the reader the follow. Both sides are tested. */
const FOLLOW_THRESHOLD_PX = 24;

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
}: {
  messages: ConciergeMessage[];
  typing?: boolean;
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
      : messages.find(
          (m): m is ConciergeSparkleMessage =>
            m.id === openPayloadId && m.kind === "sparkle" && m.collapsed !== undefined,
        );
  /** Open the full-text modal for a payload. Stable, so it does not un-memoise every row. */
  const openPayloadFor = useCallback((id: string) => setOpenPayloadId(id), []);
  // Whether the reader is following the bottom. Starts TRUE (a freshly opened thread should be at
  // its newest message) and only changes when the READER scrolls — never as a side effect of new
  // content.
  const followRef = useRef(true);
  /** Last observed scrollTop, so an event that moved nothing can be told from the reader actually
   *  scrolling. -1 is a value no scrollTop can hold, so the first event of a session always counts
   *  as the reader's. */
  const lastTopRef = useRef(-1);
  /** The newest user-sent message id this component has already reacted to. `null` until the first
   *  effect run, so a thread that MOUNTS with the user's last message in it (the persisted thread,
   *  restored at launch) isn't mistaken for a fresh submit. */
  const lastUserMessageIdRef = useRef<string | null>(null);
  /**
   * Is the reader dragging out a selection RIGHT NOW?
   *
   * GUARD 3 on the auto-follow below, and the one that answers the founder's report directly: "when
   * I copy boxes sometimes the part where I started copying loses its initial anchor location."
   *
   * The auto-follow writes `el.scrollTop = el.scrollHeight` on every change of `contentKey`, and
   * `contentKey` includes the thread's total text length — so a streaming reply fires it once per
   * token. Guards 1 and 2 both ask "should we be following?", and while a reply streams in the
   * honest answer is yes. Neither of them asks whether the reader is in the middle of a GESTURE, so
   * a drag started anywhere in the transcript gets the container yanked to the bottom underneath it,
   * several times a second. The browser goes on extending the highlight from where the anchor now
   * sits on screen, which is not where the reader put it — so the selection start visibly moves, and
   * it moves again on the next token. That is the whole bug, and it needs a streaming reply to
   * reproduce, which is exactly the case the founder said to test.
   *
   * Deferred, never cancelled: the follow stays armed, so the next delta after the release catches
   * the thread up. A reader who is selecting is reading, and content arriving during those two
   * seconds is content they did not ask to be scrolled past.
   */
  const selectingRef = useRef(false);
  useEffect(() => {
    // Primary button only — a right-click opens a context menu over a selection rather than starting
    // one.
    //
    // BOTH ends on the DOCUMENT, and symmetrically so. The release must be, because a drag that
    // overshoots the thread (which is how you select through to the end of an answer) lets go
    // somewhere else entirely — container-bound, this flag would latch on and the thread would stop
    // following for the rest of the session. The PRESS must be for the mirror reason: a selection
    // that starts in the compose box and comes up into the transcript is still a selection the
    // auto-follow would scroll out from under. The cost of listening this widely is that an ordinary
    // click anywhere defers the follow for the few milliseconds until its own mouseup, which is not
    // observable.
    const down = (e: MouseEvent) => {
      if (e.button === 0) selectingRef.current = true;
    };
    // CATCH UP ON RELEASE, rather than leaving the deferral to be resolved by the next delta.
    //
    // The guard above only early-returns; nothing re-runs the follow effect on `mouseup`, so a
    // deferred follow waited on a `contentKey` change that may never come. If the LAST delta of a
    // reply lands during the hold, the answer stays below the fold until some future message
    // arrives — and `followRef` still reads `true`, so nothing looks wrong. Widening the press to
    // the document made that reachable from gestures aimed at other surfaces entirely (dragging a
    // column pull tab, a scrollbar, a selection in the terminal), which is what turned it from a
    // trade-off the reader was making deliberately into one made on their behalf.
    //
    // Idempotent by construction: while the follow is armed the thread is already at the bottom, so
    // this is a no-op except in exactly the case it is for — content that arrived during the hold.
    const up = () => {
      if (!selectingRef.current) return;
      selectingRef.current = false;
      const el = scrollRef.current;
      if (!el || !followRef.current) return;
      el.scrollTop = el.scrollHeight;
      // Record the scroll WE caused, for the same reason the effect below does: otherwise the
      // browser's async scroll event can read as the reader moving and silently cost them the follow.
      lastTopRef.current = el.scrollTop;
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("mouseup", up);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("mouseup", up);
    };
  }, []);

  // Auto-follow, but only when the reader is actually at the bottom (bead sparkle-y4ft). This used to
  // be an unconditional `scrollTop = scrollHeight` keyed on [messages, typing], which produced the
  // founder-visible bug: "every time I click on an item, it scrolls me to the bottom of the first
  // column." Two independent causes, so two guards — removing either one leaves the bug reachable.
  //
  // Guard 1, the content key. ConciergeHost builds `messages` as [...chat, ...nudges] inside a useMemo
  // keyed on the concierge feed, so a NEW ARRAY with IDENTICAL CONTENTS arrives on every feed tick —
  // and clicking an item ticks the feed. Keying on array identity meant a click scrolled the column.
  // Key on content instead, so an unchanged thread doesn't re-run this at all.
  //
  // The key includes TOTAL text length because the brain streams: `onConciergeDelta` upserts the
  // same `brain-<id>` bubble with more text, so count and last id both stay put while the reply
  // grows below the fold. Keyed on those alone, the thread stopped following mid-answer.
  //
  // Total, not the LAST message's length: ConciergeHost builds `messages` as [...chat, ...nudges],
  // so the moment any agent is surfaced the growing bubble is no longer last and a per-last-message
  // length tracks a static nudge instead — which is the state the column normally lives in.
  const last = messages.length > 0 ? messages[messages.length - 1]! : undefined;
  const totalLength = messages.reduce((n, m) => n + ("text" in m ? m.text.length : 0), 0);
  const contentKey = `${messages.length}:${last?.id ?? ""}:${totalLength}`;
  const userMessageId = newestUserMessageId(messages);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // THE ONE THING THAT RE-ARMS THE FOLLOW BESIDES REACHING THE BOTTOM: the user's own submit.
    //
    // Everything above is about protecting a reader from content they did not ask for. A message
    // THEY sent is the opposite — it is an unambiguous "show me what happens next" — and until this
    // existed there was nothing that could re-arm the follow except personally scrolling back to the
    // bottom. That is a one-way door in practice, which is the founder's report ("when I submit a
    // chat it doesn't scroll me down to the bottom of the thread"): a trackpad flick that settles
    // 30px short of the bottom is past FOLLOW_THRESHOLD_PX, so the follow dies silently and every
    // later send — including the one they are watching for — lands below the fold.
    //
    // Keyed on a NEW user message id, never on "a user message exists". A thread the user has ever
    // typed in contains a `you` bubble forever, and the host hands this component a fresh array
    // several times a second; a presence test would re-arm on every feed tick and restore bead
    // sparkle-y4ft's "clicking an item scrolls the column" in full.
    //
    // Deliberately NOT a `sending` prop from the host. The bubble IS the send — the host appends it
    // in the same tick the message leaves (`ConciergeHost.send`) — so reading it here keeps the
    // signal in this component's own inputs, with nothing to keep in step and no way for a prop to
    // be left set after a send that failed.
    const previousUserMessageId = lastUserMessageIdRef.current;
    lastUserMessageIdRef.current = userMessageId;
    const userJustSent =
      previousUserMessageId !== null &&
      userMessageId !== "" &&
      userMessageId !== previousUserMessageId;
    if (userJustSent) followRef.current = true;
    // Guard 2, the stick-to-bottom check — READ from the reader's own scrolling, not re-measured
    // here. Measuring after layout got both ends wrong: on mount `scrollTop` is 0 against a full
    // `scrollHeight`, so a thread that opens with any content is judged "scrolled up" and never
    // follows again; and a single tall NudgeCard (badge + text + three buttons) can exceed the
    // slack, so following silently stops the first time one arrives.
    if (!followRef.current) return;
    // Guard 3 — see `selectingRef`. Never scroll out from under a live drag.
    if (selectingRef.current) return;
    el.scrollTop = el.scrollHeight;
    // Record the scroll WE caused, before the browser dispatches its (async) scroll event. Without
    // this, `lastTopRef` still holds the previous bottom, so a reader gesture that happens to land
    // on exactly that value reads as "didn't move" and the demotion is skipped — and the previous
    // bottom is the likeliest such value, since streaming moves the bottom one chunk at a time.
    lastTopRef.current = el.scrollTop;
    // `userMessageId` is in the deps even though a new bubble always moves `contentKey` too: the
    // thread is CAPPED (stores/conciergeThreadStore evicts the oldest bubbles), so a send that
    // evicts one message while adding another can leave the length unchanged, and the re-arm must
    // not depend on the total-length term happening to differ.
  }, [contentKey, typing, userMessageId]);

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
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.clientHeight - el.scrollTop <= FOLLOW_THRESHOLD_PX;
          // A CLAMP — the browser firing `scroll` because the viewport shrank or content was removed
          // — leaves scrollTop exactly where it was while the distance from the bottom grows, and it
          // always comes with a geometry change. Treating that as "the reader scrolled away" would
          // silently stop the follow for something they never did, the same class of bug as measuring
          // after layout. Reaching the bottom re-arms, whatever caused it.
          // ONE test: did this event actually move the scroll position? Every browser re-fit is
          // already covered without a second term, which is why there isn't one —
          //   • viewport shrinks (window resize, panel opens): scrollTop is untouched while the
          //     distance from the bottom grows. `readerMoved` is false, so nothing happens.
          //   • content removed below the fold: the browser clamps scrollTop to the new maximum,
          //     which IS the bottom, so `atBottom` re-arms the follow.
          //   • a scroll event that changed nothing (horizontal scroll on this element, an anchoring
          //     adjustment that nets zero, a synthetic event): `readerMoved` is false.
          // Two earlier attempts added a geometry-based "was this a clamp?" term instead. Both were
          // worse: keyed on any geometry change it swallowed real scroll-aways during streaming
          // growth, and keyed on a shrinking range it depended on a baseline that a resize with no
          // scroll event leaves stale. Neither could be given a test that reached it — every shape
          // they claimed to guard lands on `atBottom` first.
          const readerMoved = el.scrollTop !== lastTopRef.current;
          if (atBottom) followRef.current = true;
          else if (readerMoved) followRef.current = false;
          lastTopRef.current = el.scrollTop;
        }}
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
        {messages.map((m) => (
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
          />
        ))}
        {/* The pulse, plus what the concierge is actually doing when it is doing something the app
            observed — see ThinkingIndicator. It falls back to exactly the bare "…" this used to be. */}
        <ThinkingIndicator typing={typing} />
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
