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
//
// AUTO-ROUTING (PRD/sparkle/concierge-auto-routing.md). The compose box no longer carries a target
// toggle: this host decides, per message, whether it goes to the selected agent's terminal or to
// Sparkle's chat (services/conciergeRouter — heuristics first, then one Haiku tiebreak). Three
// things make that defensible, and all three live in this file:
//   • every send posts a RECEIPT naming where it went, with a one-tap redirect (setReceipt);
//   • routing failure falls back to `sparkle`, the recoverable direction (the router's own rule);
//   • sends are SERIALIZED (enqueue), because routing is a network round trip and two messages
//     sent in quick succession would otherwise reach the PTY out of submit order.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  ConciergeColumn,
  deriveWordmarkMode,
  receiptText,
  type ConciergeAnnouncement,
  type ConciergeDigestMessage,
  type ConciergeMessage,
  type ConciergeNudge,
  type ConciergeNudgeAction,
  type ConciergeReceipt,
  type ConciergeSparkleMessage,
  type ConciergeViewModel,
} from "./Concierge";
import { ConciergeSuggestions } from "./Concierge/ConciergeSuggestions";
import type { ConciergeAgent, ConciergeFeed } from "../useConciergeFeed";
import type { AgentTabStatus } from "../types";
import { bandCountLabel, bandLabel } from "../engine/statusBandLabels";
import { oneLine } from "./promptHistory";
import { openProjectTab } from "../services/openProjectTab";
import {
  onConciergeDelta,
  onConciergeDone,
  onConciergeError,
  startConciergeTurn,
  isSupersededDetail,
} from "../services/concierge";
import {
  agentCanAcceptInput,
  answersLivePicker,
  dispatchConciergeAnswer,
  onDeferredSendOutcome,
  type ConciergeDispatchPath,
  type ConciergeDispatchResult,
} from "../services/conciergeDispatch";
import type { DispatchAuthority } from "../services/dispatchAuthority";
import {
  armIntent,
  armedIntents,
  cancelIntent,
  confirmIntent,
  countdownAnnouncement,
  resumeQueuedIntents,
  subscribeIntents,
} from "../services/dispatchIntent";
import { CountdownBanner } from "./Concierge/CountdownBanner";
import { routeMessage } from "../services/conciergeRouter";
import { buildDigest } from "../services/conciergeDigest";
import { createArrivalOrder, orderByArrival } from "../engine/conciergeStreamOrder";
import { useUiStore } from "../stores/uiStore";
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
import { useRuntimeStore } from "../stores/runtimeStore";
import { usePresenceStore, type PresenceMode } from "../stores/presenceStore";
// `setConciergeChat` is aliased to `setChat` AT THE IMPORT so it stays module-scoped: that is what
// keeps `react-hooks/exhaustive-deps` from demanding it in five dependency arrays below (a store
// setter isn't on the rule's known-stable list the way `useState`'s is, even though this one never
// changes identity). See the store for the full reasoning.
import { useConciergeThread, setConciergeChat as setChat } from "../stores/conciergeThreadStore";
import {
  buildRecap,
  recapSummary,
  type AwaySnapshot,
  type RecapAgentInfo,
} from "../services/conciergeRecap";

let seq = 0;
const nextId = (p: string) => `${p}-${(seq += 1)}`;

/** How many sent messages keep their original text for a possible redirect. Only the newest bubble
 *  is ever redirectable, so anything older is dead weight — and without a bound a long session with
 *  pasted content grows the map forever. Kept well above 1 so the map still reads as a short
 *  history rather than a single slot. */
export const SENT_TEXT_LIMIT = 50;

/**
 * Ceiling on a single queued delivery, so a hung one can't wedge the shared chain forever. Well
 * above any healthy send (routing has its own 4s deadline and a dispatch is local), so this only
 * ever fires on something genuinely stuck.
 *
 * KNOWN RESIDUAL, accepted deliberately. A race is not a cancellation: an overrun task keeps
 * running and could still reach the PTY after the queue has let later work past it — the reordering
 * the chain exists to prevent. Making the chain wait for the real task instead would fix that and
 * reintroduce the wedge this bound was added for (roborev 53119), where one hung delivery kills
 * Approve — the button whose job is unsticking a blocked agent — for the rest of the session. A
 * permanently dead Approve is worse than a pathological late write, so the bound stays and the
 * residual is documented rather than papered over. Cancellation at the dispatch layer is what would
 * actually resolve it.
 */
const QUEUE_TASK_TIMEOUT_MS = 30_000;

/** Remember `text` for `id`, evicting the oldest entries past the cap (Map preserves insertion
 *  order, so the first keys are the oldest). */
export function rememberSentText(map: Map<string, string>, id: string, text: string): void {
  map.set(id, text);
  while (map.size > SENT_TEXT_LIMIT) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

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
    case "unauthorized":
      // Should be unreachable: `authority` is required and non-defaulted, so a call site that omits
      // it does not compile. Reachable only if a malformed authority is built dynamically — a bug,
      // not a user error. Say the honest thing (it did NOT send) without inventing a remedy the
      // user could act on, and let the log line carry the diagnosis.
      return approving
        ? `Something went wrong on my side, so I didn't send the approval to ${name}.`
        : `Something went wrong on my side, so I didn't send that to ${name}. Try again.`;
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

/**
 * The fleet's statuses AS THE CARDS SEE THEM, for the Away recap's two edges.
 *
 * Read from the FEED, never from `runtimeStore.status`, and that is the whole point (roborev
 * 53631-H2). The feed's per-agent status is the DERIVED/published one — the cross-window merged
 * roster plus the unstarted-worker, red-worker, unmerged and dismissed-alert overlays
 * (services/conciergeFeed → publishedStatusFor) — and it is what every `statusLabel` and every
 * nudge card in this thread already speaks. Diffing the raw store against feed-supplied labels made
 * them two vocabularies, with two visible failures:
 *
 *   • `runtimeStore.status` only holds agents THIS window hosts (useConciergeFeed), so a
 *     roster-fed agent was absent from BOTH sides of the diff and `newlyEntered` skipped it — the
 *     recap said nothing about an agent in another window that went `waiting` while the same
 *     thread rendered a nudge card for it. On a concierge column pinned to a project this window
 *     does not host, the recap could never fire at all.
 *   • A red the user had DISMISSED reads de-escalated (`idle`/`stopped`) in the feed but still
 *     `waiting` in the raw store, so the recap filed it under "Wants you" while printing the feed's
 *     "Done — your turn" beside it — resurfacing an alarm the user had explicitly silenced.
 *
 * Building both sides here makes status, label and card one vocabulary by construction, and picks
 * up cross-window agents for free.
 */
function feedStatuses(feed: ConciergeFeed): Omit<AwaySnapshot, "at"> {
  const agents = allAgents(feed);
  return {
    status: Object.fromEntries(agents.map((a): [string, AgentTabStatus] => [a.id, a.status])),
    agentIds: agents.map((a) => a.id),
  };
}

/** EVERYTHING column one accounts for right now: in scope, un-muted, needing you, and not already
 *  spoken for by an ancestor's row.
 *
 *  `band === "needs_you"` is the interruption gate. It covers exactly what the old `priority < 2`
 *  did — waiting, approval, blocked, errored — and, critically, still excludes `unmerged`, which
 *  bands `done`. On the reported fleet 27 of 51 agents were committed-but-unlanded; surfacing them
 *  here is 27 nudge cards (see services/conciergeFeed.conciergeBand).
 *
 *  These are THE SAME THREE GATES `conciergeFeed` counts `scopedCounts` on, and that is the point:
 *  the vitals line states `scopedCounts.needs_you` while the thread renders this list, so they are
 *  one population by construction rather than two computations that have to be kept in step. They
 *  did drift — `scopedCounts` counted a red worker AND the orchestrator that inherited its red, so
 *  the line said "2 Need you" over a thread holding one card.
 *
 *  Note the remaining asymmetry is the SAFE direction. `muted` can make this set smaller than the
 *  rows the filter leaves standing, so the sentence can under-state. That is fine — every row it
 *  promised is there, plus one you asked not to be interrupted about. Over-stating is the bug,
 *  because the missing rows do not exist to be shown. */
function accountedAgents(feed: ConciergeFeed): ConciergeAgent[] {
  return allAgents(feed).filter(
    (a) => a.inScope && !a.muted && !a.representedElsewhere && a.band === "needs_you",
  );
}

/** The half of {@link accountedAgents} that is OWED A ROW in column two — the digest's pool.
 *
 *  `topLevel` is what makes the digest's number honest. Every LINE this feeds is clickable, and the
 *  click isolates that band in the Build column — which narrows top-level rows and nothing else.
 *  Folding a worker into a line's count would state a number the click cannot produce: two blocked
 *  workers rendered "2 Need you in web", and clicking it left an empty column plus an empty-state
 *  chip. */
function surfacedAgents(feed: ConciergeFeed): ConciergeAgent[] {
  return accountedAgents(feed).filter((a) => a.topLevel);
}

/** The other half: accounted-for agents with NO row of their own, which therefore have to speak for
 *  themselves.
 *
 *  They are digested by the SAME rule as everything else — one keeps its card, two or more become a
 *  line — but as the `rowless` variant, because a normal line's count is a promise about rows and
 *  these have none. This population is NOT bounded by one: gap 3 below fires once per blocked
 *  worker, so several under an absent or in-motion parent used to be several cards, which is the
 *  card wall the digest exists to prevent, reintroduced through the one path that skipped it.
 *
 *  What survives from the card era is the AFFORDANCE, not the shape: a single one still gets a card
 *  whose "Show me" reveals it (`openProjectTab` selects it, and the sidebar pops a red worker out
 *  under its orchestrator), and the collapsed line's click does that same reveal for its lead.
 *
 *  Non-empty only when a rowless agent's red reached nobody — a worker with no `parentId`, one whose
 *  orchestrator is not in the fleet, or a `blocked` one whose bubble `withRedWorkerAttention`
 *  suppressed while its orchestrator was in motion. Before this existed, the `topLevel` gate turned
 *  all three into silence: no row, no card, no line, no count. See
 *  `ConciergeAgent.representedElsewhere` for why the test is band equality and not kind. */
function unrepresentedAgents(feed: ConciergeFeed): ConciergeAgent[] {
  return accountedAgents(feed).filter((a) => !a.topLevel);
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
  // The FULL accounted population, rows and rowless alike — this states `scopedCounts.needs_you`
  // right below, and listing only the row-owning half would hand the brain a count it can't see the
  // items behind.
  const surfaced = accountedAgents(feed);
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
  promptTargetShown = true,
  width,
  searchSlot,
}: {
  /** The cross-project status-band feed, built once by Workspace (see the file header). */
  feed: ConciergeFeed;
  /** The SELECTED build agent, whether or not its pane is on screen. Drives the suggestions
   *  engine, which must keep running regardless of what the user is looking at. */
  promptTarget?: ConciergePromptTarget | null;
  /** Whether that agent's pane is actually SHOWN (not the Plan board / Improve Sparkle / a closed
   *  tab). Gates routing and the visibility of the recommended-action row — but NOT the engine.
   *
   *  The two are separate on purpose. This row is the only remaining host of `useSuggestions` for
   *  build agents, and that hook does more than render pills: auto-approve, auto-resume and the
   *  phone push all live inside it. Unmounting it whenever the user glances at the Plan board would
   *  silently stop a running agent from being auto-approved — a background convenience the user
   *  turned on precisely so agents don't stall — and resume on return. So the engine follows the
   *  SELECTION and only the rendering follows the VIEW (roborev 53074). */
  promptTargetShown?: boolean;
  width?: number;
  /** The shell's ⌘K palette trigger, rendered under the scope/vitals line (PRD §4). */
  searchSlot?: ReactNode;
}) {
  // Latest feed for the event handlers (send/nudge actions), which run after render.
  const feedRef = useRef(feed);
  // The thread's arrival ledger: which message ids have been seen, and in what order. A REF, not
  // state — it records history rather than driving a render, and the memo below reads it while
  // building. Assign-once semantics keep a digest that flickers (a group needs >= 2 agents, so it
  // collapses at 1 and re-forms at 2) from leaping to the bottom of the thread each time.
  const arrivalRef = useRef(createArrivalOrder());
  // Agents seen WORKING during the current away stretch — the recap's evidence that a finish was
  // real rather than an overlay repopulating (services/conciergeRecap.buildRecap sawWorking,
  // roborev 53669-M). Accumulated here because this effect is the only thing that observes the
  // MIDDLE of the stretch: the feed keeps updating while the window is blurred, whereas the
  // presence subscription only ever sees its two ends. Cleared at both edges by the recap effect.
  const sawWorking = useRef<Set<string>>(new Set());
  useEffect(() => {
    feedRef.current = feed;
    if (usePresenceStore.getState().mode !== "away") return;
    for (const a of allAgents(feed)) if (a.status === "working") sawWorking.current.add(a.id);
  }, [feed]);

  // The thread lives in a persisted store, not component state, so it SURVIVES AN APP RESTART
  // (spec §3 subsystem C2). `setChat` is the module-scoped setter imported above and keeps the same
  // signature, so every `setChat((prev) => …)` below is unchanged — see stores/conciergeThreadStore
  // for what reaches disk (conversation only; digests, nudges and the recap card are feed-derived).
  const chat = useConciergeThread();
  // What the thread's hidden live region says. Written ONLY with finished lines — a completed brain
  // reply, or a status notice — because a value that changed per streamed chunk would hand a screen
  // reader one announcement per delta, the flooding this region exists to avoid (roborev 53010).
  //
  // `{ seq, text }`, not a bare string (roborev 53392): every write must be a DISTINCT write, or an
  // identical repeat is invisible to both React and the assistive technology. See `announce` below.
  const [announcement, setAnnouncement] = useState<ConciergeAnnouncement>({ seq: 0, text: "" });
  /** Say this in the live region — even if it is word-for-word what was just said. The seq bump is
   *  the whole point: `setAnnouncement("Sent to X.")` twice in a row is an `Object.is`-equal
   *  setState React bails out of, so the second send to the same pinned agent was never announced
   *  at all (roborev 53392). Bumping a counter makes the state genuinely new; the column keys the
   *  rendered node on it so the DOM genuinely changes. */
  const announce = useCallback((text: string) => {
    setAnnouncement((prev) => ({ seq: prev.seq + 1, text }));
  }, []);
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

  // The compose box's own insert fn, kept so a send that dies AFTER the box already cleared can put
  // the user's words back. See `restoreDraft`.
  const insertRef = useRef<((text: string) => void) | null>(null);

  /**
   * Put a draft back in the compose box.
   *
   * Arming changed WHEN the box clears relative to when a send actually lands. `deliver` now
   * resolves true the moment an intent is armed, so ComposeBox has cleared long before a countdown
   * is cancelled or its delivery fails — its own "onSend resolved false → restore" path can no
   * longer cover either case, and without this the user silently loses what they typed.
   *
   * Best-effort by construction: an unmounted box simply drops it, and the words are still visible
   * in the thread bubble regardless. Takes the TYPED text, never the payload — restoring quoted
   * attachment temp paths into the box would be the leak roborev 46911/46925 removed.
   */
  const restoreDraft = useCallback((text: string) => {
    if (text.trim() === "") return;
    insertRef.current?.(text);
  }, []);

  const registerInsert = useCallback(
    (append: ((text: string) => void) | null) => {
      insertRef.current = append;
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
  // The agent a send could reach RIGHT NOW, dropped when it no longer exists (closed, deleted, its
  // project removed). The feed carries every project's every agent, so absence from it IS "no
  // longer exists" — routing at a corpse would report a delivery that never happened. Derived
  // rather than cleared in an effect: an effect would paint one frame with the dead target still
  // live, and a send in that frame would route at it.
  //
  // Resolved live at send time, NOT pinned. Pinning was the toggle's job: the user flipped it at a
  // moment they chose, so the aim had to be frozen then. With inference there is no such moment —
  // the message is about whatever the user is looking at when they press Send, which is exactly
  // what promptTarget tracks. The aim is still captured SYNCHRONOUSLY at submit (see `send`), so
  // nothing that moves the selection while a send is queued can redirect it.
  const target = useMemo(
    () =>
      promptTarget && allAgents(feed).some((a) => a.id === promptTarget.agentId)
        ? promptTarget
        : null,
    [promptTarget, feed],
  );
  // What a send may be ROUTED at: the shown agent only (see promptTargetShown). The suggestions row
  // below keys off `target` instead, because its engine must keep running off-screen.
  const routingTarget = promptTargetShown ? target : null;
  // Latest target for the handlers, which are memoized on stable deps and run after render (same
  // pattern as feedRef above).
  const targetRef = useRef(routingTarget);
  useEffect(() => {
    targetRef.current = routingTarget;
  }, [routingTarget]);
  // Latest thread, for redirect (which needs a message's current receipt without re-memoizing the
  // controller on every streamed delta).
  const chatRef = useRef(chat);
  useEffect(() => {
    chatRef.current = chat;
  }, [chat]);
  // The message text behind each routed bubble, so a redirect can re-send the ORIGINAL words
  // rather than reconstructing them from the rendered bubble. Keyed by message id; a ref because
  // nothing renders from it and it must survive without re-rendering the column.
  const sentTextRef = useRef<Map<string, string>>(new Map());
  // The agent-bound form of the same messages (text with attachment paths prefixed). Capped through
  // the SAME helper as sentTextRef so the two evict together — a bare set() left this one growing
  // for the whole session while every entry past the cap was already unreachable, since redirect
  // bails as soon as sentTextRef has evicted the id.
  const sentPayloadRef = useRef<Map<string, string>>(new Map());
  // Redirects currently in flight, so a double-tap can't deliver twice (see redirect).
  const redirectingRef = useRef<Set<string>>(new Set());
  // Approves currently in flight, per agent. Approve is deferred behind the send queue now, so a
  // click during a still-routing send produces no immediate delivery — and with no feedback the
  // natural reaction is to click again. A second queued approve lands AFTER the picker has already
  // been answered, where it answers whatever prompt comes next or is typed as free text
  // (roborev 53119). One in flight per agent, and the thread acknowledges the click immediately.
  const approvingRef = useRef<Set<string>>(new Set());
  // Serializes sends. Routing is ASYNC now (tier 2 is a network round trip), so two messages sent
  // in quick succession race: the second can classify faster than the first and reach the PTY
  // first, silently reordering the user's instructions. The toggle-era send had no await before
  // delivery and so couldn't do this. Each send chains onto the previous one's completion, which
  // guarantees delivery in SUBMIT order.
  const sendChainRef = useRef<Promise<unknown>>(Promise.resolve());

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
          // `cur` is always the sparkle bubble for this turn — it was found by the turn's own key —
          // but the union now contains a variant with no `text` at all (the recap card), so the
          // narrowing has to be explicit rather than a defensive `?? ""`.
          text: replace ? text : (cur.kind === "sparkle" ? cur.text : "") + text,
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
      // The reply is FINISHED here — announce it once, rather than per delta. Via `announce`, so
      // the SAME reply twice in a row is still spoken twice (roborev 53392).
      if (full) announce(full);
      const startedByVoice = voiceTurnRef.current;
      voiceTurnRef.current = false;
      if (startedByVoice && full) void play(key(e.id), full, "auto");
    });
    const offError = onConciergeError((e) => {
      if (supersededTurn(e.id)) {
        delete brainTextRef.current[e.id];
        return;
      }
      // A sentinel detail is never a failure to TELL the user about — it means their own newer send
      // (or cancel) displaced this turn, and that newer turn is the one streaming (roborev 53460).
      // `startConciergeTurn` already silences these on the invoke-rejection path; this closes the
      // EVENT path, which was unfiltered by detail and whose only guard was `supersededTurn` above —
      // and that guard misses a turn which failed before streaming anything, because the send-time
      // floor can only retire ids an event has been seen for.
      //
      // Deliberately does NOT clear typing, exactly as the superseded branch above doesn't: the
      // turn that displaced this one is still talking and owns the indicator.
      if (isSupersededDetail(e.detail)) {
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
  }, [announce, play]);

  const resolveAgent = useCallback(
    (id: string) => allAgents(feedRef.current).find((a) => a.id === id) ?? null,
    [],
  );

  /** Is this agent still in the feed? Absence IS "closed / deleted / project unloaded". */
  const agentStillExists = useCallback(
    (id: string | undefined) => !!id && allAgents(feedRef.current).some((a) => a.id === id),
    [],
  );

  /**
   * Run `fn` after every user-initiated delivery already queued, and resolve to its result.
   *
   * EVERY path that can write to a PTY on the user's behalf goes through here — compose sends,
   * redirects, recommended-action clicks, and nudge Approves. Serializing only the compose path
   * would make "delivery follows submit order" true of one surface and false of the app: a
   * recommended-action tap or a redirect click while a send was still routing would land ahead of
   * the earlier message.
   *
   * `.catch(() => onFailure)` is not decoration. Without it a rejecting delivery leaves a rejected
   * promise parked in the chain (an unhandled rejection if no further send follows) and hands that
   * rejection to ComposeBox, whose `.then(ok => …)` has no rejection arm — so the draft would NOT
   * be restored and the user's text would be lost, which is the exact failure the restore logic
   * exists to prevent. The chain therefore always settles fulfilled.
   */
  const enqueue = useCallback(<T,>(fn: () => Promise<T>, onFailure: T): Promise<T> => {
    // BOUNDED. The chain is global, so one delivery that never settles (a hung invoke) would block
    // every subsequent write for the session — including Approve, whose entire job is unsticking a
    // blocked agent (roborev 53119). A task that overruns resolves to its failure value and the
    // queue moves on; the abandoned promise settles unobserved.
    const run = () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      // Clear the timer when the task settles — otherwise every delivery pinned a 30s timer for its
      // full duration, including after the host unmounted.
      const task = fn().catch(() => onFailure).finally(() => clearTimeout(timer));
      return Promise.race([
        task,
        new Promise<T>((resolve) => {
          timer = setTimeout(() => resolve(onFailure), QUEUE_TASK_TIMEOUT_MS);
        }),
      ]);
    };
    const queued = sendChainRef.current.then(run, run);
    sendChainRef.current = queued;
    return queued;
  }, []);

  // Every postSparkle line is BOOKKEEPING — a send outcome, a refusal, a deferred reconciliation —
  // never a brain reply, so none of them offer to be read aloud (speakable: false, roborev 48172).
  const postSparkle = useCallback((text: string) => {
    setChat((prev) => [
      ...prev,
      { id: nextId("sparkle"), kind: "sparkle", text, speakable: false },
    ]);
    // A send outcome is exactly what a screen-reader user needs told, and it arrives whole. Two
    // sends to the same pinned agent produce the same line twice; both must be announced.
    announce(text);
  }, [announce]);

  // ── Return-from-Away recap (design §3 A5) ────────────────────────────────────────────────────
  // Snapshot the fleet's statuses the moment presence goes Away; on the way back, diff and post one
  // card. Subscribed imperatively rather than through the `usePresenceStore` hook because this is an
  // EDGE, not a value we render: a hook would re-run the effect on every unrelated store write and
  // would give us the new mode without the old one.
  const awaySnapshot = useRef<AwaySnapshot | null>(null);
  useEffect(() => {
    const onPresence = (mode: PresenceMode, prevMode: PresenceMode) => {
      if (mode === prevMode) return;
      if (mode === "away") {
        awaySnapshot.current = { ...feedStatuses(feedRef.current), at: Date.now() };
        // A fresh stretch starts with no evidence — anything seen working during the LAST one
        // would otherwise vouch for a finish in this one.
        sawWorking.current = new Set();
        return;
      }
      // The user is back — start draining any sends the precedence rule held while they were out.
      // BEFORE the recap's early return below: a held send must come back whether or not anything
      // else changed in the fleet, and `resumeQueuedIntents` presents only the HEAD (the next
      // follows as each resolves), so this can never stack countdowns nobody is watching.
      resumeQueuedIntents();

      const snapshot = awaySnapshot.current;
      awaySnapshot.current = null;
      const worked = sawWorking.current;
      sawWorking.current = new Set();
      if (!snapshot) return; // came back Here without ever having gone Away through this host
      // Names come from the LIVE feed, not the snapshot: a rename while the user was out should
      // show the name they'll actually see when they go looking.
      const info: Record<string, RecapAgentInfo> = {};
      for (const a of allAgents(feedRef.current)) {
        info[a.id] = { name: a.name, projectName: a.projectName, statusLabel: a.statusLabel };
      }
      const recap = buildRecap({
        snapshot,
        // The SAME map, rebuilt from the feed on the return edge — see feedStatuses.
        next: feedStatuses(feedRef.current).status,
        info,
        // Middle-of-the-stretch evidence, so an agent that started AND finished while you were out
        // is reported even though both its endpoints look resting.
        sawWorking: worked,
        // NO_GATE_DECISIONS — the integration seam. The gate that logs sent/queued/cancelled while
        // Away lives on the sibling A1 branch; wiring it is replacing this literal with that log
        // filtered to `at >= snapshot.at`. See services/conciergeRecap.GateDecision.
        decisions: [],
        now: Date.now(),
        id: nextId("recap"),
      });
      // Null when nothing happened — no card at all. A recap that always appears is chrome the user
      // learns to skip, and we'd lose the one time it matters.
      if (!recap) return;
      setChat((prev) => [...prev, recap]);
      // Through the column's EXISTING single role="status" node — never a live region on the card.
      // A second region double-announces (learned during the auto-routing work).
      announce(recapSummary(recap));
    };
    return usePresenceStore.subscribe((s, prev) => onPresence(s.mode, prev.mode));
  }, [announce]);

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
      if (approvingRef.current.has(a.id)) return; // already approving this agent
      approvingRef.current.add(a.id);
      // Acknowledge the click NOW. The dispatch may sit behind a routing send for seconds, and a
      // button that does nothing visible invites the second click the guard above just swallowed.
      postSparkle(`Approving ${a.name}…`);
      try {
        // Through the SAME queue as every other user-initiated PTY write. Approve is one click away
        // at all times, so an un-queued Approve while a compose send was still routing wrote
        // "approve" into that agent's terminal AHEAD of the earlier-submitted message — exactly the
        // reordering enqueue exists to prevent, on the most reachable surface in the app.
        //
        // A THROW is caught INSIDE the queued function, not left to `enqueue`'s own catch. Both
        // produce "no result", but they mean different things to the user — a throw is a terminal
        // that could not be reached, while `null` is the queue giving up on a task that overran
        // its bound — and folding them together would silently downgrade the honest, specific line
        // main has always shown for the throwing path to the generic refusal.
        const r = await enqueue<ConciergeDispatchResult | "threw" | null>(
          () =>
            // The user clicked Approve on a nudge card — the gesture IS the authorization.
            dispatchConciergeAnswer(a.id, "approve", {
              authority: { kind: "nudge-approve", agentId: a.id },
              userPrompt: false,
            }).catch(
              () => "threw" as const,
            ),
          null,
        );
        if (r === "threw") {
          postSparkle(`I couldn't reach ${a.name}'s terminal to approve.`);
          return;
        }
        if (!r) {
          postSparkle(`I couldn't send the approval to ${a.name}.`);
          return;
        }
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
      } finally {
        approvingRef.current.delete(a.id);
      }
    },
    [postSparkle, holdAttachments, enqueue],
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
      /** Whether a PLAIN success ("Sent to X.") says so in the thread. FALSE for the two paths that
       *  post a routing receipt — the receipt already reads "→ Sent to Kraken Auth", and saying it
       *  twice made every successful prompt report itself twice. Every FAILURE still reports
       *  regardless: silence on a non-delivery is the thing this whole surface exists to prevent.
       *  REQUIRED, so a future call site has to decide rather than inherit a default that is wrong
       *  for it. */
      announceSuccess: boolean,
      /** WHY this text may reach the agent's terminal (services/dispatchAuthority). REQUIRED and
       *  non-defaulted — that requirement IS the forwarding-bug fix, so a default here would undo
       *  the whole gate at the one call site that matters most. Appended rather than inserted so
       *  the diff against a branch that also edits this file stays as small as possible. */
      authority: DispatchAuthority,
    ): Promise<boolean> => {
      try {
        const r = await dispatchConciergeAnswer(target.agentId, text, {
          authority,
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
          if (announceSuccess) postSparkle(`Sent to ${target.name}.`);
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

  /**
   * Start a Sparkle chat turn for `text`. Never fails visibly, so it reports no outcome.
   *
   * `spokenTurn` decides whether the reply is read back: a voice-started turn earns a spoken
   * reply, a typed one stays silent (text-first v1). It is passed in rather than read here because
   * it is captured at SUBMIT, and routing can queue this call for seconds behind another send.
   */
  const askSparkle = useCallback((text: string, spokenTurn: boolean) => {
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
    void startConciergeTurn(buildSnapshot(feedRef.current, text)).then((id) => {
      const n = id !== null && /^\d+$/.test(id) ? Number(id) : null;
      if (n !== null) retireThroughRef.current = Math.max(retireThroughRef.current, n - 1);
    });
  }, []);

  /** Stamp a receipt onto a user bubble. Clears `redirectable` from every OTHER bubble, so only
   *  the newest routed message offers the button — a thread full of live redirects invites
   *  redirecting something from ten turns ago, which is never what the user means. */
  const setReceipt = useCallback((id: string, receipt: ConciergeReceipt) => {
    // Feed the column's long-lived live region so the routing is ANNOUNCED, not merely rendered.
    // With the target pill gone this is the only routing signal a screen-reader user gets, and the
    // receipt line itself deliberately carries no aria-live (see RoutingReceipt's header).
    //
    // Through `announce`, never `setAnnouncement` directly (roborev 53392). Routing is STICKY —
    // two messages in a row answered by Sparkle both produce "→ Answered here" — so an identical
    // consecutive write is the COMMON case here, not a corner one, and a bare setState React bails
    // out of would announce the first and silently swallow every repeat.
    announce(receiptText(receipt));
    setChat((prev) =>
      prev.map((m) => {
        if (m.kind !== "you") return m;
        if (m.id === id) return { ...m, receipt };
        return m.receipt?.redirectable
          ? { ...m, receipt: { ...m.receipt, redirectable: false } }
          : m;
      }),
    );
  }, [announce]);

  /**
   * The one send path. Routes the text, delivers it, and posts the receipt that makes the routing
   * visible and reversible. Resolves FALSE only when the text did NOT land anywhere, so the
   * compose box restores the draft rather than making the user retype it.
   */
  const deliver = useCallback(
    async (
      id: string,
      /** What the user actually WROTE — no attachment paths. Everything that reads the message as
       *  language uses this: the router classifies it, and Sparkle answers it. Prefixing quoted
       *  temp paths onto the text the classifier sees was a real mistake — "/var/folders/…/shot.png
       *  add retry logic" is not what the user said. */
      text: string,
      /** What the AGENT receives: the same text with the quoted paths in front. PTY path only. */
      payload: string,
      /** What the THREAD already shows, reused as the prompt-history rendering. */
      display: string,
      /** The aim CAPTURED AT SUBMIT (see send). Not re-read here: by the time the queue reaches
       *  this message the user may be looking at a different agent, and delivering there would be
       *  the same irreversible misdelivery the removed pinned-aim guard prevented. */
      submitted: ConciergePromptTarget | null,
      /** The files that rode this send, so a refusal can hand them back. */
      staged: Attachment[],
      /** Whether the user SPOKE this turn, captured at submit (see askSparkle). */
      spokenTurn: boolean,
      /** This send's ordinal, so a late failure can tell "still mine" from "superseded". */
      mySend: number,
    ): Promise<boolean> => {
      // An agent that has since LEFT the feed is gone (closed, deleted, project unloaded), and
      // routing at it would report a delivery that cannot happen. Gone → the safe direction.
      const aim = submitted && agentStillExists(submitted.agentId) ? submitted : null;
      const status = aim ? useRuntimeStore.getState().status[aim.agentId] : undefined;
      // The DISPATCHER's own precondition, asked up front: it refuses cloud agents outright, so
      // telling the router turns a guaranteed delivery failure into a useful chat answer. One
      // shared predicate rather than a copy here, so the two can't drift.
      const canAcceptInput = aim ? agentCanAcceptInput(aim.agentId) : false;
      const decision = await routeMessage(text, {
        agent: aim ? { id: aim.agentId, name: aim.name, status, canAcceptInput } : null,
      });

      // Re-check AFTER the (network) route call too: the agent can be closed while we classify,
      // and dispatching at a corpse surfaces as a pty-gone error where the router's own design
      // says to take the safe direction.
      const stillThere = !!aim && agentStillExists(aim.agentId);
      if (decision.target === "agent" && aim && stillThere) {
        // A prompt into an agent's terminal produces no brain reply, so nothing is queued to be
        // spoken — leaving the flag set would autoplay the NEXT brain turn the user typed.
        voiceTurnRef.current = false;

        // ══ THE FORWARDING-BUG FIX ══════════════════════════════════════════════════════════════
        // This used to dispatch, right here, on the router's verdict alone — an agent with a live
        // prompt plus terse concierge-aimed text matched `looksLikeAnswer` and the user's words went
        // into a terminal with no warning and no way back. The router is RIGHT to be here (see
        // conciergeRouter's header, and PRs #644/#651 — it and all of its tests stay); what was
        // wrong was that its verdict went straight to the PTY.
        //
        // So it now ARMS an intent instead. The send becomes visible, counts down, and can be
        // cancelled; only an expiry the user didn't stop dispatches, and it does so carrying
        // `{ kind: "countdown", intentId }`. That is why there is no `router` arm in
        // DispatchAuthority and must never be one — a heuristic verdict is not a user gesture, and
        // the union having no legal variant for it is what makes the old behavior unrepresentable
        // rather than merely discouraged.
        const armed = armIntent({
          text: payload,
          // The BANNER and the live region quote this, never `payload`. `attachedPayload` prefixes
          // each attachment's quoted temp path, so quoting it would make the column announce
          // `I'll tell Kraken Auth: "'/var/folders/x9/T/sparkle-shot-1753.png' what is wrong here?"`
          // — the exact leak the "temp paths must never reach any of them but the first" invariant
          // above forbids. Same string that goes to promptAgent's `display` a few lines down.
          display,
          targetAgentId: aim.agentId,
          targetName: aim.name,
          // ══ PRESENCE ════════════════════════════════════════════════════════════════════════
          // The REAL store, read at expiry rather than captured at arm time — the user can walk
          // away during the very seconds the countdown is running, which is the window the
          // precedence rule exists to cover. `mode` is stored, not derived, so this is a plain
          // synchronous field read (see stores/presenceStore's header).
          //
          // This used to be the literal `() => "here"` while the presence store lived on a
          // parallel branch. That was fail-OPEN: forgetting this line produced no type error and
          // no red test, and destructive sends fired at an unattended machine. `presence` is a
          // required field for that reason — do not give it a default.
          presence: () => usePresenceStore.getState().mode,
          onDispatch: (_intent, authority) => {
            // Through the queue, so a send that armed first still lands first — the countdown must
            // not silently reorder messages relative to an Approve or a redirect.
            void enqueue(async () => {
              // Seconds have passed since the route decision. The agent can be closed inside the
              // countdown window, and dispatching at a corpse would report a delivery that cannot
              // happen — the same re-check `deliver` does around the route call, for the same
              // reason and over a much wider gap.
              if (!agentStillExists(aim.agentId)) {
                postSparkle(`${aim.name} isn't open any more, so I didn't send that.`);
                restoreDraft(text);
                restoreAttachments(staged);
                if (spokenTurn && sendSeqRef.current === mySend) dictatedRef.current = true;
                return false;
              }
              // announceSuccess: false — the receipt below already reads "→ Sent to <agent>".
              const ok = await promptAgent(
                aim,
                payload,
                { display, namingBasis: text },
                staged,
                false,
                authority,
              );
              // A FAILED delivery gets no receipt: promptAgent has already said what went wrong in
              // the thread, and "→ Sent to X" over a message that never arrived would be a plain lie.
              if (ok) {
                setReceipt(id, {
                  target: "agent",
                  agentName: aim.name,
                  agentId: aim.agentId,
                  redirectable: true,
                });
                return true;
              }
              // A failed delivery must not cost the user their files any more than their words —
              // nor the fact that they SPOKE them (roborev 46922/48172/49293).
              restoreDraft(text);
              restoreAttachments(staged);
              // RE-ARM only — never clear (roborev 52363): the user may have dictated fresh speech
              // while this send was in flight, and `spokenTurn === false` would wipe a latch that
              // belongs to those newer words. And only while THIS send is still the latest
              // (roborev 52362).
              if (spokenTurn && sendSeqRef.current === mySend) dictatedRef.current = true;
              return false;
            }, false);
          },
          // The precedence rule held it: destructive, and nobody is at the machine. Say so plainly
          // — a queued action the user never hears about is its own silent failure, the mirror of
          // the one this whole change removes.
          //
          // NOTHING IS RESTORED HERE, and that is the point of the change. This used to hand the
          // draft and the files back and tell the user to send again, which is a DROP dressed up
          // as a hold: their message was gone. The intent now survives in the queue owning both
          // the text and `staged` (still captured by the dispatch closure above), and comes back
          // in front of them when they return. Restoring the draft as well would duplicate the
          // message and re-stage files the pending send is still holding.
          onQueue: () => {
            postSparkle(
              `That looked like it could break something and you were away, so I'm holding it rather than sending it to ${aim.name}. I'll bring it back when you return.`,
            );
          },
          // Back from the queue and in front of the user again. Feed the column's ONE live region:
          // a re-presented send nobody announces is exactly as silent as the bug this fixes.
          onRepresent: (intent) => {
            announce(countdownAnnouncement(intent, Date.now()));
          },
          onCancel: () => {
            // Everything the send was carrying comes back — the draft, the files, and the
            // spoken-turn latch — for exactly the reasons the failure path above restores them.
            // Cancelling must cost the user nothing, or they learn not to use the button.
            restoreDraft(text);
            restoreAttachments(staged);
            if (spokenTurn && sendSeqRef.current === mySend) dictatedRef.current = true;
            postSparkle(`Okay — I didn't send that to ${aim.name}.`);
          },
        });
        // Feed the column's ONE live region (see setReceipt): a countdown a screen-reader user
        // can't hear is a countdown they can't cancel. Through `announce`, never `setAnnouncement`
        // — two identical consecutive sends to the same agent produce the same sentence, and a bare
        // setState React bails out of would swallow the repeat (roborev 53392).
        announce(countdownAnnouncement(armed, Date.now()));
        // TRUE — the text is in hand: armed, visible, and cancellable. The box clears its draft, and
        // the cancel/failure paths above are what put it (and the files) back if it never lands.
        return true;
      }
      // The BRAIN gets the payload, not the bare text: the concierge's headless `claude -p` reads
      // attachment paths from disk exactly as an agent does (services/conciergeAttach), so
      // stripping them here would hand Sparkle a question about a screenshot it cannot see. Only
      // the ROUTER is given the clean text — "/var/folders/…/shot.png add retry logic" is not what
      // the user said, and classifying it as if it were is a real misroute.
      askSparkle(payload, spokenTurn);
      const here = stillThere ? aim : null;
      setReceipt(id, {
        target: "sparkle",
        agentName: here?.name,
        agentId: here?.agentId,
        redirectable: true,
      });
      return true;
    },
    [
      askSparkle,
      promptAgent,
      setReceipt,
      agentStillExists,
      restoreAttachments,
      restoreDraft,
      enqueue,
      postSparkle,
      announce,
    ],
  );

  /**
   * The compose box's entry point.
   *
   * Everything that must reflect SUBMIT happens synchronously here — the user's bubble, the
   * remembered text, the staged files, the dictated-origin latch, and the AIM. Only routing and
   * delivery are queued.
   *
   * Both halves are load-bearing. Queuing the bubble left a second rapid send with no visible state
   * at all: the box clears on submit, so the text was simply gone from the UI for up to the route
   * deadline plus a round trip. And re-reading the aim inside the queued function would deliver to
   * whichever agent the user happened to be looking at when the queue reached it — reintroducing,
   * through the ordering fix itself, exactly the misdelivery the removed pinned-aim guard prevented.
   */
  const send = useCallback(
    (text: string): Promise<boolean> => {
      // Was this turn SPOKEN? Decided before anything clears (the latch is consumed here).
      const spokenTurn = dictatedRef.current || micLiveRef.current;
      dictatedRef.current = false;
      // Which send this is, so a late async outcome can tell "still mine" from "superseded".
      const mySend = ++sendSeqRef.current;
      // Sending supersedes whatever Sparkle was saying.
      stopConciergeVoice();
      // Same courtesy the agent composer extends: honor the pause-on-submit voice setting so the
      // mic does not keep transcribing the room while the send is handled.
      maybePauseOnSubmit();
      const id = nextId("you");
      const submitted = targetRef.current;
      // IS THIS A PICKER ANSWER? Asked BEFORE the payload is built, because the answer changes how
      // it is built. The prefix `attachedPayload` adds is quoted temp paths, and every arm of
      // `matchAnswerToOption` is anchored — so with a file staged and a picker on screen, "Yes"
      // arrives as `"/var/folders/…/shot.png" Yes`, matches nothing, and comes back
      // `ambiguous-picker`. The box then restores the draft AND the chips, so retyping reproduces
      // it exactly: a loop whose only exit is guessing that the attachments are the problem, which
      // the refusal copy never says.
      //
      // So a terse answer to a live picker sends UNPREFIXED and KEEPS its attachments staged for
      // the next message. Holding them is the honest half: the picker answer is a keystroke, not a
      // message that could carry a file, so consuming them would silently cost the user the picking
      // for nothing. The chips stay on screen, which is also the only signal that they weren't sent.
      const answersPicker = !!submitted && answersLivePicker(submitted.agentId, text);
      // Take the staged files in the SAME tick the text leaves, so the next message starts clean
      // and a second Send can't deliver the same attachments twice.
      const staged = answersPicker ? [] : takeAttachments();
      // THREE renderings of one message, exactly as the removed composer built them:
      //   payload — the attachments' real paths prefixed to the text, for the PTY only;
      //   display — the typed text plus compact counts, for the thread AND every prompt-history
      //             surface (the pinned header, the history dropdown);
      //   text    — what the user actually typed, for naming, the ghost-text corpus, and what the
      //             ROUTER classifies. Empty on an attachments-only send.
      // The temp paths must never reach any of them but the first (roborev 46911/46925).
      const payload = attachedPayload(text, staged);
      const display = attachedDisplay(text, staged);
      setChat((prev) => [...prev, { id, kind: "you" as const, text: display }]);
      // Remember BOTH: a redirect to the agent must replay the payload (paths included), a redirect
      // to Sparkle must replay the plain text.
      rememberSentText(sentTextRef.current, id, text);
      rememberSentText(sentPayloadRef.current, id, payload);
      return enqueue(
        () => deliver(id, text, payload, display, submitted, staged, spokenTurn, mySend),
        false,
      );
    },
    [deliver, enqueue, takeAttachments],
  );

  /** Send an already-routed message the OTHER way. Additive: the first delivery stands (see
   *  RoutingReceipt) — this adds a second one and records that both happened. */
  const redirect = useCallback(
    async (messageId: string) => {
      const text = sentTextRef.current.get(messageId);
      if (!text) return;
      // The AGENT-bound form (attachment paths prefixed). The brain reads paths too, so BOTH
      // directions replay this rather than the bare text; it falls back to `text` for a message
      // that carried no files, where the two are the same string anyway.
      const replay = sentPayloadRef.current.get(messageId) ?? text;
      const current = chatRef.current.find((m) => m.id === messageId);
      const receipt = current?.kind === "you" ? current.receipt : undefined;
      if (!receipt || receipt.alsoSentTo) return;
      // Claim the redirect BEFORE awaiting. The dispatch relay is async and the button stays
      // mounted until the receipt updates, so without this a double-tap (or one impatient second
      // click on a slow relay) passed the alsoSentTo guard twice and wrote the same text into the
      // terminal twice — irreversible, and the receipt would still read as a single redirect.
      if (redirectingRef.current.has(messageId)) return;
      redirectingRef.current.add(messageId);
      try {
        if (receipt.target === "agent") {
          // Redirecting INTO chat starts a typed turn: the user clicked a button, they did not
          // speak it, so the reply is not read back.
          askSparkle(replay, false);
          setReceipt(messageId, { ...receipt, alsoSentTo: "sparkle", redirectable: false });
          return;
        }
        // Chat → agent. Deliver to the agent the BUTTON NAMED, not to whatever is selected now:
        // the label ("Also ask Kraken Auth") is an explicit promise, and the selection moves for
        // reasons unrelated to this thread. Sending elsewhere would be exactly the misdelivery the
        // removed pinned-aim guard existed to prevent (roborev 46284-M4), in the one place the UI
        // has committed to a destination in advance.
        const promised = receipt.agentId;
        const live = targetRef.current;
        const aim =
          promised && live?.agentId === promised
            ? live
            : promised && receipt.agentName
              ? { projectId: "", agentId: promised, name: receipt.agentName }
              : null;
        if (!aim || !agentStillExists(promised)) {
          postSparkle(
            `${receipt.agentName ?? "That agent"} isn't open any more, so I couldn't pass the message along.`,
          );
          return;
        }
        // Through the queue: a redirect clicked while a compose send is still routing must land
        // AFTER it, not jump ahead of an earlier message.
        //
        // No files are staged for a redirect — they rode the original send and were consumed
        // there — so nothing can be held or handed back, and `[]` is the honest argument.
        const ok = await enqueue(
          () =>
            // The user tapped redirect on this message's routing receipt. Authorized by that tap,
            // and named by the message it belongs to.
            promptAgent(aim, replay, { display: text, namingBasis: text }, [], false, {
              kind: "redirect",
              receiptId: messageId,
            }),
          false,
        );
        if (ok) setReceipt(messageId, { ...receipt, alsoSentTo: "agent", redirectable: false });
      } finally {
        redirectingRef.current.delete(messageId);
      }
    },
    [askSparkle, promptAgent, postSparkle, setReceipt, agentStillExists, enqueue],
  );

  const controller = useMemo(
    () => ({
      onSend: send,
      onRedirect: (messageId: string) => void redirect(messageId),
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
      // The digest's whole purpose: hand off to column two instead of duplicating it.
      //
      // The founder's ask in full: "I just want Sparkle to be telling me that I have two agents that
      // need my attention. If I click on the two agents part of that text then it filters the build
      // column out to only show me the agents that need attention." Opening the project was only the
      // first half — without the second, you click "3 Need you" and still face the whole list.
      //
      // RE-DERIVED FROM THE LIVE FEED, not from the message that was rendered. A digest line can sit
      // on screen across several feed ticks, so the click has to ask what is true NOW: the group may
      // have shrunk, or its lead agent may have answered and resolved. `buildDigest` groups by
      // `project::band` and `ConciergeDigestGroup.id` is that key, so matching the clicked message's
      // id against the freshly-built groups both finds the live group and, by finding nothing, is how
      // a stale click declines to open a dead agent.
      onDigestClick: (d: ConciergeDigestMessage) => {
        // Re-derived from the population the line was BUILT from, so a stale rowless click can't be
        // answered by a row group that happens to share a project and band (their ids differ for
        // exactly this reason).
        const feed = feedRef.current;
        const live =
          d.variant === "rowless"
            ? buildDigest(unrepresentedAgents(feed), "rowless").groups.find((g) => g.id === d.id)
            : buildDigest(surfacedAgents(feed)).groups.find((g) => g.id === d.id);
        if (!live) return; // resolved out from under the click — open nothing, filter nothing
        // A ROWLESS line REVEALS, it does not filter. Its agents have no row, so `isolateStatusBand`
        // has nothing of theirs to leave standing — and worse, it would hide the very row the reveal
        // needs: the gap-3 case is a blocked worker under an orchestrator that bands `running`, so
        // isolating `needs_you` removes the orchestrator the worker pops out under. Opening the
        // project on the lead agent is exactly what that agent's own card's "Show me" did, which is
        // the honest affordance for a population that owns no rows.
        if (live.variant === "rowless") {
          openProjectTab(live.projectId, live.leadAgentId);
          return;
        }
        // ORDER IS LOAD-BEARING. `isolateStatusBand` narrows whichever project is SELECTED, so
        // selecting first is what makes the filter land on the list the sentence named. Filtering
        // first narrows somebody else's column for the frame in between, which reads as "my agents
        // just vanished".
        openProjectTab(live.projectId, live.leadAgentId);
        // The SAME `statusFilter` the sidebar's own chips write (stores/uiStore.isolateStatusBand),
        // deliberately not a filter of the digest's own: one state means the chips render what the
        // click did, "Show all" clears it like any hand-toggled filter, and the two can never
        // disagree about what column two is showing.
        //
        // The revealed agent is safe from the filter it just turned on: `live.leadAgentId` comes
        // from this band's surfaced set, so the selected row is one the filter keeps.
        useUiStore.getState().isolateStatusBand(live.band);
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
    [resolveAgent, approve, send, redirect, attach, removeAttachment, toggleMic, play],
  );

  const pinnedProjectName = useMemo(() => {
    if (!feed.pinnedProjectId) return undefined;
    return feed.projects.find((p) => p.id === feed.pinnedProjectId)?.name;
  }, [feed]);

  // Sends that are armed and counting down (services/dispatchIntent). A module-level registry
  // rather than component state on purpose: an intent must outlive any one render and must not be
  // lost if this host re-mounts mid-countdown, which would strand a timer with no way to cancel it.
  // `armedIntents` returns a snapshot with STABLE identity between mutations — a fresh array per
  // call would make useSyncExternalStore re-render forever.
  const pendingIntents = useSyncExternalStore(subscribeIntents, armedIntents, armedIntents);

  // NOTE (bead sparkle-y4ft): `messages` below gets a fresh ARRAY IDENTITY on every feed tick —
  // this memo is keyed on `feed`, which changes whenever any agent's status or a scoped count
  // moves, and clicking an item ticks the feed. ConciergeThread must therefore never treat a new
  // `messages` reference as "the thread changed"; it keys auto-follow on message count + last id +
  // last length for exactly this reason. An identity-keyed consumer scrolls the column out from
  // under the reader.
  const model: ConciergeViewModel = useMemo(() => {
    // DIGEST, don't enumerate (bead sparkle-4562.4). One item of a priority keeps its card; two or
    // more become a single line. Without this, eight P0s and nineteen P1s meant twenty-seven cards
    // stacked above the compose box — the chat pushed off screen, and column one reduced to an
    // unreadable copy of column two.
    const { cards, groups } = buildDigest(surfacedAgents(feed));
    // Rowless agents go through the SAME rule, as the `rowless` variant — one card each is how the
    // wall came back (a fleet with several blocked workers under absent or in-motion orchestrators
    // is several cards). What their line may not do is state a ROW count or filter a column that
    // has no rows to leave standing; that is the variant's job, not an exemption from digesting.
    // See `unrepresentedAgents` and services/conciergeDigest.DigestVariant.
    const rowless = buildDigest(unrepresentedAgents(feed), "rowless");
    const nudges = [...cards, ...rowless.cards].map(agentToNudge);
    const digests: ConciergeMessage[] = [...groups, ...rowless.groups].map((g) => ({
      id: g.id,
      kind: "digest" as const,
      band: g.band,
      variant: g.variant,
      text: g.text,
      leadAgentId: g.leadAgentId,
    }));
    // Order the whole stream by WHEN EACH ITEM FIRST APPEARED, not by what kind it is. Concatenated
    // as [chat, digests, nudges] only to tie-break items that arrive in the SAME tick; anything
    // already placed keeps its slot (see engine/conciergeStreamOrder for why assign-once matters).
    const stream = orderByArrival(arrivalRef.current, [...chat, ...digests, ...nudges]);
    return {
      scope: { pinnedProjectName },
      vitals: feed.scopedCounts,
      // In arrival order. This used to be `[...chat, ...digests, ...nudges]`, which pinned every
      // notice below the entire conversation no matter when it arrived — so the digests read as
      // stuck to the bottom of the pane rather than as part of the thread.
      messages: stream,
      typing,
      attachments,
      dropActive,
    };
  }, [feed, chat, typing, pinnedProjectName, attachments, dropActive]);

  return (
    <>
      <ConciergeColumn
        model={model}
        controller={controller}
        micLive={micLive}
        wordmarkMode={deriveWordmarkMode(micLive, typing)}
        width={width}
        searchSlot={searchSlot}
        // Armed sends, each cancellable, directly above the box. `cancelIntent` runs the arm site's
        // own onCancel (which restores the files and posts to the thread), so the controller here
        // has nothing to remember — see services/dispatchIntent.
        countdownSlot={
          <CountdownBanner
            intents={pendingIntents}
            onCancel={cancelIntent}
            onConfirm={confirmIntent}
          />
        }
        interim={dictation.interim}
        registerInsert={registerInsert}
        speakingMessageId={speakingId}
        onTextEdit={onTextEdit}
        announcement={announcement}
      />
      {/* The recommended-action pill. Mounted HERE — where its delivery wiring lives — but it
          renders over the target agent's terminal, which it reaches by portal (see
          ConciergeSuggestions). It was a `suggestionsSlot` in the column until the pill moved onto
          the terminal; a fragment sibling costs no layout, since a portal renders elsewhere.
          KEYED BY AGENT. useSuggestions owns one agent per instance by design; a shared instance
          with a changing id kept the previous agent's buttons on screen and would write their
          keystroke into the newly-selected agent's PTY. See ConciergeSuggestions' header.

          Keyed off `target`, NOT `routingTarget`: the engine must keep running while the user looks
          at the Plan board (auto-approve lives inside the hook). Only the PILL follows the view. */}
      {target ? (
        <ConciergeSuggestions
          key={target.agentId}
          agentId={target.agentId}
          agentName={target.name}
          visible={promptTargetShown}
          // QUEUE ONCE. onApply wraps the WHOLE action, so the delivery it calls must NOT queue
          // again: applySuggestion awaits deliverPrompt from inside the chain, and a second
          // enqueue would chain onto the very promise that is awaiting it. Circular wait — broken
          // only by the task timeout, i.e. a 30s stall of every send, redirect and Approve, and
          // then a keystroke arriving anyway (roborev 53196).
          onApply={(run) => enqueue(run, false)}
          // announceSuccess: TRUE — a suggestion click posts no receipt, so without this a
          // delivered recommended action would be the one silent success in the column.
          // The user clicked a recommended-action pill — an explicit, targeted gesture.
          onDeliverPrompt={(t) =>
            promptAgent(target, t, { display: t, namingBasis: t }, [], true, {
              kind: "suggestion",
              agentId: target.agentId,
            })
          }
          onFailure={postSparkle}
        />
      ) : null}
    </>
  );
}
