// THE APP-GLOBAL `ConciergeQueue` INPUT RIDES `dutyOwner` — roborev 57400, third time.
//
// ══ WHY THIS IS A SEPARATE FILE FROM `pusherRunner.test.ts` ═════════════════════════════════════
// Every other app-global input is asserted there through the SENT TEXT: `duties` by looking for
// "logs + beads backlog" in exactly one message, `conflicts` by looking for "#1091" in exactly one.
// That is the better assertion, and it IS available now — see the next paragraph for why this file
// spent its whole life without it.
//
// ══ AND WHY IT NOW ASSERTS THE SENT TEXT AS WELL (2026-08-13) ══════════════════════════════════
// This suite used to assert ONLY what `decideFleetReport` was handed, on the stated grounds that
// the consuming condition "is being written by a sibling change". That sibling change had already
// landed on `main`, this branch never merged, and the two halves disagreed: the sweep put the
// reading on the input under the key `conciergeQueue` while `FleetReportInput` reads `queue`, so
// every assertion below passed while the value was dropped on the floor and `queue-unfanned` never
// fired once in production.
//
// That is the textbook vacuous shape — the assertions were about the INPUT, and an input can be
// perfectly correct while the mechanism it feeds is unreachable. `the condition actually reaches
// the founder` below is the assertion that closes it: it drives the real evaluator through the real
// sweep and reads the DELIVERED SENTENCE. Run it against the key rename and it goes red.
//
// The input-level assertions are kept rather than replaced. They discriminate "the owner carries it"
// from "everyone carries it", which no single sentence can, and that is a different property:
//
//   *"A duty is APP-GLOBAL — the hourly pass belongs to the app, not to a project — but the report
//   loop below is per project, each with its own `FleetMemory`. Threading the same list into every
//   project raised `duty-overdue` in each of them independently, so with two projects the identical
//   … paragraph was composed twice; and where both resolve to the SAME recipient the founder simply
//   received it twice."*
//
// A queue depth is app-global in exactly that way — there is one concierge per window and it has no
// projectId at all — so handing it to every project is the same bug with a new subject. This stays
// asserted at the input level because it is what discriminates "the owner carries it" from
// "everyone carries it" without depending on any particular sentence being composed.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// THE REAL DECISION, WATCHED — not replaced. Everything else about the sweep has to keep working
// (the two-observation rule, the budget, the cooldowns), so the spy delegates rather than stubbing:
// a stub would make every assertion below a statement about the mock.
const seen = vi.hoisted(() => ({
  reports: [] as Array<{
    snapshots: readonly { agentId: string }[];
    duties: readonly unknown[];
    queue: unknown;
  }>,
}));
vi.mock("@sparkle/core", async (orig) => {
  const actual = await orig<typeof import("@sparkle/core")>();
  return {
    ...actual,
    decideFleetReport: (input: Parameters<typeof actual.decideFleetReport>[0]) => {
      // READ AS A TYPED FIELD, not off an untyped cast. The cast is what let the key rename hide:
      // `(input as {conciergeQueue?: unknown}).conciergeQueue` reads whatever the sweep happens to
      // put there, so the test agreed with the sweep about a name the CONSUMER does not use.
      seen.reports.push({ snapshots: input.snapshots, duties: input.duties, queue: input.queue });
      return actual.decideFleetReport(input);
    },
  };
});

import { sweepPushers, emptyPusherState, type PusherRunnerDeps } from "./pusherRunner";
import { resolvePusherPolicy, type ConciergeQueue } from "@sparkle/core";

const T0 = 1_700_000_000_000;

/**
 * Six messages stacked up behind a running turn, with nothing fanned out. The founder's case,
 * waiting well past `QUEUE_UNFANNED_MIN_AGE_MS`.
 */
const STACKED: ConciergeQueue = { queued: 6, liveAgents: 0, oldestAt: T0 - 12 * 60_000 };

/** Two healthy agents in two projects, both reporting to ONE person. */
function fakeDeps(over: Partial<PusherRunnerDeps> = {}) {
  const sent: Array<{ agentId: string; text: string }> = [];
  const deps: PusherRunnerDeps = {
    now: () => T0,
    policy: () => resolvePusherPolicy({}),
    ownsProject: () => true,
    snapshots: () => [
      { agentId: "a", projectId: "p1", label: "Agent A" },
      { agentId: "b", projectId: "p2", label: "Agent B" },
    ],
    inboxUsage: async (ids) => new Map(ids.map((id) => [id, 0])),
    reportRecipient: () => "boss",
    duties: () => [],
    conflicts: () => undefined,
    conciergeQueue: () => STACKED,
    verifyClaims: async () => new Map(),
    send: async (agentId, text) => {
      sent.push({ agentId, text });
      return true;
    },
    record: () => {},
    ...over,
  };
  return { deps, sent };
}

beforeEach(() => {
  seen.reports.length = 0;
});

describe("the queue is app-global, so exactly ONE project's report carries it", () => {
  it("hands it to one project and withholds it from the other", async () => {
    const { deps } = fakeDeps();
    await sweepPushers(deps, emptyPusherState());
    // Two projects owned ⇒ two report decisions per sweep, and the queue may appear in one.
    expect(seen.reports).toHaveLength(2);
    const carrying = seen.reports.filter((r) => r.queue !== undefined);
    expect(carrying).toHaveLength(1);
    expect(carrying[0]!.queue).toEqual(STACKED);
  });

  it("gives it to the SAME project that carries the app-global duties", async () => {
    // It must ride `dutyOwner` rather than electing an owner of its own. A second election is a
    // second thing that can migrate — and a migration resets that project's two-observation rule
    // and its cooldown, which is what makes a standing condition re-report forever.
    const duty = {
      name: "the hourly improvement pass (logs + beads backlog)",
      intervalMs: 60 * 60_000,
      lastRunAt: T0 - 9 * 60 * 60_000,
    };
    const { deps } = fakeDeps({ duties: () => [duty] });
    await sweepPushers(deps, emptyPusherState());
    // Both inputs arrive on the SAME `decideFleetReport` call. Compared against each other rather
    // than against this test's own opinion about which project ought to win — the election lives in
    // the sweep, and re-deriving it here would just assert the test agrees with itself.
    const carrying = seen.reports.filter((r) => r.queue !== undefined);
    const dutied = seen.reports.filter((r) => r.duties.length > 0);
    expect(carrying).toHaveLength(1);
    expect(dutied).toHaveLength(1);
    expect(carrying[0]!.snapshots).toBe(dutied[0]!.snapshots);
  });

  it("stays with the same project across sweeps", async () => {
    // A migrating owner is the failure the sorted election exists to prevent; asserted here too
    // because the queue is far more volatile than a duty and an owner keyed on it would move often.
    const { deps } = fakeDeps();
    // State is THREADED, not discarded: the owner election reads `state.fleet`'s keys, so two
    // independent sweeps from an empty state would not exercise the thing being asserted.
    const first = await sweepPushers(deps, emptyPusherState());
    await sweepPushers(deps, first);
    const owners = seen.reports
      .filter((r) => r.queue !== undefined)
      .map((r) => r.snapshots.map((s) => s.agentId).join(","));
    expect(owners).toEqual(["a", "a"]);
  });
});

describe("`undefined` is passed through, never coerced", () => {
  it("hands no queue at all when nobody has looked", async () => {
    // No concierge mounted in this window — a torn-off satellite, or the main window before the
    // host's first effect. `{ waiting: 0 }` here would be the fail-OPEN answer: it says the
    // concierge has nothing queued, which is a reason to stay quiet.
    const { deps } = fakeDeps({ conciergeQueue: () => undefined });
    await sweepPushers(deps, emptyPusherState());
    expect(seen.reports).toHaveLength(2);
    expect(seen.reports.every((r) => r.queue === undefined)).toBe(true);
  });

  it("reads the queue ONCE per sweep, so every project's report describes one moment", async () => {
    let reads = 0;
    const { deps } = fakeDeps({
      conciergeQueue: () => {
        reads++;
        return STACKED;
      },
    });
    await sweepPushers(deps, emptyPusherState());
    expect(reads).toBe(1);
  });
});

// ══ THE GOAL TEST — THE ASSERTION THIS SUITE SPENT ITS WHOLE LIFE WITHOUT ═══════════════════════
//
// Everything above asserts what `decideFleetReport` is HANDED. That is a statement about an input,
// and an input can be flawless while the mechanism it feeds is unreachable — which is exactly what
// happened: the sweep wrote the reading under `conciergeQueue`, `FleetReportInput` reads `queue`,
// and the founder's messages stacked six deep while nothing said a word.
//
// This block asserts the SIDE EFFECT: the sentence that lands in the concierge's inbox. It drives
// the real `evaluateFleetConditions`, the real two-observation rule and the real gate, and reads
// `deps.send`. Rename the key back and it goes red; delete the producer and it goes red; break
// `queueUnfanned`'s predicate and it goes red.
describe("the condition actually reaches the founder", () => {
  // TWO SWEEPS, because the two-observation rule is real and the first sighting may not speak. A
  // one-sweep version of this test would fail for a reason that has nothing to do with the wiring,
  // and "it did not send" would then be indistinguishable from the bug being fixed.
  async function sweepTwice(over: Partial<PusherRunnerDeps> = {}) {
    const { deps, sent } = fakeDeps(over);
    const first = await sweepPushers(deps, emptyPusherState());
    await sweepPushers(deps, first);
    return sent;
  }

  it("delivers the founder's sentence, with both numbers in it", async () => {
    const sent = await sweepTwice();
    const report = sent.find((s) => s.text.includes("concierge agents are running"));
    expect(report).toBeDefined();
    // BOTH HALVES. A depth on its own reads as a healthy backlog — it is the pairing with the agent
    // count that makes it a condition, which is why the composer states them together.
    expect(report!.text).toContain("6 messages are queued and 0 concierge agents are running");
    // And the remedy, because a count with no instruction is a number the reader can only watch.
    // A FRAGMENT OF THE REMEDY ITSELF, not `"concierge agents"` — that was a substring of the
    // sentence asserted one line above, so it could not fail, and the entire remedy paragraph could
    // have been deleted with this test still green.
    //
    // THE FRAGMENTS MOVED ONCE, and the reason is worth keeping: the remedy used to say "The queue
    // does not drain itself … Fan them out to concierge agents", which was false and self-defeating
    // — dispatching dequeues nothing and raises `liveAgents` to parity, so obeying it silenced this
    // very condition with every message unanswered (roborev 63598). Asserted end-to-end here, not
    // just in `pusherFleet.test.ts`, because this is the surface the founder actually reads.
    expect(report!.text).toContain("does NOT dequeue anything");
    expect(report!.text).toContain("work started rather than as questions answered");
    expect(report!.text).not.toContain("The queue does not drain itself");
    // It goes to the CONCIERGE, not to a build agent: this is the one class of condition no partner
    // can act on, and `reportRecipient` names the concierge for exactly that reason.
    expect(report!.agentId).toBe("boss");
  });

  // THE COUNTER-CASE, and it is what stops the test above from passing for the wrong reason. A test
  // that only ever asserts presence goes green against a sweep that reports unconditionally.
  it("says NOTHING when there is an agent for every waiting message", async () => {
    const sent = await sweepTwice({
      conciergeQueue: () => ({ queued: 6, liveAgents: 6, oldestAt: T0 - 12 * 60_000 }),
    });
    expect(sent.some((s) => s.text.includes("concierge agents are running"))).toBe(false);
  });

  // The founder's own retune, at the boundary he chose: ONE agent against six waiting messages is
  // the case that used to be silent. If this ever goes green-by-silence again, the zero-test is
  // back.
  it("still speaks when SOME agents are running but fewer than the messages", async () => {
    const sent = await sweepTwice({
      conciergeQueue: () => ({ queued: 6, liveAgents: 1, oldestAt: T0 - 12 * 60_000 }),
    });
    expect(sent.some((s) => s.text.includes("6 messages are queued and 1 concierge agents"))).toBe(
      true,
    );
  });

  // NOBODY LOOKED must stay silent — the fail-closed half. A window with no concierge mounted reads
  // `undefined`, and inventing an empty queue there would raise a false alarm about a concierge
  // that does not exist.
  it("says nothing when nobody looked", async () => {
    const sent = await sweepTwice({ conciergeQueue: () => undefined });
    expect(sent.some((s) => s.text.includes("concierge agents are running"))).toBe(false);
  });
});
