// "Here's what happened while you were gone." Built when presence goes Away → Here, from a
// StatusMap snapshotted at the moment of the Away transition. Design:
// docs/superpowers/specs/2026-07-27-concierge-control-design.md §3 A5, which is explicit that this
// SUBSUMES the separate audit-trail idea — so it has to read like a summary a person wants, not a
// dump of everything that moved. Two consequences, both load-bearing:
//
//   • It reports TRANSITIONS INTO states worth reporting, not a full status diff. An agent that was
//     working and is still working is not news; one that went from working to waiting is.
//   • It returns NULL when nothing happened, AND when the absence was too short to be one
//     (MIN_AWAY_MS). A card that always appears is chrome the user learns to skip, which would cost
//     us the one time it says something urgent — and blur → Away is immediate, so "always" would
//     have included every ⌘-tab.
//
// The status map it diffs is the FEED's derived one, supplied by the caller (ConciergeHost
// feedStatuses), never the raw runtime store — see that helper for why the difference is visible.
//
// The diff is `engine/attention.ts newlyEntered` — the SAME primitive the notification edge uses,
// deliberately not a second one. The recap and the banners must never disagree about what counts as
// "something changed", and two independent diffs are how they would.
import { needsAttention, newlyEntered, type StatusMap } from "../engine/attention";
import type { AgentTabStatus } from "../types";

/**
 * The statuses a recap reports having been ENTERED. Wider than the notification set (which is
 * "answer this now" only), and the width is the whole point — this list is what the card can say.
 * The taxonomy it draws from is packages/ui/tokens.ts AGENT_STATUS; each decision below is against
 * that file's label, because the label is what the user reads on the row.
 *
 * IN, as WANTS YOU: `waiting`, `approval`, `errored` (the attention set) plus `blocked`, which the
 * concierge's `needs_you` band already surfaces as a nudge card — a recap that omitted it would
 * contradict the cards one scroll away.
 *
 * IN, as FINISHED:
 *   • `idle` — "Done — your turn". THE ordinary finish, and its omission was the bug this list
 *     shipped with (roborev 53631-H1): `engine/hookEvents` maps the Stop hook to `idle`, so the
 *     exact scenario the card exists for — walk away, three agents finish, come back — produces
 *     `working → idle` and used to produce no card at all.
 *   • `done` — finished cleanly AND landed. Real, but comparatively rare; it was never enough on
 *     its own.
 *   • `unmerged` — "Needs merge". Finished, with work sitting on a branch. Filed under Finished
 *     rather than Wants you deliberately: it is a LANDING state, not an alarm (tokens.ts made it
 *     gray on 2026-07-26 for exactly this reason — 27 of 51 agents sat in that band and the wall of
 *     red said "most of your agents have a branch"). The row's own label carries the nuance, which
 *     is why RecapChange passes the label through instead of re-wording it here.
 *
 * OUT: `working` (a transition into not-yet-anything) and `stopped`. `stopped` is the one worth
 * writing down: it is the de-escalation target for a DISMISSED `errored` alert
 * (engine/alertDismissal.deEscalatedStatus), and the recap reads that same derived map — so
 * reporting it would re-raise, under "Finished", precisely the alarms the user silenced. It is also
 * the resting status of every persisted-but-not-running tab, so a window that restores a fleet
 * would post a wall of rows about agents that did nothing. A genuinely killed agent is therefore
 * not reported at all today; if that becomes a felt gap, it needs its own signal ("exited while you
 * were out") rather than this status.
 */
export const RECAP_STATUSES: ReadonlySet<AgentTabStatus> = new Set<AgentTabStatus>([
  "waiting",
  "approval",
  "errored",
  "blocked",
  "idle",
  "done",
  "unmerged",
]);

/** Statuses that mean "it finished", as opposed to "it wants you". The bucket test, so the two
 *  lists in the card can never both claim the same agent (or drop one between them). */
const FINISHED_STATUSES: ReadonlySet<AgentTabStatus> = new Set<AgentTabStatus>([
  "idle",
  "done",
  "unmerged",
]);

/**
 * Does this row OWE THE USER SOMETHING? The founder's rule, in one predicate:
 * *"We should never hide a row that needs action from me."* (bead `sparkle-ws8gd`)
 *
 * `RecapCard` caps each section at `SECTION_CAP` and collapses the rest into "+N more". That cap
 * may only ever eat rows that ask nothing — so the card needs to know which rows those are, and it
 * asks HERE rather than matching on the rendered label, because the label is prose that gets
 * reworded and a truncation rule keyed on prose would fail silently the first time it was.
 *
 * FINISHED IS NOT THE SAME AS SETTLED, which is the whole subtlety and is exactly what the founder
 * saw. Two of the three finished statuses still want him:
 *
 *   • `idle`     — "Done — your turn". The turn is HIS. That is an ask.
 *   • `unmerged` — "Needs merge". Work is sitting on a branch waiting to be landed. An ask.
 *   • `done`     — finished cleanly AND LANDED. Nothing is owed. The only settled status, and
 *                  therefore the only kind of row the cap may hide.
 *
 * Everything in the `needsYou` bucket is actionable by construction (`waiting`/`approval`/
 * `errored`/`blocked` are what put a row there), so this returns true for those without
 * enumerating them — a new red status must not have to be added here to be protected.
 *
 * THE EVIDENCE THIS IS THE RIGHT LINE: the founder's screenshot showed "2 need you, 16 finished"
 * with five finished rows visible, and EVERY visible one read "Done — your turn" or "Needs merge".
 * So the eleven behind "+11 more" were overwhelmingly rows that wanted him, hidden behind flat grey
 * text that did not look like a control. The card reported a count that sounded complete while
 * making actionable items invisible.
 */
export function isActionableChange(change: Pick<RecapChange, "status">): boolean {
  return change.status !== "done";
}

/**
 * The resting statuses — an agent that is neither working nor asking. Same three the `unmerged`
 * overlay treats as eligible (`engine/unmergedAttention.RESTING`), plus `unmerged` itself.
 *
 * WHY A SECOND SET IS NEEDED, and it is the subtle half of this module (roborev 53652-H). The
 * status map this diffs is the DERIVED one, and `idle`/`unmerged` are the values the derived
 * overlays move BETWEEN with no agent activity whatsoever. `newlyEntered`'s gate is only "changed,
 * and the new value is reportable", so without this, overlay churn reads as a finish:
 *
 *   • `branchStatus` is live-only and boots EMPTY (stores/runtimeStore), so after a relaunch every
 *     persisted agent reads `idle`/`stopped` until the first branch poll lands and escalates it to
 *     `unmerged`. Launch, ⌘-tab away, come back → a "finished" row for every agent with an old
 *     branch. That is exactly the wall of rows excluding `stopped` was meant to prevent;
 *     `stopped → unmerged` would have walked straight around it.
 *   • A branch landing flips `unmerged → idle`, reporting a finish that was already reported.
 *
 * So a resting → resting move is bookkeeping, and bookkeeping is not news. Two things this set
 * deliberately does NOT do, both worth knowing before you trust it as a general overlay filter:
 *
 *   • It does not gate entry into a RED status. `idle → waiting` because a worker went red is a
 *     genuine ask — the thread renders a nudge card for it — so the recap must agree.
 *   • It does not catch a red-worker paint RELEASING. When a red worker recovers (or the
 *     self-healing auto-open unstrands one), the orchestrator's bubbled `waiting`/`approval`/
 *     `blocked` drops back to `idle` with the orchestrator itself having done nothing — and since
 *     the previous status was red, that reports as a finish. ACCEPTED, not overlooked: the only
 *     way to tell it from "you were asked, and now it's done" — the case a returning user most
 *     wants — is a discriminator for whether the red was the agent's own or a bubbled paint, which
 *     the status map does not carry. Silence on the whole class would drop the real case to
 *     suppress a cosmetic one. If that discriminator ever exists, this is where it goes.
 */
const RESTING_STATUSES: ReadonlySet<AgentTabStatus> = new Set<AgentTabStatus>([
  "idle",
  "done",
  "unmerged",
  "stopped",
]);

/**
 * The shortest Away stretch whose STATUS CHANGES are worth a card.
 *
 * Presence goes Away on blur immediately and unconditionally (stores/presenceStore §1 — a locked
 * decision, and not one this gate touches), so ⌘-tabbing to Slack for eight seconds is a complete
 * Away→Here stretch. On any live fleet at least one agent moves in eight seconds, so an ungated
 * recap posts a card AND fires the column's `role="status"` announcement every time the user checks
 * another app — the "card that appears on every return from the kitchen is chrome the user learns
 * to skip" failure this module's header says it avoids. (`formatAwayFor`'s "a moment" branch was
 * the tell that this could happen at all.)
 *
 * One minute: long enough that a glance at another window is silent, short enough that a real
 * errand still gets its recap.
 */
export const MIN_AWAY_MS = 60_000;

/**
 * ONE decision the dispatch gate took while the user was Away — sent it anyway, held it back, or
 * dropped it.
 *
 * ===================== INTEGRATION SEAM — READ BEFORE WIRING =====================
 * This branch defines and renders the shape but PRODUCES NONE. The producer is the dispatch gate /
 * countdown on the sibling A1 branch (`services/dispatchIntent.ts`), whose precedence rule is that
 * presence outranks the countdown: while Away, a destructive intent's expiry QUEUES rather than
 * dispatches, while a routine one still sends. Those three outcomes are exactly `kind` below.
 *
 * To wire it up, there is one line to change: `ConciergeHost` currently passes `[]` for `decisions`
 * (search for NO_GATE_DECISIONS). Replace it with the gate's log filtered to
 * `at >= snapshot.at`. Nothing else here needs to move — `buildRecap` already renders, orders and
 * counts decisions, and has tests that cover them.
 * =================================================================================
 */
export interface GateDecision {
  id: string;
  /** sent = dispatched unattended · queued = held for your return · cancelled = dropped. */
  kind: "sent" | "queued" | "cancelled";
  /** Who it was for, in the user's vocabulary ("Kraken Auth"). */
  agentName: string;
  /** The id behind `agentName`. REQUIRED, and required for the same reason `RecapChange` carries
   *  one: the recap names build agents, and every mention of a build agent in the concierge surface
   *  is clickable — which is impossible from a name alone, since several agents routinely share one.
   *
   *  Nothing constructs a `GateDecision` yet (`ConciergeHost` passes `decisions: []` — the gate that
   *  logs them lives on a sibling branch), so making this required costs nothing today and means the
   *  producer cannot land without carrying the id. Optional would have made it forgettable, which is
   *  the failure this whole change is about. */
  agentId: string;
  /** One plain-language line: what the action was. Not a command string — the recap is a summary. */
  summary: string;
  /** Epoch ms, so the host can select only decisions taken during THIS away stretch. */
  at: number;
}

/** One agent that entered a reportable status while the user was away. */
export interface RecapChange {
  agentId: string;
  agentName: string;
  projectName: string;
  status: AgentTabStatus;
  /** The app's own words for the status ("Needs you", "Done") — passed in rather than re-derived
   *  so the card can never speak a second status vocabulary. */
  statusLabel: string;
}

/** What the thread renders. Deliberately DATA, not prose: the card does the wording, so the
 *  copy can change without touching the diff and the diff is testable without a DOM. */
export interface ConciergeRecapMessage {
  id: string;
  kind: "recap";
  /** How long the user was gone, in ms. */
  awayMs: number;
  /** Agents that now want something from you. */
  needsYou: RecapChange[];
  /** Agents that finished on their own. */
  finished: RecapChange[];
  /** What the concierge did in your absence (see the seam above). */
  decisions: GateDecision[];
}

/** The StatusMap as it stood the moment the user went Away, plus when that was. */
export interface AwaySnapshot {
  /** The DERIVED (published) status per agent — the one the feed's own labels and nudge cards
   *  speak, not the raw runtime store. `next` must come from the same place, or the card files an
   *  agent under one status while printing another one's label beside it (roborev 53631-H2). */
  status: StatusMap;
  /** The agents in the feed at snapshot time. `newlyEntered` is restricted to these, so an agent
   *  that appeared and vanished while away can't leave a ghost in the recap. */
  agentIds: string[];
  /** Of `agentIds`, the heads whose `working` was their SUBTREE's rather than their own
   *  (ConciergeAgent.rolledUpGreen).
   *
   *  Needed at the SNAPSHOT edge, not just mid-stretch. A head already rolled-up-green when the user
   *  walked away is recorded here as `working`, so when its worker finishes the diff reads
   *  `working → idle`, `rested` is false, and the sawWorking guard never runs — the head files as
   *  finished alongside the worker that actually did the work. That is the COMMON shape (leave while
   *  it runs, come back when it's done), so covering only the mid-stretch half left the reported bug
   *  in place for it (roborev 53917). Optional so a caller that predates this field still compiles;
   *  absent reads as "none were promoted", which is the pre-rollup behavior. */
  rolledUpGreen?: string[];
  at: number;
}

/** The identity a recap line needs, keyed by agent id. Supplied by the caller from the live feed —
 *  names come from NOW, not from the snapshot, because a rename during the away stretch should
 *  show the name the user will actually see when they go looking. */
export interface RecapAgentInfo {
  name: string;
  projectName: string;
  statusLabel: string;
}

/**
 * Build the recap, or NULL when there is nothing to say.
 *
 * `now` and the id are injected rather than read from the clock, so the whole thing is pure and a
 * test can assert exact wording without freezing time.
 */
export function buildRecap(args: {
  snapshot: AwaySnapshot;
  next: StatusMap;
  info: Record<string, RecapAgentInfo>;
  decisions: readonly GateDecision[];
  /**
   * Agents OBSERVED `working` at any point during the away stretch (ConciergeHost accumulates it
   * from the feed, which keeps updating while the window is blurred).
   *
   * A stretch has a MIDDLE, and two endpoints cannot describe it. This parameter is that middle,
   * and it does two jobs the diff cannot do alone:
   *
   *   • It tells "the branch poll repopulated" from "it started and finished entirely while you
   *     were out" — both read `idle → unmerged` (roborev 53669-M).
   *   • It PRODUCES the row for a finish whose endpoints match at all: `idle → working → idle` is
   *     a whole unit of work that the diff cannot see (roborev 53674-M). See the row-production
   *     step in the body, which is where this is folded in.
   *
   * Neither is hypothetical: an orchestrator hands a resting worker another unit of work, the
   * self-healing auto-open restarts a `stopped` worker, and the gate seam below has the concierge
   * itself dispatching routine intents while Away — so without this the recap can go silent about
   * work the concierge sent.
   */
  sawWorking?: ReadonlySet<string>;
  now: number;
  id: string;
}): ConciergeRecapMessage | null {
  const { snapshot, next, info, decisions, sawWorking, now, id } = args;
  const awayMs = Math.max(0, now - snapshot.at);
  // Too brief to be an absence: report nothing that MOVED, only what the concierge DID. The status
  // diff is what fires on a routine app switch (see MIN_AWAY_MS); a gate decision is never routine —
  // "I sent this while you were out" is news at eight seconds exactly as it is at eight hours, and
  // it cannot be produced by an idle fleet ticking over.
  const brief = awayMs < MIN_AWAY_MS;
  const entered = brief
    ? []
    : newlyEntered(snapshot.status, next, snapshot.agentIds, RECAP_STATUSES);

  // THE DIFF ALONE CANNOT SEE THE ORDINARY FINISH. `newlyEntered` only yields an agent whose
  // endpoints DIFFER, and the commonest real finish leaves them identical: an agent resting at
  // `idle` is handed work, runs, and the Stop hook maps it straight back to `idle` (engine/
  // hookEvents) — `idle → working → idle`, a whole unit of work with nothing to diff (roborev
  // 53674-M). Filtering on `sawWorking` inside the loop could only ever rescue rows the diff had
  // already produced, so the evidence has to fold in HERE, at row production. Restricted to
  // snapshot.agentIds and to a status that is actually a finish, so this adds work that FINISHED,
  // never an agent still going.
  const rows = [...entered];
  if (!brief && sawWorking) {
    const already = new Set(entered.map((e) => e.id));
    for (const agentId of snapshot.agentIds) {
      if (already.has(agentId) || !sawWorking.has(agentId)) continue;
      const ns = next[agentId];
      if (ns !== undefined && FINISHED_STATUSES.has(ns)) rows.push({ id: agentId, status: ns });
    }
  }

  const needsYou: RecapChange[] = [];
  const finished: RecapChange[] = [];
  for (const { id: agentId, status } of rows) {
    const meta = info[agentId];
    // An agent the caller can't name is one that has left the feed since the snapshot. Naming it
    // "that agent" in a summary the user is meant to act on is worse than omitting it.
    if (!meta) continue;
    // A finish the agent didn't make isn't a finish — see RESTING_STATUSES. It counts when the
    // agent LEFT something (`working`, or a red it resolved) or was SEEN working mid-stretch; an
    // id with no snapshot status counts as resting, since "it was already sitting there" is the
    // safe reading and a genuinely fresh agent is excluded by `agentIds` anyway.
    const before = snapshot.status[agentId];
    // A `working` that was only ever the subtree's counts as RESTING for this agent: the head did
    // not leave anything, so its worker finishing is not the head finishing. Without this the
    // promoted head is reported as a finish it never made — see AwaySnapshot.rolledUpGreen.
    const beforeWasRollup = before === "working" && snapshot.rolledUpGreen?.includes(agentId);
    const rested = before === undefined || beforeWasRollup || RESTING_STATUSES.has(before);
    if (FINISHED_STATUSES.has(status) && rested && !sawWorking?.has(agentId)) continue;
    const change: RecapChange = {
      agentId,
      agentName: meta.name,
      projectName: meta.projectName,
      status,
      statusLabel: meta.statusLabel,
    };
    // `blocked` isn't in the notification-attention set but is still something that wants you, so
    // the bucket test is "did it finish?" rather than a second attention predicate.
    if (FINISHED_STATUSES.has(status)) finished.push(change);
    else if (needsAttention(status) || status === "blocked") needsYou.push(change);
  }

  const relevant = decisions.filter((d) => d.at >= snapshot.at);
  if (needsYou.length === 0 && finished.length === 0 && relevant.length === 0) return null;

  return {
    id,
    kind: "recap",
    awayMs,
    needsYou,
    finished,
    // Oldest first — the recap reads as a narrative of the away stretch, and a narrative runs
    // forward. (`newlyEntered` already preserves the caller's agent order for the two lists.)
    decisions: [...relevant].sort((a, b) => a.at - b.at),
  };
}

/** "12 minutes" / "1 hour 5 minutes" / "a moment". Rounded to the minute on purpose: the user does
 *  not care that it was 11m43s, and a seconds-precise number reads as a stopwatch rather than a
 *  summary. Under a minute says "a moment" rather than "0 minutes". */
export function formatAwayFor(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "a moment";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"}`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  const h = `${hours} hour${hours === 1 ? "" : "s"}`;
  return rem === 0 ? h : `${h} ${rem} minute${rem === 1 ? "" : "s"}`;
}

/**
 * The one-line version — the card's heading and, word for word, what the live region announces.
 *
 * Deliberately ONE string for both. A screen-reader user gets the same sentence a sighted user
 * reads, and it goes through the concierge's EXISTING single `role="status"` announcer; the card
 * must not carry a live region of its own (a second one double-announces — already learned and
 * fixed once during the auto-routing work).
 */
export function recapSummary(recap: ConciergeRecapMessage): string {
  const parts: string[] = [];
  // The verb agrees with the count: this string is the heading AND, word for word, what the screen
  // reader says — "1 need you" is a sentence nobody would write by hand.
  const n = recap.needsYou.length;
  if (n > 0) parts.push(`${n} need${n === 1 ? "s" : ""} you`);
  if (recap.finished.length > 0) parts.push(`${recap.finished.length} finished`);
  const queued = recap.decisions.filter((d) => d.kind === "queued").length;
  const sent = recap.decisions.filter((d) => d.kind === "sent").length;
  if (sent > 0) parts.push(`${sent} sent for you`);
  if (queued > 0) parts.push(`${queued} waiting on your say-so`);
  const cancelled = recap.decisions.filter((d) => d.kind === "cancelled").length;
  if (cancelled > 0) parts.push(`${cancelled} cancelled`);
  const tail = parts.length > 0 ? `: ${parts.join(", ")}.` : ".";
  return `While you were away — ${formatAwayFor(recap.awayMs)}${tail}`;
}
