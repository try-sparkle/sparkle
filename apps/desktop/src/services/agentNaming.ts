// Auto-naming bridge (spec: agents summarize their own work). On the first prompt, and again
// whenever a later prompt represents meaningfully different work, we ask the Rust backend
// (src-tauri/src/naming.rs → cheapest Claude) for a short title + a one-sentence description and
// rename the agent. The sidebar shows the title (truncated to fit the column) and reveals the
// title + description on hover.
//
// PRECEDENCE (Phase 2a, sparkle-q1rq): for SELF-REPORTING agents — the Claude Code kinds (build,
// worker) whose Phase-1 sparkle-control persona tells them to name themselves — the agent's own
// signals win and the paid Haiku call is DEMOTED to a genuine last resort. Self-report + aiTitle
// are the primary name source; we only fall back to Haiku after the agent has had a turn to
// self-name and still hasn't. Non-self-reporting kinds (shell) keep prompt-based Haiku naming as
// before. See {@link shouldHaikuName} for the exact ladder.
//
// Everything here is best-effort: a pinned name, a too-thin prompt, or any backend failure
// (no API key, network) just leaves the current name as-is. The naming call must never block
// or break the send path, so callers fire-and-forget.
import { invoke } from "@tauri-apps/api/core";
import { useProjectStore } from "../stores/projectStore";
import { reportNamingOutcome } from "./selfReportObservability";
import type { NamingOutcome } from "../stores/selfReportMetrics";
import type { AgentKind, AgentName, PromptHistoryEntry } from "../types";

// Common filler words ignored when comparing two prompts — so "please fix the test" and
// "fix the test now" read as the same work.
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "for", "with", "this",
  "that", "it", "is", "are", "be", "please", "can", "you", "now", "then", "let", "lets",
  "i", "we", "my", "me", "also", "just", "so", "do", "make", "add", "should", "would",
]);

/** Significant lowercased word set (≥3 chars, no stopwords, no screenshot marker). */
function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/📷[^]*$/u, "") // drop the "📷 N screenshots" display suffix
      .split(/[^a-z0-9]+/u)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
  );
}

// Purely-operational words. A prompt whose content words are ALL in this set (e.g. "push to
// production", "merge to main", "looks good") describes no work to name — it's a process command
// or an ack — so we skip naming it WITHOUT a backend call. Deliberately conservative: it only
// fires when the WHOLE prompt is tactical ("run the onboarding analysis" still names, because
// onboarding/analysis aren't here), so anything subtler is left to the model's own SKIP judgment.
const TACTICAL = new Set([
  // git / build / deploy operations
  "push", "commit", "deploy", "ship", "merge", "rebase", "pull", "rerun", "redeploy", "revert",
  "undo", "redo", "build", "rebuild", "run", "production", "prod", "staging", "main", "master",
  "branch", "release",
  // build / test / CI chores (only skipped when the WHOLE prompt is one — "write tests for the
  // billing webhook" still names because "billing"/"webhook" survive). All ≥3 chars; shorter
  // tokens (e.g. "ci") never reach here since contentWords drops words under 3 chars.
  "test", "tests", "lint", "lints", "typecheck", "format", "fmt", "checks",
  // flow control
  "continue", "resume", "proceed", "again", "stop", "cancel", "abort", "approve", "reject",
  // acknowledgements / filler
  "yes", "yep", "yeah", "sure", "okay", "lgtm", "looks", "good", "great", "perfect", "nice",
  "thanks", "thank", "done", "cool", "awesome", "fine",
]);

/** True iff every content word is operational/ack (so there's no work subject to name). */
function isTacticalOnly(words: Set<string>): boolean {
  if (words.size === 0) return false;
  for (const w of words) if (!TACTICAL.has(w)) return false;
  return true;
}

/** Jaccard overlap of two word sets (1 = identical, 0 = disjoint). */
function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}

// Below this overlap, a new prompt counts as "different work" and earns a re-name.
const RENAME_SIMILARITY_THRESHOLD = 0.4;

/** The inputs the step-3 prompt heuristic reads. Shared by {@link renameDecision} and its
 *  {@link shouldRename} boolean wrapper so the single-source-of-truth intent extends to the signature. */
export interface RenameOpts {
  namePinned: boolean;
  autoNameBasis: string | null;
  prompt: string;
}

/** The step-3 prompt heuristic (pin / thin / tactical / similarity), returning the LABEL for why it
 *  would (not) spend a naming call — the SINGLE source of truth both {@link shouldRename} and
 *  {@link namingOutcome} derive from, so the boolean decision and its observed label can never drift.
 *  `"rename"` means a paid call is warranted; the other three are reasons to skip: an already-pinned
 *  name, nothing worth naming, or work that hasn't moved. `"unchanged_work"` is split out from
 *  `"skipped_thin"` because the aiTitle rung needs to tell "this prompt says nothing" (keep the
 *  title, no call) from "this prompt still matches the basis" (a genuine title win) — both collapse
 *  back to `"skipped_thin"` at step 3, preserving the existing outcome labels. Pure. */
type RenameVerdict = "self_named" | "skipped_thin" | "unchanged_work" | "rename";

function renameDecision(opts: RenameOpts): RenameVerdict {
  const words = contentWords(opts.prompt);
  // An already-pinned name (self-report or user) wins — never re-name over it.
  if (opts.namePinned) return "self_named";
  // Need at least a little substance — don't burn a call on "ok" / "continue" / "yes".
  if (words.size < 2) return "skipped_thin";
  // Skip prompts that are entirely an operational command or an ack — no work to name, no call.
  // (Anything subtler is caught by the model's own SKIP judgment in naming.rs.)
  if (isTacticalOnly(words)) return "skipped_thin";
  // First substantive prompt for this agent: always name it.
  if (!opts.autoNameBasis) return "rename";
  // Otherwise only re-name when the work has clearly shifted.
  return similarity(words, contentWords(opts.autoNameBasis)) < RENAME_SIMILARITY_THRESHOLD
    ? "rename"
    : "unchanged_work";
}

/** Exported for unit testing: should this prompt trigger a (re)naming call? Derives from the single
 *  source of truth {@link renameDecision}. */
export function shouldRename(opts: RenameOpts): boolean {
  return renameDecision(opts) === "rename";
}

/**
 * Self-reporting agents run a `claude` session that the Phase-1 sparkle-control persona tells to
 * name ITSELF (via the `rename_agent` MCP tool → sets `namePinned`) and that titles its own
 * conversation (`aiTitle`, read from the transcript by sessionTitle.ts). Those are the "build"
 * (orchestrator) and "worker" (IC) kinds — the only kinds that actually spawn `claude` with the
 * self-naming persona (see AgentPane.prepare + buildAgent.ts personas, which append
 * sparkleControlProtocol/rename_agent). "think" is a Chief chat (no PTY, never reaches the naming
 * path) and "shell" runs a raw command — neither self-reports, so they keep prompt-based Haiku
 * naming.
 */
export function isSelfNamingAgent(agent: { kind: AgentKind }): boolean {
  return agent.kind === "build" || agent.kind === "worker";
}

/**
 * Decide whether to spend a paid Haiku `generate_agent_name` call for this submit. The ladder,
 * highest-precedence first:
 *
 *  1. `aiTitle` present AND still matching the prompt → NO call. Claude Code's own session title is
 *     free and beats a thin first prompt, so it owns the name by default. But it is written ONCE on
 *     the first turn and never refreshed (see namingOutcome), so it only holds while the work still
 *     overlaps it; a clearly-shifted prompt falls through to the rungs below. Skipped entirely once
 *     `autoNameBasis` is set, i.e. once a later name already superseded the title.
 *  2. Self-reporting agent (build/worker) on its FIRST prompt (promptCount < 2) → NO call. Give the
 *     agent its first prompt→response turn to name itself (rename_agent → namePinned) or emit an
 *     aiTitle. Eliminating this eager first-prompt call is the whole point of Phase 2a: we stop
 *     spending credits naming agents that can name themselves.
 *  3. Otherwise defer to {@link shouldRename} (which still honors namePinned, thin/tactical prompts,
 *     and work-shift similarity). For a self-reporting agent this branch is only reached on a LATER
 *     prompt (>= 2 submitted) — i.e. AFTER it had a full turn to self-name and STILL has no aiTitle
 *     and isn't namePinned — a genuine last-resort fallback. Non-self-reporting agents (shell) are
 *     UNCHANGED: Haiku may name on the very first prompt exactly as it does today.
 *
 * `promptCount` is the agent's promptHistory length INCLUDING the just-submitted prompt (the caller
 * appends the prompt before naming), so the agent's first-ever submit is promptCount === 1.
 */
/** The full option set shared by {@link namingOutcome} and {@link shouldHaikuName}. */
export interface NamingDecisionOpts {
  kind: AgentKind;
  namePinned: boolean;
  aiTitle: string | null | undefined;
  autoNameBasis: string | null;
  promptCount: number;
  prompt: string;
  // Set for the worker spawn-time naming: a worker is named exactly once, from its task, with an
  // empty promptHistory (promptCount 0) — the task IS its naming moment and there is no earlier
  // self-report opportunity. Without this, the first-turn deferral below would permanently swallow
  // a worker's only naming call and it would stay "Worker N" until it self-names.
  bypassFirstTurnDefer?: boolean;
}

/**
 * Classify a naming trigger into exactly one {@link NamingOutcome}, walking the SAME ladder (in the
 * same order) as {@link shouldHaikuName}. This is pure observation — it changes no naming behavior;
 * it just LABELS which branch fired so we can measure self-report vs paid-Haiku coverage (Phase 2c,
 * sparkle-rl84). By construction the outcome is `"paid_haiku_fallback"` for exactly the inputs where
 * `shouldHaikuName` returns true, so the two never disagree (see the unit tests).
 *
 * The non-fallback branches partition the "no paid call" space:
 *  - `ai_title`          — Claude Code's own session title holds, because the prompt still overlaps
 *                          it (ladder step 1). It does NOT win outright: the title is first-turn-only
 *                          and yields once the work has clearly shifted.
 *  - `deferred_first_turn` — a self-reporting build/worker's first prompt (ladder step 2).
 *  - `self_named`        — the agent pinned its own name (rename_agent) or the user did.
 *  - `skipped_thin`      — nothing worth a call: too-thin, tactical/ack-only, or work hasn't shifted.
 */
export function namingOutcome(opts: NamingDecisionOpts): NamingOutcome {
  // (1) Claude Code's session title wins — but only while it still describes the work.
  //
  //     It used to win OUTRIGHT, on the documented belief that Claude Code keeps re-summarizing the
  //     full conversation so the newest `ai-title` always tracks the current work. It does not: it
  //     writes the title once on the first turn and then re-emits that SAME value verbatim for the
  //     rest of the session (58/58 real transcripts; one 702-line session emitted it 39 times,
  //     byte-identical from line 17 to line 691). Combined with the unconditional short-circuit,
  //     the first-turn title latched the name permanently — an agent that started on "Make YouTube
  //     videos full width of page" still wore that name hours later while doing unrelated work,
  //     and every skip was tallied as `ai_title`, i.e. reported as naming working correctly.
  //
  //     So the title now defends its own name the same way a Haiku name does: it holds while the
  //     prompt still overlaps it, and yields once the work has clearly moved on. `autoNameBasis`
  //     non-null means a later name already superseded the title — step 3 owns that case, and
  //     reading the (stale) title here would fight it.
  if (opts.aiTitle && !opts.autoNameBasis) {
    const step1 = renameDecision({
      namePinned: opts.namePinned,
      autoNameBasis: opts.aiTitle, // the title IS the current name — judge divergence against it
      prompt: opts.prompt,
    });
    // Still the right name (or nothing worth naming) → free win, no call. Only a clear work shift
    // falls through to the rungs below.
    if (step1 !== "rename") return step1 === "unchanged_work" ? "ai_title" : step1;
  }
  // (2) A self-reporting agent hasn't had a chance to self-name on its first prompt — defer,
  //     unless this is the worker's one-shot spawn-time naming (see bypassFirstTurnDefer).
  if (!opts.bypassFirstTurnDefer && isSelfNamingAgent(opts) && opts.promptCount < 2) {
    return "deferred_first_turn";
  }
  // (3) The existing prompt heuristic — delegated to renameDecision (the single source of truth that
  //     shouldRename also uses). Its "rename" verdict is our paid fallback; its skip labels pass through.
  const step3 = renameDecision({
    namePinned: opts.namePinned,
    autoNameBasis: opts.autoNameBasis,
    prompt: opts.prompt,
  });
  if (step3 === "rename") return "paid_haiku_fallback";
  // "unchanged_work" is an internal split used by rung 1; at step 3 it collapses back into
  // "skipped_thin" so the outcome labels (and their telemetry) are unchanged.
  return step3 === "unchanged_work" ? "skipped_thin" : step3;
}

export function shouldHaikuName(opts: NamingDecisionOpts): boolean {
  // Derived from the single source of truth so the decision and its observed label can never drift:
  // a paid call happens for exactly the inputs namingOutcome labels "paid_haiku_fallback".
  return namingOutcome(opts) === "paid_haiku_fallback";
}

// Agents with a naming call currently in flight. Guards against a rapid double-submit firing
// two concurrent (billed) calls for the same agent: before the first resolves, both submits
// would see autoNameBasis === null and pass shouldRename.
const inFlight = new Set<string>();

/**
 * Maybe rename `agentId` based on `prompt`. Reads the agent fresh from the store (the caller's
 * reference may be stale), decides via {@link shouldHaikuName}, then calls the backend and applies
 * the result. Any failure is swallowed — the name simply doesn't change.
 */
export async function maybeAutoName(
  projectId: string,
  agentId: string,
  prompt: string,
  opts?: { bypassFirstTurnDefer?: boolean },
): Promise<void> {
  const store = useProjectStore.getState();
  const agent = store.projects.find((p) => p.id === projectId)?.agents.find((a) => a.id === agentId);
  if (!agent) return;
  // Precedence ladder (see shouldHaikuName): aiTitle wins; a self-reporting build/worker gets its
  // first turn to self-name before we ever spend a paid call; otherwise fall through to the prompt
  // heuristic. promptHistory already includes the just-submitted prompt (appendPrompt ran first),
  // so a self-reporting agent's first-ever submit reads as promptCount === 1 and is deferred.
  // Classify the branch ONCE (observation only — same ladder, no behavior change): a paid call fires
  // for exactly the inputs labeled "paid_haiku_fallback".
  const outcome = namingOutcome({
    kind: agent.kind,
    // `selfNamed` (the agent named itself via sparkle-control) is authoritative just like a manual
    // pin: fold it into the pinned signal so we never spend a paid Haiku call over a name the agent
    // already chose (bug sparkle-pel7). Telemetry note: `namingOutcome` sees only this single boolean,
    // so a self-name is counted under the SAME label as a manual pin (renameDecision → "self_named"
    // when step 3 is reached) — it is not distinguished from a human pin in the outcome metric.
    namePinned: agent.namePinned || Boolean(agent.selfNamed),
    aiTitle: agent.aiTitle,
    autoNameBasis: agent.autoNameBasis,
    promptCount: (agent.promptHistory ?? []).length,
    prompt,
    bypassFirstTurnDefer: opts?.bypassFirstTurnDefer,
  });
  if (outcome !== "paid_haiku_fallback") {
    // Every non-paid branch (aiTitle / self-named / deferred / skipped) is a self-report win or a
    // no-op — record it and stop before spending a credit.
    reportNamingOutcome(outcome, agent.kind);
    return;
  }
  if (inFlight.has(agentId)) return; // a naming call for this agent is already running (already tallied)
  inFlight.add(agentId);
  // Tally the paid fallback only once we actually commit to invoking (past the in-flight guard).
  reportNamingOutcome("paid_haiku_fallback", agent.kind);
  try {
    const name = await invoke<AgentName>("generate_agent_name", { prompt });
    // The title is the canonical `name`; the sidebar truncates it to fit and reveals the title +
    // description on hover.
    const canonical = name?.title?.trim();
    if (canonical) {
      // Re-check pinned state at apply time — the user may have renamed mid-flight. Pass the
      // aiTitle this decision was made against so the store can distinguish "we deliberately
      // renamed past a stale title" from "a title landed while we were in flight" (the latter wins).
      useProjectStore
        .getState()
        .autoRenameAgent(projectId, agentId, canonical, prompt, name, agent.aiTitle ?? null);
    }
  } catch (e) {
    // No API key, offline, or model hiccup — keep the existing name silently.
    console.debug("auto-name skipped:", e);
  } finally {
    inFlight.delete(agentId);
  }
}

// ── Name-from-work fallback (Tier 1 + Tier 2, sparkle name-from-work) ──────────────────────────
// The composer-driven namers above only fire on a prompt SUBMIT and skip tactical prompts
// (commit/push/test/build/run/continue…). So a build/worker agent that does substantial autonomous
// work but is only handed tactical prompts — or no further composer prompts at all — never gets
// renamed off its "Build N"/"Worker N" default. These two tiers run OFF the composer path (on the
// sidebar poll tick) to close that gap:
//   • Tier 1 (free)  — extend the aiTitle poll (sessionTitle.refreshAgentTitle) to also cover CLOSED
//     default-named build/workers, so Claude Code's own session title backfills the name for free.
//   • Tier 2 (paid)  — only if Tier 1 still produced nothing after a short window: ONE Haiku
//     generate_agent_name call using the agent's actual WORK (first substantive prompt / activity)
//     as basis, applied via autoRenameAgent (which re-checks precedence).
// ADDITIVE: composer naming is untouched, and both tiers defer to the same precedence ladder
// (namePinned > selfNamed > aiTitle) — a backstop name never overrides an authoritative one.

/**
 * How many CONSECUTIVE eligible poll ticks a stuck-default build/worker must survive before Tier 2
 * (the paid Haiku backstop) fires. At the sidebar's ~15s tick this is a ~15s grace window. Sized for
 * a persona that now names itself on its FIRST tool call (see sparkleControlProtocol): one tick still
 * lets self-naming and the free Tier-1 session-title backfill win first, so the paid call stays a
 * genuine last resort. Plain const (not config.toml): it's an internal timing knob, not a user-facing
 * policy, and wiring it through the Rust config schema wasn't trivial.
 */
export const WORK_BACKSTOP_WINDOW_TICKS = 1;

/** The default-name pattern per self-naming kind: "Build 3", "Worker 12" (see projectStore.defaultAgentName). */
const DEFAULT_NAME_RE: Partial<Record<AgentKind, RegExp>> = {
  build: /^Build \d+$/u,
  worker: /^Worker \d+$/u,
};

/** True iff `name` is still the untouched kind default (e.g. "Worker 2") for a build/worker agent. Pure. */
export function isUnpinnedDefaultName(kind: AgentKind, name: string): boolean {
  const re = DEFAULT_NAME_RE[kind];
  return re != null && re.test(name.trim());
}

/** The agent fields both fallback tiers read to decide eligibility. */
export interface WorkNamingAgent {
  kind: AgentKind;
  name: string;
  namePinned: boolean;
  selfNamed?: boolean | null;
  aiTitle?: string | null;
  worktreePath: string | null;
}

/**
 * Shared gate for BOTH fallback tiers: a build/worker still holding its UNPINNED DEFAULT name, not
 * self-named, with no aiTitle, that HAS a worktree (proof it actually started real work). This is the
 * set Tier 1 adds to the title poll AND the precondition Tier 2 re-checks before spending a call. Pure.
 */
export function isNameFromWorkCandidate(a: WorkNamingAgent): boolean {
  if (!isSelfNamingAgent(a)) return false; // build/worker only (never think/shell)
  if (!a.worktreePath) return false; // no worktree → hasn't done real work yet
  if (a.namePinned || a.selfNamed) return false; // an authoritative name already won
  if (a.aiTitle && a.aiTitle.trim()) return false; // Claude Code's own title already applied
  return isUnpinnedDefaultName(a.kind, a.name);
}

/**
 * Pick the best available WORK-based naming basis for the paid backstop, in priority order:
 *  (1) the first SUBSTANTIVE (non-thin, non-tactical) recorded prompt — the agent's own task/work;
 *  (2) the agent's live activity narration (set_agent_activity), if substantive;
 * else `null` → skip and keep the default. Transcript/session-title is Tier 1's job (free), so by the
 * time Tier 2 runs it has already returned nothing usable and isn't re-read here. Pure.
 */
export function workNamingBasis(
  history: PromptHistoryEntry[] | undefined,
  activity: string | undefined,
): string | null {
  for (const e of history ?? []) {
    // Skip picker answers: they're recorded to advance promptCount, but a menu choice ("Use the
    // default") is a poor name even when it survives the tactical filter, and the real task prompt
    // sits earlier in the same history. The tactical check below catches most; this catches the rest.
    if (e?.source === "picker") continue;
    const text = (e?.text ?? "").trim();
    const words = contentWords(text);
    if (words.size >= 2 && !isTacticalOnly(words)) return text;
  }
  const act = (activity ?? "").trim();
  if (act) {
    const words = contentWords(act);
    if (words.size >= 2 && !isTacticalOnly(words)) return act;
  }
  return null;
}

// Fire-once-per-agent guard for the Tier-2 paid backstop: once an agent's backstop reaches a TERMINAL
// outcome — it produced a name, or it definitively had no basis to name from — it is never retried
// this session. A TRANSIENT failure (throw, or an empty/malformed result) deliberately does NOT mark
// the agent: marking before the outcome was known meant one blip (offline, signed out, keychain
// locked, proxy 500) permanently pinned the agent at "Build N" for the whole session.
// This is a MODULE-level (process-wide, cross-project) Set — its whole job is to survive an agent
// transiently dropping out of a project's loaded agent list (project switch/reload) so a reappearing
// agent is NOT re-charged a second paid call. We deliberately do NOT prune it against any single
// project's live ids: it holds one small string per build/worker ever backstopped this session, which
// resets on app launch — a negligible, session-bounded footprint (accepted per review 36146).
const workBackstopAttempted = new Set<string>();

/**
 * Hard cap on paid `generate_agent_name` calls per agent when the backstop keeps failing without a
 * terminal verdict. This BOUNDS the retryability above: a throw is not reliably a free
 * infrastructure failure. `naming.rs` returns Err for the model's OWN judgments too — a bare SKIP
 * sentinel (naming.rs:229), a reply that reads as conversational rather than a title, or no usable
 * title — and those calls DID reach the model, so they were billed. Worse, they're deterministic
 * for a fixed basis: the same basis re-judged next tick returns the same nothing. Without this cap
 * such an agent would re-invoke on every ~15s tick for the whole session, billing each one, which
 * is exactly the "genuine last resort" cost goal this tier exists to protect.
 *
 * Why a blunt count rather than classifying the error: the alternative is matching Rust's error
 * STRINGS across the Tauri boundary, where a reworded message silently degrades back to the
 * unbounded loop — an expensive way to be wrong. A small cap is robust to that drift and costs at
 * most 3 Haiku calls in the pathological case.
 *
 * The budget is per-AGENT and deliberately ignores basis drift. `workNamingBasis` can fall back to
 * the live `activity` narration, which changes as the agent works, so a per-basis budget would mint
 * a fresh 3 calls for every new activity string — i.e. exactly the unbounded paid loop this cap
 * exists to close. The accepted cost of keying per-agent: an agent whose early basis the model
 * SKIPs three times is burned for the session even if it later accumulates work that would name
 * cleanly. That is strictly better than the pre-fix behavior (burned on the FIRST failure), and the
 * free tiers — self-naming and the Tier-1 session-title backfill — can still rescue it.
 *
 * Also accepted: a genuinely offline user spends the budget on free failures and is then burned
 * (~45s of tolerance).
 */
export const MAX_WORK_BACKSTOP_ATTEMPTS = 3;

/** Per-agent count of non-terminal backstop attempts, against MAX_WORK_BACKSTOP_ATTEMPTS. Same
 *  module-level, session-bounded rationale as workBackstopAttempted. */
const workBackstopFailures = new Map<string, number>();

/** This agent's backstop is finished for the session — it named, or it definitively can't. Retires
 *  BOTH structures together so they can't drift: once the Set holds an id, the counter for it is
 *  dead weight (the fire-once guard short-circuits before it is ever read again). */
function markTerminal(agentId: string): void {
  workBackstopAttempted.add(agentId);
  workBackstopFailures.delete(agentId);
}

/** Record one non-terminal (retryable) attempt, promoting the agent to TERMINAL once it has burned
 *  through the cap — so retries can never become an unbounded paid loop. */
function countRetryableAttempt(agentId: string): void {
  const n = (workBackstopFailures.get(agentId) ?? 0) + 1;
  workBackstopFailures.set(agentId, n);
  if (n >= MAX_WORK_BACKSTOP_ATTEMPTS) markTerminal(agentId);
}

/**
 * Tier 2 — the paid Haiku backstop. For an eligible build/worker (see {@link isNameFromWorkCandidate})
 * that still holds an unpinned default after Tier 1 found no session title, spend ONE
 * `generate_agent_name` call using the agent's WORK as basis (never a composer/tactical prompt).
 * Succeeds AT MOST ONCE per agent. Applies via `autoRenameAgent`, which re-checks the precedence
 * ladder (namePinned > selfNamed > aiTitle) at apply time, so a name that became authoritative
 * mid-flight is never clobbered. Best-effort: a failure keeps the default silently (console.debug)
 * and stays RETRYABLE on a later tick — only a terminal outcome burns the attempt.
 */
export async function maybeNameFromWork(projectId: string, agentId: string): Promise<void> {
  if (workBackstopAttempted.has(agentId)) return; // already attempted this session (fire once)
  const store = useProjectStore.getState();
  const agent = store.projects.find((p) => p.id === projectId)?.agents.find((a) => a.id === agentId);
  if (!agent) return;
  if (!isNameFromWorkCandidate(agent)) return; // not eligible: pinned/self-named/titled/wrong-kind/no work
  if (inFlight.has(agentId)) return; // a composer-path naming call is mid-flight — retry next tick
  const basis = workNamingBasis(agent.promptHistory, agent.activity);
  if (!basis) {
    // TERMINAL: no substantive work to name from (all prompts tactical/thin, no activity). Re-scanning
    // on a later tick would find the same nothing, so burn the attempt here and keep the default.
    markTerminal(agentId);
    reportNamingOutcome("work_backstop_skipped", agent.kind);
    return;
  }
  inFlight.add(agentId);
  try {
    const name = await invoke<AgentName>("generate_agent_name", { prompt: basis });
    const canonical = name?.title?.trim();
    if (canonical) {
      // TERMINAL: we produced a name, so never spend a second call for this agent.
      markTerminal(agentId);
      // Tally only a call that actually PRODUCED a name — a throw/empty result (no key, offline,
      // model hiccup) spends nothing usable and must not depress naming coverage (namingCoverage
      // counts this label as `paid`). This is intentionally stricter than the composer-path
      // `paid_haiku_fallback`, which tallies the committed attempt.
      reportNamingOutcome("work_haiku_backstop", agent.kind);
      useProjectStore.getState().autoRenameAgent(projectId, agentId, canonical, basis, name);
    } else {
      // An empty/malformed result is treated as retryable (the model may have hiccuped) but STILL
      // counts against the cap — this call reached the model and was billed.
      countRetryableAttempt(agentId);
    }
  } catch (e) {
    // Retryable — no API key yet, offline, keychain locked, proxy 500. Deliberately do NOT mark the
    // attempt terminal: the old code marked it BEFORE the invoke, so a single blip permanently
    // pinned the agent at its default for the whole app session (that Set is module-level and never
    // pruned). Counted against the cap, because a throw is NOT reliably a free failure — naming.rs
    // also returns Err for the model's own SKIP/unusable-title verdicts, which were billed and are
    // deterministic for this basis. See MAX_WORK_BACKSTOP_ATTEMPTS.
    countRetryableAttempt(agentId);
    console.debug("work-backstop name skipped (retryable):", e);
  } finally {
    inFlight.delete(agentId);
  }
}

/** Test-only: clear the once-per-agent + in-flight guards so each case starts from a clean slate. */
export function __resetNamingGuards(): void {
  workBackstopAttempted.clear();
  workBackstopFailures.clear();
  inFlight.clear();
}
