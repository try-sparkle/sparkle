// THE PUSHER'S SWEEP — the only impure part of the design, and deliberately the thinnest.
//
// Every rule the Pusher is held to already lives in `@sparkle/core` and is tested as arithmetic:
// what is measurably true (`evaluateTriggers`), what has been true twice (`persistedTriggers`), what
// may be said (`gateChallenge`), and the order those run in (`decidePusherAction`). This file adds
// nothing to that. Its whole job is: gather a snapshot, call `decidePusherAction`, obey the answer.
//
// Keeping it that thin is the point. A sweep that made decisions of its own would be a second
// opinion about the same agent — the failure `fleetVerdict` names explicitly — and it would be the
// one part of the system not covered by pure tests.
//
// ── WHY A SIBLING OF `goalContinuationRunner` AND NOT PART OF IT ─────────────────────────────────
// That file is arranged around duplicate PTY writes ("the failure mode this whole file is arranged
// around"), and folding a second sender into it was argued for on exactly those grounds. It does
// not apply here: the goal runner writes to the **PTY** (irreversible, racing `SUBMIT_CR_DELAY_MS`)
// while this writes to the **inbox** (queued, drained at the Stop hook, `O_EXCL`-claimed). And the
// triggers are disjoint by construction — `decideContinuation` answers an expired goal with
// `{action:"none", reason:"goal-expired"}`, so every Pusher trigger sits in a gap it declines.
//
// One coordination check remains and it is the real half of that concern: an agent the goal runner
// has a send IN FLIGHT to is skipped, so the two never arrive in the same moment.
//
// ── ATTACH-AT-BIRTH NEEDS NO SPAWN HOOK ──────────────────────────────────────────────────────────
// A Pusher is not an agent row, so "attaching" is just this sweep covering every build agent from
// the moment it appears in the roster; the per-partner memory is created lazily on first sight.
// `buildAgentSpawn.ts` is untouched. A brand-new agent is protected twice over: `status === "new"`
// ("not briefed") is skipped outright, and the two-observation rule gives everything else a grace
// period of one full interval before anything can be said.

import {
  decidePusherAction,
  emptyPartnerMemory,
  emptyObserveState,
  observeFleet,
  type ObserveState,
  type PartnerMemory,
  type PartnerSnapshot,
  type PusherPolicy,
  type InboxReading,
} from "@sparkle/core";
import { log } from "../logger";

/**
 * Inbox capacity, mirroring `MAX_PER_AGENT` in `src-tauri/src/inbox.rs`.
 *
 * Duplicated rather than plumbed through because `inbox_status` reports `pending` without the
 * denominator, and a wrong value here can only make the Pusher yield EARLIER than it should — the
 * safe direction. If the Rust constant ever falls below this, the gate simply becomes stricter.
 */
export const INBOX_CAPACITY = 50;

/** One cycle's worth of what the app can tell us, plus the effects it can perform. */
export interface PusherRunnerDeps {
  now(): number;
  policy(): PusherPolicy;
  /** Single-owner election, per project. Defaults to `ownsProjectInThisWindow`. */
  ownsProject(projectId: string): boolean;
  /**
   * Every build agent this window should sweep, already filtered and read from the stores.
   *
   * Returns `projectId` alongside so the ownership election can run per project exactly as the goal
   * sweep does, rather than being decided once for the whole fleet.
   */
  snapshots(): Array<PartnerSnapshot & { projectId: string }>;
  /** Batched — ONE call for the whole fleet, not one per partner. */
  inboxUsage(agentIds: string[]): Promise<Map<string, number>>;
  /** Deliver a challenge. Returns whether it actually landed. */
  send(agentId: string, text: string): Promise<boolean>;
  /** Structured record of every decision, sent or refused. */
  record(entry: PusherLogEntry): void;
}

/** One line of the hit-rate log. `sent` is the only outcome that spends budget. */
export interface PusherLogEntry {
  at: number;
  agentId: string;
  outcome: "sent" | "refused";
  triggerId?: string;
  /** The gate's refusal reason, or `no-trigger`. Absent on a send. */
  reason?: string;
  /** The measured numbers the delivered text cites. Absent on a refusal. */
  cited?: string[];
}

/** Everything the sweep remembers between cycles. */
export interface PusherState {
  observe: ObserveState;
  partners: Map<string, PartnerMemory>;
}

export function emptyPusherState(): PusherState {
  return { observe: emptyObserveState(), partners: new Map() };
}

/**
 * Run one sweep. Returns the next state; never mutates the one passed in.
 *
 * Ordering here matters in exactly two places, and both are about not spending something on
 * nothing:
 *
 *   • The inbox is read ONCE for the whole fleet, after the observations are built, because a
 *     partner with no persisted trigger cannot send regardless of its mailbox — reading per-partner
 *     would be one IPC call each to answer a question most of them do not reach.
 *   • `memoryOnDelivered` is applied only when `send` resolves true. A refused gate or a failed
 *     transport must not burn one of four hourly slots on a message nobody received.
 */
export async function sweepPushers(
  deps: PusherRunnerDeps,
  state: PusherState,
): Promise<PusherState> {
  const now = deps.now();
  const policy = deps.policy();

  // A disabled Pusher does no work at all — not even the roster walk. The gate would refuse every
  // challenge anyway, but doing the sweep to reach that answer would spend a store read and an IPC
  // call per interval, forever, on a feature the user switched off.
  if (!policy.enabled) return state;

  const owned = deps.snapshots().filter((s) => deps.ownsProject(s.projectId));
  if (owned.length === 0) return state;

  const { observations, next: observe } = observeFleet(owned, state.observe, now);

  // Batched, once. `inbox_status` takes `agentIds: Vec<String>`, so the whole fleet costs one call.
  let usage = new Map<string, number>();
  try {
    usage = await deps.inboxUsage(owned.map((s) => s.agentId));
  } catch (e) {
    // A failed read is NOT an empty mailbox. Leaving the map empty would make every partner look
    // like it had room; the gate's own `capacity > 0 ? … : 100` then reads an absent entry as full
    // and yields, which is the direction to fail in.
    log.warn("pusher", "inbox status read failed; yielding this cycle", { error: String(e) });
  }

  const partners = new Map(state.partners);

  for (const s of owned) {
    const observation = observations.get(s.agentId);
    if (!observation) continue;

    const used = usage.get(s.agentId);
    const inbox: InboxReading =
      used === undefined
        ? // Unknown occupancy reads as FULL, so the Pusher yields rather than talking over a
          // mailbox it could not see. `inbox.rs` refuses when full rather than evicting, so the
          // cost of guessing wrong in the other direction is the concierge losing its route to
          // this same builder.
          { used: INBOX_CAPACITY, capacity: INBOX_CAPACITY }
        : { used, capacity: INBOX_CAPACITY };

    const memory = partners.get(s.agentId) ?? emptyPartnerMemory();
    const decision = decidePusherAction({ policy, observation, memory, inbox, now });

    if (decision.action === "quiet") {
      partners.set(s.agentId, decision.memory);
      deps.record({ at: now, agentId: s.agentId, outcome: "refused", reason: decision.reason });
      continue;
    }

    // The send is awaited so the budget is spent against a CONFIRMED delivery. This is the one
    // place the sweep can outlast its own interval, which is why the caller guards re-entry.
    let delivered = false;
    try {
      delivered = await deps.send(s.agentId, decision.text);
    } catch (e) {
      log.warn("pusher", "challenge send threw", { agentId: s.agentId, error: String(e) });
    }

    if (delivered) {
      partners.set(s.agentId, decision.memoryOnDelivered);
      deps.record({
        at: now,
        agentId: s.agentId,
        outcome: "sent",
        triggerId: decision.triggerId,
        cited: decision.cited,
      });
    } else {
      // Not delivered: keep the pre-send memory so the budget is untouched, but DO record this
      // cycle's sighting — the two-observation rule needs it, and a transport failure is not a
      // reason to forget what we saw.
      partners.set(s.agentId, { ...memory, lastTriggers: decision.memoryOnDelivered.lastTriggers });
      deps.record({
        at: now,
        agentId: s.agentId,
        outcome: "refused",
        triggerId: decision.triggerId,
        reason: "transport-failed",
      });
    }
  }

  // Partners that left the roster are dropped, so the map cannot grow without bound across a long
  // session. `observeFleet` garbage-collects its clocks the same way, for the same reason.
  const live = new Set(owned.map((s) => s.agentId));
  for (const id of [...partners.keys()]) if (!live.has(id)) partners.delete(id);

  return { observe, partners };
}

let timer: ReturnType<typeof setInterval> | null = null;
let sweeping = false;
let state: PusherState = emptyPusherState();

/**
 * Start the sweep. Replaces any running one.
 *
 * NO IMMEDIATE TICK, matching `goalContinuationRunner`: the first thing a fresh sweep would do is
 * record every current condition as a first sighting, and the two-observation rule means nothing can
 * be said until the second one anyway. Firing at boot would only make the app do work during the
 * busiest moment of its lifecycle to reach a conclusion it cannot act on.
 */
export function startPusherRunner(deps: PusherRunnerDeps, intervalMs: number): () => void {
  stopPusherRunner();
  const tick = async () => {
    // A sweep awaits its sends, so a slow inbox write can outlast the interval. Overlapping ticks
    // would each read the pre-send budget and could double-spend it.
    if (sweeping) return;
    sweeping = true;
    try {
      state = await sweepPushers(deps, state);
    } catch (e) {
      log.warn("pusher", "sweep failed", { error: String(e) });
    } finally {
      sweeping = false;
    }
  };
  timer = setInterval(() => void tick(), intervalMs);
  return stopPusherRunner;
}

export function stopPusherRunner(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
}

/** Test/introspection helper: is the sweep armed? */
export function isPusherRunnerRunning(): boolean {
  return timer !== null;
}

/** Test seam: forget everything the sweep has learned. */
export function _resetPusherRunnerForTests(): void {
  state = emptyPusherState();
  sweeping = false;
}
