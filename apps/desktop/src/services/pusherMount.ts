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
import { useConflictStore } from "../stores/conflictStore";
import { useSettingsStore } from "../stores/settingsStore";
import { quotaBlockForAgent, lastFailureForAgent } from "../engine/engineRegistry";
import { useBeadsStore } from "../stores/beadsStore";
import {
  ensureSparkleRepo,
  PIPELINE_HEALTH_LABEL,
  sparkleAgentIdFor,
  SPARKLE_PROJECT_ID,
} from "./sparkleAgent";
import { sweepImproveNudge, type ImproveNudgeDeps } from "./improveNudge";
import { getConfig, onConfigChanged, type BabysitConfigPayload } from "./config";
import { startConflictFlags } from "./conflictFlags";
import { startBabysitDispatcher } from "./babysitDispatcher";
import { currentWindowLabel, ownsProjectInThisWindow } from "./goalContinuationRunner";
import { notifyConcierge } from "./conciergeNotifier";
import { IMPROVEMENT_INTERVAL_MS } from "./improvementPass";
import {
  buildConciergeQueue,
  buildFleetSnapshots,
  buildStandingDuties,
  sessionEndedOf,
} from "./pusherSnapshots";
import { refreshResearch } from "./research/store";
import { cachedReceipt, loadRetroReceipts } from "./retroReceipts";
import { retroSettled } from "../engine/retroReceiptTypes";
import { startPusherRunner, type PusherLogEntry, type PusherRunnerDeps } from "./pusherRunner";
import { makePusherVerifier, type PusherVerifierDeps, type VerifyScope } from "./pusherVerifier";
import { agentBranchStatus, agentWorkflowState } from "./branchStatus";
import { fetchOpenPrs } from "./openPrs";

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
 *   • THE CONCIERGE — handed to the registered proactive sink. `notifyConcierge` returns whether the
 *     scheduler ACCEPTED it, which is the same question the inbox read-back below asks: is the
 *     message now sitting in a queue that will be drained. There is nothing further to read back
 *     once it is, because the finding is then inside the scheduler's own owed-until-delivered list,
 *     which survives a decline by design.
 *
 *     THIS BULLET USED TO BE A LIE AND IS WORTH THE PARAGRAPH (bead sparkle-qogah). It said "a sink
 *     existed and accepted it" while `notifyConcierge` could only observe the first half: the sink
 *     returned `void`, so a scheduler that discarded the text on its own `disposed` guard — or by
 *     truncating its owed list — was reported here as a delivery. `sweepPushers` then took the
 *     `delivered` branch on that `true`, spending one of four hourly slots and stamping the
 *     condition as reported for FOUR HOURS. A destroyed finding was therefore also suppressed at
 *     source for four hours, by the same call that destroyed it. Nothing in this file changed to fix
 *     it and nothing needed to: the sink is honest now, so `sendVerified` passing its answer through
 *     is finally the verification this header always claimed it was.
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

/**
 * RUNTIME ARM for the never-idle watcher, read from config.toml `[improvement].never_idle_armed`.
 *
 * A nudge auto-resumes the Improve Sparkle agent's next turn — a write — so this used to ship inert
 * behind a build-time `VITE_SPARKLE_NEVER_IDLE` flag (AGENTS.md "A hook that WRITES ships inert").
 * The founder has now reviewed the operating-contract change and armed it BY DEFAULT, and moved the
 * switch to config so it can be toggled without cutting a new DMG. So the default is ON: armed
 * unless config explicitly sets the key to false. The other guards below — an actually-idle Improve
 * Sparkle agent, ready backlog, this window owning sparkle-self — are what keep an armed build from
 * nudging when there is nothing to do. Guarded so a store not yet hydrated reads the ON default
 * rather than throwing.
 */
function neverIdleArmed(): boolean {
  try {
    return useSettingsStore.getState().improvementNeverIdleArmed !== false;
  } catch {
    return true;
  }
}

/** Live count of the Improve Sparkle project's ready work — the board's `backlog` column (open,
 *  unblocked, non-stalled, telemetry-filtered) and, counted separately, its open P1 pipeline-health
 *  beads (so a blocked-but-open P1 still says "there is work"). Both read from the 5s beads poll's
 *  cached snapshot — no `bd` shell call on this 60s tick, which is what keeps the watcher cheap. */
function improveReadyBacklog(): { ready: number; p1PipelineHealth: number } {
  const snap = useBeadsStore.getState().byProject[SPARKLE_PROJECT_ID];
  if (snap === undefined) return { ready: 0, p1PipelineHealth: 0 };
  const p1PipelineHealth = snap.beads.filter(
    (b) => b.status === "open" && b.priority === 1 && b.labels.includes(PIPELINE_HEALTH_LABEL),
  ).length;
  return { ready: snap.board.backlog.length, p1PipelineHealth };
}

/**
 * The improve agent's advance fingerprint — keyed off the ONE signal reliably populated for this
 * agent: its own pane `status` (written by `SparkleAgentPane`'s `onStatus`). It MOVES whenever the
 * agent's own turn re-opens (`idle` ↔ `working`), so a run of the SAME resting status across the whole
 * interval reads as "did not advance", and an agent whose own turn is doing the work shows `working`
 * and is never judged idle — the concierge's correction (children-exist must not read as busy).
 *
 * ── HONEST LIMITS OF THIS v1 SIGNAL, stated because the reviews are right about them (roborev 66034) ─
 * This is a COARSE PROXY, not a true concrete-advance detector, in two ways a follow-up should close
 * with a cumulative BRANCH-STATUS signal (commit count + edit count, polled from the worktree):
 *   • At the decision instant the pane is by definition resting (the decision only reaches the advance
 *     check when `paneStatus ∈ RESTING`), so `advancedRecently` degenerates to "the pane has been at
 *     the same rest for the interval" — it does not measure a commit or an edit directly.
 *   • It samples a LEVEL on the ~60s tick, so a whole working turn that opens and closes between two
 *     ticks is invisible. An agent doing a run of sub-minute turns could read as flat.
 * The consequence is a possible SPURIOUS nudge (a low-harm inbox message, rate-limited to 10 min) for
 * an agent doing very short turns — never a missed one. That residual is acceptable for a v1 that
 * SHIPS INERT behind the arming gate and is reviewed before it is switched on; it is not acceptable as
 * a permanent design, hence the branch-status follow-up.
 *
 * `undefined` status → `null` (UNREADABLE → the watcher does not judge idle), the fail-safe direction.
 */
function improveAdvanceFingerprint(agentId: string): string | null {
  return useRuntimeStore.getState().status[agentId] ?? null;
}

/**
 * The never-idle watcher's evidence, bound to the live stores. Resolves THIS window's own Improve
 * Sparkle id the same way the ownership election does (`sparkleAgentIdFor(currentWindowLabel())`) and
 * uses that ONE id for the pane read, the advance read AND the send — so the agent whose idleness is
 * judged is the agent that is nudged (roborev 66020/66021), and the message lands in the inbox that
 * agent actually drains (`SPARKLE_INBOX_AGENT` is the pane's own id).
 */
export function buildImproveNudgeDeps(): ImproveNudgeDeps {
  const improveAgentId = (): string => sparkleAgentIdFor(currentWindowLabel());
  return {
    now: () => Date.now(),
    armed: neverIdleArmed,
    ownsProject: () => ownsProjectInThisWindow(SPARKLE_PROJECT_ID),
    consentIsNever: () => useSettingsStore.getState().sparkleImprovementConsent === "never",
    paneStatus: () => useRuntimeStore.getState().status[improveAgentId()],
    advanceFingerprint: () => improveAdvanceFingerprint(improveAgentId()),
    readyBacklog: improveReadyBacklog,
    // Reuses `sendVerified`, so the nudge is confirmed to land exactly like a Pusher challenge, and it
    // does NOT append `BLOCKER_ASK` (that is the challenge path's job).
    send: (text) => sendVerified(improveAgentId(), text),
  };
}

/** Everything the sweep can tell us, bound to the live stores. */
export function buildPusherDeps(): PusherRunnerDeps {
  return {
    now: () => Date.now(),
    policy: () => policy,
    ownsProject: ownsProjectInThisWindow,
    snapshots: () => {
      const projects = useProjectStore.getState().projects;
      // WARM THE RECEIPT CACHE FOR EVERY PROJECT THIS SWEEP READS (roborev 59899). The sidebar loads
      // receipts inside a `projectId`-scoped effect, so only the OPEN project's map is ever filled —
      // but the Pusher iterates every project. Without this the lookup below answered `undefined`
      // (⇒ `retroSettled` false) for all the others, and the third clause `retirableAgents` now
      // requires could never be satisfied there: `done-not-retired` went permanently silent for
      // every unopened project, whatever was actually on disk. It also made the claim below false —
      // open that project and the row reads the receipt as settled while the report just said it
      // was not.
      //
      // FIRE-AND-FORGET, because this callback is synchronous and the lookup must stay sync (it is
      // called per agent during the map). The first sweep after launch can therefore still read a
      // cold cache for a project; that is the fail-closed direction — a missing receipt suppresses
      // the retire claim rather than manufacturing one — and it self-corrects on the next tick.
      // `loadRetroReceipts` swallows its own errors and REPLACES one project's map, so a failed or
      // slow load cannot corrupt another project's entry.
      for (const p of projects) void loadRetroReceipts(p.id);
      // ...AND WARM THE RESEARCH CACHE, for the same reason and with the same fire-and-forget
      // contract. `buildConciergeQueue` counts CONCIERGE AGENTS off `useResearchStore`, and the only
      // thing that refreshes that store today is a component effect — `ConciergeAgentsRow`'s poll,
      // which is mounted in exactly one sidebar per window (`showConciergeRow`). So in any window
      // where that row is not rendered, the store never hydrates: `hydrated` stays false and the
      // count is honestly withheld, which means the condition can never fire there. That is the
      // fail-closed direction rather than a false alarm, and it is still the feature not working.
      //
      // One directory read per sweep, deduplicated against a concurrent poll by `refreshResearch`'s
      // own generation counter, and it swallows its own errors — so a failed read leaves the count
      // withheld rather than reporting zero agents.
      void refreshResearch();
      return buildFleetSnapshots({
        projects,
        branchStatus: useRuntimeStore.getState().branchStatus,
        quotaFor: quotaBlockForAgent,
        failureFor: lastFailureForAgent,
        // THE SEAM THE UNIT TESTS STRUCTURALLY CANNOT COVER (see pusherSnapshots' header, which
        // names this call site for exactly that reason). Reads the same module cache the sidebar
        // and the confirm dialog read, so — once warmed above — the report and the row cannot
        // disagree about whether an agent's retro is on file (knightwatch 5204094441#5).
        retroSettledFor: (projectId, agentId) => retroSettled(cachedReceipt(projectId, agentId)),
        // ALL THREE MAPS, projected by the adapter's own rule — this file supplies the values and
        // decides nothing about them. `status` is live-only with a single writer (a mounted pane);
        // `lastObserved` is what `close()` captured on its way to deleting that entry, and is
        // PERSISTED; `openAgentIds` is what separates "closed, nobody is watching" from "open in
        // another window", which is the difference between the capture being the last word and it
        // being a stale reading about a running agent (roborev 61854, then 61893).
        sessionEndedFor: (agentId) => {
          const rt = useRuntimeStore.getState();
          return sessionEndedOf(agentId, rt.status, rt.lastObserved, new Set(rt.openAgentIds));
        },
        now: Date.now(),
      });
    },
    inboxUsage,
    // READ FROM THE STORE, SYNCHRONOUSLY, and `undefined` until the probe has answered even once —
    // which is the honest reading on a build whose Rust side has no `conflict_flags` command at all.
    // `conflictFlags.ts` is the only writer, and it never writes an empty list it did not receive.
    conflicts: () => useConflictStore.getState().flags,
    // THE CONCIERGE'S OWN BACKLOG, read the same way and with the same three-valued rule. The
    // assembly lives in the adapter rather than inline here because the `hydrated` gate it applies
    // is a JUDGEMENT about what may be reported, and a judgement made at a wiring site is one no
    // unit test can reach — the mistake this file's own `quotaFor` binding is the standing example
    // of. `undefined` means no concierge is mounted in this window.
    conciergeQueue: buildConciergeQueue,
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
    // VERIFY BEFORE SPEAK, bound to the real git and the real GitHub API. Called only when this
    // sweep is about to say something, so the quiet path stays IPC-free.
    verifyClaims: makePusherVerifier(verifierDeps()),
    record: recordDecision,
    // THE NEVER-IDLE WATCHER, riding the Pusher's tick. Rebuilds its deps each call so it reads the
    // live stores fresh, exactly like `snapshots()`/`duties()` above. Scoped to the Improve Sparkle
    // agent — no ordinary build agent's nudge behaviour is touched.
    nudgeImproveAgent: () => sweepImproveNudge(buildImproveNudgeDeps()),
  };
}

/**
 * The verifier's sources, bound to the same live stores the snapshot reads.
 *
 * ── WHY THE READS HERE ARE FRESH IPC AND THE SNAPSHOT'S ARE A STORE ─────────────────────────────
 * That difference IS the feature. `snapshots()` reads `runtimeStore.branchStatus`, which is filled
 * by a poll keyed on the DISPLAYED project — so for most agents it is minutes to hours old, or
 * absent. `verifyClaims` asks Rust directly, right now, about the handful of agents and PRs a report
 * is about to name. Routing this through the same store would make verification a re-read of the
 * value that was already wrong.
 *
 * ── EVERY PROJECT IS A PR SCOPE ─────────────────────────────────────────────────────────────────
 * Not just the one being reported on: a `ConflictingPr` carries no repository (Rust keys its flag
 * map by PR number alone), so the only safe question is "is this number open in ANY repo we have".
 * See `verifyPrOpen` for why that ambiguity can only ever cost a refutation rather than invent one.
 */
function verifierDeps(): PusherVerifierDeps {
  /** The project an agent lives in, and the checkout to ask about it from. */
  const locate = (agentId: string): VerifyScope | undefined => {
    for (const p of useProjectStore.getState().projects) {
      if (p.agents.some((a) => a.id === agentId)) return { projectId: p.id, rootPath: p.rootPath || null };
    }
    return undefined;
  };

  return {
    scopes: () =>
      useProjectStore.getState().projects.map((p) => ({ projectId: p.id, rootPath: p.rootPath || null })),
    scopeForAgent: locate,
    goalFor: (agentId) => {
      for (const p of useProjectStore.getState().projects) {
        const agent = p.agents.find((a) => a.id === agentId);
        if (agent !== undefined) return agent.goal;
      }
      return undefined;
    },
    openPrs: fetchOpenPrs,
    // BASE BRANCH EMPTY: Rust resolves the project's default branch itself, which is what every
    // other caller of this command does. Naming one here would be this file inventing a base.
    branchStatus: (root, projectId, agentId) => agentBranchStatus(root, projectId, agentId, ""),
    // PR PROBE ON — `prState: "open"` is what catches an agent WAITING TO MERGE its own PR, which a
    // branch read cannot see (everything is pushed, so `ahead` is 0 and the tree is clean). That is
    // the exact shape of the two "safe to retire" claims made about mid-merge agents.
    workflowState: (root, projectId, agentId) =>
      agentWorkflowState(root, agentId, "", true, projectId),
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

  // THE BACKLOG FEED FOR THE NEVER-IDLE WATCHER. Nothing else polls the sparkle-self beads into
  // `beadsStore` — it is a synthetic project id with no BoardView — so without this the watcher's
  // `readyBacklog()` would read an empty snapshot forever and never fire (roborev 66020). A `passive`
  // poll (the same kind EpicsColumn claims) reads the board on the slow cadence without the board
  // watchers.
  //
  // GATED EXACTLY LIKE THE NUDGE ITSELF, and this is not optional (roborev 66034): `ensureSparkleRepo`
  // can `git clone` the OSS repo on a fresh machine, and a `bd` poll writes to the single-writer Dolt
  // store the improve agent is concurrently using. Neither may happen on a build where the feature is
  // dormant, nor from a window that does not own the project (`startPusher` is per-window). So the
  // poll starts ONLY when armed, not chat-only, and this window owns sparkle-self — the same three
  // gates `decideImproveNudge` refuses on — and it re-checks them once the async repo resolve returns.
  let stopSparkleBeadsPoll: (() => void) | undefined;
  const backlogFeedWanted = (): boolean =>
    neverIdleArmed() &&
    useSettingsStore.getState().sparkleImprovementConsent !== "never" &&
    ownsProjectInThisWindow(SPARKLE_PROJECT_ID);
  if (backlogFeedWanted()) {
    void ensureSparkleRepo()
      .then((ws) => {
        if (stopped || !backlogFeedWanted()) return;
        useBeadsStore.getState().startPolling(SPARKLE_PROJECT_ID, ws.repoPath, undefined, "passive");
        stopSparkleBeadsPoll = () => useBeadsStore.getState().stopPolling(SPARKLE_PROJECT_ID, "passive");
      })
      .catch((e) =>
        log.warn("pusher", "sparkle beads poll failed to start; never-idle backlog stays empty", {
          error: String(e),
        }),
      );
  }

  // THE EVIDENCE FEED FOR `pr-conflicting`, started here because the Pusher is its only consumer.
  // Best-effort in the same way the config read is: a probe that cannot start leaves the store at
  // `undefined`, the condition never fires, and nothing else about the sweep changes. That is the
  // fail-closed direction — a conflict detector that cannot look says nothing rather than all-clear.
  let stopConflicts: (() => void) | undefined;
  void startConflictFlags()
    .then((stop) => {
      if (stopped) stop();
      else stopConflicts = stop;
    })
    .catch((e) => log.warn("pusher", "conflict probe failed to start", { error: String(e) }));

  // THE `/babysit-pr` AUTO-DISPATCH SWEEP, started here for the reason the founder gave when he
  // asked for it: detection is MECHANICAL, so it belongs on a deterministic timer beside the
  // conflict detector above — NOT in the hourly LLM pass, because "an hour is far too long for a PR
  // to sit with a blocking probe". The babysit pass itself needs a model; the decision to start one
  // does not, and nothing in services/babysitDispatcher makes a model call.
  //
  // Same best-effort contract as the conflict probe: if it cannot start, no driver is dispatched and
  // nothing else about the sweep changes. Silence is the fail-closed direction here too — the harm
  // being avoided is TWO drivers replying on one human's PR, never a missed one.
  //
  // STARTED FROM CONFIG, so `[babysit].enabled = false` actually stops it. It used to be started
  // with no argument at all, which meant `resolveBabysitConfig({}).enabled` was hardwired true and
  // the decision core's `disabled` hold was unreachable — the only way to stop a loop that spends a
  // full Claude session per dispatch was to ship a new build.
  //
  // The read is best-effort and its FAILURE DIRECTION IS DELIBERATE: if the config cannot be read we
  // start with the shipped defaults rather than staying off, because the sweep is compiled into this
  // build and a failed read is not a user asking for it to stop. The switch is `enabled = false`,
  // and that is honoured the moment the read succeeds.
  let stopBabysit: (() => void) | undefined;
  let babysitUnlisten: (() => void) | undefined;
  /**
   * Set once any LIVE config event has been applied.
   *
   * The initial `getConfig()` and the `onConfigChanged` subscription are independent async paths
   * with no ordering guarantee between them, so a slow initial read could land AFTER the user had
   * already switched the sweep off in the Advanced panel and restart it with the stale `enabled:
   * true` it had been holding all along (knightwatch #1291 probe 2). A newer reading always wins.
   */
  let babysitLiveApplied = false;

  /** Apply one `[babysit]` reading: stop whatever is running, start on the new settings. */
  const applyBabysit = (b: BabysitConfigPayload | undefined): void => {
    stopBabysit?.();
    stopBabysit = undefined;
    stopBabysit = startBabysitDispatcher({
      ...(b?.enabled !== undefined ? { enabled: b.enabled } : {}),
      ...(b?.cooldown_minutes !== undefined ? { cooldownMs: b.cooldown_minutes * 60_000 } : {}),
      ...(b?.recovery_cooldown_minutes !== undefined
        ? { recoveryCooldownMs: b.recovery_cooldown_minutes * 60_000 }
        : {}),
      ...(b?.max_dispatches_per_hour !== undefined
        ? { maxDispatchesPerHour: b.max_dispatches_per_hour }
        : {}),
    });
    if (stopped) stopBabysit();
  };

  // THE `.catch` IS ON THE READ ALONE, NOT THE CHAIN (roborev 58645).
  //
  // Attached to the whole chain it also catches a throw from `startBabysitDispatcher` or the log
  // after it — and the recovery arm starts the dispatcher with NO ARGUMENT, i.e. `enabled: true`.
  // That is `[babysit].enabled = false` silently failing OPEN, in exactly the direction this
  // section's own comments say a kill switch must never fail. `.then(onOk, onErr)` cannot do that:
  // the error handler sees only a rejected READ.
  void getConfig().then(
    (eff) => {
      if (stopped) return;
      // A THROW HERE LEAVES THE SWEEP UNSTARTED, DELIBERATELY, and must not reach the error arm
      // below. We KNOW the user's setting at this point; if we cannot start with it, starting
      // WITHOUT it would substitute the shipped default for a setting we have already read — which
      // is `enabled = false` failing open, the one outcome this whole section exists to prevent.
      // Not started is recoverable (the config subscription re-applies on the next change, and a
      // relaunch retries); silently running against the user's explicit off is not.
      // A live event already applied a NEWER reading; this one is stale by arrival order.
      if (babysitLiveApplied) {
        log.debug("pusher", "babysit initial config ignored: a live change already applied");
        return;
      }
      try {
        applyBabysit(eff.config.babysit);
        log.info("pusher", "babysit dispatcher started", {
          enabled: eff.config.babysit?.enabled ?? true,
        });
      } catch (err) {
        log.warn("pusher", "babysit dispatcher failed to start; NOT falling back to defaults", {
          error: String(err),
          configuredEnabled: eff.config.babysit?.enabled ?? true,
        });
      }
    },
    (e) => {
      // A read that ERRORED is not a user asking for the sweep to stop, and the sweep is compiled
      // into this build, so shipped defaults is the honest starting point. `enabled = false` is
      // honoured the moment a read succeeds — including the subscription below.
      log.warn("pusher", "babysit config read failed; starting on shipped defaults", {
        error: String(e),
      });
      if (stopped || babysitLiveApplied) return;
      try {
        applyBabysit(undefined);
      } catch (err) {
        log.warn("pusher", "babysit dispatcher failed to start", { error: String(err) });
      }
    },
  );

  // LIVE, like the Pusher policy above it. Read-once would mean a user editing `enabled = false` in
  // the ⋯ Advanced panel watches Pushers stop immediately while the babysit sweep keeps dispatching
  // until the app restarts, with nothing anywhere saying a restart is required — and for a switch
  // whose purpose is stopping a loop that spends a full Claude session per dispatch, "it looks like
  // it did nothing" invites another hand-edit rather than a restart.
  void onConfigChanged((eff) => {
    if (stopped) return;
    // Same rule as the initial read: a failed re-apply leaves it stopped rather than reverting to
    // defaults, because the reading we just failed to apply is the user's own.
    try {
      babysitLiveApplied = true;
      applyBabysit(eff.config.babysit);
    } catch (err) {
      log.warn("pusher", "babysit re-apply failed; sweep left stopped", { error: String(err) });
    }
  })
    .then((un) => {
      if (stopped) return un();
      babysitUnlisten = un;
      // RE-READ ONCE THE LISTENER IS ACTUALLY REGISTERED (knightwatch #1298 probe 2).
      //
      // `getConfig()` starts before `onConfigChanged()` finishes registering, and the Rust side
      // emits without replay — so an `enabled = false` written in that gap is seen by NEITHER path:
      // the initial read had already returned the older value, and the event fired before anyone was
      // listening. The sweep would then run against a setting the user had already changed, until
      // some later edit happened to fire another event.
      //
      // One extra read closes it. It defers to `babysitLiveApplied` like the initial read does, so a
      // live event that arrived first still wins.
      void getConfig().then(
        (eff) => {
          if (stopped || babysitLiveApplied) return;
          try {
            applyBabysit(eff.config.babysit);
          } catch (err) {
            log.warn("pusher", "babysit post-subscribe re-apply failed", { error: String(err) });
          }
        },
        (e) => log.debug("pusher", "babysit post-subscribe re-read failed", { error: String(e) }),
      );
    })
    .catch((e) =>
      log.warn("pusher", "babysit config subscription failed; switch is restart-only", {
        error: String(e),
      }),
    );

  return () => {
    stopped = true;
    stopRunner();
    stopSparkleBeadsPoll?.();
    stopConflicts?.();
    stopBabysit?.();
    babysitUnlisten?.();
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
