import { paneGeneration, paneRelaunchCount, paneState } from "./paneReadiness";

// Lets non-React code re-spawn a specific agent's PTY.
//
// Same tiny-registry shape as paneReadiness / terminalScrollback: each AgentPane registers while
// mounted and unregisters on unmount. The account-switch path needs this because a switch is
// decided globally (an ACCOUNT is running out) but executed per pane, and the pane that must act
// is usually not the one the user is looking at.
//
// Restarting is safe by construction here: the spawn path resumes the agent's Claude session
// (`--resume <id>`), so a re-spawn continues the conversation rather than starting over. Choosing a
// moment when that costs nothing is accountSwitch's job, not this registry's.

/** What `restartPaneAwaited` concluded. Only `"restarted"` means the agent came back. */
export type PaneRestartResult =
  | "restarted"
  | "no-pane"
  | "no-claude"
  | "spawn-failed"
  | "threw"
  | "timed-out"
  | "nothing-to-restart";

/** A lever may report the terminal phase its `prepare()` reached — `"ready"`, `"no-claude"`,
 *  `"error"` — or report nothing at all. Typed `unknown` rather than a phase union because the
 *  levers predate the reporting contract and several return incidental values; `restartPaneAwaited`
 *  narrows, and anything it does not recognise is a FAILURE, never a success. */
const restarts = new Map<string, () => unknown>();

/** Publish this pane's re-spawn lever. Called by AgentPane while mounted.
 *
 *  RETURN THE PHASE, don't swallow it. `prepare()` catches its own failures and resolves normally,
 *  so its terminal phase is the only thing that distinguishes a spawn that worked from one that did
 *  not. A lever that returns `void` still works, but nothing can tell whether it succeeded. */
export function registerPaneRestart(agentId: string, restart: () => unknown): void {
  restarts.set(agentId, restart);
}

/** Drop this pane's entry (unmount). */
export function unregisterPaneRestart(agentId: string): void {
  restarts.delete(agentId);
}

/** Re-spawn an agent's PTY, FIRE-AND-FORGET. Returns false when no pane is mounted for it — a
 *  closed agent simply picks up its new account the next time it spawns, so this is a no-op, never
 *  an error.
 *
 *  `true` here means DISPATCHED, not restarted: the lever is async, so this returns long before the
 *  spawn has happened and cannot see a failure inside it. That is fine for the callers who fire it
 *  as one step of a larger sweep (account switch, auth recovery, resurrection), all of which re-read
 *  the agent's state on their next tick anyway. It is NOT fine for a caller that reports an outcome
 *  to a human — use `restartPaneAwaited`. */
export function restartPane(agentId: string): boolean {
  const fn = restarts.get(agentId);
  if (!fn) return false;
  try {
    // An async lever's rejection would otherwise surface as an unhandled rejection, since the
    // returned promise is dropped here by design.
    void Promise.resolve(fn()).catch((e: unknown) => {
      console.warn("restartPane (async) failed for", agentId, e);
    });
    return true;
  } catch (e) {
    console.warn("restartPane failed for", agentId, e);
    return false;
  }
}

/** How long to wait for the PTY to come up before giving a `"timed-out"` verdict, and how often to
 *  look. Bounded on purpose: `prepare()` reaches Tauri IPC (worktree creation, guard install,
 *  claude preflight, orchestration bridge) and any of those can stall, and a concierge tool call
 *  that hangs forever is its own outage. */
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 100;

/**
 * Re-spawn an agent's PTY and WAIT until it is genuinely back up, reporting what happened.
 *
 * This exists because `restartPane`'s boolean is a dispatch receipt, and a caller that relays it to
 * a human turns it into a false success. Measured on v0.107.0: three errored agents were restarted
 * via the concierge, all three acked `{ok:true}`, and an immediate status re-read showed all three
 * still `errored` — because nothing had run yet.
 *
 * THE PHASE IS NOT THE ANSWER, and this is the trap that ate the first version of this function.
 * `prepare()` reaching phase `"ready"` means the spawn command was ASSEMBLED (`setSpawn` +
 * `setPhase("ready")`); `Terminal` execs the PTY afterwards, and that path's failure is explicitly
 * the one that "never touches `phase` at all" — it sets `gaveUp` / `paneReadiness = failed`
 * instead. So a verdict built on the phase reports a launch that died at PTY spawn as restarted.
 *
 * The fact that actually means "up" is `paneReadiness`, which the pane publishes for exactly this
 * question. So the phase is used only to FAIL FAST with a specific cause (`no-claude`, `error`),
 * and success is always the pane reaching `ready`.
 *
 * There is deliberately NO defaulted success. A lever that reports nothing, reports `"preparing"`
 * (a stale-run guard returned, or a concurrent sweep re-entered `prepare()`), or reports something
 * unrecognised does not shortcut to `"restarted"` — it falls through to the readiness wait, and the
 * real signal decides. That also means a superseded run is judged by whether the pane came up,
 * which is the only thing the caller actually cares about.
 */
export async function restartPaneAwaited(
  agentId: string,
  opts: { readyTimeoutMs?: number; pollMs?: number } = {},
): Promise<PaneRestartResult> {
  const fn = restarts.get(agentId);
  if (!fn) return "no-pane";
  // SNAPSHOT BEFORE TRIGGERING. A running agent is already `ready`, so any reading that has not
  // moved past this is the PREVIOUS launch's verdict and says nothing about the restart.
  const gen0 = paneGeneration(agentId);
  const relaunch0 = paneRelaunchCount(agentId);
  const pollMs = opts.pollMs ?? READY_POLL_MS;
  // ONE budget for the whole call, computed before anything is triggered. The lever and the
  // readiness wait are two phases of the same wait, so giving each its own `readyTimeoutMs` would
  // mean the caller can block for twice what it asked for — and `restartAgent` uses the defaults,
  // so that is a ~2-minute hang against a doc comment whose stated purpose is that a concierge tool
  // call which hangs forever is its own outage.
  const deadline = Date.now() + (opts.readyTimeoutMs ?? READY_TIMEOUT_MS);

  // BOUND THE LEVER ITSELF, not just the wait after it. `prepare()` awaits a string of Tauri
  // round-trips — worktree creation, guard install, workspace integrity, claude preflight, the
  // orchestration bridge — and any one of them can stall on a locked repo or a hung
  // `git worktree add`. Awaiting it unconditionally wedges the caller forever with no verdict it
  // can act on, which is the same class of failure this whole function exists to close.
  const STALLED = Symbol("lever-stalled");
  let report: unknown;
  try {
    report = await Promise.race([
      Promise.resolve(fn()),
      new Promise((r) => setTimeout(() => r(STALLED), Math.max(0, deadline - Date.now()))),
    ]);
  } catch (e) {
    console.warn("restartPaneAwaited failed for", agentId, e);
    return "threw";
  }
  if (report === STALLED) return "timed-out";
  // Fast, specific failures — the two phases that mean prepare() decided not to spawn at all.
  if (report === "no-claude") return "no-claude";
  if (report === "error") return "spawn-failed";

  // ── DID A RE-SPAWN ACTUALLY START? ────────────────────────────────────────────────────────────
  //
  // ASKED OF THE PANE, NEVER INFERRED. An earlier cut inferred it from the publication counter
  // moving, and that is wrong in BOTH directions (roborev 64104), because a publication only
  // happens when one of the publish effect's deps changes (`ptyReady`, `phase`, `gaveUp`,
  // `spawnMatchesTargetRuntime`):
  //
  //   • A local agent restarted while it is ALREADY mid-launch — phase "preparing", ptyReady false,
  //     which is exactly the wedged agent a human asks the concierge to restart — re-enters
  //     prepare() and every one of those writes is a no-op. Nothing publishes, yet a real re-spawn
  //     IS in flight. Inferring "nothing happened" there produced a fast false negative.
  //   • A shell or cloud re-prepare takes an early return, never remounts Terminal, and never
  //     re-spawns the PTY at all. Nothing publishes because nothing is happening.
  //
  // `notePaneRelaunch` is called synchronously by the paths that genuinely re-spawn, before their
  // first await, so by the time the lever resolves this has moved iff a re-spawn began.
  if (paneRelaunchCount(agentId) === relaunch0) {
    // Reported as its OWN outcome rather than as success. A shell or cloud re-prepare rebuilds
    // config and returns early — the PTY is never replaced — so calling it "restarted" would tell
    // the human an action happened that did not. Whether the pane happens to be up is a different
    // question from whether the restart occurred, and it is not the one that was asked.
    return "nothing-to-restart";
  }

  // A real re-spawn is in flight. Only a reading NEWER than the snapshot can judge it: the agent
  // being restarted is usually one that was already `ready`, and taking that at face value reports
  // the previous launch's verdict as this restart's success (roborev 64084).
  for (;;) {
    if (paneGeneration(agentId) > gen0) {
      const state = paneState(agentId);
      if (state === "ready") return "restarted";
      // `failed` is the pane having given up — including the PTY-spawn rejection the phase cannot
      // see, which is the whole reason this function does not trust the phase.
      if (state === "failed") return "spawn-failed";
      // The pane unmounted underneath the restart (tab closed mid-flight). Nothing is coming.
      if (state === "unmounted") return "no-pane";
      // "starting": the re-spawn is genuinely in flight. Keep waiting.
    }
    if (Date.now() >= deadline) return "timed-out";
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// ---- which account each live agent is running under -------------------------------------------
//
// The switch path needs this to know WHICH agents have to move. It can't be derived from the pin
// map: most agents auto-pick, so they have no pin, yet they're still running under some account.
// Only the pane knows the account its PTY was actually spawned with.

const paneAccounts = new Map<string, string>();

/** Publish the account this pane's PTY is running under. Called by AgentPane once the account is
 *  chosen for a spawn. */
export function registerPaneAccount(agentId: string, accountId: string): void {
  paneAccounts.set(agentId, accountId);
}

/** Drop this pane's account entry (unmount). */
export function unregisterPaneAccount(agentId: string): void {
  paneAccounts.delete(agentId);
}

/** agentId → accountId for every live pane — the input to `planSwitch`. */
export function paneAccountMap(): Record<string, string | undefined> {
  return Object.fromEntries(paneAccounts);
}

/** The account the most agents are currently running under, or null when nothing is running.
 *  This is the account a switch recommendation is about: switching one nobody uses achieves
 *  nothing, and the busiest one is what's actually consuming the quota. Ties break on the
 *  lexicographically smaller id purely for determinism. */
export function busiestPaneAccount(): string | null {
  const counts = new Map<string, number>();
  for (const accountId of paneAccounts.values()) {
    counts.set(accountId, (counts.get(accountId) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [id, n] of counts) {
    if (n > bestN || (n === bestN && best != null && id < best)) {
      best = id;
      bestN = n;
    }
  }
  return best;
}

/** Test/teardown helper. */
export function clearPaneRestarts(): void {
  restarts.clear();
  paneAccounts.clear();
}
