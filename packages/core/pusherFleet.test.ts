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
  queueUnfanned,
  retirableAgents,
  QUEUE_DEPTH_BUCKETS,
  QUEUE_UNFANNED_MIN_AGE_MS,
  type ConciergeQueue,
  type ConflictingPr,
  type FleetSnapshot,
} from "./pusherFleet";
// The pool cap, from the module that mirrors `research.rs` and is drift-tested against it —
// never restated as a literal here, which is exactly how the old comment on the cap-interaction
// case below came to assert a value that had been wrong for six days.
import { MAX_CONCURRENT_RESEARCH } from "./researchPool";
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

  it("says WHY it is the human's — the concierge's re-arms are bounded and only they refill them", () => {
    const [c] = evaluateFleetConditions([esc("a", "three continues, no progress")], T0);
    expect(c!.text).toMatch(/re-arm a goal a bounded number of times/);
    expect(c!.text).toMatch(/only your typing to the agent refills that allowance/);
    // The OLD claim — that the concierge can never re-arm and the app reserves it for the human —
    // is now false (agentGoal's `rearmGoal` / MAX_CONCIERGE_REARMS). Pinned as an absence too,
    // because a sentence that carries both readings is worse than either.
    expect(c!.text).not.toMatch(/reserves it for you/);
    expect(c!.text).not.toMatch(/cannot re-arm/);
    // …and the rewrite must still survive the fabricated-citation gate: the only number it may
    // render is the count `measured` already carries.
    expect(citable(c!.text, c!.measured)).toBe(true);
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

  // sparkle-i5v42's Bug C. `escalateGoal` and `markGoalMet` are independent latches on the same
  // `AgentGoal`, so a goal that was escalated and has SINCE been marked met (either legitimately,
  // through the front door, or via the TOCTOU `escalateGoal`'s new `metAt` guard now closes) still
  // carries a non-empty `escalation` field on its snapshot — `pusherSnapshots.ts` sets `escalation`
  // and `goalMetAt` independently. `retirableAgents` and `diedHoldingWork` both gate on
  // `goalMetAt`; this selector must too, or the founder-facing digest keeps reporting a goal the
  // roster itself already renders as finished.
  it("excludes an agent whose goal was escalated but has SINCE been marked met", () => {
    const escalatedThenMet: FleetSnapshot = { ...esc("a", "no progress"), goalMetAt: T0 - HOUR };
    expect(evaluateFleetConditions([escalatedThenMet], T0)).toEqual([]);
  });

  it("still reports the OTHERS in the batch when one has since been met", () => {
    const [c] = evaluateFleetConditions(
      [esc("still-stuck", "no progress"), { ...esc("done", "no progress"), goalMetAt: T0 - HOUR }],
      T0,
    );
    expect(c!.id).toBe("goals-escalated");
    expect(c!.agentIds).toEqual(["still-stuck"]);
    expect(c!.text).not.toContain("Agent done");
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
      queue: undefined,
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
      queue: undefined,
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

// ── MESSAGES STACKING UP WITH NOBODY TO FAN THEM OUT TO ─────────────────────────────────────────
// The founder watched six messages queue with zero concierge agents running. Nothing was errored,
// no goal was escalated, and every agent row was its normal colour — the queue simply grew, and the
// one fact worth knowing (that nothing is going to take them) existed on no surface at all.
//
// Every assertion below is on the EMITTED CONDITION, never on the fixture: a test that read the
// input object back would pass against a `queueCondition` that returned an empty string. And the
// citation assertions are load-bearing rather than hygiene — `numbersIn` matches the ZERO in "0
// concierge agents are running", so a `measured` that carries only the six gets the WHOLE batched
// report refused as `fabricated-citation`, taking `quota-blocked` and `goals-escalated` down with a
// condition neither of them has anything to do with.
describe("queue-unfanned", () => {
  const MINUTE = 60_000;
  /** The founder's case: six waiting, nobody running, and it has been that way for twelve minutes. */
  const queue = (over: Partial<ConciergeQueue> = {}): ConciergeQueue => ({
    queued: 6,
    liveAgents: 0,
    oldestAt: T0 - 12 * MINUTE,
    ...over,
  });

  const fire = (over: Partial<ConciergeQueue> = {}) =>
    evaluateFleetConditions([], T0, [], undefined, queue(over));

  it("fires for a deep queue with zero live concierge agents", () => {
    const [c] = fire();
    expect(c!.id).toBe("queue-unfanned");
    // The founder's sentence, verbatim. BOTH halves are pinned: a count with no "and 0 running"
    // reads as a healthy backlog, which is the reading that let this sit unnoticed.
    expect(c!.text).toContain("6 messages are queued and 0 concierge agents are running");
  });

  // THE CITATION TRAP, asserted twice on purpose. `citable` is the real gate check, and the explicit
  // "0" assertion is what fails loudly if someone later spells the zero as "zero" to dodge the gate
  // — which would pass `citable` while making the load-bearing half of the sentence uncheckable.
  //
  // THE AGE IS DELIBERATELY 2h 5m RATHER THAN THE FIXTURE'S 0h 12m. With a sub-hour wait the "0" in
  // `measured` is also produced by the hours component, so `toContain("0")` would hold even if the
  // live-agent count were never measured at all — the assertion would be true for a reason that has
  // nothing to do with what it claims to check. An age with no zero in it leaves exactly one source.
  it("is citable, and cites the ZERO as well as the six", () => {
    const [c] = fire({ oldestAt: T0 - (2 * 60 + 5) * MINUTE });
    expect(citable(c!.text, c!.measured)).toBe(true);
    expect(c!.measured).toContain("6");
    expect(c!.measured).toContain("0");
    // Nothing else in this reading is a zero, so the count above is the live-agent one.
    expect(c!.measured.filter((n) => n === "0")).toHaveLength(1);
  });

  // ══ THE REMEDY MUST NOT BE A WAY TO SILENCE THE ALARM (roborev 63598) ═══════════════════════════
  // This asserted the phrase "does not drain itself", which pinned in place a sentence that was
  // false in the most expensive direction available. The text claimed a queued message "waits for a
  // concierge agent to exist, so the depth only falls once one is started" and told the reader to
  // fan them out — but the concierge's turn queue advances on `turnFinished` and nothing else, so
  // dispatching research dequeues NOTHING while raising `liveAgents` to parity. Following the
  // instruction cleared the condition with every message still unanswered.
  //
  // The assertion now guards the honest version, and — the half that matters — guards against the
  // old claim coming back. A test that only checked for new wording would go green on a text that
  // said both.
  it("tells the reader what fanning out actually does, and does not promise it drains the queue", () => {
    const [c] = fire();
    // DISPATCH-AND-CONTINUE (beads sparkle-3c83a/8lwi8): dispatching now MOVES a prompt out of the
    // serial line and it returns, with findings, when its worker finishes — so the copy no longer says
    // "does NOT dequeue anything / advances only as each turn finishes", which became false.
    expect(c!.text).toContain("moves a prompt OUT of the serial line");
    // "with whatever it found" — not an unconditional "with findings": redelivery also fires for a
    // pass that failed or returned nothing, so the remedy must not promise findings (roborev 65716).
    expect(c!.text).toContain("comes back, with whatever it found, when its worker finishes");
    // The reported depth still counts a handed-off prompt — so the alert clearing means work STARTED,
    // not questions answered; without this the remedy is still, in effect, "make the alarm stop".
    expect(c!.text).toContain("work started, not as questions answered");
    // THE RETIRED CLAIMS, pinned as absent — the old timing must not survive anywhere in the text.
    expect(c!.text).not.toContain("does NOT dequeue anything");
    expect(c!.text).not.toContain("advances only as each turn finishes");
    expect(c!.text).not.toContain("does not drain itself");
    expect(c!.text).not.toContain("depth only falls once one is started");
    expect(citable(c!.text, c!.measured)).toBe(true);
  });

  it("quotes how long the oldest message has been waiting", () => {
    const [c] = fire({ oldestAt: T0 - (2 * 60 + 5) * MINUTE });
    expect(c!.text).toContain("2h 5m");
    expect(citable(c!.text, c!.measured)).toBe(true);
  });

  // ══ THE FOUNDER'S 2026-08-13 CORRECTION, AND THE REGRESSION IT GUARDS ═════════════════════════
  // This used to read "is SILENT when a concierge agent is running" and asserted `liveAgents: 1`
  // was quiet. That is the exact hole he was looking at: ONE agent against SIX waiting messages
  // called the fleet healthy, so five messages with nobody coming for them produced silence.
  // *"Let's just make it if live research is lower than the queue depth."* The test therefore
  // inverts — the case that used to prove correctness now proves the bug.
  //
  // ASSERTED AT 1 RATHER THAN ONLY AT 0. A test that fires at zero-live passes identically under
  // BOTH rules, so it cannot tell the change happened; `liveAgents: 1` is the smallest reading that
  // separates them.
  it("FIRES when agents are running but fewer than the messages waiting", () => {
    const [c] = fire({ liveAgents: 1 });
    expect(c!.id).toBe("queue-unfanned");
    expect(c!.text).toContain("6 messages are queued and 1 concierge agents are running");
    expect(citable(c!.text, c!.measured)).toBe(true);
    // One short of parity is still one message with nobody coming for it.
    expect(fire({ liveAgents: 5 })).toHaveLength(1);
  });

  // THE OTHER HALF OF THE CLASS, and the reason it is `<` rather than `<=`. An agent per waiting
  // message is a queue being SERVED, and reporting it spends the founder's attention on the healthy
  // path — which is what the floor and the buckets in this file all exist to avoid.
  it("is SILENT once there is an agent for every waiting message", () => {
    expect(fire({ liveAgents: 6 })).toEqual([]);
    expect(queueUnfanned(queue({ liveAgents: 6 }), T0)).toBeUndefined();
    // And more agents than messages is the same all-clear, not an underflow.
    expect(fire({ liveAgents: 7 })).toEqual([]);
  });

  // THE CAP INTERACTION, pinned because getting it wrong makes the condition UNSATISFIABLE rather
  // than merely wrong. If `liveAgents` counted only RUNNING children it could never exceed
  // `MAX_CONCURRENT_RESEARCH` and a deeper queue would report as abandoned forever. It counts
  // queued+running (services/research `isLive`), so a full fan-out clears it at ANY depth.
  //
  // ASSERTED PAST THE ACTUAL CAP, not at a hand-picked 6. The old version of this test asserted a
  // depth of 6 while its own comment claimed the cap was 2 — a claim that stayed in the file for
  // six days after the cap became 16 (`bf597a494`, 2026-08-13), because nothing read the number.
  // Deriving the depth from the imported constant means the case stays past-the-cap whatever the
  // cap becomes, and the comment cannot go stale independently of it.
  it("clears when every waiting message has been dispatched, even past the concurrency cap", () => {
    expect(fire({ queued: 6, liveAgents: 6 })).toEqual([]);
    const past = MAX_CONCURRENT_RESEARCH + 4;
    expect(fire({ queued: past, liveAgents: past })).toEqual([]);
    // …and the same depth with the cap's worth of agents is still a backlog, so the assertion above
    // is not passing for the trivial reason that everything clears.
    expect(fire({ queued: past, liveAgents: MAX_CONCURRENT_RESEARCH })).toHaveLength(1);
  });

  // A queue that formed seconds ago is the ordinary shape of a fan-out about to happen. Reporting it
  // is the tune-out the two-observation rule exists to prevent — and the sweep interval is short
  // enough that two observations alone would not cover the gap.
  it("is SILENT while the queue has only just formed", () => {
    expect(fire({ oldestAt: T0 - 30_000 })).toEqual([]);
    expect(fire({ oldestAt: T0 - (QUEUE_UNFANNED_MIN_AGE_MS - 1) })).toEqual([]);
  });

  it("fires exactly at the staleness floor, and that boundary is real", () => {
    expect(fire({ oldestAt: T0 - QUEUE_UNFANNED_MIN_AGE_MS })).toHaveLength(1);
  });

  // THE FLOOR'S VALUE, NOT JUST ITS BOUNDARY. Every assertion above is written against the symbol,
  // so all of them hold identically if it goes back to three minutes — the founder's number would
  // be silently reverted by a green suite. This is the one test that reads the literal.
  // *"I don't want it to be a three-minute wait. Let's make it more than a one-minute wait."*
  it("waits one minute, which is the founder's number and not the original three", () => {
    expect(QUEUE_UNFANNED_MIN_AGE_MS).toBe(60_000);
    // Stated as a live reading too, so the constant and the behaviour cannot drift apart: a
    // 90-second-old queue is reportable, and under the old floor it was not.
    expect(fire({ oldestAt: T0 - 90_000 })).toHaveLength(1);
  });

  // FAIL CLOSED. `undefined` is WE DID NOT LOOK — no store read, or a store that has not hydrated —
  // and it must never manufacture the claim that the app has stopped serving its queue.
  it("is SILENT when nobody looked", () => {
    expect(evaluateFleetConditions([], T0, [], undefined, undefined)).toEqual([]);
    expect(queueUnfanned(undefined, T0)).toBeUndefined();
  });

  // The other side of the same three-valued rule: a queue that WAS read and is empty is an all-clear,
  // and it is a different fact from never having looked.
  it("is SILENT for a looked-at empty queue", () => {
    expect(fire({ queued: 0 })).toEqual([]);
  });

  // No enqueue time recorded means the age cannot be established, and the floor above is the only
  // thing keeping a just-formed queue quiet. Fail closed rather than treat unknown as old.
  it("is SILENT when no enqueue time was recorded", () => {
    expect(fire({ oldestAt: null })).toEqual([]);
  });

  // A queue is not an agent — it is app-global, and borrowing an agent id would put an unrelated
  // agent in the cooldown's membership key. Same rule `duty-overdue` follows.
  it("claims no agent ids", () => {
    const [c] = fire();
    expect(c!.agentIds).toEqual([]);
  });

  // THE TWO-MEMBER TRICK, borrowed from `pr-conflicting`. A queue that DEEPENS inside the four-hour
  // cooldown has to be able to re-open it, and the growth rule only sees NEW members — so depth is
  // published as crossed buckets rather than as a raw count (which would re-send the same paragraph
  // every time one more message landed).
  it("re-opens the cooldown when the queue crosses a deeper bucket", () => {
    const shallow = fire({ queued: 6 })[0]!;
    const deeper = fire({ queued: 12 })[0]!;
    expect(deeper.members).toEqual(expect.arrayContaining(shallow.members));
    expect(deeper.members.length).toBeGreaterThan(shallow.members.length);
  });

  // ...and the reverse trip is an IMPROVEMENT, so it must be a strict subset and stay quiet.
  it("stays quiet when the queue merely shrinks", () => {
    const deeper = fire({ queued: 12 })[0]!;
    const shallow = fire({ queued: 6 })[0]!;
    expect(shallow.members.every((m) => deeper.members.includes(m))).toBe(true);
  });

  it("publishes a bucket for every depth it has crossed, and none it has not", () => {
    const [c] = fire({ queued: QUEUE_DEPTH_BUCKETS[1]! });
    expect(c!.members).toContain(`concierge:queue:depth-${QUEUE_DEPTH_BUCKETS[1]}`);
    expect(c!.members).not.toContain(`concierge:queue:depth-${QUEUE_DEPTH_BUCKETS[2]}`);
  });

  // A nonsensical count from the producer must not mute the detector: a negative renders as `-6`,
  // from which `numbersIn` reads `6` while `measured` would hold `-6` — the refusal `behindOf` and
  // `dirtyCountOf` are both clamped against, and it presents as silence.
  it("stays citable when the producer sends a nonsensical count", () => {
    const [c] = fire({ liveAgents: -2 });
    expect(citable(c!.text, c!.measured)).toBe(true);
    expect(c!.text).toContain("0 concierge agents are running");
  });

  // ── NON-FINITE READINGS FAIL CLOSED, WHICH CLAMPING ALONE DOES NOT GIVE YOU ────────────────────
  // A clamp defends against a number that is WRONG; these are the values that are not numbers at
  // all, and every guard in `queueUnfanned` admits them if it only clamps. `Math.trunc(NaN)` is
  // `NaN`, so `=== 0` is false and `> 0` is false — both tests pass a `NaN` straight through — and
  // `NaN < QUEUE_UNFANNED_MIN_AGE_MS` is false, so the staleness floor, the one guard keeping the
  // healthy path quiet, is skipped entirely rather than enforced.
  //
  // This is not a hypothetical hardening pass. The producer is a persisted app-wide JSON store built
  // separately against this contract, and TypeScript cannot enforce a shape at a hydration boundary
  // — a payload written before a field existed arrives as `undefined`, not as the `null` the type
  // promises. Failing open here manufactures exactly the claim this class's header says it must
  // never make: "nothing is running" said over a queue that is being served.
  it("is SILENT when the enqueue time is missing rather than null", () => {
    expect(fire({ oldestAt: undefined })).toEqual([]);
  });

  it("is SILENT when a count is not a number at all", () => {
    expect(fire({ queued: NaN })).toEqual([]);
    expect(fire({ liveAgents: NaN })).toEqual([]);
    expect(fire({ oldestAt: NaN })).toEqual([]);
  });

  // The delivered sentence is the reason this matters more than tidiness: `numbersIn` finds no digits
  // in "NaN", so a report reading "waiting NaNh NaNm" passes the citation gate and is DELIVERED. A
  // garbage sentence that survives the gate costs the channel the credibility it runs on.
  it("never composes a sentence out of non-numbers", () => {
    for (const over of [{ queued: NaN }, { liveAgents: NaN }, { oldestAt: NaN }, { oldestAt: undefined }]) {
      for (const c of fire(over)) expect(c.text).not.toContain("NaN");
    }
  });

  it("still fires on the finite reading beside them", () => {
    // The pair the three cases above need: the same fixture, one field made finite again, reaching
    // the effect. Without it "returns []" is satisfied by a function that returns [] for everything.
    expect(fire({ queued: 6, liveAgents: 0 })).toHaveLength(1);
  });

  it("ranks below the classes whose evidence a spin-down deletes, and above a stopped duty", () => {
    const ids = evaluateFleetConditions(
      [{ agentId: "w", label: "W", sessionEnded: true, dirty: true, dirtyCount: 3 }],
      T0,
      [{ name: "the hourly improvement pass", intervalMs: HOUR, lastRunAt: T0 - 7 * HOUR }],
      undefined,
      queue(),
    ).map((c) => c.id);
    expect(ids).toEqual(["died-holding-work", "queue-unfanned", "duty-overdue"]);
  });

  // The generic anti-noise rule applies to this class like every other: one sweep is not enough.
  it("is subject to the two-observation rule", () => {
    const current = fire();
    expect(persistedConditions([], current)).toEqual([]);
    expect(persistedConditions(current, current).map((c) => c.id)).toEqual(["queue-unfanned"]);
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

  // ── HOW OLD IS THE READING? ──────────────────────────────────────────────────────────────────
  //
  // "NOT current" is a QUALIFIER, and through a measured six-hour outage it was set correctly on
  // every row and did not help: it said the same words on minute one and on hour six, so it read as
  // boilerplate while the numbers next to it got acted on. The producer now states
  // `readingAgeSecs`; these cases are about the reader being TOLD it.
  //
  // Note which age this is: `unresolvedSecs` is how long the CONFLICT has stood, and it kept
  // climbing right through the outage — which is why the rows looked actively monitored when in
  // fact nothing had been read since the night before.
  it("says HOW OLD a not-current reading is, rather than only that it is not current", () => {
    const [c] = evaluateFleetConditions(
      [],
      T0,
      [],
      [pr({ evidence: "unknown", blockedBy: "gh-graphql-and-rest-failed", readingAgeSecs: 6 * 3600 })],
    );
    const line = lineFor(c!.text, 1091);
    expect(line).toContain("NOT current");
    // THE POINT: a number the reader cannot skim past.
    expect(line).toContain("last read 6h 0m ago");
    // The whole report must still survive the citation gate — a number in the text that is not in
    // `measured` refuses the WHOLE report as `fabricated-citation`, which presents as SILENCE and
    // would take the detector down in a new way while fixing the old one.
    expect(citable(c!.text, c!.measured)).toBe(true);
  });

  // THE PAIRED CASE — REQUIRED. A surface that stamped an age on every row would satisfy the case
  // above while telling the reader that live verdicts are unreliable too, which is worse than the
  // bug: the value of the disclosure is that it is NOT always there.
  it("does not age-stamp a reading that was taken on this look", () => {
    const [c] = evaluateFleetConditions([], T0, [], [pr({ evidence: "no-checks-ran", readingAgeSecs: 0 })]);
    const line = lineFor(c!.text, 1091);
    expect(line).toContain("no CI has ever run on it");
    expect(line).not.toContain("last read");
    expect(line).not.toContain("NOT current");
    expect(citable(c!.text, c!.measured)).toBe(true);
  });

  // A STALE ROW GETS THE SAME TREATMENT. This is the exact sentence the founder was shown 17 times:
  // "last known to be mergeable — that reading is NOT current". It is the one that most reads as a
  // present-tense verdict, because "mergeable" is the word a reader acts on.
  it("age-stamps a stale row's not-current mergeability too", () => {
    const [c] = evaluateFleetConditions(
      [],
      T0,
      [],
      [pr({ kind: "stale", evidence: "unknown", readingAgeSecs: 5 * 3600 + 52 * 60 })],
    );
    const line = lineFor(c!.text, 1091);
    expect(line).toContain("last known to be mergeable");
    expect(line).toContain("last read 5h 52m ago");
    expect(citable(c!.text, c!.measured)).toBe(true);
  });

  // VERSION SKEW MUST NOT MUTE THE DETECTOR. An older Rust half sends no `readingAgeSecs` at all,
  // and the field is optional precisely so that build keeps reporting: the row loses the age and
  // keeps everything else. Making it mandatory would turn every sweep on a mismatched build into
  // "we did not look" for the whole fleet at once.
  it("still reports a row from a producer that does not send an age", () => {
    const [c] = evaluateFleetConditions([], T0, [], [pr({ evidence: "unknown" })]);
    const line = lineFor(c!.text, 1091);
    expect(line).toContain("NOT current");
    expect(line).not.toContain("last read");
    expect(line).toContain("#1091");
    expect(citable(c!.text, c!.measured)).toBe(true);
  });

  // A SUB-MINUTE AGE IS NOT STALENESS. "last read 0h 0m ago" is noise that would train the reader to
  // ignore the phrase — the exact fate of the qualifier this replaces.
  it("does not stamp an age under a minute", () => {
    const [c] = evaluateFleetConditions([], T0, [], [pr({ evidence: "unknown", readingAgeSecs: 42 })]);
    expect(lineFor(c!.text, 1091)).not.toContain("last read");
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
    // `last-known` IS the "verdict nobody re-read" case: a real, recent reading for this head that
    // GitHub was still recomputing. It is counted in the conflicting aggregate — we have a verdict —
    // so the headline must weaken. (`unknown` is the OTHER thing: no verdict at all. It is no longer
    // in this aggregate, and the could-not-ask block below asserts that directly rather than by the
    // absence of one phrase, which would pass against a headline that had dropped the row entirely.)
    const [c] = evaluateFleetConditions([], T0, [], [pr({ evidence: "last-known" }), pr({ pr: 92 })]);
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

// ── "WE COULD NOT ASK" IS NOT "THIS PR IS BLOCKED" (bead sparkle-y0wmnb) ────────────────────────
//
// THE MEASURED DEFECT. A pull request that was fully green, mergeable and level with main sat
// flagged for 22 minutes because one `gh` call exited non-zero. The producer is fail-closed by
// design — an unreadable look still raises a flag, carrying the LAST SUCCESSFUL read's `kind`
// forward — so the row arrived here as `kind: "stale"` and was narrated "behind main and drifting
// further with every merge". That sentence is a verdict about a pull request nobody could reach.
//
// EVERY CASE HERE MOUNTS THE THREE SHAPES TOGETHER, because asserting the new wording on the
// could-not-ask row alone proves nothing about the shapes the rule did not pick: a rule that
// stamped "could not ask" on EVERY row would satisfy a single-shape test while destroying the
// report. The genuinely-conflicting row and the genuinely-stale row are here to fail if it does.
describe("pr-conflicting could-not-ask", () => {
  /** Fully confirmed, first-hand: this PR really is conflicting and really has never been tested. */
  const REALLY_CONFLICTING: ConflictingPr = {
    pr: 700,
    projectId: "project-alpha",
    branch: "sparkle/really-conflicting",
    ownerAgentId: null,
    kind: "conflicting",
    commitsBehind: 220,
    unresolvedSecs: 3 * 60 * 60 + 5 * 60,
    evidence: "no-checks-ran",
  };
  /** Fully confirmed, first-hand: this PR really can merge and really is a long way behind. */
  const REALLY_STALE: ConflictingPr = {
    pr: 800,
    projectId: "project-alpha",
    branch: "sparkle/really-stale",
    ownerAgentId: null,
    kind: "stale",
    commitsBehind: 40,
    unresolvedSecs: 2 * 60 * 60,
    evidence: "n/a",
  };
  /**
   * THE BEAD'S PULL REQUEST, written the way the wire actually looks.
   *
   * `evidence: "unknown"` + `blockedBy` is what Rust emits when the look was REFUSED and there is no
   * same-head verdict to fall back on: `kind` and `commitsBehind` here are the last successful
   * read's values, and that read said green, mergeable, level with main.
   */
  const COULD_NOT_ASK: ConflictingPr = {
    pr: 1953,
    projectId: "project-alpha",
    branch: "sparkle/green-and-mergeable",
    ownerAgentId: null,
    kind: "stale",
    commitsBehind: 0,
    unresolvedSecs: 22 * 60,
    evidence: "unknown",
    blockedBy: "gh-failed",
    readingAgeSecs: 22 * 60,
  };

  const report = (...conflicts: ConflictingPr[]) =>
    evaluateFleetConditions([], T0, [], conflicts)!.find((c) => c.id === "pr-conflicting")!;
  const lineFor = (text: string, n: number) => text.split("\n").find((l) => l.includes(`#${n}`))!;

  // THE CASE THE BEAD IS ABOUT. All three shapes in ONE report, and all three read differently.
  it("renders could-not-ask, genuinely-conflicting and genuinely-stale as three different things", () => {
    const c = report(REALLY_CONFLICTING, REALLY_STALE, COULD_NOT_ASK);
    const unread = lineFor(c.text, 1953);
    const conflicting = lineFor(c.text, 700);
    const staleRow = lineFor(c.text, 800);

    // 1. THE FAILED READ says so first, names the reason, and makes no claim about the PR.
    expect(unread).toContain("COULD NOT ASK GITHUB");
    expect(unread).toContain("gh-failed");
    expect(unread).toContain("may be green and mergeable right now");
    // THE COLLAPSE ITSELF: a transport error used to render as a present-tense verdict.
    expect(unread).not.toContain("drifting further with every merge");
    expect(unread).not.toContain("mergeable, but");

    // 2. THE REAL CONFLICT keeps the strongest sentence it has earned, untouched.
    expect(conflicting).toContain("conflicting, and therefore untested");
    expect(conflicting).toContain("no CI has ever run on it");
    expect(conflicting).not.toContain("COULD NOT ASK GITHUB");

    // 3. THE REAL STALE ROW keeps its present-tense mergeability, untouched.
    expect(staleRow).toContain("mergeable, but 40 commits behind main");
    expect(staleRow).toContain("drifting further with every merge");
    expect(staleRow).not.toContain("COULD NOT ASK GITHUB");

    // And no two of them are the same sentence.
    expect(new Set([unread, conflicting, staleRow]).size).toBe(3);
    expect(citable(c.text, c.measured)).toBe(true);
  });

  // THE AGGREGATE IS A CLAIM TOO. A row nobody read may not be counted into "N cannot merge" or
  // "N are behind main" — folding it in is the same collapse one level up.
  it("counts the unread row separately from the PRs it actually has a verdict for", () => {
    const head = report(REALLY_CONFLICTING, REALLY_STALE, COULD_NOT_ASK).text.split("\n")[0]!;
    expect(head).toContain("1 open PR cannot merge");
    expect(head).toContain("1 more can still merge");
    expect(head).toContain("1 more could not be read at all");
    expect(head).toContain("GitHub could not be asked");
  });

  // NOTHING BUT UNREAD ROWS. The report still goes out — silence is the failure the producer's
  // fail-closed path exists to prevent — but the headline is about our read, not about the PR.
  it("does not narrate an all-unread report as a fleet of stale PRs", () => {
    const c = report(COULD_NOT_ASK);
    const head = c.text.split("\n")[0]!;
    expect(head).toContain("1 open PR could not be read");
    expect(head).not.toContain("behind main and drifting");
    expect(head).not.toContain("cannot merge");
    expect(head).toContain("not evidence that something is wrong");
    expect(citable(c.text, c.measured)).toBe(true);
  });

  // A REMEDY IS AN INSTRUCTION THE READER WILL FOLLOW, so it has to be safe under the condition
  // that produced it. "Rebase onto main and push" is wrong advice for a PR that may be perfectly
  // healthy and that we simply could not reach — and on a branch carrying merge commits a rebase
  // drops them (AGENTS.md, sparkle-pxhaq). The unread remedy names the two things that are true.
  it("never offers the rebase remedy over a PR nobody could read", () => {
    const c = report(COULD_NOT_ASK);
    expect(c.text).not.toMatch(/rebase/i);
    expect(c.text).not.toMatch(/resolvable without judgement/);
    expect(c.text).toContain("open it on GitHub to see the real state");
    expect(c.text).toContain("an expired login or a spent rate limit");
  });

  // THE PAIRED DIRECTION — REQUIRED. The remedy that IS earned must survive: a fix that simply
  // deleted the rebase sentence would pass the case above and cost the report its whole point.
  it("still offers the rebase remedy for a conflict somebody actually read", () => {
    const c = report(REALLY_CONFLICTING, COULD_NOT_ASK);
    expect(c.text).toMatch(/rebase onto main and push/);
    // …and the unread PR's own remedy is there beside it, not replaced by it.
    expect(c.text).toContain("open it on GitHub to see the real state");
    expect(citable(c.text, c.measured)).toBe(true);
  });

  // NEVER DROPPED. Greying out or omitting an unreadable row is the opposite failure, and the
  // producer's contract forbids it by name: during a `gh` outage it would suppress a genuine,
  // recent, still-standing conflict for the whole outage.
  //
  // THIS ONE CANNOT FAIL AGAINST THE CHANGE THAT ADDED IT, AND THAT IS DELIBERATE — it is a
  // REGRESSION GUARD, not evidence for the fix. It passed before this change and passes after it;
  // what it exists to catch is the obvious over-correction, a later edit that "fixes" the confident
  // verdict by suppressing the row. `mutation-check` will call it vacuous against this diff; the
  // six cases above are the ones that prove the behaviour.
  it("still reports the PR, its number, its owner and how old the reading is", () => {
    const c = report(COULD_NOT_ASK);
    const line = lineFor(c.text, 1953);
    expect(line).toContain("#1953");
    expect(line).toContain("sparkle/green-and-mergeable");
    expect(line).toContain("Owner unresolved");
    expect(line).toContain("last read 0h 22m ago");
    expect(citable(c.text, c.measured)).toBe(true);
  });

  // A LAST-KNOWN CONFLICT WE COULD NOT RE-READ still says what it last was — the failed read does
  // not erase the verdict, it only stops it being spoken in the present tense.
  it("keeps the last known conflicting verdict on an unreadable row, in the past tense", () => {
    const c = report({ ...COULD_NOT_ASK, kind: "conflicting", commitsBehind: 12 });
    const line = lineFor(c.text, 1953);
    expect(line).toContain("COULD NOT ASK GITHUB");
    expect(line).toContain("The last look that got an answer says conflicting, and therefore untested");
    expect(line).toContain("12 commits behind main when we last managed to look");
    expect(citable(c.text, c.measured)).toBe(true);
  });

  // ── THE OVER-CORRECTION, AND ITS PAIR (roborev 75149) ────────────────────────────────────────
  //
  // THE MEASURED DEFECT, one level up from the one this describe block was written for. `couldNotAsk`
  // is reached only on a BLIND look over STORED facts — `conflict_watch::blind_facts` clones the last
  // successful read — so an unread row's `kind` is the verdict of a look that DID get an answer. The
  // first fix made the unread class FLAT: every unread row got the "any of these may be green and
  // mergeable right now" headline and the "nothing can be fixed by touching the branch" remedy,
  // whatever it last read. Through the six-hour `gh` outage this module documents — five PRs each
  // read hours earlier as conflicting, 220 behind, never tested — that headline drops the conflict
  // count entirely and that remedy tells the reader the one thing that WOULD clear it is the wrong
  // thing to do, for six hours. Keeping the row while stripping its count and inverting its advice
  // suppresses the conflict exactly as effectively as dropping the row would, which the producer's
  // evidence contract forbids by name: `"unknown"` licenses "we cannot vouch for this verdict",
  // never "there is no verdict".
  //
  // BOTH SHAPES ARE MOUNTED IN EVERY CASE BELOW, and the assertion is that they RENDER DIFFERENTLY.
  // Asserting the new wording on the conflicting shape alone proves nothing about the shape the rule
  // did not pick: a rule that stamped the conflicting wording on EVERY unread row would satisfy a
  // single-shape test while destroying the report the cases above build.
  const outage = (n: number, kind: ConflictingPr["kind"]) =>
    Array.from({ length: n }, (_, i) => ({
      ...COULD_NOT_ASK,
      pr: 1900 + i,
      branch: `sparkle/blinded-${i}`,
      kind,
      commitsBehind: 220,
    }));

  it("keeps the conflict count in an all-unread headline when that is what the rows last read", () => {
    const conflictingOutage = report(...outage(5, "conflicting"));
    const staleOutage = report(...outage(5, "stale"));
    const headC = conflictingOutage.text.split("\n")[0]!;
    const headS = staleOutage.text.split("\n")[0]!;

    // 1. THE CONFLICT IS STILL COUNTED. Five rows nobody could re-read, five verdicts that were real
    //    and recent when they were taken — the number IS the disclosure.
    expect(headC).toContain("5 open PRs could not be read");
    expect(headC).toContain("5 were last known to be conflicting and therefore untested");
    // …and the sentence that would contradict all five is not said over them.
    expect(headC).not.toContain("may be green and mergeable right now");
    expect(headC).not.toContain("nothing below is a verdict");

    // 2. THE STALE OUTAGE KEEPS THE ABSOLUTE WORDING, which is true of it and of nothing else.
    expect(headS).toContain("5 open PRs could not be read");
    expect(headS).toContain("nothing below is a verdict");
    expect(headS).toContain("any of these may be green and mergeable right now");
    expect(headS).not.toContain("conflicting");

    // 3. AND THE TWO SHAPES ARE NOT THE SAME SENTENCE.
    expect(headC).not.toEqual(headS);
    expect(citable(conflictingOutage.text, conflictingOutage.measured)).toBe(true);
    expect(citable(staleOutage.text, staleOutage.measured)).toBe(true);
  });

  it("still names a catch-up remedy for unread PRs that were last known to be conflicting", () => {
    const conflictingOutage = report(...outage(5, "conflicting"));
    const staleOutage = report(...outage(5, "stale"));

    // CONDITIONED, NOT WITHDRAWN: act on the verdict, look before you rewrite anything, and name BOTH
    // catch-up verbs — a bare "rebase" drops the merge commits a branch may carry (sparkle-pxhaq),
    // which is the same shape of unsafe advice one size down.
    expect(conflictingOutage.text).toContain("5 unread PRs were last known to be conflicting");
    expect(conflictingOutage.text).toContain("open them on GitHub first, because we could not re-read them");
    expect(conflictingOutage.text).toContain("catching the branch up onto main is what clears it");
    expect(conflictingOutage.text).toContain(
      "Merge origin/main when the branch carries merge commits; rebase onto it otherwise.",
    );
    // The absolute withdrawal is NOT said over them — that is the inversion this case exists to catch.
    expect(conflictingOutage.text).not.toContain("can be fixed by touching the branch");
    // Fixing `gh` is still true of every unread row, whichever half it fell in.
    expect(conflictingOutage.text).toContain("an expired login or a spent rate limit");

    // THE PAIR. The stale outage keeps the absolute remedy and is offered no catch-up verb at all —
    // rewriting a branch we merely failed to reach is the advice the first fix correctly removed.
    expect(staleOutage.text).toContain("can be fixed by touching the branch");
    expect(staleOutage.text).toContain("an expired login or a spent rate limit");
    expect(staleOutage.text).not.toMatch(/rebase/i);
    expect(staleOutage.text).not.toContain("catching the branch up");
    expect(conflictingOutage.text).not.toEqual(staleOutage.text);
    expect(citable(conflictingOutage.text, conflictingOutage.measured)).toBe(true);
    expect(citable(staleOutage.text, staleOutage.measured)).toBe(true);
  });

  // A MIXED REPORT DISCLOSES THE SAME FACT ONE LEVEL DOWN. When there IS a first-hand verdict to
  // headline, the unread rows are a clause rather than the sentence — and the conflicting half of
  // that clause is still counted, so it cannot be read as "N rows about which nothing is known".
  it("counts the last-known-conflicting unread rows inside a mixed report's clause", () => {
    const c = report(REALLY_STALE, ...outage(2, "conflicting"), COULD_NOT_ASK);
    const head = c.text.split("\n")[0]!;
    expect(head).toContain("3 more could not be read at all");
    expect(head).toContain("Of the unread, 2 were last known to be conflicting and therefore untested");
    // Both unread halves get their own remedy, and neither is spoken over the other's rows.
    expect(c.text).toContain("2 unread PRs were last known to be conflicting");
    expect(c.text).toContain("Nothing on the unread PR last known to merge can be fixed by touching the branch");
    expect(citable(c.text, c.measured)).toBe(true);
  });

  // WHOSE HOLD IS IT? `blockedBy` on a row we could not re-read is what stopped US, and rendering it
  // as "Blocked by: …" makes it read as a property of the pull request — the same collapse, smaller.
  it("does not call our own failed read a hold on the pull request", () => {
    const c = report({ ...COULD_NOT_ASK, evidence: "last-known-unconfirmed", blockedBy: "sweep-budget" });
    const line = lineFor(c.text, 1953);
    expect(line).toContain("We could not re-read it: sweep-budget.");
    expect(line).not.toContain("Blocked by: sweep-budget.");
    expect(citable(c.text, c.measured)).toBe(true);
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
      { queued: 6, liveAgents: 0, oldestAt: T0 - 12 * 60_000 },
    );
    expect(conditions.map((c) => c.id)).toEqual([
      "quota-blocked",
      "shared-failure",
      "died-holding-work",
      "queue-unfanned",
      "duty-overdue",
      "pr-conflicting",
      "goals-escalated",
      "done-not-retired",
    ]);
    for (const c of conditions) {
      expect(c.members.length, `${c.id} publishes no fingerprint`).toBeGreaterThan(0);
      // Namespaced, so two classes can never collide on a bare id.
      for (const m of c.members) expect(m).toMatch(/^(agent|duty|pr|concierge):/);
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

  it("fingerprints the concierge queue by its depth, which is the only identity a queue has", () => {
    const [c] = evaluateFleetConditions([], T0, [], undefined, {
      queued: 6,
      liveAgents: 0,
      oldestAt: T0 - 12 * 60_000,
    });
    expect(c!.agentIds).toEqual([]);
    expect(c!.members).toEqual(["concierge:queue", "concierge:queue:depth-2", "concierge:queue:depth-5"]);
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
