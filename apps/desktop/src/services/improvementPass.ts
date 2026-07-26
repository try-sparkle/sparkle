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
import {
  assertWorkspaceIntegrity,
  createAgentWorktree,
  installWorktreeGuard,
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
    "your final state). Review the most recent entries in the Sparkle session logs you were",
    "given access to, looking for failures, recurring errors, or clear performance problems.",
    "Pick AT MOST ONE concrete, high-value, privacy-safe improvement and implement it as a",
    "small, focused change on a fresh branch in this worktree. If nothing meets that bar, make",
    "no changes at all — a no-op pass is a good outcome.",
    LEFTOVER_CLAUSE,
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
  /** Epoch ms at which the connectivity re-attempt comes due, or null when none is armed
   *  (module-level latch below). Omitted by callers that don't model retries. */
  retryDueAt?: number | null;
}

/** Has the hourly slot itself come due? The ONE definition of that threshold: the gate decides
 *  whether to run on it, and the scheduler decides whether the run is a fresh slot (which
 *  re-earns the connectivity retry) or the re-attempt. Two copies of this comparison would only
 *  stay correct while they stayed identical. */
export function isHourlySlotDue(lastRunAt: number, now: number): boolean {
  return now - lastRunAt >= IMPROVEMENT_INTERVAL_MS;
}

/** Pure gate: is an hourly pass due right now? (bead sparkle-4xwk.2) */
export function shouldRunImprovementPass(gate: PassGate): boolean {
  if (gate.consent === "never") return false;
  if (gate.passRunning) return false;
  if (gate.paneStatus === "working") return false;
  if (gate.lastRunAt === null) return false; // scheduler seeds the clock on its first tick
  // An armed retry short-circuits the hourly wait, but NOT the guards above it: the pass still
  // must not double-run or share the worktree with a live pane session.
  if (gate.retryDueAt != null && gate.now >= gate.retryDueAt) return true;
  return isHourlySlotDue(gate.lastRunAt, gate.now);
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

/** In-flight latch. Module-level (not store state): it guards a real child process in THIS
 *  webview, and must reset with the page. */
let passRunning = false;

/** True while a headless pass is in flight (read by the scheduler's gate). */
export function isPassRunning(): boolean {
  return passRunning;
}

/** How a pass ended. `cancelled` marks the deliberate-handoff path — an `ok: false` that is NOT
 *  a failure, so it must not warn or park the agent on "blocked". */
type PassOutcome = { ok: boolean; text: string; cancelled?: boolean };

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
  if (passRunning || consent === "never") return;
  passRunning = true;
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
    // Advisory, never fatal: parking declines on its own whenever there's anything to lose (dirty
    // tree, or commits not yet on an origin ref — e.g. a pass that committed but couldn't push, or
    // a case-by-case draft awaiting review), and a failure here must not cost the user a pass.
    try {
      const park = await parkWorktreeOnBase(
        ws.repoPath,
        SPARKLE_PROJECT_ID,
        SPARKLE_AGENT_ID,
        ws.defaultBranch,
      );
      if (!park.parked && park.reason !== "already-fresh") {
        console.warn("improvement pass: starting from a stale base —", park.reason);
      }
    } catch (e) {
      console.warn("improvement pass: could not park the worktree on a fresh base:", e);
    }
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
        void cancelImprovementPass().catch(() => {});
        settle({ ok: false, text: `pass timed out after ${PASS_TIMEOUT_MS / 60000} minutes and was killed` });
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
        listen<{ sessionId: string; text: string }>("sparkle_improve:done", (ev) =>
          settle({ ok: true, text: ev.payload.text }),
        ).then(track),
        listen<{ message: string }>("sparkle_improve:error", (ev) =>
          settle({ ok: false, text: ev.payload.message }),
        ).then(track),
      ]).then(
        () => {
          // Same settlement discipline as track: if the pass already settled (e.g. the
          // accepted stale-event race delivered first), don't spawn a run nobody is watching.
          if (settled) return;
          invoke("sparkle_improve_run", {
            cwd: wt.path,
            claudePath: claude.path,
            persona: sparklePersona(ws.logDir, wt.path, consent, submit?.verdict ?? "unknown"),
            prompt: hourlyMissionPrompt(consent, submit?.verdict ?? "unknown"),
            logDir: ws.logDir,
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
    passRunning = false;
  }
}
