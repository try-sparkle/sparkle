import { useEffect, useRef, useState } from "react";
import { TbBulb } from "react-icons/tb";
import { C, FONT_WEIGHT } from "../theme/colors";
import type { Project } from "../types";
import { useSettingsStore, effectiveChiefPat, aiFeatureMode } from "../stores/settingsStore";
import { useHandoffStore } from "../stores/handoffStore";
import { useDictationStore } from "../stores/dictationStore";
import { MIC_HOT_PLACEHOLDER, WAKE_PLACEHOLDER } from "../voice/dictationCopy";
import {
  ensureChiefProject,
  startChat,
  pollForResponse,
  ensureSkill,
  createMemory,
  ChiefError,
  type MemoryCategory,
  type ChiefScope,
  type ChatOptions,
} from "../services/chief";
import { structuredJson } from "../services/anthropic";
import { synthesizePrd, writePrd, type SynthesizeResult } from "../services/prd";
import { generateTasks, createBeadFull, beadDepAdd } from "../services/tasks";
import { turnIntoPlan } from "../services/turnIntoPlan";
import { maybeAutoName } from "../services/agentNaming";
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";
import { registerThink } from "../services/thinkBridge";
import { AiDisabledError, OutOfCreditsError } from "../services/credits";
import { useHistoryStore } from "../stores/historyStore";
import type { HistoryEntry, HistoryKind } from "../services/history";
import { sendClaudeChat, cancelClaudeChat, resolveClaudePath } from "../services/claudeChat";
import { chiefInterject } from "../services/chiefParticipant";
import { answerAsVoice } from "../services/voiceAnswer";
import { Markdown } from "./Markdown";
import { MentionPicker, type MentionPick } from "./MentionPicker";
import { searchVoices, findVoice } from "../services/expertRoster";

// Who authored a chat message. "user" = you. "claude" = the headless Claude Code engine (the
// primary, fast responder). "chief" = Chief popping in with a library-grounded observation, or the
// direct answer when you @mention @chief. "voice" = an @mentioned expert voice (a Chief persona).
type Author = "user" | "claude" | "chief" | "voice";

interface ChatMsg {
  id: string;
  author: Author;
  /** For author "voice": the roster handle (e.g. "architect") shown as the byline. */
  voiceHandle?: string;
  text: string;
  /** Streaming/awaiting a reply — renders a dimmed bubble + a typing affordance. */
  pending?: boolean;
}

// One markdown instruction shared by both the in-bubble rendering and the engine prompt.
const MD_HINT = "Respond in clean GitHub-flavored markdown.";

// Build a plain transcript for the grounding/synthesis backends (Chief + Make a Plan). Mentions and
// authorship are flattened to User/Assistant so the downstream prompts stay simple.
function buildTranscript(msgs: ChatMsg[]): string {
  return msgs
    .filter((m) => !m.pending && m.text.trim())
    .map((m) => `${m.author === "user" ? "User" : "Assistant"}: ${m.text}`)
    .join("\n\n");
}

// --- @mention routing -----------------------------------------------------------------------
// A typed message is routed by its FIRST recognized @mention: @chief → Chief only; @<voice> → that
// expert voice only (Claude Code stays silent for both); otherwise → Claude Code (and Chief may
// interject afterward). The mention token is stripped from the question handed to Chief/the voice.
type Route =
  | { kind: "claude"; question: string }
  | { kind: "chief"; question: string }
  | { kind: "voice"; handle: string; question: string };

const MENTION_RE = /(^|\s)@([a-z0-9][a-z0-9-]*)\b/gi;

export function routeMessage(text: string): Route {
  const t = text ?? "";
  let m: RegExpExecArray | null;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(t))) {
    const handle = (m[2] ?? "").toLowerCase();
    if (!handle) continue;
    if (handle === "chief") {
      return { kind: "chief", question: stripMention(t, "chief") };
    }
    if (findVoice(handle)) {
      return { kind: "voice", handle, question: stripMention(t, handle) };
    }
    // An unknown @token (e.g. an email or a stray @) doesn't route — keep scanning, then fall back.
  }
  return { kind: "claude", question: t.trim() };
}

function stripMention(text: string, handle: string): string {
  const re = new RegExp(`(^|\\s)@${handle}\\b`, "gi");
  return (text ?? "")
    .replace(re, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// --- @-token parsing for the live picker ----------------------------------------------------
// Find an in-progress mention token immediately before the caret: an `@` that starts the line or
// follows whitespace, with only handle chars after it up to the caret. Returns the token's start
// index + the query (text after `@`), or null when the caret isn't inside a mention.
export function activeMentionToken(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  const upto = text.slice(0, caret);
  const m = upto.match(/(?:^|\s)@([a-z0-9-]*)$/i);
  if (!m) return null;
  const at = upto.lastIndexOf("@");
  return { start: at, query: m[1] ?? "" };
}

/**
 * The Think tab: a thin markdown chat over the user's OWN Claude Code (headless, streamed — never
 * the Anthropic API), with Chief popping in from the project's PRD library and @mentionable expert
 * voices. "Make a Plan" hands the conversation to the Plan tab as an epic + child beads.
 */
export function ThinkPanel({
  project,
  agentId,
  visible = true,
}: {
  project: Project;
  agentId: string;
  visible?: boolean;
}) {
  const chiefPatStored = useSettingsStore((s) => s.chiefPat);
  const runtimeChiefPat = useSettingsStore((s) => s.runtimeChiefPat);
  const chiefProjectByProject = useSettingsStore((s) => s.chiefProjectByProject);
  const setChiefProject = useSettingsStore((s) => s.setChiefProject);

  const pat = effectiveChiefPat(chiefPatStored, runtimeChiefPat);
  const chiefProjectId = chiefProjectByProject[project.id];

  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [planning, setPlanning] = useState(false);
  const [claudePath, setClaudePath] = useState<string | null>(null);
  const [claudeReady, setClaudeReady] = useState<"checking" | "ok" | "missing">("checking");

  // The current Claude Code session id — captured from each `done` event and passed back as
  // `--resume` on the next turn so the conversation is continuous.
  const sessionIdRef = useRef<string | undefined>(undefined);

  // Mention picker state. `query` filters the roster; `tokenStart` marks the `@` we'll replace on
  // pick; `active` is the highlighted row (0 = @chief, then the filtered voices).
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [pickerActive, setPickerActive] = useState(0);
  const tokenStartRef = useRef<number>(-1);

  const handoff = useHandoffStore((s) => s.pending);
  const clearHandoff = useHandoffStore((s) => s.clear);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const linkAttemptKey = useRef<string | null>(null);
  // Active claude-chat listener cleanup, so we can tear a turn down on unmount.
  const claudeCleanup = useRef<(() => void) | null>(null);

  // Resolve the user's own `claude` binary once (same preflight the Build terminal uses). Claude
  // Code authenticates itself with the user's binary — Sparkle never handles the token.
  useEffect(() => {
    let cancelled = false;
    void resolveClaudePath()
      .then((p) => {
        if (cancelled) return;
        setClaudePath(p);
        setClaudeReady("ok");
      })
      .catch(() => {
        if (!cancelled) setClaudeReady("missing");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Link (or create) the Chief project for grounding/participation once a PAT is available. Chief is
  // optional for chatting with Claude Code, but required for participation, @chief/@voice, and plan.
  useEffect(() => {
    if (!pat || chiefProjectId) return;
    const key = `${project.id}|${pat}`;
    if (linkAttemptKey.current === key) return;
    linkAttemptKey.current = key;
    let cancelled = false;
    void ensureChiefProject(pat, project.name, undefined)
      .then((id) => {
        if (!cancelled) setChiefProject(project.id, id);
      })
      .catch(() => {
        // Best-effort: a Chief link failure just disables Chief features, not the whole tab.
      });
    return () => {
      cancelled = true;
    };
  }, [pat, chiefProjectId, project.id, project.name, setChiefProject]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, sending]);

  // Tear any in-flight Claude turn down on unmount.
  useEffect(() => {
    return () => {
      claudeCleanup.current?.();
      void cancelClaudeChat(agentId);
    };
  }, [agentId]);

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
      // Capture is best-effort — never let it break the chat.
    }
  };

  const chiefEnabled = !!pat && !!chiefProjectId;
  // The AI-features toggle (⋯ menu). The old metered interview enforced this via meteredAi; now that
  // Think runs on the user's own Claude Code, only the Chief-backed paths (@chief, @voice, Make a
  // Plan, the interjection) are gated — talking to your own Claude Code is always allowed.
  const aiOff = () => aiFeatureMode(useSettingsStore.getState()) === "off";
  const AI_OFF_MSG = "AI features are off — turn them on in the ⋯ menu.";

  // Monotonic turn token. Every dispatched turn captures the value at start; a Chief/voice turn
  // checks it before writing its result, and `stopTurn` bumps it — so a network poll that resolves
  // AFTER the user stopped neither overwrites the "_(stopped)_" bubble nor records a response. The
  // Claude path is torn down directly (cancelClaudeChat unsubscribes its listeners), so this guards
  // the Chief/voice polls that have no abort wired through.
  const turnSeqRef = useRef(0);

  // Append a message; returns its id so streaming callbacks can target it.
  const pushMsg = (m: Omit<ChatMsg, "id"> & { id?: string }): string => {
    const id = m.id ?? crypto.randomUUID();
    setMessages((prev) => [...prev, { ...m, id }]);
    return id;
  };
  const patchMsg = (id: string, patch: Partial<ChatMsg> | ((m: ChatMsg) => Partial<ChatMsg>)) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, ...(typeof patch === "function" ? patch(m) : patch) } : m)),
    );
  };

  // --- Claude Code turn (the default, fast path) ------------------------------------------
  const sendToClaude = async (question: string, transcriptBefore: ChatMsg[], { capture = true } = {}) => {
    if (!claudePath) {
      setError("Claude Code isn't available yet — give it a moment, or install the `claude` binary.");
      setSending(false);
      return;
    }
    const replyId = pushMsg({ author: "claude", text: "", pending: true });
    let acc = ""; // full reply text committed to state so far
    // Coalesce streamed deltas: a fast stream fires onDelta many times per frame. Buffering the
    // unflushed text and committing it to React state once per animation frame (instead of a state
    // write + re-render per delta) turns O(deltas) re-renders into O(frames), and moves the string
    // growth off the per-delta hot path. onDone/onError commit the authoritative final text directly
    // and cancel any pending frame, so the last partial buffer is never lost or left marked pending.
    let buf = "";
    let rafId: number | null = null;
    const flushDelta = () => {
      rafId = null;
      if (!buf) return;
      acc += buf;
      buf = "";
      patchMsg(replyId, { text: acc, pending: true });
    };
    const scheduleFlush = () => {
      if (rafId == null) rafId = requestAnimationFrame(flushDelta);
    };
    const cancelFlush = () => {
      if (rafId != null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    };
    // A turn can settle (done/error) BEFORE `sendClaudeChat` resolves its cleanup — most visibly when
    // a backend completes synchronously. `handleSettle` tears down whatever listeners are already
    // wired; the post-await assignment below tears them down immediately if we settled first, so the
    // cleanup is never left dangling and the next turn can't inherit a stale one.
    let settled = false;
    const handleSettle = () => {
      settled = true;
      claudeCleanup.current?.();
      claudeCleanup.current = null;
    };
    try {
      const cleanup = await sendClaudeChat({
        id: agentId,
        prompt: question,
        cwd: project.rootPath,
        claudePath,
        resumeSessionId: sessionIdRef.current,
        onDelta: (text) => {
          buf += text;
          scheduleFlush();
        },
        onDone: ({ sessionId, text }) => {
          cancelFlush();
          sessionIdRef.current = sessionId || sessionIdRef.current;
          const finalText = (text && text.trim()) || acc + buf;
          buf = "";
          patchMsg(replyId, { text: finalText, pending: false });
          if (capture && finalText.trim()) recordTurn("response", finalText);
          setSending(false);
          handleSettle();
          // After Claude answers, let Chief decide whether to pop in (background, best-effort).
          maybeChiefInterject([...transcriptBefore, { id: replyId, author: "claude", text: finalText }]);
        },
        onError: (message) => {
          cancelFlush();
          patchMsg(replyId, { text: `_Claude Code error: ${message}_`, pending: false });
          setError(message);
          setSending(false);
          handleSettle();
        },
      });
      // Compose cancelFlush into the stored cleanup so EVERY teardown path — unmount, Stop, a
      // superseding turn — also cancels a pending delta frame. Without this, a turn abandoned
      // without a done/error event could still fire its last rAF and re-mark the message pending.
      const teardown = () => {
        cancelFlush();
        cleanup();
      };
      if (settled) teardown();
      else claudeCleanup.current = teardown;
    } catch (e) {
      cancelFlush();
      patchMsg(replyId, { text: `_Claude Code error: ${friendlyError(e)}_`, pending: false });
      setError(friendlyError(e));
      setSending(false);
    }
  };

  // Fire Chief's optional interjection after a Claude turn. Gated on Chief being connected + AI on.
  const maybeChiefInterject = (convo: ChatMsg[]) => {
    if (!chiefEnabled) return;
    if (aiFeatureMode(useSettingsStore.getState()) === "off") return;
    void chiefInterject(
      { startChat, pollForResponse },
      { pat, chiefProjectId: chiefProjectId!, conversation: buildTranscript(convo) },
    )
      .then((obs) => {
        if (obs) pushMsg({ author: "chief", text: obs });
      })
      .catch(() => {
        // chiefInterject already swallows errors to null; this is just belt-and-suspenders.
      });
  };

  // --- @chief turn (Chief only; Claude Code stays silent) ---------------------------------
  // AI-features gating + the unpaired-prompt guard live in `dispatch` (before the prompt is
  // recorded). Here we guard the COMPLETION on `turn` so a poll that resolves after Stop is a no-op.
  const sendToChief = async (
    question: string,
    transcriptBefore: ChatMsg[],
    { capture = true, turn }: { capture?: boolean; turn: number },
  ) => {
    if (!chiefEnabled) {
      setError("Connect Chief to talk to it directly.");
      setSending(false);
      return;
    }
    const replyId = pushMsg({ author: "chief", text: "", pending: true });
    try {
      const scope: ChiefScope = { project_ids: [chiefProjectId!] };
      const opts: ChatOptions = { intelligence: "fast", scope };
      const prompt = `${buildTranscript(transcriptBefore)}\n\nUser asks Chief directly: ${question}\n\n${MD_HINT}`;
      const { chat_id, message_id } = await startChat(pat, chiefProjectId!, prompt, opts);
      const reply = await pollForResponse(pat, chiefProjectId!, chat_id, message_id);
      if (turnSeqRef.current !== turn) return; // stopped/superseded — don't overwrite or record
      patchMsg(replyId, { text: reply.trim() || "_(no response)_", pending: false });
      if (capture) recordTurn("response", reply);
    } catch (e) {
      if (turnSeqRef.current !== turn) return;
      patchMsg(replyId, { text: `_Chief error: ${friendlyError(e)}_`, pending: false });
      setError(friendlyError(e));
    } finally {
      if (turnSeqRef.current === turn) setSending(false);
    }
  };

  // --- @voice turn (the expert voice answers via a Chief persona; Claude Code stays silent) -
  const sendToVoice = async (
    handle: string,
    question: string,
    transcriptBefore: ChatMsg[],
    { capture = true, turn }: { capture?: boolean; turn: number },
  ) => {
    const voice = findVoice(handle);
    if (!voice) {
      setError(`Unknown expert voice @${handle}.`);
      setSending(false);
      return;
    }
    if (!chiefEnabled) {
      setError("Connect Chief to bring in expert voices.");
      setSending(false);
      return;
    }
    const replyId = pushMsg({ author: "voice", voiceHandle: handle, text: "", pending: true });
    try {
      const answer = await answerAsVoice(
        { ensureSkill, startChat, pollForResponse },
        {
          pat,
          chiefProjectId: chiefProjectId!,
          voiceName: voice.handle,
          instructions: voice.instructions,
          question,
          conversation: buildTranscript(transcriptBefore),
        },
      );
      if (turnSeqRef.current !== turn) return; // stopped/superseded — don't overwrite or record
      patchMsg(replyId, { text: answer.trim() || "_(no response)_", pending: false });
      if (capture) recordTurn("response", answer);
    } catch (e) {
      if (turnSeqRef.current !== turn) return;
      patchMsg(replyId, { text: `_@${handle} couldn't answer: ${friendlyError(e)}_`, pending: false });
      setError(friendlyError(e));
    } finally {
      if (turnSeqRef.current === turn) setSending(false);
    }
  };

  // Core dispatch: route by @mention, then push the user's message + run the turn.
  const dispatch = async (raw: string, { capture = true } = {}) => {
    const prompt = raw.trim();
    if (!prompt || sending) return;
    setError("");
    const route = routeMessage(prompt);

    // Always echo the user's message into the thread first (send() has already cleared the
    // composer, so otherwise a blocked turn would make their text vanish).
    const userMsg: ChatMsg = { id: crypto.randomUUID(), author: "user", text: prompt };
    const before = [...messages, userMsg];
    setMessages(before);

    // Gate the Chief-backed routes on the AI toggle AFTER echoing but BEFORE recording/sending, so
    // the bubble shows yet no unpaired prompt is persisted and no backend fires.
    if ((route.kind === "chief" || route.kind === "voice") && aiOff()) {
      setError(AI_OFF_MSG);
      return;
    }

    if (capture) {
      recordTurn("prompt", prompt);
      void maybeAutoName(project.id, agentId, prompt);
    }
    setSending(true);
    const turn = ++turnSeqRef.current;

    if (route.kind === "chief") {
      // A bare "@chief" (no following text) → ask Chief for its read on the thread, not the literal token.
      const q = route.question || "What's your take on the conversation so far?";
      await sendToChief(q, before, { capture, turn });
    } else if (route.kind === "voice") {
      const q = route.question || "What's your perspective on the conversation so far?";
      await sendToVoice(route.handle, q, before, { capture, turn });
    } else {
      await sendToClaude(route.question, before, { capture });
    }
  };

  // --- composer send + key handling -------------------------------------------------------
  const send = () => {
    const prompt = input.trim();
    if (!prompt || sending) return;
    setInput("");
    closePicker();
    void dispatch(prompt);
  };

  // Cancel an in-flight turn so a hung `claude` (or a slow Chief poll) can never wedge the composer
  // with the Send button stuck disabled. Kills the headless child, tears the listeners down, and
  // marks any still-streaming reply as stopped.
  const stopTurn = () => {
    // Invalidate the in-flight turn so a Chief/voice poll that resolves later is a no-op (its
    // completion guard sees a bumped token), and tear down the Claude listeners + child.
    turnSeqRef.current++;
    void cancelClaudeChat(agentId);
    claudeCleanup.current?.();
    claudeCleanup.current = null;
    setSending(false);
    setMessages((prev) =>
      prev.map((m) => (m.pending ? { ...m, pending: false, text: m.text || "_(stopped)_" } : m)),
    );
  };

  const pickerRows = () => {
    const voices = searchVoices(pickerQuery);
    return { count: 1 + voices.length, voices };
  };

  const applyPick = (item: MentionPick) => {
    const start = tokenStartRef.current;
    const caret = inputRef.current?.selectionStart ?? input.length;
    const head = start >= 0 ? input.slice(0, start) : input;
    const tail = input.slice(caret);
    const next = `${head}@${item.handle} ${tail}`;
    setInput(next);
    closePicker();
    // Restore focus + caret just after the inserted mention.
    requestAnimationFrame(() => {
      const pos = `${head}@${item.handle} `.length;
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(pos, pos);
      }
    });
  };

  const closePicker = () => {
    setPickerOpen(false);
    setPickerQuery("");
    setPickerActive(0);
    tokenStartRef.current = -1;
  };

  const refreshPicker = (value: string, caret: number) => {
    const tok = activeMentionToken(value, caret);
    if (tok) {
      tokenStartRef.current = tok.start;
      setPickerQuery(tok.query);
      setPickerActive(0);
      setPickerOpen(true);
    } else {
      closePicker();
    }
  };

  const onComposerChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInput(value);
    refreshPicker(value, e.target.selectionStart ?? value.length);
  };

  const onComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (pickerOpen) {
      const { count, voices } = pickerRows();
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setPickerActive((i) => (i + 1) % count);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setPickerActive((i) => (i - 1 + count) % count);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const voice = voices[pickerActive - 1];
        const pick: MentionPick | null =
          pickerActive === 0
            ? { handle: "chief", kind: "chief" }
            : voice
            ? { handle: voice.handle, kind: "voice" }
            : null;
        if (pick) applyPick(pick);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closePicker();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  // --- "Make a Plan": synthesize → epic + beads → switch to the Plan tab -------------------
  async function handleMakeAPlan() {
    if (planning || messages.length === 0) return;
    if (!chiefEnabled) {
      setError("Connect Chief to turn this into a plan.");
      return;
    }
    if (aiOff()) {
      setError(AI_OFF_MSG);
      return;
    }
    setPlanning(true);
    setError("");
    setNotice("Making a plan — synthesizing your conversation into a PRD, then breaking it into tasks…");
    try {
      const res = await turnIntoPlan(
        {
          synthesize: (a) => synthesizePrd({ startChat, pollForResponse, writePrd }, a),
          generate: (a) =>
            generateTasks(
              {
                structuredJson,
                createBeadFull,
                beadDepAdd,
                writePrd,
                createMemory: (content, category) =>
                  createMemory(pat, chiefProjectId!, {
                    content,
                    category: category as MemoryCategory,
                  }).then(() => {}),
              },
              a,
            ),
        },
        { pat, chiefProjectId: chiefProjectId!, projectPath: project.rootPath, transcript: buildTranscript(messages) },
      );
      // The Think agent becomes the epic — the through-line into Plan and Build.
      useProjectStore.getState().renameAgent(project.id, agentId, res.epicTitle);
      setNotice(
        `Plan ready — epic ${res.epicId} with ${res.taskIds.length} task(s). Opening the Plan tab…`,
      );
      // Hand off: take the user to the Plan tab where the epic + beads are waiting.
      useUiStore.getState().setWorkMode("plan");
    } catch (e) {
      setNotice("");
      setError(friendlyError(e));
    } finally {
      setPlanning(false);
    }
  }

  // The connectivity re-query nudge: route a synthetic status-update through Claude (no capture).
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;
  const hasConversationRef = useRef(false);
  hasConversationRef.current = messages.length > 0;
  useEffect(() => {
    return registerThink(agentId, (text) => {
      if (!hasConversationRef.current) return;
      void dispatchRef.current(text, { capture: false });
    });
  }, [agentId]);

  // A terminal-selection action queued a prompt for this project's think agent.
  useEffect(() => {
    if (!handoff || handoff.projectId !== project.id) return;
    const { text, autoSend } = handoff;
    clearHandoff();
    if (autoSend) {
      void dispatch(text);
    } else {
      setInput(text);
      inputRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handoff, project.id]);

  // ---- Voice dictation wiring (mirrors the build Composer) ------------------------
  const audioActive = useDictationStore((s) => visible && s.status === "listening");
  const phase = useDictationStore((s) => s.phase);
  const liveActive = audioActive && phase === "active";
  const livePassive = audioActive && phase === "passive";
  const interim = useDictationStore((s) => (visible ? s.interim : ""));

  useEffect(() => {
    if (!visible) return;
    const append = (text: string) => {
      setInput((v) => (v ? `${v} ${text}` : text));
      inputRef.current?.focus();
    };
    useDictationStore.getState().registerInsert(append);
    return () => {
      const store = useDictationStore.getState();
      if (store.insertTarget === append) store.registerInsert(null);
    };
  }, [visible]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: C.forest }}>
      {/* Header */}
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
          {" — "}
          {claudeReady === "ok"
            ? chiefEnabled
              ? "Claude Code, with Chief in the room"
              : "Claude Code"
            : claudeReady === "checking"
            ? "starting Claude Code…"
            : "Claude Code not found"}
        </span>
      </div>

      {/* Transcript */}
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: 16 }}>
          {messages.length === 0 && (
            <div style={{ color: C.muted, fontSize: 13, lineHeight: 1.6, maxWidth: 580 }}>
              Talk to <strong>Claude Code</strong> about <strong>{project.name}</strong> — ask
              anything, invoke skills, think out loud. Chief sits in the room and pops in with
              observations grounded in your project library.
              <br />
              <br />
              Type <code>@</code> to bring in an expert voice, or <code>@chief</code> to ask Chief
              directly. When you're ready, press <em>“Make a Plan”</em> to hand it to the Plan tab.
            </div>
          )}
          {messages.map((m) => (
            <Bubble key={m.id} msg={m} />
          ))}
        </div>
      </div>

      {error && <div style={{ padding: "8px 16px", color: C.sienna, fontSize: 12 }}>{error}</div>}
      {notice && !error && (
        <div style={{ padding: "8px 16px", color: C.muted, fontSize: 12 }}>{notice}</div>
      )}

      {/* The single Plan handoff action */}
      <div
        style={{
          display: "flex",
          gap: 8,
          padding: "8px 12px",
          borderTop: `1px solid ${C.deepForest}`,
        }}
      >
        <button
          onClick={() => void handleMakeAPlan()}
          disabled={planning || messages.length === 0 || !chiefEnabled}
          title={
            chiefEnabled
              ? "Synthesize this conversation into an epic + tasks and open the Plan tab"
              : "Connect Chief to make a plan"
          }
          style={{
            background: planning || messages.length === 0 || !chiefEnabled ? C.forest : C.teal,
            color: planning || messages.length === 0 || !chiefEnabled ? C.muted : C.cream,
            border: `1px solid ${planning || messages.length === 0 || !chiefEnabled ? C.forest : C.teal}`,
            borderRadius: 8,
            padding: "6px 16px",
            fontSize: 13,
            fontWeight: FONT_WEIGHT.semibold,
            cursor: planning || messages.length === 0 || !chiefEnabled ? "default" : "pointer",
          }}
        >
          {planning ? "Making a plan…" : "Make a Plan"}
        </button>
      </div>

      {/* Composer (with the @-mention picker floating above it) */}
      <div style={{ position: "relative", padding: 12, borderTop: `1px solid ${C.deepForest}` }}>
        {pickerOpen && (
          <div style={{ position: "absolute", bottom: "100%", left: 12, marginBottom: 6, zIndex: 20 }}>
            <MentionPicker
              query={pickerQuery}
              activeIndex={pickerActive}
              onActiveIndexChange={setPickerActive}
              onPick={applyPick}
              onClose={closePicker}
            />
          </div>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={onComposerChange}
              onKeyDown={onComposerKeyDown}
              onClick={(e) =>
                refreshPicker(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)
              }
              placeholder={
                liveActive
                  ? MIC_HOT_PLACEHOLDER
                  : livePassive
                  ? WAKE_PLACEHOLDER
                  : `Talk to Claude Code about ${project.name}…  (type @ for voices)`
              }
              rows={2}
              style={{
                width: "100%",
                boxSizing: "border-box",
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
            {audioActive && interim && (
              <div
                style={{
                  color: C.muted,
                  fontStyle: "italic",
                  fontSize: 13,
                  lineHeight: 1.4,
                  padding: "0 2px",
                  fontFamily: '"IBM Plex Sans", sans-serif',
                }}
              >
                {interim}
              </div>
            )}
          </div>
          <button
            onClick={() => (sending ? stopTurn() : send())}
            disabled={!sending && !input.trim()}
            title={sending ? "Stop the current turn" : "Send"}
            style={{
              alignSelf: "stretch",
              background: sending ? C.sienna : input.trim() ? C.teal : C.forest,
              color: C.cream,
              border: "none",
              borderRadius: 8,
              padding: "0 18px",
              fontWeight: FONT_WEIGHT.semibold,
              cursor: !sending && !input.trim() ? "default" : "pointer",
            }}
          >
            {sending ? "Stop" : "Send"}
          </button>
        </div>
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

// The byline shown above a non-user bubble.
function authorLabel(m: ChatMsg): string {
  if (m.author === "chief") return "Chief";
  if (m.author === "voice") return `@${m.voiceHandle}`;
  return "Claude Code";
}

function Bubble({ msg }: { msg: ChatMsg }) {
  const mine = msg.author === "user";
  // Author-tinted left border so Claude / Chief / a voice are visually distinct at a glance.
  const accent =
    msg.author === "chief" ? C.accentInk : msg.author === "voice" ? C.successInk : C.teal;
  return (
    <div style={{ display: "flex", justifyContent: mine ? "flex-end" : "flex-start", marginBottom: 12 }}>
      <div style={{ maxWidth: "82%", display: "flex", flexDirection: "column", gap: 3 }}>
        {!mine && (
          <span style={{ fontSize: 11, color: C.muted, fontWeight: FONT_WEIGHT.semibold, paddingLeft: 2 }}>
            {authorLabel(msg)}
          </span>
        )}
        <div
          style={{
            background: mine ? C.teal : C.deepForest,
            color: C.cream,
            border: mine ? "none" : `1px solid ${C.forest}`,
            borderLeft: mine ? "none" : `3px solid ${accent}`,
            borderRadius: 12,
            padding: "8px 12px",
            opacity: msg.pending && !msg.text ? 0.6 : 1,
          }}
        >
          {msg.pending && !msg.text ? (
            <span style={{ color: C.cream, fontSize: 14 }}>…</span>
          ) : mine ? (
            <span style={{ fontSize: 14, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{msg.text}</span>
          ) : (
            <Markdown text={msg.text} />
          )}
        </div>
      </div>
    </div>
  );
}
