// activityNarrator (bead ) — regenerate an agent's "what I'm building" line from the
// agent's OWN last turn, at every turn boundary, so the line stops depending on the agent
// remembering to write it.
//
// SEE ALSO the two halves this sits between:
//   • engine/activityNarrationPolicy — the PURE spend decision (throttle, floors). Every `true` it
//     returns is a real charge against the user's own Claude subscription.
//   • engine/activityFreshness (bead sparkle-s8y5t6) — the PURE reading rule. A line is a
//     timestamped quote, and past `ACTIVITY_STALE_MS` it renders as one.
//
// WHY THE STOP BOUNDARY. Claude Code's `Stop` hook already hands `AgentPane` the session transcript
// path at the end of every turn, and `read_transcript_last_assistant` is already called there for
// history capture. So the agent's own account of what it just did is ALREADY in hand at exactly the
// moment it is freshest — this feature is a second reader of a value the app was reading anyway, not
// a new capture, a new poll, or a new privacy surface.
//
// GATED ON `autoRename`, deliberately, and this is a scoping decision worth stating rather than
// burying. Narration is the same family as auto-naming — Sparkle generating an agent's descriptive
// text on the cheap Haiku path — and that flag already means "let Sparkle write my agents' labels".
// But the SPEND PROFILES differ: auto-naming is roughly one call per agent for the life of the
// agent, while narration is up to one call per agent per minute (see NARRATION_MIN_INTERVAL_MS), and
// this app routinely runs 60+ agents. A user who wants naming may not want that. A dedicated flag is
// the honest end state; it needs a `[ai]` config key, a settings row and a store field, so it is
// deliberately NOT invented here without the product call being made. The throttle is what actually
// bounds the cost today.
import { invoke } from "@tauri-apps/api/core";
import { noteAiProviderFailure, noteAiServiceFailure } from "./anthropic";
import { oneshotFailoverConfigDir } from "./accountSelection";
import { aiFeatureNow } from "./aiGate";
import { selfReportProtected, shouldNarrate } from "../engine/activityNarrationPolicy";

const hasTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Ask the backend (Haiku 4.5) for a one-line plain-language narration of what an agent is
 *  building, derived from the tail of its last assistant `turn`. Returns null outside Tauri and on
 *  any failure — never throws — so the caller leaves the existing line alone.
 *
 *  Mirrors `attention.summarizeAttention`, including its deliberate NON-report of AI health on the
 *  success path: `narrate_activity` is `cacheable: true`, and `claude_oneshot` serves a cache hit
 *  before spawning anything, so a duplicate Stop for one turn returns without touching the CLI.
 *  Reporting healthy from a cache hit would zero the failure run and let a wedged or signed-out CLI
 *  hide behind a banner saying everything is fine. */
export async function narrateActivity(turn: string, project?: string): Promise<string | null> {
  if (!hasTauri) return null;
  try {
    // Route off a walled default account to a healthy signed-in one when possible; undefined leaves
    // the ambient default and is dropped from the invoke.
    const configDir = await oneshotFailoverConfigDir();
    const line = await invoke<string>("narrate_activity", { turn, project, configDir });
    return typeof line === "string" && line.trim() ? line : null;
  } catch (e) {
    noteAiProviderFailure(e);
    noteAiServiceFailure(e);
    console.debug("narrate_activity failed", e);
    return null;
  }
}

/**
 * When we last ATTEMPTED a narration for each agent, keyed by agent id.
 *
 * Deliberately in-memory and NOT persisted: its only job is to stop a wedged CLI from being retried
 * every turn, and after an app restart one retry per agent is the correct behaviour — the CLI may
 * well have been fixed in between.
 */
const lastAttemptAt = new Map<string, number>();

/** Everything `maybeNarrateActivity` touches that is not a pure function, injected so the whole
 *  orchestration is testable with no Tauri, no store and no clock. */
export interface NarrateActivityDeps {
  /**
   * Stable per-agent key for the ATTEMPT ledger below. The agent id.
   *
   * A module-level Map rather than a caller-held ref ON PURPOSE: a ref lives and dies with the
   * mounted `AgentPane`, so switching agents in the sidebar would reset the throttle and reopen the
   * very hole this closes. The ledger has to outlive a remount.
   */
  agentKey: string;
  /** Epoch ms this agent's activity line was last WRITTEN (`AgentTab.activityAt`). */
  lastNarratedAt: number | undefined;
  /**
   * Provenance of the line currently on this agent (`AgentTab.activitySource`).
   *
   * Load-bearing, not diagnostic: a still-fresh `"self"` line is a deliberate statement the agent
   * chose to make, and overwriting it both destroys the one channel that can say something the
   * transcript does not show AND costs a paid ask-summary the free self-report would have supplied
   * (roborev 82272). See `SELF_REPORT_PROTECTED_MS`.
   */
  existingSource: "self" | "narrated" | undefined;
  /**
   * Re-read the line that is on the row RIGHT NOW, called immediately before the write.
   *
   * `existingSource`/`lastNarratedAt` above are a snapshot taken BEFORE the model call; this is the
   * same two fields read AFTER it. Both are needed, and neither substitutes for the other: the
   * snapshot decides whether to spend at all, this one decides whether the answer is still safe to
   * land (roborev 82276). Omitting it keeps the old blind-write behaviour, which is why the app's
   * call site supplies it.
   */
  currentLine?: () => { source: "self" | "narrated" | undefined; at: number | undefined } | undefined;
  /** The model call. Defaults to the real `narrateActivity`. */
  narrate?: (turn: string, project?: string) => Promise<string | null>;
  /** Commit the line. Defaults to the real `projectStore.setAgentActivity`, source `"narrated"`. */
  write: (line: string, now: number) => void;
  /** Injected clock. */
  now?: () => number;
  /** Whether narration may spend anything at all. Defaults to the `autoRename` AI gate. */
  enabled?: () => boolean;
  /** Diagnostic project label passed through to the model call. */
  project?: string;
  /**
   * The attempt ledger. Defaults to the module-level map, which is what makes the throttle survive
   * an `AgentPane` remount.
   *
   * INJECTED RATHER THAN RESET: the obvious alternative is a `__resetNarrationAttempts()` export
   * for tests to call between cases, and that is a test-only function on the production surface —
   * `scripts/dormant-exports.mjs` rightly fails the build for exactly that. Handing a test its own
   * Map keeps module state out of the test's way without exporting anything the app never calls.
   */
  attempts?: Map<string, number>;
}

/**
 * Narrate this agent's turn, if policy allows it.
 *
 * Resolves to the reason nothing happened (or `"narrated"`), rather than void, so a skipped call and
 * a FAILED call are distinguishable from the outside. They look identical otherwise — the line just
 * does not change — and telling them apart is the difference between "the throttle is working" and
 * "the CLI is wedged and nobody noticed".
 */
export async function maybeNarrateActivity(
  turnText: string,
  deps: NarrateActivityDeps,
): Promise<string> {
  const now = (deps.now ?? Date.now)();
  const enabled = (deps.enabled ?? (() => aiFeatureNow("autoRename")))();

  // The throttle is judged against the LATER of "we last wrote a line" and "we last tried" — see
  // NarrationDecisionInput.lastSpendAt for why the attempt half is load-bearing (roborev 82233).
  // Undefined only when NEITHER has ever happened, so a brand-new agent still narrates immediately.
  const attempts = deps.attempts ?? lastAttemptAt;
  const attemptedAt = attempts.get(deps.agentKey);
  const lastSpendAt =
    deps.lastNarratedAt === undefined && attemptedAt === undefined
      ? undefined
      : Math.max(deps.lastNarratedAt ?? 0, attemptedAt ?? 0);

  const decision = shouldNarrate({
    turnText,
    lastSpendAt,
    now,
    enabled,
    existingSource: deps.existingSource,
    // The line's own write time IS `lastNarratedAt` — the attempt ledger must not be folded in
    // here, or a failed narration attempt would age a self-report it never touched.
    existingAt: deps.lastNarratedAt,
  });
  if (!decision.narrate) return decision.reason;

  // STAMP BEFORE THE AWAIT, not after. Two reasons, and the second is the one that bites: a call
  // that fails must still count as a spend (that is the whole fix), and a second Stop arriving
  // while this one is still in flight must see the attempt already recorded — otherwise two
  // concurrent turns both pass the throttle and both spend.
  attempts.set(deps.agentKey, now);

  const narrate = deps.narrate ?? narrateActivity;
  const line = await narrate(turnText, deps.project);
  // A failed or empty narration leaves the PREVIOUS line in place, with its honest age showing,
  // rather than clearing it. An empty line is strictly worse than a stale one that says so: the
  // stale line still tells you what the agent was last known to be doing.
  if (!line || !line.trim()) return "no-line";

  // COMPARE-AND-SWAP, not a blind assignment (roborev 82276). Everything above decided against a
  // snapshot taken before the await; the store applies `setAgentActivity` as a plain overwrite, so
  // a deliberate self-report that landed while the model was thinking would be destroyed here — and
  // stamped with the pre-await `now`, rewinding the row's clock backwards on top of it. Re-ask the
  // SAME predicate against the live row and abandon the answer we already paid for: a line the
  // agent chose to write beats a recap of the turn before it, and the spend is already recorded in
  // the attempt ledger so this cannot become a retry loop.
  const current = deps.currentLine?.();
  if (current && selfReportProtected(current.source, current.at, now)) return "self-report-arrived";

  // Stamp with the SAME `now` the policy judged against, not a second Date.now(). The throttle and
  // the stamp must agree, or a slow model call shifts the next eligible time and the interval
  // silently drifts longer than it is documented to be.
  deps.write(line.trim(), now);
  return "narrated";
}
