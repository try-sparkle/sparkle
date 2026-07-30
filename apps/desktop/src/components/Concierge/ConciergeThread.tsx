// The long chat thread: right-aligned user bubbles, left plain Sparkle replies (no
// "You"/"Sparkle" labels, no left-side glow — alignment and chrome carry authorship), batch
// dividers, and nudge cards. Auto-follows the newest message.
import { useCallback, useEffect, useRef, useState } from "react";
import { FiAlertCircle, FiBell, FiCheck } from "react-icons/fi";
import { C, CHAT_USER_BUBBLE } from "../../theme/colors";
import { TYPE } from "../../theme/scale";
import { Markdown } from "../Markdown";
import { bandColor } from "../../engine/statusBandLabels";
import { CopyAnswerButton } from "./CopyAnswerButton";
import { useCopyOnSelection } from "./useCopyOnSelection";
import { NudgeCard } from "./NudgeCard";
import { RecapCard } from "./RecapCard";
import { RoutingReceipt } from "./RoutingReceipt";
import { ThinkingIndicator } from "./ThinkingIndicator";
// The strip a SENT message's files draw as, plus the one lightbox they open. It lives in
// components/composer beside that lightbox rather than here — see its header for why.
// SHARED WITH THE DRAFT: the concierge compose box renders this same component, passing `onRemove`.
// Omitting it here is what makes this copy read-only — a sent message has nothing to take back.
import { AttachmentStrip } from "../composer/AttachmentStrip";
// THE collapsed-text pill and its modal — the same components the BUILD-AGENT composer draws (via
// components/composer/AttachmentRow), reused here rather than copied into a transcript-shaped twin (see
// TextPill's header for why there is only one). As of this change those are the only two callers: the
// concierge's own compose box is NOT on this primitive yet, so do not read these imports as evidence
// that surface is already wired — it still needs doing (roborev 55746).
import { TextPill } from "../composer/TextPill";
import { TextPillModal } from "../composer/TextPillModal";
import { CONCIERGE_THREAD_TESTID } from "../../engine/composeBoxHeight";
import { splitMentionText, type ConciergeMention } from "./mentions";
import { MentionPill } from "./MentionPill";
import type {
  ConciergeCopyKind,
  ConciergeDigestMessage,
  ConciergeMessage,
  ConciergeNudge,
  ConciergeSparkleMessage,
} from "./types";

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

export const FAILURE_BUBBLE_TESTID = "concierge-failure";
export const FAILURE_EVIDENCE_TESTID = "concierge-failure-evidence";
/** A collapsed payload the reader chose to see as regular text, expanded IN PLACE in its bubble. */
export const COLLAPSED_TEXT_TESTID = "concierge-collapsed-text";

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

/**
 * A user bubble's words, with any agent it ADDRESSED drawn as a pill rather than as raw `@text`.
 *
 * THIS IS NO LONGER THE FIRST PLACE THE PILL APPEARS, and the correction matters because the old
 * note here was load-bearing prose. It read: "the composer cannot draw one — it is a plain
 * `<textarea>`, and it stays one … so the SENT message is where the pill becomes visible." The
 * premise was right and the conclusion was wrong, and the founder reported the gap: a completed
 * `@Kraken Auth` sat in the compose box as plain text and only became a pill after Send.
 *
 * The textarea IS still a plain textarea (the rich placeholder overlay and the measured height
 * engine both depend on that, and neither moved). What changed is that the composer paints its
 * pills BEHIND it — see ./MentionMirror. So the pill is now visible from the moment the mention is
 * completed, and this bubble is where it becomes a RECORD rather than where it is first seen.
 *
 * Split against the mentions RECORDED ON THE MESSAGE (see ConciergeUserMessage.mentions), never
 * against the live roster, so a message keeps its pills after its agent is closed. That is the one
 * place this surface deliberately differs from the composer's: there, the roster is live, because a
 * draft's aim must track the fleet it will actually be delivered to.
 *
 * Plain text renders exactly as it did before — one string, no wrapper — so a thread of ordinary
 * messages is untouched by this and its whitespace behaviour cannot drift.
 */
function MentionedText({ text, mentions }: { text: string; mentions?: ConciergeMention[] }) {
  if (!mentions?.length) return <>{text}</>;
  return (
    <>
      {splitMentionText(text, mentions).map((part, i) =>
        part.kind === "text" ? (
          // The index IS the identity here: these parts are positional slices of one immutable
          // string on a message that never re-renders with different content.
          <span key={i}>{part.text}</span>
        ) : (
          // The SHARED pill (./MentionPill) — the same component the composer paints behind its
          // textarea. It used to be six style properties inlined here, which is how the sent pill
          // and the composer pill would have drifted a shade apart with nothing failing.
          <MentionPill key={i} agentId={part.agentId}>
            {part.text}
          </MentionPill>
        ),
      )}
    </>
  );
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
  const onAnswerCopied = useCallback(() => onCopied?.("answer"), [onCopied]);
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
  /**
   * The pill (or the expanded text) under a sparkle line that carries a payload.
   *
   * ONE ROW while collapsed, and `variant="inline"` is what makes that true — the default `tile` is
   * the composer's 46px dashed box, which reads as an empty drop target sitting in running prose.
   * NO `onRemove`: a posted line is a record, and offering to delete half of one implies an edit the
   * app cannot make.
   */
  const collapsedPayload = (m: ConciergeSparkleMessage) => {
    const block = m.collapsed;
    if (!block) return null;
    if (shownAsText.has(m.id))
      return (
        <div
          data-testid={COLLAPSED_TEXT_TESTID}
          style={{
            marginTop: 4,
            fontSize: 12,
            color: C.cream,
            // VERBATIM, never through <Markdown> — the same call the failure bubble's evidence makes
            // above, for the same reason: this is the user's own pasted text, where a `_` or a `*` is
            // a character and not a formatting instruction.
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          {block.text}
        </div>
      );
    return (
      <div style={{ marginTop: 4 }}>
        <TextPill block={block} variant="inline" onOpen={() => setOpenPayloadId(m.id)} />
      </div>
    );
  };
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
        {messages.map((m) => {
          if (m.kind === "nudge")
            return (
              <NudgeCard
                key={m.id}
                nudge={m}
                onNudgeClick={onNudgeClick}
                onNudgeAction={onNudgeAction}
              />
            );
          if (m.kind === "recap")
            return <RecapCard key={m.id} recap={m} onRevealAgent={onRevealAgent} />;
          if (m.kind === "you")
            return (
              <div
                key={m.id}
                style={{ maxWidth: "92%", alignSelf: "flex-end", textAlign: "right" }}
              >
                <div
                  data-testid="you-bubble"
                  data-wired={wired ? "yes" : "no"}
                  style={{
                    display: "inline-block",
                    textAlign: "left",
                    fontSize: 13,
                    // WIRED: a wash of the terminal's OWN ink over the flood, not `--k-bubble`.
                    //
                    // The mock writes this as `rgba(255,255,255,.08)`, which is a dark-mode idiom —
                    // on light's terminal plane (#d9e3f3) a white wash is very nearly invisible, so
                    // copying the literal would give the bubble a fill in one theme and none in the
                    // other. A wash of `termInk` is the themed equivalent: it moves AWAY from the
                    // plane in both directions, so the bubble reads as a bubble at both ends, and it
                    // stays inside the terminal's own register rather than reaching back into the
                    // shell's for a colour the flood just replaced.
                    background: wired
                      ? `color-mix(in srgb, currentColor 10%, transparent)`
                      : CHAT_USER_BUBBLE,
                    // NO BORDER. The bubble already has a FILL, and a fill is a shape — outlining it
                    // says the same thing twice and, at a 25% wash of `muted`, said it faintly. The
                    // founder called this out directly: the bubble should read as one solid object,
                    // not a tinted box inside a hairline.
                    //
                    // The tail corner is what identifies it as YOURS (14/14/4/14 — square-ish into
                    // the bottom-right, where the column's own edge is), which is the same
                    // shape-not-hue reasoning the status dots and the palette badges use.
                    // 4px corners with a HARD tail (0), per the spec's `--r-bubble: 4px`. This was 14/14/4/14 — a
                    // pill. The direction draws boxes rather than filling lozenges, so the bubble is a
                    // tight rectangle whose square bottom-right corner points at the column edge.
                    borderRadius: "4px 4px 0 4px",
                    padding: "9px 12px",
                  }}
                >
                  {/* ABOVE the words, the way every chat client shows what was sent with them. The
                      text still carries the compact count ("look · 1 image"), which is what a
                      restored bubble falls back to once its base64 has been stripped. */}
                  <AttachmentStrip attachments={m.attachments ?? []} />
                  <MentionedText text={m.text} mentions={m.mentions} />
                </div>
                {m.receipt && (
                  <RoutingReceipt
                    receipt={m.receipt}
                    onRedirect={onRedirect ? () => onRedirect(m.id) : undefined}
                  />
                )}
              </div>
            );
          if (m.kind === "digest") {
            // The digest LINE, not a card. Deliberately quiet chrome — a coloured edge and a count,
            // the width of a sentence — because the whole point is that N items stop occupying N
            // cards' worth of the column (bead sparkle-4562.4). The click hands off to column two.
            //
            // Paint and label BOTH come from the shared band helpers, the same source NudgeCard reads,
            // so a digest line and the cards it stands in for can never speak two vocabularies. It is
            // `bandColor(m.band)` rather than NudgeCard's `nudgeAccent()` because a digest is not
            // necessarily a nudge: the grouping is keyed by band, and a future surfaced band would
            // otherwise be painted in the nudge's sienna regardless of what it means.
            //
            // THE TWO VARIANTS GET TWO TEST IDS, deliberately. A "rows" line's number is a promise
            // that its click leaves exactly that many rows standing in column two, and the guards for
            // that invariant read the DOM by this id (ConciergeHost.digestFilter.test.tsx). A
            // "rowless" line stands for agents that have no row at all, so folding it under the same
            // id would hand those guards a number they would then check against rows — and the
            // honest answer would look like a regression. Same chrome, same band vocabulary,
            // different promise.
            const tint = bandColor(m.band);
            return (
              <button
                key={m.id}
                type="button"
                data-testid={m.variant === "rowless" ? "concierge-rowless-digest" : "concierge-digest"}
                data-band={m.band}
                onClick={() => onDigestClick?.(m)}
                style={{
                  alignSelf: "stretch",
                  textAlign: "left",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 12,
                  fontFamily: "inherit",
                  color: C.cream,
                  background: `color-mix(in srgb, ${tint} 8%, transparent)`,
                  border: `1px solid color-mix(in srgb, ${tint} 30%, transparent)`,
                  borderLeft: `3px solid ${tint}`,
                  borderRadius: 6,
                  padding: "7px 10px",
                  cursor: "pointer",
                }}
              >
                {m.text}
              </button>
            );
          }
          if (m.kind === "batch")
            return (
              <div
                key={m.id}
                style={{
                  alignSelf: "stretch",
                  fontSize: 12,
                  color: C.conciergeMuted,
                  textAlign: "center",
                  padding: "6px 0",
                  borderTop: `1px dashed color-mix(in srgb, ${C.muted} 30%, transparent)`,
                  borderBottom: `1px dashed color-mix(in srgb, ${C.muted} 30%, transparent)`,
                }}
              >
                {m.text}
              </div>
            );
          // A TURN THAT FAILED, with the concierge's own words attached (engine/conciergeFailureNotice).
          //
          // The evidence is rendered as PLAIN TEXT, never through <Markdown>. It is a verbatim
          // machine string — a stderr dump full of `_` and `*` is not a formatting instruction, and
          // running it through a renderer would silently eat the characters that make it readable.
          // That is the whole contract: whatever the concierge said, the user sees.
          if (m.kind === "failure")
            return (
              <div
                key={m.id}
                data-testid={FAILURE_BUBBLE_TESTID}
                style={{ maxWidth: "92%", alignSelf: "flex-start" }}
              >
                <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
                  <FiAlertCircle
                    size={12}
                    aria-hidden
                    style={{ flexShrink: 0, marginTop: 4, color: C.sienna }}
                  />
                  <div style={{ minWidth: 0 }}>
                    <div>{m.headline}</div>
                    {m.evidence && (
                      <p
                        data-testid={FAILURE_EVIDENCE_TESTID}
                        style={{
                          margin: "4px 0 0",
                          color: C.conciergeMuted,
                          fontSize: 12,
                          whiteSpace: "pre-wrap",
                          overflowWrap: "anywhere",
                        }}
                      >
                        {m.evidence}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            );
          // kind === "sparkle" — no bubble, RENDERED MARKDOWN.
          //
          // The brain's persona tells it to answer in GitHub-flavored markdown, and this used to
          // print the raw string — so every reply arrived as a wall of "**bold**" and "- " bullets
          // run together on one line. Reuses the app's shared renderer (components/Markdown), which
          // already owns the GFM styling and the link/image scheme allow-lists, rather than growing
          // a second one here.
          //
          // A PUSH IS NOT A REPLY, and it has to look like it isn't (services/conciergeProactive,
          // PRD §2a). Two things a plain sparkle bubble cannot say:
          //
          //   • WHO STARTED THIS. Every other left-aligned line in the thread answers something the
          //     user said. A push doesn't, and a paragraph that appears with no question above it
          //     reads as the app having lost track of the conversation unless it is labelled.
          //   • WHETHER IT IS STILL TRUE. A thread entry is append-only, so "3 need you" keeps
          //     asserting a resolved count forever. `markStaleProactive` decides that from the digest
          //     the push was authored against; this is where the decision becomes visible. Dimmed and
          //     relabelled rather than struck through or removed: the founder may well be reading it
          //     as it goes stale, and a line that vanishes mid-read is its own bug.
          if (m.proactive)
            return (
              <div
                key={m.id}
                data-testid="concierge-push"
                data-stale={m.stale ? "true" : "false"}
                style={{ maxWidth: "92%", alignSelf: "flex-start", opacity: m.stale ? 0.5 : 1 }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    fontSize: 12,
                    color: C.conciergeMuted,
                    marginBottom: 3,
                  }}
                >
                  <FiBell size={11} aria-hidden />
                  <span>{m.stale ? "Sparkle noticed — no longer current" : "Sparkle noticed"}</span>
                </div>
                <Markdown text={m.text} />
                {collapsedPayload(m)}
                {/* A push is still an ANSWER — the same words, arrived unasked — so it gets the same
                    copy affordance. Copying its markdown source, like the branch below. */}
                <CopyAnswerButton text={m.text} onCopied={onAnswerCopied} />
              </div>
            );
          return (
            <div key={m.id} style={{ maxWidth: "92%", alignSelf: "flex-start" }}>
              <Markdown text={m.text} />
              {/* AFTER the sentence, because it is what the sentence is about — a relayed brief the
                  transcript used to echo inline and push the conversation off screen. */}
              {collapsedPayload(m)}
              {/* ANSWERS ONLY. Not the user's own bubbles (they wrote it), and not the nudge, recap,
                  digest or batch cards above — those are chrome the app generated about state, not
                  prose anyone wants in a doc. Copies `m.text`, the markdown SOURCE, so a table stays
                  a table on paste (see CopyAnswerButton). */}
              <CopyAnswerButton text={m.text} onCopied={onAnswerCopied} />
            </div>
          );
        })}
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
