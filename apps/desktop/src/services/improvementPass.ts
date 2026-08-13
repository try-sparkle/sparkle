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
import { accountConfigDirFor } from "./accountSelection";
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
export function hourlyMissionPrompt(
  consent: SparkleImprovementConsent,
  submit: SubmitVerdict = "unknown",
): string {
  // The persona already carries a propose-only override, but this prompt is the LAST thing the
  // model reads — leaving "submit the PR yourself" in it would have the mission contradict the
  // system prompt on the one instruction that cannot succeed. Say the same thing in both places.
  const disposition = isSubmitBlocked(submit)
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

/** Failure shapes that mean "the transport broke", as opposed to "the pass ran and something
 *  about the work went wrong". Only these earn a re-attempt: they carry no signal that a second
 *  try would fail the same way, and the slot they burned produced nothing usable. Matched on the
 *  message text because that is all the failure event carries (the Rust side renders it in
 *  `failure_message`). Deliberately narrow — an ambiguous message stays non-transient and waits
 *  out the hour. In particular a usage/spend limit is NOT here: that WILL fail again. */
const TRANSIENT_FAILURE_PATTERNS = [
  "unable to connect",
  "enotfound",
  "eai_again",
  "econnreset",
  "econnrefused",
  "econnaborted",
  "etimedout",
  "socket hang up",
  "network error",
  "connection refused",
  "connection reset",
  "getaddrinfo",
  // Truncated-stream shapes. These come from the OTHER side of the connection — the pass did
  // reach the API and the stream then died partway — so they never match the pre-flight
  // patterns above, yet they are the dominant failure in practice: most failed passes report
  // one of these two, and every one of them costs a full hourly slot. The re-attempt is safe
  // for the same reason the hourly one is: a pass re-reads the repo state (and its own open
  // PRs) before doing anything, so partial work from the dead attempt is deduped, not redone.
  "closed mid-response",
  "stalled mid-stream",
];

/** True when a failed pass's message names a connectivity problem rather than a real failure. */
export function isTransientPassFailure(message: string): boolean {
  const lower = message.toLowerCase();
  return TRANSIENT_FAILURE_PATTERNS.some((p) => lower.includes(p));
}

/** True while a headless pass is in flight (read by the scheduler's gate).
 *
 *  RE-EXPORTED, not defined here. The latch itself lives in the leaf `improvementPassLatch` so that
 *  a module wanting only this boolean — `services/sparkleBusy`, and through it every UI component
 *  whose graph reaches `stores/settingsStore` — does not acquire THIS module's dependencies with it.
 *  That header explains what it cost when it did. Importers of `isPassRunning` from here keep
 *  working; new readers of the bare boolean should take the leaf. */
export { isPassRunning } from "./improvementPassLatch";

/** How a pass ended. `cancelled` marks the deliberate-handoff path — an `ok: false` that is NOT
 *  a failure, so it must not warn or park the agent on "blocked". */
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
 * cannot save a commit) — so the hourly pass stops for good until a human acts. A red row alone does
 * not tell them that, or that the thing to act on is a leftover branch in an app-owned worktree they
 * have never opened. AGENTS.md's rule applies: a refusal a user is expected to act on needs a remedy
 * they can actually see.
 *
 * PATH-FREE and BRANCH-FREE by construction, exactly like the Rust side's reason token: this text is
 * relayed to the phone and returned by `read_agent_terminal`, so it says WHAT to look for and leaves
 * the caller to run the command in the worktree, rather than embedding anything that could carry a
 * user's content.
 */
export function refusalDetail(reason: string): string {
  switch (reason) {
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
 * a failed pass parks on "blocked", which is RED (packages/ui/tokens.ts) but deliberately outside
 * the badge/notification set, so it recolors and re-sorts the row without firing a banner at you —
 * and it is dismissible, since it persists until the retry an hour later.
 *
 * `freshSlot` says this run is the hourly one coming due, not the connectivity re-attempt —
 * the scheduler knows which, and only a fresh slot re-earns the one retry.
 */
export async function runImprovementPass(
  consent: SparkleImprovementConsent,
  freshSlot = false,
): Promise<void> {
  if (consent === "never") return;
  // Claim-or-bail in ONE call: the check and the set used to be two statements, which is the shape
  // a second pass can slip between.
  if (!claimPass()) return;
  // Consume the armed retry before anything can fail: whatever happens next re-decides the
  // wait, and leaving it armed would make the gate fire again on the very next tick.
  //
  // `freshSlot` is what keeps a STALE arm from eating a later slot's retry: an armed retry can
  // go unconsumed for the rest of the hour (the pane guard suppresses it, say), and without the
  // flag the next hourly run would look like "the retry" and inherit its spent budget.
  if (freshSlot || retryDueAt === null) retryUsed = false;
  retryDueAt = null;
  const setStatus = useRuntimeStore.getState().setStatus;
  try {
    const claude = await checkClaude();
    if (!claude.installed || !claude.path) return; // not set up yet — skip quietly
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
    // "blocked" is the existing user-visible surface for exactly this: RED, so the row recolors and
    // re-sorts, but deliberately outside the badge/notification set, so it does not fire a banner —
    // and dismissible, since it persists until the retry an hour later. That makes the refusal loud
    // enough to see and quiet enough to ignore, rather than log-only.
    //
    // A THROW is deliberately NOT caught here. It used to be swallowed, which silently promoted the
    // least-informed case to the most-permissive outcome — but catching it HERE was wrong in the
    // other direction (roborev 55239): the local handler returned from inside the `try`, so it
    // bypassed `armRetryIfTransient`, the only place a lost-connectivity failure earns this slot's
    // one early re-attempt. Park is the MOST networked setup step (it fetches), so it was the one
    // step whose throw could not arm a retry, and the scheduler has already stamped `lastRunAt` —
    // making a connectivity blip cost a full hour of no pass, where before it cost nothing.
    // The outer `catch` already warns, arms the retry and sets `blocked`; letting the throw reach it
    // gets all three, so there is nothing left for a local handler to do.
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
      // WHICH MEANS THE REFUSAL IS PERMANENT, and a permanent refusal whose only signal is a red row
      // is the same shape the Rust side just spent a commit removing (a guard becoming the thing it
      // exists to prevent), relocated from "runs forever from a stale base" to "never runs again"
      // (roborev 55239). So the reason is WRITTEN WHERE SOMEONE WILL READ IT, not just warned:
      // `attentionScreen` is the text captured when an agent goes red, which is what the pane shows,
      // what the phone relays, and — since the concierge can now address this agent at all — what
      // `read_agent_terminal` returns for it at tier (b). The remedy is named, not implied: a user
      // told only "blocked" has no way to learn that a leftover branch in an app-owned worktree they
      // have never seen is what stopped it.
      const detail = refusalDetail(park.reason);
      console.warn("improvement pass: refusing to run from an unknown base —", park.reason, "—", detail);
      useRuntimeStore.getState().setAttentionScreen(SPARKLE_AGENT_ID, detail);
      setStatus(SPARKLE_AGENT_ID, "blocked");
      return; // `finally` still clears the passRunning latch.
    }
    // READABLE WITHOUT A PANE. This pass has no PTY, so the concierge's live tiers are all empty for
    // it — registering the worktree is the only thing that makes "what is Improve Sparkle doing?"
    // answerable while an hourly pass is mid-flight. It is the WORKTREE and not a resolved file
    // precisely because of where this line sits: the pass has not spawned yet, and it spawns with no
    // `--resume`, so the newest transcript right now is the PREVIOUS pass's. Tier (d) picks the file
    // when it reads (roborev 55363).
    registerSparkleTranscript(SPARKLE_AGENT_ID, wt.path);
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
    const configDir = (await accountConfigDirFor(SPARKLE_AGENT_ID)) ?? null;

    setStatus(SPARKLE_AGENT_ID, "working");
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
          invoke("sparkle_improve_run", {
            cwd: wt.path,
            claudePath: claude.path,
            // Headless: nobody is here to run `gh auth login`, whatever the consent mode says.
            persona: sparklePersona(ws.logDir, wt.path, consent, submit?.verdict ?? "unknown", {
              attended: false,
            }),
            prompt: hourlyMissionPrompt(consent, submit?.verdict ?? "unknown"),
            logDir: ws.logDir,
            configDir,
          }).catch(fail);
        },
        fail,
      );
    });

    if (outcome.ok) {
      const result = parseImproveResult(outcome.text);
      setStatus(
        SPARKLE_AGENT_ID,
        result && result.awaitingApproval > 0 ? "approval" : "idle",
      );
    } else if (outcome.cancelled) {
      // Somebody deliberately took the worktree — the interactive pane's prepare(). Nothing is
      // wrong, so don't park on "blocked" (red — it reads as "this needs your attention") and
      // don't warn; the pane is about to drive the agent's status itself.
      setStatus(SPARKLE_AGENT_ID, "idle");
    } else {
      console.warn("improvement pass failed:", outcome.text);
      // Only on a timeout. Every other failure shape either never started the agent (preflight,
      // transport) or was reported BY it, so there is no half-finished work to characterize — and
      // an unconditional probe would park the worktree out from under the retry armed just below.
      if (outcome.timedOut)
        await reportTimeoutLeftovers(ws.repoPath, ws.defaultBranch, outcome.killed);
      armRetryIfTransient(outcome.text);
      setStatus(SPARKLE_AGENT_ID, "blocked");
    }
  } catch (e) {
    console.warn("improvement pass errored:", e);
    // The setup steps above (worktree, guard, integrity) reach the network too, so a throw
    // here can be the same lost-connectivity story as a failed run.
    armRetryIfTransient(e instanceof Error ? e.message : String(e));
    setStatus(SPARKLE_AGENT_ID, "blocked");
  } finally {
    releasePass();
  }
}
