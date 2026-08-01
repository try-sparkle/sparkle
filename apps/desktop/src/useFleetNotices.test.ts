// THE PROPERTY: the binding reads the right things from the right places.
//
// Everything downstream is already tested as arithmetic in `@sparkle/core`, and `pusherSnapshots`
// pins the field mapping. What ONLY exists here is the wiring — `branchStatus` keyed by `agent.id`,
// the registry lookups bound to the right functions, the settings clock reaching the duty — and that
// is precisely the part the pure tests structurally cannot cover. It is also the part that was
// missing entirely: for three commits the conditions were computed in tests and delivered nowhere.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./engine/engineRegistry", () => ({
  quotaBlockForAgent: vi.fn(() => undefined),
  lastFailureForAgent: vi.fn(() => undefined),
}));

import { fleetNoticesFrom } from "./useFleetNotices";
import { quotaBlockForAgent, lastFailureForAgent } from "./engine/engineRegistry";
import { IMPROVEMENT_INTERVAL_MS } from "./services/improvementPass";
import type { AgentTab, Project } from "./types";
import type { BranchStatus } from "./services/branchStatus";

const T0 = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const OFFLINE = "API Error: Unable to connect to API (ENOTFOUND)";

const agent = (id: string, over: Partial<AgentTab> = {}): AgentTab =>
  ({
    id,
    name: `Agent ${id}`,
    kind: "build",
    parentId: null,
    runtime: "local",
    worktreePath: null,
    branch: null,
    baseBranch: null,
    lastPrompt: "",
    promptHistory: [],
    ...over,
  }) as AgentTab;

const project = (agents: AgentTab[], id = "p"): Project =>
  ({ id, name: id, rootPath: "/tmp", defaultBranch: "main", createdAt: "", agents, selectedAgentId: null }) as Project;

const branch = (over: Partial<BranchStatus> = {}): BranchStatus => ({
  ahead: 0,
  behind: 0,
  dirty: false,
  filesChanged: 0,
  insertions: 0,
  deletions: 0,
  ...over,
});

function inputs(over: Partial<Parameters<typeof fleetNoticesFrom>[0]> = {}) {
  return {
    projects: [project([agent("a")])],
    branchStatus: {},
    improvementLastRunAt: T0, // on time
    improvementHeldBy: undefined,
    now: T0,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(quotaBlockForAgent).mockReturnValue(undefined);
  vi.mocked(lastFailureForAgent).mockReturnValue(undefined);
});

describe("the registry binding", () => {
  it("says nothing about a healthy fleet", () => {
    expect(fleetNoticesFrom(inputs())).toEqual([]);
  });

  // The two lookups are easy to swap, and swapping them is silent: both take an agentId and both
  // return an optional record, so a quota wall would surface as a shared failure and vice versa.
  it("routes the QUOTA lookup to the quota condition", () => {
    vi.mocked(quotaBlockForAgent).mockReturnValue({
      message: "You've hit your weekly limit · resets Aug 4 at 11pm (America/Bogota)",
      resetAt: T0 + 4 * HOUR,
      resetParsed: true,
      at: T0,
    });
    const ids = fleetNoticesFrom(inputs()).map((c) => c.id);
    expect(ids).toEqual(["quota-blocked"]);
  });

  it("routes the FAILURE lookup to the shared-failure condition", () => {
    vi.mocked(lastFailureForAgent).mockReturnValue({ message: OFFLINE, at: T0 });
    const conditions = fleetNoticesFrom(
      inputs({ projects: [project([agent("a"), agent("b")])] }),
    );
    expect(conditions.map((c) => c.id)).toEqual(["shared-failure"]);
    expect(conditions[0]!.text).toContain(OFFLINE);
  });

  it("passes the SAME clock to the quota lookup that the conditions are evaluated at", () => {
    fleetNoticesFrom(inputs({ now: T0 + 999 }));
    expect(vi.mocked(quotaBlockForAgent)).toHaveBeenCalledWith("a", T0 + 999);
  });

  it("asks the registry for each agent by its OWN id", () => {
    fleetNoticesFrom(inputs({ projects: [project([agent("a"), agent("b")])] }));
    const asked = vi.mocked(lastFailureForAgent).mock.calls.map((c) => c[0]);
    expect(asked).toEqual(["a", "b"]);
  });
});

describe("the branchStatus binding", () => {
  // Keyed by `agent.id`. A wrong key reads as "not polled" for every agent, which fails CLOSED —
  // silently, since the retire condition simply never fires and nothing looks broken.
  it("reports a finished agent as safe to retire when its own branch is clean", () => {
    const conditions = fleetNoticesFrom(
      inputs({
        projects: [project([agent("a", { goal: { text: "x", setAt: T0, ttlMs: 1, metAt: T0 } } as Partial<AgentTab>)])],
        branchStatus: { a: branch() },
      }),
    );
    expect(conditions.map((c) => c.id)).toEqual(["done-not-retired"]);
  });

  it("does NOT call it safe to retire when its own branch holds work", () => {
    const conditions = fleetNoticesFrom(
      inputs({
        projects: [project([agent("a", { goal: { text: "x", setAt: T0, ttlMs: 1, metAt: T0 } } as Partial<AgentTab>)])],
        branchStatus: { a: branch({ ahead: 2 }) },
      }),
    );
    expect(conditions).toEqual([]);
  });

  // The fail-closed case with teeth: an unpolled branch must not become "safe to retire".
  it("stays silent when the branch was never polled", () => {
    const conditions = fleetNoticesFrom(
      inputs({
        projects: [project([agent("a", { goal: { text: "x", setAt: T0, ttlMs: 1, metAt: T0 } } as Partial<AgentTab>)])],
        branchStatus: {},
      }),
    );
    expect(conditions).toEqual([]);
  });
});

describe("the standing-duty binding", () => {
  it("reports the hourly pass once it has missed two intervals", () => {
    const conditions = fleetNoticesFrom(
      inputs({ improvementLastRunAt: T0 - 9 * HOUR, now: T0 }),
    );
    expect(conditions.map((c) => c.id)).toEqual(["duty-overdue"]);
    expect(conditions[0]!.text).toContain("logs + beads backlog");
  });

  it("quotes the hold reason the caller supplied", () => {
    const conditions = fleetNoticesFrom(
      inputs({
        improvementLastRunAt: T0 - 9 * HOUR,
        improvementHeldBy: "the Sparkle agent pane reads 'working'",
      }),
    );
    expect(conditions[0]!.text).toContain("Held by: the Sparkle agent pane reads 'working'.");
  });

  // The real cadence, not a test constant — a duty built with the wrong interval would report an
  // on-time pass as overdue, or never report a stopped one.
  it("uses the app's real hourly interval", () => {
    const justUnder = fleetNoticesFrom(
      inputs({ improvementLastRunAt: T0 - (2 * IMPROVEMENT_INTERVAL_MS - 1) }),
    );
    const justOver = fleetNoticesFrom(
      inputs({ improvementLastRunAt: T0 - 2 * IMPROVEMENT_INTERVAL_MS }),
    );
    expect(justUnder).toEqual([]);
    expect(justOver.map((c) => c.id)).toEqual(["duty-overdue"]);
  });

  it("never reports a duty whose clock the scheduler has not seeded", () => {
    expect(fleetNoticesFrom(inputs({ improvementLastRunAt: null }))).toEqual([]);
  });
});

describe("the whole picture", () => {
  it("batches an agent condition and a duty into the same list, most-blocking first", () => {
    vi.mocked(quotaBlockForAgent).mockReturnValue({
      message: "You've hit your weekly limit · resets Aug 4 at 11pm (America/Bogota)",
      resetAt: T0 + 4 * HOUR,
      resetParsed: true,
      at: T0,
    });
    const ids = fleetNoticesFrom(inputs({ improvementLastRunAt: T0 - 9 * HOUR })).map((c) => c.id);
    expect(ids).toEqual(["quota-blocked", "duty-overdue"]);
  });
});
