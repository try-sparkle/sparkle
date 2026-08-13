// WHEN RECOVERY GIVES UP, THE CONCIERGE GETS THE AGENT — THE FOUNDER NEVER DOES.
//
// This is the third leg of the dead-session fix and the one that keeps the other two honest. A dead
// session's row is now amber rather than red (`engine/deadSessionAttention`) on the rule that RED is
// reserved for the founder being the only actor who can unblock something — which is true only
// while something else is actually acting. `daily-cap-spent` is the moment nothing is: it is the
// ONLY terminal bound `decideResurrection` has, because the ladder plateaus at 30 minutes rather
// than ending.
//
// Before this, that moment reached nobody. It was reported through the sweep's returned `outcomes`,
// which the interval caller discards, and through a grouped log line. So the row would have gone
// quiet with no owner — a silently abandoned agent, which is strictly worse than the false red the
// de-redding removed.
//
// It goes to the CONCIERGE because the concierge can act on it: read what the agent was doing, then
// restart it or take its branch over. The founder cannot type into a terminal that is not running —
// which is his objection in the first place: *"there's nothing I can do to resolve this. So why am I
// seeing this?"*
import { beforeEach, describe, expect, it } from "vitest";

import { routeRecoveryExhausted } from "@sparkle/core";
import { MAX_RESURRECTS_PER_AGENT_PER_DAY } from "../engine/resurrection";
import { bandOfStatus } from "../engine/buildSections";
import { isRedStatus } from "./windowStatus";
import { needsAttention } from "../engine/attention";
import { RECOVERING_DEAD_STATUS } from "../engine/deadSessionAttention";
import {
  _resetResurrectionRunnerForTests,
  type DueAgent,
  type ResurrectionSweepOptions,
  sweepResurrections,
} from "./resurrectionRunner";
import { resetAdmittedAgents } from "./resurrectionAdmission";

const NOW = 1_754_534_400_000;

/** An agent that has spent every respawn in the rolling window. The cap is checked at `>=`, so this
 *  is the smallest number that exhausts it — derived from the constant rather than hard-coded, so
 *  raising the cap cannot leave this test asserting about a budget that is no longer spent. */
const SPENT = Array.from({ length: MAX_RESURRECTS_PER_AGENT_PER_DAY }, (_, i) => NOW - 1_000 - i);

function dead(over: Partial<DueAgent> = {}): DueAgent {
  return {
    agentId: "a1",
    projectId: "proj-1",
    worktree: "/wt/a1",
    // The cause the whole change is about: an unexplained death, which used to be structurally
    // unrecoverable and now recovers at the conservative pace — until the budget runs out.
    cause: "unknown",
    epoch: "epoch-that-died",
    diedAt: NOW - 60_000,
    notBeforeMs: NOW - 60_000,
    message: undefined,
    attemptsAt: SPENT,
    ...over,
  };
}

interface Harness {
  opts: ResurrectionSweepOptions;
  /** Every text handed to the concierge, in order. */
  escalations: string[];
  mounted: string[];
}

function harness(due: DueAgent[], over: Partial<ResurrectionSweepOptions> = {}): Harness {
  const escalations: string[] = [];
  const mounted: string[] = [];
  return {
    escalations,
    mounted,
    opts: {
      now: NOW,
      ownsProject: () => true,
      projectTornOut: () => false,
      hasAgentRow: () => true,
      due: () => Promise.resolve(due),
      liveSessions: () => Promise.resolve([]),
      claim: () => Promise.resolve(true),
      release: () => Promise.resolve(),
      mount: (agentId) => {
        mounted.push(agentId);
        return "opened" as const;
      },
      suppress: () => {},
      escalate: (text) => {
        escalations.push(text);
        return true;
      },
      ...over,
    },
  };
}

beforeEach(() => {
  _resetResurrectionRunnerForTests();
  resetAdmittedAgents();
});

describe("5. an agent whose recovery budget is spent is handed to the concierge", () => {
  it("escalates it, and does not respawn it", async () => {
    const h = harness([dead()]);
    const outcomes = await sweepResurrections(h.opts);

    expect(outcomes).toEqual([{ agentId: "a1", action: "none", detail: "daily-cap-spent" }]);
    // THE SIDE EFFECT, not the decision restated.
    expect(h.escalations).toHaveLength(1);
    expect(h.mounted).toEqual([]);
  });

  it("says what the concierge needs in order to act, and never asks the founder", async () => {
    const h = harness([dead()]);
    await sweepResurrections(h.opts);
    const text = h.escalations[0]!;

    // The ROUTE is what decides the recipient, and it must be the concierge. Asserted on the router
    // as well as on the sweep, because re-pointing it at the founder is the single change that would
    // undo this whole feature while every other assertion here still passed.
    expect(routeRecoveryExhausted({ label: "x", attempts: 1 }).target).toBe("concierge");
    // It states the agent is DEAD — the fact that distinguishes this from its live-agent sibling
    // `routeRetriesExhausted`, whose own doc records two rounds of getting that backwards.
    expect(text).toContain("DEAD");
    // …and the real spend, from the ledger, not the cap constant restated.
    expect(text).toContain(String(MAX_RESURRECTS_PER_AGENT_PER_DAY));
    // …and it does not tell the concierge to relay this to a person.
    expect(text.toLowerCase()).not.toContain("ask the founder");
  });

  it("escalates ONCE per episode, not once every 15-second sweep", async () => {
    // `daily-cap-spent` persists for hours. An unlatched escalation would be ~240 concierge findings
    // an hour for one agent, each costing a real turn against the same account limit the fleet is
    // already fighting.
    const h = harness([dead()]);
    await sweepResurrections(h.opts);
    await sweepResurrections({ ...h.opts, now: NOW + 15_000 });
    await sweepResurrections({ ...h.opts, now: NOW + 30_000 });
    expect(h.escalations).toHaveLength(1);
  });

  it("…but a genuinely NEW death escalates again", async () => {
    // The latch is keyed on the death instant, not on a bare boolean. An agent that came back, died
    // again and re-exhausted its budget is a new finding, and swallowing it would be the silent
    // abandonment this whole leg exists to prevent.
    const h = harness([dead()]);
    await sweepResurrections(h.opts);
    expect(h.escalations).toHaveLength(1);

    const later = NOW + 60_000;
    await sweepResurrections({
      ...h.opts,
      now: later,
      due: () => Promise.resolve([dead({ diedAt: later - 1_000 })]),
    });
    expect(h.escalations).toHaveLength(2);
  });

  it("keeps the finding OWED when the concierge could not be told", async () => {
    // `notifyConcierge` returns false when the text went nowhere, and its published contract is that
    // such a finding stays owed. Latching on a failed hand-off is exactly how the Pusher lost
    // findings — a destroyed item that was also suppressed at source.
    const refused: string[] = [];
    const h = harness([dead()], {
      escalate: (text) => {
        refused.push(text);
        return false;
      },
    });
    await sweepResurrections(h.opts);
    await sweepResurrections({ ...h.opts, now: NOW + 15_000 });
    expect(refused).toHaveLength(2);
  });

  it("does NOT escalate an agent that is merely between rungs — the paired negative", async () => {
    // Without this, "the concierge was told" would also pass for a sweep that escalated every
    // refusal it saw, which would page the concierge about every dead agent on the fleet every 15
    // seconds. `waiting-for-next-rung` clears by itself and is nobody's to act on.
    const h = harness([dead({ attemptsAt: [NOW - 1_000] })]);
    const outcomes = await sweepResurrections(h.opts);
    expect(outcomes).toEqual([{ agentId: "a1", action: "none", detail: "waiting-for-next-rung" }]);
    expect(h.escalations).toEqual([]);
  });

  it("does NOT escalate a stop the user asked for", async () => {
    // Nothing is owed for a `human-stopped` agent: the human already decided, so there is no work to
    // hand anybody. It is refused before the cap is ever consulted.
    const h = harness([dead({ cause: "human-stopped" })]);
    const outcomes = await sweepResurrections(h.opts);
    expect(outcomes).toEqual([{ agentId: "a1", action: "none", detail: "human-stopped" }]);
    expect(h.escalations).toEqual([]);
  });

  it("escalates on the COHORT path too — the other of the two refusal sites", async () => {
    // ⚠️ THE LEG THAT CAUGHT THE REAL BUG. The sweep refuses an agent in two structurally different
    // places, and which one it lands in has nothing to do with its own state: `groupCohorts`
    // discards a run below `SHARED_FAILURE_MIN_VICTIMS`, so a SOLO death (every test above) never
    // enters the cohort loop, while agents that died together do. Wiring the escalation into one
    // site left the other silently uncovered, with every other assertion in this file green.
    //
    // Two deaths of the SAME cause within the shared-failure window is what forms a cohort.
    const h = harness([
      dead({ agentId: "a1" }),
      dead({ agentId: "a2", diedAt: NOW - 59_000, notBeforeMs: NOW - 59_000 }),
    ]);
    const outcomes = await sweepResurrections(h.opts);

    expect(outcomes.map((o) => o.detail).sort()).toEqual(["daily-cap-spent", "daily-cap-spent"]);
    // BOTH members, not just the one that happens to be elected — each is its own finding, and the
    // concierge cannot act on an agent it was never told about.
    expect(h.escalations).toHaveLength(2);
  });

  it("and the exhausted row still does not become RED", async () => {
    // The de-redding is not conditional on recovery still being possible — the row stays amber and
    // the OWNER changes, which is the whole point of routing to the concierge. A red row here would
    // put the founder back in front of a dead terminal.
    const h = harness([dead()]);
    await sweepResurrections(h.opts);
    expect(isRedStatus(RECOVERING_DEAD_STATUS)).toBe(false);
    expect(needsAttention(RECOVERING_DEAD_STATUS)).toBe(false);
    expect(bandOfStatus(RECOVERING_DEAD_STATUS)).not.toBe("needs_you");
  });
});
