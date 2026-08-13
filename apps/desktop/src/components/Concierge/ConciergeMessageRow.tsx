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
// `shownBlockIds` is a STRING, not the thread's `Set`. Passing the set would defeat the whole thing —
// expanding one payload replaces the set, so every row's props would change and every row would
// re-render for a state change that concerns exactly one of them. It is a string rather than the
// boolean it started as because a user message can carry SEVERAL pastes, and one of them being
// expanded says nothing about its siblings.
import { memo } from "react";
import { FiAlertCircle, FiBell } from "react-icons/fi";
// The sent card's INKS are not imported here on purpose — they arrive as `SENT_CARD_INK_VARS`
// below, which is the whole mechanism: the card redefines the ink custom properties on its own
// element so the entire subtree resolves to them. Naming the raw constants here would invite a
// second, hand-applied copy that could drift from the one the subtree actually sees.
import { C, CHAT_USER_BUBBLE, CHAT_SENT_BUBBLE } from "../../theme/colors";
import { RADIUS } from "../../theme/scale";
import { Markdown } from "../Markdown";
import { bandColor } from "../../engine/statusBandLabels";
import { CopyAnswerButton } from "./CopyAnswerButton";
import { MessageStatusLive, type ConciergeMessageStatusText } from "./MessageStatus";
import { NudgeCard } from "./NudgeCard";
import { RecapCard } from "./RecapCard";
import { RoutingReceipt } from "./RoutingReceipt";
import { SentToAgentRow, sentToAgent, SENT_CARD_INK_VARS } from "./SentToAgentRow";
import { LintMark } from "./LintMark";
import { AttachmentStrip } from "../composer/AttachmentStrip";
import { TextPill } from "../composer/TextPill";
import { composeBody, type TextBlock } from "../composer/attachments";
import { blockKey, SHOWN_ID_SEP } from "./collapsedBlocks";
import { splitMentionText, type ConciergeMention } from "./mentions";
import { MentionPill } from "./MentionPill";
// `ReplyAnchorViews`, not `ReplyAnchors` — the RULE module is `replyAnchors.ts`, and on a
// case-insensitive filesystem two modules differing only in case are the same path to the resolver
// (tsc rejects the program outright). The suffix keeps the pair distinguishable everywhere.
import { AnsweredMarker, ReplyAnchorStubs } from "./ReplyAnchorViews";
import { reportClaudeAuthFailed } from "../../services/claudeAuthSignal";
import type {
  ConciergeDigestMessage,
  ConciergeMessage,
  ConciergeNudge,
} from "./types";

export const FAILURE_BUBBLE_TESTID = "concierge-failure";
export const FAILURE_EVIDENCE_TESTID = "concierge-failure-evidence";
/** The in-place re-authentication affordance on an auth-kind failure bubble. */
export const FAILURE_REAUTH_TESTID = "concierge-failure-reauth";
/** Small, low-emphasis affordance: this sits inside an error bubble in a narrow column, so it must
 *  read as a remedy attached to the message rather than compete with the concierge's own controls. */
const reauthButton: React.CSSProperties = {
  marginTop: 8,
  background: "transparent",
  color: C.cream,
  border: `1px solid ${C.sienna}`,
  borderRadius: RADIUS.input,
  padding: "4px 10px",
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
};

/** A collapsed payload the reader chose to see as regular text, expanded IN PLACE in its bubble. */
export const COLLAPSED_TEXT_TESTID = "concierge-collapsed-text";
/** The placeholder standing in for a reply held back by a blocking lint finding. */
export const HELD_REPLY_TESTID = "concierge-held-reply";

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
  /** THIS message's blocks that have been expanded in place, `|`-joined. A primitive, never the
   *  thread's set — see this file's header. `""` when none are, which is almost always. */
  shownBlockIds: string;
  /** Open the full-text modal for one payload, identified by its (message, block) PAIR — see
   *  ./collapsedBlocks' `blockKey`. Not the message: it can carry several pastes. Not the block
   *  either: block ids are not unique across a restart. */
  onOpenPayload: (key: string) => void;
  onNudgeClick: (nudge: ConciergeNudge) => void;
  onNudgeAction: (nudge: ConciergeNudge, actionId: string) => void;
  onRevealAgent?: (agentId: string) => void;
  onRedirect?: (messageId: string) => void;
  onDigestClick?: (digest: ConciergeDigestMessage) => void;
  onAnswerCopied: () => void;
  /** The user's OWN message reached the clipboard. A separate callback from `onAnswerCopied`
   *  rather than one taking a kind, because both must be `useCallback(…, [])`-stable in
   *  ConciergeThread (see its "Handlers, STABILISED" block) and a kind-taking prop invites a call
   *  site to build `() => onCopied("message")` inline, which would un-memoise every row on every
   *  feed tick — the exact regression the memo exists to prevent. */
  onMessageCopied: () => void;
  /** For a `you` message THAT WAS ANSWERED: the id of the reply that answered it (see
   *  ./replyAnchors). Undefined on every other kind and on a message nothing has replied to yet.
   *
   *  A PLAIN STRING, derived by the thread rather than stored on the message, and both halves of that
   *  matter. Derived, so the reply's `answers` array stays the single record and the two directions
   *  cannot disagree. A string rather than the thread's map, for the same reason `shownBlockIds` is a
   *  string and not the thread's `Set`: this row is memoised, and handing it a container that is
   *  rebuilt every tick would re-render the whole transcript for a fact about one message. */
  answeredBy?: string;
  /** For a `you` message: what the concierge is doing about THIS message, already phrased by the
   *  producer (see ./MessageStatus). Undefined on every other kind, and on the overwhelming majority
   *  of `you` bubbles — a settled thread has a status on roughly one of them.
   *
   *  THE RESOLVED ENTRY, never the thread's map and never a `statusFor` callback, for exactly the
   *  reason `shownBlockIds` is a string and `answeredBy` a plain string: this row is memoised, and a
   *  container or a closure rebuilt on every tick would re-render all hundred bubbles for a fact
   *  about one of them — which is the transcript-wide re-diff that makes a click-drag selection
   *  stutter (see this file's header). Resolved by the thread, a bubble with no status is handed
   *  `undefined` on both renders and the memo holds.
   *
   *  THE PHRASE ONLY. The ink is a reading of the liveness clock and is taken inside
   *  `MessageStatusLive`, one level below this row — a tone on this prop would change once a second
   *  for the whole of every turn and re-render the bubble with it (roborev 57889-M2). */
  status?: ConciergeMessageStatusText;
  /** This message was just jumped to — light it briefly so the reader can see where they landed. */
  highlighted?: boolean;
  /** Scroll to the message with this id and light it up. Stable, or the memo above is worthless. */
  onJump?: (id: string) => void;
}

export const ConciergeMessageRow = memo(function ConciergeMessageRow({
  message: m,
  wired,
  shownBlockIds,
  onOpenPayload,
  onNudgeClick,
  onNudgeAction,
  onRevealAgent,
  onRedirect,
  onDigestClick,
  onAnswerCopied,
  onMessageCopied,
  answeredBy,
  status,
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
  /** The blocks this reader has already asked to see as regular text. Rebuilt per render from a
   *  primitive prop — see this file's header for why it is not the thread's own Set. */
  const shown = shownBlockIds ? new Set(shownBlockIds.split(SHOWN_ID_SEP)) : null;
  /**
   * The pills (or the expanded text) for a message's collapsed payloads.
   *
   * ONE COMPONENT FOR BOTH ARMS. The sparkle side draws a brief the concierge relayed; the `you`
   * side draws the founder's own paste. They are the same object rendered the same way on purpose:
   * the parity IS the feature ("I want that same functionality when I'M the one sending big blocks
   * of text"), and two renderers over one `TextBlock` is how the two sides drift a shade apart with
   * nothing failing.
   *
   * ONE ROW per block while collapsed, and `variant="inline"` is what makes that true — the default
   * `tile` is the composer's 46px dashed box, which reads as an empty drop target sitting in running
   * prose. NO `onRemove` on either side: a sent message is a record, and offering to delete half of
   * one implies an edit the app cannot make.
   */
  const collapsedPayload = (blocks: readonly TextBlock[]) => {
    if (blocks.length === 0) return null;
    return (
      <div
        style={{
          marginTop: 4,
          display: "flex",
          flexDirection: "column",
          gap: 4,
          // The `you` bubble is right-aligned prose; without this the pills would stretch to the
          // bubble's full width instead of sitting at their own.
          alignItems: "flex-start",
        }}
      >
        {blocks.map((block) =>
          shown?.has(block.id) ? (
            <div
              key={block.id}
              data-testid={COLLAPSED_TEXT_TESTID}
              style={{
                fontSize: 12,
                color: C.cream,
                // VERBATIM, never through <Markdown> — the same call the failure bubble's evidence
                // makes below, for the same reason: this is the user's own pasted text, where a `_`
                // or a `*` is a character and not a formatting instruction.
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
              }}
            >
              {block.text}
            </div>
          ) : (
            <TextPill
              key={block.id}
              block={block}
              variant="inline"
              // THE PAIR, not the block id — see ./collapsedBlocks' header. Two pastes from
              // different sessions can both be `blk-1`, and opening by block id alone shows the
              // wrong one.
              onOpen={() => onOpenPayload(blockKey(m.id, block.id))}
            />
          ),
        )}
      </div>
    );
  };

  if (m.kind === "nudge")
    return <NudgeCard nudge={m} onNudgeClick={onNudgeClick} onNudgeAction={onNudgeAction} />;
  if (m.kind === "recap") return <RecapCard recap={m} onRevealAgent={onRevealAgent} />;
  if (m.kind === "you") {
    // THE `unanswered` STAMP IS WITHDRAWN ONCE A REPLY NAMES THIS MESSAGE, and this is the seam
    // where the two facts meet.
    //
    // `askSparkle` stamps `unanswered: true` on a bubble the user's NEXT send displaced before a
    // single byte came back — true at that instant. It is not the last word: the concierge usually
    // does answer, a couple of messages later, and when it does the reply records this message in
    // its `answers` (see ./replyAnchors). At that point the receipt's "never answered" is
    // contradicted by the app's own record, and would render directly above an "Answered below"
    // marker pointing at the answer. One bubble, two opposite claims, one of them demonstrably false.
    //
    // WITHDRAWN HERE, NOT IN RoutingReceipt: that component owns the WORDS for a state, and this row
    // owns which state is true. Passing it a corrected receipt needs nothing from it and survives
    // its copy changing — including the deletion of the "never answered" string, after which this
    // becomes a no-op on a field nobody renders.
    //
    // HOISTED OUT OF THE JSX (it used to be an inline ternary on RoutingReceipt's prop) because the
    // corrected receipt now has a SECOND reader: `sentToAgent` below decides whether this bubble is
    // drawn as a sent card. Two readers of one fact must not each re-derive it.
    const receipt =
      m.receipt && answeredBy && m.receipt.unanswered
        ? { ...m.receipt, unanswered: undefined }
        : m.receipt;
    // NON-NULL EXACTLY WHEN THIS MESSAGE REACHED AN AGENT — the black card, and the destination row
    // inside it. See ./SentToAgentRow for which receipts qualify and why a refused one does not.
    const sent = receipt ? sentToAgent(receipt) : null;
    return (
      // `data-message-id` is THE JUMP TARGET (see ConciergeThread's `jumpTo`) — an attribute rather
      // than a ref registry because the thread already owns the scroller and can find its own
      // descendants, and a registry of refs across a memoised list is a leak waiting to happen.
      // Carried by the two kinds an anchor can name, `you` and `sparkle`; nothing else is jumpable.
      <div
        data-message-id={m.id}
        // WHICH SURFACE A SELECTION CAME FROM, declared rather than parsed out of the id's prefix
        // (see useQuoteOnSelection.quoteSourceOf). Only decides the quote chip's caption; the id is
        // what the brain resolves against.
        data-quote-source="you"
        data-highlighted={highlighted ? "yes" : "no"}
        style={{ maxWidth: "92%", alignSelf: "flex-end", textAlign: "right", ...flash }}
      >
        {/* WHAT THIS MESSAGE IS REPLYING TO — the other direction of the same iMessage idiom the
            `sparkle` arm draws below (see ./replyAnchors). Deliberately WITHOUT `onJump`: the
            founder chose attribution the brain can resolve over a clickable back-reference, so this
            takes the stub's existing non-clickable form rather than growing a second one. */}
        <ReplyAnchorStubs anchors={m.quoting ? [m.quoting] : undefined} />
        <div
          data-testid="you-bubble"
          data-wired={wired ? "yes" : "no"}
          // THE MACHINE-READABLE FORM OF THE TREATMENT, so a test can assert "this message is
          // presented as having left the room" without reading colours out of a style attribute —
          // the convention this column already follows (see NudgeCard's `data-resolved`).
          data-sent-to-agent={sent && !wired ? "yes" : "no"}
          style={{
            display: "inline-block",
            // THE TWO LINES THAT KEEP A PASTED URL INSIDE THE COLUMN. `inline-block` is
            // shrink-to-fit, so this bubble sizes itself to its own MIN-CONTENT — and the parent's
            // `maxWidth: 92%` clamps the PARENT, not this. With `overflow-wrap: normal` the
            // min-content of one unbroken token (a run URL, an absolute worktree path, a bead list)
            // is the whole token, so the bubble grew to 569px inside a 359px scroller and pushed
            // 252px of horizontal overflow into the thread — measured, in a rendering engine, with
            // and without the scrollbar rules, so it is not caused by them.
            //
            // The founder saw it as a horizontal scrollbar the moment the vertical one appeared
            // (bead sparkle-nheu8): `overflow-y: auto` with `overflow-x: visible` COMPUTES to
            // `overflow-x: auto`, so the overflow had always been there and had always been
            // scrollable — the overlay bar just never painted to say so.
            //
            // `anywhere`, not `break-word`: only `anywhere` participates in min-content sizing,
            // which is the whole mechanism here. `break-word` wraps the glyphs and leaves the box
            // just as wide, so the bar would stay. `maxWidth: 100%` is the belt to that braces —
            // it caps the box at the parent's 92% for anything that still cannot break (a wide
            // image, a table), turning an escaped child into a clipped one rather than a
            // column-wide scroll.
            maxWidth: "100%",
            overflowWrap: "anywhere",
            textAlign: "left",
            fontSize: 13,
            // THE INK PINNING FOR THE BLACK CARD, spread FIRST so nothing below can be shadowed by
            // it and so the card's own declarations still win. Only when the card is actually drawn:
            // pinning inks on an ordinary blue bubble would break it in light mode, which is the
            // exact failure these vars exist to prevent, pointed the other way.
            ...(sent && !wired ? SENT_CARD_INK_VARS : {}),
            // WIRED: a wash of the terminal's OWN ink over the flood, not `--k-bubble`.
            //
            // The mock writes this as `rgba(255,255,255,.08)`, which is a dark-mode idiom — on
            // light's terminal plane (#d9e3f3) a white wash is very nearly invisible, so copying the
            // literal would give the bubble a fill in one theme and none in the other. A wash of
            // `termInk` is the themed equivalent: it moves AWAY from the plane in both directions, so
            // the bubble reads as a bubble at both ends, and it stays inside the terminal's own
            // register rather than reaching back into the shell's for a colour the flood just
            // replaced.
            //
            // SENT: black, because the message LEFT (founder: *"it would be a black background
            // instead of a blue background when it was sent to an agent"*). See CHAT_SENT_BUBBLE.
            //
            // WIRED WINS OVER SENT, and the order of these branches is the decision. In a mounted
            // column EVERY message goes to that one agent, so the destination is ambient — a black
            // card on every bubble would be a signal that never varies, which is no signal, and it
            // would fight the terminal flood this wash exists to sit inside.
            background: wired
              ? `color-mix(in srgb, currentColor 10%, transparent)`
              : sent
                ? CHAT_SENT_BUBBLE
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
          {/* THE PASTES, AS PILLS — the founder's ask, and the parity that named this work: the
              transcript draws the same pills his compose box drew, instead of the forty rows of
              wall they were collapsed to keep out of the box.

              ABOVE THE WORDS, matching BOTH the composer's own layout (pills sit over the textarea)
              and the wire order (`composeBody` puts every block ahead of what was typed), so the
              bubble reads in the order the message was actually assembled.

              `m.text` IS THE TYPED HALF ONLY once this field is present — see
              ConciergeUserMessage.collapsed. Nothing here is a truncation: the full bytes are in the
              block, one click away, and what reached the agent's terminal never came through this
              branch at all. */}
          {m.collapsed?.length ? (
            <div style={{ marginBottom: 4 }}>{collapsedPayload(m.collapsed)}</div>
          ) : null}
          {/* THE WORDS, WITH THE COPY GLYPH FLOATED INTO THEIR TOP-RIGHT.
              The founder's placement: *"the copy icon should actually be put INSIDE the box,
              because the copy icon should be referencing what I wrote. That's what we're copying
              here."* The button copies `m.text` and nothing else, so it belongs with the words —
              not in the margin beneath them, which is where the annotations about the send live and
              is now where the per-message STATUS goes (./MessageStatus).

              THIS WRAPPER IS NOT DECORATION (roborev 58010-M1). The float must be scoped to the
              TEXT, and my first cut put it at the top of the bubble instead — where it also met
              `AttachmentStrip`, which is a block-level `display: flex` container. A block-level flex
              box establishes its own formatting context, so it does NOT flow around a float: its
              border box gets narrowed by the glyph's width for its full height, squeezing the
              thumbnail strip and pushing thumbnails near the wrap boundary onto an extra row. The
              rationale "the words flow around it" was true of the words and false of the strip.
              Floating inside a text-only wrapper placed AFTER the strip is what makes the rationale
              actually hold — the glyph now meets nothing but the text it belongs to.

              FLOAT, NOT ABSOLUTE POSITIONING. An absolute glyph would sit ON TOP of a message long
              enough to reach it, and the bubble is width-fitted (`inline-block`), so there is no
              reserved gutter for it to live in. A float reserves its own space in the flow.

              THE OLD CONSTRAINTS THAT STILL HOLD:
                • RENDERED ALWAYS, never on hover, so nothing about the entry's height changes when
                  the pointer crosses it (see CopyAnswerButton's header — the thread auto-follows on
                  a content key, and a control that appears on hover nudges the scroll under a reader
                  who is only moving the mouse).
                • None of the bubble's geometry — `display: inline-block`, the 4px corners with the
                  hard tail, `padding: "9px 12px"`, the fill, the deliberate absence of a border — is
                  touched by any of this. */}
          {/* TAGGED FOR THE VISUAL PROBE, which needs to read the paint on the founder's OWN WORDS
              rather than on the card that holds them. scripts/visual/sent-card-shot.mjs measured the
              card element itself while this was untagged, which re-read the card's own `color`
              declaration and reported a healthy 16.99 for text that was actually unreadable. A
              testid here is what makes that reading about the words. */}
          <div data-testid="you-text">
            <span style={{ float: "right", marginLeft: 6, marginRight: -4, marginTop: -2 }}>
              {/* THE WHOLE MESSAGE, not the visible half. `m.text` is only what was typed AROUND
                  the pastes once this bubble carries pills, so copying it would silently hand over
                  a message with its paste missing — the exact substitution the pill's promise is
                  that it never makes. Recomposed through the SHARED `composeBody`, the same
                  function the compose box built the body with, so the clipboard and the wire cannot
                  disagree about what a pill expands to. `verbatimTyped`, because `typed` already
                  arrived trimmed-or-deliberately-not from the box (see that function's doc). */}
              <CopyAnswerButton
                kind="message"
                text={
                  m.collapsed?.length
                    ? composeBody(m.collapsed, m.text, { verbatimTyped: true })
                    : m.text
                }
                onCopied={onMessageCopied}
              />
            </span>
            <MentionedText text={m.text} mentions={m.mentions} />
          </div>
          {/* WHERE THIS MESSAGE WENT — INSIDE the card, which is the founder's ask: *"instead of
              being below where it says send to admin calendar … it would be inside the card."*
              Nothing hangs beneath the bubble for a forwarded message any more.

              LAST CHILD, below the words and the pastes, because it is a fact ABOUT the message
              rather than part of it — the reader takes the message first and the destination second.

              NOT drawn while wired: the sent card is suppressed there (see the background above), so
              its destination row would be a rule and a label floating in a bubble with no card. */}
          {sent && !wired && receipt && <SentToAgentRow receipt={receipt} />}
        </div>
        {/* WHAT THE CONCIERGE IS DOING ABOUT THIS MESSAGE — the founder's ask, in the corner the
            copy glyph just vacated: *"below the box, where the copy icon currently is, it could show
            the status for that specific question."* Renders NOTHING without a status, which is the
            state almost every bubble in a long thread is in (see ./MessageStatus).

            ABOVE THE RECEIPT, because the two say different things in the order they become true:
            this is what is happening NOW, the receipt is the settled record of where the message
            went, and "answered below" after that is what happened next.

            `MessageStatusLive`, not `MessageStatus`: the ink is a clock reading, so the component
            that takes it re-renders at 1 Hz for the whole of a turn. Mounted here it is one leaf on
            one bubble; taken any higher — in the producer, which the host calls — it reconciles the
            entire transcript (roborev 57889-M2). It renders nothing at all without a status, which
            is the state almost every bubble is in. */}
        <MessageStatusLive status={status} />
        {/* THE LINE BELOW THE BUBBLE, FOR EVERY MESSAGE THE CARD DOES NOT SPEAK FOR. It is not
            deleted and its wording is untouched: a REFUSED send ("Not sent — X couldn't take it")
            still says so from here, which is deliberate. The founder chose it when asked — black
            means the message left, so one that bounced must not be able to borrow the treatment, and
            it has no destination to draw a pill for.

            Also still the home for a wired-column send, whose card is suppressed above. */}
        {receipt && !(sent && !wired) && (
          <RoutingReceipt
            // Already corrected for the withdrawn `unanswered` stamp — see where `receipt` is
            // derived at the top of this branch.
            receipt={receipt}
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
  }
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
        data-testid={
          m.variant === "rowless"
            ? "concierge-rowless-digest"
            : m.variant === "unmerged"
              ? "concierge-unmerged-digest"
              : "concierge-digest"
        }
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
            {/* THE REMEDY, AS A CONTROL RATHER THAN A SENTENCE. An expired session cannot be fixed
                by retrying, so the failure has to carry a way out or the user is stuck exactly where
                the founder was: re-sending a request that can never succeed. Publishing to the
                auth signal (rather than opening a modal here) lets ReadinessGate re-probe and raise
                its own blocking sign-in surface — one sign-in surface, one live probe deciding. */}
            {m.canReauth && (
              <button
                type="button"
                data-testid={FAILURE_REAUTH_TESTID}
                onClick={reportClaudeAuthFailed}
                style={reauthButton}
              >
                Sign in to Claude
              </button>
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
        // A push is still the concierge's own words — the same copy affordance applies below, and
        // the same quote one does. Quoting an unprompted line back at it is exactly as meaningful as
        // quoting a reply.
        data-quote-source="sparkle"
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
        {/* ══ AT THE BEGINNING OF THE ROW, NOT THE END (founder, 2026-08-05) ═══════════════════════
            *"For the content that the concierge sends I would rather have it be at the beginning of
            the row instead of top right. I do like it being top right for what I send."*
            The two sides are deliberately DIFFERENT, and that is the point rather than an
            inconsistency: a user bubble is a right-aligned BOX whose corner is its natural control
            slot, while an answer is left-aligned prose with no box — so its leading edge is where the
            eye starts, and a glyph there is found without hunting for it.
            FLOATED, mirroring the user side's `float: right`, and for the same reason: the prose flows
            around it instead of being pushed down a line, and absolute positioning would sit ON the
            text — which jsdom has no layout engine to catch.
            Rendered ALWAYS, never on hover, so the entry's height cannot change under a reader who is
            only moving the mouse (see CopyAnswerButton's header). */}
        <span style={{ float: "left", marginRight: 6, marginLeft: -2, marginTop: -1 }}>
          <CopyAnswerButton text={m.text} onCopied={onAnswerCopied} />
        </span>
        <Markdown text={m.text} mergeQuotes />
        {collapsedPayload(m.collapsed ? [m.collapsed] : [])}
        {/* A push is still an ANSWER — the same words, arrived unasked — so it gets the same copy
            affordance. Copying its markdown source, like the branch below. */}
        {/* …and it is linted like one: a push streams over the same events and reaches the same
            `concierge:done`, so a promise made in an unprompted line is exactly as checkable as one
            made in a reply. Omitting it here would have left a whole channel unmarked. */}
        <LintMark marks={m.lint} />
      </div>
    );
  return (
    <div
      data-message-id={m.id}
      // See the `you` arm: declares the surface a selection was taken from, for the quote chip's
      // caption. This is the branch the founder's request is actually about — the long, dense
      // answers he wants to reply to one claim inside.
      data-quote-source="sparkle"
      data-highlighted={highlighted ? "yes" : "no"}
      style={{ maxWidth: "92%", alignSelf: "flex-start", minWidth: 0, ...flash }}
    >
      {/* WHAT THIS REPLY IS ANSWERING, above its own words — the iMessage idiom, and the reason this
          component exists (see ./replyAnchors). One quoted stub per message it covers, in the order
          they were sent, so a single reply to a burst of five is legible as five answers rather than
          one paragraph nobody can aim at. */}
      <ReplyAnchorStubs anchors={m.answers} onJump={onJump} />
      {/* HELD BY A BLOCKING LINT FINDING — the words are withheld while a correction turn runs.
          The ROW stays (blanking in place is what keeps the reply in its original position; see
          `ConciergeSparkleMessage.held`), so something has to occupy it: an empty bubble reads as a
          turn that produced nothing, which is the one thing the block path must never look like.
          Deliberately says nothing ABOUT the finding — the violating sentence is exactly what must
          not be on screen, and naming the check here would invite reading it as the answer. */}
      {m.held ? (
        <div data-testid={HELD_REPLY_TESTID} style={{ fontSize: 13, color: C.conciergeMuted }}>
          Rewriting this reply…
        </div>
      ) : (
        <>
          {/* ══ AT THE BEGINNING OF THE ROW, NOT THE END (founder, 2026-08-05) ═══════════════════
              *"For the content that the concierge sends I would rather have it be at the beginning
              of the row instead of top right. I do like it being top right for what I send."*
              The two sides are deliberately DIFFERENT, and that is the point rather than an
              inconsistency: a user bubble is a right-aligned BOX whose corner is its natural
              control slot, while an answer is left-aligned prose with no box — so its leading edge
              is where the eye starts, and a glyph there is found without hunting for it.
              FLOATED, mirroring the user side's `float: right`, and for the same reason: the prose
              flows around it instead of being pushed down a line, and absolute positioning would
              sit ON the text — which jsdom has no layout engine to catch.
              Rendered ALWAYS, never on hover, so the entry's height cannot change under a reader
              who is only moving the mouse (see CopyAnswerButton's header).

              INSIDE THE NOT-HELD ARM, which is the merge decision worth recording rather than a
              placement detail. A HELD reply is one whose words are being withheld because a lint
              finding blocked them — so a copy control there would hand the reader, on one click,
              exactly the sentence the block exists to keep off screen. The glyph is absent while
              held and returns with the words. */}
          <span style={{ float: "left", marginRight: 6, marginLeft: -2, marginTop: -1 }}>
            <CopyAnswerButton text={m.text} onCopied={onAnswerCopied} />
          </span>
          <Markdown text={m.text} mergeQuotes />
        </>
      )}
      {/* AFTER the sentence, because it is what the sentence is about — a relayed brief the
          transcript used to echo inline and push the conversation off screen. */}
      {collapsedPayload(m.collapsed ? [m.collapsed] : [])}
      {/* PROSE ONLY — answers here, pushes above, and the user's own bubbles in the `you` branch.
          NOT the nudge, recap, digest or batch cards: those are chrome the app generated about
          state, not words anyone wants in a doc, and the negative assertions in
          ConciergeThread.copy.test are what stops this glyph spreading to every card. Copies
          `m.text`, the markdown SOURCE, so a table stays a table on paste (see CopyAnswerButton). */}
      {/* WHAT THE LINTER CAUGHT IN THIS REPLY (bead sparkle-kr2jz) — one quiet line, or nothing.
          LAST, under the copy glyph, mirroring the `you` arm's order: the words, then the control
          that acts on them, then the annotations ABOUT them (there: the routing receipt and the
          answered marker). It renders unasked, which is the bead's explicit requirement — a finding
          the founder has to go looking for is the invisible counter this replaces. */}
      <LintMark marks={m.lint} />
    </div>
  );
});
