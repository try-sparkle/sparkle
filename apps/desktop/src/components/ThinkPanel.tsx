import { memo, useEffect, useRef, useState } from "react";
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
import { aiFeatureLockedNow, useAiFeatureLocked } from "../services/aiGate";
import { AiLockedNotice } from "./AiLockedNotice";
import { useHistoryStore } from "../stores/historyStore";
import type { HistoryEntry, HistoryKind } from "../services/history";
import { sendClaudeChat, cancelClaudeChat, resolveClaudePath } from "../services/claudeChat";
import { chiefInterject } from "../services/chiefParticipant";
import { answerAsVoice } from "../services/voiceAnswer";
import { Markdown } from "./Markdown";
import { MentionPicker, type MentionPick } from "./MentionPicker";
import { searchVoices, findVoice } from "../services/expertRoster";
import { screenshotAttachment } from "./composer/attachmentsApi";
import { composeThinkTurn } from "./thinkCompose";
import type { Attachment } from "./composer/attachments";

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
// A message can be answered by MORE THAN ONE responder. The rule (confirmed with the founder):
//   • A mention at the VERY START of the message is a *directed* message — ONLY that entity answers
//     (Sparkle stays silent). "@chief what's the risk?" → Chief alone.
//   • A mention that appears LATER is *additive* — Sparkle answers the message AND every @mentioned
//     entity chimes in, like a group chat. "…make a PRD. And @chief thoughts?" → Sparkle + Chief.
//   • Plain text → Sparkle alone (Chief may still interject afterward).
// Recognized @mentions (@chief + known expert voices) are stripped from the question handed to every
// responder; unknown @tokens (emails, a stray @) are left intact and don't route.
export type Responder =
  | { kind: "claude" }
  | { kind: "chief" }
  | { kind: "voice"; handle: string };

export interface RouteResult {
  /** The question with recognized @mention tokens stripped — handed to every responder. */
  question: string;
  /** Ordered, de-duplicated responders. When additive, Sparkle ("claude") leads. */
  responders: Responder[];
}

const MENTION_RE = /(^|\s)@([a-z0-9][a-z0-9-]*)\b/gi;

export function routeMessage(text: string): RouteResult {
  const t = (text ?? "").trim();
  const question = stripAllMentions(t);

  const mentions: Responder[] = [];
  const seen = new Set<string>();
  let leadingMention: Responder | null = null;
  let m: RegExpExecArray | null;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(t))) {
    const handle = (m[2] ?? "").toLowerCase();
    if (!handle) continue;
    const responder: Responder | null =
      handle === "chief"
        ? { kind: "chief" }
        : findVoice(handle)
        ? { kind: "voice", handle }
        : null;
    if (!responder) continue; // unknown @token — ignore, keep scanning
    // Position of the "@": m.index points at the (^|\s) boundary; add its width (0 at start, else 1).
    const atIndex = m.index + (m[1] ? m[1].length : 0);
    if (leadingMention === null && mentions.length === 0 && atIndex === 0) {
      leadingMention = responder; // the message OPENS with this recognized mention → directed
    }
    const key = responder.kind === "chief" ? "chief" : `voice:${responder.handle}`;
    if (!seen.has(key)) {
      seen.add(key);
      mentions.push(responder);
    }
  }

  if (mentions.length === 0) return { question, responders: [{ kind: "claude" }] };
  if (leadingMention) return { question, responders: [leadingMention] }; // directed: solo
  return { question, responders: [{ kind: "claude" }, ...mentions] }; // additive: Sparkle + mentions
}

// Strip every RECOGNIZED @mention (@chief + known voices), preserving the boundary char before it;
// unknown @tokens (e.g. an email) are left untouched.
function stripAllMentions(text: string): string {
  return (text ?? "")
    .replace(MENTION_RE, (full: string, boundary: string, handle: string) =>
      (handle ?? "").toLowerCase() === "chief" || findVoice((handle ?? "").toLowerCase())
        ? boundary
        : full,
    )
    .replace(/\s{2,}/g, " ")
    .trim();
}

// --- @mention emphasis (composer overlay + sent bubble) -------------------------------------
export interface MentionSeg {
  text: string;
  /** Set when this segment is a RECOGNIZED @mention token; `text` still includes the leading "@". */
  handle?: string;
}

// Split `text` into plain + recognized-mention segments. Mention `text` keeps the leading "@" so the
// composer overlay preserves character-for-character width under the transparent textarea (caret
// alignment); the sent bubble strips it at render time. Unknown @tokens stay inline as plain text.
export function splitMentions(text: string): MentionSeg[] {
  const src = text ?? "";
  const segs: MentionSeg[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(src))) {
    const handle = (m[2] ?? "").toLowerCase();
    if (handle !== "chief" && !findVoice(handle)) continue; // unknown @token — leave inline
    const at = m.index + (m[1] ? m[1].length : 0); // index of the "@"
    if (at > last) segs.push({ text: src.slice(last, at) });
    const end = at + 1 + handle.length;
    segs.push({ text: src.slice(at, end), handle });
    last = end;
  }
  if (last < src.length) segs.push({ text: src.slice(last) });
  return segs;
}

// Shared mention emphasis: teal (accent ink) + semibold. `stripAt` drops the leading "@" — used in
// the STATIC sent bubble (no caret to keep aligned); the live composer keeps it.
function MentionText({ text, stripAt }: { text: string; stripAt: boolean }) {
  return (
    <>
      {splitMentions(text).map((seg, i) =>
        seg.handle ? (
          <span key={i} style={{ color: C.accentInk, fontWeight: FONT_WEIGHT.semibold }}>
            {stripAt ? seg.text.slice(1) : seg.text}
          </span>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}

// One shared typography spec so the composer's highlight overlay lines up character-for-character
// with the transparent-text <textarea> on top of it — any drift misaligns the caret. The wrap keys
// (`overflowWrap`/`wordBreak`) live HERE so both layers pick identical break points for a long
// unbroken token (a pasted URL, a long @handle); splitting them across the two inline styles is
// exactly the drift this spec exists to prevent.
const COMPOSER_TYPO = {
  fontFamily: '"IBM Plex Sans", sans-serif',
  fontSize: 14,
  lineHeight: 1.4,
  padding: "8px 10px",
  boxSizing: "border-box" as const,
  overflowWrap: "break-word" as const,
  wordBreak: "break-word" as const,
};

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
  // Capture screenshots handed off with the draft (pending.attachments). Shown as pills above
  // the composer; on send each becomes a `[Screenshot: <path>]` line in the turn text — neither
  // the headless Claude Code chat nor Chief takes image content blocks yet, and Claude Code can
  // read the file from disk via its path.
  const [attachedShots, setAttachedShots] = useState<Attachment[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // Trial "see it but buy to use it": Think is VISIBLE during the trial (aiGate visible split), but
  // submitting while LOCKED (flag on, no credits) shows this inline buy-to-use notice instead of
  // firing any backend — the typed text is preserved so the user can send for real after buying.
  const [showLockedNotice, setShowLockedNotice] = useState(false);
  // Reactive lock state so the notice self-clears the moment the app is bought (becomes entitled),
  // mirroring the other visible-but-locked surfaces — otherwise it would linger for an already-
  // entitled user until the next dispatch() ran.
  const thinkLocked = useAiFeatureLocked("brainstorm");
  useEffect(() => {
    if (!thinkLocked) setShowLockedNotice(false);
  }, [thinkLocked]);
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
  // The mention-highlight layer behind the composer textarea; kept scroll-synced with the textarea.
  const overlayRef = useRef<HTMLDivElement>(null);
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

  // Monotonic plan token — the Make-a-Plan analogue of `turnSeqRef`. Bumped by `cancelPlan` so a
  // synthesis/generation that resolves AFTER the user backed out neither switches tabs nor clears the
  // (already reset) planning state. Gives the founder an escape hatch even if the network is slow —
  // the per-request timeout in chief.ts prevents the true infinite hang, this covers the wait.
  const planSeqRef = useRef(0);

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

  // --- Sparkle turn (the default, fast path — the user's own headless Claude Code) --------
  // Returns a promise that RESOLVES when the turn settles (done/error), so `dispatch` can await it
  // alongside any concurrent @chief/@voice responders and clear `sending` only once all are done.
  // `interject` is suppressed when Chief is already an explicit responder this turn (no double reply).
  const sendToClaude = (
    question: string,
    transcriptBefore: ChatMsg[],
    { capture = true, interject = true }: { capture?: boolean; interject?: boolean } = {},
  ): Promise<void> => {
    return new Promise<void>((resolve) => {
      if (!claudePath) {
        setError("Sparkle isn't available yet — give it a moment, or install the `claude` binary.");
        resolve();
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
      // A turn can settle (done/error) BEFORE `sendClaudeChat` resolves its cleanup — most visibly
      // when a backend completes synchronously. `handleSettle` tears down whatever listeners are
      // already wired; the post-await assignment below tears them down immediately if we settled
      // first, so the cleanup is never left dangling and the next turn can't inherit a stale one.
      let settled = false;
      const handleSettle = () => {
        settled = true;
        claudeCleanup.current?.();
        claudeCleanup.current = null;
      };
      sendClaudeChat({
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
          handleSettle();
          // After Sparkle answers, let Chief decide whether to pop in (background, best-effort) —
          // unless Chief is already answering this turn explicitly.
          if (interject) {
            maybeChiefInterject([...transcriptBefore, { id: replyId, author: "claude", text: finalText }]);
          }
          resolve();
        },
        onError: (message) => {
          cancelFlush();
          patchMsg(replyId, { text: `_Sparkle error: ${message}_`, pending: false });
          setError(message);
          handleSettle();
          resolve();
        },
      })
        .then((cleanup) => {
          // Compose cancelFlush into the stored cleanup so EVERY teardown path — unmount, Stop, a
          // superseding turn — also cancels a pending delta frame. Without this, a turn abandoned
          // without a done/error event could still fire its last rAF and re-mark the message pending.
          const teardown = () => {
            cancelFlush();
            cleanup();
          };
          if (settled) teardown();
          else claudeCleanup.current = teardown;
        })
        .catch((e) => {
          cancelFlush();
          patchMsg(replyId, { text: `_Sparkle error: ${friendlyError(e)}_`, pending: false });
          setError(friendlyError(e));
          resolve();
        });
    });
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
    }
    // `sending` is cleared by `dispatch` once every responder this turn has settled.
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
      return;
    }
    if (!chiefEnabled) {
      setError("Connect Chief to bring in expert voices.");
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
    }
    // `sending` is cleared by `dispatch` once every responder this turn has settled.
  };

  // Core dispatch: route by @mention, then push the user's message + run every responder this turn.
  const dispatch = async (raw: string, { capture = true } = {}) => {
    const prompt = raw.trim();
    if (!prompt || sending) return;
    // Visible-but-locked (trial / no credits): Think is shown but can't run. Surface the buy-to-use
    // notice and fire NO backend (Claude/Chief/voice). This also guards the non-composer callers
    // (capture/handoff auto-send, the connectivity nudge); send() already blocks before clearing the
    // composer, so the user's typed text is never lost.
    if (aiFeatureLockedNow("brainstorm")) {
      setShowLockedNotice(true);
      return;
    }
    setShowLockedNotice(false);
    setError("");
    const { question, responders } = routeMessage(prompt);

    // Always echo the user's message into the thread first (send() has already cleared the
    // composer, so otherwise a blocked turn would make their text vanish).
    const userMsg: ChatMsg = { id: crypto.randomUUID(), author: "user", text: prompt };
    const before = [...messages, userMsg];
    setMessages(before);

    // Talking to your own Sparkle (Claude Code) is always allowed; only the Chief-backed responders
    // (@chief, @voice) are gated on the AI toggle. So when AI is off, drop those responders rather
    // than blocking the whole turn — Sparkle can still answer. Gate AFTER echoing but BEFORE
    // recording/sending, so the bubble shows yet no unpaired prompt is persisted and no backend fires.
    let active = responders;
    if (aiOff()) {
      active = responders.filter((r) => r.kind === "claude");
      if (active.length === 0) {
        setError(AI_OFF_MSG); // e.g. a directed "@chief …" with AI off — nothing left to run
        return;
      }
    }

    if (capture) {
      recordTurn("prompt", prompt);
      void maybeAutoName(project.id, agentId, prompt);
    }
    setSending(true);
    const turn = ++turnSeqRef.current;

    // Suppress Chief's automatic post-Sparkle interjection when Chief is already answering explicitly.
    const chiefExplicit = active.some((r) => r.kind === "chief");
    const jobs = active.map((r) => {
      if (r.kind === "chief") {
        // A bare "@chief" (no other text) → ask Chief for its read on the thread, not the literal token.
        return sendToChief(question || "What's your take on the conversation so far?", before, {
          capture,
          turn,
        });
      }
      if (r.kind === "voice") {
        return sendToVoice(r.handle, question || "What's your perspective on the conversation so far?", before, {
          capture,
          turn,
        });
      }
      return sendToClaude(question, before, { capture, interject: !chiefExplicit });
    });
    await Promise.allSettled(jobs);
    if (turnSeqRef.current === turn) setSending(false);
  };

  // --- composer send + key handling -------------------------------------------------------
  // Attached capture screenshots go into the dispatched turn as `[Screenshot: <path>]` lines
  // (see attachedShots above) — an image alone is sendable, matching the capture modal's rule.
  const send = () => {
    const typed = input.trim();
    if ((!typed && attachedShots.length === 0) || sending) return;
    // Locked (trial / no credits): show the buy-to-use notice WITHOUT clearing the composer or
    // firing a backend, so the typed text + attachments survive for a real send after buying.
    if (aiFeatureLockedNow("brainstorm")) {
      setShowLockedNotice(true);
      return;
    }
    const prompt = composeThinkTurn(typed, attachedShots.map((a) => a.path));
    setInput("");
    setAttachedShots([]);
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
    const seq = ++planSeqRef.current;
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
      if (planSeqRef.current !== seq) return; // user cancelled while we were working — drop the result
      // The Think agent becomes the epic — the through-line into Plan and Build.
      useProjectStore.getState().renameAgent(project.id, agentId, res.epicTitle);
      setNotice(
        `Plan ready — epic ${res.epicId} with ${res.taskIds.length} task(s). Opening the Plan tab…`,
      );
      // Hand off: take the user to the Plan tab where the epic + beads are waiting.
      useUiStore.getState().setWorkMode("plan");
    } catch (e) {
      if (planSeqRef.current !== seq) return; // cancelled — a late failure shouldn't clobber the UI
      setNotice("");
      setError(friendlyError(e));
    } finally {
      if (planSeqRef.current === seq) setPlanning(false);
    }
  }

  // Back out of an in-flight "Make a Plan": bump the token (so the pending synthesis/generation is
  // ignored when it resolves) and reset the UI immediately. The founder was left stuck on
  // "Making a plan…" with no way out; this is the escape hatch.
  function cancelPlan() {
    planSeqRef.current++;
    setPlanning(false);
    setNotice("");
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

  // A terminal-selection action (or the capture modal) queued a prompt for this project's think
  // agent. Capture handoffs also carry screenshots — surfaced as pills above the composer.
  useEffect(() => {
    if (!handoff || handoff.projectId !== project.id) return;
    const { text, autoSend, attachments } = handoff;
    clearHandoff();
    if (autoSend) {
      // Compose the screenshot refs straight into the auto-sent turn (roborev 25166/25167) — do
      // NOT stage them as pills, or they'd silently ride the user's next, unrelated send. This
      // also makes an image-only autoSend (text: "") dispatch, matching send()'s rule.
      void dispatch(composeThinkTurn(text, attachments?.map((a) => a.path) ?? []));
    } else {
      if (attachments?.length) {
        setAttachedShots((prev) => [
          ...prev,
          ...attachments.map((a) => screenshotAttachment(a.path, a.dataUrl)),
        ]);
      }
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
              ? "Sparkle, with Chief in the room"
              : "Sparkle"
            : claudeReady === "checking"
            ? "starting Sparkle…"
            : "Sparkle not found"}
        </span>
      </div>

      {/* Transcript */}
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: 16 }}>
          {messages.length === 0 && (
            <div style={{ color: C.muted, fontSize: 13, lineHeight: 1.6, maxWidth: 580 }}>
              Talk to <strong>Sparkle</strong> about <strong>{project.name}</strong> — ask
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
      {showLockedNotice && thinkLocked && (
        <div style={{ padding: "0 16px 8px" }}>
          <AiLockedNotice label="Buy Sparkle to think with AI." />
        </div>
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
        {(() => {
          // While planning, the button becomes a Cancel (the notice line above carries the progress
          // text), so a slow synthesis can never leave the founder stuck with no way out.
          const idleDisabled = messages.length === 0 || !chiefEnabled;
          const disabled = !planning && idleDisabled;
          return (
            <button
              onClick={() => (planning ? cancelPlan() : void handleMakeAPlan())}
              disabled={disabled}
              title={
                planning
                  ? "Cancel making the plan"
                  : chiefEnabled
                  ? "Synthesize this conversation into an epic + tasks and open the Plan tab"
                  : "Connect Chief to make a plan"
              }
              style={{
                background: planning ? C.sienna : idleDisabled ? C.forest : C.teal,
                color: disabled ? C.muted : C.cream,
                border: `1px solid ${planning ? C.sienna : idleDisabled ? C.forest : C.teal}`,
                borderRadius: 8,
                padding: "6px 16px",
                fontSize: 13,
                fontWeight: FONT_WEIGHT.semibold,
                cursor: disabled ? "default" : "pointer",
              }}
            >
              {planning ? "Cancel" : "Make a Plan"}
            </button>
          );
        })()}
      </div>

      {/* Composer (with the @-mention picker floating above it) */}
      <div style={{ position: "relative", padding: 12, borderTop: `1px solid ${C.deepForest}` }}>
        {attachedShots.length > 0 && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            {attachedShots.map((a) => (
              <CaptureShotPill
                key={a.id}
                att={a}
                onRemove={() => setAttachedShots((prev) => prev.filter((x) => x.id !== a.id))}
              />
            ))}
          </div>
        )}
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
            {/* Composer: a transparent-text <textarea> over a styled highlight overlay, so @mentions
                render teal + bold as you type. The textarea still owns the raw text (incl. the "@")
                and the caret; the overlay just paints. Empty → textarea shows its own text/placeholder
                (no overlay needed), so the native placeholder color isn't clobbered by transparency. */}
            <div
              style={{
                position: "relative",
                background: C.deepForest,
                border: `1px solid ${C.forest}`,
                borderRadius: 8,
              }}
            >
              <div
                ref={overlayRef}
                aria-hidden
                style={{
                  position: "absolute",
                  inset: 0,
                  overflow: "hidden",
                  pointerEvents: "none",
                  whiteSpace: "pre-wrap",
                  color: C.cream,
                  ...COMPOSER_TYPO,
                }}
              >
                <MentionText text={input} stripAt={false} />
                {"\u200b" /* trailing zero-width space keeps a final newline's line height */}
              </div>
              <textarea
                ref={inputRef}
                className="think-composer-input"
                value={input}
                onChange={onComposerChange}
                onKeyDown={onComposerKeyDown}
                onClick={(e) =>
                  refreshPicker(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)
                }
                onScroll={(e) => {
                  if (overlayRef.current) overlayRef.current.scrollTop = e.currentTarget.scrollTop;
                }}
                placeholder={
                  liveActive
                    ? MIC_HOT_PLACEHOLDER
                    : livePassive
                    ? WAKE_PLACEHOLDER
                    : `Talk to Sparkle about ${project.name}…  (type @ for voices)`
                }
                rows={2}
                style={{
                  position: "relative",
                  display: "block",
                  width: "100%",
                  resize: "none",
                  background: "transparent",
                  // Hide the raw text (the overlay paints it) but keep the caret + placeholder visible.
                  color: input ? "transparent" : C.cream,
                  caretColor: C.cream,
                  border: "none",
                  outline: "none",
                  ...COMPOSER_TYPO,
                }}
              />
            </div>
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
            disabled={!sending && !input.trim() && attachedShots.length === 0}
            title={sending ? "Stop the current turn" : "Send"}
            style={{
              alignSelf: "stretch",
              background: sending
                ? C.sienna
                : input.trim() || attachedShots.length > 0
                ? C.teal
                : C.forest,
              color: C.cream,
              border: "none",
              borderRadius: 8,
              padding: "0 18px",
              fontWeight: FONT_WEIGHT.semibold,
              cursor:
                !sending && !input.trim() && attachedShots.length === 0 ? "default" : "pointer",
            }}
          >
            {sending ? "Stop" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

// A capture screenshot riding with the draft — AttachmentTile's visual language (46px image
// tile, thin border, floating × remove) at the app-wide 4px radius. Read-only beyond remove:
// no lightbox/multi-select here, the Think composer just needs the "this image is attached" cue.
function CaptureShotPill({ att, onRemove }: { att: Attachment; onRemove: () => void }) {
  return (
    <div style={{ position: "relative", lineHeight: 0 }}>
      <div
        title={att.path}
        style={{
          height: 46,
          maxWidth: 120,
          display: "flex",
          alignItems: "center",
          borderRadius: 4,
          border: `1px solid ${C.forest}`,
          overflow: "hidden",
          boxSizing: "border-box",
          background: C.deepForest,
        }}
      >
        {att.dataUrl ? (
          <img
            src={att.dataUrl}
            alt={att.name}
            style={{ height: "100%", maxWidth: 118, objectFit: "cover", display: "block" }}
          />
        ) : (
          <span
            style={{
              padding: "0 8px",
              color: C.cream,
              fontSize: 11,
              fontWeight: FONT_WEIGHT.semibold,
              fontFamily: '"IBM Plex Sans", sans-serif',
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              lineHeight: 1.2,
            }}
          >
            {att.name}
          </span>
        )}
      </div>
      <button
        onClick={onRemove}
        title="Remove"
        style={{
          position: "absolute",
          top: -6,
          right: -6,
          width: 18,
          height: 18,
          borderRadius: 4,
          background: C.sienna,
          color: C.cream,
          border: "none",
          cursor: "pointer",
          fontSize: 12,
          lineHeight: "18px",
          padding: 0,
        }}
      >
        ×
      </button>
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
  return "Sparkle";
}

// Memoized: the message list re-renders on every streaming token (patchMsg replaces the messages
// array), but patchMsg preserves object identity for every message EXCEPT the one being patched, so
// a shallow-equal memo re-renders only the streaming bubble — the rest (and their markdown parse)
// are skipped. Without this, an N-message conversation re-parsed all N bubbles' markdown per token.
const Bubble = memo(function Bubble({ msg }: { msg: ChatMsg }) {
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
            <span style={{ fontSize: 14, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
              <MentionText text={msg.text} stripAt />
            </span>
          ) : (
            <Markdown text={msg.text} />
          )}
        </div>
      </div>
    </div>
  );
});
