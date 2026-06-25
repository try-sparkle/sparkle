import { useEffect, useRef, useState } from "react";
import { C, FONT_WEIGHT } from "../theme/colors";
import type { Project } from "../types";
import { useSettingsStore, effectiveChiefPat } from "../stores/settingsStore";
import { useHandoffStore } from "../stores/handoffStore";
import {
  ensureChiefProject,
  startChat,
  sendMessage,
  pollForResponse,
  ChiefError,
} from "../services/chief";
import { registerBrainstorm } from "../services/brainstormBridge";

interface ChatMsg {
  role: "user" | "assistant";
  text: string;
}

/**
 * The Brainstorm agent's surface: a chat with Chief (Storytell) scoped to a project whose
 * library mirrors this Sparkle project. On first use we auto-create/link a Chief project named
 * after the Sparkle project, then every turn chats over that project's content. No worktree,
 * no PTY — this is a knowledge conversation, not a build agent. (Epic , phase .)
 */
export function BrainstormPanel({ project, agentId }: { project: Project; agentId: string }) {
  const chiefPatStored = useSettingsStore((s) => s.chiefPat);
  const runtimeChiefPat = useSettingsStore((s) => s.runtimeChiefPat);
  const setChiefPat = useSettingsStore((s) => s.setChiefPat);
  const chiefProjectByProject = useSettingsStore((s) => s.chiefProjectByProject);
  const setChiefProject = useSettingsStore((s) => s.setChiefProject);

  // Subscribing to runtimeChiefPat above means this re-renders (and drops the connect screen)
  // once the env-resolved PAT lands from the Rust backend at startup.
  const pat = effectiveChiefPat(chiefPatStored, runtimeChiefPat);
  const chiefProjectId = chiefProjectByProject[project.id];

  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [linking, setLinking] = useState(false);
  const handoff = useHandoffStore((s) => s.pending);
  const clearHandoff = useHandoffStore((s) => s.clear);

  const chatIdRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Attempt the auto-link at most ONCE per (project, pat) pair. Without this, a failed link
  // (Chief outage / bad PAT) would re-fire the effect via setLinking(false) and retry forever,
  // hammering the API. The key changes only when the user connects a new PAT or switches project,
  // which is exactly when a fresh attempt is wanted.
  const linkAttemptKey = useRef<string | null>(null);

  // Link (or create) the Chief project for this Sparkle project once a PAT is available.
  useEffect(() => {
    if (!pat || chiefProjectId) return;
    const key = `${project.id}|${pat}`;
    if (linkAttemptKey.current === key) return; // already tried (succeeded or failed)
    linkAttemptKey.current = key;
    let cancelled = false;
    setLinking(true);
    void ensureChiefProject(pat, project.name, undefined)
      .then((id) => {
        if (!cancelled) setChiefProject(project.id, id);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLinking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pat, chiefProjectId, project.id, project.name, setChiefProject]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, sending]);

  // Core send, given an explicit prompt. Used by the composer (the typed message) and by the
  // connectivity re-query (a "status update" nudge delivered through the brainstorm bridge).
  const sendText = async (prompt: string) => {
    if (!prompt || sending) return;
    if (!pat) {
      setError("Connect Chief first.");
      return;
    }
    setError("");
    setMessages((m) => [...m, { role: "user", text: prompt }]);
    setSending(true);
    try {
      const pid = chiefProjectId ?? (await ensureChiefProject(pat, project.name, undefined));
      if (!chiefProjectId) setChiefProject(project.id, pid);

      let messageId: string;
      if (chatIdRef.current) {
        messageId = (await sendMessage(pat, pid, chatIdRef.current, prompt)).message_id;
      } else {
        const started = await startChat(pat, pid, prompt);
        chatIdRef.current = started.chat_id;
        messageId = started.message_id;
      }
      const text = await pollForResponse(pat, pid, chatIdRef.current!, messageId);
      setMessages((m) => [...m, { role: "assistant", text }]);
    } catch (e) {
      const msg =
        e instanceof ChiefError
          ? e.message
          : e instanceof Error
            ? e.message
            : String(e);
      setError(msg);
    } finally {
      setSending(false);
    }
  };

  // The composer's send: take the typed input, clear it, and dispatch.
  const send = () => {
    const prompt = input.trim();
    if (!prompt || sending) return; // don't clear the box if a turn is already in flight
    setInput("");
    void sendText(prompt);
  };

  // Register this panel so the connectivity re-query can deliver its "status update" nudge here.
  // We keep the latest sendText in a ref (it closes over state that changes each render) and
  // register a stable wrapper once per agent. The nudge only fires for an already-active
  // conversation — there's nothing to "update" on a chat that never started.
  const sendTextRef = useRef(sendText);
  sendTextRef.current = sendText;
  useEffect(() => {
    return registerBrainstorm(agentId, (text) => {
      if (!chatIdRef.current) return; // no conversation yet — skip
      void sendTextRef.current(text);
    });
  }, [agentId]);

  // A terminal-selection action queued a prompt for this project's brainstorm agent. Prefill it
  // (and auto-send for Explain/Ask). Runs once per queued handoff, then clears it.
  // Guard on `pat`: if Chief is not yet connected the composer isn't mounted, so deferring keeps
  // the handoff alive until the user connects and the next render re-runs this effect.
  useEffect(() => {
    if (!handoff || handoff.projectId !== project.id || !pat) return;
    const { text, autoSend } = handoff;
    clearHandoff();
    if (autoSend) {
      void sendText(text);
    } else {
      setInput(text);
      inputRef.current?.focus();
    }
    // `sendText` is stable enough for this one-shot; the deps are the intentional gates
    // (handoff to consume, project.id to scope it, pat to defer until Chief is connected).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handoff, project.id, pat]);

  // ---- No PAT yet: connect state -------------------------------------------------
  if (!pat) {
    return <ConnectChief onSave={setChiefPat} />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: C.forest }}>
      {/* Header: which Chief project this chat is grounded in. */}
      <div
        style={{
          padding: "10px 16px",
          borderBottom: `1px solid ${C.deepForest}`,
          display: "flex",
          alignItems: "center",
          gap: 8,
          color: C.muted,
          fontSize: 12,
        }}
      >
        <span style={{ fontSize: 14 }}>✦</span>
        <span>
          Brainstorming with Chief over{" "}
          <span style={{ color: C.cream, fontWeight: FONT_WEIGHT.semibold }}>{project.name}</span>
          {linking ? " — linking project…" : chiefProjectId ? "'s library" : ""}
        </span>
      </div>

      {/* Transcript */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: 16 }}>
        {messages.length === 0 && (
          <div style={{ color: C.muted, fontSize: 13, lineHeight: 1.6, maxWidth: 560 }}>
            Ask Chief anything about <strong>{project.name}</strong>. It answers from everything in
            the project's library — including the commit progress docs your Build agents produce.
            <br />
            <br />
            Try: <em>"What have we decided so far?"</em> or <em>"Summarize the open concerns."</em>
          </div>
        )}
        {messages.map((m, i) => (
          <Bubble key={i} role={m.role} text={m.text} />
        ))}
        {sending && <Bubble role="assistant" text="…" pending />}
      </div>

      {error && (
        <div style={{ padding: "8px 16px", color: C.sienna, fontSize: 12 }}>{error}</div>
      )}

      {/* Composer */}
      <div style={{ display: "flex", gap: 8, padding: 12, borderTop: `1px solid ${C.deepForest}` }}>
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={`Message Chief about ${project.name}…`}
          rows={2}
          style={{
            flex: 1,
            resize: "none",
            background: C.deepForest,
            color: C.cream,
            border: `1px solid ${C.forest}`,
            borderRadius: 8,
            padding: "8px 10px",
            fontFamily: '"IBM Plex Sans", sans-serif',
            fontSize: 14,
            outline: "none",
          }}
        />
        <button
          onClick={() => void send()}
          disabled={sending || !input.trim()}
          style={{
            alignSelf: "stretch",
            background: sending || !input.trim() ? C.forest : C.teal,
            color: C.cream,
            border: "none",
            borderRadius: 8,
            padding: "0 18px",
            fontWeight: FONT_WEIGHT.semibold,
            cursor: sending || !input.trim() ? "default" : "pointer",
          }}
        >
          {sending ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}

function Bubble({
  role,
  text,
  pending,
}: {
  role: "user" | "assistant";
  text: string;
  pending?: boolean;
}) {
  const mine = role === "user";
  return (
    <div style={{ display: "flex", justifyContent: mine ? "flex-end" : "flex-start", marginBottom: 10 }}>
      <div
        style={{
          maxWidth: "78%",
          background: mine ? C.teal : C.deepForest,
          color: C.cream,
          border: mine ? "none" : `1px solid ${C.forest}`,
          borderRadius: 12,
          padding: "8px 12px",
          fontSize: 14,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          opacity: pending ? 0.6 : 1,
        }}
      >
        {text}
      </div>
    </div>
  );
}

function ConnectChief({ onSave }: { onSave: (pat: string) => void }) {
  const [val, setVal] = useState("");
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 14,
        padding: 32,
        textAlign: "center",
        background: C.forest,
        height: "100%",
      }}
    >
      <div style={{ fontSize: 28 }}>✦</div>
      <div style={{ color: C.cream, fontWeight: FONT_WEIGHT.semibold, fontSize: 16 }}>
        Connect Chief to brainstorm
      </div>
      <div style={{ color: C.muted, fontSize: 13, maxWidth: 420, lineHeight: 1.6 }}>
        Paste a Chief Personal Access Token (starts with <code>pat_</code>). The Brainstorm agent
        chats with Chief over this project's library.
      </div>
      <input
        value={val}
        onChange={(e) => setVal(e.target.value)}
        placeholder="pat_…"
        style={{
          width: 360,
          maxWidth: "100%",
          background: C.deepForest,
          color: C.cream,
          border: `1px solid ${C.teal}`,
          borderRadius: 8,
          padding: "9px 12px",
          fontSize: 14,
          outline: "none",
        }}
      />
      <button
        onClick={() => val.trim() && onSave(val.trim())}
        style={{
          background: C.teal,
          color: C.cream,
          border: "none",
          borderRadius: 8,
          padding: "9px 22px",
          fontWeight: FONT_WEIGHT.semibold,
          cursor: "pointer",
        }}
      >
        Connect
      </button>
    </div>
  );
}
