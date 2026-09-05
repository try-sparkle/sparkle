// inboxStallEscalation — THE RECURRENCE GUARD for a peer inbox that has stopped draining.
//
// ── WHAT WENT UNNOTICED, MEASURED (beads sparkle-6yrvqd, sparkle-eou3y0.1) ───────────────────────
// The app-owned agent `__sparkle_self__` had an inbox that NEVER drained: 145 records on disk, all
// severity `act`, the oldest queued 11.6 hours earlier, `delivered: 0` and `acknowledged: 0` for its
// entire lifetime. Two agents each spent a full session believing they were coordinating with the
// other. The founder, verbatim: *"improved sparkle is not getting your messages."*
//
// NOTHING ANYWHERE REPORTED IT. `inbox_send` returned `state: "queued"` with a message id every
// time, so every sender was told it had communicated. The number that would have exposed it sat on
// the `inbox_status` row the whole time and was inferable ONLY by whoever happened to call that op
// and think to look at it. Nobody did, for days. A fact that is merely AVAILABLE ON DEMAND is not
// reported — it is a fact nobody reads, which is the same as no fact at all.
//
// So this module asks the question on a beat and pushes the answer at the concierge, which is the
// one surface in this app that can both show a human and act on its own.
//
// ── WHY A SEPARATE WATCH AND NOT `services/fleetWatch` ───────────────────────────────────────────
// `fleetWatch` already calls `inboxStatus` on a beat, which makes it the obvious host — and it is
// STRUCTURALLY BLIND TO THE MEASURED INCIDENT, which is the decisive fact. Its `pollFleetOnce` asks
// for inbox rows over `candidates` ONLY: the agents `decideIdleDelivery` judged idle and safe to
// write to ("Asked for ONLY the idle candidates, so an advancing fleet costs zero inbox reads").
// `__sparkle_self__` was `working` throughout the outage — it reaches turn boundaries constantly —
// so it was never a candidate and its row was never read. A guard grafted onto that loop would have
// been green for the entire eleven and a half hours. The blindness is not incidental either: it is
// the point of that filter, and widening it would make every advancing agent cost an inbox read on
// a 30s beat, which is the cost decision that pushed that poll from ten seconds to thirty.
//
// The other candidates and why they lost:
//   • `stores/inboxStore` (the 10s Level 2 poll) is DEMAND-DRIVEN — it reads exactly the ids some
//     surface is currently rendering. An inbox nobody has on screen is the one most likely to be
//     stalled and the one it will never look at.
//   • The agent ROW's pending badge already shows depth, and depth is what the outage looked like
//     from outside: 41 queued reads as "busy agent with mail waiting", not as "this drain is dead".
//     A number with no verdict beside it is what was already there and was already not read.
//   • `inbox_send`'s receipt now carries `RecipientQueue.notDraining` (bead sparkle-6yrvqd, the
//     previous piece), and that is the right place for it — but it only reaches a sender at the
//     moment it sends. An inbox that stalls while nobody happens to be writing to it stays silent,
//     and the whole shape of this outage is that senders were RARE and the stall was CONSTANT.
//
// ── THE TRIGGER IS AN AGE, NEVER THE COUNTERS ────────────────────────────────────────────────────
// The obvious test is `delivered === 0 && pending >= fyiCeiling`, and keyed on the counters ALONE it
// is wrong in the direction that kills a guard. `inbox::status_of` derives `delivered` and
// `acknowledged` by iterating the records still present in `<agent>.jsonl`, and `retention::
// reap_inbox` compacts that file at `2 × MAX_AGE_MS` (24h) — so a perfectly healthy long-lived agent
// reads `delivered: 0, acknowledged: 0` a day after its last delivery. An alarm keyed on that
// accuses working agents, and an alarm that fires on healthy agents is an alarm nobody reads, which
// is THE SAME FAILURE this guard exists to prevent, rebuilt one level up. (The previous piece
// shipped exactly that bug and review caught it before it landed.)
//
// So the trigger is `RecipientQueue.notDraining` — the age of the OLDEST STILL-PENDING record, which
// retention cannot reset because that record is by construction still in the file. It is IMPORTED,
// not re-derived: two definitions of "not draining" in two modules are two predicates that look like
// one and drift silently, so `conciergeTools/fleet.recipientQueueFromRow` is the only place that
// verdict is computed. This module adds one conjunct on top of it and nothing else.
//
// ── THE COUNTERS STILL DO A JOB: THEY MAKE THE DIAGNOSIS LEGIBLE ─────────────────────────────────
// Unsafe as a TRIGGER, they are the right DISCRIMINATOR once the age has already proven the stall,
// and the distinction they draw is exactly the one whose absence produced a wrong theory that
// circulated for days. Improve Sparkle reported *"the channel is one-way FYI by design: my message
// is delivered to it, but its reply doesn't route back"* — WRONG IN BOTH HALVES. Nothing had been
// delivered, and the channel is not one-way. An operator has to be able to read
//
//     NEVER DRAINED           — no record ever reached the agent; the drain path has never run
//     STALLED AFTER DELIVERING — it ran before and stopped; the agent is not reaching turn boundaries
//
// off the report without a code dive, because they have DIFFERENT CAUSES and DIFFERENT REMEDIES: the
// first is a missing `Stop` hook in the agent's `.claude/settings.local.json`, the second is agent
// liveness and has nothing to do with hook config. Reading them as one fact is what sent a session
// after a routing bug that did not exist.
//
// The claim is bounded honestly. `delivered === 0` proves "nothing in this inbox's RETAINED history
// was delivered", not "in its lifetime" — and the retained history is at least as long as the oldest
// pending record has been waiting, because that record is one of the ones being counted. The report
// says exactly that and no more.
//
// ── AND IT MUST NOT BECOME NOISE ─────────────────────────────────────────────────────────────────
// A guard that shouts every beat gets muted, and a muted guard is the same as no guard. Three rules,
// in the order they bind:
//   1. EDGE-TRIGGERED. A stall is announced on the transition INTO it. An inbox that is stalled and
//      STAYS stalled moves no edge and says nothing more.
//   2. ANNOUNCED MEANS ACCEPTED. The edge is recorded only when `notifyConcierge` returns `true`.
//      A push that reached nobody (no concierge window mounted — a real state, not a defect) leaves
//      the finding OWED and it is retried next beat. This is the shape `pipelineHealthEscalation`
//      documents having got wrong: a gate that CONSUMES the alarm before the sink accepts it turns a
//      lost alarm into a handled one, and that is the one thing a watchdog must never do.
//   3. RESTATED, NOT REPEATED. A stall that outlives {@link RESTATE_AFTER_MS} is announced again, so
//      a multi-day outage does not go permanently silent after one notice nobody happened to catch.
//      At six hours that is at most four notices a day per agent, against a 2h detection threshold.
// A DIAGNOSIS CHANGE re-announces immediately, because never-drained → stalled-after-delivering is a
// different fault with a different remedy and suppressing it would leave the reader acting on the
// superseded one. Clearing fires one RECOVERY notice, and only for a stall that was actually
// ANNOUNCED — an all-clear for an alarm nobody heard is pure noise.
//
// ── ROUTING: THE CONCIERGE, AND DELIBERATELY NOT THE INBOX ───────────────────────────────────────
// `pipelineHealthEscalation` routes to two channels: the concierge feed AND a doorbell into the
// `__sparkle_self__` inbox. The second one is unavailable to this module BY CONSTRUCTION — the thing
// being reported is that an inbox does not drain, and in the measured incident that inbox was
// `__sparkle_self__` itself. Sending a stall report through the stalled queue is the deadlock
// sparkle-eou3y0.1 is named for: *"the queue's own remedy text says the state clears only when that
// agent drains its queue. But the agent cannot be TOLD to drain its queue, because telling it
// requires the queue."* So there is one sink, plus a `log.warn` per decided report as a floor that
// needs no window mounted.
import { log } from "../logger";
import { useProjectStore } from "../stores/projectStore";
import {
  inboxStatus,
  recipientQueueFromRow,
  type InboxStatusRow,
  type RecipientQueue,
} from "./conciergeTools/fleet";
import { notifyConcierge } from "./conciergeNotifier";
import { findKnownAgent, openAgentIdSet } from "./knownAgents";

/**
 * How often the sweep asks.
 *
 * FIVE MINUTES. This does not need to be fast and being fast costs something: the detection
 * threshold it feeds is TWO HOURS (`fleet.NOT_DRAINING_AFTER_MS`), so a beat any tighter than this
 * buys nothing but I/O — the answer cannot change more than once per beat in a way anyone can act
 * on. A tick is a bounded pair of file reads per addressable agent, no subprocess and no agent turn,
 * so five minutes over a few dozen agents is free; the reason not to run it at `fleetWatch`'s thirty
 * seconds is simply that there is nothing to gain by it.
 */
export const INBOX_STALL_POLL_INTERVAL_MS = 5 * 60 * 1000;

/**
 * How long a still-stalled inbox stays quiet after being announced before it is announced again.
 *
 * SIX HOURS. Edge-triggering alone would announce a permanent stall exactly once, ever — and a
 * notice delivered into a concierge transcript at 03:00 that scrolls past unread is then the only
 * warning the outage ever gets. Six hours bounds the noise at four notices a day per stalled agent
 * while keeping the fault in front of whoever is actually at the machine. Well above the two-hour
 * detection threshold, so a restatement is never a re-detection of the same edge.
 */
export const RESTATE_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * WHICH FAULT THIS IS — the distinction whose absence produced a wrong theory that circulated for
 * days. See the header. Derived from the counters, which is safe HERE and only here, because it is
 * read after the age has already established that the inbox is stalled.
 */
export type InboxStallDiagnosis = "never-drained" | "stalled-after-delivering";

/** One stalled inbox, with everything the report needs and nothing derived twice. */
export interface InboxStallFinding {
  agentId: string;
  /** A display name where this window has one; `null` for an id with no record to name it. */
  agentName: string | null;
  diagnosis: InboxStallDiagnosis;
  pending: number;
  fyiCeiling: number;
  delivered: number;
  acknowledged: number;
  /** How long the oldest still-pending record has been queued. Always finite — `notDraining` is
   *  false without it, so a finding cannot exist with an unreadable age. */
  waitedMs: number;
}

/** What one sweep did, returned for logging and for the tests to assert on. */
export interface InboxStallSweep {
  /** Stalls found this sweep, whether or not they were announced. */
  found: InboxStallFinding[];
  /** Reports the concierge ACCEPTED — the edge is recorded only for these. */
  announced: InboxStallFinding[];
  /** Findings held back by rules 1-3 above (already announced, same diagnosis, inside the window). */
  suppressed: InboxStallFinding[];
  /**
   * Reports that passed the gate and were REFUSED by the sink. NOT a subset of `announced`: these
   * are still owed and will be retried next beat, which is the whole reason the edge is recorded on
   * acceptance rather than on the decision to send.
   */
  undelivered: InboxStallFinding[];
  /** Agents whose announced stall CLEARED this sweep, and for which a recovery notice was composed. */
  recovered: string[];
}

/** The seams. Injectable so the clock, the roster and the sink can all be driven by a test — an age
 *  judged against an untestable clock cannot be pinned in either direction. */
export interface InboxStallDeps {
  /** Every addressable inbox, not merely the delivery candidates — see the header. */
  agentIds(): string[];
  inboxStatus(agentIds: string[]): Promise<InboxStatusRow[]>;
  /** Returns whether the push was ACCEPTED, not merely whether a sink existed. */
  notifyConcierge(text: string): boolean;
  nameOf(agentId: string): string | null;
  now(): number;
}

/**
 * Agents announced as stalled, and what was said about them. Module scope because the edge outlives
 * any single sweep, exactly as `pipelineHealthEscalation`'s debounce state does.
 */
const announcedStalls = new Map<string, { atMs: number; diagnosis: InboxStallDiagnosis }>();

/**
 * IS THIS INBOX STALLED? The whole trigger, in one named predicate on one line.
 *
 * ONE LINE ON PURPOSE. This is a guard that both BLOCKS and ALLOWS, and `AGENTS.md`'s rule for that
 * shape is that a change is not verified until a mutant in EACH direction reds a test — narrowing it
 * must red a test proving the measured outage is still reported, widening it must red a test proving
 * a healthy post-compaction inbox stays silent. `mutation-check.sh --bidirectional` derives that pair
 * from a line that HOLDS a condition, and a `return <expr>;` is one of the shapes it can flip; the
 * `if (…) continue;` guard clauses this replaced were not, so the pair could not be derived at all.
 *
 * TWO CONJUNCTS, and the first one is IMPORTED rather than written here:
 *  1. `RecipientQueue.notDraining` — the oldest still-pending record has waited past
 *     `fleet.NOT_DRAINING_AFTER_MS`. THE one definition of "not draining" in this app; a second copy
 *     here would be a second predicate that looks like the first and drifts silently.
 *  2. `fyiHeadroom === 0` — i.e. `pending >= fyiCeiling`, the acceptance criterion on
 *     sparkle-eou3y0.1 and the point at which the stall starts REFUSING sends rather than merely
 *     swallowing them. Read off the same `RecipientQueue` rather than re-comparing the numbers, so
 *     the ceiling stays Rust's to decide.
 */
export function isStalledInbox(q: RecipientQueue): boolean {
  return q.notDraining && q.fyiHeadroom === 0;
}

/**
 * Find every stalled inbox in a batch of status rows.
 *
 * The verdict itself is {@link isStalledInbox}. A row whose ceilings or age cannot be read yields NO
 * finding: `recipientQueueFromRow` returns `null` or a false `notDraining` for it, and "I could not
 * read this meter" is not a proven outage.
 */
export function resolveInboxStalls(
  rows: readonly InboxStatusRow[],
  nowMs: number,
  nameOf: (agentId: string) => string | null = () => null,
): InboxStallFinding[] {
  const found: InboxStallFinding[] = [];
  for (const row of rows) {
    const q = recipientQueueFromRow(row, nowMs);
    if (q === null) continue;
    if (!isStalledInbox(q)) continue;
    // `notDraining` is only ever true with a finite `oldestPendingMs`, so this cannot be null here;
    // the guard is a type narrowing, not a second opinion about the verdict.
    if (q.oldestPendingMs === null) continue;
    // READ, NOT DEFAULTED. Both are required `number`s on the row and non-`Option` `u32`s in Rust,
    // so a `?? 0` here would be unreachable — and it would default an unreadable counter to the
    // STRONGER of the two claims, asserting "never drained" from absent evidence in the one case it
    // could ever run. No default is the honest shape when the type is the contract.
    const { delivered, acknowledged } = row;
    found.push({
      agentId: row.agentId,
      agentName: nameOf(row.agentId),
      // Safe here and nowhere else — see the header. The age has already proven the stall; these
      // counters only say WHICH stall it is.
      diagnosis: delivered === 0 && acknowledged === 0 ? "never-drained" : "stalled-after-delivering",
      pending: q.pending,
      fyiCeiling: q.fyiCeiling,
      delivered,
      acknowledged,
      waitedMs: nowMs - q.oldestPendingMs,
    });
  }
  return found;
}

function hoursOf(ms: number): number {
  return Math.floor(ms / (60 * 60 * 1000));
}

function label(f: Pick<InboxStallFinding, "agentId" | "agentName">): string {
  return f.agentName === null ? f.agentId : `${f.agentName} (${f.agentId})`;
}

/**
 * The report a human or the concierge reads. The DIAGNOSIS LEADS, before any number.
 *
 * A reader takes the opening of a notice as its verdict, and depth-and-age read as bookkeeping
 * whatever figures they carry — which is precisely what happened when the numbers were on the status
 * row the whole time and nobody drew a conclusion from them. The two arms name different causes,
 * prescribe different checks, and each explicitly denies the other's story, because the failure this
 * guard is a recurrence guard FOR was an operator confidently reporting the wrong one.
 */
export function composeInboxStallReport(f: InboxStallFinding): string {
  const waited = hoursOf(f.waitedMs);
  const head =
    `INBOX NOT DRAINING — ${label(f)}. ${f.pending} message(s) are queued and undelivered, at or ` +
    `over the ${f.fyiCeiling}-message \`fyi\` ceiling, and the oldest has been waiting ${waited}h. ` +
    "A drain runs at every turn boundary, so a message waiting that long has had none. Every " +
    'sender is being told `state: "queued"` and believes it communicated; it did not.';

  const diagnosis =
    f.diagnosis === "never-drained"
      ? "DIAGNOSIS — NEVER DRAINED. Not one record in this inbox's retained history has reached " +
        `\`delivered\` or \`acknowledged\` (delivered ${f.delivered}, acknowledged ` +
        `${f.acknowledged}), and that history covers at least the ${waited}h the oldest queued ` +
        "message has been waiting. So this is NOT 'a message was delivered and the reply was " +
        "lost', and it is NOT a one-way-by-design channel: nothing has ever arrived. " +
        "CAUSE: the drain rides the `Stop` hook, and an agent whose worktree registers no `Stop` " +
        "hook drains never (bead sparkle-6yrvqd). " +
        "CHECK: that agent's `.claude/settings.local.json` for a `sparkle-hook.mjs` `Stop` entry — " +
        "a normal agent worktree registers nine hook events; a broken one is missing this one."
      : "DIAGNOSIS — STALLED AFTER DELIVERING. This inbox HAS delivered: " +
        `${f.delivered} delivered and ${f.acknowledged} acknowledged among the records still ` +
        "retained. So the drain path exists and is wired correctly, and it has STOPPED. " +
        "CAUSE: not hook registration. The agent is not reaching turn boundaries — wedged " +
        "mid-turn, its PTY gone, or spun down. " +
        "CHECK: that agent's liveness and its terminal, NOT its hook config.";

  return `${head}\n\n${diagnosis}`;
}

/** The all-clear, sent only for a stall that was actually announced. */
export function composeInboxRecoveryReport(
  agentId: string,
  agentName: string | null,
  diagnosis: InboxStallDiagnosis,
): string {
  const was =
    diagnosis === "never-drained"
      ? "had never delivered a single message"
      : "had stopped delivering after previously working";
  return (
    `INBOX DRAINING AGAIN — ${label({ agentId, agentName })}. The inbox that ${was} is no longer ` +
    "stalled: its oldest queued message is within the drain window again, or its queue has emptied."
  );
}

/**
 * Should this finding be announced now? Rules 1-3 of the header, in the order they bind.
 *
 * PURE AND CONSUMES NOTHING. It does not touch `announcedStalls`; the sweep records the edge only
 * after the sink accepts, which is what keeps a refused push owed rather than silently spent.
 */
export function shouldAnnounce(f: InboxStallFinding, nowMs: number): boolean {
  const prev = announcedStalls.get(f.agentId);
  if (prev === undefined) return true;
  if (prev.diagnosis !== f.diagnosis) return true;
  return nowMs - prev.atMs >= RESTATE_AFTER_MS;
}

/**
 * One sweep: read every addressable inbox, report what is stalled, clear what recovered.
 *
 * NEVER THROWS. A watchdog that takes itself down on a transient IPC error is off exactly when the
 * fault it watches for is most likely to be present.
 */
export async function runInboxStallSweep(deps: InboxStallDeps): Promise<InboxStallSweep> {
  const empty: InboxStallSweep = {
    found: [],
    announced: [],
    suppressed: [],
    undelivered: [],
    recovered: [],
  };
  const ids = deps.agentIds();
  if (ids.length === 0) return empty;

  const nowMs = deps.now();
  let rows: InboxStatusRow[];
  try {
    rows = await deps.inboxStatus(ids);
  } catch (e) {
    // UNREADABLE IS NOT HEALTHY, and it is not stalled either. Returning the empty sweep leaves every
    // announced stall RECORDED rather than clearing it — a failed read must not fire a recovery
    // notice for a fault that is still there.
    log.warn("inbox-stall", "inbox status read failed; will retry on the next sweep", {
      error: String(e),
    });
    return empty;
  }

  const found = resolveInboxStalls(rows, nowMs, deps.nameOf);
  const stalledNow = new Set(found.map((f) => f.agentId));

  const announced: InboxStallFinding[] = [];
  const suppressed: InboxStallFinding[] = [];
  const undelivered: InboxStallFinding[] = [];

  for (const f of found) {
    if (!shouldAnnounce(f, nowMs)) {
      suppressed.push(f);
      continue;
    }
    const text = composeInboxStallReport(f);
    // The floor. Written whatever the sink says, so the fault is on the record even in a window with
    // no concierge mounted — the one case where the push cannot land.
    log.warn("inbox-stall", "inbox not draining", {
      agentId: f.agentId,
      diagnosis: f.diagnosis,
      pending: f.pending,
      waitedHours: hoursOf(f.waitedMs),
    });
    let accepted = false;
    try {
      accepted = deps.notifyConcierge(text);
    } catch (e) {
      log.warn("inbox-stall", "concierge push threw", { agentId: f.agentId, error: String(e) });
    }
    if (accepted) {
      // RULE 2: the edge is recorded HERE, on acceptance, and nowhere else.
      announcedStalls.set(f.agentId, { atMs: nowMs, diagnosis: f.diagnosis });
      announced.push(f);
    } else {
      undelivered.push(f);
    }
  }

  // RECOVERY. Only for an agent whose stall was ANNOUNCED — an all-clear for an alarm the reader
  // never heard is pure noise. The record is dropped either way, so the next stall re-announces.
  const recovered: string[] = [];
  const answeredFor = new Set(rows.map((r) => r.agentId));
  for (const [agentId, prev] of [...announcedStalls]) {
    if (stalledNow.has(agentId)) continue;
    // An agent the batch did not answer for is UNOBSERVED, not recovered. Dropping it here would
    // clear a live fault the moment its pane closed, and re-announce it the moment the pane reopened.
    if (!answeredFor.has(agentId)) continue;
    announcedStalls.delete(agentId);
    recovered.push(agentId);
    try {
      deps.notifyConcierge(
        composeInboxRecoveryReport(agentId, deps.nameOf(agentId), prev.diagnosis),
      );
    } catch (e) {
      log.warn("inbox-stall", "recovery push threw", { agentId, error: String(e) });
    }
  }

  return { found, announced, suppressed, undelivered, recovered };
}

/**
 * Every addressable inbox this window knows about.
 *
 * DELIBERATELY BROADER THAN `fleetWatch`'s candidate set, which is the whole reason this module has
 * its own list — see the header. The roster walk plus the open-pane set, which is what admits the
 * app-owned `__sparkle_self__` agent: it is in no project's roster by design (`services/knownAgents`
 * says so explicitly), so a roster-only walk would miss the exact agent the outage happened to.
 */
export function addressableAgentIds(): string[] {
  const roster = useProjectStore
    .getState()
    .projects.flatMap((p) => p.agents.map((a) => a.id));
  return [...new Set([...roster, ...openAgentIdSet()])];
}

export function liveInboxStallDeps(): InboxStallDeps {
  return {
    agentIds: addressableAgentIds,
    inboxStatus: async (agentIds) => {
      // The existing wrapper, not a fresh `invoke`, so this reads the same row shape every other
      // caller does — including `oldestPendingMs`, which is the field the verdict rests on.
      const r = await inboxStatus(agentIds);
      if (!r.ok) throw new Error(`${r.reason}: ${r.message}`);
      return r.data.rows;
    },
    // `notifyConcierge` returns whether the text was ACCEPTED, not merely whether a sink existed
    // (bead sparkle-qogah). Rule 2 above depends on that being the honest answer.
    notifyConcierge: (text) => notifyConcierge(text, "pusher"),
    nameOf: (agentId) => findKnownAgent(agentId)?.name ?? null,
    now: () => Date.now(),
  };
}

interface WatchHandle {
  timer: ReturnType<typeof setInterval> | null;
  deps: InboxStallDeps;
  running: boolean;
}
let active: WatchHandle | null = null;

/**
 * Start the stall watch. Fires once immediately and then on {@link INBOX_STALL_POLL_INTERVAL_MS}.
 * Calling it again replaces any running watch. Returns the teardown.
 */
export function startInboxStallWatch(
  deps: InboxStallDeps = liveInboxStallDeps(),
  intervalMs: number = INBOX_STALL_POLL_INTERVAL_MS,
): () => void {
  stopInboxStallWatch();
  const handle: WatchHandle = { timer: null, deps, running: false };
  active = handle;

  const tick = async () => {
    if (handle.running || active !== handle) return;
    handle.running = true;
    try {
      await runInboxStallSweep(handle.deps);
    } catch (e) {
      // `runInboxStallSweep` is documented never to throw; this is the backstop that keeps a defect
      // in it from killing the loop.
      log.warn("inbox-stall", "sweep threw; will retry on the next tick", { error: String(e) });
    } finally {
      handle.running = false;
    }
  };

  void tick();
  handle.timer = setInterval(() => void tick(), intervalMs);
  return stopInboxStallWatch;
}

/** Stop the watch (idempotent). Safe on unmount whether or not one is running. */
export function stopInboxStallWatch(): void {
  if (active?.timer) clearInterval(active.timer);
  active = null;
}

/** TEST SEAM. Forget the announced-edge state so one test cannot leak into the next. */
export function __resetInboxStallStateForTests(): void {
  announcedStalls.clear();
  stopInboxStallWatch();
}
