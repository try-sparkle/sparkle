// ConciergeHost — the integration layer (bead sparkle-qd80 / CM-U7) that turns the presentational
// ConciergeColumn (CM-U1) into the live, cross-project concierge: it builds the view-model from the
// real status-band feed (CM-U3), streams the headless brain (CM-U2) into the thread, and routes the
// user's answers into the right agent's terminal via the dispatch relay (CM-U4).
//
// Mounted UNCONDITIONALLY as the persistent left column of the workspace — the concierge IS the
// experience, not a flagged addition to an older UI (PRD/sparkle/concierge-mode.md §6). It owns
// all concierge state; the column stays a pure renderer. The status-band feed is built ONCE by
// Workspace (it drives the tab badges too) and passed in, so there is a single subscription, a
// single tray-roster fetch, and no chance of the tab counts and the vitals line disagreeing.
//
// The voice pass (bead sparkle-4562.2 / CM-U9) is wired here too, both directions: the mic borrows
// the app-wide dictation target (useConciergeDictation) while the user talks, and a finished brain
// reply is spoken back through services/conciergeVoice. Autoplay is narrow ON PURPOSE — only a turn
// the user STARTED by voice is spoken, and only while the do-not-interrupt store allows it. Every
// reply also carries a speaker button, which is how a typed turn gets read aloud.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ConciergeColumn,
  deriveWordmarkMode,
  type ConciergeMessage,
  type ConciergeNudge,
  type ConciergeNudgeAction,
  type ConciergeSparkleMessage,
  type ConciergeViewModel,
} from "./Concierge";
import type { ConciergeAgent, ConciergeFeed } from "../useConciergeFeed";
import { bandCountLabel, bandLabel } from "../engine/statusBandLabels";
import { oneLine } from "./promptHistory";
import { openProjectTab } from "../services/openProjectTab";
import {
  onConciergeDelta,
  onConciergeDone,
  onConciergeError,
  startConciergeTurn,
} from "../services/concierge";
import {
  dispatchConciergeAnswer,
  onDeferredSendOutcome,
  type ConciergeDispatchPath,
  type ConciergeDispatchResult,
} from "../services/conciergeDispatch";
import { attachedDisplay, attachedPayload } from "../services/conciergeAttach";
import { useConciergeAttachments } from "../hooks/useConciergeAttachments";
import type { Attachment } from "./composer/attachments";
import {
  shouldSpeakConciergeReply,
  speakConciergeReply,
  speakOnDemand,
  stopConciergeVoice,
} from "../services/conciergeVoice";
import { maybePauseOnSubmit } from "../services/dictationControls";
import { useConciergeDictation } from "../useConciergeDictation";
import { useSparklePrefsStore } from "../stores/sparklePrefsStore";
import { useSpendPill } from "../stores/spendStore";

let seq = 0;
const nextId = (p: string) => `${p}-${(seq += 1)}`;

/** What the concierge says when the server has refused the send: the free trial is spent. The
 *  dispatch path gates BEFORE delivery (services/trialMeter.trialSendAllowed), so nothing reached
 *  the agent — say so plainly rather than leaving the user waiting on a reply that isn't coming. */
export const TRIAL_SPENT_TEXT =
  "Your free trial is used up, so that didn't send. Upgrade and I'll pass it straight through.";

/** The two voices a non-delivery is reported in: the nudge card's Approve relay, and the compose
 *  box's user-authored prompt. Same facts, different remedy — "hit Retry" vs "then send again". */
type RefusalVoice = "approval" | "prompt";

/** The paths that mean NOT DELIVERED. `picker-option`/`free-text` are excluded because they DID
 *  land; `queued` because it means HELD — the callers report that themselves, but only when `ok`,
 *  so an `ok:false` queued result DOES reach `refusedPath` and comes back `null` for the generic
 *  line (roborev 53044). Narrowing the parameter this way means handing a delivered path to
 *  `refusalCopy` is a compile error at the call site rather than a misleading generic
 *  "I couldn't send…" — the very dead end it exists to remove (roborev 52972). */
type RefusedPath = Exclude<ConciergeDispatchPath, "picker-option" | "free-text" | "queued">;

/**
 * The refusal path of a result that did NOT deliver — or `null` when it did.
 *
 * `ok` stays the ONLY test for delivery. An earlier pass got the narrowing by widening the callers'
 * success branch to `r.ok || r.path === "picker-option" || r.path === "free-text"`, which inverted
 * that: an `{ ok: false, path: "free-text" }` would have reported "Sent to X." and, in
 * `promptAgent`, returned true — DISCARDING the user's draft on a failure that used to restore it
 * (roborev 53018). A cosmetic risk is not worth a real one. This predicate gives the same
 * compile-time proof with `ok` still in charge.
 */
function refusedPath(r: ConciergeDispatchResult): RefusedPath | null {
  if (r.ok) return null;
  switch (r.path) {
    // ok:false on a path that means "delivered" is a contradiction the type system can't yet rule
    // out (ok and path are independent fields). Treat it as a plain refusal with no bespoke line
    // rather than as a success — the user keeps their draft either way.
    case "picker-option":
    case "free-text":
      return null;
    // `queued` means HELD, not delivered — reachable here precisely BECAUSE the callers gate their
    // held branch on `ok`. An ok:false hold is not a hold, so it takes the generic refusal line.
    case "queued":
      return null;
    default:
      return r.path;
  }
}

/** THE one place a refused dispatch path becomes user-facing copy.
 *
 *  `approve` and `promptAgent` used to carry two near-identical `else if` ladders over the same
 *  paths, and they drifted exactly as you'd expect: the truthful `agent-failed`/`cloud-agent` lines
 *  landed on the prompt side a full commit before the approval side, so approving on a cloud agent
 *  gave the generic "I couldn't send…" dead end for a week. An exhaustive `switch` makes that
 *  impossible — a path added to ConciergeDispatchPath is a TYPE ERROR here (the `never` guard in
 *  `default`) instead of a silent fall-through to the generic line.
 *
 *  Only NON-delivery is handled: the callers report the delivered/held paths themselves, because
 *  what they do there differs (approve returns void; promptAgent returns whether to keep the draft). */
function refusalCopy(path: RefusedPath | null, name: string, voice: RefusalVoice): string {
  const approving = voice === "approval";
  const generic = approving ? `I couldn't send the approval to ${name}.` : `I couldn't send that to ${name}.`;
  if (path === null) return generic; // refused on a delivered-looking path — see refusedPath
  switch (path) {
    case "trial-spent":
      return TRIAL_SPENT_TEXT;
    case "agent-failed":
      return approving
        ? `${name} couldn't start, so I couldn't send the approval — open its pane and hit Retry.`
        : `${name} couldn't start, so that didn't send — open its pane and hit Retry (or finish installing Claude Code), then send again.`;
    case "cloud-agent":
      return approving
        ? `${name} runs in the cloud — I can't relay the approval from here yet; answer it in its own pane.`
        : `${name} runs in the cloud, and prompting cloud agents from here isn't wired up yet — use its own pane for now.`;
    case "pty-gone":
      return approving
        ? `${name}'s terminal has closed — I couldn't send the approval.`
        : `${name}'s terminal has closed — that didn't send. Start it again and I'll pass it along.`;
    case "ambiguous-picker":
      return approving
        ? `${name} is asking something I can't answer with a plain "approve" — open it to choose.`
        : `${name} is waiting on a choice I can't map that to — open it and pick, or answer with just the option.`;
    // No bespoke line: "empty" is a blank answer the UI already swallows, and "expired"/"abandoned"
    // are DEFERRED outcomes reported by the onDeferredSendOutcome effect below, never returned to a
    // caller synchronously. They are listed rather than folded into `default` on purpose — `default`
    // has to stay unreachable for the exhaustiveness guard to have any teeth.
    case "empty":
    case "expired":
    case "abandoned":
      return generic;
    default: {
      const unhandled: never = path;
      void unhandled;
      return generic;
    }
  }
}

/** Flatten every agent across the feed (used to resolve a nudge back to its source agent). */
function allAgents(feed: ConciergeFeed): ConciergeAgent[] {
  return feed.projects.flatMap((p) => p.agents);
}

/** The agents the concierge should surface right now: in scope, un-muted, needing you.
 *
 *  `band === "needs_you"` is the interruption gate. It covers exactly what the old `priority < 2`
 *  did — waiting, approval, blocked, errored — and, critically, still excludes `unmerged`, which
 *  bands `done`. On the reported fleet 27 of 51 agents were committed-but-unlanded; surfacing them
 *  here is 27 nudge cards (see services/conciergeFeed.conciergeBand). */
function surfacedAgents(feed: ConciergeFeed): ConciergeAgent[] {
  return allAgents(feed).filter((a) => a.inScope && !a.muted && a.band === "needs_you");
}

function actionsFor(a: ConciergeAgent): ConciergeNudgeAction[] {
  const show: ConciergeNudgeAction = { id: "show", label: "Show me" };
  const mute: ConciergeNudgeAction = { id: "mute", label: "Mute", kind: "ghost" };
  // The primary (gold) action is Approve when the agent is blocked on an approval prompt (one-tap
  // relay into its terminal); otherwise it's Show me. Show me is plain when Approve is the primary.
  if (a.status === "approval") {
    return [{ id: "approve", label: "Approve", kind: "primary" }, show, mute];
  }
  return [{ ...show, kind: "primary" }, mute];
}

function agentToNudge(a: ConciergeAgent): ConciergeNudge {
  return {
    id: a.id, // the source agent id — resolved back via the feed on click/action
    kind: "nudge",
    band: a.band,
    projectName: a.projectName,
    agentName: a.name,
    text: `${a.statusLabel} — ${a.name} in ${a.projectName}.`,
    actions: actionsFor(a),
  };
}

/** Compact context handed to the headless brain so its reply is grounded in what's actually happening. */
function buildSnapshot(feed: ConciergeFeed, userText: string): string {
  const surfaced = surfacedAgents(feed);
  const lines = surfaced.map(
    (a) => `- [${a.projectName}] ${a.name}: ${a.statusLabel} (${bandLabel(a.band)})`,
  );
  // Keep the project count SCOPED to what's actually surfaced so it can't misstate scope (e.g. say
  // "5 projects" while only counting in-scope agents).
  const scopedProjects = new Set(surfaced.map((a) => a.projectId)).size;
  const state =
    surfaced.length > 0
      ? `${bandCountLabel("needs_you", feed.scopedCounts.needs_you)} across ${scopedProjects} project(s):\n${lines.join("\n")}`
      : `All projects are calm right now.`;
  return `${state}\n\nThe user says: ${userText}\n\nReply briefly and recommend the next action.`;
}

/** The agent a compose-box send would reach when the target is "agent": the selected tab's
 *  selected agent. Null when there's no project open or no agent selected. */
export interface ConciergePromptTarget {
  projectId: string;
  agentId: string;
  name: string;
}

export function ConciergeHost({
  feed,
  promptTarget = null,
  promptTargetUnavailableReason,
  width,
  searchSlot,
}: {
  /** The cross-project status-band feed, built once by Workspace (see the file header). */
  feed: ConciergeFeed;
  /** The agent the compose box can prompt directly; null → the box only talks to Sparkle. */
  promptTarget?: ConciergePromptTarget | null;
  /** Why promptTarget is null even though an agent IS selected (e.g. a cloud agent) — shown on
   *  the disabled send-target toggle instead of the misleading "no agent selected". */
  promptTargetUnavailableReason?: string;
  width?: number;
  /** The shell's ⌘K palette trigger, rendered under the scope/vitals line (PRD §4). */
  searchSlot?: ReactNode;
}) {
  // Latest feed for the event handlers (send/nudge actions), which run after render.
  const feedRef = useRef(feed);
  useEffect(() => {
    feedRef.current = feed;
  }, [feed]);

  const [chat, setChat] = useState<ConciergeMessage[]>([]);
  // What the thread's hidden live region says. Written ONLY with finished lines — a completed brain
  // reply, or a status notice — because a value that changed per streamed chunk would hand a screen
  // reader one announcement per delta, the flooding this region exists to avoid (roborev 53010).
  const [announcement, setAnnouncement] = useState("");
  const [typing, setTyping] = useState(false);
  // The mic is the dictation hook's now (CM-U9) — it owns armed state, the app-wide dictation
  // target and the live interim transcript, so there is no local micLive to keep in sync.
  const dictation = useConciergeDictation();
  const { micLive, toggleMic, registerInsert: dictationRegisterInsert } = dictation;
  // Read at send time by the (memoised) controller, which must not be rebuilt on every mic flip.
  const micLiveRef = useRef(micLive);
  useEffect(() => {
    micLiveRef.current = micLive;
  }, [micLive]);

  // The reply currently being spoken, so exactly one speaker button reads as active.
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const speakingIdRef = useRef<string | null>(null);
  useEffect(() => {
    speakingIdRef.current = speakingId;
  }, [speakingId]);

  // The brain text accumulated for the in-flight turn, keyed by turn id. Kept in a ref rather than
  // re-derived from the rendered thread so the done handler can hand TTS the WHOLE reply.
  const brainTextRef = useRef<Record<string, string>>({});
  // The newest turn id seen from the brain stream, as a number (see supersededTurn below).
  const latestTurnRef = useRef(-1);
  // Every turn up to and including this id has been superseded by a send. See supersededTurn.
  const retireThroughRef = useRef(-1);
  // Was the turn in flight started by voice? Only such a turn is spoken back unprompted.
  const voiceTurnRef = useRef(false);
  // Set when a dictated segment reaches the compose box, and NOT cleared until the turn is sent.
  // Reading micLive at submit time would misclassify the common path: the stop word (and
  // pause-on-submit, and focus loss) drops the mic out of the routing state, so a fully dictated
  // turn would look typed and its reply would silently never be spoken.
  const dictatedRef = useRef(false);
  // Monotonic send counter: lets an async send outcome know whether it is still the latest turn.
  const sendSeqRef = useRef(0);

  const registerInsert = useCallback(
    (append: ((text: string) => void) | null) => {
      // A box going away takes the latch with it (roborev 46922): the ComposeBox resets its own
      // `text` on remount, and a latch that outlived the words that set it would make the next
      // TYPED turn look dictated.
      if (append === null) dictatedRef.current = false;
      dictationRegisterInsert(
        append === null
          ? null
          : (text: string) => {
              dictatedRef.current = true;
              append(text);
            },
      );
    },
    [dictationRegisterInsert],
  );

  // The dictated-origin latch is retired the moment the user empties the box by hand — otherwise
  // dictating a segment, deleting it, and typing a fresh message would speak the reply to a turn
  // the user typed, which is the exact inverse of the misclassification the latch exists to fix
  // (roborev 46922). Only hand edits report here; a dictated segment does not.
  const onTextEdit = useCallback((text: string) => {
    if (text.trim() === "") dictatedRef.current = false;
  }, []);

  const play = useCallback(async (id: string, text: string, mode: "auto" | "demand") => {
    // Pre-check the same pure gate speakConciergeReply applies, so a suppressed autoplay never
    // flashes the speaker button active for a reply that is not going to be spoken.
    if (mode === "auto" && !shouldSpeakConciergeReply({ voiceTurn: true })) return;
    // A new clip always supersedes the old one. Required, not defensive: the system-voice fallback
    // QUEUES utterances rather than replacing them, so without this, clicking the speaker on a
    // second reply would talk about the first one while the UI showed the second as active.
    stopConciergeVoice();
    setSpeakingId(id);
    try {
      if (mode === "auto") await speakConciergeReply(text, { voiceTurn: true });
      else await speakOnDemand(text);
    } finally {
      // Only clear if we are still the clip that is playing — a newer speak has already taken over.
      setSpeakingId((cur) => (cur === id ? null : cur));
    }
  }, []);

  // Files staged for the NEXT send (parity row #21): the compose box's attach buttons, and a file
  // dropped on the box. The four handlers are stable, so the controller memo below can depend on
  // them; only `attachments`/`dropActive` change per render.
  const {
    attachments,
    dropActive,
    attach,
    remove: removeAttachment,
    take: takeAttachments,
    restore: restoreAttachments,
  } = useConciergeAttachments();
  // Where the compose box aims. The AGENT IS PINNED at the moment the user flips the toggle, not
  // resolved at send time: selection moves for reasons that have nothing to do with the box (a
  // nudge's "Show me", a notification reveal, a tab click), so a live lookup would deliver a
  // paragraph the user typed for one agent into whichever agent happened to be selected when they
  // pressed Send. Null = talking to Sparkle.
  const [aimedAt, setAimedAt] = useState<ConciergePromptTarget | null>(null);
  // The aim, DROPPED when the agent it names is gone (closed, deleted, its project removed). The
  // feed carries every project's every agent, so absence from it IS "no longer exists" — and
  // leaving a pinned name on the pill for an agent that can't receive anything would be a lie.
  // Derived rather than cleared in an effect: an effect would paint one frame with the dead aim
  // still on the pill, and a send in that frame would route at a corpse.
  const aim = useMemo(
    () => (aimedAt && allAgents(feed).some((a) => a.id === aimedAt.agentId) ? aimedAt : null),
    [aimedAt, feed],
  );
  // Latest aim for the handlers, which are memoized on stable deps and run after render (same
  // pattern as feedRef above).
  const targetRef = useRef(promptTarget);
  const aimedAtRef = useRef(aim);
  useEffect(() => {
    targetRef.current = promptTarget;
    aimedAtRef.current = aim;
  }, [promptTarget, aim]);

  // Stream the brain into the thread: deltas append to a bubble keyed by the turn id; done finalizes.
  useEffect(() => {
    const key = (id: string) => `brain-${id}`;
    // TRUE when this event belongs to a turn the user has already moved past. NOT a pure
    // predicate: on the way to `false` it also adopts a newer turn (advancing `latestTurnRef`) and
    // retires its predecessors' accumulated text. Named for what it RETURNS — an `admitTurn` that
    // returned true for "rejected" made every call site read backwards, which is the kind of thing
    // the next handler gets silently wrong (roborev 53051).
    //
    // DEFENCE IN DEPTH, not the primary guard (roborev 53088/53105/53130). concierge.rs retires a
    // superseded turn at the SEND — before the replacement child is even spawned — and its reader
    // goes silent at the source, so these events should not arrive at all. This keeps the frontend
    // honest about ids anyway: it is the layer that knows which bubble is which.
    //
    // Turn ids ARE the backend's monotonic token (`token.to_string()`), so "newer" is a numeric
    // comparison, not a guess. A straggler from an older turn is dropped whole: it must not
    // accumulate, must not wipe the live turn's text, and above all must not consume the live
    // turn's `voiceTurnRef` or clear its typing indicator. Ids that aren't numbers are local
    // errors (CONCIERGE_LOCAL_ERROR_ID) and always surface.
    const supersededTurn = (id: string): boolean => {
      // Strictly a token, not "anything Number() will swallow" (roborev 53004): Number("") is 0 and
      // Number(" 5 ") is 5, so a malformed id would quietly become a turn number instead of taking
      // the local-error path it resembles.
      if (!/^\d+$/.test(id)) return false;
      const n = Number(id);
      // `retireThrough` is what closes the straggler WINDOW (roborev 53004/53051). Advancing only when a
      // newer turn's event arrives leaves exactly the wrong gap open: the backend kills the old
      // child at send time and its reader flushes buffered stdout immediately, while the new turn
      // still has to spawn `claude` and wait on the model. Those late events carry the OLD id, so
      // "newer than anything I've seen" would call them live. Sending retires everything up to and
      // including the newest id seen so far, which is the old turn by construction.
      if (n <= retireThroughRef.current) return true;
      if (n < latestTurnRef.current) return true;
      if (n > latestTurnRef.current) {
        latestTurnRef.current = n;
        // A genuinely newer turn retires its predecessors' accumulated text. Doing it HERE rather
        // than at send time is what keeps a turn that is still streaming from being truncated
        // into TTS (roborev 49293/49294).
        for (const k of Object.keys(brainTextRef.current)) if (k !== id) delete brainTextRef.current[k];
      }
      return false;
    };
    const upsert = (id: string, text: string, replace: boolean) => {
      const prior = brainTextRef.current[id] ?? "";
      brainTextRef.current[id] = replace ? text : prior + text;
      setChat((prev) => {
        const k = key(id);
        const i = prev.findIndex((m) => m.id === k);
        if (i === -1) return [...prev, { id: k, kind: "sparkle", text, speakable: true }];
        const next = prev.slice();
        const cur = next[i]!;
        next[i] = {
          ...cur,
          kind: "sparkle",
          text: replace ? text : (cur.text ?? "") + text,
          speakable: true,
        };
        return next;
      });
    };
    const offDelta = onConciergeDelta((e) => {
      if (supersededTurn(e.id)) return;
      upsert(e.id, e.text, false);
    });
    const offDone = onConciergeDone((e) => {
      if (supersededTurn(e.id)) {
        delete brainTextRef.current[e.id];
        return;
      }
      setTyping(false);
      if (e.text) upsert(e.id, e.text, true);
      const full = brainTextRef.current[e.id] ?? "";
      delete brainTextRef.current[e.id];
      // The reply is FINISHED here — announce it once, rather than per delta.
      if (full) setAnnouncement(full);
      const startedByVoice = voiceTurnRef.current;
      voiceTurnRef.current = false;
      if (startedByVoice && full) void play(key(e.id), full, "auto");
    });
    const offError = onConciergeError((e) => {
      if (supersededTurn(e.id)) {
        delete brainTextRef.current[e.id];
        return;
      }
      setTyping(false);
      voiceTurnRef.current = false;
      // A failed turn never reaches the done handler, so drop its partial text here rather than
      // retaining every failed reply for the life of the session.
      delete brainTextRef.current[e.id];
      setChat((prev) => [
        ...prev,
        {
          id: nextId("err"),
          kind: "sparkle",
          text: "I couldn't reach my brain just now — try me again in a moment.",
          speakable: false,
        },
      ]);
    });
    return () => {
      offDelta();
      offDone();
      offError();
    };
  }, [play]);

  const resolveAgent = useCallback(
    (id: string) => allAgents(feedRef.current).find((a) => a.id === id) ?? null,
    [],
  );

  // Every postSparkle line is BOOKKEEPING — a send outcome, a refusal, a deferred reconciliation —
  // never a brain reply, so none of them offer to be read aloud (speakable: false, roborev 48172).
  const postSparkle = useCallback((text: string) => {
    setChat((prev) => [
      ...prev,
      { id: nextId("sparkle"), kind: "sparkle", text, speakable: false },
    ]);
    // A send outcome is exactly what a screen-reader user needs told, and it arrives whole.
    setAnnouncement(text);
  }, []);

  // Files that rode a QUEUED send, per agent, oldest first. A queued send resolves ok:TRUE (it is
  // held, not lost), so the synchronous restore below never runs for it — and if the hold later
  // ages out or the terminal dies, the thread says "Send it again" while the attachments have
  // already been consumed and would have to be re-picked from disk (roborev 51594). Held here,
  // and handed back by the deferred-outcome handler on any non-delivery. One entry per queued
  // send, because an agent can have several waiting and each gets its own outcome.
  const heldAttachments = useRef<Map<string, Attachment[][]>>(new Map());
  /** Record what rode a QUEUED send — including NOTHING, which is the whole point of the queue
   *  being 1:1 (roborev 52969). Skipping the empty pushes made this a FIFO of batches popped by a
   *  FIFO of outcomes that counted differently: a queued Approve (or any queued send with no
   *  files) would pop — and drop — the batch belonging to a LATER send, losing the user's files
   *  exactly as before, or hand them back while their send was still held, so the next send
   *  delivered the same file twice. */
  const holdAttachments = useCallback((agentId: string, staged: Attachment[]) => {
    const q = heldAttachments.current.get(agentId) ?? [];
    q.push(staged);
    heldAttachments.current.set(agentId, q);
  }, []);
  /** Take back the oldest batch held for this agent (empty when it carried no files). */
  const takeHeldAttachments = useCallback((agentId: string): Attachment[] => {
    const q = heldAttachments.current.get(agentId);
    if (!q || q.length === 0) return [];
    const batch = q.shift()!;
    if (q.length === 0) heldAttachments.current.delete(agentId);
    return batch;
  }, []);

  // Relay an Approve into the agent's terminal and ALWAYS give the user feedback — a silent failure
  // (dead terminal, an ambiguous prompt) would leave them waiting. Also swallows the throwing path.
  //
  // userPrompt: FALSE — "approve" is machine-authored. When the picker has scrolled off this falls
  // through to the free-text path, and a one-word non-prompt must not enter the prompt history,
  // debit a free-trial prompt, or become the agent's auto-name (see services/conciergeDispatch).
  const approve = useCallback(
    async (a: ConciergeAgent) => {
      try {
        const r = await dispatchConciergeAnswer(a.id, "approve", { userPrompt: false });
        // "queued" is ok:true but NOT delivered — say so rather than claiming it was sent. The `ok`
        // conjunct is load-bearing: an ok:false queued result must NOT get the "I'll approve when
        // it's ready" promise, which would be the same lie the refusal paths exist to avoid — and
        // it must not take a hold slot either, since no deferred outcome is coming to pop it.
        if (r.ok && r.path === "queued") {
          // Carries no files, but DOES emit a deferred outcome — so it takes a slot in the hold
          // queue, or its outcome would pop the batch belonging to a later send (roborev 52969).
          holdAttachments(a.id, []);
          postSparkle(`${a.name} is still starting up — I'll approve as soon as it's ready.`);
        } else if (r.ok) postSparkle(`Approved — sent to ${a.name}.`);
        else postSparkle(refusalCopy(refusedPath(r), a.name, "approval"));
      } catch {
        postSparkle(`I couldn't reach ${a.name}'s terminal to approve.`);
      }
    },
    [postSparkle, holdAttachments],
  );

  // The composer's job, re-homed: deliver a USER-authored prompt into the PINNED agent's terminal,
  // with every side-effect the old AgentPane composer had (history, the pinned breadcrumb's
  // marker, ghost suggestions, the auto-name ladder, the trial meter) — that's what
  // `userPrompt: true` turns on. Every outcome is reported back into the thread, because this box
  // is the only place the user can see that a send didn't land.
  //
  // Resolves TRUE when the text is safely in the agent's hands (delivered or held) and FALSE when
  // it isn't, so the compose box can put the user's draft back rather than making them retype it —
  // exactly what the removed composer's restoreDraft did.
  const promptAgent = useCallback(
    async (
      target: ConciergePromptTarget,
      text: string,
      renderings: { display: string; namingBasis: string },
      /** What rode this send. REQUIRED (roborev 52969): a default would let a future call site
       *  silently hold nothing and re-introduce the lost-files bug with no type error. */
      staged: Attachment[],
    ): Promise<boolean> => {
      try {
        const r = await dispatchConciergeAnswer(target.agentId, text, {
          userPrompt: true,
          ...renderings,
        });
        // As in `approve`, `ok` gates the held branch: an ok:false queued result must not be
        // promised ("I'll send it when ready") NOR keep the draft-discarding `return true` — and
        // it must not hold the files either, since the refusal below restores them synchronously.
        if (r.ok && r.path === "queued") {
          // Held, not delivered: keep the files with the promise, so a hold that never lands can
          // give them back instead of quietly costing the user the picking (roborev 51594).
          holdAttachments(target.agentId, staged);
          postSparkle(`${target.name} is still starting up — I'll send that the moment it's ready.`);
          return true;
        }
        // `matchedLabel` is OPTIONAL on the result, so interpolating it unguarded would render the
        // literal `I answered "undefined".` — the same untrue report this ladder exists to avoid.
        // Today's only picker-option return always sets it; the type doesn't promise that, and a
        // second return site would ship the bad string silently (roborev 53097).
        //
        // Degrade WITHIN the branch rather than falling through: on picker-option the user's text
        // was NOT sent — dispatch matched it to a live option and wrote that option's keystroke —
        // so "Sent to X." would report the one thing that definitely didn't happen. Losing the
        // option's name is not the same as losing the fact that a question got answered
        // (roborev 53111).
        if (r.ok && r.path === "picker-option") {
          postSparkle(
            r.matchedLabel
              ? `${target.name} was asking something — I answered "${r.matchedLabel}".`
              : `${target.name} was asking something — I answered it.`,
          );
          return true;
        }
        if (r.ok) {
          postSparkle(`Sent to ${target.name}.`);
          return true;
        }
        postSparkle(refusalCopy(refusedPath(r), target.name, "prompt"));
        return false;
      } catch {
        postSparkle(`I couldn't reach ${target.name}'s terminal.`);
        return false;
      }
    },
    [postSparkle, holdAttachments],
  );

  // Reconcile the promise made when a prompt was QUEUED: the pane flushes it later (or the hold
  // ages out), and without this the user is told "I'll send it when it's ready" and then never
  // hears another word. Names the agent from the feed so the message reads like the others.
  useEffect(
    () =>
      onDeferredSendOutcome((r) => {
        const name = allAgents(feedRef.current).find((a) => a.id === r.agentId)?.name ?? "that agent";
        // The files that rode this held send: handed back when it never landed, dropped when it
        // did. Taken either way so the queue can't outlive the promise it belongs to.
        const held = takeHeldAttachments(r.agentId);
        if (!r.ok) restoreAttachments(held);
        // Quote the DISPLAY rendering, never `sent` — `sent` is the wire payload and carries the
        // attachments' temp paths (roborev 46925). Falls back to `sent` only when the dispatch
        // carried no separate display, i.e. nothing was attached.
        const shown = r.display ?? r.sent;
        const quoted = shown ? ` ("${oneLine(shown)}")` : "";
        // Each non-delivery says what actually happened; a wrong reason is its own small lie
        // (roborev 46485-M — `abandoned` used to be reported as "the terminal closed", which is
        // false when the spawn failed and no terminal ever opened).
        //
        // `pty-gone` is its OWN arm rather than the catch-all: the terminal-closed wording is a
        // specific claim, and letting any future path fall into it (say abandonPendingSends grows
        // an `agent-failed` emit) is how 46485-M happened the first time. An unknown path gets a
        // reason it can always stand behind (roborev 53162).
        if (r.ok) postSparkle(`${name} is up — I sent your message${quoted}.`);
        else if (r.path === "expired") postSparkle(`${name} never came up, so I dropped the message I was holding${quoted}. Send it again when it's running.`);
        else if (r.path === "abandoned") postSparkle(`${name} couldn't take the message I was holding${quoted}. Send it again once it's running.`);
        else if (r.path === "pty-gone") postSparkle(`${name}'s terminal closed before I could send the message I was holding${quoted}.`);
        // LEXICALLY distinct from the `abandoned` arm — "didn't", not "couldn't". Identical copy
        // silently un-pinned that arm once (roborev 53187), and merely dropping its remedy clause
        // left this string a strict PREFIX of it, so the two were separable only by a `$` anchor in
        // one test: any unanchored assertion written later would match both and lose the guarantee
        // again (roborev 53198). Different words cost nothing and don't depend on regex discipline.
        //
        // Reason only, no remedy: the paths that could land here need DIFFERENT next steps —
        // `agent-failed` wants a Retry, and a `cloud-agent` is never "running" locally at all — so
        // "send it again once it's running" would be an instruction that never comes true. Those
        // two are the known paths still routed here; neither reaches this listener today, and if
        // one starts to, it should get its own arm with its own remedy rather than this bare line.
        else postSparkle(`${name} didn't take the message I was holding${quoted}.`);
      }),
    [postSparkle, takeHeldAttachments, restoreAttachments],
  );

  const controller = useMemo(
    () => ({
      onSend: (text: string): void | Promise<boolean> => {
        // Was this turn SPOKEN? Decided before anything clears (the latch is consumed here), and
        // applied only on the brain path below — an agent prompt starts no brain turn to speak back.
        const spokenTurn = dictatedRef.current || micLiveRef.current;
        dictatedRef.current = false;
        // Which send this is, so a late async outcome can tell "still mine" from "superseded".
        const mySend = ++sendSeqRef.current;
        // Sending supersedes whatever Sparkle was saying.
        stopConciergeVoice();
        // Same courtesy the agent composer extends: honor the pause-on-submit voice setting so the
        // mic does not keep transcribing the room while the send is handled.
        maybePauseOnSubmit();
        // Take the staged files in the SAME tick the text leaves, so the next message starts clean
        // and a second Send can't deliver the same attachments twice.
        const staged = takeAttachments();
        // THREE renderings of one message, exactly as the removed composer built them:
        //   payload — the attachments' real paths prefixed to the text, for the PTY only;
        //   display — the typed text plus compact counts, for the thread AND every prompt-history
        //             surface (the pinned header, the history dropdown);
        //   text    — what the user actually typed, for naming and the ghost-text corpus. Empty on
        //             an attachments-only send, which is what makes auto-naming skip it.
        // The temp paths must never reach any of them but the first (roborev 46911/46925).
        const payload = attachedPayload(text, staged);
        const display = attachedDisplay(text, staged);
        setChat((prev) => [...prev, { id: nextId("you"), kind: "you" as const, text: display }]);
        // The PINNED aim (set when the toggle was flipped), read live from the ref because the
        // memo's deps are stable. Not `promptTarget` — see the aimedAt comment.
        const aim = aimedAtRef.current;
        if (aim) {
          // A prompt into an agent's terminal produces no brain reply, so nothing is queued to be
          // spoken — leaving the flag set would autoplay the NEXT brain turn the user typed.
          voiceTurnRef.current = false;
          return promptAgent(aim, payload, { display, namingBasis: text }, staged).then((ok) => {
            // A failed delivery must not cost the user their files any more than their words —
            // nor the fact that they SPOKE them. The box puts the draft back, and a restored
            // draft that reads as typed would silently never be spoken when the user re-aims it
            // at Sparkle: the exact misclassification the latch exists to prevent (roborev
            // 46922/48172/49293).
            if (!ok) {
              restoreAttachments(staged);
              // RE-ARM only — never clear (roborev 52363): the user may have dictated fresh speech
              // into the box while this send was in flight, and `spokenTurn === false` would wipe
              // a latch that belongs to those newer words. And only while THIS send is still the
              // latest: a turn sent after it has already made its own classification, which a late
              // failure must not overwrite (roborev 52362).
              if (spokenTurn && sendSeqRef.current === mySend) dictatedRef.current = true;
            }
            return ok;
          });
        }
        // A voice-started turn earns a spoken reply; a typed one stays silent (text-first v1).
        voiceTurnRef.current = spokenTurn;
        setTyping(true);
        // SENDING retires every turn seen so far, here as well as in the backend (see
        // supersededTurn). Their accumulated text is dropped as those events are rejected, not
        // wiped here — clearing the map at send would truncate a turn that is still legitimately
        // streaming.
        //
        // This floor can only retire ids we have SEEN an event for, so a turn killed before it
        // emitted anything is not covered by it; the returned token below closes that half. Both
        // are belt to concierge.rs's braces, which stops a superseded reader emitting at all
        // (roborev 53088/53105/53130).
        retireThroughRef.current = latestTurnRef.current;
        void startConciergeTurn(buildSnapshot(feedRef.current, payload)).then((id) => {
          const n = id !== null && /^\d+$/.test(id) ? Number(id) : null;
          if (n !== null) retireThroughRef.current = Math.max(retireThroughRef.current, n - 1);
        });
      },
      // Flip ON pins the CURRENTLY selected agent; flip OFF goes back to Sparkle. Pinning at flip
      // time is what makes the aim honest — nothing that moves the selection afterwards can
      // redirect a prompt the user typed for this agent.
      // Reads the LIVE (derived) aim, not the raw state: an aim whose agent has gone is already
      // showing as "Sparkle", so the next flip must PIN — not clear a pin nobody can see.
      onToggleSendTarget: () => setAimedAt(aimedAtRef.current ? null : targetRef.current),
      onMicToggle: toggleMic,
      onSpeak: (m: ConciergeSparkleMessage) => {
        if (speakingIdRef.current === m.id) {
          stopConciergeVoice();
          setSpeakingId(null);
          return;
        }
        void play(m.id, m.text, "demand");
      },
      onAttach: attach,
      onRemoveAttachment: removeAttachment,
      // PRD §3 (cross-project surfacing): clicking a nudge card "opens that project's tab,
      // switches to Build, and selects the referenced agent". openProjectTab does all three — the
      // tab select plus the shared reveal — so a nudge from a background project lands correctly.
      onNudgeClick: (n: ConciergeNudge) => {
        const a = resolveAgent(n.id);
        if (a) openProjectTab(a.projectId, a.id);
      },
      onNudgeAction: (n: ConciergeNudge, actionId: string) => {
        const a = resolveAgent(n.id);
        if (!a) return;
        if (actionId === "show") {
          openProjectTab(a.projectId, a.id);
        } else if (actionId === "approve") {
          void approve(a);
        } else if (actionId === "mute") {
          useSparklePrefsStore.getState().setInterruptPreference(a.id, "mute");
        }
      },
    }),
    [resolveAgent, approve, promptAgent, attach, removeAttachment, takeAttachments, restoreAttachments, toggleMic, play],
  );

  const pinnedProjectName = useMemo(() => {
    if (!feed.pinnedProjectId) return undefined;
    return feed.projects.find((p) => p.id === feed.pinnedProjectId)?.name;
  }, [feed]);

  // Live cross-project spend "today" (CM-U8): a shared 60s poll + focus refresh, pre-formatted as
  // "$X.XX" (or "$—" until the first read). See stores/spendStore.ts.
  const spendText = useSpendPill();

  const model: ConciergeViewModel = useMemo(() => {
    const nudges = surfacedAgents(feed).map(agentToNudge);
    return {
      scope: { pinnedProjectName },
      vitals: feed.scopedCounts,
      spend: { amountText: spendText },
      messages: [...chat, ...nudges],
      typing,
      // While aimed, the pill names the PINNED agent (the one a send actually reaches), not
      // whatever is selected right now. Un-aimed, it offers the current selection as the thing the
      // toggle would pin — and renders inert when there is nothing to pin.
      send: {
        target: aim ? ("agent" as const) : ("sparkle" as const),
        agentName: aim?.name ?? promptTarget?.name,
        unavailableReason: promptTargetUnavailableReason,
      },
      attachments,
      dropActive,
    };
  }, [feed, chat, typing, pinnedProjectName, spendText, promptTarget, promptTargetUnavailableReason, aim, attachments, dropActive]);

  return (
    <ConciergeColumn
      model={model}
      controller={controller}
      micLive={micLive}
      wordmarkMode={deriveWordmarkMode(micLive, typing)}
      width={width}
      searchSlot={searchSlot}
      interim={dictation.interim}
      registerInsert={registerInsert}
      speakingMessageId={speakingId}
      onTextEdit={onTextEdit}
      announcement={announcement}
    />
  );
}
