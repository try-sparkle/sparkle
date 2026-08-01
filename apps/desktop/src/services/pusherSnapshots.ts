// THE ADAPTER — app state in, `FleetSnapshot` out, and nothing else.
//
// `@sparkle/core` is a leaf: it must not import a store, an engine, or a Tauri command, so every
// fleet condition it decides is a pure function of a snapshot somebody else gathered. This is that
// somebody. It is the only file that knows both halves, and it is deliberately dumb — it maps
// fields, it does not decide anything. A judgement made here would be a second opinion about the
// same agent, invisible to the arithmetic tests in `packages/core`.
//
// ── PURE, AND TAKING ITS SOURCES AS PARAMETERS ───────────────────────────────────────────────────
// The stores and the engine registry arrive as arguments rather than being read from module scope,
// which is what lets the mapping be tested without a running app.
//
// NOT YET WIRED, AND SAYING SO IS THE POINT (roborev 57313/57341). An earlier version of this
// comment described a `fleetSnapshotsNow()` wrapper "at the bottom" that does the store reading.
// No such function exists anywhere in the repo, and nothing outside the tests imports this module —
// so the sentence told the next reader the app -> `@sparkle/core` seam was connected when it is not,
// and pointed the file's whole safety argument at code that was never written.
//
// What is genuinely missing is exactly the part these unit tests structurally cannot cover: binding
// `branchStatus` by `agent.id` and `quotaFor`/`failureFor` to the right registry functions. That
// arrives with the surface that renders these conditions.
//
// ── THE ONE RULE THAT MATTERS ────────────────────────────────────────────────────────────────────
// FAIL CLOSED, inherited verbatim from `pusherObserve`: `undefined` means WE DID NOT LOOK and must
// never satisfy anything. It has real teeth in exactly one place here — `hasUnlandedWork`, which
// feeds the "safe to retire" claim. Getting that wrong does not produce a noisy message; it tells
// the founder to discard an agent holding commits nobody merged. So it is only ever `false` on
// AFFIRMATIVE evidence of a clean tree, and `undefined` whenever the branch poll has not run.

import type { FleetSnapshot, StandingDuty } from "@sparkle/core";
import type { AgentTab, Project } from "../types";
import type { BranchStatus } from "./branchStatus";
import type { QuotaBlock } from "../engine/quotaBlock";
import type { PassHoldReason } from "./improvementPass";
import { agentDisplayName } from "../engine/agentDisplayName";

/** Everything the mapping reads. Supplied by the caller so this stays testable and pure. */
export interface FleetSnapshotInput {
  /** `projectStore.projects` — the Pusher spans every project, ownership is filtered downstream. */
  projects: readonly Project[];
  /** `runtimeStore.branchStatus`. A MISSING entry is "not polled", never "clean". */
  branchStatus: Readonly<Record<string, BranchStatus>>;
  /** `engineRegistry.quotaBlockForAgent`. */
  quotaFor(agentId: string, now: number): QuotaBlock | undefined;
  /** `engineRegistry.lastFailureForAgent`. */
  failureFor(agentId: string): { message: string; at: number } | undefined;
  now: number;
}

/**
 * Is this agent's tree affirmatively CLEAN, affirmatively HOLDING work, or unknown?
 *
 * Three-valued on purpose, and the `undefined` arm is the one doing the safety work — see the header.
 *
 * `worktreeOnBranch === false` reads as UNKNOWN rather than as either answer. `BranchStatus` says a
 * parked tree's dirt belongs to some other branch, so `dirty` cannot be attributed to this agent —
 * but `ahead` is derived from the branch ref and stays true. Rather than mix one trustworthy field
 * with one untrustworthy one to reach a claim as consequential as "safe to retire", a parked tree
 * declines to answer.
 */
export function unlandedWorkOf(status: BranchStatus | undefined): boolean | undefined {
  if (status === undefined) return undefined;
  if (status.worktreeOnBranch === false) return undefined;
  if (status.ahead > 0 || status.dirty) return true;
  return false;
}

/** One agent's snapshot. Exported for the tests, which assert the mapping field by field. */
export function snapshotOfAgent(
  agent: AgentTab,
  input: FleetSnapshotInput,
): FleetSnapshot & { agentId: string } {
  const branch = input.branchStatus[agent.id];
  const quota = input.quotaFor(agent.id, input.now);
  const failure = input.failureFor(agent.id);
  const goal = agent.goal;

  return {
    agentId: agent.id,
    // The SHARED naming rule, not a local one: the concierge, the sidebar and this report must call
    // the same agent the same thing, or a report names something the founder cannot find on screen.
    label: agentDisplayName(agent),
    ...(quota !== undefined
      ? {
          quota: {
            message: quota.message,
            resetAt: quota.resetAt,
            resetParsed: quota.resetParsed,
          },
        }
      : {}),
    // Passed through UNNORMALISED — `sharedFailureCohorts` groups on these exact bytes to recognise
    // that one host event killed several agents, and any tidying here would tidy away the evidence.
    ...(failure !== undefined ? { failure: { message: failure.message, at: failure.at } } : {}),
    // `escalatedAt` is what `goalStateOf` latches on; the reason is quoted verbatim in the report.
    ...(goal?.escalatedAt !== undefined
      ? { escalation: { ...(goal.escalationReason !== undefined ? { reason: goal.escalationReason } : {}) } }
      : {}),
    ...(goal?.metAt !== undefined ? { goalMetAt: goal.metAt } : {}),
    ...(unlandedWorkOf(branch) !== undefined ? { hasUnlandedWork: unlandedWorkOf(branch) } : {}),
  };
}

/**
 * Every agent, with the project it belongs to.
 *
 * BUILD AGENTS ONLY. Workers are excluded because the report's actions do not apply to them: a
 * worker is retired by its orchestrator rather than by the founder, and reporting one as "safe to
 * retire" would route the action to the wrong person. They still appear in their orchestrator's own
 * accounting, which is where that decision belongs.
 *
 * `projectId` rides along so the sweep's per-project ownership election and per-project report both
 * work without a second lookup.
 */
export function buildFleetSnapshots(
  input: FleetSnapshotInput,
): Array<FleetSnapshot & { projectId: string }> {
  const out: Array<FleetSnapshot & { projectId: string }> = [];
  for (const project of input.projects) {
    for (const agent of project.agents) {
      if (agent.kind !== "build") continue;
      out.push({ ...snapshotOfAgent(agent, input), projectId: project.id });
    }
  }
  return out;
}

/**
 * The app's standing duties, as the fleet report understands them.
 *
 * ── WHY THE HOURLY PASS IS HERE AT ALL ───────────────────────────────────────────────────────────
 * The consent banner promises it runs once an hour. `useImprovementScheduler` really is mounted and
 * really does tick — but `shouldRunImprovementPass` can decline every tick, indefinitely, and until
 * `passHoldReason` existed nothing recorded which arm declined. One of those arms is
 * self-sustaining: a wedged Sparkle pane reads `working`, so the pass is skipped, so the pane never
 * stops being busy. The founder found this the only way it can be found — by asking.
 *
 * `heldBy` is what makes the report actionable, so it is passed through as the caller's own words
 * rather than re-derived here; `passHoldReason` is the single source of that decision.
 */
export function buildStandingDuties(input: {
  /** `settingsStore.improvementLastRunAt`. `null` means the scheduler has not seeded — NOT overdue. */
  improvementLastRunAt: number | null;
  /** `IMPROVEMENT_INTERVAL_MS`, passed in so this file does not pin the cadence. */
  improvementIntervalMs: number;
  /** A human-readable rendering of `passHoldReason`, or undefined when nothing is holding it. */
  improvementHeldBy?: string;
}): StandingDuty[] {
  return [
    {
      name: "the hourly improvement pass (logs + beads backlog)",
      intervalMs: input.improvementIntervalMs,
      // `null` → omitted → fail-closed. An unseeded clock is not an overdue duty.
      ...(input.improvementLastRunAt !== null ? { lastRunAt: input.improvementLastRunAt } : {}),
      ...(input.improvementHeldBy !== undefined ? { heldBy: input.improvementHeldBy } : {}),
    },
  ];
}

/**
 * The hold reasons as a sentence the report can quote. Kept beside the duty it describes.
 *
 * TYPED ON `PassHoldReason`, NOT `string` (roborev 57323). As `Record<string, string>` a sixth arm
 * compiled cleanly with no text and a typo'd key compiled too — and under this project's
 * `noUncheckedIndexedAccess` the lookup is `string | undefined`, which assigns silently into the
 * optional `heldBy`. The report would then say "Nothing reports why." about a hold whose cause was
 * known, which is silent failure in the exact direction this feature exists to prevent. Keyed on the
 * union, a new arm is a compile error.
 */
export const PASS_HOLD_TEXT: Record<PassHoldReason, string> = {
  "consent-off": "improvement consent is set to never",
  "already-running": "a pass is already in flight",
  "pane-busy": "the Sparkle agent pane reads 'working' — which also prevents the next tick, so this one does not clear itself",
  "pane-wedged":
    "the Sparkle agent pane has read 'working' for over three hours — the hourly duty has been off that whole time, and it will not clear itself: interrupt or restart that pane",
  "clock-unseeded": "the scheduler has not seeded its clock yet",
  offline: "this machine is offline",
};
