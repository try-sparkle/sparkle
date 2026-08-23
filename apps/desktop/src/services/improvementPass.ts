// The HOURLY improvement pass — the machinery behind the consent banner's first bullet
// ("Once per hour, we use a small amount of your Claude Code subscription to evaluate your
// logs", bead sparkle-4xwk.2). The scheduler (useImprovementScheduler.ts) calls
// `shouldRunImprovementPass` on a slow tick and, when a pass is due, `runImprovementPass`:
// prepare the agent's app-owned worktree (same repo/worktree as the interactive pane), then
// run the user's own `claude -p` headlessly via the Rust `sparkle_improve_run` command with
// the consent-mode persona (sparkleAgent.ts). Consent semantics are enforced by the persona +
// scrub gate (Unit A): "always" auto-submits scrubbed PRs, "case_by_case" drafts and STOPS —
// the drafted PR is waiting in the session, which the pane resumes when the user opens it.
// "never" never reaches this module (the scheduler skips), and the pass never runs while the
// interactive pane session is live (one claude per worktree).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { checkClaude } from "../preflight";
import { safeUnlisten } from "./safeUnlisten";
import { useRuntimeStore } from "../stores/runtimeStore";
import type { SparkleImprovementConsent } from "../stores/settingsStore";
import type { AgentTabStatus } from "../types";
import {
  checkSubmitCapability,
  ensureSparkleRepo,
  isSubmitBlocked,
  sparklePersona,
  SPARKLE_AGENT_ID,
  SPARKLE_PROJECT_ID,
  type SubmitVerdict,
} from "./sparkleAgent";
import { registerSparkleTranscript } from "./sparkleTranscript";
// The LEAF registry, not the `conciergeTools/terminal` re-export: this module must not drag the
// snapshot machinery and the dispatcher into its graph (see agentTranscriptRegistry's header).
import { noteAgentSessionId } from "./agentTranscriptRegistry";
import { claimPass, releasePass } from "./improvementPassLatch";
// The failure→colour rule, kept OUT of this file so it is testable without the Tauri graph and
// so the quota arm reuses the very detector the build rows use (see its header).
import {
  classifyPassFailure,
  isTransientPassFailure,
  passFailureStatus,
  type PassFailureClass,
} from "../engine/passFailureStatus";
import { accountConfigDirFor } from "./accountSelection";
import { buildControlMcpConfig } from "./claudeSpawn";
import { startControlBridge, controlMcpPaths } from "./orchestrationLaunch";
import { sparkleControlProtocol } from "./buildAgent";
import {
  assertWorkspaceIntegrity,
  createAgentWorktree,
  installWorktreeGuard,
  type ParkOutcome,
  parkWorktreeOnBase,
} from "./worktree";

/** The banner's promised cadence: one evaluation pass per hour. */
export const IMPROVEMENT_INTERVAL_MS = 60 * 60 * 1000;
/** How often the scheduler re-checks whether a pass is due. */
export const IMPROVEMENT_TICK_MS = 5 * 60 * 1000;
/** How long a single pass may run before we presume it hung, kill it, and release the latch —
 *  without this, one wedged `claude -p` would hold `passRunning` forever and silently end the
 *  hourly loop (roborev #24516). This timeout OWNS the normal path; STALE_PASS_MAX in
 *  sparkle_improve.rs (the reclaim backstop for a reloaded webview) must strictly EXCEED it so
 *  the two never race at the boundary. */
export const PASS_TIMEOUT_MS = 30 * 60 * 1000;
/** The same wall in the unit a prompt (and a failure message) states it in. Derived, never
 *  written twice: a budget the mission promises and a watchdog that fires at a different number
 *  is worse than not stating one at all. */
export const PASS_BUDGET_MINUTES = PASS_TIMEOUT_MS / 60000;
/** Minimum cool-off before the ONE re-attempt a connectivity failure earns comes due. A pass
 *  that died because the network was momentarily unreachable did no work at all, so charging it
 *  the full hourly interval throws away an entire slot over a few seconds of bad DNS.
 *
 *  This is a FLOOR, not a schedule: the scheduler only re-checks the gate every
 *  IMPROVEMENT_TICK_MS, and the cool-off is armed when the failed pass FINISHES (partway into a
 *  tick), so the re-attempt actually lands on the first tick at or after it — in practice one to
 *  two ticks out. Minutes either way, which is the point; the cool-off exists so a re-attempt
 *  doesn't fire straight back into a network that is still down. */
export const IMPROVEMENT_RETRY_MS = IMPROVEMENT_TICK_MS;

/** The structured trailer the mission prompt requires as the pass's last line, so the app can
 *  set the row status without scraping prose. */
export interface ImproveResult {
  /** PRs actually submitted this pass (only ever non-zero in "always" mode). */
  submitted: number;
  /** Drafted PRs waiting for the user's approval in the session ("case_by_case" mode). */
  awaitingApproval: number;
  /** One-line, PII-free summary of what the pass did. */
  summary: string;
}

/** Parse the trailing `IMPROVE_RESULT: {...}` marker from the pass's final message. Returns
 *  null when absent/malformed — the pass still counts as done, just without structured info. */
export function parseImproveResult(text: string): ImproveResult | null {
  // Last occurrence wins (the model may quote the required format while explaining itself).
  const matches = [...text.matchAll(/IMPROVE_RESULT:\s*(\{.*?\})/g)];
  const raw = matches.at(-1)?.[1];
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<ImproveResult>;
    return {
      submitted: typeof v.submitted === "number" ? v.submitted : 0,
      awaitingApproval: typeof v.awaitingApproval === "number" ? v.awaitingApproval : 0,
      summary: typeof v.summary === "string" ? v.summary : "",
    };
  } catch {
    return null;
  }
}

/** The worktree is REUSED across passes, and `createAgentWorktree` is idempotent by design — it
 *  returns an existing checkout untouched rather than resetting it, because the interactive pane
 *  shares that same worktree and a reset would destroy real work. So a pass that dies mid-run
 *  (killed by the watchdog, a dropped connection, an exhausted quota) leaves the tree parked on
 *  ITS branch with ITS half-finished edits, and the NEXT pass opens on top of them.
 *
 *  Nothing tells that next pass the edits aren't its own. Left unsaid, it can commit a stranger's
 *  half-done change into its PR — the worst outcome this agent has, since an unreviewed edit it
 *  never reasoned about would ride out through the scrub gate under its summary. Say it plainly,
 *  and give it the same "cut from fresh origin/main" rule AGENTS.md gives everyone else, so
 *  "a fresh branch in this worktree" can't be read as "whatever branch is checked out". */
const LEFTOVER_CLAUSE =
  "Before you start, check `git status` and the current branch: this worktree is reused every " +
  "pass, so a previous pass that was killed mid-run may have left uncommitted edits and its own " +
  "branch checked out. Treat anything you did not write this pass as leftovers — never commit " +
  "it, never fold it into your change, and never describe it in your PR. Set it aside (stash it, " +
  "or leave it on its branch) and cut your fresh branch from origin/main.";

/** The pass runs against a hard wall (PASS_TIMEOUT_MS) that nothing ever told it about. So it
 *  budgets as if time were unbounded — picking scope it can't finish, and holding the whole
 *  change for one commit at the end — and the watchdog's SIGKILL arrives with no warning, no
 *  chance to commit, and no chance to clean up.
 *
 *  Everything uncommitted at that moment is lost, and the cost doesn't stop there: the killed
 *  pass leaves the worktree parked on its branch with its half-finished edits, which is exactly
 *  the mess LEFTOVER_CLAUSE above has to spend the NEXT pass's attention on. One killed pass
 *  therefore degrades two.
 *
 *  A deadline is only a deadline if you know it before you spend it. State the number, say what
 *  happens at it, and give the two behaviours that make the wall survivable: commit incrementally
 *  so progress is durable, and prefer the finished narrow change over the unfinished broad one. */
const passBudgetClause = () =>
  `You have about ${PASS_BUDGET_MINUTES} minutes: a watchdog kills this pass at that wall, ` +
  "abruptly and with no chance to save, commit, or clean up. Plan around it — pick a change " +
  "you can finish inside it, and make your progress durable as you go by committing each " +
  "self-contained piece as soon as it verifies, rather than saving one commit for the end. " +
  "Anything still uncommitted when the wall arrives is lost, and it leaves the worktree dirty " +
  "for the next pass. If you are running short, finish and land the smaller change you have " +
  "rather than the larger one you don't — a narrow improvement that ships beats a broad one " +
  "that gets killed.";

/** The one-shot mission for an hourly pass. Mode-specific ONLY in what happens to a finished
 *  change — the persona (sparklePersona) already carries the hard rules; this restates the
 *  operative ones so a fresh `-p` session can't miss them, and demands the structured trailer. */
/** What to do with a FINISHED change — propose-only, auto-submit, or draft-and-stop. Shared by the
 *  hourly mission and the backlog-drainer mission so the disposition copy (which restates the
 *  persona's operative rules for a fresh `-p` session) can never drift between the two paths — the
 *  AGENTS.md "user-facing copy is code" rule: a change to WHEN/whether a PR is submitted must land in
 *  every place that narrates it. */
export function passDisposition(
  consent: SparkleImprovementConsent,
  submit: SubmitVerdict = "unknown",
): string {
  // The persona already carries a propose-only override, but the mission prompt is the LAST thing the
  // model reads — leaving "submit the PR yourself" in it would have the mission contradict the
  // system prompt on the one instruction that cannot succeed. Say the same thing in both places.
  return isSubmitBlocked(submit)
    ? "Pull requests cannot be opened from this machine, so this is a PROPOSE-ONLY pass: do the " +
      "full job and COMMIT to a local branch, then stop. Do not run `gh pr create` or `git push`. " +
      "Report the branch name and the scrubbed PR title + body you would have submitted, and " +
      'count that as "awaitingApproval" in the trailer below.'
    : consent === "always"
      ? "You are in \"Always\" consent mode: once the change is committed and the PR text passes " +
        "the scrub gate (scripts/sparkle-scrub.sh), submit the PR yourself with " +
        "`gh pr create --base main` — no approval step."
      : "You are in \"Case by case\" consent mode: commit the change and draft the PR title + " +
        "body, run the scrub gate (scripts/sparkle-scrub.sh), then STOP — do NOT run " +
        "`gh pr create`. Leave the draft as your final message so the user can review and " +
        "approve it when they open this conversation.";
}

export function hourlyMissionPrompt(
  consent: SparkleImprovementConsent,
  submit: SubmitVerdict = "unknown",
): string {
  const disposition = passDisposition(consent, submit);
  return [
    "Hourly improvement pass (unattended — no user is watching; never wait for input except as",
    "your final state).",
    "FIRST, before mining any logs, drain the agent-feedback bead inbox — the durable queue where",
    "merged workers' retrospectives are filed, one bead per pain point. Read it through",
    "`scripts/retro-inbox-triage.sh --apply`, NOT a raw `bd list`: the inbox is past 1500 open",
    "items, so a raw list is unreadable in one pass and you would re-read the same first screen",
    "every hour. Triage ranks it worst-first and, critically, marks the beads whose fix has already",
    "MERGED or already LANDED on main — picking one of those means re-investigating finished work.",
    "Pass `--apply`: it is the ONLY thing that takes a finished bead back out of the queue, and its",
    "two writes are both fail-closed — it closes a bead only when a coverage cue on the bead itself",
    "names a MERGED PR, and it otherwise just records the landing sha as a comment. Running it as a",
    "dry run leaves the inbox one-way, which is how it grew past 1500. Then `bd show` only the item",
    "you pick. For each item, file a new bead or enrich an existing one — RECORD the recurrence,",
    "but do NOT move its priority: priority is set by a human, and the ladder that let a sighting",
    "count escalate it was retired 2026-08-09 (bead sparkle-mzgqt). PREFER fixing the",
    "highest-value item as",
    "this pass's change. If the item you picked turns out to be already fixed — a LANDED row whose",
    "commit you read and confirmed, or work you find on main — `bd close` it citing that sha before",
    "moving to the next candidate; that is the only way a finding stops being rediscovered.",
    "Belt and braces, one line, before anything else: run `bash scripts/session-beads-consolidate.sh`.",
    "That is the bead CONSOLIDATION watcher — it merges duplicate beads and forms epics from related",
    "clusters. It is cadence-gated and lock-guarded, so calling it here when its SessionStart hook",
    "already ran is a no-op; it never blocks and it never prints.",
    "Only if the inbox is empty do you fall through to the logs:",
    "review the most recent entries in the Sparkle session logs you were",
    "given access to, looking for failures, recurring errors, or clear performance problems.",
    "Pick AT MOST ONE concrete, high-value, privacy-safe improvement and implement it as a",
    "small, focused change on a fresh branch in this worktree. If nothing meets that bar, make",
    "no changes at all — a no-op pass is a good outcome.",
    LEFTOVER_CLAUSE,
    // Before the disposition, not after: the budget is what decides whether the change is small
    // enough to reach a commit at all, and the disposition is what to do once it has.
    passBudgetClause(),
    disposition,
    "Never include PII or user-specific content anywhere outward-facing, per your standing",
    "privacy rules.",
    "End your final message with exactly one line of the form:",
    'IMPROVE_RESULT: {"submitted": <n>, "awaitingApproval": <n>, "summary": "<one line, no PII>"}',
  ].join(" ");
}

/** The one bead a backlog-drainer dispatch targets — already CLAIMED (labelled `draining`) and
 *  spooled by the deterministic supervisor (scripts/backlog-drainer.sh). */
export interface DrainFocus {
  beadId: string;
  title?: string;
  /** The task string the shell engine spooled, if any (informational — the brief re-derives it). */
  task?: string;
  goal?: string;
}

/** The one-shot mission for a BACKLOG-DRAINER dispatch: the supervisor has already selected and
 *  claimed this specific worst-first agent-feedback bead, so — unlike the hourly pass, which
 *  DISCOVERS its target — this pass is TOLD its target and fixes exactly it. Same disposition,
 *  budget and scrub/trailer structure as the hourly mission (shared helpers) so the two behave
 *  identically once the target is fixed. */
export function drainMissionPrompt(
  focus: DrainFocus,
  consent: SparkleImprovementConsent,
  submit: SubmitVerdict = "unknown",
): string {
  const disposition = passDisposition(consent, submit);
  const title = focus.title ? ` (${focus.title})` : "";
  return [
    "Backlog-drainer pass (unattended — no user is watching; never wait for input except as your",
    "final state).",
    `The backlog drainer has already CLAIMED agent-feedback bead ${focus.beadId}${title} for you to`,
    "fix — it is labelled `draining`, so no other agent will take it, and your job THIS pass is to",
    "resolve exactly it (not to go hunting for other work).",
    `FIRST read it: \`bd show ${focus.beadId}\`.`,
    "If bd shows the bead is ALREADY fixed, or its fix already MERGED/LANDED on main, do NOT redo",
    `finished work: \`bd close ${focus.beadId}\` citing that sha and stop.`,
    // The supervisor's slot accounting depends on these transitions: scripts/backlog-drainer.sh
    // `count_running` counts non-closed `draining`-labelled beads as OCCUPIED slots, and
    // `reconcile_claims` separates a live-but-slow worker (in_progress, 24h horizon) from one that
    // NEVER PICKED UP (still `open` past claim_max_age ~6h => released and re-dispatched to a SECOND
    // worker). So move the bead to in_progress the moment you start, and close it when the fix lands —
    // otherwise a drained bead pins its slot forever (the fleet stops dispatching once cap beads sit
    // open+draining) or an in-flight bead is re-claimed as "never started" (duplicate work). (roborev 68223)
    `Otherwise, the MOMENT you start work, mark it in progress: \`bd update ${focus.beadId} --status in_progress\`.`,
    "Then find the root cause and implement a small, focused fix on a fresh branch in this worktree,",
    "and verify it (run the relevant tests).",
    `When your fix has landed (PR merged), \`bd close ${focus.beadId}\` citing the merge sha; in a`,
    "propose-only or case-by-case pass where you stop before merge, leave it in_progress for the",
    "merge to close.",
    `Name ${focus.beadId} — and any DUPLICATES you find of the same finding — in a \`Refs:\` trailer`,
    "on your commit(s), so the finding stops being rediscovered by later passes.",
    "Belt and braces, one line, before anything else: run `bash scripts/session-beads-consolidate.sh`",
    "(the bead consolidation watcher — cadence-gated and lock-guarded, a no-op if it already ran).",
    LEFTOVER_CLAUSE,
    passBudgetClause(),
    disposition,
    "Never include PII or user-specific content anywhere outward-facing, per your standing privacy",
    "rules.",
    "End your final message with exactly one line of the form:",
    'IMPROVE_RESULT: {"submitted": <n>, "awaitingApproval": <n>, "summary": "<one line, no PII>"}',
  ].join(" ");
}

/** Everything `shouldRunImprovementPass` weighs. Plain data so the decision is unit-testable. */
export interface PassGate {
  consent: SparkleImprovementConsent;
  /** Epoch ms of the last attempt; null = never (the scheduler seeds it instead of running). */
  lastRunAt: number | null;
  now: number;
  /** A pass is already in flight (module-level latch below). */
  passRunning: boolean;
  /** The improvement agent's live row status — undefined when its pane was never opened.
   *  "working" means an interactive session is actively producing output; a pass must not
   *  share the worktree with it. */
  paneStatus: AgentTabStatus | undefined;
  /** Epoch ms at which the pane's CURRENT unbroken run of `working` began, or null when it is not
   *  working / nothing has sampled it (see the `notePaneStatus` latch). Only used to tell a live
   *  session apart from a wedged one; a null reads as "just started", which is the conservative
   *  direction — it holds the pass and reports the plain `pane-busy`. Omitted by callers that
   *  don't model the distinction. */
  paneBusySince?: number | null;
  /** Epoch ms at which the connectivity re-attempt comes due, or null when none is armed
   *  (module-level latch below). Omitted by callers that don't model retries. */
  retryDueAt?: number | null;
  /** The app's connectivity verdict (connectionStore.isOnline: navigator.onLine AND a real
   *  reachability probe). Omitted by callers that don't model connectivity, which reads as
   *  online — the same optimistic default the store itself launches with. */
  isOnline?: boolean;
}

/** Has the hourly slot itself come due? The ONE definition of that threshold: the gate decides
 *  whether to run on it, and the scheduler decides whether the run is a fresh slot (which
 *  re-earns the connectivity retry) or the re-attempt. Two copies of this comparison would only
 *  stay correct while they stayed identical. */
export function isHourlySlotDue(lastRunAt: number, now: number): boolean {
  return now - lastRunAt >= IMPROVEMENT_INTERVAL_MS;
}

/** How long a `working` pane is read as a LIVE session rather than a wedged one.
 *
 *  Three whole slots. One slot lost to a pane is ordinary — an interactive session that outlasts a
 *  tick is exactly what the `pane-busy` hold is for, and the pass genuinely must not share the
 *  agent worktree with it. Three in a row is not: it means the hourly duty has been silently off
 *  for the better part of a morning, which is the shape the founder actually hit.
 *
 *  IT DOES NOT MAKE THE PASS RUN ANYWAY, AND THAT IS DELIBERATE. Two `claude` processes in one
 *  worktree is the failure the hold exists to prevent, and a stuck status line is not evidence the
 *  process is gone — `pane-busy` is set from a tab status, not from a liveness probe, so "it has
 *  been working a long time" and "nothing is there" are different claims and only the first is in
 *  evidence. What the bound buys is a hold that stops SOUNDING routine, so the condition can be
 *  reported and cleared instead of persisting under a sentence nobody re-reads. */
export const PANE_BUSY_HOLD_LIMIT_MS = 3 * IMPROVEMENT_INTERVAL_MS;

/** How far `hourlySlotStamp` may rewind the stamp to undo a late tick.
 *
 *  Two ticks. One tick is the floor for honest lateness (the scheduler cannot see a slot sooner
 *  than its next tick); the second absorbs a tick that was itself throttled while the window sat
 *  in the background. Anything beyond that is a sleep or a restart, not lateness, and the doc on
 *  `hourlySlotStamp` explains why those must NOT be snapped. Raising this directly lowers the
 *  guaranteed spacing between passes, which is `IMPROVEMENT_INTERVAL_MS` minus this value. */
export const MAX_SNAP_BACK_MS = 2 * IMPROVEMENT_TICK_MS;

/** What to record as the slot's start, given the clock the gate just weighed.
 *
 *  STAMPING `now` MAKES THE HOURLY SCHEDULE DRIFT, AND THE DRIFT COMPOUNDS. The scheduler only
 *  notices a due slot on a tick, so it always fires some δ late — δ is small when the app is
 *  focused and large when the window is backgrounded and the timer is throttled. Recording the
 *  tick time folds that δ permanently into the phase, and the next slot inherits it, so the pass
 *  walks later and later around the clock. Measured over one 30-hour stretch of session logs the
 *  phase moved ~40 minutes (a run at :33:07 became a run at :13:44), and an hour whose tick landed
 *  past the next boundary was simply skipped — a whole pass lost, with nothing in the logs naming
 *  why. Anchoring instead means a late tick costs that ONE slot its punctuality and nothing more.
 *
 *  So: snap back to the most recent slot boundary at or before `now`, which is the boundary this
 *  run belongs to — but only far enough to undo real tick lateness. THE SNAP-BACK IS BOUNDED, and
 *  that bound is load-bearing rather than tidy: stamping an arbitrary boundary in the past also
 *  moves the NEXT one closer, and the gap it leaves is whatever the remainder happens to be. A
 *  machine that sleeps 6h55m wakes with a remainder of 55 minutes, so an unbounded snap would
 *  stamp 55 minutes ago and let the next tick fire a SECOND full pass five minutes after the
 *  catch-up one. Sleep and restart gaps are near-uniform in that remainder, so roughly half of all
 *  wake-ups would double-spend the user's subscription against a banner that promises once an hour.
 *
 *  `MAX_SNAP_BACK_MS` is what separates the two cases: a remainder inside it is a late tick and is
 *  corrected, a remainder past it is a sleep/restart gap and keeps `now`. Consecutive attempts are
 *  therefore never closer than `IMPROVEMENT_INTERVAL_MS - MAX_SNAP_BACK_MS`. The price is that a
 *  long gap re-phases the grid once — which is the pre-existing behavior, not a new cost, and it
 *  happens per sleep rather than per hour.
 *
 *  Returns `now` unchanged when the slot is NOT due, which is the connectivity re-attempt: that
 *  run is off-grid by construction (it exists precisely because its slot's pass never happened),
 *  and there is no boundary of its own to snap to. Same disposition for a `lastRunAt` in the
 *  future, which a backwards clock adjustment can produce — a negative remainder would push the
 *  stamp forward and suppress real slots. */
export function hourlySlotStamp(lastRunAt: number, now: number): number {
  const elapsed = now - lastRunAt;
  if (elapsed < IMPROVEMENT_INTERVAL_MS) return now;
  const remainder = elapsed % IMPROVEMENT_INTERVAL_MS;
  return remainder <= MAX_SNAP_BACK_MS ? now - remainder : now;
}

/**
 * WHY a pass is not running right now, or `null` when it is due.
 *
 * ── WHY THIS EXISTS BESIDE THE BOOLEAN ───────────────────────────────────────────────────────────
 * `shouldRunImprovementPass` answered `false` and said nothing more, and the consequence was not
 * theoretical: the founder asked what the improvement agent had been doing and the honest answer was
 * "nothing, for hours" — with no way to find out which gate was holding it. Three of these five
 * conditions can persist INDEFINITELY without anything on any surface reporting them, and one of
 * them is self-sustaining: an agent wedged in the Sparkle pane reads `working`, so every tick skips,
 * so the pane never becomes not-working. The hourly duty stops forever and the banner still promises
 * it runs once an hour.
 *
 * The reasons are DATA rather than prose so a caller can count them and a report can quote one —
 * `pusherFleet`'s `duty-overdue` condition names the holder, and a reason that had to be re-derived
 * by a second reader would be a second opinion about the same gate.
 */
export type PassHoldReason =
  /** `[sparkle] improvement consent = never` — the user switched it off. Not a fault. */
  | "consent-off"
  /** A pass is already in flight. Transient by construction. */
  | "already-running"
  /** The Sparkle agent pane is `working`. THE SELF-SUSTAINING ONE — see the header. */
  | "pane-busy"
  /** The pane has read `working` for longer than {@link PANE_BUSY_HOLD_LIMIT_MS} — i.e. it has
   *  eaten several whole slots in a row. Still holds the pass (see the constant for why running
   *  anyway is not the answer), but it is a SEPARATE reason so a surface can escalate it: at
   *  minute two and at hour thirty `pane-busy` reads identically, and that sameness is what let
   *  the duty stop forever without anything sounding different. */
  | "pane-wedged"
  /** The scheduler has not seeded its clock yet (first tick after launch). */
  | "clock-unseeded"
  /** Known-offline: the slot is held rather than spent on a guaranteed connectivity failure. */
  | "offline";

/**
 * The gate, stated once. {@link shouldRunImprovementPass} delegates to this so the boolean and the
 * reason cannot drift — two copies of a five-arm gate is exactly how a surface starts explaining a
 * hold that is no longer the one in force.
 */
export function passHoldReason(gate: PassGate): PassHoldReason | null {
  if (gate.consent === "never") return "consent-off";
  if (gate.passRunning) return "already-running";
  if (gate.paneStatus === "working") {
    // Bounded, not unbounded. A pane that has read `working` across several consecutive slots is
    // no longer distinguishable from a live session by status alone — and the plain `pane-busy`
    // string is the same sentence either way, so the hold announces itself identically whether it
    // is two minutes or two days old. Past the limit it becomes its own reason, which is the half
    // of this that a caller can act on.
    const since = gate.paneBusySince;
    const wedged = since != null && gate.now - since >= PANE_BUSY_HOLD_LIMIT_MS;
    return wedged ? "pane-wedged" : "pane-busy";
  }
  if (gate.lastRunAt === null) return "clock-unseeded"; // scheduler seeds on its first tick
  // Known-offline: hold the slot rather than spend it. A pass needs the network from its very
  // first step, so launching one now buys a guaranteed connectivity failure — and because the
  // scheduler stamps the clock at ATTEMPT time, that doomed launch costs the whole hour AND the
  // one re-attempt the slot was allowed. The characteristic shape is a machine waking from
  // sleep: the tick fires before the interface is back, the pass dies unreachable, its retry
  // fires into the same dead network minutes later, and the next real pass is an hour away.
  // Skipping instead leaves `lastRunAt` untouched, so the slot stays due and the pass starts on
  // the first tick after connectivity returns. This sits BELOW the seed guard (a launch with no
  // clock still seeds) and ABOVE the retry short-circuit, since an armed re-attempt is exactly
  // what must not be spent while offline.
  if (gate.isOnline === false) return "offline";
  return null;
}

/** Pure gate: is an hourly pass due right now? (bead sparkle-4xwk.2) */
export function shouldRunImprovementPass(gate: PassGate): boolean {
  if (passHoldReason(gate) !== null) return false;
  // An armed retry short-circuits the hourly wait, but NOT the guards above it: the pass still
  // must not double-run or share the worktree with a live pane session.
  if (gate.retryDueAt != null && gate.now >= gate.retryDueAt) return true;
  return isHourlySlotDue(gate.lastRunAt!, gate.now);
}

/** True when a failed pass's message names a connectivity problem rather than a real failure.
 *
 *  RE-EXPORTED, not defined here. The predicate and its pattern list moved to the LEAF
 *  `engine/passFailureStatus` when the failure→colour classifier was added: that classifier asks
 *  this question, this module asks the classifier, and defining both here would make the two
 *  modules import each other — dragging this module's Tauri/store graph into every consumer of a
 *  pure function. Importers of `isTransientPassFailure` from here keep working unchanged. */
export { isTransientPassFailure };

/** True while a headless pass is in flight (read by the scheduler's gate).
 *
 *  RE-EXPORTED, not defined here. The latch itself lives in the leaf `improvementPassLatch` so that
 *  a module wanting only this boolean — `services/sparkleBusy`, and through it every UI component
 *  whose graph reaches `stores/settingsStore` — does not acquire THIS module's dependencies with it.
 *  That header explains what it cost when it did. Importers of `isPassRunning` from here keep
 *  working; new readers of the bare boolean should take the leaf. */
export { isPassRunning } from "./improvementPassLatch";

/** How a pass ended. `cancelled` marks the deliberate-handoff path — an `ok: false` that is NOT
 *  a failure, so it must not warn or park the agent on a failure status at all. */
type PassOutcome = {
  ok: boolean;
  text: string;
  cancelled?: boolean;
  timedOut?: boolean;
  /** Resolves when the watchdog's kill invoke has RETURNED. Carried on the outcome so the
   *  leftovers probe can be ordered after the process group is actually gone — see
   *  `reportTimeoutLeftovers`. Never rejects. */
  killed?: Promise<boolean>;
};

/** How long the leftovers probe waits for the kill to be reaped, and then for park itself. Both
 *  are bounds on a path that runs BEFORE the in-flight latch is released, so neither may be
 *  unbounded; a diagnostic must never be able to end the hourly loop. */
export const PROBE_KILL_WAIT_MS = 10_000;
export const PROBE_TIMEOUT_MS = 20_000;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Say what a pass killed by the watchdog LEFT BEHIND in the worktree.
 *
 *  The timeout message names the wall and stops there, which makes the single most common way a
 *  pass fails also the least actionable one. Two very different things hide behind one line: a pass
 *  that was still editing when SIGKILL arrived (30 minutes of uncommitted work, gone) and a pass
 *  that had committed and pushed and merely overran its wrap-up (nothing lost at all). The
 *  responses are opposite — shrink the scope the mission prompt asks for, versus nothing.
 *
 *  It also joins up two log signatures that are the SAME event seen an hour apart from opposite
 *  ends. A kill that leaves the tree dirty is exactly why the next hour's pass declines to park and
 *  reports `starting from a stale base`, and until now nothing connected them: the drift looked
 *  spontaneous at the point it was observed, and the kill looked consequence-free at the point it
 *  was caused.
 *
 *  The probe is `parkWorktreeOnBase` rather than a status of its own, because park already answers
 *  precisely the question worth asking — is there anything here worth NOT throwing away — and it
 *  declines, naming the reason, whenever there is. Running it now is not extra work either: it is
 *  the same call the next pass makes at startup, an hour earlier. Advisory throughout, exactly like
 *  the startup park: a pass has already failed by the time this runs, and a probe must not be able
 *  to turn that into a thrown error on the way out. */
async function reportTimeoutLeftovers(
  repoPath: string,
  defaultBranch: string,
  killed: Promise<boolean> | undefined,
): Promise<void> {
  try {
    // A CONFIRMED REAP IS A PRECONDITION, NOT A DELAY. `parkWorktreeOnBase` is not read-only — it
    // stashes tooling churn and checks the worktree out onto the base — so running it while the
    // process group may still be alive would let it check out over a `claude` that is still
    // writing, and would sample the tree before the writes stopped. It would destroy the very work
    // it exists to report on, and then report that there was none.
    //
    // So the two ways the kill fails to confirm — the wait expiring, and the invoke REJECTING —
    // must both abandon the probe rather than fall through it. They are exactly the cases where
    // the group is most likely still running, which makes falling through worst precisely when it
    // is least safe. A diagnostic is not worth a worktree; say so and stop.
    const reaped = await Promise.race([
      killed ?? Promise.resolve(true),
      delay(PROBE_KILL_WAIT_MS).then(() => false),
    ]);
    if (!reaped) {
      console.warn(
        "improvement pass: could not confirm the kill, so the worktree was left untouched " +
          "and unexamined",
      );
      return;
    }
    const park = await Promise.race([
      // DECLINE, deliberately — NOT the "stash" policy the startup park uses. This probe exists to
      // REPORT what the killed pass left behind, and a stash would relocate the very leftovers it is
      // reporting on: the answer would become "nothing at risk" because the question had already
      // moved it. Declining is what makes the reading true. The startup park an hour later is the
      // right place to clear it, because by then the reporting has happened and the decision to
      // proceed is a separate one.
      parkWorktreeOnBase(repoPath, SPARKLE_PROJECT_ID, SPARKLE_AGENT_ID, defaultBranch, "decline"),
      // BOUNDED, because this is awaited before the latch is released. Park takes the per-repo git
      // lock and fetches, so an unbounded wait here could hold `passRunning` forever — which is the
      // exact wedge the watchdog exists to prevent, reintroduced on the most common failure path.
      delay(PROBE_TIMEOUT_MS).then(() => null),
    ]);
    if (park === null) {
      console.warn("improvement pass: gave up waiting to see what the killed pass left behind");
    } else if (park.reason === "dirty" || park.reason === "unpushed") {
      console.warn(
        "improvement pass: the killed pass left work behind —",
        park.reason,
        "— the next pass will start from a stale base",
      );
    } else if (park.parked || park.reason === "already-fresh") {
      // Says nothing about whether the pass ACCOMPLISHED anything — a pass that committed, pushed
      // and opened its PR parks clean too. It says only that the kill destroyed nothing, which is
      // the half of the question the worktree can actually answer.
      console.warn("improvement pass: the killed pass left nothing at risk in the worktree");
    } else {
      // `no-worktree`, `no-base`, `checkout-failed`: the probe could not CONCLUDE. Reporting those
      // as leftovers would be the same ambiguity this change exists to remove, moved one line down
      // — and would attach a stale-base prediction that is simply false for `no-worktree`.
      console.warn(
        "improvement pass: could not tell what the killed pass left behind —",
        park.reason,
      );
    }
  } catch (e) {
    console.warn("improvement pass: could not tell what the killed pass left behind:", e);
  }
}

/**
 * What the user is told when a park refuses, and what they can do about it.
 *
 * NAMES THE REMEDY, per reason. These declines are self-perpetuating — nothing in the pass, the app,
 * or the next hour's park can clear them, and the `"stash"` policy explicitly cannot help (a stash
 * cannot save a commit) — so the hourly pass stops for good until a human acts. A recoloured dot
 * alone does not tell them that, or that the thing to act on is a leftover branch in an app-owned
 * worktree they have never opened. (The dot is AMBER for the first declines and only goes RED once
 * the same reason has recurred PARK_DECLINE_ESCALATE_AFTER times, which makes this text MORE
 * load-bearing than it was, not less: for the first hours it is the only detail anywhere.) AGENTS.md's rule applies: a refusal a user is expected to act on needs a remedy
 * they can actually see.
 *
 * PATH-FREE and BRANCH-FREE by construction, exactly like the Rust side's reason token: this text is
 * relayed to the phone and returned by `read_agent_terminal`, so it says WHAT to look for and leaves
 * the caller to run the command in the worktree, rather than embedding anything that could carry a
 * user's content.
 */
export function refusalDetail(reason: string): string {
  switch (reason) {
    case "in-use":
      return (
        "Improve Sparkle skipped this hourly pass: an interactive session is actively working in its " +
        "workspace, so it left that session's branch and changes exactly as they are rather than reset " +
        "them out from under it. It will run again on its own once the session ends."
      );
    case "unpushed":
      return (
        "Improve Sparkle can't start a pass: its workspace still holds commits that exist nowhere " +
        "else, so it won't reset the branch out from under them. Nothing here can clear that on its " +
        "own — push that branch, or delete it once you're sure you don't want the work, and the next " +
        "hourly pass will run."
      );
    case "dirty":
      return (
        "Improve Sparkle can't start a pass: it tried to set aside leftover changes in its workspace " +
        "and the stash failed, so it left the workspace exactly as it found it rather than write over " +
        "it. Clearing the workspace by hand will let the next hourly pass run."
      );
    case "no-base":
      return (
        "Improve Sparkle can't start a pass: it can't resolve the branch it builds from, so it has no " +
        "known starting point. This usually clears on its own once the machine is back online."
      );
    case "checkout-failed":
      return (
        "Improve Sparkle can't start a pass: switching its workspace to a fresh starting point " +
        "failed. Nothing was lost, but the next hourly pass won't run until that workspace is usable."
      );
    default:
      return (
        `Improve Sparkle can't start a pass: its workspace isn't in a state it can build from (${reason}), ` +
        "so it stopped rather than work from a starting point it can't describe."
      );
  }
}

/** Settles the in-flight pass when it is killed from OUTSIDE its own promise. Null when no pass
 *  is running. The Rust cancel is silent by design (it emits no error event, so a cancel can't
 *  land on a later pass's listeners), which means nothing else would ever resolve the promise:
 *  the latch, the listeners and the watchdog all stayed live until the timer fired ~30 minutes
 *  later and reported a timeout that never happened. */
let settleOnCancel: (() => void) | null = null;

/** When the connectivity re-attempt comes due, or null when none is armed. Module-level for the
 *  same reason as `passRunning`: it describes THIS webview's in-memory attempt state, and a
 *  reload should forget it rather than resurrect a retry for a pass nobody remembers. */
let retryDueAt: number | null = null;
/** One retry per hourly slot. Without this an offline machine would re-spawn `claude` every
 *  tick for the whole hour instead of once. */
let retryUsed = false;

/** Consecutive hourly passes that must refuse to run for the SAME reason before the row escalates
 *  from the SILENT AMBER `lapsed` pill to the NOTIFYING RED `errored` one. One refusal is routine — a
 *  killed pass left work behind and the next hour clears it — but the SAME refusal several hours
 *  running is a loop nothing here can break (a stash cannot save a commit, and next hour's park makes
 *  the identical decision), and staying silent is exactly how the hourly loop went dark for days
 *  without anyone being pinged. `errored` is in the notify set (settingsStore
 *  DEFAULT_NOTIFY_STATUSES) where the non-escalated status deliberately is not, so crossing this
 *  threshold fires the banner/badge the quiet tier holds back. Three: the second refusal could still
 *  be the tail of a transient hiccup; the third is a loop.
 *
 *  ⚠️ THE NON-ESCALATED ARM WAS RED `blocked` UNTIL 2026-08-22 and is now AMBER `lapsed`; the
 *  ESCALATED arm is unchanged. The threshold itself is deliberately untouched by that change — what
 *  moved is only the colour of the rows BELOW it, which the next hour's park re-attempts by itself. */
export const PARK_DECLINE_ESCALATE_AFTER = 3;
/** The reason the last hourly park DECLINED, and how many hourly passes in a row it has declined for
 *  THAT reason. Module-level for the same reason as the retry latch above: it is this webview's running
 *  tally, and a reload should start it over. Cleared by any park that succeeds (or is already-fresh). */
let parkDeclineReason: string | null = null;
let parkDeclineStreak = 0;

/** Epoch ms of the armed connectivity re-attempt, or null (read by the scheduler's gate). */
export function passRetryDueAt(): number | null {
  return retryDueAt;
}

/** When the pane's CURRENT unbroken run of `working` began, or null when it is not working.
 *  Module-level for the same reason as the two latches above: it describes this webview's own
 *  observation, and a reload should start the clock over rather than inherit a stale one. */
let paneBusySince: number | null = null;

/** Sample the pane's status and keep the latch above honest; returns the (possibly new) start.
 *
 *  The status stores carry no timestamp of their own, so SOMETHING has to observe the transition —
 *  this is that seam, and the scheduler's tick is the sampler (it already runs on a fixed interval
 *  and already reads the status for the gate). A status that is not `working` clears the latch, so
 *  a pane that finishes and starts again is a NEW run and not a continuation of the old one; that
 *  matters because the wedge this bound is looking for is one unbroken run, not busy-in-aggregate. */
export function notePaneStatus(status: AgentTabStatus | undefined, now: number): number | null {
  if (status !== "working") paneBusySince = null;
  else if (paneBusySince === null) paneBusySince = now;
  return paneBusySince;
}

/** Read the latch without disturbing it — for surfaces that render the hold but do not sample. */
export function paneBusySinceAt(): number | null {
  return paneBusySince;
}

/** Test seam: forget the pane-busy run, as a fresh webview would. */
export function resetPaneBusyForTests(): void {
  paneBusySince = null;
}

/** Test seam: forget any armed retry, as a fresh webview would. */
export function resetPassRetryForTests(): void {
  retryDueAt = null;
  retryUsed = false;
}

/** Fold one park DECLINE into the running same-reason tally and decide how loudly to surface it. It
 *  advances the module tally — a NEW reason restarts it at 1, the SAME reason extends it — and once it
 *  reaches PARK_DECLINE_ESCALATE_AFTER the status rises from the silent AMBER `lapsed` pill to the
 *  notifying RED `errored` one, so a stuck loop stops hiding in a row nobody watches. Returns the
 *  status to set and the current streak length (for the escalation log and attention screen).
 *
 *  WHY THE FIRST REFUSALS ARE AMBER. `lapsed` is "the machinery stopped and ANOTHER ACTOR clears it"
 *  (packages/ui/tokens.ts). A single decline is exactly that: next hour's park makes the attempt
 *  again, and it commonly succeeds (a killed pass's leftovers get cleaned up, a fetch that failed
 *  works). Nothing is owed by the founder, so it must not wear the alarm colour — the founder's own
 *  complaint about rows that "don't require my assistance" is what created the amber tier.
 *
 *  WHY THE ESCALATED ARM STAYS RED. At PARK_DECLINE_ESCALATE_AFTER consecutive same-reason declines
 *  there IS no other actor: `unpushed` cannot be stashed away, and every later park will decide
 *  identically. A human is the only one who can clear it, which is precisely what red means — and
 *  `errored` is the arm that notifies. */
function noteParkDeclineStatus(reason: string): { status: AgentTabStatus; streak: number } {
  if (reason === parkDeclineReason) {
    parkDeclineStreak += 1;
  } else {
    parkDeclineReason = reason;
    parkDeclineStreak = 1;
  }
  const escalate = parkDeclineStreak >= PARK_DECLINE_ESCALATE_AFTER;
  return { status: escalate ? "errored" : "lapsed", streak: parkDeclineStreak };
}

/** Clear the consecutive-decline tally — any park that SUCCEEDS (parked or already-fresh) breaks the
 *  streak, so the next first refusal starts a fresh count rather than escalating on the wrong hour. */
function clearParkDeclineStreak(): void {
  parkDeclineReason = null;
  parkDeclineStreak = 0;
}

/** The last RUN failure's reason and how many hourly passes in a row have failed for THAT reason.
 *
 *  ⚠️ WHY THIS EXISTS AT ALL (roborev 67832, HIGH). Moving auto-retried failures off red onto amber
 *  was right for a ONE-OFF failure and wrong for a REPEATING one, and it made the repeating case
 *  QUIETER THAN IT WAS BEFORE — not merely calmer. `blocked` bands into `needs_you`
 *  (`engine/buildSections.bandOfStatus`), while `lapsed` bands into **`done`**: a band the sidebar
 *  can collapse and filter away and the concierge digest does not count. Both are outside
 *  `DEFAULT_NOTIFY_STATUSES`, so neither fires a banner. An hourly loop dying the same way every hour
 *  therefore sat in the FINISHED band with nothing pinged — verbatim the "the hourly loop stopped for
 *  days behind a row nobody was pinged about" incident that {@link PARK_DECLINE_ESCALATE_AFTER}
 *  exists to end, reintroduced through a different door.
 *
 *  The amber tier's own rule settles it: amber means ANOTHER ACTOR clears this. "The next hourly slot
 *  re-attempts by itself" is a claim about the mechanism, not about the outcome — and once the same
 *  re-attempt has failed identically N times, no other actor is coming. That is red by definition.
 *
 *  ⚠️ IT COUNTS ATTEMPTS, NOT HOURS (roborev 67903). `armRetryIfTransient` earns one early
 *  re-attempt inside the same slot, so a transient shape can contribute two ticks in one hour and the
 *  threshold can be reached in fewer than three. That is the honest reading and it is the one the
 *  name should carry — the guarantee is N consecutive failures FOR THE SAME REASON, which is the
 *  property that means "no other actor is coming", not a claim about the clock.
 *
 *  Normalized so a message differing only by a timestamp or a path still counts as the same reason;
 *  module state for the same reason as the park tally, and cleared by any pass that COMPLETES. */
let runFailureReason: string | null = null;
let runFailureStreak = 0;

/** Collapse a failure message to the part that identifies the REASON, so a repeat is recognisable.
 *  Digits and anything path-shaped vary run to run and would otherwise restart the tally forever. */
function runFailureKey(message: string): string {
  return message
    .toLowerCase()
    .replace(/\/[^\s'"]+/g, "/P")
    .replace(/\d+/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/** The status a RUN failure (or a setup throw) parks on, escalating a repeat to the notifying tier.
 *
 *  A wall (`quota`/`auth`) is red immediately and does NOT participate: it is already the loudest
 *  thing this row can say, and streaking it would only delay the escalation it has already earned.
 *  Everything else is AMBER once, AMBER twice, and RED on the {@link PARK_DECLINE_ESCALATE_AFTER}th
 *  consecutive failure for the same reason — the same threshold as the park path — though NOT the same
 *  cadence, per the attempts-not-hours note above. */
export function noteRunFailureStatus(
  message: string,
  cls: PassFailureClass,
): { status: AgentTabStatus; streak: number } {
  if (cls === "quota" || cls === "auth") {
    // ⚠️ DOES NOT PARTICIPATE — AND THAT MEANS IT LEAVES THE TALLY ALONE (roborev 67902). This used
    // to null the streak, which is a different thing and a worse one: a loop failing identically most
    // hours but hitting an occasional wall had its count restarted every time, so it could never
    // reach the threshold and the escalation this whole helper exists for never fired. A wall is
    // already the loudest thing this row can say; it neither needs the streak nor should erase it.
    return { status: passFailureStatus(cls), streak: runFailureStreak };
  }
  const key = runFailureKey(message);
  if (key === runFailureReason) runFailureStreak += 1;
  else {
    runFailureReason = key;
    runFailureStreak = 1;
  }
  const escalate = runFailureStreak >= PARK_DECLINE_ESCALATE_AFTER;
  return { status: escalate ? "errored" : passFailureStatus(cls), streak: runFailureStreak };
}

/** Park the row on a run failure AND, when it has escalated, say WHY somewhere a human can read.
 *
 *  ⚠️ ONE HELPER, CALLED FROM BOTH SITES (roborev 68035). The first cut wrote the screen in the
 *  `outcome` branch only, and the outer `catch` shares this very tally — so a repeatable SETUP throw
 *  (the worktree cut, `parkWorktreeOnBase`, `assertWorkspaceIntegrity`, all networked and all capable
 *  of failing with an identical message every hour) escalated to RED completely silently. A tally
 *  shared by two branches needs its surface shared too, or one of them is a trap.
 *
 *  STATUS FIRST, THEN THE SCREEN, and that order is load-bearing: `setStatus` DROPS `attentionScreen`
 *  whenever the new status is outside the red tier, so writing the screen first would erase it on
 *  every amber (non-escalated) pass. The park path documents the same rule for the same reason.
 *
 *  The wording says PASSES, not "hourly passes": `armRetryIfTransient` can contribute a second tick
 *  inside one slot, so the count is attempts. The park path's "hourly" is correct for ITS tally,
 *  which really is one tick per hourly park; copying it here would assert the thing this module just
 *  established is false. */
function surfaceRunFailure(
  failure: { status: AgentTabStatus; streak: number },
  detail: string,
): void {
  useRuntimeStore.getState().setStatus(SPARKLE_AGENT_ID, failure.status);
  if (failure.status !== "errored") return;
  console.error(
    "improvement pass: STUCK —",
    failure.streak,
    "consecutive failures for the same reason —",
    detail,
  );
  useRuntimeStore
    .getState()
    .setAttentionScreen(
      SPARKLE_AGENT_ID,
      `Improve Sparkle has failed ${failure.streak} passes in a row for the same reason, so it is not going to clear itself:\n\n${detail}`,
    );
}

/** Any pass that COMPLETES breaks the run-failure streak — the loop is demonstrably not stuck. */
function clearRunFailureStreak(): void {
  runFailureReason = null;
  runFailureStreak = 0;
}

/** Read the consecutive same-reason run-failure tally without disturbing it. */
export function runFailureStreakAt(): number {
  return runFailureStreak;
}

/** Test seam: forget the run-failure tally, as a fresh webview would. */
export function resetRunFailureStreakForTests(): void {
  clearRunFailureStreak();
}

/** Read the consecutive same-reason decline tally without disturbing it. */
export function parkDeclineStreakAt(): number {
  return parkDeclineStreak;
}

/** Test seam: forget the consecutive-decline tally, as a fresh webview would. */
export function resetParkDeclineStreakForTests(): void {
  clearParkDeclineStreak();
}

/** Arm the one connectivity re-attempt this slot is allowed, when the failure looks like a
 *  network problem. Anything else — a real failure, or a second connectivity failure in the
 *  same slot — waits out the hour as before. */
function armRetryIfTransient(message: string): void {
  if (retryUsed || !isTransientPassFailure(message)) return;
  retryUsed = true;
  retryDueAt = Date.now() + IMPROVEMENT_RETRY_MS;
}

/** Kill an in-flight pass (harmless no-op when none). The interactive pane calls this in
 *  prepare() so two `claude` processes never share the agent worktree.
 *
 *  Settling here is the point: a pane-initiated cancel is a deliberate handoff, not a failure,
 *  and until it settled the pass the `passRunning` latch stayed set for the remainder of the
 *  30-minute window — so an hourly tick landing in it was skipped, and the pass was finally
 *  reported as "timed out after 30 minutes and was killed" minutes after the user had taken
 *  over. Capture the hook BEFORE the await: settling is idempotent (`finish` is first-caller-
 *  wins), so a hook belonging to an already-settled pass is a no-op, whereas re-reading it
 *  afterwards could settle a DIFFERENT pass that started while the invoke was in flight. */
export async function cancelImprovementPass(): Promise<void> {
  const settle = settleOnCancel;
  try {
    await invoke("sparkle_improve_cancel");
  } finally {
    settle?.();
  }
}

/**
 * Run one headless improvement pass now. Resolves when the pass finishes (or fails); callers
 * that only want to fire-and-forget can ignore the promise. Quietly does nothing if claude
 * isn't installed. Status wiring: the pinned row shows "working" for the duration, then
 * "approval" (red "Approve?") when a case-by-case draft awaits the user, else back to "idle";
 * a failed pass parks on whatever `engine/passFailureStatus` classifies it as — AMBER `lapsed`
 * ("Unfinished, not yours") for the transient shapes and the timeout, which the armed re-attempt or
 * the next hourly slot picks up unaided, and RED `blocked` only for an account/quota wall, which
 * nothing but the founder or the clock can clear. Neither fires a banner; both recolor and re-sort
 * the row, and both persist until the retry.
 *
 * `freshSlot` says this run is the hourly one coming due, not the connectivity re-attempt —
 * the scheduler knows which, and only a fresh slot re-earns the one retry.
 */
/**
 * The `--mcp-config` JSON for one hourly pass, or `undefined` when the control bridge is not
 * available (bead sparkle-hdlhox).
 *
 * WHY THE HEADLESS PASS GETS THIS AT ALL. The pass already DRAINS its inbox — `build_improve_exec`
 * exports `SPARKLE_INBOX_AGENT` — so it can be told things and, without the control MCP, could not
 * answer. That asymmetry is the original problem relocated rather than solved: the concierge's whole
 * job on this channel is to reply "that contradicts what I can observe", and a correction the
 * corrected party cannot respond to ends the exchange instead of starting one. This pass is also the
 * body that HAS the cross-agent findings — it does the log-mining and the bead triage — while the
 * interactive pane is mostly the user chatting.
 *
 * NEVER THROWS, and that is the load-bearing property. An hourly pass that dies because a socket
 * was slow would be a far worse regression than a pass with no cross-agent tools: `undefined` here
 * emits no flag at all (not an empty one, which `claude` would reject), so the pass runs exactly as
 * it did before this change.
 */
export async function buildPassControlMcp(): Promise<string | undefined> {
  try {
    const [bridge, paths] = await Promise.all([startControlBridge(), controlMcpPaths()]);
    return buildControlMcpConfig({
      nodePath: paths.nodePath,
      serverPath: paths.serverPath,
      socketPath: bridge.socketPath,
      token: bridge.token,
      agentId: SPARKLE_AGENT_ID,
    });
  } catch (e) {
    console.warn("improvement pass: sparkle-control MCP unavailable; running without it", e);
    return undefined;
  }
}

export async function runImprovementPass(
  consent: SparkleImprovementConsent,
  freshSlot = false,
  focusBead?: DrainFocus,
): Promise<boolean> {
  // Returns whether a pass actually RAN (reached the worker and it reported) — false on every early
  // bail (consent off, latch busy, no claude, park refused, cancelled, failed). The drainer bridge
  // relies on this to ack (delete) a spooled request ONLY when a worker really ran, so a bead is
  // never silently lost to a bail. The hourly scheduler ignores the value (fire-and-forget).
  if (consent === "never") return false;
  // Claim-or-bail in ONE call: the check and the set used to be two statements, which is the shape
  // a second pass can slip between.
  if (!claimPass()) return false;
  // Consume the armed retry before anything can fail: whatever happens next re-decides the
  // wait, and leaving it armed would make the gate fire again on the very next tick.
  //
  // `freshSlot` is what keeps a STALE arm from eating a later slot's retry: an armed retry can
  // go unconsumed for the rest of the hour (the pane guard suppresses it, say), and without the
  // flag the next hourly run would look like "the retry" and inherit its spent budget.
  //
  // A DRAIN pass (focusBead set) is NOT an hourly slot, so it must NOT touch this latch — doing so
  // would disarm/consume the hourly scheduler's one connectivity re-attempt (roborev 68224).
  if (!focusBead) {
    if (freshSlot || retryDueAt === null) retryUsed = false;
    retryDueAt = null;
  }
  let ran = false;
  const setStatus = useRuntimeStore.getState().setStatus;
  try {
    const claude = await checkClaude();
    if (!claude.installed || !claude.path) return false; // not set up yet — skip quietly
    // GREEN FROM THE FIRST STEP OF ACTUAL WORK, not from the last one.
    //
    // The headless pass has no PTY and no StatusEngine (see the module header + the `sparkle_improve:*`
    // listeners below), so unlike a build agent — whose row goes green the instant its terminal spawns
    // (statusEngine.ts, `spawn -> working`) — nothing here reports "working" from the stream. The row
    // is driven only by these explicit `setStatus` calls. This one used to sit just before the
    // `sparkle_improve_run` invoke, AFTER the whole networked preamble: the OSS clone
    // (`ensureSparkleRepo`, minutes on a cold start), the worktree cut, and the fresh-base
    // `parkWorktreeOnBase` (which fetches). For that entire window the pass is actively working while
    // the row shows the PREVIOUS pass's resting `idle`/`stopped` — a GRAY dot on a plainly working
    // agent, which is exactly the "falls to gray while its work is still live" symptom the trustworthy
    // -status-dot work chased on the interactive side. Claim `working` HERE instead, as soon as Claude
    // is confirmed present, so setup is covered too.
    //
    // NOT EARLIER — this is below the `!claude.installed` return on purpose. A machine with no Claude
    // never runs, and marking it green would be a false-green with no turn behind it. Everything below
    // this line, by contrast, either runs the pass or resolves to a TERMINAL status that overrides
    // this: a declined/thrown park → `lapsed`/`errored` (the park gate below), any setup throw → the
    // outer `catch` → `passFailureStatus` (`lapsed`, or `blocked` for a quota wall), a completed run
    // → `idle`/`approval`, a handoff → `idle`. So no path
    // leaves a stale `working`; the only change is that the truthful green now starts at the top of the
    // work rather than at the end of the setup.
    setStatus(SPARKLE_AGENT_ID, "working");
    const ws = await ensureSparkleRepo();
    const wt = await createAgentWorktree(
      ws.repoPath,
      SPARKLE_PROJECT_ID,
      SPARKLE_AGENT_ID,
      ws.defaultBranch,
    );
    // Park the worktree back on a FRESH base before the pass starts. createAgentWorktree is
    // idempotent by leaving an existing worktree alone, so without this every hourly pass inherits
    // the PREVIOUS pass's topic branch and drifts further behind main — the exact "never a stale
    // base" trap AGENTS.md warns about, which also eventually trips the build's staleness gate.
    //
    // "stash": this worktree is APP-OWNED end to end, so leftover dirt from a killed pass is ours to
    // set aside. It is stashed, never committed and never discarded — recoverable by hand from
    // `git stash list`. The default policy stays decline-don't-touch for everyone else.
    //
    // PARK OR REFUSE. This used to warn and run the pass anyway, which is how the defect stayed
    // invisible for so long: an hourly `starting from a stale base — dirty` in a log nobody reads,
    // while every pass built on whatever the last one left behind. A pass from an unknown base is
    // worse than no pass — it burns the hour, and its output is a diff against a tree we cannot
    // describe. So a park that neither moved the worktree nor found it already fresh stops the run.
    //
    // THE REFUSAL IS SURFACED ON THE ROW, not just logged — but AMBER `lapsed`, not red. It was
    // `blocked` (RED) until 2026-08-22, on the argument that red "recolors and re-sorts … but is
    // deliberately outside the badge/notification set, so it does not fire a banner". That argument
    // was about LOUDNESS and it was right about loudness; it was wrong about MEANING. Red means "you
    // are the only one who can clear this" (packages/ui/tokens.ts), and a first refusal is the
    // opposite: next hour's park re-attempts it unaided, and it commonly clears. `lapsed` — "the
    // machinery stopped and another actor clears it" — recolours the dot with no badge and no
    // banner, which is the same loudness with the true meaning. The row still goes RED when there
    // genuinely is no other actor: PARK_DECLINE_ESCALATE_AFTER consecutive same-reason declines
    // escalate to `errored` (noteParkDeclineStatus, below).
    //
    // A THROW is deliberately NOT caught here. It used to be swallowed, which silently promoted the
    // least-informed case to the most-permissive outcome — but catching it HERE was wrong in the
    // other direction (roborev 55239): the local handler returned from inside the `try`, so it
    // bypassed `armRetryIfTransient`, the only place a lost-connectivity failure earns this slot's
    // one early re-attempt. Park is the MOST networked setup step (it fetches), so it was the one
    // step whose throw could not arm a retry, and the scheduler has already stamped `lastRunAt` —
    // making a connectivity blip cost a full hour of no pass, where before it cost nothing.
    // The outer `catch` already warns, arms the retry and sets the classified failure status; letting
    // the throw reach it gets all three, so there is nothing left for a local handler to do.
    const park: ParkOutcome = await parkWorktreeOnBase(
      ws.repoPath,
      SPARKLE_PROJECT_ID,
      SPARKLE_AGENT_ID,
      ws.defaultBranch,
      "stash",
    );
    if (!park.parked && park.reason !== "already-fresh") {
      // `unpushed` is the common one and is a CONTAINMENT hold, not a failure: a previous pass
      // committed and could not push, so its work exists nowhere else and park refuses to step over
      // it. A stash cannot save a commit, so nothing here can clear it — a human has to.
      //
      // WHICH MEANS THE REFUSAL IS PERMANENT, and a permanent refusal whose only signal is a
      // recoloured dot is the same shape the Rust side just spent a commit removing (a guard becoming
      // the thing it exists to prevent), relocated from "runs forever from a stale base" to "never
      // runs again" (roborev 55239). So the reason is WRITTEN WHERE SOMEONE WILL READ IT, not just
      // warned: `attentionScreen` is the text captured when an agent needs looking at (it is written
      // on the amber first refusals too, not only on the red escalation), which is what the pane shows,
      // what the phone relays, and — since the concierge can now address this agent at all — what
      // `read_agent_terminal` returns for it at tier (b). The remedy is named, not implied: a user
      // told only that the pass did not run has no way to learn that a leftover branch in an
      // app-owned worktree they have never seen is what stopped it.
      const detail = refusalDetail(park.reason);
      // ESCALATE A STUCK LOOP. A single refusal stays on the silent AMBER `lapsed` pill (it may clear
      // next hour); the SAME refusal PARK_DECLINE_ESCALATE_AFTER hours running is a loop nothing here
      // can break, so it must stop being invisible. Crossing the threshold raises the row to RED
      // `errored` — which IS in the notify set that the amber tier is deliberately kept out of — so it fires the
      // banner/badge, and the attention screen (tier (b) of readAgentTerminal, relayed to the phone
      // and returned to the concierge) says how long it has been stuck. This is the founder-requested
      // prevention: the hourly log-mining + beads-drain loop stopped for days behind a red row nobody
      // was pinged about, because the park declined every hour and the only signal was a silent pill.
      const { status, streak } = noteParkDeclineStatus(park.reason);
      const escalated = status === "errored";
      const screen = escalated
        ? `Improve Sparkle has been unable to start ${streak} hourly passes in a row for the same reason, ` +
          `and it won't recover on its own. ${detail}`
        : detail;
      if (escalated) {
        console.error(
          "improvement pass: STUCK — refused to start",
          streak,
          "hourly passes in a row —",
          park.reason,
          "—",
          detail,
        );
      } else {
        console.warn("improvement pass: refusing to run from an unknown base —", park.reason, "—", detail);
      }
      // ⚠️ STATUS FIRST, THEN THE SCREEN — the order is load-bearing, and it became so the day this
      // branch stopped being red. `runtimeStore.setStatus` DROPS `attentionScreen[agentId]` whenever
      // the new status is outside the red tier (sparkle-99o9a: a capture must not outlive the ask it
      // photographs). `lapsed` is outside that tier by design, so writing the screen first and the
      // status second would erase the remedy text on the very next line — silently, leaving the row
      // amber with nothing anywhere to say WHY, which is strictly worse than the red row this change
      // is removing. Written after, it survives: `setAttentionScreen` has no such gate, and tier (b)
      // of `readAgentTerminal` reads the capture without asking whether the row is red.
      setStatus(SPARKLE_AGENT_ID, status);
      useRuntimeStore.getState().setAttentionScreen(SPARKLE_AGENT_ID, screen);
      return false; // `finally` still clears the passRunning latch.
    }
    // The park cleared (a fresh base, or one already fresh) — the consecutive-decline streak the hourly
    // loop may have been accumulating is broken. Reset it so a later first refusal starts a new count
    // rather than inheriting this run's and escalating on the wrong hour.
    clearParkDeclineStreak();
    // READABLE WITHOUT A PANE. This pass has no PTY, so the concierge's live tiers are all empty for
    // it — registering the worktree is the only thing that makes "what is Improve Sparkle doing?"
    // answerable while an hourly pass is mid-flight. It is the WORKTREE and not a resolved file
    // precisely because of where this line sits: the pass has not spawned yet, and it spawns with no
    // `--resume`, so the newest transcript right now is the PREVIOUS pass's. Tier (d) picks the file
    // when it reads (roborev 55363).
    //
    // AND IT CARRIES THE ACCOUNT CONFIG DIR. This pass spawns `claude` with a per-account
    // `CLAUDE_CONFIG_DIR`, so its transcript is written under `<accountConfigDir>/projects/<slug>/`
    // and NOT under `$HOME/.claude/projects/<slug>/`. Registering the worktree without it left both
    // readers — the concierge's tier (d) and the mounted pane — scanning a directory that does not
    // exist for this agent, i.e. an empty answer for a pass that was writing at that moment. This
    // agent has no `AgentPane`, so there is no hook stream to supply it later; the registration is
    // the only writer it will ever get.
    const configDir = (await accountConfigDirFor(SPARKLE_AGENT_ID)) ?? null;
    registerSparkleTranscript(SPARKLE_AGENT_ID, wt.path, configDir);
    // THE REFUSAL TEXT IS RETRACTED THE MOMENT IT STOPS BEING TRUE. Nothing else clears it, and it
    // is not merely cosmetic residue: `attentionScreen` is tier (b) of `readAgentTerminal`, so a
    // stale "can't start a pass — push that branch" would be handed to the concierge as this agent's
    // CURRENT screen, and relayed to the user in the present tense, while the pass it describes was
    // running fine. That is the confidently-wrong failure the whole read chain is built to avoid,
    // and this branch is what newly exposed it (before, nothing could read this agent at all).
    //
    // Cleared HERE — after the gate, before the pass starts — because this is the exact point at
    // which the previous refusal is known to be over. Writing `""` rather than deleting the key is
    // what tier (b) already treats as "no ask-screen captured".
    useRuntimeStore.getState().setAttentionScreen(SPARKLE_AGENT_ID, "");
    // Same protections the interactive pane installs — this pass runs with auto-approved
    // tools, so the write-guard + integrity check matter MORE here, not less.
    try {
      await installWorktreeGuard(wt.path);
    } catch (e) {
      console.warn("improvement pass: guard install failed (relocation still protects):", e);
    }
    await assertWorkspaceIntegrity(wt.path);
    // Ask BEFORE spending the pass whether its work can actually be submitted. A read-only user
    // (the normal case for the public build) would otherwise run a full pass and 403 on the very
    // last step; the persona degrades to propose-only instead. A failed probe yields "unknown",
    // which keeps the normal submitting path — never let a network blip mute a maintainer.
    const submit = await checkSubmitCapability().catch(() => null);

    // WHICH ACCOUNT THIS PASS RUNS UNDER — resolved HERE, at the pass boundary, and not touched
    // again for the life of the pass.
    //
    // That placement is the whole rule for this consumer (PRD/sparkle/account-rotation.md §6). A
    // pass is one unattended `claude -p` child, and its account is fixed the moment that child is
    // spawned; re-reading the selection mid-pass could not move the running process anyway, and
    // would only put the pass's transcript and its account out of step. So a switch that happens
    // while a pass is in flight changes NOTHING about that pass — it finishes on the account it
    // started on — and takes effect on the next hourly pass, which is at most an hour away.
    //
    // Keyed by SPARKLE_AGENT_ID so the headless pass and the interactive Improve Sparkle pane
    // resolve to the SAME account: they already share one worktree, and pinning the pane would be
    // meaningless if the background pass ignored the pin.
    // Riding out a temporarily unreadable accounts backend is the RESOLVER's job, not this
    // caller's: the interactive Improve Sparkle pane resolves the same key through
    // `chooseAccountForAgent`, and a rule implemented here would leave that half on a different
    // one — two spawns into one shared worktree, disagreeing. So `?? null` is the whole of it, and
    // `undefined` here now means only "no account has ever resolved for this key".
    //
    // RESOLVED ABOVE `registerSparkleTranscript`, not here, so the registration can CARRY it — see
    // that call. Still one resolution, still at the pass boundary, still untouched for the life of
    // the pass; only its line moved.

    // `working` was already claimed at the top of the work (right after the Claude-installed check),
    // so the row has been green through the clone/worktree/park/probe preamble — see that call.
    const outcome = await new Promise<PassOutcome>((resolve, reject) => {
      const unlisteners: Array<() => void> = [];
      // One guarded teardown shared by every exit path (first caller wins; the rest no-op),
      // so a future cleanup step can't be added to one path and missed on another.
      let settled = false;
      const finish = (deliver: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        settleOnCancel = null;
        // safeUnlisten (not a bare `u()`): a window-close during a pass can tear down Tauri's
        // listeners map before this runs, and a raw unlisten then throws the benign "handlerId"
        // race as an unhandled rejection. Fire-and-forget — teardown order is unaffected.
        for (const u of unlisteners) void safeUnlisten(u);
        deliver();
      };
      const settle = (v: PassOutcome) => finish(() => resolve(v));
      const fail = (e: unknown) =>
        finish(() => reject(e instanceof Error ? e : new Error(String(e))));
      // Armed for the whole life of the pass; `finish` disarms it. The watchdog below cancels
      // too, but settles itself synchronously first, so its timeout text wins over this one.
      settleOnCancel = () => settle({ ok: false, cancelled: true, text: "pass was cancelled" });
      // Hung-pass watchdog: kill the pass and release the latch rather than wait forever
      // (roborev #24516). cancel is silent by design (no error event), so settle here.
      const timer = setTimeout(() => {
        // Handed to the outcome, not discarded: the leftovers probe MUST NOT touch the worktree
        // until this has returned. `settle` still runs synchronously right after, so the timeout
        // text keeps winning the race against the cancel hook.
        const killed = cancelImprovementPass().then(
          () => true,
          () => false,
        );
        settle({
          ok: false,
          timedOut: true,
          killed,
          text: `pass timed out after ${PASS_BUDGET_MINUTES} minutes and was killed`,
        });
      }, PASS_TIMEOUT_MS);
      // Each unlistener is captured as ITS OWN listen resolves (not from Promise.all's result):
      // if one listen registers and the other rejects, the fulfilled handle must still reach
      // `unlisteners` or that listener would leak for the life of the webview. A handle that
      // arrives after settlement is unlistened on the spot for the same reason.
      const track = (u: () => void) => {
        if (settled) void safeUnlisten(u);
        else unlisteners.push(u);
      };
      Promise.all([
        listen<{ sessionId: string; text: string }>("sparkle_improve:done", (ev) => {
          // BIND BEFORE SETTLING, and both orderings matter for a different reason.
          //
          // Bind at all: `done` carries the id of the session the pass FINISHED writing, and it is
          // exactly as authoritative as the early announcement below — it comes from the same
          // process the app started. `handle_event` re-assigns `session_id` on the `result` event,
          // so if the pass forked or continued mid-flight the two differ, and the final file is the
          // TAIL of the conversation someone opened the pane to read. The announcement is once-only
          // by design (it must not re-fire at turn end), which means without this the late id is
          // dropped and that tail is unreadable until next hour's directory scan. It also covers a
          // stream whose `init` line never carried an id, where `done` is the only one the app ever
          // sees. Additive and idempotent — the registry accumulates and no-ops on a known id.
          //
          // Before `settle`: so the id is recorded before anything later in this handler can throw
          // or be reordered. NOT because settling stops this handler — it does not, and the comment
          // here used to say so (roborev 63251). `settle` → `finish` unlistens fire-and-forget and
          // resolves; neither aborts the handler that is currently executing, and the awaiting
          // continuation only runs on a later microtask, so a bind placed after `settle` would
          // still run and still run before any consumer could observe the registry. In a file where
          // comments are read as contracts, that invented an ordering rule a future reader would
          // carry to other handlers, where it is equally untrue.
          if (ev.payload.sessionId) noteAgentSessionId(SPARKLE_AGENT_ID, ev.payload.sessionId);
          settle({ ok: true, text: ev.payload.text });
        }).then(track),
        listen<{ message: string; sessionId?: string }>("sparkle_improve:error", (ev) => {
          // THE SAME BIND ON THE FAILING PATH, and it matters more here (roborev 63251). A pass that
          // fails still wrote a conversation, and a failure is the ending someone actually opens the
          // pane to read. Rust had the id in scope on this branch and dropped it, so the very case
          // the `done` bind covers — a pass that forked or continued mid-flight, leaving the
          // once-only early announcement naming a different file than the final one — left the tail
          // unreadable on every failure. On the error path `done` never arrives, so for a stream
          // whose `init` line carried no id this is the only id the app will ever see.
          if (ev.payload.sessionId) noteAgentSessionId(SPARKLE_AGENT_ID, ev.payload.sessionId);
          settle({ ok: false, text: ev.payload.message });
        }).then(track),
        // WHICH SESSION THIS PASS IS WRITING — announced by Rust from Claude's own first stream line,
        // and the ONLY authoritative answer available mid-pass.
        //
        // The mounted transcript reads by session id and fails closed on an agent whose sessions it
        // does not know. This pass has no pane and therefore no hook events, so `AgentPane`'s gated
        // writer can never fire for it (roborev 63133/63135). `registerSparkleTranscript` above does
        // bind something — but it runs BEFORE the spawn, and the spawn carries no `--resume`, so
        // what it can see is the PREVIOUS pass's session. This is the live one, and it comes from
        // the process the app itself started rather than from a directory scan that cannot tell this
        // pass's file from any other `claude` run in the same tree.
        //
        // It does NOT settle the pass. It is a binding, not an outcome, and it arrives ~a second in
        // — treating it as a result would end every pass immediately. It is tracked like its
        // siblings so it cannot outlive the run.
        listen<{ sessionId: string }>("sparkle_improve:session", (ev) => {
          if (ev.payload.sessionId) noteAgentSessionId(SPARKLE_AGENT_ID, ev.payload.sessionId);
        }).then(track),
      ]).then(
        () => {
          // Same settlement discipline as track: if the pass already settled (e.g. the
          // accepted stale-event race delivered first), don't spawn a run nobody is watching.
          if (settled) return;
          // Headless: nobody is here to run `gh auth login`, whatever the consent mode says.
          const headlessPersona = sparklePersona(
            ws.logDir,
            wt.path,
            consent,
            submit?.verdict ?? "unknown",
            { attended: false },
          );
          void buildPassControlMcp().then((mcpConfig) => {
            if (settled) return;
            const controlUp = mcpConfig !== undefined;
            invoke("sparkle_improve_run", {
              cwd: wt.path,
              claudePath: claude.path,
              persona: controlUp
                ? `${headlessPersona}\n\n${sparkleControlProtocol()}`
                : headlessPersona,
              prompt: focusBead
                ? drainMissionPrompt(focusBead, consent, submit?.verdict ?? "unknown")
                : hourlyMissionPrompt(consent, submit?.verdict ?? "unknown"),
              logDir: ws.logDir,
              mcpConfig,
              configDir,
            }).catch(fail);
          }, fail);
        },
        fail,
      );
    });

    if (outcome.ok) {
      const result = parseImproveResult(outcome.text);
      // A pass that COMPLETED is proof the loop is not stuck, whatever it reported.
      ran = true; // a worker ran and reported — the drainer bridge may ack the spooled request.
      clearRunFailureStreak();
      setStatus(
        SPARKLE_AGENT_ID,
        result && result.awaitingApproval > 0 ? "approval" : "idle",
      );
    } else if (outcome.cancelled) {
      // Somebody deliberately took the worktree — the interactive pane's prepare(). Nothing is
      // wrong, so don't park on a failure status at all (not even the amber one — nothing here is
      // unfinished) and don't warn; the pane is about to drive the agent's status itself.
      setStatus(SPARKLE_AGENT_ID, "idle");
    } else {
      console.warn("improvement pass failed:", outcome.text);
      // Only on a timeout. Every other failure shape either never started the agent (preflight,
      // transport) or was reported BY it, so there is no half-finished work to characterize — and
      // an unconditional probe would park the worktree out from under the retry armed just below.
      if (outcome.timedOut)
        await reportTimeoutLeftovers(ws.repoPath, ws.defaultBranch, outcome.killed);
      // ⚠️ CLASSIFY ONCE, DRIVE BOTH DECISIONS (roborev 67806). The quota-outranks-transient ordering
      // was applied to the COLOUR and not to the RETRY: `armRetryIfTransient` asked
      // `isTransientPassFailure` directly, so a message carrying BOTH shapes — a dropped connection
      // and a limit banner in one payload — armed the slot's one early re-attempt AND painted the row
      // red. The pass then re-ran minutes later against a wall no retry can clear, burned `retryUsed`
      // for the hour (so a genuinely transient failure later got none), and flickered the red dot back
      // through `working`. The classifier honoured the ordering; this caller did not.
      const outcomeClass = classifyPassFailure(outcome.text, Date.now());
      if (outcomeClass === "transient") armRetryIfTransient(outcome.text);
      // AMBER unless the account itself is walled. This wrote `blocked` (RED) for EVERY failure
      // until 2026-08-22 — including the connectivity shapes `armRetryIfTransient` re-attempts a
      // minute later on the line above, and the 30-minute timeout the next hourly slot re-attempts
      // by itself. See engine/passFailureStatus for the rule and why quota is the one red arm.
      // AMBER unless the account is walled — OR unless this is the same failure for the third hour
      // running, at which point no other actor is coming and it is red. See noteRunFailureStatus.
      const outcomeFailure = noteRunFailureStatus(outcome.text, outcomeClass);
      surfaceRunFailure(outcomeFailure, outcome.text);
    }
  } catch (e) {
    console.warn("improvement pass errored:", e);
    // The setup steps above (worktree, guard, integrity) reach the network too, so a throw
    // here can be the same lost-connectivity story as a failed run.
    const failure = e instanceof Error ? e.message : String(e);
    // ⚠️ Same rule as the outcome path above (roborev 67806): classify ONCE and let it gate the
    // retry too. A quota wall reached through a THROW must not arm the slot's one re-attempt — it
    // would re-run against the wall minutes later and burn `retryUsed` for the hour.
    const failureClass = classifyPassFailure(failure, Date.now());
    if (failureClass === "transient") armRetryIfTransient(failure);
    // Same rule as the failure branch above: a setup throw is something the next slot re-attempts,
    // so it is AMBER — unless the message names an account wall, which no re-attempt can clear.
    surfaceRunFailure(noteRunFailureStatus(failure, failureClass), failure);
  } finally {
    releasePass();
  }
  return ran;
}
