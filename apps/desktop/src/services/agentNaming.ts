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
import type { AgentKind, AgentName } from "../types";

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

/** Exported for unit testing: should this prompt trigger a (re)naming call? */
export function shouldRename(opts: {
  namePinned: boolean;
  autoNameBasis: string | null;
  prompt: string;
}): boolean {
  const words = contentWords(opts.prompt);
  // Need at least a little substance — don't burn a call on "ok" / "continue" / "yes".
  if (opts.namePinned || words.size < 2) return false;
  // Skip prompts that are entirely an operational command or an ack — no work to name, no call.
  // (Anything subtler is caught by the model's own SKIP judgment in naming.rs.)
  if (isTacticalOnly(words)) return false;
  // First substantive prompt for this agent: always name it.
  if (!opts.autoNameBasis) return true;
  // Otherwise only re-name when the work has clearly shifted.
  return similarity(words, contentWords(opts.autoNameBasis)) < RENAME_SIMILARITY_THRESHOLD;
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
 *  1. `aiTitle` present → NO call. Claude Code's own session title is derived from the WHOLE
 *     conversation and is authoritative; the prompt-only Haiku name must never fight it.
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
export function shouldHaikuName(opts: {
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
}): boolean {
  // (1) Claude Code's whole-conversation title wins outright.
  if (opts.aiTitle) return false;
  // (2) A self-reporting agent hasn't had a chance to self-name on its first prompt — defer,
  //     unless this is the worker's one-shot spawn-time naming (see bypassFirstTurnDefer).
  if (!opts.bypassFirstTurnDefer && isSelfNamingAgent(opts) && opts.promptCount < 2) return false;
  // (3) Everything else follows the existing prompt heuristic (pinned/thin/tactical/similarity).
  return shouldRename({ namePinned: opts.namePinned, autoNameBasis: opts.autoNameBasis, prompt: opts.prompt });
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
  if (
    !shouldHaikuName({
      kind: agent.kind,
      namePinned: agent.namePinned,
      aiTitle: agent.aiTitle,
      autoNameBasis: agent.autoNameBasis,
      promptCount: (agent.promptHistory ?? []).length,
      prompt,
      bypassFirstTurnDefer: opts?.bypassFirstTurnDefer,
    })
  ) {
    return;
  }
  if (inFlight.has(agentId)) return; // a naming call for this agent is already running
  inFlight.add(agentId);
  try {
    const name = await invoke<AgentName>("generate_agent_name", { prompt });
    // The title is the canonical `name`; the sidebar truncates it to fit and reveals the title +
    // description on hover.
    const canonical = name?.title?.trim();
    if (canonical) {
      // Re-check pinned state at apply time — the user may have renamed mid-flight.
      useProjectStore.getState().autoRenameAgent(projectId, agentId, canonical, prompt, name);
    }
  } catch (e) {
    // No API key, offline, or model hiccup — keep the existing name silently.
    console.debug("auto-name skipped:", e);
  } finally {
    inFlight.delete(agentId);
  }
}
