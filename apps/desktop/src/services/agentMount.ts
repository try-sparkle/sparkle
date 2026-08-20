// agentMount — THE ONE implementation of "bring this agent's pane back", shared by every caller
// that needs an agent RUNNING without a human having clicked anything.
//
// ══ WHY THIS IS A SHARED MODULE AND NOT FIVE LINES AT EACH CALL SITE ══════════════════════════
// This rule has now been derived independently three times, and got it wrong twice. It was
// `resurrectionRunner`'s private `defaultMount` (correct, and only after roborev 60241 fixed it),
// and then `services/sendToBuild`'s machine-driven handoff re-derived half of it and shipped the
// exact same no-op the resurrector had already paid to learn. The rule below is subtle enough that
// re-deriving it is a losing bet every time, so there is one copy and everyone calls it.
//
// ══ THE TRAP: `runtimeStore.open` IS A NO-OP FOR THE COMMON CASE ══════════════════════════════
// The intuitive mount signal is `runtimeStore.open(agentId)`. It does nothing at all for the state
// a recovery sweep actually finds, and the reason is structural rather than incidental:
//
//   • A sweep can only conclude "this agent is dead" from a `runtimeStore.status` entry
//     (`agentLiveness.livenessOf` returns "local" — the only observed reading — ONLY when
//     `status[id] !== undefined`), and that entry is written solely by a MOUNTED `AgentPane`.
//   • So every death a window observes with evidence is BY CONSTRUCTION one whose pane is still
//     there, sitting on its "Agent exited — Start again" overlay.
//   • And in that state `open` is a no-op: it merges the id into `openAgentIds`, finds the set
//     unchanged (nothing removes an id when its PTY exits), and returns the same state object. No
//     remount, no `claude --resume`.
//   • Conversely, an agent the user CLOSED has no status entry at all — so it reads as
//     liveness-unknown, which every sweep treats as "leave it alone". The one state where `open`
//     would do real work is the state no sweep will act on.
//
// `restartPane` is the lever that works there: it is what the "Start again" button pulls, tearing
// the PTY down and re-spawning it, which resumes the Claude session.
import { restartPane, restartPaneAwaited, type PaneRestartResult } from "./paneControl";
import { paneState } from "./paneReadiness";
import { admitAgent } from "./resurrectionAdmission";
import { useRuntimeStore } from "../stores/runtimeStore";

/**
 * What a mount attempt actually did.
 *
 * `no-agent-row` is a REFUSAL, not a variant of success — the caller must not report a relaunch,
 * and must not spend whatever budget it was about to spend.
 */
export type MountResult = "restarted" | "opened" | "no-agent-row";

/** Did the mount actually relaunch something? The one predicate a caller needs before reporting a
 *  recovery to a human or charging an attempt against a bounded budget. */
export function mounted(r: MountResult): boolean {
  return r !== "no-agent-row";
}

/**
 * Bring `agentId` back. Two routes, because there are two genuinely different states.
 *
 * ── ROUTE 1: THE PANE IS STILL MOUNTED, on "Agent exited — Start again" ───────────────────────
 * The COMMON case (see the header). `restartPane` re-spawns the PTY and resumes the session. Tried
 * FIRST, because a mounted pane is authoritative evidence that route 2's work is already done.
 *
 * ── ROUTE 2: NO PANE AT ALL ──────────────────────────────────────────────────────────────────
 * The app-restart case: this window has never mounted anything for that agent. `restartPane`
 * returns false (no pane registered a lever), and admission + `open` are exactly right — together
 * they are what makes `Workspace` mount a fresh pane, which prepares the worktree and resumes.
 * BOTH calls, doing different jobs: `admitAgent` unlocks the PROJECT's visited gate in Workspace's
 * `live` memo, and `open` is the app's ordinary, persisted, multi-window mount signal for the
 * AGENT — the one `runtimeStore.close()` undoes, which is what keeps the pane closable.
 *
 * ── ROUTE 2'S PRECONDITION IS CHECKED BEFORE ANYTHING IS WRITTEN ─────────────────────────────
 * Route 2 only works when a `Project.agents` row names the id: `Workspace` gates the project on
 * `p.agents.some(a => admitted.has(a.id))` and then mounts with `for (const a of p.agents)`, so an
 * id naming no row satisfies neither. Both writes are effectively permanent for the session — the
 * admission set is add-only by design, and nothing removes an id from `openAgentIds` on a PTY exit
 * — so growing them for an id that can never mount is pure garbage the caller would then report as
 * a successful relaunch. Skipping this check is why the resurrector shipped as a no-op once.
 *
 * `hasRow` is injected rather than read here so that a caller's own pre-gate and this function are
 * driven by ONE predicate; two copies could answer differently, and the pairing that matters in
 * production would then be untested by construction.
 */
export function mountAgent(agentId: string, hasRow: (id: string) => boolean): MountResult {
  if (restartPane(agentId)) return "restarted";
  if (!hasRow(agentId)) return "no-agent-row";
  admitAgent(agentId);
  useRuntimeStore.getState().open(agentId);
  return "opened";
}

// ══ THE AWAITED VARIANT ═══════════════════════════════════════════════════════════════════════
//
// `mountAgent` above reports what it DISPATCHED. That is right for `resurrectionRunner`, which
// re-reads every agent's state on its next tick and so cannot be fooled for longer than one
// interval. It is wrong for a caller that spends a one-shot budget and then TELLS A HUMAN what it
// did — `paneControl` says so in as many words: "`true` here means DISPATCHED, not restarted … It
// is NOT fine for a caller that reports an outcome to a human — use `restartPaneAwaited`."
//
// The epic sweep is exactly that caller. It spends an agent slot and an epic's only automatic
// restart, then sends the founder a message beginning "I restarted". Measured on v0.107.0, the
// dispatch receipt lied three times out of three: agents restarted through the concierge all acked
// `{ok:true}` and an immediate status re-read showed all three still `errored`.

/**
 * What an awaited mount concluded. A superset of {@link MountResult}: everything `mountAgent` can
 * say, plus the failures only waiting can observe, plus `already-live`.
 *
 * `already-live` is NOT a failure and NOT a no-op — see {@link mountAgentAwaited}.
 */
/** How long route 2 waits for `Workspace` to mount the pane it just arranged, and how often it
 *  looks. Matches `paneControl`'s own readiness budget: both are waiting on the same render-plus-
 *  spawn path, so a caller passing one `readyTimeoutMs` gets one meaning for it. */
const MOUNT_TIMEOUT_MS = 60_000;
const MOUNT_POLL_MS = 100;

/**
 * Time RESERVED for route 2's mount wait, so phase 1 can never consume the whole budget.
 *
 * Sharing one deadline across both phases stops the caller blocking for twice what it asked for —
 * but on its own it creates a worse failure than the one it fixes. `restartPaneAwaited` can return
 * `no-pane` LATE (its `unmounted` check precedes its deadline check, so it can return with ~0ms
 * left), and route 2 would then make its two PERMANENT writes and immediately time out. The caller
 * reports a failure and stays silent, the epic's one-shot budget is already spent — and `Workspace`
 * goes on to mount the pane anyway, so an orchestrator comes up holding a drafted seed with no
 * delivered instruction. That is strictly worse than either phase failing on its own.
 *
 * So phase 1 is bounded to the budget MINUS this floor, and the floor is what phase 2 is guaranteed.
 * Capped at half the budget so a caller passing a very small timeout (tests do) still gets a
 * sensible split rather than a phase 1 of zero.
 *
 * EXPORTED so its test asserts the real split exactly rather than a bound. A test that merely checks
 * "phase 1 got less than the budget" is satisfied by a 1ms reservation — and by the pre-fix code
 * whenever the millisecond rolls over between two `Date.now()` reads, which makes the revert-check
 * probabilistic in exactly the situation the guard has to hold.
 */
export const MOUNT_MIN_ROUTE2_MS = 5_000;

export type AwaitedMountResult =
  | "restarted"
  | "opened"
  | "already-live"
  | "no-agent-row"
  | "no-claude"
  | "spawn-failed"
  | "timed-out"
  | "nothing-to-restart";

/**
 * Did the agent end up RUNNING? The predicate a caller needs before reporting a recovery or
 * charging a bounded budget.
 *
 * Three arms pass, and `already-live` is the one worth stating: the agent is up, so a caller that
 * hands work to it will be heard. It is a success for the handoff even though no restart happened.
 */
export function mountedAwaited(r: AwaitedMountResult): boolean {
  return r === "restarted" || r === "opened" || r === "already-live";
}

/** `restartPaneAwaited`'s verdict in this module's vocabulary. `no-pane` is deliberately absent —
 *  it is not a failure but a routing fact ("no pane is mounted"), so the caller falls through to
 *  route 2 rather than reporting it. */
function fromPaneVerdict(v: Exclude<PaneRestartResult, "no-pane">): AwaitedMountResult {
  switch (v) {
    case "restarted":
      return "restarted";
    case "no-claude":
      return "no-claude";
    case "timed-out":
      return "timed-out";
    case "nothing-to-restart":
      return "nothing-to-restart";
    // `spawn-failed` and `threw` are the same fact to a caller: the re-spawn was attempted and the
    // agent did not come back. Collapsed rather than carried, because no caller can act differently
    // on "the lever raised" versus "the pane gave up" — both mean do not report a relaunch.
    case "spawn-failed":
    case "threw":
      return "spawn-failed";
    default: {
      const unhandled: never = v;
      void unhandled;
      // A verdict this module has never heard of is NOT a success. `PaneRestartResult` growing an
      // arm should be a compile error above; this is the runtime belt for a shape the compiler
      // never sees, and it fails closed like every other gate on this path.
      return "spawn-failed";
    }
  }
}

/**
 * Bring `agentId` back and WAIT until it is genuinely up, reporting what actually happened.
 *
 * Same two routes as {@link mountAgent}, and one gate in front of them.
 *
 * ── THE LIVENESS RE-CHECK, AND WHY IT IS NOT PARANOIA ────────────────────────────────────────
 * A sweep decides "this agent is dead", then does real awaited work before it gets here — the epic
 * sweep awaits a `bd label` write, which shells out to a store that is single-writer and shared by
 * every worktree in the repo, so it can queue for tens of seconds. An orchestrator that came back
 * on its own inside that window is ALIVE and quite possibly mid-turn, and `restartPane` would tear
 * its PTY down underneath it — destroying real work to "recover" an agent that had already
 * recovered. The decision that got us here is stale by construction; this asks again at the last
 * instant before the irreversible step.
 *
 * `already-live` is then the honest answer: nothing was restarted, and the caller must not claim
 * one — but the agent IS up, so the work the caller wanted to hand over can still be delivered.
 * That is why {@link mountedAwaited} passes it.
 *
 * `already-live` is returned when liveness is UNOBSERVED as well as when it is observed alive — see
 * the polarity note at the check itself.
 *
 * `isLive` is INJECTED for the same reason `hasRow` is: the caller has already gated on aliveness
 * to decide this agent needed reviving at all, and two copies of that predicate could answer
 * differently — which would make the pairing that matters in production untested by construction.
 */
export async function mountAgentAwaited(
  agentId: string,
  hasRow: (id: string) => boolean,
  isLive: (id: string) => boolean | undefined,
  opts: { readyTimeoutMs?: number; pollMs?: number } = {},
): Promise<AwaitedMountResult> {
  // POLARITY MATCHES THE CALLER'S OWN GATE, and it is `!== false` rather than `=== true` for the
  // reason `epicSweepRunner.candidateFor` states where it makes the same test: "a wrong 'alive'
  // costs one skipped tick, a wrong 'dead' spawns a rival". `undefined` means UNOBSERVED, not dead —
  // an agent the user closed reads that way — so treating it as dead here would tear down a PTY on
  // the strength of a reading nobody took. A skipped tick is recoverable; a killed mid-turn
  // orchestrator is not. Asking the question the other way round would also silently disagree with
  // the gate that decided this agent needed reviving, which is the thing injecting `isLive` exists
  // to prevent.
  if (isLive(agentId) !== false) return "already-live";

  // ── ONE DEADLINE FOR BOTH PHASES ────────────────────────────────────────────────────────────
  // Computed BEFORE anything is triggered, and shared by the lever wait below and route 2's mount
  // wait. Giving each phase its own `readyTimeoutMs` would let this block for TWICE what the caller
  // asked for — `paneControl.restartPaneAwaited` calls out that exact hazard as the reason it
  // budgets its own two phases together, and an earlier cut of this function reintroduced it by
  // starting a fresh clock after the lever had already burned its full budget.
  //
  // It is reachable, not theoretical: `restartPaneAwaited` returns `no-pane` LATE when the pane
  // unmounts mid-restart, having spent nearly everything. The sweep passes no timeouts, so that was
  // 60s + 60s inside one serialized tick.
  const budget = opts.readyTimeoutMs ?? MOUNT_TIMEOUT_MS;
  const deadline = Date.now() + budget;
  const pollMs = opts.pollMs ?? MOUNT_POLL_MS;
  // PHASE 1 GETS THE BUDGET LESS THE FLOOR — see MOUNT_MIN_ROUTE2_MS. Not the whole remaining
  // budget: a phase 1 that spends everything leaves route 2 writing permanent state it cannot then
  // observe, which is the silent side-effecting failure that reservation exists to prevent.
  const verdict = await restartPaneAwaited(agentId, {
    readyTimeoutMs: Math.max(0, budget - Math.min(MOUNT_MIN_ROUTE2_MS, budget / 2)),
    pollMs,
  });
  // ROUTE 1 concluded — the pane existed and reported something, good or bad.
  if (verdict !== "no-pane") return fromPaneVerdict(verdict);
  // ROUTE 2: no pane is mounted for this id in this window. Same precondition and same two writes
  // as the synchronous path — see `mountAgent` for why both, and why the check comes first.
  if (!hasRow(agentId)) return "no-agent-row";
  // …and REFUSE on an exhausted budget for the same reason, BEFORE writing anything. The floor
  // reserved above makes this unreachable in normal operation; it is the belt for a caller passing a
  // zero or negative timeout, and it keeps the discipline `no-agent-row` sets — never make a
  // permanent write for a mount this call cannot stay around to observe.
  if (Date.now() >= deadline) return "timed-out";
  admitAgent(agentId);
  useRuntimeStore.getState().open(agentId);

  // ── WAIT FOR THE PANE TO ACTUALLY APPEAR ────────────────────────────────────────────────────
  // These two writes only ARRANGE a mount: `Workspace` performs it on its next render pass, so for
  // some time afterwards no pane exists for this id and `paneState` reads `"unmounted"`.
  //
  // Returning immediately made `opened` a promise the caller could not use. A caller that then
  // writes to the agent hits a pane that is not merely un-ready but ABSENT, and
  // `conciergeDispatch`'s hold decides on `paneState(id) === "starting"` — so an absent pane does
  // not queue, it is refused outright as `pty-gone`. The delivery therefore failed on exactly the
  // route where the caller had most reason to expect the queue to catch it, after an irreversible
  // budget had already been spent.
  //
  // So route 2 waits for the pane to REGISTER — any state but `unmounted` — and only then reports
  // `opened`. `starting` is the expected arrival (the PTY is coming up, which is what the hold
  // queue is for); `failed`/`ready` are also real registrations and are left to the caller's own
  // reading. Bounded by the SAME budget as route 1, so this cannot block longer than the caller
  // asked for, and a pane that never appears is reported as the timeout it is rather than as a
  // successful mount.
  // Reuses the SAME `deadline` computed above — see the note there. Whatever route 1 spent is
  // already gone from this budget, so the two phases together cannot exceed what was asked for.
  for (;;) {
    if (paneState(agentId) !== "unmounted") return "opened";
    if (Date.now() >= deadline) return "timed-out";
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
