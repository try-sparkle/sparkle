// ONE transcript entry, and the reason it is a component rather than a branch inside the thread's
// `.map()`: a settled entry must be INERT.
//
// The host hands ConciergeThread a fresh `messages` array several times a second — the memo that
// builds it is keyed on the agent feed, so any agent's status moving, any scoped count changing, and
// every token of a streaming reply produce a new array (see ConciergeHost, bead sparkle-y4ft). While
// every entry was inline JSX, each of those ticks re-created and re-diffed the ENTIRE transcript,
// including the hundred messages that had not changed since they were written.
//
// That cost lands on the main thread at exactly the wrong moment. A click-drag selection across
// several messages is a sequence of `mousemove`s the browser can only extend the highlight from if
// it is free to process them; a transcript-wide re-render on every streaming token competes for that
// time, and the drag stutters. Memoising here makes a settled entry cost nothing per tick, because
// its props are identical: the message objects in the chat half of the stream have STABLE identity
// (conciergeThreadStore upserts in place, so only the bubble actually being streamed into is a new
// object), and every callback below is stabilised by ConciergeThread before it is handed down.
//
// `shownAsText` is a BOOLEAN, not the thread's `Set`. Passing the set would defeat the whole thing —
// expanding one payload replaces the set, so every row's props would change and every row would
// re-render for a state change that concerns exactly one of them.
import { memo } from "react";
import { FiAlertCircle, FiBell } from "react-icons/fi";
import { C, CHAT_USER_BUBBLE } from "../../theme/colors";
import { Markdown } from "../Markdown";
import { bandColor } from "../../engine/statusBandLabels";
import { CopyAnswerButton } from "./CopyAnswerButton";
import { NudgeCard } from "./NudgeCard";
import { RecapCard } from "./RecapCard";
import { RoutingReceipt } from "./RoutingReceipt";
import { AttachmentStrip } from "../composer/AttachmentStrip";
import { TextPill } from "../composer/TextPill";
import { splitMentionText, type ConciergeMention } from "./mentions";
import { MentionPill } from "./MentionPill";
// `ReplyAnchorViews`, not `ReplyAnchors` — the RULE module is `replyAnchors.ts`, and on a
// case-insensitive filesystem two modules differing only in case are the same path to the resolver
// (tsc rejects the program outright). The suffix keeps the pair distinguishable everywhere.
import { AnsweredMarker, ReplyAnchorStubs } from "./ReplyAnchorViews";
import type {
  ConciergeDigestMessage,
  ConciergeMessage,
  ConciergeNudge,
  ConciergeSparkleMessage,
} from "./types";

export const FAILURE_BUBBLE_TESTID = "concierge-failure";
export const FAILURE_EVIDENCE_TESTID = "concierge-failure-evidence";
/** A collapsed payload the reader chose to see as regular text, expanded IN PLACE in its bubble. */
export const COLLAPSED_TEXT_TESTID = "concierge-collapsed-text";

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

export interface ConciergeMessageRowProps {
  message: ConciergeMessage;
  /** The column is PATCHED to a terminal and has taken its colour (see ConciergeThread). */
  wired: boolean;
  /** THIS message's payload has been expanded in place. A boolean, never the thread's set. */
  shownAsText: boolean;
  /** Open the full-text modal for the message with this id. */
  onOpenPayload: (id: string) => void;
  onNudgeClick: (nudge: ConciergeNudge) => void;
  onNudgeAction: (nudge: ConciergeNudge, actionId: string) => void;
  onRevealAgent?: (agentId: string) => void;
  onRedirect?: (messageId: string) => void;
  onDigestClick?: (digest: ConciergeDigestMessage) => void;
  onAnswerCopied: () => void;
  /** For a `you` message THAT WAS ANSWERED: the id of the reply that answered it (see
   *  ./replyAnchors). Undefined on every other kind and on a message nothing has replied to yet.
   *
   *  A PLAIN STRING, derived by the thread rather than stored on the message, and both halves of that
   *  matter. Derived, so the reply's `answers` array stays the single record and the two directions
   *  cannot disagree. A string rather than the thread's map, for the same reason `shownAsText` is a
   *  boolean and not the thread's `Set`: this row is memoised, and handing it a container that is
   *  rebuilt every tick would re-render the whole transcript for a fact about one message. */
  answeredBy?: string;
  /** This message was just jumped to — light it briefly so the reader can see where they landed. */
  highlighted?: boolean;
  /** Scroll to the message with this id and light it up. Stable, or the memo above is worthless. */
  onJump?: (id: string) => void;
}

export const ConciergeMessageRow = memo(function ConciergeMessageRow({
  message: m,
  wired,
  shownAsText,
  onOpenPayload,
  onNudgeClick,
  onNudgeAction,
  onRevealAgent,
  onRedirect,
  onDigestClick,
  onAnswerCopied,
  answeredBy,
  highlighted = false,
  onJump,
}: ConciergeMessageRowProps) {
  /**
   * The "you landed here" flash, and why it is a SHADOW rather than padding or a border.
   *
   * The jump scrolls a message into the middle of the column, where nothing else has changed — so
   * without a flash the reader has to work out which of the bubbles now on screen is the one they
   * asked for. It must cost ZERO layout: this row sits in the thread's flex column, and a highlight
   * that added padding or a border would nudge every message below it at the exact moment the
   * scroller is trying to settle on a position. An outset shadow paints outside the box and shifts
   * nothing.
   */
  const flash = highlighted
    ? {
        borderRadius: 6,
        boxShadow: `0 0 0 3px color-mix(in srgb, ${C.accentInk} 40%, transparent)`,
        transition: "box-shadow 200ms ease",
      }
    : { borderRadius: 6, transition: "box-shadow 400ms ease" };
  /**
   * The pill (or the expanded text) under a sparkle line that carries a payload.
   *
   * ONE ROW while collapsed, and `variant="inline"` is what makes that true — the default `tile` is
   * the composer's 46px dashed box, which reads as an empty drop target sitting in running prose.
   * NO `onRemove`: a posted line is a record, and offering to delete half of one implies an edit the
   * app cannot make.
   */
  const collapsedPayload = (sm: ConciergeSparkleMessage) => {
    const block = sm.collapsed;
    if (!block) return null;
    if (shownAsText)
      return (
        <div
          data-testid={COLLAPSED_TEXT_TESTID}
          style={{
            marginTop: 4,
            fontSize: 12,
            color: C.cream,
            // VERBATIM, never through <Markdown> — the same call the failure bubble's evidence makes
            // below, for the same reason: this is the user's own pasted text, where a `_` or a `*` is
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
        <TextPill block={block} variant="inline" onOpen={() => onOpenPayload(sm.id)} />
      </div>
    );
  };

  if (m.kind === "nudge")
    return <NudgeCard nudge={m} onNudgeClick={onNudgeClick} onNudgeAction={onNudgeAction} />;
  if (m.kind === "recap") return <RecapCard recap={m} onRevealAgent={onRevealAgent} />;
  if (m.kind === "you")
    return (
      // `data-message-id` is THE JUMP TARGET (see ConciergeThread's `jumpTo`) — an attribute rather
      // than a ref registry because the thread already owns the scroller and can find its own
      // descendants, and a registry of refs across a memoised list is a leak waiting to happen.
      // Carried by the two kinds an anchor can name, `you` and `sparkle`; nothing else is jumpable.
      <div
        data-message-id={m.id}
        data-highlighted={highlighted ? "yes" : "no"}
        style={{ maxWidth: "92%", alignSelf: "flex-end", textAlign: "right", ...flash }}
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
            // The mock writes this as `rgba(255,255,255,.08)`, which is a dark-mode idiom — on
            // light's terminal plane (#d9e3f3) a white wash is very nearly invisible, so copying the
            // literal would give the bubble a fill in one theme and none in the other. A wash of
            // `termInk` is the themed equivalent: it moves AWAY from the plane in both directions, so
            // the bubble reads as a bubble at both ends, and it stays inside the terminal's own
            // register rather than reaching back into the shell's for a colour the flood just
            // replaced.
            background: wired
              ? `color-mix(in srgb, currentColor 10%, transparent)`
              : CHAT_USER_BUBBLE,
            // NO BORDER. The bubble already has a FILL, and a fill is a shape — outlining it says the
            // same thing twice and, at a 25% wash of `muted`, said it faintly. The founder called
            // this out directly: the bubble should read as one solid object, not a tinted box inside
            // a hairline.
            //
            // 4px corners with a HARD tail (0), per the spec's `--r-bubble: 4px`. This was 14/14/4/14
            // — a pill. The direction draws boxes rather than filling lozenges, so the bubble is a
            // tight rectangle whose square bottom-right corner points at the column edge.
            borderRadius: "4px 4px 0 4px",
            padding: "9px 12px",
          }}
        >
          {/* ABOVE the words, the way every chat client shows what was sent with them. The text
              still carries the compact count ("look · 1 image"), which is what a restored bubble
              falls back to once its base64 has been stripped. */}
          <AttachmentStrip attachments={m.attachments ?? []} />
          <MentionedText text={m.text} mentions={m.mentions} />
        </div>
        {m.receipt && (
          <RoutingReceipt
            receipt={m.receipt}
            onRedirect={onRedirect ? () => onRedirect(m.id) : undefined}
          />
        )}
        {/* THE HALF THAT ANSWERS THE COMPLAINT. The founder counts unanswered messages by looking at
            his OWN bubbles, not at the reply — so an answered one has to say so from here, and offer
            the jump forward. Below the receipt: "where it went" is a fact about the send, "answered
            below" is what happened next, and they read in that order. */}
        {answeredBy && <AnsweredMarker replyId={answeredBy} onJump={onJump} />}
      </div>
    );
  if (m.kind === "digest") {
    // The digest LINE, not a card. Deliberately quiet chrome — a coloured edge and a count, the
    // width of a sentence — because the whole point is that N items stop occupying N cards' worth of
    // the column (bead sparkle-4562.4). The click hands off to column two.
    //
    // Paint and label BOTH come from the shared band helpers, the same source NudgeCard reads, so a
    // digest line and the cards it stands in for can never speak two vocabularies. It is
    // `bandColor(m.band)` rather than NudgeCard's `nudgeAccent()` because a digest is not necessarily
    // a nudge: the grouping is keyed by band, and a future surfaced band would otherwise be painted
    // in the nudge's sienna regardless of what it means.
    //
    // THE TWO VARIANTS GET TWO TEST IDS, deliberately. A "rows" line's number is a promise that its
    // click leaves exactly that many rows standing in column two, and the guards for that invariant
    // read the DOM by this id (ConciergeHost.digestFilter.test.tsx). A "rowless" line stands for
    // agents that have no row at all, so folding it under the same id would hand those guards a
    // number they would then check against rows — and the honest answer would look like a
    // regression. Same chrome, same band vocabulary, different promise.
    const tint = bandColor(m.band);
    return (
      <button
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
  // The evidence is rendered as PLAIN TEXT, never through <Markdown>. It is a verbatim machine
  // string — a stderr dump full of `_` and `*` is not a formatting instruction, and running it
  // through a renderer would silently eat the characters that make it readable. That is the whole
  // contract: whatever the concierge said, the user sees.
  if (m.kind === "failure")
    return (
      <div data-testid={FAILURE_BUBBLE_TESTID} style={{ maxWidth: "92%", alignSelf: "flex-start" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
          <FiAlertCircle size={12} aria-hidden style={{ flexShrink: 0, marginTop: 4, color: C.sienna }} />
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
  // The brain's persona tells it to answer in GitHub-flavored markdown, and this used to print the
  // raw string — so every reply arrived as a wall of "**bold**" and "- " bullets run together on one
  // line. Reuses the app's shared renderer (components/Markdown), which already owns the GFM styling
  // and the link/image scheme allow-lists, rather than growing a second one here.
  //
  // A PUSH IS NOT A REPLY, and it has to look like it isn't (services/conciergeProactive, PRD §2a).
  // Two things a plain sparkle bubble cannot say:
  //
  //   • WHO STARTED THIS. Every other left-aligned line in the thread answers something the user
  //     said. A push doesn't, and a paragraph that appears with no question above it reads as the app
  //     having lost track of the conversation unless it is labelled.
  //   • WHETHER IT IS STILL TRUE. A thread entry is append-only, so "3 need you" keeps asserting a
  //     resolved count forever. `markStaleProactive` decides that from the digest the push was
  //     authored against; this is where the decision becomes visible. Dimmed and relabelled rather
  //     than struck through or removed: the founder may well be reading it as it goes stale, and a
  //     line that vanishes mid-read is its own bug.
  if (m.proactive)
    return (
      <div
        data-testid="concierge-push"
        data-message-id={m.id}
        data-highlighted={highlighted ? "yes" : "no"}
        data-stale={m.stale ? "true" : "false"}
        style={{ maxWidth: "92%", alignSelf: "flex-start", opacity: m.stale ? 0.5 : 1, ...flash }}
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
        {/* A push is still an ANSWER — the same words, arrived unasked — so it gets the same copy
            affordance. Copying its markdown source, like the branch below. */}
        <CopyAnswerButton text={m.text} onCopied={onAnswerCopied} />
      </div>
    );
  return (
    <div
      data-message-id={m.id}
      data-highlighted={highlighted ? "yes" : "no"}
      style={{ maxWidth: "92%", alignSelf: "flex-start", minWidth: 0, ...flash }}
    >
      {/* WHAT THIS REPLY IS ANSWERING, above its own words — the iMessage idiom, and the reason this
          component exists (see ./replyAnchors). One quoted stub per message it covers, in the order
          they were sent, so a single reply to a burst of five is legible as five answers rather than
          one paragraph nobody can aim at. */}
      <ReplyAnchorStubs anchors={m.answers} onJump={onJump} />
      <Markdown text={m.text} />
      {/* AFTER the sentence, because it is what the sentence is about — a relayed brief the
          transcript used to echo inline and push the conversation off screen. */}
      {collapsedPayload(m)}
      {/* ANSWERS ONLY. Not the user's own bubbles (they wrote it), and not the nudge, recap, digest
          or batch cards above — those are chrome the app generated about state, not prose anyone
          wants in a doc. Copies `m.text`, the markdown SOURCE, so a table stays a table on paste
          (see CopyAnswerButton). */}
      <CopyAnswerButton text={m.text} onCopied={onAnswerCopied} />
    </div>
  );
});
