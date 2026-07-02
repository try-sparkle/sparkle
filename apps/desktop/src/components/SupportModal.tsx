// The in-app support modal (docs/support/SUPPORT-SYSTEM-SPEC.md §7). Opened from the "Support"
// link in the StatusBar. It gives the user two always-available paths to help:
//   1. A docs-aware chat helper — describe the problem, get a warm reply + doc-link chips.
//   2. An ALWAYS-visible "Open a support ticket" button that gathers redacted logs + app metadata
//      + the account email and files a ticket, then hands back a secret link to view/reply.
//
// The goal is that the user feels HELD and cared for: warm copy, an instant reassuring
// confirmation, and a copyable link the moment the ticket exists. All network/log/secret work is
// done in Rust (supportApi.ts → support::* commands); this component is presentation + orchestration.
import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { C, FONT, CHAT_USER_BUBBLE } from "../theme/colors";
import { ModalShell } from "./ModalShell";
import { Markdown } from "./Markdown";
import { getIdentities } from "../services/accountStore";
import { log } from "../logger";
import {
  buildTicketPayload,
  desktopCreateTicket,
  readRecentLogs,
  supportChatSend,
  supportMetadata,
  type CreatedTicket,
  type DocLink,
  type SupportMeta,
} from "../services/supportApi";

// ── Inline Feather icons (no emoji — matches the StatusBar icon style) ────────────────────────────
const ICON = { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

function SendIcon() {
  return (
    <svg {...ICON} aria-hidden>
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}
function LifeBuoyIcon() {
  return (
    <svg {...ICON} aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="4" />
      <line x1="4.93" y1="4.93" x2="9.17" y2="9.17" />
      <line x1="14.83" y1="14.83" x2="19.07" y2="19.07" />
      <line x1="14.83" y1="9.17" x2="19.07" y2="4.93" />
      <line x1="4.93" y1="19.07" x2="9.17" y2="14.83" />
    </svg>
  );
}
function ExternalLinkIcon() {
  return (
    <svg {...ICON} aria-hidden>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}
function CopyIcon() {
  return (
    <svg {...ICON} aria-hidden>
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg {...ICON} aria-hidden>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

/** One rendered chat turn. Assistant turns carry the doc links the helper surfaced. */
interface Turn {
  role: "user" | "assistant";
  content: string;
  docLinks?: DocLink[];
}

const FALLBACK_META: SupportMeta = { appVersion: "", os: "", arch: "" };

export function SupportModal({ onClose }: { onClose: () => void }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  // When the server signals it couldn't fully resolve the issue (or the user asked for a human), it
  // sets offerTicket — we then EMPHASIZE the always-present ticket button (filled, not outlined) to
  // nudge the user toward it, without ever hiding it.
  const [emphasizeTicket, setEmphasizeTicket] = useState(false);

  const [email, setEmail] = useState("");
  const [emailKnown, setEmailKnown] = useState(false);

  const [ticketBusy, setTicketBusy] = useState(false);
  const [ticketError, setTicketError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedTicket | null>(null);
  const [copied, setCopied] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);

  // Prefill the email from the signed-in Claude account identity so most users never have to type
  // it. Falls back to a small input when no identity has an email yet.
  useEffect(() => {
    let alive = true;
    getIdentities()
      .then((ids) => {
        const found = ids.find((i) => i.email)?.email;
        if (alive && found) {
          setEmail(found);
          setEmailKnown(true);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Keep the transcript pinned to the newest message as it grows.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns, chatBusy]);

  const sendChat = async () => {
    const text = input.trim();
    if (!text || chatBusy) return;
    const nextTurns: Turn[] = [...turns, { role: "user", content: text }];
    setTurns(nextTurns);
    setInput("");
    setChatBusy(true);
    setChatError(null);
    try {
      const resp = await supportChatSend(nextTurns.map((t) => ({ role: t.role, content: t.content })));
      setTurns((cur) => [...cur, { role: "assistant", content: resp.reply, docLinks: resp.docLinks }]);
      setEmphasizeTicket(resp.offerTicket);
    } catch (e) {
      log.error("support", "chat send failed", e);
      setChatError("We couldn't reach the assistant just now — you can still open a ticket below and we'll take it from here.");
    } finally {
      setChatBusy(false);
    }
  };

  const openTicket = async () => {
    if (ticketBusy) return;
    const emailTrim = email.trim();
    if (!emailTrim) {
      setTicketError("Add your email so we can reach you, then we'll open your ticket.");
      return;
    }
    setTicketBusy(true);
    setTicketError(null);
    try {
      const [logs, meta] = await Promise.all([
        readRecentLogs().catch(() => ""),
        supportMetadata().catch(() => FALLBACK_META),
      ]);
      const transcript = turns.map((t) => ({ role: t.role, content: t.content }));
      const payload = buildTicketPayload({ email: emailTrim, transcript, logs, meta });
      const ticket = await desktopCreateTicket(payload);
      log.info("support", "ticket created", { id: ticket.id });
      setCreated(ticket);
    } catch (e) {
      log.error("support", "create ticket failed", e);
      setTicketError("Something went wrong opening your ticket. Please try again in a moment — your message is safe.");
    } finally {
      setTicketBusy(false);
    }
  };

  const copyLink = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      log.error("support", "copy link failed", e);
    }
  };

  // ModalShell owns the dimmed backdrop (click = close) + Escape-to-close + centered card (spec §7).
  // The inner column caps its own height so a long transcript scrolls instead of growing the card
  // past the viewport.
  const overlay = (
    <ModalShell width={520} zIndex={200} onCancel={onClose}>
      <div style={{ display: "flex", flexDirection: "column", maxHeight: "80vh" }}>
        {created ? renderSuccess() : renderChat()}
      </div>
    </ModalShell>
  );

  function renderChat() {
    return (
      <>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <span style={{ color: C.accentInk, display: "inline-flex" }}>
            <LifeBuoyIcon />
          </span>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: C.cream }}>How can we help?</h2>
        </div>
        <p style={{ margin: "0 0 14px", fontSize: 13, color: C.muted, lineHeight: 1.5 }}>
          Tell us what's going on and we'll try to help right away. You can open a ticket any time —
          a real person will follow up.
        </p>

        <div
          ref={scrollRef}
          style={{
            flex: "1 1 auto",
            overflowY: "auto",
            minHeight: 120,
            maxHeight: "40vh",
            display: "flex",
            flexDirection: "column",
            gap: 10,
            padding: "2px 2px 6px",
          }}
        >
          {turns.length === 0 && !chatBusy && (
            <p style={{ margin: 0, fontSize: 13, color: C.muted, fontStyle: "italic" }}>
              e.g. "My agent won't start" or "How do I connect my phone?"
            </p>
          )}
          {turns.map((t, i) =>
            t.role === "user" ? (
              <div
                key={i}
                style={{
                  alignSelf: "flex-end",
                  maxWidth: "85%",
                  background: CHAT_USER_BUBBLE,
                  borderRadius: 10,
                  padding: "8px 12px",
                  fontSize: 14,
                  lineHeight: 1.5,
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                }}
              >
                {t.content}
              </div>
            ) : (
              <div key={i} style={{ alignSelf: "flex-start", maxWidth: "92%" }}>
                <div
                  style={{
                    background: C.forest,
                    border: `1px solid ${C.deepForest}`,
                    borderRadius: 10,
                    padding: "8px 12px",
                  }}
                >
                  <Markdown text={t.content} />
                </div>
                {t.docLinks && t.docLinks.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                    {t.docLinks.map((d, j) => (
                      <button
                        key={j}
                        onClick={() => void openUrl(d.href).catch((e) => log.error("support", "open doc failed", e))}
                        title={d.href}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 5,
                          background: "transparent",
                          border: `1px solid ${C.accentInk}`,
                          color: C.accentInk,
                          borderRadius: 4,
                          padding: "3px 10px",
                          fontSize: 12,
                          fontFamily: FONT.ui,
                          cursor: "pointer",
                        }}
                      >
                        <ExternalLinkIcon />
                        {d.title}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ),
          )}
          {chatBusy && (
            <div style={{ alignSelf: "flex-start", fontSize: 13, color: C.muted, fontStyle: "italic" }}>
              Thinking…
            </div>
          )}
        </div>

        {chatError && (
          <p style={{ margin: "8px 0 0", fontSize: 12.5, color: C.muted, lineHeight: 1.5 }}>{chatError}</p>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void sendChat();
              }
            }}
            rows={2}
            placeholder="Describe your problem…"
            style={{
              flex: "1 1 auto",
              resize: "none",
              background: C.forest,
              border: `1px solid ${C.forest}`,
              borderRadius: 8,
              padding: "8px 10px",
              color: C.cream,
              fontSize: 14,
              fontFamily: FONT.ui,
              lineHeight: 1.4,
            }}
          />
          <button
            onClick={() => void sendChat()}
            disabled={!input.trim() || chatBusy}
            title="Send"
            style={{
              alignSelf: "stretch",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              background: C.accentInk,
              color: C.deepForest,
              border: "none",
              borderRadius: 8,
              padding: "0 14px",
              fontSize: 13,
              fontWeight: 600,
              fontFamily: FONT.ui,
              cursor: !input.trim() || chatBusy ? "default" : "pointer",
              opacity: !input.trim() || chatBusy ? 0.5 : 1,
            }}
          >
            <SendIcon />
            Send
          </button>
        </div>

        {/* Always-visible ticket path (spec §7). */}
        <div style={{ borderTop: `1px solid ${C.forest}`, marginTop: 16, paddingTop: 14 }}>
          {!emailKnown && (
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com — where we'll reach you"
              style={{
                width: "100%",
                boxSizing: "border-box",
                marginBottom: 10,
                background: C.forest,
                border: `1px solid ${C.forest}`,
                borderRadius: 8,
                padding: "8px 10px",
                color: C.cream,
                fontSize: 13,
                fontFamily: FONT.ui,
              }}
            />
          )}
          <button
            onClick={() => void openTicket()}
            disabled={ticketBusy}
            style={{
              width: "100%",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              background: emphasizeTicket ? C.accentInk : "transparent",
              border: `1px solid ${C.accentInk}`,
              color: emphasizeTicket ? C.deepForest : C.accentInk,
              borderRadius: 8,
              padding: "9px 14px",
              fontSize: 13.5,
              fontWeight: 600,
              fontFamily: FONT.ui,
              cursor: ticketBusy ? "default" : "pointer",
              opacity: ticketBusy ? 0.6 : 1,
            }}
          >
            <LifeBuoyIcon />
            {ticketBusy ? "Opening your ticket…" : "Open a support ticket"}
          </button>
          {ticketError && (
            <p style={{ margin: "8px 0 0", fontSize: 12.5, color: C.muted, lineHeight: 1.5 }}>{ticketError}</p>
          )}
          <p style={{ margin: "8px 0 0", fontSize: 11.5, color: C.muted, lineHeight: 1.5 }}>
            We'll attach recent app logs (with API keys and tokens removed) so we can help faster.
          </p>
        </div>
      </>
    );
  }

  function renderSuccess() {
    const ticket = created as CreatedTicket;
    return (
      <>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <span style={{ color: C.successInk, display: "inline-flex" }}>
            <CheckIcon />
          </span>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: C.cream }}>We've got it — you're in good hands</h2>
        </div>
        <p style={{ margin: "0 0 16px", fontSize: 13.5, color: C.cream, lineHeight: 1.6 }}>
          Your ticket is open and a real person will follow up by email. Here's your private link to
          view the conversation and reply any time — no sign-in needed. We're on it.
        </p>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: C.forest,
            border: `1px solid ${C.forest}`,
            borderRadius: 8,
            padding: "8px 10px",
            marginBottom: 14,
          }}
        >
          <input
            readOnly
            value={ticket.url}
            onFocus={(e) => e.currentTarget.select()}
            style={{
              flex: "1 1 auto",
              background: "transparent",
              border: "none",
              color: C.cream,
              fontSize: 12.5,
              fontFamily: FONT.ui,
              outline: "none",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          />
          <button
            onClick={() => void copyLink()}
            title="Copy link"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              background: "transparent",
              border: `1px solid ${copied ? C.successInk : C.accentInk}`,
              color: copied ? C.successInk : C.accentInk,
              borderRadius: 6,
              padding: "4px 10px",
              fontSize: 12,
              fontFamily: FONT.ui,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => void openUrl(ticket.url).catch((e) => log.error("support", "open ticket failed", e))}
            style={{
              flex: "1 1 auto",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              background: C.accentInk,
              color: C.deepForest,
              border: "none",
              borderRadius: 8,
              padding: "10px 14px",
              fontSize: 13.5,
              fontWeight: 600,
              fontFamily: FONT.ui,
              cursor: "pointer",
            }}
          >
            <ExternalLinkIcon />
            View your ticket
          </button>
          <button
            onClick={onClose}
            style={{
              flex: "0 0 auto",
              background: "transparent",
              border: `1px solid ${C.forest}`,
              color: C.muted,
              borderRadius: 8,
              padding: "10px 16px",
              fontSize: 13.5,
              fontFamily: FONT.ui,
              cursor: "pointer",
            }}
          >
            Done
          </button>
        </div>
      </>
    );
  }

  return overlay;
}
