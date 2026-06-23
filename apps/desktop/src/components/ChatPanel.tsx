import { C, CHAT_USER_BUBBLE, FONT_WEIGHT } from "@sparkle/ui";
import type { ChatMessage } from "../types";

interface Props {
  messages: ChatMessage[];
  onAction: (action: string) => void;
}

// §10.4 — right rail on macOS. iMessage-style list, plain prose (no markdown).
export function ChatPanel({ messages, onAction }: Props) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          padding: "14px 16px",
          borderBottom: "1px solid #0d140f",
          color: C.cream,
          fontWeight: FONT_WEIGHT.semibold,
        }}
      >
        Chief
      </div>
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        {messages.map((m) => (
          <div
            key={m.id}
            style={{
              alignSelf: m.role === "user" ? "flex-end" : "flex-start",
              maxWidth: "85%",
            }}
          >
            <div
              style={{
                background: m.role === "user" ? CHAT_USER_BUBBLE : C.forest,
                color: C.cream,
                padding: "8px 12px",
                borderRadius: 12,
                fontSize: 14,
              }}
            >
              {m.text}
            </div>
            {m.actions && (
              <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                {m.actions.map((a) => (
                  <button
                    key={a.action}
                    onClick={() => onAction(a.action)}
                    style={{
                      background: a.type === "primary" ? C.teal : "transparent",
                      color: a.type === "destructive" ? C.sienna : C.cream,
                      border:
                        a.type === "primary" ? "none" : `1px solid ${C.muted}`,
                      borderRadius: 6,
                      padding: "4px 10px",
                      fontSize: 12,
                      cursor: "pointer",
                    }}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
