// busyLiveness — A "WORKING" PILL IS A CLAIM ABOUT NOW. `working` means "actively producing output"
// (packages/ui AGENT_STATUS), so a row still wearing it long after its process died is telling an
// orchestrator that a dead worker is a healthy, running one.
//
// THE REPORT (PR #2548 retro, bead sparkle-dlze6u). Spawned workers reported a healthy busy status
// on the orchestrator roster while having ZERO live processes — one for sixty-eight minutes. The
// orchestrator, reading the roster, trusts a dead worker as running: it neither reassigns its task
// nor recovers its branch, and (the other half of that bead, owned elsewhere) the teardown that
// eventually fires deletes the worktree's uncommitted work.
//
// WHY THE PILL COULD NOT RETRACT ITSELF — the SAME latch `engine/movementRetraction` is written
// around, one tier over. `components/AgentPane.tsx` is the ONLY writer of `runtimeStore.status`, so a
// status is live exactly while a pane is mounted for that agent; panes mount lazily, per project. For
// a worker this window is not hosting — or one whose PTY died without the status engine observing a
// clean exit — `working` is a FROZEN LAST READING with no writer that can ever retract it. Deriving
// the roster from it faithfully re-renders a fact that stopped being true an hour ago.
//
// THE SIGNAL, AND WHY IT IS NOT A NEW ONE. `fleet_digest` (src-tauri/src/fleet.rs) reads every
// agent's hook log straight off disk, `services/fleetWatch` polls it over `openAgentIdSet()` — the
// population that INCLUDES workers this window does not host — and publishes it as
// `runtimeStore.agentMovement`. That is the fleet's OWN liveness read (fleet.rs: reading artifacts is
// "how we learn who is alive"), collected for free on a timer, no agent turn and no process ping. So
// the reconciliation is a second reading of an artifact stream already being collected — exactly as
// `movementRetraction` is, and the mirror image of it: that module retracts a stale RED when the
// agent HAS moved; this one retracts a stale GREEN when the agent has demonstrably NOT.
//
// ── THE TWO WAYS THIS COULD HAVE BEEN WRONG, AND HOW EACH IS AVOIDED ──────────────────────────────
//
// 1. FALSELY KILLING A LIVE-BUT-QUIET AGENT. A genuinely-working agent between tool calls is quiet
//    for a while, and one long tool call (a full test suite, a Rust rebuild) is quiet for several
//    minutes with no intervening hook. So the bound is `STALE_AFTER_MS`, aliased to
//    `fleetVerdict.SILENT_AFTER_MS` — the app's ONE already-vetted "this long with no artifact of any
//    kind means not thinking" line, chosen there precisely because "the full test suite and a Rust
//    rebuild both fit inside it". A row is downgraded ONLY past that bound. It is also SELF-HEALING:
//    the moment the agent fires another hook, `agentMovement` refreshes and the next `get_state`
//    reads `working` again. The failure it can still make is a brief `stopped` blink for an agent on
//    a tool call longer than the bound — a momentary under-report, the same direction
//    `movementRetraction` fails in ("a lingering pill is the bug; a pill that never appears is a
//    worse one" — here, inverted: a false-busy is the bug being fixed, a brief false-stopped is the
//    cheaper error).
//
// 2. DECLARING DEATH ON NO EVIDENCE. `unobserved` (no artifact at all — a just-spawned worker whose
//    hook has not fired, or one this window's digest never covered) is NOT the same as `silent`
//    (`fleetVerdict`'s own distinction). Absent evidence means we cannot see the worker, never that
//    it is dead — so a MISSING or unusable movement timestamp NEVER downgrades. Only a POSITIVE
//    timestamp older than the bound does. This is what keeps the reconciliation from erasing a fresh
//    worker that has not yet written its first artifact.
//
// PURE — data in, data out, the clock arrives as a parameter, no store and no I/O — in the same
// family as `engine/movementRetraction.withMovementRetraction`, and composed onto the status map the
// same way (early, against the agents' OWN statuses, so a downgraded worker also stops bubbling a
// green dot into its orchestrator's roll-up).
import type { AgentTabStatus } from "@sparkle/ui";
import type { MovementEvidence } from "./movementRetraction";
import { SILENT_AFTER_MS } from "./fleetVerdict";

/**
 * The bound past which a `working` row with no fresher artifact is treated as a frozen last reading
 * rather than a live one. Aliased to `fleetVerdict.SILENT_AFTER_MS` on purpose: the app already has
 * ONE threshold for "this long with no artifact of any kind means the agent is not thinking", and a
 * second hand-picked number here would be one more thing to keep in sync (and to get wrong). See
 * header note 1 for why it is a bound and not zero.
 */
export const STALE_AFTER_MS = SILENT_AFTER_MS;

/**
 * Age (ms) of the freshest usable artifact instant in this movement snapshot, or `null` when there is
 * none to read.
 *
 * `null` is the honest "we cannot tell" and it NEVER downgrades a row (header note 2): an absent
 * `MovementEvidence`, a null/zero/non-finite timestamp, and a FUTURE timestamp (clock skew — treating
 * it as "just now" would keep a possibly-dead worker busy, which is the safe direction here) all
 * return `null`. A real, past `lastEventMs` returns its age.
 */
export function movementAgeMs(ev: MovementEvidence | undefined, now: number): number | null {
  if (ev === undefined) return null;
  const ts = ev.lastEventMs;
  if (ts === null || !Number.isFinite(ts) || ts <= 0) return null;
  if (ts > now) return null; // future timestamp is a broken clock, not evidence of life
  return now - ts;
}

/**
 * De-escalate every `working` row whose agent has demonstrably NOT moved for `staleAfterMs` — i.e. a
 * dead worker still wearing a healthy busy pill — down to `stopped`.
 *
 * Composed onto the status map like `engine/movementRetraction.withMovementRetraction`: returns the
 * SAME reference when nothing is reconciled (no render / no needless roster churn) and never mutates
 * the input. Only `working` is touched — it is the sole GREEN/"running" tier (packages/ui
 * AGENT_STATUS), and the only status the retro's "healthy busy" names; the red tiers (`waiting` /
 * `approval` / `blocked`) are someone waiting on the human, not a claim the process is producing
 * output, so they are out of scope and left alone.
 *
 * `stopped` (not `idle`) is the right landing: `idle` means "finished its turn, your move", which is
 * a false claim of a completed turn; `stopped` means "no live process", which is exactly what a dead
 * worker is. It is also the default the sidebar and `get_state` already use for a process-less agent,
 * so the reconciled row is indistinguishable from any other stopped one downstream.
 */
export function withBusyLivenessReconciliation<T extends { id: string }>(
  agents: readonly T[],
  statusMap: Record<string, AgentTabStatus>,
  movementOf: (id: string) => MovementEvidence | undefined,
  now: number,
  staleAfterMs: number = STALE_AFTER_MS,
): Record<string, AgentTabStatus> {
  let out: Record<string, AgentTabStatus> | null = null;
  const ensure = (): Record<string, AgentTabStatus> => (out ??= { ...statusMap });
  for (const a of agents) {
    if (statusMap[a.id] !== "working") continue;
    const age = movementAgeMs(movementOf(a.id), now);
    if (age === null) continue; // no positive evidence of staleness — cannot claim the worker is dead
    if (age < staleAfterMs) continue; // fresh artifact — genuinely working
    ensure()[a.id] = "stopped";
  }
  return out ?? statusMap;
}
