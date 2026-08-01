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
  evaluateFleetConditions,
  sharedFailureCohorts,
  isQuotaWalled,
  persistedConditions,
  quotedNumbers,
  retirableAgents,
  type FleetSnapshot,
} from "./pusherFleet";
import { checkCitations } from "./pusherGate";

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
      [{ agentId: "a", label: "Finished One", goalMetAt: T0 - HOUR, hasUnlandedWork: false }],
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
});

describe("ordering and persistence", () => {
  it("reports quota first — it is the one condition where retrying is actively wrong", () => {
    const ids = evaluateFleetConditions(
      [
        { agentId: "c", goalMetAt: T0, hasUnlandedWork: false },
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
