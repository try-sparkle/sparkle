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
  decideFleetReport,
  emptyFleetMemory,
  emptyPartnerMemory,
  emptyObserveState,
  evaluateFleetConditions,
  evaluateTriggers,
  expireClearedTriggers,
  fleetObservationMemory,
  isQuotaWalled,
  observeFleet,
  type FleetMemory,
  type FleetSnapshot,
  type ObserveState,
  type PartnerMemory,
  type PartnerSnapshot,
  recordSend,
  type BudgetState,
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
  snapshots(): Array<PartnerSnapshot & FleetSnapshot & { projectId: string }>;
  /** Batched — ONE call for the whole fleet, not one per partner. */
  inboxUsage(agentIds: string[]): Promise<Map<string, number>>;
  /** Deliver a challenge. Returns whether it actually landed. */
  send(agentId: string, text: string): Promise<boolean>;
  /**
   * Who receives the batched fleet report — the conditions no PARTNER can act on.
   *
   * `undefined` means there is nobody to report to in this window, so nothing is SENT — though the
   * conditions are still observed, so the report is not late when a recipient appears. That is the
   * honest default rather than falling back to some agent: the three fleet conditions are, by
   * construction, the ones whose subjects cannot act on them (`pusherFleet`), so delivering the
   * report to an arbitrary partner would be worse than not sending it at all.
   */
  reportRecipient(projectId: string): string | undefined;
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
  /**
   * Set on the batched fleet report, so the hit-rate log can tell it apart from a per-partner
   * challenge. `agentId` on those lines is the RECIPIENT, not a subject of the report.
   */
  scope?: "fleet";
}

/** Everything the sweep remembers between cycles. */
export interface PusherState {
  observe: ObserveState;
  partners: Map<string, PartnerMemory>;
  /**
   * projectId → the report channel's own memory for that project (its own budget, its own
   * cooldowns).
   *
   * PER PROJECT, not fleet-wide (roborev 56908). The per-partner loop is careful that "the ownership
   * election can run per project exactly as the goal sweep does, rather than being decided once for
   * the whole fleet"; a single global report would undo that in three ways at once — it would quote
   * one project's agent labels and escalation reasons to another project's recipient, and its
   * cooldown would let one project's long-standing quota wall suppress another project's brand-new
   * one.
   */
  fleet: Map<string, FleetMemory>;
}

export function emptyPusherState(): PusherState {
  return { observe: emptyObserveState(), partners: new Map(), fleet: new Map() };
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

  // Grouped per project, so each project's report is composed from — and delivered to — its own
  // people. `byProject` also fixes the iteration order of the report passes below.
  const byProject = new Map<string, typeof owned>();
  for (const s of owned) {
    const list = byProject.get(s.projectId);
    if (list === undefined) byProject.set(s.projectId, [s]);
    else list.push(s);
  }

  const recipients = new Map<string, string>();
  for (const projectId of byProject.keys()) {
    const r = deps.reportRecipient(projectId);
    if (r !== undefined) recipients.set(projectId, r);
  }

  // Batched, once. `inbox_status` takes `agentIds: Vec<String>`, so the whole fleet costs one call.
  // Every project's recipient rides along in the SAME call rather than costing one each.
  let usage = new Map<string, number>();
  try {
    const ids = [...new Set([...owned.map((s) => s.agentId), ...recipients.values()])];
    usage = await deps.inboxUsage(ids);
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

    // A QUOTA-WALLED PARTNER IS NOT CHALLENGED, and this is a correctness rule rather than a
    // courtesy. It cannot execute anything until a wall-clock time, so the message is not merely
    // unread — it is unreadable, and it consumes one of the `MAX_PER_AGENT` slots the concierge may
    // need to reach the same builder once the wall comes down. The condition is reported to the
    // recipient instead, by the fleet pass below, where somebody can actually act on it.
    //
    // Note which trigger this suppresses in practice: a walled agent is exactly the agent whose goal
    // quietly expires while it cannot run, so without this the Pusher's highest-value trigger fires
    // hardest at the one partner guaranteed not to hear it.
    // THE SIGHTING IS STILL RECORDED. Suppressing the send must not suppress the observation, or a
    // wall lasting days leaves the partner's `lastTriggers` frozen and the two-observation rule
    // restarts from stale state the moment it comes down — rule 1 in `pusherDecide`'s header, which
    // fails silently and looks exactly like a healthy partner.
    if (isQuotaWalled(s, now)) {
      const memory = partners.get(s.agentId) ?? emptyPartnerMemory();
      const seen = evaluateTriggers(observation);
      partners.set(s.agentId, {
        ...memory,
        lastTriggers: seen,
        // The cooldowns are expired here too, exactly as `decidePusherAction` does unconditionally
        // (roborev 56908). A wall lasts many sweeps, and a NON-latching trigger — unpushed work, an
        // unanswered question — can clear and return inside one. Without this its stale stamp
        // survives the wall, and the partner is `repeat-suppressed` on release for what is a
        // genuinely new episode.
        lastChallengedAt: expireClearedTriggers(memory.lastChallengedAt, seen.map((t) => t.id)),
      });
      deps.record({ at: now, agentId: s.agentId, outcome: "refused", reason: "quota-blocked" });
      continue;
    }

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

  // ONE REPORT PER PROJECT, each with its own memory. Sequential rather than concurrent: each send
  // is one inbox write, and running them in parallel would buy nothing while making the log order
  // depend on transport latency.
  const fleet = new Map(state.fleet);
  for (const [projectId, list] of byProject) {
    fleet.set(
      projectId,
      await reportFleet(
        deps,
        list,
        recipients.get(projectId),
        usage,
        fleet.get(projectId) ?? emptyFleetMemory(),
        now,
        // The WHOLE roster, not just this project's slice: `reportRecipient(projectId)` is not
        // required to name an agent inside that project, and the wall check must still find it
        // (roborev 56973).
        owned,
        partners,
      ),
    );
  }
  // NOT PRUNED, unlike `partners` above — the two keys are not analogous (roborev 56973). An agent
  // id that leaves the roster never comes back; a projectId does, after any sweep where that project
  // contributed zero owned snapshots (a partial store read, a transient `ownsProject` flip, all its
  // agents momentarily filtered). Deleting its memory there would reset the budget and every
  // cooldown, so a condition reported minutes earlier is re-reported at zero cost on return. The
  // growth argument for pruning does not apply either: projectIds are bounded by the number of
  // projects, not by session length.

  return { observe, partners, fleet };
}

/**
 * The batched report — the three conditions no partner can act on, delivered once to the recipient.
 *
 * Runs AFTER the per-partner loop and shares its already-batched `inbox_status` read, so the whole
 * feature costs the sweep no additional IPC. The same delivery discipline applies as above: the
 * report's own budget is spent only against a confirmed send.
 */
async function reportFleet(
  deps: PusherRunnerDeps,
  owned: readonly (FleetSnapshot & { projectId: string })[],
  recipient: string | undefined,
  usage: ReadonlyMap<string, number>,
  memory: FleetMemory,
  now: number,
  everyone: readonly (FleetSnapshot & { projectId: string })[],
  partners: Map<string, PartnerMemory>,
): Promise<FleetMemory> {
  // NO RECIPIENT, NO REPORT — BUT THE SIGHTING STILL ADVANCES. This is rule 1 from `pusherDecide`'s
  // header applied to the report channel, and it is easy to get backwards: returning `memory`
  // untouched looks like the conservative choice, and it means a window that later acquires a
  // recipient needs two MORE sweeps before it can say anything. The two-observation rule is about
  // whether the CONDITION is real, not about whether anyone was listening while it was measured.
  //
  // The budget does not advance, because nothing was sent — but the cooldowns DO expire, which is
  // why this goes through `fleetObservationMemory` rather than spreading `lastConditions` by hand.
  if (recipient === undefined) {
    return fleetObservationMemory(memory, evaluateFleetConditions(owned, now));
  }

  // A QUOTA-WALLED RECIPIENT CANNOT READ THE REPORT EITHER, and the argument is verbatim the one the
  // per-partner loop makes (roborev 56908): the message is not merely unread, it is unreadable, and
  // it burns a `MAX_PER_AGENT` slot the concierge needs once the wall lifts. Refusing to send a
  // partner a challenge while happily posting a report to an equally walled recipient would be the
  // same mistake with the reasoning left behind.
  const walledRecipient = everyone.find((s) => s.agentId === recipient && isQuotaWalled(s, now));
  if (walledRecipient !== undefined) {
    deps.record({
      at: now,
      agentId: recipient,
      outcome: "refused",
      reason: "recipient-quota-blocked",
      scope: "fleet",
    });
    return fleetObservationMemory(memory, evaluateFleetConditions(owned, now));
  }

  const used = usage.get(recipient);
  const inbox: InboxReading =
    used === undefined
      ? { used: INBOX_CAPACITY, capacity: INBOX_CAPACITY }
      : { used, capacity: INBOX_CAPACITY };

  // ONE CONTAINMENT FOR AN AGENT THAT IS BOTH (roborev 56908, then 56973). `FleetMemory.budget` is
  // deliberately separate from `PartnerMemory.budget`, so a recipient that is also a partner would
  // otherwise receive `MESSAGES_PER_HOUR` challenges AND `MESSAGES_PER_HOUR` reports in one hour —
  // the gate header calls that budget "the containment", and for exactly that agent it doubled.
  //
  // The first fix muted its per-partner channel instead, and that was BROADER THAN THE DEFECT: the
  // report only ever covers the three fleet conditions, so `goal-expired`, `unpushed-commits` and
  // `unanswered-question` for that agent became unreachable by any channel — "sat stuck and nobody
  // said anything", guaranteed for one agent per project. Sharing the budget keeps both channels
  // open and still bounds the total.
  const partnerMemory = partners.get(recipient);
  const shared: BudgetState =
    partnerMemory === undefined
      ? memory.budget
      : { sentAt: [...memory.budget.sentAt, ...partnerMemory.budget.sentAt] };

  const decision = decideFleetReport({
    policy: deps.policy(),
    snapshots: owned,
    memory: { ...memory, budget: shared },
    inbox,
    now,
  });

  // The merged view is for the DECISION only; what is stored is this channel's own budget, or the
  // partner's sends would be double-counted against it forever.
  const own = (m: FleetMemory): FleetMemory => ({ ...m, budget: memory.budget });

  if (decision.action === "quiet") {
    deps.record({
      at: now,
      agentId: recipient,
      outcome: "refused",
      reason: decision.reason,
      scope: "fleet",
    });
    return own(decision.memory);
  }

  let delivered = false;
  try {
    delivered = await deps.send(recipient, decision.text);
  } catch (e) {
    log.warn("pusher", "fleet report send threw", { error: String(e) });
  }

  if (delivered) {
    deps.record({
      at: now,
      agentId: recipient,
      outcome: "sent",
      triggerId: decision.conditionIds.join("+"),
      cited: decision.cited,
      scope: "fleet",
    });
    // Recorded against BOTH ledgers when they coincide, so the shared bound is symmetric: the next
    // per-partner sweep sees this send too, not just the next report.
    if (partnerMemory !== undefined) {
      partners.set(recipient, { ...partnerMemory, budget: recordSend(partnerMemory.budget, now) });
    }
    return { ...decision.memoryOnDelivered, budget: recordSend(memory.budget, now) };
  }

  // Undelivered: keep the pre-send budget and stamps, but DO keep this sweep's sighting and the
  // expired cooldowns, exactly as the per-partner path does. A transport failure is not a reason to
  // forget what was observed — nor to strand the stamp of a condition that has since cleared.
  deps.record({
    at: now,
    agentId: recipient,
    outcome: "refused",
    reason: "transport-failed",
    scope: "fleet",
  });
  return own(decision.memoryOnFailure);
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
