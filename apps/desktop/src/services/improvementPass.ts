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
  ensureSparkleRepo,
  sparklePersona,
  SPARKLE_AGENT_ID,
  SPARKLE_PROJECT_ID,
} from "./sparkleAgent";
import {
  assertWorkspaceIntegrity,
  createAgentWorktree,
  installWorktreeGuard,
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

/** The one-shot mission for an hourly pass. Mode-specific ONLY in what happens to a finished
 *  change — the persona (sparklePersona) already carries the hard rules; this restates the
 *  operative ones so a fresh `-p` session can't miss them, and demands the structured trailer. */
export function hourlyMissionPrompt(consent: SparkleImprovementConsent): string {
  const disposition =
    consent === "always"
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
}

/** Pure gate: is an hourly pass due right now? (bead sparkle-4xwk.2) */
export function shouldRunImprovementPass(gate: PassGate): boolean {
  if (gate.consent === "never") return false;
  if (gate.passRunning) return false;
  if (gate.paneStatus === "working") return false;
  if (gate.lastRunAt === null) return false; // scheduler seeds the clock on its first tick
  return gate.now - gate.lastRunAt >= IMPROVEMENT_INTERVAL_MS;
}

/** In-flight latch. Module-level (not store state): it guards a real child process in THIS
 *  webview, and must reset with the page. */
let passRunning = false;

/** True while a headless pass is in flight (read by the scheduler's gate). */
export function isPassRunning(): boolean {
  return passRunning;
}

/** Kill an in-flight pass (harmless no-op when none). The interactive pane calls this in
 *  prepare() so two `claude` processes never share the agent worktree. */
export function cancelImprovementPass(): Promise<void> {
  return invoke("sparkle_improve_cancel");
}

/**
 * Run one headless improvement pass now. Resolves when the pass finishes (or fails); callers
 * that only want to fire-and-forget can ignore the promise. Quietly does nothing if claude
 * isn't installed. Status wiring: the pinned row shows "working" for the duration, then
 * "approval" (red "Approve?") when a case-by-case draft awaits the user, else back to "idle";
 * a failed pass parks on "blocked" (quiet gray — an unattended background failure isn't a
 * red-alert interruption; it retries next hour).
 */
export async function runImprovementPass(consent: SparkleImprovementConsent): Promise<void> {
  if (passRunning || consent === "never") return;
  passRunning = true;
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
    // Same protections the interactive pane installs — this pass runs with auto-approved
    // tools, so the write-guard + integrity check matter MORE here, not less.
    try {
      await installWorktreeGuard(wt.path);
    } catch (e) {
      console.warn("improvement pass: guard install failed (relocation still protects):", e);
    }
    await assertWorkspaceIntegrity(wt.path);

    setStatus(SPARKLE_AGENT_ID, "working");
    const outcome = await new Promise<{ ok: boolean; text: string }>((resolve, reject) => {
      const unlisteners: Array<() => void> = [];
      // One guarded teardown shared by every exit path (first caller wins; the rest no-op),
      // so a future cleanup step can't be added to one path and missed on another.
      let settled = false;
      const finish = (deliver: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // safeUnlisten (not a bare `u()`): a window-close during a pass can tear down Tauri's
        // listeners map before this runs, and a raw unlisten then throws the benign "handlerId"
        // race as an unhandled rejection. Fire-and-forget — teardown order is unaffected.
        for (const u of unlisteners) void safeUnlisten(u);
        deliver();
      };
      const settle = (v: { ok: boolean; text: string }) => finish(() => resolve(v));
      const fail = (e: unknown) =>
        finish(() => reject(e instanceof Error ? e : new Error(String(e))));
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
            persona: sparklePersona(ws.logDir, wt.path, consent),
            prompt: hourlyMissionPrompt(consent),
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
    } else {
      console.warn("improvement pass failed:", outcome.text);
      setStatus(SPARKLE_AGENT_ID, "blocked");
    }
  } catch (e) {
    console.warn("improvement pass errored:", e);
    setStatus(SPARKLE_AGENT_ID, "blocked");
  } finally {
    passRunning = false;
  }
}
