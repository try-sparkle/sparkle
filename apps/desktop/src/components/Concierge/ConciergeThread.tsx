// The long chat thread: right-aligned user bubbles, left plain Sparkle replies (no
// "You"/"Sparkle" labels, no left-side glow — alignment and chrome carry authorship), batch
// dividers, and nudge cards. Auto-follows the newest message.
import { useEffect, useRef } from "react";
import { C, CHAT_USER_BUBBLE } from "../../theme/colors";
import { NudgeCard } from "./NudgeCard";
import type { ConciergeMessage, ConciergeNudge } from "./types";

export function ConciergeThread({
  messages,
  typing = false,
  onNudgeClick,
  onNudgeAction,
}: {
  messages: ConciergeMessage[];
  typing?: boolean;
  onNudgeClick: (nudge: ConciergeNudge) => void;
  onNudgeAction: (nudge: ConciergeNudge, actionId: string) => void;
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
        // kind === "sparkle" — plain warm text, no bubble.
        return (
          <div key={m.id} style={{ maxWidth: "92%", alignSelf: "flex-start" }}>
            <div style={{ fontSize: 13.5, lineHeight: 1.5, color: C.cream }}>{m.text}</div>
          </div>
        );
      })}
      {typing && (
        <div
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
