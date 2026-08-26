// portBroker — the ONE module that talks to the Rust port broker (bead `.5`).
//
// Two primitives, and the split is the whole design (see `port_broker.rs`'s header):
//   * a PORT LEASE for a port that can move — every agent is handed a different number, so two
//     agents verifying at once never reach for the same one;
//   * a GATE LOCK for a port (or any resource) that cannot — Sparkle's own dev server is 1420 with
//     `strictPort: true`, so there is no second port to hand out and the only question is who has
//     it. A refusal NAMES the holder, because "the port is in use" tells someone running eight
//     agents nothing at all.
//
// Every `invoke` lives here, for the same reason `services/verifyGate` keeps its own: a component
// that invokes directly cannot be rendered in jsdom without a bridge mock, so the tests that would
// catch a regression stop being written.
//
// THE COMMAND NAMES AND PAYLOAD SHAPES ARE A FROZEN CONTRACT with `port_broker.rs`. Note every
// nullable field below is written `T | null`, never `T?`: a Rust `Option` crosses serde's wire as an
// explicit `null`, never as an absent key, so `field?: T` describes a shape the wire cannot produce.
import { invoke } from "@tauri-apps/api/core";

/** One held port. Mirrors `port_broker::PortLease`. */
export interface PortLease {
  port: number;
  agentId: string;
  /** What the port is for — `"preview"`, a harness. Part of a lease's identity. */
  kind: string;
  pid: number;
  acquiredAtMs: number;
  heartbeatAtMs: number;
}

/** One held gate lock. Mirrors `port_broker::GateLock`. */
export interface GateLock {
  name: string;
  agentId: string;
  pid: number;
  acquiredAtMs: number;
  /** The TTL the HOLDER took it under — expiry is judged by their terms, not the reader's. */
  ttlSecs: number;
}

/** A lease plus what the machine says about it right now. */
export interface LeaseView extends PortLease {
  /** Heartbeat older than the TTL. NOT the same as reclaimable — see `bound`. */
  expired: boolean;
  /** Something is listening right now. Expired AND bound is a live holder, never reclaimed. */
  bound: boolean;
}

export interface GateLockView extends GateLock {
  expired: boolean;
}

export type GateState = "acquired" | "reentered" | "reclaimed" | "refused";

export interface GateLockOutcome {
  /** True for taken / re-entered / reclaimed. */
  acquired: boolean;
  state: GateState;
  /** The record in force afterwards — OURS when we took it, the HOLDER'S when we were refused. */
  lock: GateLock;
  reclaimedFrom: string | null;
  /** Empty unless refused. Names the holder, its pid and how long it has had the lock. */
  message: string;
}

export type ReleaseState = "released" | "not-held" | "held-by-other";

export interface ReleaseOutcome {
  outcome: ReleaseState;
  /** Set only for `held-by-other` — the agent whose record was left alone. */
  holder: string | null;
}

export interface BrokerStatus {
  registry: string;
  enabled: boolean;
  rangeStart: number;
  rangeEnd: number;
  leaseTtlSecs: number;
  heartbeatSecs: number;
  leases: LeaseView[];
  gateLocks: GateLockView[];
}

/** Take a port for this agent. Re-entrant: asking twice returns the port already held. */
export function acquirePort(
  projectRoot: string,
  agentId: string,
  kind = "preview",
): Promise<PortLease> {
  return invoke<PortLease>("port_broker_acquire", { projectRoot, agentId, kind });
}

/**
 * Heartbeat one lease.
 *
 * REJECTS when the lease is gone or is somebody else's, rather than silently re-acquiring. A holder
 * that has lost its port must find out — otherwise it goes on believing it owns one another agent
 * is already using, which is the collision the broker exists to prevent, arrived at the long way.
 */
export function renewPort(projectRoot: string, port: number, agentId: string): Promise<PortLease> {
  return invoke<PortLease>("port_broker_renew", { projectRoot, port, agentId });
}

/** Give a port back. Idempotent, and it never removes another agent's lease. */
export function releasePort(
  projectRoot: string,
  port: number,
  agentId: string,
): Promise<ReleaseOutcome> {
  return invoke<ReleaseOutcome>("port_broker_release", { projectRoot, port, agentId });
}

export function brokerStatus(projectRoot: string): Promise<BrokerStatus> {
  return invoke<BrokerStatus>("port_broker_status", { projectRoot });
}

/**
 * Take a named gate lock.
 *
 * DOES NOT REJECT ON REFUSAL. A refusal is an ANSWER — it carries the holder, which is the one
 * thing the caller needs in order to say anything useful — and turning it into a thrown error
 * would collapse it into "something went wrong" and throw that away. Read `acquired`.
 */
export function acquireGateLock(
  projectRoot: string,
  name: string,
  agentId: string,
  ttlSecs?: number,
): Promise<GateLockOutcome> {
  return invoke<GateLockOutcome>("gate_lock_acquire", {
    projectRoot,
    name,
    agentId,
    ttlSecs: ttlSecs ?? null,
  });
}

export function releaseGateLock(
  projectRoot: string,
  name: string,
  agentId: string,
): Promise<ReleaseOutcome> {
  return invoke<ReleaseOutcome>("gate_lock_release", { projectRoot, name, agentId });
}

/** Read gate locks — one by `name`, or all of them when `name` is omitted. */
export function gateLockStatus(projectRoot: string, name?: string): Promise<GateLockView[]> {
  return invoke<GateLockView[]>("gate_lock_status", { projectRoot, name: name ?? null });
}

/** The gate-lock name a PINNED port is serialized under. Mirrors `port_broker::pinned_gate_name`. */
export function pinnedGateName(port: number): string {
  return `port-${port}`;
}

/** Sparkle's own dev port gate. Mirrors `port_broker::SPARKLE_DEV_GATE`. */
export const SPARKLE_DEV_GATE = "-1420";

/**
 * Run `body` while holding a named gate lock, and give the lock back whichever way `body` ends.
 *
 * The reason this exists rather than each caller pairing its own acquire/release: the release has to
 * happen on the THROW path too, and a caller that forgets wedges a PINNED resource — which by
 * construction has no alternative for anyone else to move to — until the TTL runs out. A `finally`
 * written once is the difference between a lock and a leak.
 *
 * Returns `null` without running `body` when the lock is refused; `onRefused` receives the outcome
 * so a caller can show WHO has it. A refusal is not an exception — it is the ordinary answer when
 * somebody else is using a singleton.
 */
export async function withGateLock<T>(
  projectRoot: string,
  name: string,
  agentId: string,
  body: () => Promise<T>,
  opts: { ttlSecs?: number; onRefused?: (outcome: GateLockOutcome) => void } = {},
): Promise<T | null> {
  const outcome = await acquireGateLock(projectRoot, name, agentId, opts.ttlSecs);
  if (!outcome.acquired) {
    opts.onRefused?.(outcome);
    return null;
  }
  try {
    return await body();
  } finally {
    await releaseGateLock(projectRoot, name, agentId).catch(() => {
      // A failed release is not worth failing the caller's work over: the TTL clears it either way,
      // and re-throwing here would replace `body`'s real result (or its real error) with a cleanup
      // detail nobody can act on.
    });
  }
}

/**
 * The leases whose port nothing is listening on — a LEAK, not a collision.
 *
 * `expired` and `bound` are separate columns for exactly this reason, and reading either alone gets
 * it wrong in a different direction: expired-and-bound is a live-but-quiet holder that must never be
 * disturbed, expired-and-unbound is an agent that went away without releasing.
 */
export function leakedLeases(status: BrokerStatus): LeaseView[] {
  return status.leases.filter((l) => l.expired && !l.bound);
}
