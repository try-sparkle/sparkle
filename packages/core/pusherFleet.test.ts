// THE PROPERTY: a condition the PARTNER cannot act on is measured, quoted verbatim, and citable.
//
// Every case here uses the real banner the founder was shown, because the citation rule is what
// makes or breaks this feature and the rule is sensitive to the exact characters in the string:
// "Aug 4" and "11pm" are numbers the report reproduces but never computed, and a `measured` list
// that misses either gets the whole report refused as `fabricated-citation` — a failure that would
// show up as SILENCE, which is indistinguishable from a healthy fleet.
import { describe, it, expect } from "vitest";
import {
  evaluateFleetConditions,
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
