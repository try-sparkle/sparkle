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
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, typing]);

  return (
    <div
      ref={scrollRef}
      data-testid="concierge-thread"
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
