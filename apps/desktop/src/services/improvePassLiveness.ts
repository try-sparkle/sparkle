// THE PINNED "IMPROVE SPARKLE" ROW'S PROCESS-TRUTH STATUS WRITER — a THIRD writer for
// `runtimeStore.status["__sparkle_self__"]`, driven by the pass CHILD rather than by whichever JS
// happens to be mounted.
//
// WHY THE ROW WENT GRAY WHILE ITS AGENT WORKED. That key had exactly two producers, and BOTH can
// be absent while the headless pass keeps running:
//
//   1. a mounted `SparkleAgentPane` — its `onStatus` is the status engine, which `Terminal` DETACHES
//      and disposes on unmount ("DETACH, never kill"). The PTY keeps running; the key freezes at
//      whatever resting value it last held.
//   2. `services/improvementPass` — whose in-flight latch is MODULE state (see
//      `improvementPassLatch`'s header: it "must reset with the page"), while the Rust child
//      survives up to `STALE_PASS_MAX` (35 min). A webview reload mid-pass therefore leaves the
//      child working with no listener and no `setStatus` behind it.
//
// With neither producer live, `AgentSidebar`'s `effectiveStatus[id] ?? "stopped"` renders GRAY and
// nothing can retract it. The status overlays can't help — they rewrite only ids they find in
// `project.agents`, and `__sparkle_self__` is deliberately never in that array — and `grayFloorFor`
// can't either (the pinned row sits outside every stage group, and amber is its only output).
//
// WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT:
//
//   • It POLLS the process (`sparkle_improve_active`), it does not subscribe. A lost event is the
//     exact hole case (2) above IS; re-emitting one would rebuild it.
//   • It is a FLOOR THAT RAISES, not a second status derivation. It only ever moves the row off a
//     RESTING status, and it releases on the falling edge back to the value it displaced — so when
//     no child is alive the existing producers' resting status wins, unchanged. The row keeps its
//     ONE derivation in `AgentSidebar` (which both that file and `SparkleAgentRow` forbid
//     duplicating at length — a private derivation is how this row once rendered GREEN while
//     sitting on an unanswered picker); this writes the same map every other producer writes.
//   • It RETRACTS ONLY WHAT IT WROTE, and it decides that by WRITE GENERATION, never by
//     `openAgentIds`. Two rejected designs are worth recording, because both look right and both
//     ship a broken row:
//
//       — "stand down while the pane is open" makes the writer PERMANENTLY INERT. Nothing ever
//         removes `__sparkle_self__` from `openAgentIds`: there is no `close(sparkleAgentId)`
//         anywhere, the set is persisted across relaunch, and `sparkleOpenSetWhitelist`
//         re-whitelists the main window's own id on every boot reconcile. Any user who has ever
//         opened (or warm-launched) the pane would get a writer that never runs again.
//       — "raise always, but veto the RETRACTION on the same flag" is worse: the row is then pinned
//         at `working` with no producer behind it, and that key is NOT display-only. The scheduler
//         feeds it to `notePaneStatus`/`passHoldReason`, where `working` holds the hourly slot and
//         after `PANE_BUSY_HOLD_LIMIT_MS` becomes `pane-wedged` — the improvement duty disabled
//         permanently, telling the user to restart a pane that was never the cause.
//
//     So the falling edge retracts whenever the value is still the `working` WE put there and no
//     other write to this key has landed since. `current !== "working"` alone CANNOT answer the
//     second half: `setStatus` bails out on an identical value and zustand then fires no listener at
//     all, so a producer re-asserting `working` over our `working` leaves the map byte-identical and
//     is invisible to any reader downstream of the store — a subscription included. That is why the
//     count is taken from `statusWriteCount`, which the store increments on the CALL, before its own
//     bail-out can discard it. The pane's status engine reporting `working` on construction is
//     precisely that shape, and it is the window the retraction has to survive.
//   • It FAILS TOWARD THE CURRENT BEHAVIOUR. An invoke that throws writes nothing.
import { invoke } from "@tauri-apps/api/core";
import type { AgentTabStatus } from "../types";
import { statusWriteCount, useRuntimeStore } from "../stores/runtimeStore";
import { SPARKLE_AGENT_ID } from "./sparkleAgent";

/** Wire shape of the `sparkle_improve_active` command (`ImproveLiveness` in `sparkle_improve.rs`).
 *
 *  ⚠️ `elapsedMs` is `number | null`, NOT `number | undefined`. It is backed by a Rust
 *  `Option<u64>` with no `skip_serializing_if`, so the key is ALWAYS PRESENT and carries `null`
 *  when the slot is empty — a type written as `elapsedMs?: number` would describe a shape the wire
 *  cannot produce (AGENTS.md). Both spellings are accepted here so neither side can silently
 *  discard the payload. */
export type ImprovePassLiveness = {
  active: boolean;
  elapsedMs?: number | null;
};

/** How often to ask the process. Cheap (one mutex read, no child touched) and deliberately much
 *  finer-grained than the hourly scheduler's own `IMPROVEMENT_TICK_MS` — five minutes of a gray dot
 *  on a working agent is the symptom, not the fix. */
export const LIVENESS_POLL_MS = 10_000;

/** The statuses this writer may raise FROM: the ones that mean "no turn is running". Anything else
 *  — `working`, and every attention tier (`waiting`/`approval`/`blocked`/`errored`/`questions`) — is
 *  a live producer's word about this agent and is never overwritten, so a pass that reports its own
 *  richer state mid-flight keeps it. `undefined` (no producer has ever written) counts as resting. */
const RESTING: ReadonlySet<AgentTabStatus> = new Set<AgentTabStatus>([
  "stopped",
  "idle",
  "done",
  "new",
]);

/** The resting value this writer displaced when it raised the row, or `null` when it holds nothing.
 *  Set ONLY when a raise actually performed the write, so we can never retract a value that was
 *  somebody else's to begin with. Module state, and losing it on a page reload is CORRECT: the
 *  reload is precisely when the row must be re-raised from scratch, and `runtimeStore.status` is
 *  live-only (never persisted) so the value a re-raise captures is the post-reload resting one. */
let held: AgentTabStatus | null = null;

/** `statusWriteCount(SPARKLE_AGENT_ID)` immediately after our own raise write. A different value on
 *  the falling edge means somebody has written this key since — including a re-assert of the same
 *  value, which is the case a value comparison structurally cannot see. See the header. */
let heldGeneration = 0;

/** Drop any hold WITHOUT writing. For the scheduler's unmount, and for test isolation. */
export function resetImprovePassLiveness(): void {
  held = null;
  heldGeneration = 0;
}

/** Apply one liveness reading to the row's status. Not exported: the production path is
 *  {@link pollImprovePassLiveness}, and a second exported entry point is a seam every test would
 *  inject, leaving the real call site covered by nothing (the `sparkle-lgbwf` shape). */
function applyLiveness(active: boolean): void {
  const rt = useRuntimeStore.getState();
  const current = rt.status[SPARKLE_AGENT_ID];
  if (active) {
    // Raise only FROM a resting value, so a live producer's word — `working`, or any attention tier
    // — is never overwritten. Re-raising on a later poll is deliberate: a row that falls back to
    // gray while the child is still alive is the whole defect.
    if (current !== undefined && !RESTING.has(current)) return;
    if (held === null) held = current ?? "stopped";
    rt.setStatus(SPARKLE_AGENT_ID, "working");
    heldGeneration = statusWriteCount(SPARKLE_AGENT_ID);
    return;
  }
  if (held === null) return;
  const restore = held;
  held = null;
  // Retract only what is still OURS — see the header. Either test failing means a producer owns the
  // row now, and its word outranks a remembered one.
  if (current !== "working" || statusWriteCount(SPARKLE_AGENT_ID) !== heldGeneration) return;
  rt.setStatus(SPARKLE_AGENT_ID, restore);
}

/** Take ONE process reading and mirror it onto the pinned row. Safe to call on a timer; never
 *  throws. */
export async function pollImprovePassLiveness(): Promise<void> {
  let live: ImprovePassLiveness;
  try {
    live = await invoke<ImprovePassLiveness>("sparkle_improve_active");
  } catch {
    // No reading taken — leave the row exactly as the existing producers left it.
    return;
  }
  applyLiveness(live?.active === true);
}
