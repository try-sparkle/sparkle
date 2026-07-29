// The two holes roborev 54743 found in the `new` de-escalation, both of which the original suite
// missed for the same reason: every test injected a clock, so nothing ever asked what wakes the
// clock up, and nothing drove the un-briefed → briefed transition.
import { describe, expect, it } from "vitest";

import { newlyEntered, type StatusMap } from "./attention";
import {
  NEW_AGENT_GRACE_MS,
  isDemonstratedAsk,
  nextGraceExpiry,
  withNewAgentCalm,
  type BriefableAgent,
} from "./newAgentAttention";

const T0 = 1_700_000_000_000;

const agent = (over: Partial<BriefableAgent> = {}): BriefableAgent => ({
  id: "a1",
  lastPrompt: "",
  promptHistory: [],
  createdAt: T0,
  ...over,
});

describe("nextGraceExpiry — the backstop needs something to wake it", () => {
  it("reports when a held `errored` red is due to surface", () => {
    // THE CASE THE WINDOW EXISTS FOR. An errored agent emits no further status writes, so without a
    // deadline to schedule against, the memo holding it at `new` would never recompute and the row
    // would stay gray forever — silently contradicting NEW_AGENT_GRACE_MS's own promise.
    expect(nextGraceExpiry([agent()], { a1: "errored" }, T0)).toBe(T0 + NEW_AGENT_GRACE_MS);
  });

  it("returns the SOONEST deadline when several are held", () => {
    const agents = [
      agent({ id: "a1", createdAt: T0 + 60_000 }),
      agent({ id: "a2", createdAt: T0 }), // spawned earliest → surfaces first
      agent({ id: "a3", createdAt: T0 + 30_000 }),
    ];
    const map: StatusMap = { a1: "errored", a2: "errored", a3: "errored" };
    expect(nextGraceExpiry(agents, map, T0)).toBe(T0 + NEW_AGENT_GRACE_MS);
  });

  it("reports NOTHING for the untimed branch — `blocked`/`idle` never expire", () => {
    // These map to `new` unconditionally (a never-briefed agent is never-briefed at any age), so
    // arming a timer for them would be a wake-up that changes nothing.
    expect(nextGraceExpiry([agent()], { a1: "blocked" }, T0)).toBeNull();
    expect(nextGraceExpiry([agent()], { a1: "idle" }, T0)).toBeNull();
  });

  it("reports nothing once the window has already closed", () => {
    expect(nextGraceExpiry([agent()], { a1: "errored" }, T0 + NEW_AGENT_GRACE_MS + 1)).toBeNull();
  });

  it("reports nothing for a briefed agent, an ask, or a row with no spawn stamp", () => {
    expect(nextGraceExpiry([agent({ lastPrompt: "go" })], { a1: "errored" }, T0)).toBeNull();
    expect(nextGraceExpiry([agent()], { a1: "waiting" }, T0)).toBeNull();
    expect(nextGraceExpiry([agent({ createdAt: undefined })], { a1: "errored" }, T0)).toBeNull();
  });

  it("agrees with the overlay it schedules for: held before, surfaced after", () => {
    const a = [agent()];
    const map: StatusMap = { a1: "errored" };
    const due = nextGraceExpiry(a, map, T0)!;
    expect(withNewAgentCalm(a, map, due - 1).a1).toBe("new");
    expect(withNewAgentCalm(a, map, due).a1).toBe("errored");
  });
});

describe("newlyEntered — leaving `new` is a re-baseline, not an entry", () => {
  const enabled = new Set(["idle", "waiting", "approval", "errored", "blocked"] as const);
  const ids = ["a1"];

  it("does NOT fire 'your turn' when a briefless agent is finally briefed", () => {
    // THE REGRESSION THIS GUARDS. `new` is an overlay: briefing an agent flips the published value
    // `new` → `idle` while the RAW status never moved. That synthetic edge into `idle` — which
    // notifies by default — would ping "Finished — your turn" about an agent that just STARTED,
    // recreating the exact false notification the `new` status was introduced to remove.
    expect(newlyEntered({ a1: "new" }, { a1: "idle" }, ids, enabled as never)).toEqual([]);
  });

  it("also stays quiet for new → blocked, the other untimed mapping", () => {
    expect(newlyEntered({ a1: "new" }, { a1: "blocked" }, ids, enabled as never)).toEqual([]);
  });

  it("STILL fires on new → errored — the edge the 5-minute backstop exists to produce", () => {
    // THE HIGH FINDING (roborev 54830). The guard first read "not a demonstrated ask", which also
    // swallowed this. `errored` is terminal — the runtime store skips unchanged writes — so dropping
    // it meant NO banner and NO phone push, EVER, for a briefless agent that crashed inside the
    // grace window. That is the timer machinery negated by the guard meant to support it.
    expect(newlyEntered({ a1: "new" }, { a1: "errored" }, ids, enabled as never)).toEqual([
      { id: "a1", status: "errored" },
    ]);
  });

  it("STILL fires when the agent leaves `new` by actually asking something", () => {
    // The point is to drop synthetic edges, not to muffle real questions. `waiting`/`approval` are
    // never overlaid onto `new` in the first place, so an edge into one of them is genuine.
    expect(newlyEntered({ a1: "new" }, { a1: "waiting" }, ids, enabled as never)).toEqual([
      { id: "a1", status: "waiting" },
    ]);
    expect(newlyEntered({ a1: "new" }, { a1: "approval" }, ids, enabled as never)).toEqual([
      { id: "a1", status: "approval" },
    ]);
  });

  it("leaves every other transition exactly as it was — no regression to real notifications", () => {
    expect(newlyEntered({ a1: "working" }, { a1: "idle" }, ids, enabled as never)).toEqual([
      { id: "a1", status: "idle" },
    ]);
    expect(newlyEntered({ a1: "working" }, { a1: "errored" }, ids, enabled as never)).toEqual([
      { id: "a1", status: "errored" },
    ]);
    // A first observation still fires — an id absent from `prev` is an entry.
    expect(newlyEntered({}, { a1: "waiting" }, ids, enabled as never)).toEqual([
      { id: "a1", status: "waiting" },
    ]);
  });
});

describe("isDemonstratedAsk", () => {
  it("is exactly the two statuses that prove the agent asked something", () => {
    expect(isDemonstratedAsk("waiting")).toBe(true);
    expect(isDemonstratedAsk("approval")).toBe(true);
    for (const s of ["idle", "blocked", "errored", "working", "new", "stopped"] as const) {
      expect(isDemonstratedAsk(s)).toBe(false);
    }
    expect(isDemonstratedAsk(undefined)).toBe(false);
  });
});
