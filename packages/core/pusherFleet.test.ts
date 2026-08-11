// THE PROPERTY: a condition the PARTNER cannot act on is measured, quoted verbatim, and citable.
//
// Every case here uses the real banner the founder was shown, because the citation rule is what
// makes or breaks this feature and the rule is sensitive to the exact characters in the string:
// "Aug 4" and "11pm" are numbers the report reproduces but never computed, and a `measured` list
// that misses either gets the whole report refused as `fabricated-citation` — a failure that would
// show up as SILENCE, which is indistinguishable from a healthy fleet.
import { describe, it, expect } from "vitest";
import {
  SHARED_FAILURE_MAX_AGE_MINUTES,
  SHARED_FAILURE_MIN_VICTIMS,
  SHARED_FAILURE_WINDOW_MINUTES,
  DUTY_OVERDUE_FACTOR,
  diedHoldingWork,
  evaluateFleetConditions,
  overdueDuties,
  sharedFailureCohorts,
  isQuotaWalled,
  persistedConditions,
  quotedNumbers,
  retirableAgents,
  type ConflictingPr,
  type FleetSnapshot,
} from "./pusherFleet";
import { checkCitations } from "./pusherGate";
// The growth rule lives in the report engine, so the one `died-holding-work` case that is about the
// cooldown is asserted through the real `decideFleetReport` rather than by reading `members`.
import { decideFleetReport, emptyFleetMemory } from "./pusherFleetReport";
import { resolvePusherPolicy } from "./pusherPolicy";

const T0 = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

/** The exact string the founder was shown. Verbatim matters — see the file header. */
const WEEKLY = "You've hit your weekly limit · resets Aug 4 at 11pm (America/Bogota)";

const walled = (id: string, over: Partial<FleetSnapshot> = {}): FleetSnapshot => ({
  agentId: id,
  label: `Agent ${id}`,
  quota: { message: WEEKLY, resetAt: T0 + 4 * HOUR, resetParsed: true },
  ...over,
});

/** Every condition must survive the gate's citation check, or it can never be delivered. */
function citable(text: string, measured: readonly string[]): boolean {
  return checkCitations(text, measured).ok;
}

describe("quota-blocked", () => {
  it("counts the blocked agents and quotes the earliest reset verbatim", () => {
    const [c] = evaluateFleetConditions(
      [
        walled("a", { quota: { message: WEEKLY, resetAt: T0 + 9 * HOUR, resetParsed: true } }),
        walled("b", { quota: { message: WEEKLY, resetAt: T0 + 2 * HOUR, resetParsed: true } }),
      ],
      T0,
    );
    expect(c!.id).toBe("quota-blocked");
    expect(c!.agentIds).toEqual(["a", "b"]);
    expect(c!.text).toContain("2 agents are quota-blocked");
    // The whole banner, character for character — not a reformatted `resetAt`.
    expect(c!.text).toContain(WEEKLY);
  });

  it("says the retry will not work, which is the half that cost the founder hours", () => {
    const [c] = evaluateFleetConditions([walled("a")], T0);
    expect(c!.text).toMatch(/Restarting them does not help/);
  });

  it("passes the citation gate — every number in the banner is measured", () => {
    const [c] = evaluateFleetConditions([walled("a"), walled("b"), walled("c")], T0);
    expect(citable(c!.text, c!.measured)).toBe(true);
    // The two numbers nobody computed: they exist only because the banner is quoted.
    expect(c!.measured).toContain("4");
    expect(c!.measured).toContain("11");
    expect(c!.measured).toContain("3");
  });

  it("picks the earliest reset by TIME, not by roster order", () => {
    const early = "You've hit your weekly limit · resets Aug 1 at 9pm (America/Bogota)";
    const [c] = evaluateFleetConditions(
      [
        walled("late", { quota: { message: WEEKLY, resetAt: T0 + 9 * HOUR, resetParsed: true } }),
        walled("early", { quota: { message: early, resetAt: T0 + HOUR, resetParsed: true } }),
      ],
      T0,
    );
    expect(c!.text).toContain(early);
    expect(c!.text).not.toContain(WEEKLY);
  });

  it("never quotes an UNPARSED reset — a bounded fallback is a guess, not a measurement", () => {
    const vague = "You've hit your usage limit · raise it at claude.ai/settings/usage";
    const [c] = evaluateFleetConditions(
      [walled("a", { quota: { message: vague, resetAt: T0 + 5 * HOUR, resetParsed: false } })],
      T0,
    );
    expect(c!.text).not.toContain(vague);
    expect(c!.text).toMatch(/not known from here/);
    expect(citable(c!.text, c!.measured)).toBe(true);
  });

  it("prefers a parsed reset over an earlier UNPARSED one", () => {
    const [c] = evaluateFleetConditions(
      [
        walled("guess", {
          quota: { message: "usage limit · raise it at claude.ai", resetAt: T0 + 1, resetParsed: false },
        }),
        walled("real", { quota: { message: WEEKLY, resetAt: T0 + 9 * HOUR, resetParsed: true } }),
      ],
      T0,
    );
    expect(c!.text).toContain(WEEKLY);
  });

  it("a wall whose reset has PASSED is history, not a condition", () => {
    const past = walled("a", { quota: { message: WEEKLY, resetAt: T0 - 1, resetParsed: true } });
    expect(isQuotaWalled(past, T0)).toBe(false);
    expect(evaluateFleetConditions([past], T0)).toEqual([]);
  });

  it("an ABSENT quota block never manufactures a wall", () => {
    expect(isQuotaWalled({ agentId: "a" }, T0)).toBe(false);
    expect(evaluateFleetConditions([{ agentId: "a" }], T0)).toEqual([]);
  });
});

describe("escalated goals", () => {
  const esc = (id: string, reason?: string): FleetSnapshot => ({
    agentId: id,
    label: `Agent ${id}`,
    escalation: reason === undefined ? {} : { reason },
  });

  it("reports the batch with each agent's blocker, so one glance clears eight", () => {
    const eight = Array.from({ length: 8 }, (_, i) => esc(`a${i}`, `blocker ${i}`));
    const [c] = evaluateFleetConditions(eight, T0);
    expect(c!.id).toBe("goals-escalated");
    expect(c!.text).toContain("8 goals are escalated");
    for (let i = 0; i < 8; i++) expect(c!.text).toContain(`blocker ${i}`);
    expect(citable(c!.text, c!.measured)).toBe(true);
  });

  it("says WHY it is a dead end — that the app reserves it for the human", () => {
    const [c] = evaluateFleetConditions([esc("a", "three continues, no progress")], T0);
    expect(c!.text).toMatch(/reserves it for you/);
  });

  it("names an agent with no recorded reason rather than dropping it from the batch", () => {
    const [c] = evaluateFleetConditions([esc("a"), esc("b", "real reason")], T0);
    expect(c!.agentIds).toEqual(["a", "b"]);
    expect(c!.text).toContain("no reason was recorded");
  });

  it("whitelists numbers inside a LABEL, which nothing computed", () => {
    const [c] = evaluateFleetConditions(
      [{ agentId: "a", label: "Cockpit Resize 2", escalation: { reason: "gave up" } }],
      T0,
    );
    expect(c!.text).toContain("Cockpit Resize 2");
    expect(citable(c!.text, c!.measured)).toBe(true);
  });

  it("whitelists numbers inside a REASON, which nothing computed", () => {
    const [c] = evaluateFleetConditions([esc("a", "3 continues without the mark moving")], T0);
    expect(citable(c!.text, c!.measured)).toBe(true);
  });
});

describe("done but not retired", () => {
  it("requires BOTH a met goal and affirmatively-clean work", () => {
    const [c] = evaluateFleetConditions(
      [{ agentId: "a", label: "Finished One", goalMetAt: T0 - HOUR, hasUnlandedWork: false, retroSettled: true }],
      T0,
    );
    expect(c!.id).toBe("done-not-retired");
    expect(c!.text).toContain("1 agent has");
    expect(c!.text).toContain("Finished One");
    expect(citable(c!.text, c!.measured)).toBe(true);
  });

  // THE FAIL-CLOSED CASE WITH REAL TEETH. `undefined` means no branch status was polled; calling
  // that "safe to retire" tells the founder to discard an agent that may hold unmerged commits.
  it("an UNKNOWN work status is never called safe to retire", () => {
    expect(retirableAgents([{ agentId: "a", goalMetAt: T0 }])).toEqual([]);
    expect(evaluateFleetConditions([{ agentId: "a", goalMetAt: T0 }], T0)).toEqual([]);
  });

  it("holding unlanded work is never called safe to retire", () => {
    expect(
      retirableAgents([{ agentId: "a", goalMetAt: T0, hasUnlandedWork: true }]),
    ).toEqual([]);
  });

  it("an unmet goal is never called safe to retire, however clean the tree", () => {
    expect(retirableAgents([{ agentId: "a", hasUnlandedWork: false }])).toEqual([]);
  });

  it("an agent with NO retro on file is never called safe to retire", () => {
    // knightwatch 5204094441#5, and this is contract drift rather than a new rule: engine/
    // retroReceiptTypes already said in its own words that the Pusher "requires an affirmative
    // `true` before it will recommend retiring anything". It did not. So the report told the
    // founder a row was safe to retire moments before that row's × asked him to retire it
    // "without its retro?" — two surfaces, one agent, opposite advice.
    //
    // FAILS against the pre-change code, where both of these returned the agent.
    expect(retirableAgents([{ agentId: "a", goalMetAt: T0, hasUnlandedWork: false }])).toEqual([]);
    expect(
      retirableAgents([
        { agentId: "a", goalMetAt: T0, hasUnlandedWork: false, retroSettled: false },
      ]),
    ).toEqual([]);
    // …and the condition disappears from the report with it, not just from this list.
    expect(
      evaluateFleetConditions([{ agentId: "a", goalMetAt: T0, hasUnlandedWork: false }], T0),
    ).toEqual([]);
  });

  it("…and IS called safe to retire once the retro is on file — the control", () => {
    // Without this, deleting the condition outright would pass every test above. The rung must stay
    // reachable: it returns on its own the day a captured/excused receipt exists for the agent.
    const settled = { agentId: "a", goalMetAt: T0, hasUnlandedWork: false, retroSettled: true };
    expect(retirableAgents([settled])).toEqual([settled]);
    expect(evaluateFleetConditions([settled], T0).map((c) => c.id)).toContain("done-not-retired");
  });
});

describe("died holding work", () => {
  /** The founder's case: spawned, ran, session ended, three research docs left uncommitted. */
  const dead = (id: string, over: Partial<FleetSnapshot> = {}): FleetSnapshot => ({
    agentId: id,
    label: `Agent ${id}`,
    sessionEnded: true,
    dirty: true,
    dirtyCount: 3,
    ...over,
  });

  it("fires on ended + goal unmet + dirty, and names the agent, the count and the loss", () => {
    const [c] = evaluateFleetConditions([dead("a", { label: "Homepage Designs" })], T0);
    expect(c!.id).toBe("died-holding-work");
    expect(c!.agentIds).toEqual(["a"]);
    // The three things the founder has to decide with: WHICH agent, HOW MANY files, and that the
    // work is destroyed by the tidy-up he would otherwise reach for.
    expect(c!.text).toContain("Homepage Designs");
    expect(c!.text).toContain("3 uncommitted files");
    expect(c!.text).toMatch(/DELETES that work/);
    expect(c!.text).toMatch(/Decide what to keep/);
  });

  // The near-inverse class one line down says "safe to retire". Retiring one of THESE is the
  // destructive act, so the two must never be confusable by a reader skimming the batch.
  it("never reads as housekeeping", () => {
    const [c] = evaluateFleetConditions([dead("a")], T0);
    expect(c!.text).not.toMatch(/safe to retire/i);
    expect(c!.text).toMatch(/uncommitted/);
  });

  // THE FAIL-CLOSED CASE, and the one this class exists to get right. `undefined` is "the branch
  // poll did not answer" — no evidence at all, not weak evidence — and warning over it sends the
  // founder to rescue a worktree that holds nothing.
  it("says nothing when the branch poll DID NOT ANSWER", () => {
    const unread = dead("a", { dirty: undefined, dirtyCount: undefined });
    expect(diedHoldingWork([unread])).toEqual([]);
    expect(evaluateFleetConditions([unread], T0)).toEqual([]);
  });

  it("says nothing about a CLEAN tree", () => {
    const clean = dead("a", { dirty: false, dirtyCount: 0 });
    expect(diedHoldingWork([clean])).toEqual([]);
    expect(evaluateFleetConditions([clean], T0)).toEqual([]);
  });

  it("says nothing when the goal was MARKED MET — the session ending is the agent finishing", () => {
    const done = dead("a", { goalMetAt: T0 - HOUR });
    expect(diedHoldingWork([done])).toEqual([]);
    expect(evaluateFleetConditions([done], T0)).toEqual([]);
  });

  it("says nothing when no session end was OBSERVED, and nothing when one affirmatively did not", () => {
    const unknown = dead("a", { sessionEnded: undefined });
    const running = dead("a", { sessionEnded: false });
    expect(diedHoldingWork([unknown])).toEqual([]);
    expect(diedHoldingWork([running])).toEqual([]);
    expect(evaluateFleetConditions([unknown], T0)).toEqual([]);
    expect(evaluateFleetConditions([running], T0)).toEqual([]);
  });

  // THE CONTROL, and it is the half that makes the five negatives above mean anything. Each row is
  // a disqualified snapshot plus the repair of the ONE field that disqualified it: silent before,
  // firing after. Without this, a class deleted outright — or given an unsatisfiable predicate —
  // passes every negative, and each negative on its own is equally satisfied by an unrelated gate
  // upstream having short-circuited the whole evaluation.
  it("…and fires the moment the ONE disqualifying field is repaired", () => {
    const cases: Array<[string, Partial<FleetSnapshot>, Partial<FleetSnapshot>]> = [
      ["the branch poll never answered", { dirty: undefined, dirtyCount: undefined }, { dirty: true }],
      ["the tree is clean", { dirty: false, dirtyCount: 0 }, { dirty: true }],
      ["the goal was marked met", { goalMetAt: T0 - HOUR }, { goalMetAt: undefined }],
      ["no session end was observed", { sessionEnded: undefined }, { sessionEnded: true }],
      ["the session has not ended", { sessionEnded: false }, { sessionEnded: true }],
    ];
    for (const [why, broken, repair] of cases) {
      expect(diedHoldingWork([dead("a", broken)]), why).toEqual([]);
      expect(diedHoldingWork([dead("a", { ...broken, ...repair })]).map((s) => s.agentId), why).toEqual(["a"]);
    }
  });

  it("fingerprints by agent, so a SECOND agent joining re-opens the report", () => {
    const one = [dead("a")];
    const two = [dead("a"), dead("b")];
    const [c] = evaluateFleetConditions(one, T0);
    expect(c!.members).toEqual(["agent:a"]);

    // Asserted through the real report engine rather than by reading `members`: the growth rule
    // lives in `decideFleetReport`, and a fingerprint that is merely well-formed proves nothing
    // about whether the founder actually hears about agent b inside the cooldown.
    const reported = evaluateFleetConditions(one, T0);
    const memoryAfterReporting = {
      ...emptyFleetMemory(),
      lastConditions: reported,
      lastReported: {
        "died-holding-work": {
          at: T0,
          agentIds: reported[0]!.agentIds,
          members: reported[0]!.members,
        },
      },
    };
    const later = T0 + 60_000; // well inside REPEAT_COOLDOWN_MS

    // The same single agent is the thing already said — it stays quiet.
    const unchanged = decideFleetReport({
      policy: resolvePusherPolicy({}),
      snapshots: one,
      memory: memoryAfterReporting,
      duties: [],
      conflicts: undefined,
      inbox: { used: 0, capacity: 50 },
      now: later,
    });
    expect(unchanged.action).toBe("quiet");
    // The REASON matters: `all-conditions-cooled` is the cooldown doing its job. Any other quiet
    // reason would mean this case never exercised the growth rule at all — it would be the
    // two-observation rule, or an empty evaluation, silencing it for an unrelated cause.
    if (unchanged.action !== "quiet") return;
    expect(unchanged.reason).toBe("all-conditions-cooled");

    // A second agent dying holding work is NEWS, inside the same cooldown.
    const grown = decideFleetReport({
      policy: resolvePusherPolicy({}),
      snapshots: two,
      memory: { ...memoryAfterReporting, lastConditions: evaluateFleetConditions(two, T0) },
      duties: [],
      conflicts: undefined,
      inbox: { used: 0, capacity: 50 },
      now: later,
    });
    expect(grown.action).toBe("send");
    if (grown.action !== "send") return;
    expect(grown.conditionIds).toContain("died-holding-work");
    expect(grown.text).toContain("Agent b");
    expect(grown.text).toContain("2 agents' sessions ended");
  });

  // THE ONE THAT CATCHES A MISSING `quotedNumbers`. A label's digits are quoted and never computed,
  // and a `measured` that misses one gets the WHOLE report refused as `fabricated-citation` — which
  // presents as silence, i.e. the exact failure this class was built to end.
  it("passes the citation gate, including the digits in a label", () => {
    const [c] = evaluateFleetConditions(
      [dead("a", { label: "Homepage Designs 10", dirtyCount: 3 }), dead("b", { dirtyCount: 17 })],
      T0,
    );
    expect(citable(c!.text, c!.measured)).toBe(true);
    expect(c!.measured).toContain("10"); // quoted from the label, computed by nobody
    expect(c!.measured).toContain("17"); // the second agent's real file count
    expect(c!.measured).toContain("2"); // the count of agents
  });

  // An absent count is UNKNOWN, never zero — printing a 0 would say the opposite of the fact the
  // line exists to carry. The agent is still named, so he can still go and look.
  it("says the count was not recorded rather than printing a zero", () => {
    const [c] = evaluateFleetConditions([dead("a", { dirtyCount: undefined })], T0);
    expect(c!.text).toMatch(/did not record how many/);
    expect(c!.text).toContain("Agent a");
    expect(c!.text).not.toMatch(/\b0 uncommitted/);
    expect(citable(c!.text, c!.measured)).toBe(true);
  });

  it("stays citable when the producer sends a nonsensical count", () => {
    // Same trap `behindOf` clamps: `-4` renders as `-4`, from which `numbersIn` reads `4` while
    // `measured` would hold `-4`. The mismatch refuses the whole report, i.e. silence.
    const [c] = evaluateFleetConditions([dead("a", { dirtyCount: -4 })], T0);
    expect(citable(c!.text, c!.measured)).toBe(true);
    expect(c!.text).toContain("0 uncommitted files");
  });

  it("uses the singular for exactly one file", () => {
    const [c] = evaluateFleetConditions([dead("a", { dirtyCount: 1 })], T0);
    expect(c!.text).toContain("1 uncommitted file,");
  });

  // The ordering claim, and the reason for it: this is the only class whose evidence a spin-down
  // deletes, so it outranks every class about work that merely cannot proceed.
  it("ranks after shared-failure and ahead of duty-overdue and everything below", () => {
    const ids = evaluateFleetConditions(
      [
        { agentId: "r", label: "R", goalMetAt: T0, hasUnlandedWork: false, retroSettled: true },
        { agentId: "e", label: "E", escalation: { reason: "gave up" } },
        { agentId: "f1", label: "F1", failure: { message: "API Error: ENOTFOUND", at: T0 - 60_000 } },
        { agentId: "f2", label: "F2", failure: { message: "API Error: ENOTFOUND", at: T0 - 60_000 } },
        dead("d"),
        walled("q"),
      ],
      T0,
      [{ name: "the hourly improvement pass", intervalMs: HOUR, lastRunAt: T0 - 9 * HOUR }],
    ).map((c) => c.id);
    expect(ids).toEqual([
      "quota-blocked",
      "shared-failure",
      "died-holding-work",
      "duty-overdue",
      "goals-escalated",
      "done-not-retired",
    ]);
  });
});

describe("ordering and persistence", () => {
  it("reports quota first — it is the one condition where retrying is actively wrong", () => {
    const ids = evaluateFleetConditions(
      [
        { agentId: "c", goalMetAt: T0, hasUnlandedWork: false, retroSettled: true },
        { agentId: "b", escalation: { reason: "gave up" } },
        walled("a"),
      ],
      T0,
    ).map((c) => c.id);
    expect(ids).toEqual(["quota-blocked", "goals-escalated", "done-not-retired"]);
  });

  it("only a condition seen TWICE is eligible", () => {
    const first = evaluateFleetConditions([walled("a")], T0);
    expect(persistedConditions([], first)).toEqual([]);
    expect(persistedConditions(first, first).map((c) => c.id)).toEqual(["quota-blocked"]);
  });

  it("compares by id, so a condition whose COUNT grew still counts as persisting", () => {
    const one = evaluateFleetConditions([walled("a")], T0);
    const two = evaluateFleetConditions([walled("a"), walled("b")], T0);
    const [p] = persistedConditions(one, two);
    // The fresh measurement is what gets reported, not the stale one it persisted against.
    expect(p!.text).toContain("2 agents are quota-blocked");
  });
});

describe("quotedNumbers — the widening, and its limit", () => {
  it("collects numbers from every quoted string", () => {
    expect(quotedNumbers("Aug 4 at 11pm", "round 8")).toEqual(["4", "11", "8"]);
  });

  it("ignores absent strings rather than throwing", () => {
    expect(quotedNumbers(undefined, "7", undefined)).toEqual(["7"]);
  });

  // THE LIMIT. The widening whitelists what is REPRODUCED, never what is computed — a number that
  // appears in no quoted string and no count is still a fabricated citation.
  it("does not whitelist a number that appears in no quoted string", () => {
    const measured = quotedNumbers("resets Aug 4 at 11pm");
    expect(checkCitations("there are 12 agents", measured).ok).toBe(false);
  });
});

// ── MACHINE-SHUTDOWN CASUALTIES ─────────────────────────────────────────────────────────────────
// The founder saw this three times in one day: the host sleeps or restarts, every local agent dies
// with the same banner, and each victim's row says "errored" on its own — so nothing anywhere says
// they are ONE event. Five separate problems is exactly the noise the message budget exists to
// prevent.
describe("shared failure", () => {
  const OFFLINE = "API Error: Unable to connect to API (ENOTFOUND)";
  const MIN = 60_000;

  const died = (id: string, at = T0, message = OFFLINE): FleetSnapshot => ({
    agentId: id,
    label: `Agent ${id}`,
    failure: { message, at },
  });

  it("reports N victims of one cause as ONE event, quoting the shared error verbatim", () => {
    const five = ["a", "b", "c", "d", "e"].map((id) => died(id));
    const [c] = evaluateFleetConditions(five, T0);
    expect(c!.id).toBe("shared-failure");
    expect(c!.agentIds).toEqual(["a", "b", "c", "d", "e"]);
    expect(c!.text).toContain("5 agents stopped for a single shared reason, not 5 separate ones");
    expect(c!.text).toContain("one event, not 5 problems");
    expect(c!.text).toContain(OFFLINE);
    expect(citable(c!.text, c!.measured)).toBe(true);
  });

  it("is ONE condition, so the batch spends one message however many victims", () => {
    const ten = Array.from({ length: 10 }, (_, i) => died(`a${i}`));
    expect(evaluateFleetConditions(ten, T0).filter((c) => c.id === "shared-failure")).toHaveLength(1);
  });

  // A single agent failing is already visible on its own row, and aggregating one thing saves nobody
  // a glance. The claim this condition makes — "one cause, not N problems" — is only true at N >= 2.
  it("says nothing about a lone failure", () => {
    expect(sharedFailureCohorts([died("a")], T0)).toEqual([]);
    expect(evaluateFleetConditions([died("a")], T0)).toEqual([]);
  });

  it("needs the failures to be the SAME error, not merely simultaneous", () => {
    const different = [died("a", T0, OFFLINE), died("b", T0, "API Error: 529 overloaded")];
    expect(sharedFailureCohorts(different, T0)).toEqual([]);
  });

  it("needs them to be the same MOMENT, not merely the same error", () => {
    const apart = [died("a", T0), died("b", T0 - (SHARED_FAILURE_WINDOW_MINUTES + 1) * MIN)];
    expect(sharedFailureCohorts(apart, T0)).toEqual([]);
  });

  // Anchored to the NEWEST failure, not to the group's span: a recurring error that hits one agent
  // on Monday and another on Thursday is not one event, and a span test would eventually call it one.
  it("counts only the current burst when an error recurs over days", () => {
    const snaps = [
      died("old1", T0 - 3 * 24 * 60 * MIN),
      died("old2", T0 - 3 * 24 * 60 * MIN),
      died("new1", T0),
      died("new2", T0 - MIN),
    ];
    const [cohort] = sharedFailureCohorts(snaps, T0);
    expect(cohort!.agents.map((a) => a.agentId)).toEqual(["new1", "new2"]);
  });

  // THE OVERLAP THAT WOULD DOUBLE-REPORT. A limit banner is also identical across agents, so without
  // the exclusion the quota cohort forms here too and the same agents appear twice in one message.
  it("never counts a quota-walled agent as a shared-failure victim", () => {
    const both = [
      { ...walled("q1"), failure: { message: WEEKLY, at: T0 } },
      { ...walled("q2"), failure: { message: WEEKLY, at: T0 } },
    ];
    expect(sharedFailureCohorts(both, T0)).toEqual([]);
    const ids = evaluateFleetConditions(both, T0).map((c) => c.id);
    expect(ids).toEqual(["quota-blocked"]);
  });

  it("reports EVERY distinct cause rather than silently keeping the largest", () => {
    const snaps = [
      died("a", T0, OFFLINE),
      died("b", T0, OFFLINE),
      died("c", T0, OFFLINE),
      died("x", T0, "API Error: 529 overloaded"),
      died("y", T0, "API Error: 529 overloaded"),
    ];
    const [c] = evaluateFleetConditions(snaps, T0);
    expect(c!.text).toContain(OFFLINE);
    expect(c!.text).toContain("529 overloaded");
    expect(c!.text).toContain("5 agents stopped across 2 shared causes");
    expect(c!.agentIds).toHaveLength(5);
    expect(citable(c!.text, c!.measured)).toBe(true);
  });

  it("leads with the largest cohort", () => {
    const snaps = [
      died("x", T0, "small"),
      died("y", T0, "small"),
      died("a", T0, OFFLINE),
      died("b", T0, OFFLINE),
      died("c", T0, OFFLINE),
    ];
    expect(sharedFailureCohorts(snaps, T0)[0]!.message).toBe(OFFLINE);
  });

  it("ranks below quota but above escalation — retrying quota is the one actively wrong remedy", () => {
    const ids = evaluateFleetConditions(
      [
        { agentId: "e", label: "Esc", escalation: { reason: "gave up" } },
        died("a"),
        died("b"),
        walled("q"),
      ],
      T0,
    ).map((c) => c.id);
    expect(ids).toEqual(["quota-blocked", "shared-failure", "goals-escalated"]);
  });

  // THE WINDOW IS RELATIVE, SO IT ALONE CANNOT ANSWER "IS THIS STILL HAPPENING" (roborev 57275).
  // The host is offline 02:00-03:00, five agents record 02:10, and at 09:00 they are still within
  // fifteen minutes of EACH OTHER. Without an absolute bound the report claims they stopped as if it
  // were now, and re-fires every cooldown forever. The existing "recurs over days" case cannot see
  // this: it keeps a FRESH burst to anchor against, so it passes with or without the bound.
  it("says nothing about a cohort that is entirely stale", () => {
    const old = T0 - 3 * 24 * 60 * MIN;
    expect(sharedFailureCohorts([died("a", old), died("b", old)], T0)).toEqual([]);
    expect(evaluateFleetConditions([died("a", old), died("b", old)], T0)).toEqual([]);
  });

  it("reports a burst that is old but still inside the max age", () => {
    const lastNight = T0 - (SHARED_FAILURE_MAX_AGE_MINUTES - 60) * MIN;
    const [c] = evaluateFleetConditions([died("a", lastNight), died("b", lastNight)], T0);
    expect(c!.id).toBe("shared-failure");
  });

  it("the max age is a real cutoff, not a coincidence of the fixtures", () => {
    const inside = T0 - (SHARED_FAILURE_MAX_AGE_MINUTES - 1) * MIN;
    const outside = T0 - (SHARED_FAILURE_MAX_AGE_MINUTES + 1) * MIN;
    expect(sharedFailureCohorts([died("a", inside), died("b", inside)], T0)).toHaveLength(1);
    expect(sharedFailureCohorts([died("a", outside), died("b", outside)], T0)).toEqual([]);
  });

  // A timestamp says the agent died THEN, not that it is still dead. Quoting the age is what stops a
  // fourteen-hour-old event reading as a fresh one; the cutoff alone would not.
  it("quotes how long ago it happened, and cites it", () => {
    const at = T0 - (2 * 60 + 14) * MIN;
    const [c] = evaluateFleetConditions([died("a", at), died("b", at)], T0);
    expect(c!.text).toContain("died together 2h 14m ago");
    expect(citable(c!.text, c!.measured)).toBe(true);
  });

  it("the minimum is a real threshold, not a coincidence of the fixtures", () => {
    const atThreshold = Array.from({ length: SHARED_FAILURE_MIN_VICTIMS }, (_, i) => died(`a${i}`));
    expect(sharedFailureCohorts(atThreshold, T0)).toHaveLength(1);
    expect(sharedFailureCohorts(atThreshold.slice(0, -1), T0)).toEqual([]);
  });
});

// ── A STANDING DUTY THAT SILENTLY STOPPED ───────────────────────────────────────────────────────
// The founder asked what the improvement agent had been doing; the honest answer was "nothing, for
// hours", and nothing on any surface said so. This is the only class where NOTHING looks wrong —
// every agent is fine and a promised capability has simply stopped.
describe("duty overdue", () => {
  const MIN = 60_000;
  const HOURLY = 60 * MIN;
  const duty = (over: Partial<Parameters<typeof overdueDuties>[0][number]> = {}) => ({
    name: "the hourly improvement pass",
    intervalMs: HOURLY,
    lastRunAt: T0 - 7 * HOURLY,
    ...over,
  });

  it("reports how long it has been and how often it should run", () => {
    const [c] = evaluateFleetConditions([], T0, [duty()]);
    expect(c!.id).toBe("duty-overdue");
    expect(c!.text).toContain("the hourly improvement pass");
    expect(c!.text).toContain("last ran 7h 0m ago");
    expect(c!.text).toContain("every 1h 0m");
    expect(citable(c!.text, c!.measured)).toBe(true);
  });

  // The actionable half. "It has not run for nine hours" sends someone hunting; naming the holder
  // points at the thing to fix — and the holder that matters is self-sustaining (a wedged pane
  // reads `working`, so every tick skips and the pane never stops being busy).
  it("names what is holding it, verbatim", () => {
    const [c] = evaluateFleetConditions([], T0, [
      duty({ heldBy: "the Sparkle agent pane reads 'working'" }),
    ]);
    expect(c!.text).toContain("Held by: the Sparkle agent pane reads 'working'.");
    expect(citable(c!.text, c!.measured)).toBe(true);
  });

  it("says so honestly when nothing reports a cause", () => {
    const [c] = evaluateFleetConditions([], T0, [duty()]);
    expect(c!.text).toContain("Nothing reports why.");
  });

  // One missed slot is ordinary — offline, a pass still running, a briefly busy pane. Reporting
  // each of those is the tune-out the two-observation rule exists to prevent.
  it("tolerates a single missed interval", () => {
    expect(overdueDuties([duty({ lastRunAt: T0 - 1.5 * HOURLY })], T0)).toEqual([]);
  });

  it("fires at the factor, and that boundary is real", () => {
    const inside = overdueDuties([duty({ lastRunAt: T0 - DUTY_OVERDUE_FACTOR * HOURLY })], T0);
    const outside = overdueDuties([duty({ lastRunAt: T0 - (DUTY_OVERDUE_FACTOR * HOURLY - 1) })], T0);
    expect(inside).toHaveLength(1);
    expect(outside).toEqual([]);
  });

  // An unseeded scheduler reads as undefined, and "we never looked" must not become "the product
  // has stopped working".
  it("never fires on a duty whose clock was never read", () => {
    expect(overdueDuties([duty({ lastRunAt: undefined })], T0)).toEqual([]);
    expect(evaluateFleetConditions([], T0, [duty({ lastRunAt: undefined })])).toEqual([]);
  });

  it("ignores a duty with no meaningful interval rather than dividing by it", () => {
    expect(overdueDuties([duty({ intervalMs: 0 })], T0)).toEqual([]);
  });

  it("leads with the longest overdue", () => {
    const out = overdueDuties(
      [duty({ name: "recent", lastRunAt: T0 - 3 * HOURLY }), duty({ name: "ancient", lastRunAt: T0 - 40 * HOURLY })],
      T0,
    );
    expect(out.map((o) => o.duty.name)).toEqual(["ancient", "recent"]);
  });

  // A duty is not an agent. Borrowing an agent id would put an unrelated agent into the cooldown's
  // membership key, so a duty going overdue would re-open an unrelated condition.
  it("claims no agent ids", () => {
    const [c] = evaluateFleetConditions([], T0, [duty()]);
    expect(c!.agentIds).toEqual([]);
  });

  it("ranks after the agent-stopping classes but before per-agent dead ends", () => {
    const ids = evaluateFleetConditions(
      [{ agentId: "e", label: "Esc", escalation: { reason: "gave up" } }, walled("q")],
      T0,
      [duty()],
    ).map((c) => c.id);
    expect(ids).toEqual(["quota-blocked", "duty-overdue", "goals-escalated"]);
  });

  it("says nothing when every duty is on time", () => {
    expect(evaluateFleetConditions([], T0, [duty({ lastRunAt: T0 - 10 * MIN })])).toEqual([]);
  });
});

// THE HEADLINE FACT, AND THE FAIL-CLOSED RULE THAT GUARDS IT.
//
// Every assertion here is on the EMITTED TEXT, never on the fixture that produced it — a test that
// checked the input object would pass against a `conflictCondition` that returned an empty string.
// The one that matters most is the compound claim: "conflicting" and "untested" have to arrive
// together, because said apart the first reads as a merge chore and the reader stops there.
describe("pr-conflicting", () => {
  const pr = (over: Partial<ConflictingPr> = {}): ConflictingPr => ({
    pr: 1091,
    projectId: "project-alpha",
    branch: "sparkle/roborev-backlog-notice-collapse",
    ownerAgentId: null,
    kind: "conflicting",
    commitsBehind: 220,
    unresolvedSecs: 3 * 60 * 60 + 5 * 60,
    // THE FULLY-CONFIRMED CASE by default, so the tests that pin the strongest sentence say which
    // evidence earns it. Every other value is exercised by the block at the bottom of this file.
    evidence: "no-checks-ran",
    ...over,
  });

  it("fires for a DIRTY pr and names it, with the untested fact attached to it", () => {
    const [c] = evaluateFleetConditions([], T0, [], [pr()]);
    expect(c!.id).toBe("pr-conflicting");
    expect(c!.text).toContain("#1091");
    // The compound claim, in one clause. Split across two sentences this would still pass a naive
    // `toContain("untested")`, which is why the phrase is pinned rather than the word.
    expect(c!.text).toContain("conflicting, and therefore untested");
    expect(c!.text).toContain("no CI has ever run on it");
    expect(c!.text).toContain("220 commits behind main");
  });

  it("explains WHY there is no CI, in the report the founder actually reads", () => {
    const [c] = evaluateFleetConditions([], T0, [], [pr()]);
    // Not "checks failed". The mechanism — no event, so no run was ever created — is the half that
    // makes "conflicts" stop reading as a merge problem.
    expect(c!.text).toContain("never fires GitHub's pull_request event");
    expect(c!.text).toMatch(/ABSENT/);
  });

  it("says a one-commit conflict is resolvable without judgement", () => {
    const [c] = evaluateFleetConditions([], T0, [], [pr()]);
    expect(c!.text).toMatch(/only one commit ahead of main is usually resolvable without judgement/);
  });

  // THE GATE EATS AN UNCITED REPORT SILENTLY — the failure presents as a healthy-looking fleet, not
  // as an error. Every number the text quotes must be in `measured` or nothing is ever delivered.
  it("passes the citation gate, including the digits in the branch name", () => {
    const [c] = evaluateFleetConditions(
      [],
      T0,
      [],
      [pr(), pr({ pr: 806, branch: "sparkle/left-pair-2", commitsBehind: 41, kind: "stale" })],
    );
    expect(citable(c!.text, c!.measured)).toBe(true);
    expect(c!.measured).toContain("1091");
    expect(c!.measured).toContain("220");
    // Quoted, never computed: the trailing digit of the branch name.
    expect(c!.measured).toContain("2");
  });

  it("cites the hold reason's digits when one is recorded", () => {
    const [c] = evaluateFleetConditions([], T0, [], [pr({ blockedBy: "waiting on 3 approvals" })]);
    expect(c!.text).toContain("Blocked by: waiting on 3 approvals.");
    expect(citable(c!.text, c!.measured)).toBe(true);
  });

  // FAIL CLOSED. These are different facts about the world and only one of them may ever be
  // manufactured by a caller — see `conflictFlags.ts` for the seam where conflating them would make
  // an unauthenticated `gh` read as an all-clear.
  it("says NOTHING when we did not look (undefined)", () => {
    expect(evaluateFleetConditions([], T0, [], undefined)).toEqual([]);
  });

  it("says nothing when we DID look and there are none ([])", () => {
    expect(evaluateFleetConditions([], T0, [], [])).toEqual([]);
  });

  // A PR whose owner is unresolved is the case this class was built for: all five of the real ones
  // are on descriptive branches, so nothing resolves them. Dropping them would have made the
  // detector silent about exactly its own motivating evidence.
  it("reports an UNRESOLVED owner as unresolved rather than dropping or guessing it", () => {
    const [c] = evaluateFleetConditions([], T0, [], [pr({ ownerAgentId: null })]);
    expect(c!.text).toContain("#1091");
    expect(c!.text).toContain("Owner unresolved");
    // No pill: an id here would open some agent, and the reader could not tell it was the wrong one.
    expect(c!.agentIds).toEqual([]);
  });

  it("names a resolved owner by the label the rest of the app uses", () => {
    const [c] = evaluateFleetConditions(
      [{ agentId: "a1", label: "Cockpit Resize" }],
      T0,
      [],
      [pr({ ownerAgentId: "a1" })],
    );
    expect(c!.text).toContain("Owner: Cockpit Resize");
    expect(c!.agentIds).toEqual(["a1"]);
  });

  it("says so when an owner is recorded but not visible from this window", () => {
    const [c] = evaluateFleetConditions([], T0, [], [pr({ ownerAgentId: "gone" })]);
    expect(c!.text).toContain("Owner recorded, but not an agent this window can see");
  });

  // THE ONE THAT KEEPS THE HEADLINE HONEST. "Untested" is claimed for conflicting PRs only; a
  // mergeable-but-behind PR has had CI, and blurring the two costs the headline its credibility.
  it("never calls a STALE pr untested", () => {
    const [c] = evaluateFleetConditions(
      [],
      T0,
      [],
      [pr({ pr: 1050, kind: "stale", evidence: "n/a", commitsBehind: 40 })],
    );
    const line = c!.text.split("\n").find((l) => l.includes("#1050"));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/untested/i);
    expect(line).not.toMatch(/no CI/i);
    expect(line).toContain("mergeable, but 40 commits behind main");
  });

  it("does not offer the conflict remedy in a stale-only report", () => {
    const [c] = evaluateFleetConditions([], T0, [], [pr({ kind: "stale", evidence: "n/a" })]);
    expect(c!.text).not.toMatch(/resolvable without judgement/);
    expect(c!.text).not.toMatch(/untested/i);
    expect(citable(c!.text, c!.measured)).toBe(true);
  });

  it("leads with the conflicting prs and reports the stale ones behind them", () => {
    const [c] = evaluateFleetConditions(
      [],
      T0,
      [],
      [pr({ pr: 700, kind: "stale", evidence: "n/a" }), pr({ pr: 800 })],
    );
    expect(c!.text.indexOf("#800")).toBeLessThan(c!.text.indexOf("#700"));
    expect(c!.text).toContain("1 more can still merge");
  });

  // PRIORITY. Quota still outranks it — an agent that cannot execute at all beats work that has
  // already been done and is merely rotting.
  it("ranks below quota-blocked and above done-not-retired", () => {
    const ids = evaluateFleetConditions(
      [{ agentId: "c", goalMetAt: T0, hasUnlandedWork: false, retroSettled: true }, walled("q")],
      T0,
      [],
      [pr()],
    ).map((c) => c.id);
    expect(ids).toEqual(["quota-blocked", "pr-conflicting", "done-not-retired"]);
  });

  it("ranks below duty-overdue and above goals-escalated", () => {
    const ids = evaluateFleetConditions(
      [{ agentId: "e", label: "Esc", escalation: { reason: "gave up" } }],
      T0,
      [{ name: "the hourly improvement pass", intervalMs: HOUR, lastRunAt: T0 - 9 * HOUR }],
      [pr()],
    ).map((c) => c.id);
    expect(ids).toEqual(["duty-overdue", "pr-conflicting", "goals-escalated"]);
  });
});

// An owner that IS on the roster but carries no name is a fourth case, and it must not borrow
// `nameOf`'s "an unnamed agent" fallback — "owner an unnamed agent" reads like a name.
describe("pr-conflicting owner naming", () => {
  it("distinguishes an unnamed roster agent from one this window cannot see", () => {
    const base: ConflictingPr = {
      pr: 900,
      projectId: "project-alpha",
      branch: "sparkle/x",
      ownerAgentId: "nameless",
      kind: "conflicting",
      commitsBehind: 3,
      unresolvedSecs: 60,
      evidence: "no-checks-ran",
    };
    const [c] = evaluateFleetConditions([{ agentId: "nameless" }], T0, [], [base]);
    expect(c!.text).toContain("Owner recorded, but that agent has no name");
    expect(c!.text).not.toContain("an unnamed agent");
    expect(c!.agentIds).toEqual(["nameless"]);
    expect(citable(c!.text, c!.measured)).toBe(true);
  });
});

// EVIDENCE IS WHAT LICENSES THE STRONGEST SENTENCE, AND MOST VALUES DO NOT LICENSE IT.
//
// A CONFLICTING row is what a directly-observed absence of CI produces AND what an inherited or
// never-taken verdict produces — Rust computes `untested` as `is_dirty || refusal.is_some()`, which
// is why the consumer does not carry the field at all. A report composed without `evidence` told the
// founder "no CI has ever run on it" about rows the producer
// had explicitly marked as not-read-this-look. Every assertion here is on the LINE the reader sees:
// a test that checked the fixture carried `evidence` would pass against a `conflictCondition` that
// ignores the field entirely, which is exactly the bug.
describe("pr-conflicting evidence", () => {
  // Its own fixture: the factory above is scoped to its describe, and every case here differs from
  // the default in exactly one field — the one under test.
  const pr = (over: Partial<ConflictingPr> = {}): ConflictingPr => ({
    pr: 1091,
    projectId: "project-alpha",
    branch: "sparkle/roborev-backlog-notice-collapse",
    ownerAgentId: null,
    kind: "conflicting",
    commitsBehind: 220,
    unresolvedSecs: 3 * 60 * 60 + 5 * 60,
    evidence: "no-checks-ran",
    ...over,
  });
  const lineFor = (text: string, n: number) => text.split("\n").find((l) => l.includes(`#${n}`));

  it("claims no CI has EVER run only for the directly-observed case", () => {
    const [c] = evaluateFleetConditions([], T0, [], [pr({ evidence: "no-checks-ran" })]);
    expect(lineFor(c!.text, 1091)).toContain("no CI has ever run on it");
  });

  // THE TWO INHERITED STATES. Both carry a real, recent verdict for this head — so the PR is still
  // named, still called conflicting, still called untested. What it may not do is present a verdict
  // nobody re-read as one somebody did.
  for (const evidence of ["last-known", "last-known-unconfirmed"] as const) {
    it(`says a ${evidence} reading is not current instead of claiming first-hand knowledge`, () => {
      const [c] = evaluateFleetConditions([], T0, [], [pr({ evidence })]);
      const line = lineFor(c!.text, 1091);
      expect(line).not.toContain("no CI has ever run on it");
      expect(line).toContain("NOT current");
      expect(line).toContain("not re-read on the last look");
      // Reported and actionable, not dropped or hedged into uselessness.
      expect(line).toContain("conflicting, and therefore untested");
      expect(line).toContain("220 commits behind main");
      expect(citable(c!.text, c!.measured)).toBe(true);
    });
  }

  // `unknown` is the one with nothing confirmable behind it — and it still must not be dropped:
  // during a `gh` outage that would suppress a genuine standing conflict for the whole outage.
  it("says an unknown reading is not current, and still reports the PR", () => {
    const [c] = evaluateFleetConditions([], T0, [], [pr({ evidence: "unknown" })]);
    const line = lineFor(c!.text, 1091);
    expect(line).not.toContain("no CI has ever run on it");
    expect(line).toContain("nothing about this commit could be confirmed");
    expect(line).toContain("#1091");
    expect(citable(c!.text, c!.measured)).toBe(true);
  });

  // Checks that EXIST but predate the conflict are not an absence of CI. Same conclusion, different
  // route, and the report states the route.
  it("does not call stale checks an absence of CI", () => {
    const [c] = evaluateFleetConditions([], T0, [], [pr({ evidence: "checks-are-stale" })]);
    const line = lineFor(c!.text, 1091);
    expect(line).not.toContain("no CI has ever run on it");
    expect(line).toContain("its only checks ran before the conflict arose");
    expect(citable(c!.text, c!.measured)).toBe(true);
  });

  // ── THE AGGREGATE IS A CLAIM TOO, AND IT COVERS EVERY ROW ────────────────────────────────────
  // The headline used to say "they have never been tested" unconditionally, one line above a row
  // that says its checks DID run, or that nobody re-read the verdict. Same defect as the row-level
  // one, one level up: the strongest sentence stated where the evidence does not license it.
  it("does not claim the fleet was NEVER tested when a row's checks merely predate the conflict", () => {
    const [c] = evaluateFleetConditions([], T0, [], [pr({ evidence: "checks-are-stale" })]);
    const head = c!.text.split("\n")[0];
    expect(head).not.toContain("never been tested");
    expect(head).toContain("nothing current has tested it");
    // And the remedy, which promised "the CI run it has never had" over the same rows.
    expect(c!.text).not.toContain("the CI run it has never had");
    expect(c!.text).toContain("the CI run it is missing");
    expect(citable(c!.text, c!.measured)).toBe(true);
  });

  it("does not claim the fleet was NEVER tested over a verdict nobody re-read", () => {
    const [c] = evaluateFleetConditions([], T0, [], [pr({ evidence: "unknown" }), pr({ pr: 92 })]);
    const head = c!.text.split("\n")[0];
    expect(head).not.toContain("never been tested");
    expect(head).toContain("nothing current has tested them");
    expect(citable(c!.text, c!.measured)).toBe(true);
  });

  // The strongest sentence is still SAID when every row earns it — a fix that just weakened the
  // headline everywhere would pass the two above and cost the report its whole point.
  it("still says NEVER TESTED when every row is the directly-observed absence", () => {
    const [c] = evaluateFleetConditions([], T0, [], [pr(), pr({ pr: 92 })]);
    expect(c!.text.split("\n")[0]).toContain("they have never been tested");
    expect(c!.text).toContain("the CI run it has never had");
  });

  // ── A `stale` ROW IS A MERGEABILITY CLAIM, AND A REFUSED READ CANNOT MAKE IT ──────────────────
  // Rust answers `kind: "stale"` from `!is_dirty`, and on a refused look that is the LAST value
  // `gh` reported rather than a current one — so `kind: "stale", evidence: "unknown"` is a real
  // payload, and the row used to be narrated as flatly "mergeable".
  it("does not call a stale pr mergeable in the present tense on a reading nobody took", () => {
    const [c] = evaluateFleetConditions(
      [],
      T0,
      [],
      [pr({ pr: 1050, kind: "stale", evidence: "unknown", commitsBehind: 40 })],
    );
    const line = lineFor(c!.text, 1050);
    expect(line).not.toContain("— mergeable, but");
    expect(line).toContain("last known to be mergeable");
    expect(line).toContain("NOT current");
    // Still reported, still actionable, and still never called untested.
    expect(line).toContain("40 commits behind main");
    expect(line).not.toMatch(/untested/i);
    expect(citable(c!.text, c!.measured)).toBe(true);
  });

  it("does not tell the founder a stale-only fleet can still merge TODAY on an unread verdict", () => {
    const [c] = evaluateFleetConditions(
      [],
      T0,
      [],
      [pr({ pr: 1050, kind: "stale", evidence: "last-known", commitsBehind: 40 })],
    );
    expect(c!.text).not.toContain("can still merge today");
    expect(c!.text).toContain("was last known to merge, on a reading that is NOT current");
    expect(citable(c!.text, c!.measured)).toBe(true);
  });

  // FAIL SAFE ON A VALUE THIS BUILD HAS NEVER SEEN. The producer's value set has grown three times;
  // the next growth must degrade to the WEAKER sentence, never to a claim of knowledge nobody has.
  it("treats an evidence value it does not recognise as not current", () => {
    const [c] = evaluateFleetConditions([], T0, [], [pr({ evidence: "some-future-value" })]);
    const line = lineFor(c!.text, 1091);
    expect(line).not.toContain("no CI has ever run on it");
    expect(line).toContain("NOT current");
    expect(citable(c!.text, c!.measured)).toBe(true);
  });
});

// A NONSENSICAL COUNT MUST NOT MUTE THE DETECTOR. `-5` renders as `-5` and `numbersIn` reads `5`, so
// an unclamped count would put a number in the text that is not in `measured` — and `gateChallenge`
// refuses the WHOLE report as `fabricated-citation`, silently. One bad field from the producer would
// take the class down entirely, which is the failure shape this whole class exists to end.
describe("pr-conflicting citation safety", () => {
  it("stays citable when the producer sends a negative commits-behind", () => {
    const [c] = evaluateFleetConditions(
      [],
      T0,
      [],
      [
        {
          pr: 12,
          projectId: "project-alpha",
          branch: "sparkle/x",
          ownerAgentId: null,
          kind: "conflicting",
          commitsBehind: -5,
          unresolvedSecs: -1,
          evidence: "no-checks-ran",
        },
      ],
    );
    expect(citable(c!.text, c!.measured)).toBe(true);
    expect(c!.text).toContain("0 commits behind main");
    expect(c!.text).not.toContain("-5");
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE CONTENT FINGERPRINT — `FleetCondition.members`.
//
// The report cooldown re-opens on GROWTH, and it used to measure growth over `agentIds`. That is a
// fingerprint only for the classes whose subject IS an agent. `duty-overdue` hard-codes `agentIds:
// []` and `pr-conflicting` fills it from resolved owners only — and the PRs it was built for resolve
// to none. For exactly those cases the list is empty, `[].some(...)` is always false, and growth was
// undetectable: a new conflicting untested PR stayed silent for the full four-hour cooldown.
//
// These pin the identity each class publishes. The four-hour behaviour itself is asserted at the
// decision level in `pusherFleetReport.test.ts`, where the silence would actually be felt.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe("the condition fingerprint", () => {
  const conflicting: ConflictingPr = {
    pr: 1091,
    projectId: "project-alpha",
    branch: "sparkle/roborev-backlog-notice-collapse",
    ownerAgentId: null,
    kind: "conflicting",
    commitsBehind: 220,
    evidence: "no-checks-ran",
    unresolvedSecs: 4 * 60 * 60,
  };
  const hourly = {
    name: "the hourly improvement pass",
    intervalMs: HOUR,
    lastRunAt: T0 - 9 * HOUR,
  };

  // THE INVARIANT A FUTURE CLASS MUST NOT BREAK. A class that publishes no fingerprint is not
  // broken — `hasNewMember` fails it OPEN, so it reports rather than going quiet — but it also has
  // no cooldown at all, so it would repeat on every sweep. Every class that ships today has one.
  it("every condition a sweep can produce names what it covers", () => {
    const conditions = evaluateFleetConditions(
      [
        walled("q1"),
        { agentId: "f1", label: "F1", failure: { message: "API Error: ENOTFOUND", at: T0 - 60_000 } },
        { agentId: "f2", label: "F2", failure: { message: "API Error: ENOTFOUND", at: T0 - 60_000 } },
        { agentId: "e1", label: "E1", escalation: { reason: "gave up" } },
        { agentId: "d1", label: "D1", goalMetAt: T0 - HOUR, hasUnlandedWork: false, retroSettled: true },
        { agentId: "w1", label: "W1", sessionEnded: true, dirty: true, dirtyCount: 3 },
      ],
      T0,
      [hourly],
      [conflicting],
    );
    expect(conditions.map((c) => c.id)).toEqual([
      "quota-blocked",
      "shared-failure",
      "died-holding-work",
      "duty-overdue",
      "pr-conflicting",
      "goals-escalated",
      "done-not-retired",
    ]);
    for (const c of conditions) {
      expect(c.members.length, `${c.id} publishes no fingerprint`).toBeGreaterThan(0);
      // Namespaced, so two classes can never collide on a bare id.
      for (const m of c.members) expect(m).toMatch(/^(agent|duty|pr):/);
    }
  });

  // THE CASE THE OLD RULE COULD NOT SEE. An unresolved owner contributes no agent id, so this is the
  // only handle the cooldown has on the PRs this class was actually built for.
  it("fingerprints a conflicting PR by its NUMBER, which an unresolved owner still has", () => {
    const [c] = evaluateFleetConditions([], T0, [], [conflicting]);
    expect(c!.agentIds).toEqual([]);
    expect(c!.members).toEqual(["pr:1091", "pr:1091:conflicting"]);
  });

  // A conflicting PR carries a second member so that stale → conflicting reads as GROWTH. Emitting
  // both rather than swapping keeps the reverse trip a strict subset, so an improvement stays quiet.
  it("gives a stale PR only the bare number, so going conflicting ADDS a member", () => {
    const [c] = evaluateFleetConditions(
      [],
      T0,
      [],
      [{ ...conflicting, kind: "stale", evidence: "n/a" }],
    );
    expect(c!.members).toEqual(["pr:1091"]);
  });

  it("fingerprints a duty by name, which is the only identity a duty has", () => {
    const [c] = evaluateFleetConditions([], T0, [hourly]);
    expect(c!.agentIds).toEqual([]);
    expect(c!.members).toEqual(["duty:the hourly improvement pass"]);
  });

  // The agent classes keep the set they always had, namespaced. This is the regression guard: the
  // fingerprint is an ADDITION, and `quota-blocked`'s membership must not have moved.
  it("fingerprints an agent class by exactly the agents it names", () => {
    const [c] = evaluateFleetConditions([walled("q1"), walled("q2")], T0);
    expect(c!.agentIds).toEqual(["q1", "q2"]);
    expect(c!.members).toEqual(["agent:q1", "agent:q2"]);
  });

  // `shared-failure` flattens cohorts, so one agent can arrive twice; a duplicated member would make
  // the set comparison ask the same question twice, harmlessly, but the set is the contract.
  it("does not repeat an agent that appears in more than one cohort", () => {
    const [c] = evaluateFleetConditions(
      [
        { agentId: "a", failure: { message: "boom", at: T0 } },
        { agentId: "b", failure: { message: "boom", at: T0 } },
      ],
      T0,
    );
    expect(c!.members).toEqual(["agent:a", "agent:b"]);
  });
});
