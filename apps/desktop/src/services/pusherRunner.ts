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
// ── MOUNTED 2026-08-04, AND SAYING SO HERE IS THE POINT (was roborev 57400) ─────────────────────
// `startPusherRunner` had no production caller for the whole of its life: the only thing that ever
// invoked it was `pusherRunner.test.ts`, so every condition below was computed, tested and never
// delivered. That is recorded rather than deleted because the gap was reported three times from
// three different layers, each time because a comment described wiring that did not exist — and the
// inverse lie is just as expensive, so this paragraph turns over the moment the wiring lands.
//
// It has landed. `services/pusherMount.ts` builds these deps from the live stores and `App.tsx`
// mounts it beside `GoalContinuation`. `duties()` is bound; `reportRecipient` names the concierge;
// `send` writes to the inbox and READS IT BACK before reporting success. `passHoldReason` is the one
// input still unbound, so `duty-overdue` fires on the arithmetic without naming which arm holds the
// hourly pass — a less useful sentence, never a wrong one.
//
// ── ATTACH-AT-BIRTH NEEDS NO SPAWN HOOK ──────────────────────────────────────────────────────────
// A Pusher is not an agent row, so "attaching" is just this sweep covering every build agent from
// the moment it appears in the roster; the per-partner memory is created lazily on first sight.
// `buildAgentSpawn.ts` is untouched. A brand-new agent is protected twice over: `status === "new"`
// ("not briefed") is skipped outright, and the two-observation rule gives everything else a grace
// period of one full interval before anything can be said.

import {
  claimsForConditions,
  claimsForTriggers,
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
  pruneRefutedFleetEvidence,
  pruneRefutedObservation,
  type ClaimVerdicts,
  type ConflictingPr,
  type PusherClaim,
  type FleetMemory,
  type FleetSnapshot,
  type StandingDuty,
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
   * honest default rather than falling back to some agent: the fleet conditions are, by
   * construction, the ones whose subjects cannot act on them (`pusherFleet`), so delivering the
   * report to an arbitrary partner would be worse than not sending it at all.
   */
  reportRecipient(projectId: string): string | undefined;
  /**
   * The app's standing recurring duties — the hourly improvement pass, and whatever acquires a
   * cadence later. Read per sweep so a duty that starts or stops is picked up without a restart.
   */
  duties(): readonly StandingDuty[];
  /**
   * Open PRs that cannot merge, for the `pr-conflicting` condition — or `undefined` for WE DID NOT
   * LOOK.
   *
   * SYNCHRONOUS, exactly like `snapshots()`: it reads a store that a listener and a poller keep
   * current, so the sweep is not made to await another IPC round-trip it would then have to bound.
   * `inboxUsage` is the only awaited input and it stays that way.
   *
   * The `undefined` arm is the fail-closed one and it is not decorative: before the conflict probe
   * has ever answered — which includes an older backend with no such command at all — there is no
   * evidence, and an empty list would say "we checked, every PR is fine".
   */
  conflicts(): readonly ConflictingPr[] | undefined;
  /**
   * RE-READ these facts NOW, at the moment we are about to speak about them.
   *
   * ── WHY THIS IS THE ONE PLACE THE SWEEP AWAITS TWICE ────────────────────────────────────────────
   * Every other input above is a store read, deliberately synchronous, because the sweep runs on a
   * one-minute tick and must not queue behind IPC. This one is different in kind: `conflicts()` reads
   * a store a poller refreshes every TEN minutes, `hasUnlandedWork` comes from a branch poll keyed on
   * the DISPLAYED project, and an escalation is latched and never clears itself — while the report's
   * own cooldown is FOUR HOURS. So the gap between measuring and speaking is measured in hours, and
   * the sentences are written in the present tense. Two merged PRs, an escalated goal that was
   * already met, and two "safe to retire" claims about agents mid-merge all shipped through that gap
   * on one afternoon.
   *
   * ── IT IS CALLED ONLY ON THE SEND PATH ─────────────────────────────────────────────────────────
   * A sweep that has nothing to say verifies nothing, so the overwhelmingly common case costs no
   * additional I/O at all. What it costs is one round-trip on the sweeps that were about to
   * interrupt the founder — which is exactly the moment being right is worth a round-trip.
   *
   * ── AN UNANSWERED CLAIM IS NOT A REFUTATION ────────────────────────────────────────────────────
   * Return whatever could be read. A claim omitted from the map, and a throw from this function, both
   * read as `unreadable` and change NOTHING — see `pusherVerify`'s header. Failing the other way
   * would let one `gh` outage silence a genuine fleet-wide block, and silence is the failure this
   * whole feature exists to eliminate.
   */
  verifyClaims(claims: readonly PusherClaim[]): Promise<ClaimVerdicts>;
  /** Structured record of every decision, sent or refused. */
  record(entry: PusherLogEntry): void;
}

/**
 * Ask the verifier, and turn every way of failing into "we learned nothing".
 *
 * A THROW MUST NOT BE A REFUTATION and must not be a crash. `sweepPushers` already catches at the
 * tick, but a throw here would abandon the rest of the roster mid-sweep — so an offline machine
 * would stop reporting quota walls, not merely stop verifying them.
 */
async function readVerdicts(
  deps: PusherRunnerDeps,
  claims: readonly PusherClaim[],
): Promise<ClaimVerdicts> {
  if (claims.length === 0) return new Map();
  try {
    return await deps.verifyClaims(claims);
  } catch (e) {
    log.warn("pusher", "claim verification failed; every claim reads as unreadable", {
      error: String(e),
    });
    return new Map();
  }
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

  // WHO RECEIVES A REPORT — this sweep's projects only. Also what the inbox batch is sized from: a
  // project with nothing owned this sweep gets no report, so its recipient's mailbox need not be read.
  const recipients = new Map<string, string>();
  for (const projectId of byProject.keys()) {
    const r = deps.reportRecipient(projectId);
    if (r !== undefined) recipients.set(projectId, r);
  }

  // ...and the SAME lookup over every project we still hold memory for, used ONLY to aggregate
  // ledgers (roborev 57047). `FleetMemory` is deliberately never pruned so its ledger survives a
  // project's transient absence — but the ledger surviving is worth nothing if the lookup that reads
  // it does not. Built from `recipients` alone, one sweep where a project contributes zero owned
  // snapshots made its spend invisible and the bound lapsed: the same "a transient absence must not
  // reset the containment" failure as the previous two commits, relocated a third time.
  // `deps.reportRecipient` is a pure lookup by projectId, so asking it about an absent project is safe.
  const ledgerRecipients = new Map<string, string>();
  for (const projectId of new Set([...byProject.keys(), ...state.fleet.keys()])) {
    const r = deps.reportRecipient(projectId);
    if (r !== undefined) ledgerRecipients.set(projectId, r);
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

  // EVERY FLEET LEDGER THAT NAMES THIS AGENT AS ITS RECIPIENT (roborev 57043). Keyed by AGENT, not
  // by the agent's own project, because `reportRecipient(projectId)` may name an agent that lives in
  // a different project — and may name the same agent for several. Keying on `s.projectId` made the
  // shared bound silently lapse in exactly those cases.
  const fleetLedgerFor = new Map<string, number[]>();
  for (const [projectId, r] of ledgerRecipients) {
    fleetLedgerFor.set(r, [
      ...(fleetLedgerFor.get(r) ?? []),
      ...(state.fleet.get(projectId)?.budget.sentAt ?? []),
    ]);
  }

  // Read ONCE per sweep, so every project's report describes the same moment.
  const allDuties = deps.duties();

  // ...and the same for the conflict evidence, which is APP-GLOBAL in the same way and for a
  // sharper reason: a `ConflictingPr` carries no projectId at all, so there is nothing to split it
  // by. It therefore rides with the duties — assigned to exactly one project below, because
  // threading one app-global list into every project's report is what produced the duplicated
  // "the hourly improvement pass is 9h overdue" paragraph (roborev 57400).
  //
  // `undefined` is passed through as `undefined`, never coerced to `[]`: the whole point of the
  // three-valued rule is that the sweep must be able to say "nothing has looked yet".
  const allConflicts = deps.conflicts();

  // ...AND ASSIGNED TO EXACTLY ONE PROJECT (roborev 57400). A duty is APP-GLOBAL — the hourly pass
  // belongs to the app, not to a project — but the report loop below is per project, each with its
  // own `FleetMemory`. Threading the same list into every project raised `duty-overdue` in each of
  // them independently, so with two projects the identical "the hourly improvement pass is 9h
  // overdue" paragraph was composed twice; and where both resolve to the SAME recipient (explicitly
  // supported here — `reportRecipient(projectId)` need not name an agent inside that project) the
  // founder simply received it twice. It also spent the shared budget a genuinely project-specific
  // condition might then be refused for.
  //
  // Assigned by SORTED projectId rather than by iteration order, so the owner is stable across
  // sweeps: picking "the first project we happened to walk" would migrate the duty whenever the
  // roster reordered, and each move would reset that project's two-observation rule and cooldown —
  // making a permanently-overdue duty re-report forever.
  // Owned by a project that can actually DELIVER, and by one that survives a bad sweep.
  //
  // `byProject` was both wrong answers at once (roborev 57425). It includes projects with NO
  // recipient, so if the lowest-sorted project happened to have none, `reportFleet` returned early
  // and the app-global duty went to NOBODY — a regression, since before the owner existed every
  // project carried the duties and any one of them delivered. And it is rebuilt each sweep from
  // `owned`, so a partial `snapshots()` read or an `ownsProject` flip that dropped the owner for two
  // consecutive sweeps migrated the duty to a project with a fresh two-observation counter and no
  // cooldown — re-telling the founder the paragraph this owner exists to send once. That is the
  // fourth appearance of "a transient absence must not reset the containment" in this file.
  //
  // `ledgerRecipients` answers both by construction: it spans `byProject.keys() ∪ state.fleet.keys()`
  // (so a project absent for a sweep is still a candidate) and contains ONLY projects with a
  // recipient (so the owner can deliver).
  //
  // ACCEPTED: if the owner is absent this sweep, or its recipient is quota-walled, the duty simply
  // is not reported until it can be — rather than migrating. Not-now is the right trade against
  // re-reporting, which is the failure the owner exists to prevent.
  const dutyOwner = [...ledgerRecipients.keys()].sort()[0];

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
    // A SHARED-FAILURE VICTIM IS DELIBERATELY *NOT* SUPPRESSED HERE, though it is just as dead. The
    // difference is that a quota wall carries `resetAt`, so the suppression expires on a measured
    // clock; `failure` carries no end time, so muting on it means muting for as long as whoever
    // supplies the snapshot keeps the field set. A stale field would then silence an agent forever —
    // which is the same "unreachable by any channel" failure that muting the report recipient
    // produced (roborev 56973), and it is not worth re-earning to save a message to a dead inbox.
    //
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

    // ONE BOUND, READ FROM BOTH SIDES (roborev 57040). When this agent is also its project's report
    // recipient, the two channels share `MESSAGES_PER_HOUR` — so each MERGES the other's ledger for
    // the decision, while each STORES only its own. One send therefore lands on exactly one ledger
    // and is counted exactly once by both channels.
    //
    // Which ledger a send is stored on is the part that took three attempts to get right. Storing
    // it on both double-counted it (roborev 57039). Storing the report's on the PARTNER ledger fixed
    // that and broke something worse: `partners` is pruned every sweep for any agent absent from
    // `owned`, so one partial `snapshots()` read or transient `ownsProject` flip wiped the report
    // channel's entire hourly bound and allowed 8 interruptions instead of 4 — the exact
    // "a transient absence must not reset the containment" argument already accepted for the fleet
    // map, reintroduced through the other ledger. So each channel stores on its OWN ledger, and the
    // report's lives in `FleetMemory`, which is never pruned.
    const fleetSent = fleetLedgerFor.get(s.agentId);
    const forDecision: PartnerMemory =
      fleetSent === undefined || fleetSent.length === 0
        ? memory
        : { ...memory, budget: { sentAt: [...memory.budget.sentAt, ...fleetSent] } };

    /** Strip the merged view back to this partner's own ledger before storing. */
    const ownPartner = (m: PartnerMemory): PartnerMemory => ({ ...m, budget: memory.budget });

    let decision = decidePusherAction({ policy, observation, memory: forDecision, inbox, now });

    // VERIFY BEFORE SPEAK. Only once something is actually about to be said, and then over EVERY
    // trigger currently firing rather than only the top one — because pruning can promote the
    // second, and a promoted trigger nobody verified would walk straight through this gate.
    //
    // The re-decision is the whole point: what comes back out is composed by `decidePusherAction`
    // from corrected evidence, so a surviving challenge is byte-identical to the one it would have
    // had and the citation gate is satisfied by construction. Filtering the finished text instead
    // would leave `measured` describing a challenge that is no longer being made.
    if (decision.action === "send") {
      const verdicts = await readVerdicts(
        deps,
        claimsForTriggers(evaluateTriggers(observation), s.agentId),
      );
      const verified = pruneRefutedObservation(observation, s.agentId, verdicts);
      // Identity, not deep-equality: `pruneRefutedObservation` returns the same object when nothing
      // was contradicted, so the ordinary path does no second decide at all.
      if (verified !== observation) {
        decision = decidePusherAction({ policy, observation: verified, memory: forDecision, inbox, now });
      }
    }

    if (decision.action === "quiet") {
      partners.set(s.agentId, ownPartner(decision.memory));
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
      partners.set(s.agentId, {
        ...ownPartner(decision.memoryOnDelivered),
        budget: recordSend(memory.budget, now),
      });
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
        // The same aggregate from the other side: every OTHER project whose reports go to this same
        // recipient. Read from the live `fleet` map, so a report already sent this sweep counts.
        [...ledgerRecipients]
          .filter(([pid, r]) => pid !== projectId && r === recipients.get(projectId))
          .flatMap(([pid]) => fleet.get(pid)?.budget.sentAt ?? []),
        // The WHOLE roster, not just this project's slice: `reportRecipient(projectId)` is not
        // required to name an agent inside that project, and the wall check must still find it
        // (roborev 56973).
        owned,
        partners,
        // Only the owning project carries the app-global duties; the rest report agents only.
        projectId === dutyOwner ? allDuties : [],
        // The same owner carries the app-global conflict evidence. A non-owner is handed `[]` —
        // "we looked, nothing for you" — rather than `undefined`, because the difference the
        // fail-closed rule protects is about whether the PROBE ran, and it did; this project simply
        // is not the one that reports its result.
        projectId === dutyOwner ? allConflicts : [],
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
 * The batched report — the conditions no partner can act on, delivered once to the recipient.
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
  otherProjectSent: readonly number[],
  everyone: readonly (FleetSnapshot & { projectId: string })[],
  partners: Map<string, PartnerMemory>,
  duties: readonly StandingDuty[],
  conflicts: readonly ConflictingPr[] | undefined,
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
    return fleetObservationMemory(memory, evaluateFleetConditions(owned, now, duties, conflicts));
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
    return fleetObservationMemory(memory, evaluateFleetConditions(owned, now, duties, conflicts));
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
  // report only ever covers the fleet conditions, so `goal-expired`, `unpushed-commits` and
  // `unanswered-question` for that agent became unreachable by any channel — "sat stuck and nobody
  // said anything", guaranteed for one agent per project. Sharing the budget keeps both channels
  // open and still bounds the total.
  //
  // The merge is SYMMETRIC: the per-partner loop builds the mirror of this one. Each channel reads
  // both ledgers and writes only its own.
  const partnerMemory = partners.get(recipient);
  const shared: BudgetState = {
    sentAt: [
      ...memory.budget.sentAt,
      ...(partnerMemory?.budget.sentAt ?? []),
      ...otherProjectSent,
    ],
  };

  const decisionInput = {
    policy: deps.policy(),
    snapshots: owned as readonly FleetSnapshot[],
    duties,
    conflicts,
    memory: { ...memory, budget: shared },
    inbox,
    now,
  };
  let decision = decideFleetReport(decisionInput);

  // VERIFY BEFORE SPEAK — the report channel's half. See `PusherRunnerDeps.verifyClaims`.
  //
  // The two calls to `decideFleetReport` are not a wasteful double-run: the first is what decides
  // whether anything would be said AT ALL, and it is what keeps the I/O off every quiet sweep. It is
  // pure, allocates a few strings, and is dwarfed by the round-trip it guards.
  //
  // WHAT THE SECOND CALL FIXES THAT A FILTER COULD NOT. A condition is a finished paragraph over a
  // cohort — "3 open PRs cannot merge…" and three lines under it. Removing one merged PR changes the
  // headline count, the plural, the remedy sentence and the `measured` whitelist together, and a
  // text that cites a number `measured` no longer holds is refused wholesale by `gateChallenge` as
  // `fabricated-citation` — which presents as SILENCE. So the correction is applied to the EVIDENCE
  // and `pusherFleet` recomposes; there is still exactly one composer.
  //
  // A condition may also VANISH here, and that is the intended outcome rather than an edge case: a
  // class whose every member turned out to be merged genuinely does not hold, and the memory stored
  // below then records that verified absence — so the condition is heard again immediately if it
  // returns, instead of sitting behind a stamp it never earned.
  if (decision.action === "send") {
    const claims: readonly PusherClaim[] = claimsForConditions(decision.conditions, owned, conflicts);
    if (claims.length > 0) {
      const verdicts = await readVerdicts(deps, claims);
      const verified = pruneRefutedFleetEvidence({ snapshots: owned, conflicts }, verdicts);
      decision = decideFleetReport({
        ...decisionInput,
        snapshots: verified.snapshots,
        conflicts: verified.conflicts,
      });
      if (decision.action === "quiet") {
        // NAMED SEPARATELY IN THE LOG. `no-condition` from this path would read as "the fleet is
        // healthy" when what actually happened is "everything we were about to say turned out to be
        // false" — and the hit-rate log is the only place the difference is recoverable.
        deps.record({
          at: now,
          agentId: recipient,
          outcome: "refused",
          reason: "verified-false",
          scope: "fleet",
        });
        return { ...decision.memory, budget: memory.budget };
      }
    }
  }

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
    // CHARGED TO EXACTLY ONE LEDGER, AND IT IS THIS ONE (roborev 57039, then 57040). Recording it
    // on both double-counted it; recording it on the PARTNER ledger instead put the report
    // channel's whole bound in the map that is pruned on roster absence. `FleetMemory` is never
    // pruned, so the report's send lives here and the partner channel reads it through the same
    // merge the report uses in the other direction. Deduping the merged timestamps would not have
    // worked either: a challenge and a report in the same sweep legitimately share `now`.
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
