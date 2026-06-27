import { useEffect, useRef, useState } from "react";
import { TbBulb } from "react-icons/tb";
import { C, FONT_WEIGHT } from "../theme/colors";
import type { Project } from "../types";
import { useSettingsStore, effectiveChiefPat, aiFeatureMode } from "../stores/settingsStore";
import { useHandoffStore } from "../stores/handoffStore";
import {
  ensureChiefProject,
  startChat,
  sendMessage,
  pollForResponse,
  ensureSkill,
  createMemory,
  ChiefError,
  wipeChiefLibrary,
  type MemoryCategory,
} from "../services/chief";
import { chatOnce, structuredJson } from "../services/anthropic";
import { createLibrarian, type Librarian } from "../services/librarian";
import { useLibrarianStore } from "../stores/librarianStore";
import { synthesizePrd, writePrd, type SynthesizeResult } from "../services/prd";
import { generateTasks, createBeadFull, beadDepAdd } from "../services/tasks";
import { sendToBuild } from "../services/sendToBuild";
import { LibrarianRail } from "./LibrarianRail";
import { registerThink } from "../services/thinkBridge";
import { meteredAi } from "../services/sparkleApi";
import { CHIEF_CALL_CENTS } from "../services/creditPricing";
import { AiDisabledError, OutOfCreditsError } from "../services/credits";
import { useAuthStore } from "../stores/authStore";
import { useHistoryStore } from "../stores/historyStore";
import type { HistoryEntry, HistoryKind } from "../services/history";

interface ChatMsg {
  role: "user" | "assistant";
  text: string;
}

// The interviewer persona. The conversation runs on Claude-direct (snappy), while Chief grounds it
// in the background via the librarian (see services/librarian.ts) — its findings are folded into the
// system prompt below so each turn is sharper without ever blocking on Chief.
const INTERVIEWER_SYSTEM = [
  "You are Sparkle's product-thinking interviewer. Help the user turn a raw idea into a crisp,",
  "buildable spec by interviewing them — ONE sharp question at a time, never a wall of questions.",
  "Prefer concrete multiple-choice when it helps them decide. Surface hidden assumptions, edge",
  "cases, and scope boundaries. Be concise and warm. When a direction becomes clear, briefly",
  "reflect it back before moving on. Do NOT write the final PRD yourself — when the user is ready",
  "they will press “I'm done” to synthesize it from the whole conversation.",
].join(" ");

function buildTranscript(msgs: ChatMsg[]): string {
  return msgs.map((m) => `${m.role === "user" ? "User" : "Interviewer"}: ${m.text}`).join("\n\n");
}

/** Fold the librarian's latest grounding/challenges into the interviewer's system prompt. Read from
 *  the store at call time (not render) so the freshest background findings ground the next turn. */
function buildInterviewSystem(agentId: string): string {
  const lanes = useLibrarianStore.getState().byAgent[agentId];
  const g = (lanes?.grounding ?? []).map((i) => `- ${i.text}`).join("\n");
  const c = (lanes?.challenges ?? []).map((i) => `- ${i.text}`).join("\n");
  let s = INTERVIEWER_SYSTEM;
  if (g) {
    s += `\n\nThe project librarian surfaced relevant prior context — use it to sharpen your questions, don't recite it verbatim:\n${g}`;
  }
  if (c) {
    s += `\n\nThe skeptic raised these challenges — weave the important ones into your questioning:\n${c}`;
  }
  return s;
}

/**
 * The Think agent's surface: a Claude-direct interview that turns an idea into a spec, grounded in
 * real time by Chief's background "librarian + skeptic" (the side-rail). When the spec is ready the
 * user synthesizes a cited PRD ("I'm done"), generates an epic + child beads ("Generate tasks"), and
 * hands it to the Build orchestrator ("Send to Build"). No worktree, no PTY. (Epic sparkle-hiju.)
 */
export function ThinkPanel({ project, agentId }: { project: Project; agentId: string }) {
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
  const [notice, setNotice] = useState("");
  const [linking, setLinking] = useState(false);
  const [resetState, setResetState] = useState<"idle" | "confirm" | "working">("idle");
  // The closed-loop state: a synthesized PRD, then the epic it became.
  const [prd, setPrd] = useState<SynthesizeResult | null>(null);
  const [epicId, setEpicId] = useState<string | null>(null);
  const [synthesizing, setSynthesizing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const clearChiefDocState = useSettingsStore((s) => s.clearChiefDocState);
  const handoff = useHandoffStore((s) => s.pending);
  const clearHandoff = useHandoffStore((s) => s.clear);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const librarianRef = useRef<Librarian | null>(null);
  // Attempt the auto-link at most ONCE per (project, pat) pair. Without this, a failed link
  // (Chief outage / bad PAT) would re-fire the effect via setLinking(false) and retry forever,
  // hammering the API. The key changes only when the user connects a new PAT or switches project,
  // which is exactly when a fresh attempt is wanted.
  const linkAttemptKey = useRef<string | null>(null);

  // Spin up the background librarian once per Think agent; tear it down (and clear its lanes) on
  // unmount. Wired to the real Chief client and the librarian store.
  useEffect(() => {
    const lib = createLibrarian({
      startChat,
      pollForResponse,
      ensureSkill,
      setLane: useLibrarianStore.getState().setLane,
      setStatus: useLibrarianStore.getState().setStatus,
    });
    librarianRef.current = lib;
    return () => {
      lib.dispose();
      useLibrarianStore.getState().clear(agentId);
      librarianRef.current = null;
    };
  }, [agentId]);

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

  // Fire-and-forget capture of a think turn into the durable history store. This must NEVER break
  // the chat: we guard against both a synchronous throw and a rejected promise here.
  const recordTurn = (kind: HistoryKind, text: string) => {
    const entry: HistoryEntry = {
      id: crypto.randomUUID(),
      kind,
      source: "brainstorm",
      projectId: project.id,
      agentId,
      projectName: project.name,
      agentName: "Think",
      text,
      createdAt: Date.now(),
    };
    try {
      void useHistoryStore.getState().record(entry).catch(() => {});
    } catch {
      // Capture is best-effort — a failed write must not surface into the chat flow.
    }
  };

  // Core send: the interview runs on Claude-direct (fast). After the user's turn we kick the
  // background librarian so Chief grounds the NEXT exchange without ever blocking this one.
  const sendText = async (prompt: string, { capture = true }: { capture?: boolean } = {}) => {
    if (!prompt || sending) return;
    if (!pat) {
      setError("Connect Chief first.");
      return;
    }
    setError("");
    const nextMessages: ChatMsg[] = [...messages, { role: "user", text: prompt }];
    setMessages(nextMessages);
    if (capture) recordTurn("prompt", prompt);

    // Kick the background librarian for the next turn (non-blocking; swallows its own errors).
    // Gate it on the AI-features toggle so a disabled-AI session doesn't fire background Chief
    // round-trips — mirroring how the interview turn below short-circuits via meteredAi.
    if (chiefProjectId && aiFeatureMode(useSettingsStore.getState()) !== "off") {
      librarianRef.current?.onUserTurn({
        agentId,
        pat,
        chiefProjectId,
        conversation: buildTranscript(nextMessages),
      });
    }

    setSending(true);
    try {
      // Meter the exchange against the user's AI credits / the AI-features toggle, then run the
      // Claude-direct interview turn with the librarian's grounding folded into the system prompt.
      const text = await meteredAi(
        { estimateCents: CHIEF_CALL_CENTS, reason: "chief_debit", meta: { projectId: project.id } },
        async () => {
          const system = buildInterviewSystem(agentId);
          const user = `${buildTranscript(nextMessages)}\n\nRespond as the interviewer with your next message.`;
          return chatOnce(system, user);
        },
      );
      setMessages((m) => [...m, { role: "assistant", text }]);
      if (capture) recordTurn("response", text);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setSending(false);
      // Refresh the balance so the counter reflects the debit/refund.
      void useAuthStore.getState().refresh();
    }
  };

  // The composer's send: take the typed input, clear it, and dispatch.
  const send = () => {
    const prompt = input.trim();
    if (!prompt || sending) return; // don't clear the box if a turn is already in flight
    setInput("");
    void sendText(prompt);
  };

  // "I'm done": synthesize a cited PRD from the whole conversation via Chief (research depth).
  async function handleSynthesize() {
    if (synthesizing || messages.length === 0) return;
    if (!chiefProjectId) {
      setError("Chief isn't linked yet — give it a moment and try again.");
      return;
    }
    setSynthesizing(true);
    setError("");
    setNotice("Synthesizing the PRD from your whole library… this is the deep pass, it can take a minute.");
    try {
      const result = await synthesizePrd(
        { startChat, pollForResponse, writePrd },
        { pat, chiefProjectId, projectPath: project.rootPath, transcript: buildTranscript(messages) },
      );
      setPrd(result);
      setEpicId(null);
      setNotice(`PRD written to ${result.path}. Review it, then “Generate tasks”.`);
    } catch (e) {
      setNotice("");
      setError(friendlyError(e));
    } finally {
      setSynthesizing(false);
    }
  }

  // "Generate tasks": turn the PRD into an epic + dependency-aware child beads.
  async function handleGenerateTasks() {
    if (!prd || generating) return;
    if (!chiefProjectId) return;
    setGenerating(true);
    setError("");
    setNotice("Generating the epic and tasks…");
    try {
      const res = await generateTasks(
        {
          structuredJson,
          createBeadFull,
          beadDepAdd,
          writePrd,
          createMemory: (content, category) =>
            createMemory(pat, chiefProjectId, { content, category: category as MemoryCategory }).then(
              () => {},
            ),
        },
        {
          projectPath: project.rootPath,
          prdFilename: prd.filename,
          prdContent: prd.content,
          prdRelPath: prd.path,
        },
      );
      setEpicId(res.epicId);
      setPrd({ ...prd, content: res.updatedPrdContent });
      setNotice(
        `Created epic ${res.epicId} with ${res.taskIds.length} task(s). Open Tasks to watch them, or “Send to Build”.`,
      );
    } catch (e) {
      setNotice("");
      setError(friendlyError(e));
    } finally {
      setGenerating(false);
    }
  }

  // "Send to Build": spawn/seed the orchestrator with the epic + PRD; it drives the board from here.
  function handleSendToBuild() {
    if (!epicId || !prd) return;
    try {
      sendToBuild({ projectId: project.id, epicId, prdPath: prd.path });
      setNotice("Sent to Build — the orchestrator is starting. Watch the Tasks board fill in.");
    } catch (e) {
      setError(friendlyError(e));
    }
  }

  async function handleResetLibrary() {
    if (!chiefProjectId) return;
    if (resetState === "idle") {
      setResetState("confirm");
      return;
    }
    setResetState("working");
    setError("");
    setNotice("");
    try {
      const n = await wipeChiefLibrary(pat, chiefProjectId);
      setNotice(`Reset Chief library — removed ${n} file(s). Current docs re-sync on the next commit.`);
    } catch (e) {
      setNotice("");
      setError(e instanceof Error ? e.message : "Reset failed.");
    } finally {
      // Clear docState regardless of success or partial failure: any wipe attempt leaves
      // the library in an unknown state, and clearing the ledger ensures the next sync
      // does a full re-upload rather than skipping paths whose assets were already deleted.
      clearChiefDocState(chiefProjectId);
      setResetState("idle");
    }
  }

  // Register this panel so the connectivity re-query can deliver its "status update" nudge here.
  // The nudge only "updates" an already-active conversation — firing it on an untouched, empty
  // panel would inject an unsolicited synthetic turn (and a metered debit). Gate on a ref tracking
  // whether the conversation has started (kept current to dodge a stale closure).
  const sendTextRef = useRef(sendText);
  sendTextRef.current = sendText;
  const hasConversationRef = useRef(false);
  hasConversationRef.current = messages.length > 0;
  useEffect(() => {
    return registerThink(agentId, (text) => {
      if (!hasConversationRef.current) return; // no conversation yet — nothing to "update"
      // A synthetic status-update nudge, not a user turn — don't capture it into history.
      void sendTextRef.current(text, { capture: false });
    });
  }, [agentId]);

  // A terminal-selection action queued a prompt for this project's think agent. Prefill it
  // (and auto-send for Explain/Ask). Runs once per queued handoff, then clears it.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handoff, project.id, pat]);

  // ---- No PAT yet: connect state -------------------------------------------------
  if (!pat) {
    return <ConnectChief onSave={setChiefPat} />;
  }

  const canSynthesize = !synthesizing && messages.length > 0 && !!chiefProjectId;

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
        <TbBulb size={20} style={{ flexShrink: 0 }} />
        <span>
          Thinking about{" "}
          <span style={{ color: C.cream, fontWeight: FONT_WEIGHT.semibold }}>{project.name}</span>
          {linking ? " — linking Chief…" : chiefProjectId ? " — Chief is grounding you live" : ""}
        </span>
        <div style={{ flex: 1 }} />
        {chiefProjectId && (
          <button
            onClick={() => void handleResetLibrary()}
            disabled={resetState === "working"}
            title="Delete all files in this project's Chief library and re-sync the current docs"
            style={{
              background: "transparent",
              color: resetState === "confirm" ? C.sienna : C.muted,
              border: `1px solid ${resetState === "confirm" ? C.sienna : C.forest}`,
              borderRadius: 6,
              padding: "2px 8px",
              fontSize: 11,
              cursor: resetState === "working" ? "default" : "pointer",
            }}
            onBlur={() => setResetState((s) => (s === "confirm" ? "idle" : s))}
          >
            {resetState === "working"
              ? "Resetting…"
              : resetState === "confirm"
                ? "Click to confirm reset"
                : "Reset library"}
          </button>
        )}
      </div>

      {/* Transcript + live grounding rail */}
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: 16 }}>
          {messages.length === 0 && (
            <div style={{ color: C.muted, fontSize: 13, lineHeight: 1.6, maxWidth: 560 }}>
              Think out loud about <strong>{project.name}</strong>. I'll interview you to shape it into
              a spec — one question at a time — while Chief grounds us in everything the project already
              knows (see the rail on the right).
              <br />
              <br />
              When it's sharp, press <em>“I'm done”</em> to synthesize a PRD, then{" "}
              <em>“Generate tasks”</em> and <em>“Send to Build”</em>.
            </div>
          )}
          {messages.map((m, i) => (
            <Bubble key={i} role={m.role} text={m.text} />
          ))}
          {sending && <Bubble role="assistant" text="…" pending />}
        </div>
        <LibrarianRail
          agentId={agentId}
          onInject={(t) => {
            setInput(t);
            inputRef.current?.focus();
          }}
        />
      </div>

      {error && <div style={{ padding: "8px 16px", color: C.sienna, fontSize: 12 }}>{error}</div>}
      {notice && !error && (
        <div style={{ padding: "8px 16px", color: C.muted, fontSize: 12 }}>{notice}</div>
      )}

      {/* The closed-loop actions */}
      <div
        style={{
          display: "flex",
          gap: 8,
          padding: "8px 12px",
          borderTop: `1px solid ${C.deepForest}`,
          flexWrap: "wrap",
        }}
      >
        <ActionButton
          label={synthesizing ? "Synthesizing…" : "I'm done — write the PRD"}
          onClick={() => void handleSynthesize()}
          disabled={!canSynthesize}
          primary
        />
        <ActionButton
          label={generating ? "Generating…" : "Generate tasks"}
          onClick={() => void handleGenerateTasks()}
          disabled={!prd || generating}
        />
        <ActionButton label="Send to Build" onClick={handleSendToBuild} disabled={!epicId} />
        {prd && (
          <span style={{ alignSelf: "center", color: C.muted, fontSize: 11, fontFamily: "monospace" }}>
            {prd.path}
            {epicId ? ` · ${epicId}` : ""}
          </span>
        )}
      </div>

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
          placeholder={`Think out loud about ${project.name}…`}
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

function friendlyError(e: unknown): string {
  if (e instanceof AiDisabledError) return "AI features are off — turn them on in the ⋯ menu.";
  if (e instanceof OutOfCreditsError) return "Out of AI credits. Add more to keep thinking.";
  if (e instanceof ChiefError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

function ActionButton({
  label,
  onClick,
  disabled,
  primary,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: disabled ? C.forest : primary ? C.teal : C.deepForest,
        color: disabled ? C.muted : C.cream,
        border: `1px solid ${disabled ? C.forest : primary ? C.teal : C.forest}`,
        borderRadius: 8,
        padding: "6px 14px",
        fontSize: 12.5,
        fontWeight: FONT_WEIGHT.semibold,
        cursor: disabled ? "default" : "pointer",
      }}
    >
      {label}
    </button>
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
      <TbBulb size={28} />
      <div style={{ color: C.cream, fontWeight: FONT_WEIGHT.semibold, fontSize: 16 }}>
        Connect Chief to think
      </div>
      <div style={{ color: C.muted, fontSize: 13, maxWidth: 420, lineHeight: 1.6 }}>
        Paste a Chief Personal Access Token (starts with <code>pat_</code>). The Think agent uses
        Chief to ground your thinking in this project's library.
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
