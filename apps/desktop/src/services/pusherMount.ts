// THE BINDING THAT WAS MISSING — app state and effects, wired into the Pusher's sweep.
//
// ── WHAT THIS CHANGES ────────────────────────────────────────────────────────────────────────────
// Eight modules in `@sparkle/core` decide what a Pusher may notice, what it may say, how often, and
// to whom; `pusherRunner` performs one sweep; `pusherSnapshots` maps app state into the shape they
// read. All of it was complete, tested as arithmetic, and NEVER RUN. `pusherRunner`'s own header
// said so: *"`startPusherRunner` and `sweepPushers` have no production caller: the only place they
// are invoked is `pusherRunner.test.ts`."* Both files sat in `scripts/dormant-modules.allow`.
//
// That is the literal answer to the founder's *"the pusher… is not cycling"*. Nothing was wrong with
// the Pusher's judgement; it had never been asked for one. This file is the ~200 lines that ask.
//
// ── THE THREE TARGETS, IN HIS ORDER OF PREFERENCE ────────────────────────────────────────────────
// *"push the BUILD AGENT when it can act; push the CONCIERGE when only it can; reach the FOUNDER
// only when neither can."* The sweep already splits its findings exactly that way and it is worth
// naming which mechanism carries which, because the split is not new here — only the delivery is:
//
//   • BUILD AGENT — `decidePusherAction` raises a per-partner challenge for a condition the partner
//     itself can clear (unpushed work, an expired goal, a roborev lap past the plateau, an
//     unanswered question). Delivered to its inbox, with `BLOCKER_ASK` appended so the answer comes
//     back in a form something can read.
//   • CONCIERGE — `decideFleetReport` batches the conditions whose subjects CANNOT act: an agent
//     walled behind an account limit, a goal the app reserves for a human, several agents killed by
//     one event, an overdue app duty. Those are what `reportRecipient` names a recipient for, and
//     that recipient is now the concierge rather than nobody.
//   • FOUNDER — not reached from here at all. He is reached only through the concierge's own
//     judgement about what it was told, which is the escalation of last resort the design asks for.
//
// ── EVERY PUSH IS VERIFIED, AND AN UNVERIFIED ONE IS A FAILURE ───────────────────────────────────
// Non-negotiable, and for good reason: three of this app's delivery paths have been caught reporting
// success nobody observed (sparkle-bbghz, sparkle-bhhu1, sparkle-b3coh). `deps.send` returning true
// is the event that SPENDS one of four hourly slots and advances the cooldown, so a false positive
// costs a real message about a real condition. See `sendVerified`.
//
// ── WHY THE TERMINAL IS NOT USED ─────────────────────────────────────────────────────────────────
// The submit key is dead fleet-wide (sparkle-bhhu1: text reaches the prompt, Enter does not send it,
// and `send_control_key` returns ok anyway), and a terminal write refuses outright while an agent is
// in a full-screen TUI. The inbox has neither problem: it is queued, drained at the agent's own Stop
// boundary, and `O_EXCL`-claimed so the two delivery paths cannot double-send. That is a route
// around sparkle-bhhu1 rather than a fix for it.

import {
  BLOCKER_ASK,
  PUSHERS_DISABLED,
  resolvePusherPolicy,
  type PusherPolicy,
  type StandingDuty,
} from "@sparkle/core";
import { invoke } from "@tauri-apps/api/core";
import { log } from "../logger";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useSettingsStore } from "../stores/settingsStore";
import { quotaBlockForAgent, lastFailureForAgent } from "../engine/engineRegistry";
import { getConfig, onConfigChanged } from "./config";
import { ownsProjectInThisWindow } from "./goalContinuationRunner";
import { notifyConcierge } from "./conciergeNotifier";
import { IMPROVEMENT_INTERVAL_MS } from "./improvementPass";
import { buildFleetSnapshots, buildStandingDuties } from "./pusherSnapshots";
import { startPusherRunner, type PusherLogEntry, type PusherRunnerDeps } from "./pusherRunner";

/**
 * The recipient id that means "the concierge", reusing the identity the control bridge already
 * stamps (`bridge.rs::CONCIERGE_CALLER_AGENT_ID`, mirrored in `controlListener`).
 *
 * WHY A SENTINEL RATHER THAN A NEW DEP. `reportRecipient` returns an agent id and `send` delivers to
 * it, and every rule in `reportFleet` — the shared hourly budget, the per-project memory that is
 * never pruned, the "no recipient, no report, but the sighting still advances" rule — is written
 * against that pair. Adding a second delivery dep would have meant duplicating all of it for one
 * recipient. Branching inside `send` reuses every one of those rules unchanged, and `pusherRunner`
 * needed no edit at all.
 */
export const CONCIERGE_RECIPIENT_ID = "sparkle:concierge";

/**
 * The resolved `[pushers]` policy, cached.
 *
 * Read once at start and refreshed on change rather than awaited per sweep: `sweepPushers` takes
 * `policy()` synchronously, and a config read is a Tauri round-trip that would put an IPC call in
 * front of every cycle for a value that changes when a human edits a file.
 *
 * DISABLED until the first read resolves, which is the fail-safe direction and matches
 * `PUSHERS_DISABLED`'s own reasoning: a sweep that ran before the config was known would be a
 * feature switched on underneath the user's setting.
 */
let policy: PusherPolicy = PUSHERS_DISABLED;

/** The last log line per agent, so the hit-rate log stays readable at DEBUG. */
function recordDecision(entry: PusherLogEntry): void {
  if (entry.outcome === "sent") {
    log.info("pusher", `pushed ${entry.agentId}`, {
      scope: entry.scope ?? "partner",
      trigger: entry.triggerId,
      cited: entry.cited,
    });
    return;
  }
  // Refusals are the overwhelming majority — a fleet of 30 produces 30 of them per cycle — so they
  // are DEBUG. The ones worth seeing at WARN are the two that mean a push was owed and did not land.
  if (entry.reason === "transport-failed") {
    log.warn("pusher", `push to ${entry.agentId} did not land; it stays owed`, {
      scope: entry.scope ?? "partner",
      trigger: entry.triggerId,
    });
    return;
  }
  log.debug("pusher", `quiet on ${entry.agentId}`, { reason: entry.reason });
}

/**
 * Deliver one push and CONFIRM it, returning false unless it was independently observed to land.
 *
 * Two recipients, two verifications, and neither trusts the call's own return value:
 *
 *   • THE CONCIERGE — handed to the registered proactive sink. `notifyConcierge` returns whether a
 *     sink existed and accepted it; there is nothing further to read back, because the finding is
 *     now inside the scheduler's own owed-until-delivered list, which survives a decline by design.
 *   • A BUILD AGENT — queued with `inbox_send`, then READ BACK with `inbox_status`: the message id
 *     must appear in that agent's `pendingIds`, or the push is treated as failed. `inbox_send` now
 *     reads back inside Rust too (sparkle-bbghz), so this is the second of two independent checks —
 *     deliberately, because the one thing the Rust read-back cannot prove is that the reader and the
 *     writer resolved the same inbox, and this call is made by the reader.
 *
 * A message already CLAIMED between the send and the read is the one benign way `pendingIds` can
 * miss it, so a rising `delivered`/`pending` total counts as landed too — the agent taking a message
 * faster than we could look must not be recorded as a lost one.
 */
async function sendVerified(agentId: string, text: string): Promise<boolean> {
  if (agentId === CONCIERGE_RECIPIENT_ID) return notifyConcierge(text);

  let messageId: string;
  try {
    messageId = await invoke<string>("inbox_send", { agentId, text, severity: "act" });
  } catch (e) {
    log.warn("pusher", "inbox_send refused", { agentId, error: String(e) });
    return false;
  }

  try {
    const rows = await invoke<Array<{ agentId: string; pending: number; pendingIds: string[]; delivered: number }>>(
      "inbox_status",
      { agentIds: [agentId] },
    );
    const row = rows.find((r) => r.agentId === agentId);
    if (row === undefined) {
      log.warn("pusher", "push unverified — no inbox row came back", { agentId, messageId });
      return false;
    }
    if (row.pendingIds.includes(messageId)) return true;
    // Claimed already: gone from `pendingIds`, counted in `delivered`. Delivery is what we wanted.
    if (row.delivered > 0) return true;
    log.warn("pusher", "push unverified — the id is not in the queue we just wrote to", {
      agentId,
      messageId,
    });
    return false;
  } catch (e) {
    // COULD NOT LOOK is not DID NOT LAND, but it is not evidence of landing either, and the rule
    // here is that an unverified push is a failed one. Costs at worst one duplicate next sweep;
    // the alternative costs a silent hole, which is the whole class of bug this loop exists inside.
    log.warn("pusher", "push unverified — status read failed", { agentId, error: String(e) });
    return false;
  }
}

/** One batched `inbox_status` for the whole fleet — one IPC call per sweep, not one per agent. */
async function inboxUsage(agentIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (agentIds.length === 0) return out;
  const rows = await invoke<Array<{ agentId: string; pending: number }>>("inbox_status", { agentIds });
  for (const r of rows) out.set(r.agentId, r.pending);
  // The concierge has no inbox and never will — it is reached through the proactive channel, not
  // through a queue. Reporting it as EMPTY rather than leaving it absent matters: an absent entry
  // reads as FULL by `sweepPushers`' fail-closed rule, which would make the fleet report yield every
  // cycle and the concierge would never be told anything.
  out.set(CONCIERGE_RECIPIENT_ID, 0);
  return out;
}

/**
 * The app's standing duties, read fresh each sweep so a pass that starts or stops is picked up.
 *
 * `improvementHeldBy` IS DELIBERATELY NOT SUPPLIED YET, and the omission is worth stating because
 * `buildStandingDuties` accepts it and `PASS_HOLD_TEXT` exists to render it. `passHoldReason(gate)`
 * needs a `PassGate` assembled from the consent setting, the in-flight flag, the Sparkle pane's live
 * status and connectivity — i.e. the scheduler's own decision inputs, which are not reachable from a
 * background sweep without duplicating that assembly and risking a second, disagreeing opinion.
 *
 * The consequence is bounded and one-directional: `duty-overdue` still fires on the arithmetic
 * (`elapsed >= interval * 2`), so an overdue hourly pass is still reported; the report simply cannot
 * yet name WHICH arm is holding it. That is a less useful sentence, never a wrong one. Wiring it
 * means lifting the gate assembly into a shared reader, which belongs with the scheduler.
 */
function duties(): readonly StandingDuty[] {
  const s = useSettingsStore.getState();
  return buildStandingDuties({
    improvementLastRunAt: s.improvementLastRunAt,
    improvementIntervalMs: IMPROVEMENT_INTERVAL_MS,
  });
}

/** Everything the sweep can tell us, bound to the live stores. */
export function buildPusherDeps(): PusherRunnerDeps {
  return {
    now: () => Date.now(),
    policy: () => policy,
    ownsProject: ownsProjectInThisWindow,
    snapshots: () =>
      buildFleetSnapshots({
        projects: useProjectStore.getState().projects,
        branchStatus: useRuntimeStore.getState().branchStatus,
        quotaFor: quotaBlockForAgent,
        failureFor: lastFailureForAgent,
        now: Date.now(),
      }),
    inboxUsage,
    // THE ASK RIDES THE CHALLENGE. `decidePusherAction` has already measured why this partner is
    // being spoken to; appending `BLOCKER_ASK` turns a statement into a question whose answer is
    // machine-readable, which is what closes the loop — otherwise the challenge lands, the agent
    // narrates, and nothing reads what it said. The ask carries no digits precisely so it cannot
    // trip `checkCitations`; `pusherBlocker` pins that with a test against the real gate.
    send: (agentId, text) =>
      sendVerified(agentId, agentId === CONCIERGE_RECIPIENT_ID ? text : `${text}\n\n${BLOCKER_ASK}`),
    // EVERY PROJECT REPORTS TO THE CONCIERGE. It is not required to be an agent in that project —
    // `reportFleet` is explicit that `reportRecipient(projectId)` need not name one — and the
    // concierge is the correct single recipient for exactly the conditions this channel carries:
    // they are the ones no partner can act on.
    reportRecipient: () => CONCIERGE_RECIPIENT_ID,
    duties,
    record: recordDecision,
  };
}

/**
 * Start the Pusher for this window. Returns the stopper.
 *
 * SURVIVES ITS OWN TURN ENDING, which was the founder's actual requirement — *"it must run
 * continuously, not as a one-shot build agent that finishes and stops"*. This is a `setInterval` in
 * the desktop app rather than an agent with a task list, so there is no turn for it to end: it keeps
 * cycling for as long as a window is open, exactly like `startFleetWatch` and
 * `startGoalContinuationRunner` beside it. The previous Pusher was a build agent, which is why it
 * completed its work and went idle.
 *
 * Per-window rather than per-app, deduplicated the same way its siblings are: `ownsProject` elects a
 * single owner per project, so a torn-off satellite window observes the fleet but does not double
 * every push.
 */
export function startPusher(): () => void {
  let stopped = false;
  let unlisten: (() => void) | undefined;

  // Seed the policy, then follow it. Both are best-effort: a config read that fails leaves the
  // Pusher disabled, which is the safe direction and is what an older backend produces anyway.
  void getConfig()
    .then((eff) => {
      policy = resolvePusherPolicy(eff.config.pushers);
      log.info("pusher", "policy resolved", {
        enabled: policy.enabled,
        intervalMs: policy.observeIntervalMs,
        perHour: policy.messagesPerHour,
      });
    })
    .catch((e) => log.warn("pusher", "config read failed; staying disabled", { error: String(e) }));

  void onConfigChanged((eff) => {
    policy = resolvePusherPolicy(eff.config.pushers);
  })
    .then((un) => {
      if (stopped) un();
      else unlisten = un;
    })
    .catch((e) => log.warn("pusher", "config subscription failed", { error: String(e) }));

  // The TICK is fixed at the policy floor, and the policy's own `observeIntervalMs` is enforced
  // inside the sweep by the per-trigger cooldowns and the hourly budget rather than by the timer.
  // Ticking at the floor is what lets a config change take effect without a restart — a timer built
  // from a policy that had not loaded yet would be stuck at the default for the life of the window.
  const stopRunner = startPusherRunner(buildPusherDeps(), MIN_TICK_MS);

  return () => {
    stopped = true;
    stopRunner();
    unlisten?.();
  };
}

/**
 * How often the sweep wakes, in ms.
 *
 * ONE MINUTE, which is `MIN_OBSERVE_INTERVAL_MS` — the floor the policy itself refuses to go below.
 * A sweep is a store read plus at most one batched IPC call and no model call, so the cost of waking
 * is small; what bounds the Pusher's actual volume is the four-per-hour budget and the four-hour
 * repeat cooldown, neither of which the timer can relax. Waking often and speaking rarely is the
 * right shape for a watchdog: it is what makes the two-observation rule cheap enough to be honest,
 * and it means a condition is noticed a minute after it becomes true rather than five.
 */
export const MIN_TICK_MS = 60_000;
