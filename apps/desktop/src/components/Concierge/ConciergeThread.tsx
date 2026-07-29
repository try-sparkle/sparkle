// The long chat thread: right-aligned user bubbles, left plain Sparkle replies (no
// "You"/"Sparkle" labels, no left-side glow — alignment and chrome carry authorship), batch
// dividers, and nudge cards. Auto-follows the newest message.
import { useEffect, useRef } from "react";
import { FiBell } from "react-icons/fi";
import { C, CHAT_USER_BUBBLE } from "../../theme/colors";
import { Markdown } from "../Markdown";
import { bandColor } from "../../engine/statusBandLabels";
import { NudgeCard } from "./NudgeCard";
import { RecapCard } from "./RecapCard";
import { RoutingReceipt } from "./RoutingReceipt";
import { ThinkingIndicator } from "./ThinkingIndicator";
// The read-only strip a SENT message's files draw as, plus the one lightbox they open. It lives in
// components/composer beside that lightbox rather than here — see its header for why.
import { MessageAttachments } from "../composer/MessageAttachments";
import { CONCIERGE_THREAD_TESTID } from "../../engine/composeBoxHeight";
import { splitMentionText, type ConciergeMention } from "./mentions";
import type { ConciergeDigestMessage, ConciergeMessage, ConciergeNudge } from "./types";

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

/**
 * A user bubble's words, with any agent it ADDRESSED drawn as a pill rather than as raw `@text`.
 *
 * The founder's ask ends here: "if I press enter it shows me the agent as a pill in the chat." The
 * composer cannot draw one — it is a plain `<textarea>`, and it stays one, because the rich
 * placeholder overlay and the measured height engine both depend on that — so the SENT message is
 * where the pill becomes visible, and it is also where it matters most: this bubble is the record
 * of who a message went to.
 *
 * Split against the mentions RECORDED ON THE MESSAGE (see ConciergeUserMessage.mentions), never
 * against the live roster, so a message keeps its pills after its agent is closed.
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
          <span
            key={i}
            data-testid="concierge-mention-pill"
            data-agent-id={part.agentId}
            style={{
              // Tinted, not bordered — the same call the bubble itself makes (see its NO BORDER
              // note): a fill is already a shape, and a hairline around a pill this small at 13px
              // reads as noise. The teal is the attachment chip's tint, which is the established
              // "something rode along with this message" signal in this column.
              background: `color-mix(in srgb, ${C.teal} 18%, transparent)`,
              color: C.cream,
              borderRadius: 4,
              padding: "1px 4px",
              // Keep the address on one line: a pill broken across two lines stops reading as one
              // object, and these are two or three words at most.
              whiteSpace: "nowrap",
            }}
          >
            {part.text}
          </span>
        ),
      )}
    </>
  );
}

export function ConciergeThread({
  messages,
  typing = false,
  onNudgeClick,
  onNudgeAction,
  onRedirect,
  onDigestClick,
}: {
  messages: ConciergeMessage[];
  typing?: boolean;
  onNudgeClick: (nudge: ConciergeNudge) => void;
  onNudgeAction: (nudge: ConciergeNudge, actionId: string) => void;
  /** Redirect the message with this id the other way (see RoutingReceipt). */
  onRedirect?: (messageId: string) => void;
  /** A digest line was clicked: open that project and reveal its lead agent. */
  onDigestClick?: (digest: ConciergeDigestMessage) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
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
        if (m.kind === "recap") return <RecapCard key={m.id} recap={m} />;
        if (m.kind === "you")
          return (
            <div
              key={m.id}
              style={{ maxWidth: "92%", alignSelf: "flex-end", textAlign: "right" }}
            >
              <div
                data-testid="you-bubble"
                style={{
                  display: "inline-block",
                  textAlign: "left",
                  fontSize: 13,
                  background: CHAT_USER_BUBBLE,
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
                <MessageAttachments attachments={m.attachments ?? []} />
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
            </div>
          );
        return (
          <div key={m.id} style={{ maxWidth: "92%", alignSelf: "flex-start" }}>
            <Markdown text={m.text} />
          </div>
        );
      })}
      {/* The pulse, plus what the concierge is actually doing when it is doing something the app
          observed — see ThinkingIndicator. It falls back to exactly the bare "…" this used to be. */}
      <ThinkingIndicator typing={typing} />
    </div>
  );
}
