// The RESEARCH domain, and above all the ONE property it exists to hold: dispatch returns before the
// research is done.
//
// That property is a NEGATIVE — "this code does not wait" — and a negative is exactly the shape that
// produces a vacuous test, so it is asserted three ways rather than once:
//
//   1. through the REGISTRY, with the store module mocked and no deps injected, so the production
//      call site (the one that supplies LIVE_RESEARCH_DEPS) is what runs — not a seam every test
//      replaces. `getResearch` never resolves in that case; the reply must still carry the task.
//   2. at the domain, on a MANUAL CLOCK, with `dispatchResearch` itself never resolving: the call
//      must still settle, as a bounded refusal, rather than hanging until something else gives up.
//   3. by asserting the ops this domain never performs — `deps.get` is never called by `dispatch`.
//
// Both (1) and (2) were confirmed to go RED against a hand-mutated research.ts that awaits the
// child; see PRD/sparkle/concierge-agents.md for the mutations and their output.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ResearchTask } from "../research/types";

// ---------------------------------------------------------------------------------------------
// The store seam — mocked at the MODULE, so the registry's own wiring is what gets exercised
// ---------------------------------------------------------------------------------------------

// Arrow indirection, not a direct binding: a `vi.mock` factory runs during the import phase, before
// these consts initialise. Dereferencing the mock only when the function is CALLED is what makes
// the pattern safe (the same shape registry.test.ts uses).
const dispatchMock = vi.fn<(input: unknown) => Promise<ResearchTask>>();
const listMock = vi.fn<() => Promise<ResearchTask[]>>();
const getMock = vi.fn<(id: string) => Promise<ResearchTask | null>>();
const cancelMock = vi.fn<(id: string) => Promise<ResearchTask>>();

vi.mock("../research/store", async (orig) => ({
  ...(await orig<typeof import("../research/store")>()),
  dispatchResearch: (...a: unknown[]) => dispatchMock(a[0]),
  listResearch: () => listMock(),
  getResearch: (...a: unknown[]) => getMock(a[0] as string),
  cancelResearch: (...a: unknown[]) => cancelMock(a[0] as string),
}));

import {
  DISPATCH_ACK_MS,
  LIVE_RESEARCH_DEPS,
  MAX_RECENT_RESEARCH,
  RESEARCH_OPS,
  RESEARCH_RISK,
  cancelResearchTask,
  dispatchResearchTask,
  getResearchTask,
  listResearchTasks,
  type ResearchDeps,
} from "./research";
import { dispatchConciergeTool, REGISTRY_CODES, type ConciergeToolReply } from "./registry";
import { _resetResearchStoreForTests, useResearchStore } from "../research/store";
import { useProjectStore } from "../../stores/projectStore";

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

const NOW = 1_000_000;

/** A task exactly as research/types.ts describes it — every Option-backed field PRESENT and `null`,
 *  never omitted. A fixture with the keys missing would test a shape the wire cannot produce. */
function task(over: Partial<ResearchTask> = {}): ResearchTask {
  return {
    id: "r1",
    question: "why is CI red on main",
    depth: "quick",
    projectId: null,
    projectRoot: "/tmp/demo",
    status: "running",
    createdAt: NOW,
    startedAt: NOW + 5,
    finishedAt: null,
    findings: null,
    error: null,
    readAt: null,
    ...over,
  };
}

function call(op: string, args: unknown = {}) {
  return { domain: "research", op, args, toolCallId: "tc-research-1" };
}

function refusal(r: ConciergeToolReply): { code: string; message: string } {
  if (r.ok) throw new Error(`expected a refusal, got ok with data ${JSON.stringify(r.data)}`);
  return { code: r.code, message: r.message };
}

function data(r: ConciergeToolReply): Record<string, unknown> {
  if (!r.ok) throw new Error(`expected ok, got ${r.code}: ${r.message}`);
  return r.data as Record<string, unknown>;
}

/** A promise that never settles — the whole point of the cases below. */
function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

/**
 * A manual clock + timer queue, modelled on conciergeProactive.test.ts.
 *
 * Deliberately NOT `vi.useFakeTimers()`: the bound under test is reached through an injected
 * `setTimer`, and a fake-timer harness would also stub timers this module does not own — so a case
 * would pass or fail for reasons outside the code it names.
 */
function harness(over: Partial<ResearchDeps> = {}) {
  let now = NOW;
  let nextHandle = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const cleared: number[] = [];
  const remembered: ResearchTask[] = [];
  const deps: ResearchDeps = {
    dispatch: async () => task(),
    list: async () => [],
    get: async () => null,
    cancel: async () => task({ status: "cancelled", finishedAt: NOW + 9 }),
    now: () => now,
    setTimer: (fn, ms) => {
      const h = ++nextHandle;
      timers.set(h, { at: now + ms, fn });
      return h;
    },
    clearTimer: (h) => {
      cleared.push(h);
      timers.delete(h);
    },
    remember: (t) => {
      remembered.push(t);
    },
    ...over,
  };
  /** Advance the clock, running every timer that comes due, in due order. */
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = target;
  };
  return { deps, advance, pending: () => timers.size, cleared, remembered };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetResearchStoreForTests();
  useProjectStore.setState({ projects: [], selectedProjectId: null } as never);
  // EVERY dispatch needs a resolvable project, because the runner needs a directory to work in and
  // refuses to guess one. Seeded here so each case is about the thing it names rather than about
  // project setup; the cases that are about resolution override it.
  const seeded = useProjectStore.getState().addProject("Seeded", "/tmp/seeded");
  useProjectStore.setState({ selectedProjectId: seeded } as never);
  // Sensible defaults; each case overrides what it is about.
  dispatchMock.mockResolvedValue(task());
  listMock.mockResolvedValue([]);
  getMock.mockResolvedValue(task());
  cancelMock.mockResolvedValue(task({ status: "cancelled", finishedAt: NOW + 9 }));
});

// ---------------------------------------------------------------------------------------------
// 1. Classification
// ---------------------------------------------------------------------------------------------

describe("classification", () => {
  it("publishes exactly the four ops", () => {
    expect([...RESEARCH_OPS]).toEqual(["dispatch", "list", "get", "cancel"]);
  });

  // The founder's explicit call: "no cap, trust the concierge". `routine` derives to `allow` in
  // policy.ts, so this is what stops dispatch becoming an approval prompt per question. If someone
  // reclassifies it as costs-money the derived default flips to `ask` and the feature stops being
  // the thing it was asked for — so the words are pinned here, not just in prose.
  it("makes dispatch and cancel routine (auto-allowed), and the reads read-only", () => {
    expect(RESEARCH_RISK).toEqual({
      dispatch: "routine",
      list: "read-only",
      get: "read-only",
      cancel: "routine",
    });
  });
});

// ---------------------------------------------------------------------------------------------
// 2. THE PROPERTY: dispatch does not block
// ---------------------------------------------------------------------------------------------

describe("dispatch does not wait for the research", () => {
  // (1) Through the REGISTRY, with no injected deps — so LIVE_RESEARCH_DEPS and the route table are
  // what run. `getResearch` never resolves: an implementation that read the task back to see whether
  // it had finished would hang here forever.
  it("settles with the task record even when reading a task back can never resolve", async () => {
    getMock.mockImplementation(() => never<ResearchTask | null>());
    dispatchMock.mockResolvedValue(task({ id: "r-live", status: "running" }));

    const r = await dispatchConciergeTool(call("dispatch", { question: "why is CI red on main" }));

    expect(r.ok).toBe(true);
    expect(data(r)).toMatchObject({
      taskId: "r-live",
      status: "running",
      live: true,
      // Present and null — "not yet", not "this shape has no findings".
      findings: null,
      error: null,
      finishedAt: null,
    });
    // The direct observation behind the property: dispatch performs ONE round trip and never
    // consults the task again.
    expect(getMock).not.toHaveBeenCalled();
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("reports an UNFINISHED task — never a terminal one — as the dispatch result", async () => {
    dispatchMock.mockResolvedValue(task({ id: "r-queued", status: "queued", startedAt: null }));

    const r = await dispatchConciergeTool(call("dispatch", { question: "find the flaky test" }));

    expect(data(r)).toMatchObject({ status: "queued", live: true, startedAt: null });
  });

  // (2) At the domain, on the manual clock, with the DISPATCH round trip itself never answering.
  // A bare `await deps.dispatch(...)` never settles here; the bound is what makes it an answer.
  it("answers within the ack bound when the runner never acknowledges", async () => {
    const h = harness({ dispatch: () => never<ResearchTask>() });

    const pending = dispatchResearchTask(
      { question: "why is CI red", projectId: null, projectRoot: "/tmp/seeded", depth: "quick" },
      h.deps,
    );
    h.advance(DISPATCH_ACK_MS);
    const r = await pending;

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("not-acknowledged");
    // A remedy string is an instruction the reader follows, so it must not be the one that starts a
    // second metered child. It names the READ as the next step and forbids the re-dispatch.
    expect(r.message).toContain("DO NOT");
    expect(r.message).toContain("list");
  });

  it("clears the ack timer once the runner answers, leaving nothing pending", async () => {
    const h = harness({ dispatch: async () => task({ id: "r-fast" }) });

    const r = await dispatchResearchTask(
      { question: "why is CI red", projectId: null, projectRoot: "/tmp/seeded", depth: "quick" },
      h.deps,
    );

    expect(r.ok && r.data.taskId).toBe("r-fast");
    expect(h.pending()).toBe(0);
    expect(h.cleared).toHaveLength(1);
  });

  it("folds the new task into the window's cache so the row does not wait for a poll", async () => {
    dispatchMock.mockResolvedValue(task({ id: "r-cached" }));

    await dispatchConciergeTool(call("dispatch", { question: "who owns the release script" }));

    expect(useResearchStore.getState().byId["r-cached"]?.id).toBe("r-cached");
  });
});

// ---------------------------------------------------------------------------------------------
// 3. `research:dispatch` MUST NOT be granted the raised transport bound
// ---------------------------------------------------------------------------------------------

describe("the MCP transport bound", () => {
  /** The literal body of `const SLOW_CONCIERGE_OPS … new Set…([ … ])` in the mcp-control source. */
  function slowOpsBlock(): string {
    const source = readFileSync(
      fileURLToPath(new URL("../../../../mcp-control/src/tools.ts", import.meta.url)),
      "utf8",
    );
    const start = source.indexOf("const SLOW_CONCIERGE_OPS");
    if (start < 0) throw new Error("could not find `const SLOW_CONCIERGE_OPS` — was it renamed?");
    const end = source.indexOf("]);", start);
    if (end < 0) throw new Error("unterminated SLOW_CONCIERGE_OPS set literal");
    return source.slice(start, end);
  }

  // The extractor must actually have found the set; otherwise the assertion below passes against
  // an empty string and proves nothing.
  it("reads a non-trivial set from the mcp-control source", () => {
    expect(slowOpsBlock()).toContain('"lifecycle:spawn_build_agent"');
  });

  // research:dispatch is the ONE op whose contract is that it returns before its work is done, so
  // the 50s ceiling would buy nothing and cost the fail-fast behaviour a wedged app needs. Nothing
  // else would catch its addition — the set is a plain literal and every entry typechecks.
  it("does not grant research:dispatch the raised ceiling", () => {
    const entries = [...slowOpsBlock().matchAll(/"([a-z_]+:[a-z_]+)"/g)].map((m) => m[1]!);
    expect(entries.length).toBeGreaterThan(3);
    expect(entries.filter((e) => e.startsWith("research:"))).toEqual([]);
  });

  // …and the app-side bound must stay comfortably under the 30s default it is answering ahead of.
  it("keeps the ack bound well under the bridge default", () => {
    expect(DISPATCH_ACK_MS).toBeLessThan(30_000);
  });
});

// ---------------------------------------------------------------------------------------------
// 4. Routing and argument validation
// ---------------------------------------------------------------------------------------------

describe("routing", () => {
  it("routes list, returning what is running and what came back", async () => {
    listMock.mockResolvedValue([
      task({ id: "a", status: "running", createdAt: 10 }),
      task({ id: "b", status: "done", createdAt: 20, finishedAt: 25, findings: "it was the cache" }),
      task({ id: "c", status: "cancelled", createdAt: 30, finishedAt: 31 }),
    ]);

    const d = data(await dispatchConciergeTool(call("list")));

    expect((d.running as { taskId: string }[]).map((t) => t.taskId)).toEqual(["a"]);
    // Newest first, and a cancelled task counts as finished — the founder can see it either way.
    expect((d.recent as { taskId: string }[]).map((t) => t.taskId)).toEqual(["c", "b"]);
    expect(d.totalFinished).toBe(2);
  });

  it("reports the true finished count when `recent` is capped, rather than implying that is all", async () => {
    listMock.mockResolvedValue(
      Array.from({ length: MAX_RECENT_RESEARCH + 4 }, (_, i) =>
        task({ id: `t${i}`, status: "done", createdAt: i, finishedAt: i + 1, findings: "x" }),
      ),
    );

    const d = data(await dispatchConciergeTool(call("list")));

    expect(d.recent).toHaveLength(MAX_RECENT_RESEARCH);
    expect(d.totalFinished).toBe(MAX_RECENT_RESEARCH + 4);
  });

  it("routes get, carrying the findings", async () => {
    getMock.mockResolvedValue(
      task({ id: "r9", status: "done", finishedAt: NOW + 30, findings: "the runner was asleep" }),
    );

    const d = data(await dispatchConciergeTool(call("get", { taskId: "r9" })));

    expect(d).toMatchObject({ taskId: "r9", status: "done", findings: "the runner was asleep" });
    expect(getMock).toHaveBeenCalledWith("r9");
  });

  it("refuses an id it does not hold rather than returning an empty success", async () => {
    getMock.mockResolvedValue(null);

    const r = await dispatchConciergeTool(call("get", { taskId: "ghost" }));

    // "I can't find it" and "it hasn't finished" must not read the same to a model deciding to wait.
    expect(refusal(r).code).toBe("unknown-task");
  });

  it("routes cancel and returns the task, so the caller can read its real state back", async () => {
    cancelMock.mockResolvedValue(task({ id: "r5", status: "cancelled", finishedAt: NOW + 40 }));

    const d = data(await dispatchConciergeTool(call("cancel", { taskId: "r5" })));

    expect(d).toMatchObject({ taskId: "r5", status: "cancelled", live: false });
    expect(cancelMock).toHaveBeenCalledWith("r5");
  });

  it("surfaces a runner failure as a refusal carrying the runner's own sentence", async () => {
    dispatchMock.mockRejectedValue(new Error("no research runner in this build"));

    const r = await dispatchConciergeTool(call("dispatch", { question: "anything" }));

    expect(refusal(r).code).toBe("dispatch-failed");
    expect(refusal(r).message).toContain("no research runner in this build");
  });

  it("refuses an op this domain does not have, listing the ones it does", async () => {
    const r = await dispatchConciergeTool(call("summarise", { taskId: "r1" }));

    expect(refusal(r).code).toBe(REGISTRY_CODES.unknownOp);
    expect(refusal(r).message).toContain("dispatch");
  });
});

describe("argument validation", () => {
  it("refuses a dispatch with no question, NAMING the field", async () => {
    const r = await dispatchConciergeTool(call("dispatch", {}));

    expect(refusal(r).code).toBe(REGISTRY_CODES.badArgs);
    expect(refusal(r).message).toContain("question");
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("refuses an empty question rather than dispatching a blank one", async () => {
    const r = await dispatchConciergeTool(call("dispatch", { question: "" }));

    expect(refusal(r).code).toBe(REGISTRY_CODES.badArgs);
    expect(refusal(r).message).toContain("question");
  });

  it("refuses a question past the cap instead of silently truncating the brief", async () => {
    const r = await dispatchConciergeTool(call("dispatch", { question: "x".repeat(2001) }));

    expect(refusal(r).code).toBe(REGISTRY_CODES.badArgs);
    expect(refusal(r).message).toContain("question");
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("refuses an unknown depth, naming it", async () => {
    const r = await dispatchConciergeTool(call("dispatch", { question: "q", depth: "exhaustive" }));

    expect(refusal(r).code).toBe(REGISTRY_CODES.badArgs);
    expect(refusal(r).message).toContain("depth");
  });

  // STRICT, not stripping: a model must not be able to smuggle a field past the schema and have it
  // silently ignored — the reply would then describe a call nobody made.
  it("REFUSES an unrecognised field rather than dropping it", async () => {
    const r = await dispatchConciergeTool(
      call("dispatch", { question: "q", projectRoot: "/etc" }),
    );

    expect(refusal(r).code).toBe(REGISTRY_CODES.badArgs);
    expect(refusal(r).message).toContain("projectRoot");
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it.each(["get", "cancel"])("refuses %s with no taskId, naming the field", async (op) => {
    const r = await dispatchConciergeTool(call(op, {}));

    expect(refusal(r).code).toBe(REGISTRY_CODES.badArgs);
    expect(refusal(r).message).toContain("taskId");
  });

  it("refuses arguments to list, which takes none", async () => {
    const r = await dispatchConciergeTool(call("list", { projectId: "p1" }));

    expect(refusal(r).code).toBe(REGISTRY_CODES.badArgs);
    expect(refusal(r).message).toContain("projectId");
  });
});

// ---------------------------------------------------------------------------------------------
// 5. Project resolution — the context a MODEL is never allowed to supply
// ---------------------------------------------------------------------------------------------

describe("project resolution", () => {
  it("falls back to the selected project when none is named", async () => {
    const id = useProjectStore.getState().addProject("Demo", "/tmp/demo");
    useProjectStore.setState({ selectedProjectId: id } as never);

    await dispatchConciergeTool(call("dispatch", { question: "q" }));

    expect(dispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: id, depth: "quick" }),
    );
  });

  // A task RECORD may carry a null project (research/types.ts) — a project can be removed after the
  // fact. A DISPATCH may not: the child needs a directory to run in, and the runner refuses to guess
  // one rather than researching an arbitrary tree and answering confidently about it.
  it("refuses to dispatch when there is no project to resolve a root from", async () => {
    useProjectStore.setState({ projects: [], selectedProjectId: null } as never);

    const r = await dispatchConciergeTool(call("dispatch", { question: "q" }));

    expect(refusal(r).code).toBe(REGISTRY_CODES.unknownProject);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  // The ROOT is what the runner actually needs, so it is asserted rather than assumed.
  it("passes the resolved project ROOT, not just its id", async () => {
    await dispatchConciergeTool(call("dispatch", { question: "q" }));

    expect(dispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({ projectRoot: "/tmp/seeded" }),
    );
  });

  // …but a project NAMED and not found is a mistake, not a choice.
  it("refuses a projectId no project has", async () => {
    const r = await dispatchConciergeTool(call("dispatch", { question: "q", projectId: "nope" }));

    expect(refusal(r).code).toBe(REGISTRY_CODES.unknownProject);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("passes depth through when the caller escalates", async () => {
    await dispatchConciergeTool(call("dispatch", { question: "q", depth: "deep" }));

    expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({ depth: "deep" }));
  });
});

// ---------------------------------------------------------------------------------------------
// 6. The production seam
// ---------------------------------------------------------------------------------------------

describe("the live deps", () => {
  // AGENTS.md's defaulted-seam warning: a `deps = LIVE` parameter that every test overrides leaves
  // the one line supplying the real value covered by nothing. The registry cases above run WITHOUT
  // deps, so that line is exercised — and these pin that the domain functions really do default to
  // it rather than to something a refactor swapped in.
  it("is what the domain functions default to", async () => {
    listMock.mockResolvedValue([]);
    await listResearchTasks();
    expect(listMock).toHaveBeenCalledTimes(1);

    getMock.mockResolvedValue(task({ id: "r7" }));
    await getResearchTask("r7");
    expect(getMock).toHaveBeenCalledWith("r7");

    cancelMock.mockResolvedValue(task({ id: "r7", status: "cancelled" }));
    await cancelResearchTask("r7");
    expect(cancelMock).toHaveBeenCalledWith("r7");
  });

  it("uses a real clock and real timers", () => {
    expect(typeof LIVE_RESEARCH_DEPS.now()).toBe("number");
    const h = LIVE_RESEARCH_DEPS.setTimer(() => {}, 1000);
    expect(h).toBeDefined();
    LIVE_RESEARCH_DEPS.clearTimer(h);
  });
});
