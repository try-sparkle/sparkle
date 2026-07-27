// The long chat thread: right-aligned user bubbles, left plain Sparkle replies (no
// "You"/"Sparkle" labels, no left-side glow — alignment and chrome carry authorship), batch
// dividers, and nudge cards. Auto-follows the newest message.
import { useEffect, useRef } from "react";
import { FiVolume2, FiVolumeX } from "react-icons/fi";
import { C, CHAT_USER_BUBBLE } from "../../theme/colors";
import { NudgeCard } from "./NudgeCard";
import type { ConciergeMessage, ConciergeNudge, ConciergeSparkleMessage } from "./types";

export function ConciergeThread({
  messages,
  typing = false,
  onNudgeClick,
  onNudgeAction,
  onSpeak,
  speakingMessageId = null,
}: {
  messages: ConciergeMessage[];
  typing?: boolean;
  onNudgeClick: (nudge: ConciergeNudge) => void;
  onNudgeAction: (nudge: ConciergeNudge, actionId: string) => void;
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
            </div>
          );
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
        // kind === "sparkle" — plain warm text, no bubble. The speaker sits inline after the
        // text (not floating over it) so it never covers a word, and it is only rendered when the
        // integration layer supplied onSpeak AND the line is a brain REPLY (`speakable`). The
        // host's transactional notices arrive as `sparkle` too — "Sent to X.", "…that didn't
        // send." — and offering to read those aloud was never the intent (roborev 48172).
        const speaking = speakingMessageId === m.id;
        const speakThis = onSpeak && m.text && m.speakable ? onSpeak : null;
        return (
          <div key={m.id} style={{ maxWidth: "92%", alignSelf: "flex-start" }}>
            <div style={{ fontSize: 13.5, lineHeight: 1.5, color: C.cream }}>
              {m.text}
              {speakThis ? (
                <button
                  type="button"
                  onClick={() => speakThis(m)}
                  aria-label={speaking ? "Stop speaking" : "Speak this reply"}
                  aria-pressed={speaking}
                  title={speaking ? "Stop speaking" : "Speak this reply"}
                  style={{
                    marginLeft: 6,
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
