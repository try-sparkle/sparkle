// The long chat thread: right-aligned user bubbles, left plain Sparkle replies (no
// "You"/"Sparkle" labels, no left-side glow — alignment and chrome carry authorship), batch
// dividers, and nudge cards. Auto-follows the newest message.
import { useEffect, useRef } from "react";
import { FiVolume2, FiVolumeX } from "react-icons/fi";
import { C, CHAT_USER_BUBBLE } from "../../theme/colors";
import { Markdown } from "../Markdown";
import { bandColor } from "../../engine/statusBandLabels";
import { NudgeCard } from "./NudgeCard";
import { RoutingReceipt } from "./RoutingReceipt";
import type {
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

export function ConciergeThread({
  messages,
  typing = false,
  onNudgeClick,
  onNudgeAction,
  onRedirect,
  onDigestClick,
  onSpeak,
  speakingMessageId = null,
}: {
  messages: ConciergeMessage[];
  typing?: boolean;
  onNudgeClick: (nudge: ConciergeNudge) => void;
  onNudgeAction: (nudge: ConciergeNudge, actionId: string) => void;
  /** Redirect the message with this id the other way (see RoutingReceipt). */
  onRedirect?: (messageId: string) => void;
  /** A digest line was clicked: open that project and reveal its lead agent. */
  onDigestClick?: (digest: ConciergeDigestMessage) => void;
  /** Speak-on-demand for a Sparkle reply. Absent = no speaker buttons (voice is opt-in). */
  onSpeak?: (message: ConciergeSparkleMessage) => void;
  speakingMessageId?: string | null;
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

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
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
  }, [contentKey, typing]);

  return (
    <div
      ref={scrollRef}
      data-testid="concierge-thread"
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
        if (m.kind === "you")
          return (
            <div
              key={m.id}
              style={{ maxWidth: "92%", alignSelf: "flex-end", textAlign: "right" }}
            >
              <div
                style={{
                  display: "inline-block",
                  textAlign: "left",
                  fontSize: 13,
                  background: CHAT_USER_BUBBLE,
                  border: `1px solid color-mix(in srgb, ${C.muted} 25%, transparent)`,
                  borderRadius: "14px 14px 4px 14px",
                  padding: "9px 12px",
                }}
              >
                {m.text}
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
          const tint = bandColor(m.band);
          return (
            <button
              key={m.id}
              type="button"
              data-testid="concierge-digest"
              data-band={m.band}
              onClick={() => onDigestClick?.(m)}
              style={{
                alignSelf: "stretch",
                textAlign: "left",
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 12.5,
                fontFamily: "inherit",
                color: C.cream,
                background: `color-mix(in srgb, ${tint} 8%, transparent)`,
                border: `1px solid color-mix(in srgb, ${tint} 30%, transparent)`,
                borderLeft: `3px solid ${tint}`,
                borderRadius: 10,
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
                fontSize: 11.5,
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
        // kind === "sparkle" — no bubble, RENDERED MARKDOWN, with the speaker button after it.
        //
        // The brain's persona tells it to answer in GitHub-flavored markdown, and this used to
        // print the raw string — so every reply arrived as a wall of "**bold**" and "- " bullets
        // run together on one line. Reuses the app's shared renderer (components/Markdown), which
        // already owns the GFM styling and the link/image scheme allow-lists, rather than growing
        // a second one here.
        //
        // The speaker is only rendered when the integration layer supplied onSpeak AND the line is
        // a brain REPLY (`speakable`). The host's transactional notices arrive as `sparkle` too —
        // "Sent to X.", "…that didn't send." — and offering to read those aloud was never the
        // intent (roborev 48172). It sits AFTER the markdown block rather than inline inside it:
        // Markdown emits block-level children, so an inline button spliced into that flow would be
        // pushed onto its own line by the last paragraph anyway.
        const speaking = speakingMessageId === m.id;
        const speakThis = onSpeak && m.text && m.speakable ? onSpeak : null;
        return (
          <div key={m.id} style={{ maxWidth: "92%", alignSelf: "flex-start" }}>
            <Markdown text={m.text} />
            {speakThis ? (
              <button
                type="button"
                onClick={() => speakThis(m)}
                aria-label={speaking ? "Stop speaking" : "Speak this reply"}
                aria-pressed={speaking}
                title={speaking ? "Stop speaking" : "Speak this reply"}
                style={{
                  marginLeft: 2,
                  verticalAlign: "middle",
                  background: "transparent",
                  border: "none",
                  padding: 2,
                  cursor: "pointer",
                  color: speaking ? C.amber : C.muted,
                  lineHeight: 0,
                }}
              >
                {speaking ? <FiVolumeX size={13} aria-hidden /> : <FiVolume2 size={13} aria-hidden />}
              </button>
            ) : null}
          </div>
        );
      })}
      {typing && (
        <div
          aria-hidden
          aria-label="Sparkle is typing"
          style={{ alignSelf: "flex-start", fontSize: 13.5, color: C.conciergeMuted }}
        >
          {/* index.css's existing "working on it" opacity breathe — no motion, reduced-motion safe. */}
          <span className="sparkle-pulse">…</span>
        </div>
      )}
    </div>
  );
}
