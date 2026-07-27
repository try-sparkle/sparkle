import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { computeSuggestions, SuggestionOfflineError } from "./engine";
import { AiUnavailableError } from "../anthropic";
import { getAgentScrollback } from "../terminalScrollback";
import { AiUnreachableError } from "../anthropic";
import { useAiFeature } from "../aiGate";
import { useRuntimeStore } from "../../stores/runtimeStore";
import { useProjectStore } from "../../stores/projectStore";
import { useConnectionStore } from "../../stores/connectionStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { pushSuggestions } from "../relayClient";
import { deriveCta } from "../../engine/agentCta";
import { isInMotion } from "../../engine/inMotion";
import { resolveStage } from "../../engine/workflowStage";
import { maybeAutoApprove, maybeAutoResume } from "./approvalsRuntime";
import { detectPendingQuestion } from "./pendingQuestion";
import { log } from "../../logger";
import type { AgentTabStatus } from "../../types";
import type { SuggestionButton } from "./types";
import type { ApprovalCategory } from "./approvalCategories";

// Statuses where it's the user's turn — the agent finished a turn or is blocked on input. We
// compute suggestions on entry to one of these (the "blocked on user" trigger from the spec).
const YOUR_TURN: ReadonlySet<AgentTabStatus> = new Set<AgentTabStatus>([
  "idle",
  "waiting",
  "approval",
  "errored",
  "done",
]);

// djb2 — cheap + stable; only the tail matters for identity, so identical terminal state never
// triggers a recompute (one Haiku call per distinct blocked state, not per render).
export function hashScrollback(s: string): string {
  let h = 5381;
  const tail = s.slice(-4000);
  for (let i = 0; i < tail.length; i++) h = ((h << 5) + h + tail.charCodeAt(i)) | 0;
  return String(h);
}

export function shouldRecompute(a: {
  lastHash: string | null;
  nextHash: string;
  composerEmpty: boolean;
}): boolean {
  if (!a.composerEmpty) return false;
  return a.lastHash !== a.nextHash;
}

// Cap TOTAL attempts (the initial compute plus its retries) for the SAME failing state so a
// persistently-rejecting compute can't self-perpetuate into an unbounded retry loop (the reject
// path bumps retryTick to recover from a transient failure; without a cap that would spin).
// Resets on success or a genuine state change.
export const MAX_COMPUTE_ATTEMPTS = 3;

/** Whether a failing state still has attempt budget left (exported as a pure unit for testing).
 *  `failures` counts attempts already failed, so budget remains while it's below the cap. */
export function withinRetryBudget(failures: number): boolean {
  return failures < MAX_COMPUTE_ATTEMPTS;
}

/** The failure count paired with the state it was spent on. Kept as ONE value rather than a count
 *  and a hash that can drift apart: the count is meaningless without the hash it belongs to. */
export interface FailState {
  hash: string | null;
  count: number;
}

export const NO_FAILURES: FailState = { hash: null, count: 0 };

/** Attempts already failed for `hash` — 0 for any OTHER state (which starts with a full budget).
 *  Reading the count *relative to* a hash is what keeps the budget attached to the state that spent
 *  it. Zeroing the counter whenever a different hash passed through looked equivalent, but computes
 *  for other states interleave freely with the retries of a failing one — the terminal repaints, or
 *  an offline-deferred compute runs — and each one refunded the exhausted budget, so a persistently
 *  failing state kept buying metered calls indefinitely. Pure, for testing. */
export function failuresFor(state: FailState, hash: string): number {
  return state.hash === hash ? state.count : 0;
}

/**
 * Whether a rejected compute is PERMANENT for this request — i.e. an identical retry is guaranteed
 * to fail the same way, so spending the retry budget on it only buys wasted (paid) calls, extra
 * gateway load, and duplicate warnings. The proxy surfaces its status as `... (HTTP <code>)`.
 *
 * 4xx means "this request is wrong" (bad route, bad body, bad/expired auth) and nothing about
 * re-sending it changes that — EXCEPT 408 (Request Timeout) and 429 (Too Many Requests), which are
 * explicitly "try this again later" and keep the normal backoff. 5xx stays retryable: it's the
 * transient-gateway-blip case the backoff exists for.
 */
export function isTerminalComputeError(message: string): boolean {
  const m = /\(HTTP (\d{3})\)/.exec(message);
  if (!m) return false;
  const code = Number(m[1]);
  if (code === 408 || code === 429) return false;
  return code >= 400 && code < 500;
}

// Base delay before RETRYING a *failed* compute. The overwhelmingly common failure is a transient
// AI-gateway blip ("ai request failed", HTTP 502) — retrying instantly fires all attempts within a
// few milliseconds, so they land on the SAME blip and the whole state gives up (and hammers a
// struggling gateway with rapid paid calls). A short, growing backoff spaces the attempts out so a
// transient blip has time to clear before the next try. Kept modest so suggestions still feel live.
export const RETRY_BACKOFF_MS = 700;

/** Backoff (ms) before the next retry, given how many attempts have already failed (1 after the
 *  first failure). Grows exponentially and is capped so it never stalls the UI. Pure, for testing. */
export function retryBackoffMs(failures: number): number {
  return Math.min(RETRY_BACKOFF_MS * 2 ** Math.max(0, failures - 1), 4000);
}

// How often the settle-watcher re-hashes the scrollback while the agent is blocked on the user.
// Two consecutive identical hashes = the terminal has finished painting (settled).
export const SETTLE_TICK_MS = 1200;

// How many distinct settled states to remember per agent (see `memo` below). Small on purpose: the
// point is to cover an agent that flips out of and back into the SAME your-turn state, which needs
// only the last handful. Insertion-ordered, so evicting the oldest key is the LRU-ish behavior we
// want without carrying a real LRU.
export const MEMO_LIMIT = 8;

/** Remember a computed set under its scrollback hash, evicting the oldest once past MEMO_LIMIT.
 *  Pure (mutates the map it's handed) so the eviction rule is testable without rendering. */
export function rememberComputed<T>(memo: Map<string, T>, hash: string, value: T): void {
  memo.delete(hash); // re-insert so a re-hit refreshes recency
  memo.set(hash, value);
  while (memo.size > MEMO_LIMIT) {
    const oldest = memo.keys().next().value;
    if (oldest === undefined) break;
    memo.delete(oldest);
  }
}

/**
 * Owns the per-agent suggestion set. Recomputes once when the agent enters a your-turn status with
 * an empty composer and a changed scrollback; caches by scrollback hash so identical state never
 * recomputes. Returns the visible (non-dismissed) buttons plus per-button dismiss + a clear.
 */
/** Per-AGENT (not per-instance) state, so a remount can't resurrect an already-answered prompt or
 *  discard a paid compute. Keyed by agent id and never pruned during a session: an entry is a small
 *  Set/Map, and an agent id is not reused. See the refs in useSuggestions for why these moved. */
const HANDLED_SIGS = new Map<string, Set<string>>();
const MEMOS = new Map<string, Map<string, { buttons: SuggestionButton[]; questionPending: boolean }>>();

function handledSigsFor(agentId: string): Set<string> {
  let s = HANDLED_SIGS.get(agentId);
  if (!s) HANDLED_SIGS.set(agentId, (s = new Set()));
  return s;
}

function memoFor(
  agentId: string,
): Map<string, { buttons: SuggestionButton[]; questionPending: boolean }> {
  let m = MEMOS.get(agentId);
  if (!m) MEMOS.set(agentId, (m = new Map()));
  return m;
}

/**
 * Clear an agent's answered-picker signatures. Exported because the invalidation CANNOT live in a
 * mounted effect any more (roborev 53159).
 *
 * The signature is the option set alone, so every Claude Code bash permission prompt shares one —
 * the set is only meant to stop ONE settled screen re-sending a keystroke while it re-hashes during
 * a single your-turn. A later, genuinely distinct prompt with the same options must be answered
 * again. The hook used to clear on the your-turn→working flip, which worked while one instance
 * lived forever; now that the concierge mounts this only for the SELECTED agent, an agent that
 * finishes its turn while you are looking at a different one would never be cleared — and on
 * return, its next real prompt would be suppressed as "already handled", leaving the agent blocked
 * forever while the UI claimed it was auto-approved. So the flip is watched at module level.
 */
export function clearHandledSignatures(agentId: string): void {
  HANDLED_SIGS.get(agentId)?.clear();
}

/**
 * Watch EVERY agent's status, not just the mounted one's, and clear the de-dupe set when an agent
 * leaves your-turn. This is the module-level half of clearHandledSignatures' contract.
 *
 * Subscribed once at import. The store is a plain zustand store, so this costs one comparison per
 * status write and needs no component to be alive — which is the entire point: the agent that most
 * needs clearing is the one you are NOT looking at.
 */
/**
 * The subscription body, exported so a test can drive it directly.
 *
 * Clears any agent NOT in your-turn, rather than watching for the your-turn→working TRANSITION. A
 * transition needs a prior observation, and the watcher has none for an agent whose first observed
 * status is already `working` — so the edge could be missed exactly once, which for this guard means
 * an agent silently stuck. "Not in your-turn" needs no history and is strictly safer: an agent that
 * is working has no live picker on screen, so a remembered signature can only do harm.
 */
export function onRuntimeStatusChange(status: Record<string, AgentTabStatus>): void {
  for (const [id, s] of Object.entries(status)) {
    if (!YOUR_TURN.has(s)) clearHandledSignatures(id);
  }
}

// Guarded: this runs at IMPORT time, and several suites replace the runtime store with a bare
// selector stub that has no `subscribe`. A module that throws while being imported takes the whole
// file down, which is a far worse failure than this watcher being inactive in a unit test — the
// behaviour it guards has its own coverage via onRuntimeStatusChange.
if (typeof useRuntimeStore.subscribe === "function") {
  useRuntimeStore.subscribe((state) => onRuntimeStatusChange(state.status));
}

/** Drop an agent's per-agent state — call when the agent is closed for good. Exported for tests,
 *  which must not leak an answered-picker signature from one case into the next. */
export function resetSuggestionMemory(agentId?: string): void {
  if (agentId === undefined) {
    HANDLED_SIGS.clear();
    MEMOS.clear();
    return;
  }
  HANDLED_SIGS.delete(agentId);
  MEMOS.delete(agentId);
}

export function useSuggestions(agentId: string, composerEmpty: boolean) {
  const [buttons, setButtons] = useState<SuggestionButton[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  // The category we last auto-answered for this agent (drives the inline "Auto-approved {label} ·
  // Manage" note), or null. Cleared whenever normal buttons are shown or the state moves on.
  const [autoApproved, setAutoApproved] = useState<ApprovalCategory | null>(null);
  // Signatures of picker instances already auto-answered, so a re-rendered/settled scrollback can't
  // re-send the keystroke. See maybeAutoApprove.
  //
  // MODULE-SCOPED, KEYED BY AGENT — not an instance ref. This is a de-dupe guard against an
  // IRREVERSIBLE action (a keystroke into a live PTY), so it has to outlive the component. As an
  // instance ref it died with the hook, and the concierge now mounts the row keyed by agent id:
  // tabbing to another agent and back while the same permission prompt was still on screen
  // remounted the hook with an empty set and auto-approve fired a SECOND time (roborev 53074).
  // Per-agent state that guards a side effect belongs to the agent, not to a React instance.
  // Read DIRECTLY each render, not through a ref. `useRef(handledSigsFor(agentId))` captures the
  // entry for whatever id was present at FIRST render and ignores the argument forever after — so
  // the state was per-instance-of-the-first-agent, the opposite of what it claims, and correctness
  // rested entirely on the caller remembering `key={agentId}`. An O(1) map lookup makes the key an
  // optimisation rather than a load-bearing invariant (roborev 53159).
  const handledSigs = { current: handledSigsFor(agentId) };
  const lastHash = useRef<string | null>(null);
  // Results of past computes for THIS agent, keyed by scrollback hash. `lastHash` is nulled every
  // time the agent leaves your-turn (so a genuinely-repeated prompt recomputes), which means an
  // agent that flips out of and back into the SAME settled screen re-ran the whole compute — and
  // when learned actions are on, that is a metered Haiku call bought for a state we already have
  // the answer to. Surviving the reset lets that round-trip be served locally. Deliberately NOT
  // persisted: it's a within-session echo cache, nothing more.
  //
  // Also module-scoped per agent, for the cheaper half of the same reason: a remount used to throw
  // the cache away and re-buy a metered Haiku compute for a screen already computed — exactly what
  // this cache exists to prevent.
  const memo = { current: memoFor(agentId) }; // same reasoning as handledSigs above
  // Guards against a duplicate concurrent (paid) compute while one is in flight. `retryTick` lets a
  // discarded compute re-trigger the effect so a state we returned to still gets suggestions.
  const computing = useRef(false);
  // Which compute currently OWNS `computing`. Bumped per compute and, critically, by the re-aim
  // cleanup below: a compute started for the previous agent resolves long after the guard has been
  // handed to the new one, and its `.finally` would otherwise clear a guard it no longer owns —
  // letting a second (metered) compute start for an agent that already has one in flight.
  const computeToken = useRef(0);
  const [retryTick, setRetryTick] = useState(0);
  // Pending failure-retry timer (see retryBackoffMs). Held in a ref so the effect cleanup can cancel
  // it when the state moves on before the backoff fires, and so we never stack overlapping timers.
  const retryTimer = useRef<number | null>(null);
  // Consecutive-failure counter (+ the hash it's failing on) to bound retries per failing state.
  const fail = useRef<FailState>(NO_FAILURES);
  // Whether we last pushed a NON-empty set to the phone — so retiring only emits a clearing push
  // when there's actually something to clear (no chatty empty pushes on every status flip).
  const pushedNonEmpty = useRef(false);

  // Retire this agent's buttons on the phone (and drop the host's id→value map) so a phone can't
  // click a suggestion the desktop has stopped showing. No-op if nothing non-empty was pushed.
  // Signature of the last set pushed to the phone; retire() resets it so a set can be re-pushed
  // after a clear. Declared before `retire` (which writes it) though the push effect below reads it.
  const lastPushedRef = useRef<string>("");
  const retire = useCallback(() => {
    lastPushedRef.current = "";
    if (!pushedNonEmpty.current) return;
    pushedNonEmpty.current = false;
    pushSuggestions({ agent_id: agentId, buttons: [] });
  }, [agentId]);
  // useAiFeature already ANDs the per-feature flag with paid entitlement, so this is the real
  // "are learned (Haiku) actions live?" signal. Heuristic buttons show regardless (computeSuggestions
  // returns them before this gate), so passing it as aiEnabled keeps heuristics on when AI is off.
  const learnedOn = useAiFeature("suggestedActions");
  // "Are we actually reachable?" (browser online AND the Rust reachability probe agree). When
  // offline we skip the learned Haiku call, which could only DNS-fail; when it flips back true this
  // is an effect dep, so the deferred compute for the still-blocked state re-runs on reconnect.
  const isOnline = useConnectionStore((s) => s.isOnline);
  const status = useRuntimeStore((s) => s.status[agentId]);
  const isYourTurn = status !== undefined && YOUR_TURN.has(status);
  /** Is the agent STILL blocked on the user, right now? Reads the store rather than the render-time
   *  `isYourTurn`, which is a snapshot: both the memo hit (effects flush after paint) and the async
   *  compute (`.then` on a microtask) can run after a store write the closure never saw. Typing a
   *  picker answer off a screen the agent has already left is wrong regardless of the de-dupe set,
   *  so both auto-answer sites gate on this (roborev 53203/53248). */
  const isLive = useCallback(
    () => YOUR_TURN.has(useRuntimeStore.getState().status[agentId] as AgentTabStatus),
    [agentId],
  );
  // The LIVE stage — deliberately NOT `workflowShipped`, which is a latch-once watermark that trips
  // the first time work reaches main and clears only on close. Reading it here is what made an agent
  // that landed an earlier cycle offer "Close Build Agent" over fresh un-landed work. The watermark
  // still exists for the bead lifecycle and the "landed at least once" marker, whose ever-landed
  // semantics are correct — it's just wrong for "what should you do right now".
  //
  // Resolved the SAME way the sidebar resolves it — `resolveStage(branchStatus, workflowStage)`,
  // the furthest-along of what git proves and the recorded override. Reading the bare override here
  // was a real divergence: two surfaces, two different stages for one agent. Before the first stage
  // poll writes an override, git already proves `building_saved` on a branch with commits, so the
  // sidebar showed a stage while the CTA had none at all (`undefined` → no CTA). resolveStage never
  // returns below what git proves and never undefined, so the CTA now tracks the same truth; stages
  // below `building_saved` still yield no CTA, because deriveCta returns null for them.
  const branchStatusForAgent = useRuntimeStore((s) => s.branchStatus[agentId]);
  const stageOverride = useRuntimeStore((s) => s.workflowStage[agentId]);
  const stage = useMemo(
    () => resolveStage(branchStatusForAgent, stageOverride),
    [branchStatusForAgent, stageOverride],
  );
  // Select the one PRIMITIVE deriveCta reads (CtaSignals), not the WorkflowState object.
  // `setWorkflowState` builds a fresh object every applied poll, so subscribing to the object would
  // hand this hook a new reference each tick. That identity churn used to reach the compute effect's
  // dep array and abort an in-flight (paid Haiku) compute mid-poll, discarding the result and
  // re-running it — a real cost, since the compute is a metered call.
  const hasRemote = useRuntimeStore((s) => s.workflowState[agentId]?.hasRemote);
  // The PR signals, selected as primitives for the same identity-churn reason as `hasRemote` above.
  // They joined CtaSignals when the PR became the gate under the `pr_first` delivery policy.
  const prState = useRuntimeStore((s) => s.workflowState[agentId]?.prState);
  const prNumber = useRuntimeStore((s) => s.workflowState[agentId]?.prNumber);
  // Is this agent still MOVING even though its own turn is closed — a worker it spawned is
  // mid-build? An orchestrator that landed an earlier cycle sits at stage `merged`/`shipped`, and
  // without this the pill read "Close Build Agent" over a fleet that was actively building (founder
  // report 2026-07-22). Subscribing to the whole status map is safe HERE specifically because
  // `applyCta` is used only at RENDER and is deliberately kept out of the compute effect's dep
  // array — the identity-churn hazard documented on `hasRemote` above is about aborting an
  // in-flight paid compute, which this can't reach.
  const statusMap = useRuntimeStore((s) => s.status);
  const agents = useProjectStore(
    (s) => s.projects.find((p) => p.id === s.selectedProjectId)?.agents,
  );
  const inMotion = useMemo(
    () => isInMotion(agentId, agents ?? [], statusMap),
    [agentId, agents, statusMap],
  );
  // The delivery policy, from the editable config mirror (`[workflow] require_pr`, default true).
  // This is the line that makes the setting LOAD-BEARING: require_pr has shipped defaulted-true and
  // fully plumbed since the config file landed, while the CTA hardcoded the opposite policy — so the
  // documented default and the actual behavior disagreed, and open PRs were routed around.
  const requirePr = useSettingsStore((s) => s.requirePr);

  // Suppresses the CTA after `clear()` (the user just acted on it) until the next compute or turn.
  // Without this the render-time merge would immediately re-add the very pill they just clicked.
  const [ctaCleared, setCtaCleared] = useState(false);

  // Whether the settled scrollback shows the agent AWAITING AN ANSWER (a prose question or a
  // terminal widget). A property of the same settled state the buttons were computed from, so it's
  // captured in the compute effect — where the scrollback is already read and authoritative — and
  // reset everywhere the buttons reset. Deriving it at render instead would mean calling
  // getAgentScrollback() on every render and re-scanning a 4000-char tail for no new information.
  const [questionPending, setQuestionPending] = useState(false);

  // ---------------------------------------------------------------------------
  // RE-POINTING THIS INSTANCE AT A DIFFERENT AGENT
  // ---------------------------------------------------------------------------
  //
  // Everything above is per-AGENT state living in a per-INSTANCE holder. That was safe while every
  // caller mounted one instance per agent, and it is why ConciergeSuggestions mounts this with
  // `key={agentId}`. But nothing in the hook ENFORCED it: called with a changing id, none of the
  // state or refs above resets on that change, and `idle` is in YOUR_TURN — so agent A's computed
  // buttons stayed on screen under agent B's name until a compute for B committed (a network round
  // trip, or up to SETTLE_TICK_MS). The click handler resolves the target at CLICK time, so a click
  // in that window sent A's prompt into B's TERMINAL. That is irreversible, and a pill only has to
  // be up for ONE FRAME for it to happen.
  //
  // Fixed here, INSIDE the hook, so the invariant no longer rests on every caller remembering the
  // key. `key=` remains correct and stays where it is; this makes it an optimisation rather than
  // the only thing standing between a re-aim and a misdelivered prompt.
  //
  // The split between the two halves below is load-bearing:
  //
  //   • STATE is reset DURING RENDER. React re-runs a component that sets its own state while
  //     rendering and DISCARDS the first pass, so no committed frame ever carries the previous
  //     agent's buttons — there is no frame to click in. Doing this in an effect instead would
  //     commit exactly one frame of (agent B, A's buttons), which is the whole bug.
  //   • REFS are reset in an EFFECT CLEANUP, because a ref written during render would be written
  //     on the discarded pass too, and because the cleanup is the one place that still sees the
  //     OLD agent — which is what lets it retire that agent's phone copy.
  //
  // A keyed REMOUNT of the compose box was the other candidate fix and was rejected: remounting
  // takes ComposeBox's `text` down with it, destroying the user's typed draft on every re-aim —
  // trading one silent data loss for another, on the surface whose own comments call retyping a
  // paragraph "the worst possible outcome of a failed send".
  const [aimedAt, setAimedAt] = useState(agentId);
  if (aimedAt !== agentId) {
    setAimedAt(agentId);
    // A's buttons must not survive into B's frame — this is THE line the misdelivery hangs on.
    setButtons([]);
    // A's dismissals are about A's buttons; carried over they would silently hide B's.
    setDismissed(new Set());
    // A note about a prompt on A's screen, rendered under B's name, is simply false.
    setAutoApproved(null);
    setQuestionPending(false);
    // B starts with a fresh CTA: `ctaCleared` records that the user acted on A's pill.
    setCtaCleared(false);
  }

  // The ref half. Declared BEFORE the compute effect so its cleanup runs first: React runs every
  // changed effect's cleanup (in declaration order) before running any of the new effects, so the
  // refs are clean by the time the compute effect fires for the new agent.
  useEffect(
    () => () => {
      // `lastHash` is what tells the compute effect "already computed this screen". Carried across
      // a re-aim onto a matching screen (two workers on one repo settling on the same "Done." tail
      // is ordinary) it would refuse B the compute it never had a turn at.
      lastHash.current = null;
      // The retry budget is spent PER FAILING STATE and read relative to its hash. A's exhausted
      // budget must not refuse B on an identical screen — B simply never gets suggestions.
      fail.current = NO_FAILURES;
      // Disown any in-flight compute (see computeToken) and hand the guard to the new agent
      // immediately, so B doesn't wait out A's round trip.
      computeToken.current += 1;
      computing.current = false;
      // A pending retry belongs to the state we just aimed away from.
      if (retryTimer.current !== null) {
        window.clearTimeout(retryTimer.current);
        retryTimer.current = null;
      }
      // A's phone copy is a live tap target. The desktop is no longer offering it for A, so a tap
      // would fire an action no surface is showing — retire it. This also resets `lastPushedRef`
      // and `pushedNonEmpty`, the two remaining refs. `retire` closes over the OLD agentId, which
      // is exactly what a cleanup needs. It runs on UNMOUNT too, which is the other way an instance
      // stops owning an agent (a closed pane must not leave buttons armed on the phone).
      retire();
    },
    // `retire` is itself memoised on agentId, so it changes exactly when the aim does.
    [retire],
  );

  // Stage-derived primary + computed alternates. deriveCta returns null when there's nothing to
  // nudge (no committed work yet), in which case the ordinary suggestions stand on their own.
  // NOTE this is used only at RENDER (see `shown`), never inside the compute effect — keeping it out
  // of that dep array is what stops a poll from cancelling an in-flight paid compute.
  const applyCta = useCallback(
    (computed: SuggestionButton[]): SuggestionButton[] => {
      // `?? null` because the optional-chained selectors yield `undefined` before any workflow poll
      // has applied, while CtaSignals models "no PR" as null. Both mean "not a live PR" to the
      // policy, so they collapse here rather than teaching the pure engine about undefined.
      const signals = { hasRemote, prState: prState ?? null, prNumber: prNumber ?? null };
      const cta = stage
        ? deriveCta(stage, signals, computed, {
            questionPending,
            inMotion,
            policy: requirePr ? "pr_first" : "direct",
          })
        : null;
      return cta ? [cta.primary, ...cta.alternates] : computed;
    },
    [stage, hasRemote, prState, prNumber, questionPending, inMotion, requirePr],
  );

  useEffect(() => {
    if (!isYourTurn) return;
    // A compute for the current state is already in flight — don't fire a duplicate (which, when
    // learned actions are on, is a redundant paid Haiku call). The in-flight one will either apply
    // its result or, if superseded, bump retryTick to re-evaluate.
    if (computing.current) return;
    // No content, no compute — the same rule the settle watcher below already applies. A null
    // provider means the terminal is UNMOUNTED (not empty), and an empty buffer gives the model an
    // empty "Recent terminal output:" block, so either way the paid Haiku call can only return
    // nothing while clobbering whatever buttons are already up. Coercing null to "" here instead
    // spent one call per your-turn on agents whose terminal hadn't registered its provider yet.
    // lastHash is deliberately NOT committed: once real output arrives its hash differs from
    // whatever we skipped, and the watcher bumps retryTick to compute it.
    const scrollback = getAgentScrollback(agentId);
    if (!scrollback) return;
    const nextHash = hashScrollback(scrollback);
    if (!shouldRecompute({ lastHash: lastHash.current, nextHash, composerEmpty })) return;
    // A genuinely different state gets a fresh retry budget; retries of the SAME failing state draw
    // down the budget set in .catch below — and once that budget is exhausted, ANY re-trigger for
    // the same hash (composer typed-then-cleared, learnedOn toggled) must bail here too, or each
    // such cycle would buy a fresh paid call the budget already refused (lastHash was never
    // committed for a failing hash, so shouldRecompute alone can't stop it). Note this only READS
    // the budget — a different hash must not RESET it, or passing through one refunds the other.
    if (!withinRetryBudget(failuresFor(fail.current, nextHash))) return;
    // Already computed this exact settled state earlier in the session (the agent left your-turn and
    // came back to the same screen). Serve it locally instead of re-buying the compute. The
    // auto-approve check still runs — it's the local heuristic tier, it's what `handledSigs` being
    // cleared on the turn flip is FOR (a genuinely repeated prompt must be answered again), and
    // skipping it here would leave a repeat permission prompt showing buttons instead of being
    // auto-answered. Accepted staleness: the learned tier also reads the user's action history, so a
    // memo hit can serve suggestions ranked from slightly older history. Same screen, same answers —
    // worth far more than the metered call it saves.
    const hit = memo.current.get(nextHash);
    if (hit) {
      // Not live → commit NOTHING. Unlike the async path there is nothing here worth salvaging: a
      // memo hit spent no metered call, so bailing costs only a cache read. Suppressing just the
      // auto-answer while still committing lastHash and raising the buttons was the same defect the
      // async path was fixed out of — a hash committed for work that was discarded — and it left a
      // repeat permission prompt showing buttons instead of being auto-answered, with recovery
      // depending on a render that the batched approval→working→approval transition skips
      // (roborev 53286).
      if (!isLive()) return;
      const autoCat = maybeAutoApprove(agentId, scrollback, handledSigs.current);
      lastHash.current = nextHash;
      // Unlike the success path below, this branch deliberately does NOT clear `fail`. It can't be
      // stale here: only a SUCCEEDED compute is ever memoized, so a hash present in the memo is by
      // construction not the hash we're currently failing on. Clearing it would read as though the
      // two paths guard the same thing — and would throw away a budget this path never spent.
      setDismissed(new Set());
      if (autoCat) {
        setAutoApproved(autoCat);
        setButtons([]);
        setQuestionPending(false);
        retire();
        log.debug("suggestions", "auto-approved", { agentId, category: autoCat });
        return;
      }
      rememberComputed(memo.current, nextHash, hit); // refresh recency
      setAutoApproved(null);
      setCtaCleared(false);
      setQuestionPending(hit.questionPending);
      setButtons(hit.buttons);
      log.debug("suggestions", "memo hit", { agentId, buttons: hit.buttons.length });
      return;
    }
    computing.current = true;
    // This compute's claim on the guard above. Only the owner may release it — see the `.finally`.
    const myToken = (computeToken.current += 1);
    let alive = true;
    // Whether the finally block should bump retryTick. The bump must happen AFTER the in-flight
    // guard clears: if the re-render it triggers is processed between .catch and .finally (React
    // is free to flush it on any microtask boundary), the effect re-runs while computing.current
    // is still true, early-returns, and the retry is silently dropped.
    let retryAfter = false;
    // How long to wait before that retry. A superseded compute (composer toggled mid-flight)
    // recomputes the CURRENT state immediately (0); a *failed* compute backs off (retryBackoffMs)
    // so a transient gateway blip can clear before the next attempt.
    let retryDelay = 0;
    log.debug("suggestions", "compute", { agentId, chars: scrollback.length, learnedOn });
    void computeSuggestions({ agentId, scrollback, aiEnabled: learnedOn, entitled: true, online: isOnline })
      .then((set) => {
        // Commit the hash ONLY when we actually apply the result. If the composer went non-empty
        // mid-compute (alive === false), drop the result, leave lastHash unchanged, and bump
        // retryTick so the state we're actually in now recomputes — otherwise the suggestions for
        // that blocked state would be lost until the scrollback or status changed.
        if (!alive) {
          retryAfter = true;
          return;
        }
        fail.current = NO_FAILURES;
        lastHash.current = nextHash;
        setDismissed(new Set());
        // Sparkle Auto-Approve: if this settled state is a classifiable permission prompt whose
        // effective rule is "always" (and the feature is on), the local classifier types the plain
        // "Yes" ONCE (signature de-duped) INSTEAD of surfacing buttons. Retire any phone copy and
        // show the inline "Auto-approved" note. The keystroke comes only from the local heuristic
        // tier, never the learned tier — the existing raw-keystroke trust boundary is preserved.
        // Sparkle Auto-Resume (a sub-option of Auto-approve): the session-resume prompt has no
        // Yes/No pair so the approval classifier ignores it. If the effective `resume` rule is
        // "summary"/"full" (and the master toggle is on), the local detector types the matching
        // digit ONCE and we suppress the buttons — same post-fire cleanup as auto-approve. Checked
        // first because it shares the handledSigs de-dupe set and never overlaps a permission prompt.
        // RE-VALIDATE LIVENESS before typing anything. This compute started while the agent was
        // blocked on the user; by the time its promise resolves the agent may have moved on, and
        // typing a picker answer off a scrollback snapshot it has already left is wrong regardless
        // of what the de-dupe set says.
        //
        // Gates ONLY the two auto-answers — the irreversible half. Bailing out of the whole `.then`
        // (as this first did) threw away everything the metered call bought: rememberComputed never
        // ran for exactly the leave-and-return transition the memo exists to serve, while lastHash
        // had already advanced to a hash whose result was discarded. Recovering that needs the
        // reset effect, which needs React to render with isYourTurn false — and two store writes in
        // one task (approval → working → approval, a resume echo) auto-batch into a single render
        // where it never does, leaving the screen with no suggestions at all (roborev 53248).
        //
        // It also stops depending on effect ordering. The clear used to live in the reset effect,
        // which React runs AFTER the compute effect's cleanup sets `alive = false` — safe by
        // construction. The module watcher fires synchronously inside the zustand `set`, before
        // React has committed anything and while `alive` is still true, so a compute resolving on
        // the next microtask would see a freshly-emptied set and auto-answer a SECOND time
        // (roborev 53203). Checking the live status makes the watcher's timing irrelevant.
        const live = isLive();
        const autoResume = live ? maybeAutoResume(agentId, scrollback, handledSigs.current) : null;
        if (autoResume) {
          setAutoApproved(null); // not a category note; just suppress the pills for this prompt
          setButtons([]);
          setQuestionPending(false); // answered on the user's behalf — nothing is pending
          retire();
          log.debug("suggestions", "auto-resumed", { agentId, mode: autoResume });
          return;
        }
        const autoCat = live ? maybeAutoApprove(agentId, scrollback, handledSigs.current) : null;
        if (autoCat) {
          setAutoApproved(autoCat);
          setButtons([]);
          setQuestionPending(false); // answered on the user's behalf — nothing is pending
          // Use retire() rather than open-coding it: it already no-ops when nothing non-empty was
          // pushed, AND it resets lastPushedRef. Open-coding left that signature stale, so a later
          // compute in the SAME your-turn yielding the same button ids would hit the sig guard and
          // never re-send the phone the set the desktop is showing.
          retire();
          log.debug("suggestions", "auto-approved", { agentId, category: autoCat });
          return;
        }
        setAutoApproved(null);
        setCtaCleared(false); // a fresh state — the CTA is relevant again
        // Captured from the SAME scrollback the buttons were computed from, so the two can never
        // disagree about which state they describe.
        const pending = detectPendingQuestion(scrollback);
        setQuestionPending(pending);
        // Remember this settled state so a later return to the SAME screen is served locally rather
        // than re-bought. Only the ordinary (non-auto-approved) path caches: the auto-approve branch
        // above returns early and deliberately re-runs its local classifier each time.
        rememberComputed(memo.current, nextHash, { buttons: set.buttons, questionPending: pending });
        // Store the RAW computed set; the CTA is merged over it at RENDER time (see `shown` below).
        // Storing the merged list here instead would freeze the CTA at compute time: the workflow
        // stage advances on the ~15-30s poll, long after the scrollback settled, and this effect
        // refuses to re-run for an unchanged hash — so a landing agent would keep offering "Land to
        // Main" after it had already reached local main.
        //
        // The relay push does NOT happen here: the render-time effect below is the SINGLE owner of
        // pushes. Pushing from both meant every successful compute relayed two identical events, and
        // a push from here could never cover a CTA that changed with the stage rather than the
        // scrollback.
        setButtons(set.buttons);
        log.debug("suggestions", "computed", { agentId, buttons: set.buttons.length });
      })
      .catch((err: unknown) => {
        // Offline is NOT a failure of THIS state — the same compute will succeed once we reconnect.
        // Leave lastHash unadvanced (so it recomputes) but DON'T spend the retry budget, DON'T warn,
        // and DON'T bump retryTick (which would spin every render while offline). The isOnline effect
        // dep re-runs this compute when connectivity returns.
        // Same disposition for a compute that DISCOVERED we're offline mid-flight: the pre-compute
        // `online` gate can only read the store, and the reachability heartbeat is up to 30s stale,
        // so a route that dropped inside that window let the call through to a guaranteed transport
        // failure. Retrying it spends the budget on paid calls that cannot succeed. chatOnce has
        // already marked the store offline, so `isOnline` (an effect dep) re-runs this compute the
        // moment connectivity returns — the same recovery path as the gate above, not a dead end.
        if (err instanceof SuggestionOfflineError || err instanceof AiUnreachableError) {
          log.debug("suggestions", "compute deferred (offline)", { agentId });
          return;
        }
        // The compute rejected — leave lastHash unadvanced and re-trigger so this state can retry,
        // but only up to MAX_COMPUTE_ATTEMPTS for the SAME failing state, so a persistent rejection
        // can't spin into an unbounded loop of paid computes. A genuine state change resets this.
        // An unavailable backend is the one rejection with NO transient hope: the retries are
        // guaranteed to hit the same wall, so spend the whole budget at once rather than paying for
        // two more round-trips per state. Note this canNOT take the deferred (offline) path above:
        // offline is detected locally and costs nothing, whereas learning the backend is down COSTS
        // a request — so deferring without drawing down the budget would let every re-render buy
        // another doomed call, which is worse than the bounded retries this replaces.
        const unavailable = err instanceof AiUnavailableError;
        const message = err instanceof Error ? err.message : String(err);
        // A permanent rejection can't be retried into a success, so burn the whole budget at once:
        // the retry branch below then falls through to the terminal path, and the effect's own
        // budget guard refuses any later re-trigger for this same hash. Two disjoint shapes are
        // terminal — an unavailable backend (AiUnavailableError, tracked above via `unavailable`,
        // whose message carries no HTTP code) and a 4xx surfaced as `... (HTTP 4xx)` — so OR them.
        const terminal = unavailable || isTerminalComputeError(message);
        const spent = terminal ? MAX_COMPUTE_ATTEMPTS : failuresFor(fail.current, nextHash) + 1;
        // Count and hash move together, so a compute for another state can never be charged this
        // budget — nor refund it.
        fail.current = { hash: nextHash, count: spent };
        // An unavailable backend logs at debug, not warn: it's an environmental condition the user
        // can't act on, and warning on every occurrence is the retry-storm noise this cut aims at.
        log[unavailable ? "debug" : "warn"]("suggestions", "compute failed", {
          agentId,
          failures: spent,
          terminal,
          error: message,
        });
        if (!alive) return;
        if (withinRetryBudget(spent)) {
          retryAfter = true;
          retryDelay = retryBackoffMs(spent);
        } else {
          // Budget exhausted: this settled state is known-uncomputable. Keeping the PREVIOUS
          // state's buttons through the transient retries was fine, but past the last retry
          // they're stale on a terminal that shows something else — drop them locally and retire
          // the phone's copy so a phone can't click an action for a state that no longer exists.
          setButtons([]);
          setQuestionPending(false); // no answers to lead with — let the stage CTA stand
          retire();
        }
      })
      .finally(() => {
        // DISOWNED — this compute belongs to an agent the box has since aimed away from. The
        // re-aim cleanup already released the guard (and may have handed it to a compute that is
        // still running for the NEW agent), so clearing it here would let a second metered compute
        // start for that agent. Its retry bump is equally irrelevant: it would re-trigger work for
        // a state nobody is looking at.
        if (computeToken.current !== myToken) return;
        // Otherwise ALWAYS clear the guard, so a rejected compute can never permanently lock out
        // future computes for this agent (the guard at the top of the effect keys off this flag).
        computing.current = false;
        // Bump only now that the guard is clear — see retryAfter above. A failed compute waits out
        // its backoff first (retryDelay); a superseded one (retryDelay 0) re-triggers immediately.
        // The timer id is parked in a ref so the effect cleanup can cancel a pending retry if the
        // state moves on before it fires.
        if (!retryAfter) return;
        if (retryDelay <= 0) {
          setRetryTick((t) => t + 1);
          return;
        }
        retryTimer.current = window.setTimeout(() => {
          retryTimer.current = null;
          setRetryTick((t) => t + 1);
        }, retryDelay);
      });
    return () => {
      alive = false;
      if (retryTimer.current !== null) {
        window.clearTimeout(retryTimer.current);
        retryTimer.current = null;
      }
    };
  }, [agentId, isYourTurn, composerEmpty, learnedOn, retryTick, retire, isOnline]);

  // Settle-watcher. The your-turn status flip (Claude's Stop hook) RACES the final terminal paint
  // into xterm, so the compute above frequently hashes a mid-paint — or, right after a pane mount,
  // empty — scrollback, commits that hash, and (having no scrollback subscription) would never look
  // again: the buttons for the settled state simply never appear. While the agent stays blocked on
  // the user with an empty composer, re-hash the tail on a slow tick; when it has SETTLED (two
  // consecutive identical hashes) on a state we haven't computed, bump retryTick so the compute
  // effect re-runs. The settle requirement keeps mid-stream frames from triggering paid computes,
  // the lastHash gate keeps each distinct settled state to exactly one compute, and the failure
  // budget is honored so the watcher can't resurrect an unbounded retry loop the .catch above
  // deliberately capped.
  useEffect(() => {
    if (!isYourTurn || !composerEmpty) return;
    let prevTickHash: string | null = null;
    const id = window.setInterval(() => {
      if (computing.current) return;
      // Offline: the compute would only defer again — don't bump retryTick every tick. The isOnline
      // effect dep re-runs the compute on reconnect. Read the store live so the running interval
      // (its deps don't include isOnline) sees the current connectivity without restarting.
      if (!useConnectionStore.getState().isOnline) return;
      // No content, no compute — the same guard the effect above applies, and it must stay the
      // SAME guard. A null provider means the terminal is UNMOUNTED, not that it is empty, but an
      // empty buffer is equally uncomputable. Bailing on both also keeps this tick from spinning:
      // the effect never commits lastHash for a state it skipped, so were we to settle on the
      // empty hash we'd find `h !== lastHash.current` forever and bump retryTick every tick.
      // Ticks resume once real output arrives, which still covers the mount race.
      const scrollback = getAgentScrollback(agentId);
      if (!scrollback) return;
      const h = hashScrollback(scrollback);
      const settled = h === prevTickHash;
      prevTickHash = h;
      if (!settled || h === lastHash.current) return;
      if (!withinRetryBudget(failuresFor(fail.current, h))) return;
      setRetryTick((t) => t + 1);
    }, SETTLE_TICK_MS);
    return () => window.clearInterval(id);
  }, [agentId, isYourTurn, composerEmpty]);

  // When the agent goes back to working (no longer the user's turn), drop the stale buttons — the
  // terminal state has moved on, so retire the phone's copy too. The CTA rides on the computed set
  // (it's merged in at render), so clearing here correctly takes the CTA down with it: a working
  // agent shouldn't be offered "Land to Main" mid-turn.
  useEffect(() => {
    if (!isYourTurn) {
      setButtons([]);
      setAutoApproved(null); // the prompt is gone — drop any lingering auto-approved note
      // Reset the auto-answer dedupe when the agent goes back to working: the signature guard is
      // only meant to stop a SINGLE settled screen from re-sending the keystroke while it re-hashes
      // during one your-turn. A later, genuinely-distinct prompt for the same command (e.g. the same
      // `rm -rf build/` run twice) hashes identically, so if the set persisted across turns that
      // second REAL prompt would be suppressed WITHOUT being answered — leaving the agent blocked.
      clearHandledSignatures(agentId);
      lastHash.current = null;
      setCtaCleared(false); // the next your-turn starts with a fresh CTA
      setQuestionPending(false); // the agent is working again — whatever it asked has been answered
      retire();
    }
  }, [isYourTurn, retire]);

  // NOTE: we deliberately do NOT retire() when the desktop composer merely goes non-empty (the user
  // starts typing). The desktop hides its row, but the phone is an independent surface and the agent
  // is still blocked on the SAME prompt — a phone tap is still valid, so it's not a stale injection.
  // Retiring on every keystroke-start would be chatty and would wrongly clear the phone's view; a
  // real send flips the agent off your-turn, which retires through the effect above.
  const dismiss = useCallback((id: string) => setDismissed((d) => new Set(d).add(id)), []);
  const clear = useCallback(() => {
    setButtons([]);
    setAutoApproved(null);
    setQuestionPending(false); // the user just answered it
    // The user just acted on the row; the CTA must go down with the rest of it. Without this the
    // render-time merge would re-add the very pill they clicked (buttons is empty, but deriveCta
    // builds its primary from the stage alone). Reset on the next compute or turn change.
    setCtaCleared(true);
    // Commit the CURRENT scrollback hash rather than nulling: the agent often stays your-turn
    // (settled) for a beat after a suggestion click, and a null lastHash would let the settle-
    // watcher immediately recompute — resurrecting the very buttons the user just acted on (and
    // re-pushing them to the phone). The watcher recomputes only once the terminal actually moves.
    lastHash.current = hashScrollback(getAgentScrollback(agentId) ?? "");
    retire();
  }, [agentId, retire]);

  // The CTA is merged HERE, at render, over whatever the last compute produced — not baked into
  // `buttons` — so the pill tracks the live stage as the poll advances it (building_saved →
  // merged_local → merged) without needing the scrollback to change.
  //
  // The `isYourTurn` gate is load-bearing, NOT a shortcut: deriveCta builds its primary from the
  // stage alone, so applyCta([]) is NON-empty. SuggestionRow is gated only on the composer being
  // empty (suggestionRowVisible), not on your-turn — so without this gate a build agent that is
  // actively WORKING with committed work would render a "Land to Main" pill mid-turn. The same gate
  // is what makes `clear()` and the not-your-turn reset actually take the CTA down with them.
  //
  // Suppressed on the auto-approve path too: that state deliberately shows only the inline
  // "Auto-approved" note (the compute path clears the buttons), and a CTA beside it would contradict
  // that. And after `clear()` (the user just clicked the pill) until the next compute or turn.
  const showCta = isYourTurn && !autoApproved && !ctaCleared;
  // Dismissal is applied AFTER the merge: deriveCta unconditionally prepends its primary, so
  // filtering first left the pill's × advertising an action it couldn't perform (click × → the
  // identical pill re-renders). Filtering here lets × drop the CTA and fall back to the alternates.
  const merged = showCta ? applyCta(buttons) : buttons;
  const shown = merged.filter((b) => !dismissed.has(b.id));
  // Computed at render so the push effect can depend on a STABLE string rather than `shown`, which
  // .filter() rebuilds every render — the same identity churn just removed from the compute effect.
  const shownSig = shown.map((b) => b.id).join("|");

  // SINGLE owner of relay pushes. The compute path deliberately doesn't push: two owners meant every
  // successful compute relayed the same set twice, and a compute-time push can't cover a CTA that
  // changes with the STAGE (a 15-30s poll) rather than the scrollback. Keyed on the button-id
  // signature so an unchanged set never re-pushes.
  useEffect(() => {
    // Never push a non-empty set once the turn is over. On the your-turn→working transition React
    // commits a render where isYourTurn is already false but `buttons` still holds the old set
    // (setButtons([]) hasn't flushed). Effects run in declaration order, so the reset effect above
    // retires first — and without this guard THIS effect would immediately re-push that stale set,
    // undoing the retire and re-arming taps on the phone for a turn the agent has moved on from.
    if (!isYourTurn && shown.length > 0) return;
    if (shownSig === lastPushedRef.current) return;
    // Nothing to clear: don't emit a chatty empty `suggestions` event on every your-turn transition
    // that yields no buttons. An empty set AFTER a non-empty one still pushes, to retire the old one.
    if (shown.length === 0 && !pushedNonEmpty.current) return;
    lastPushedRef.current = shownSig;
    pushedNonEmpty.current = shown.length > 0;
    pushSuggestions({
      agent_id: agentId,
      buttons: shown.map(({ id, label, value }) => ({ id, label, value })),
    });
    // `shown` is read through the closure; `shownSig` is the identity-stable trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, shownSig, isYourTurn]);

  return { buttons: shown, dismiss, clear, autoApproved };
}
