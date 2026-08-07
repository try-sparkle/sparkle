// "A NULL OR A THROW MEANS NOTHING WAS CREATED" — HELD BY CONSTRUCTION (roborev 59548, 59562).
//
// Every refusal in `spawnBuildAgentInProject` returns `null` BEFORE `store.addAgent`, so callers are
// entitled to read a non-answer as "the store is as I found it". Past `addAgent` that stops being
// true on its own: `perfStart`, `landInAgent`, `runtimeStore.open` and `attachBrief` all run after a
// real agent exists.
//
// `babysitDispatcher.dispatchOne` is the caller that makes this load-bearing, and it can be hurt in
// BOTH directions, so both are pinned here:
//
//   * Return a truthy id for an agent that will never start, and `dispatchOne` logs "dispatched a
//     driver" and holds the synthetic lease for its full 90-minute stale window — the PR is never
//     babysat, and the row sits mounted-but-briefless holding a capacity slot.
//   * Tear down an agent that IS running, and the lease is released while it works — the next sweep
//     adds a SECOND driver to the same human's pull request.
//
// So the split is by CONSEQUENCE: before the brief is attached, compensate and refuse; after it,
// keep the agent and report.
import { describe, it, expect, beforeEach, vi } from "vitest";

let attachBriefImpl: (id: string, prompt: string) => void = () => {};
let landInAgentImpl: (projectId: string, id: string) => void = () => {};
let createBeadImpl: (...a: unknown[]) => unknown = async () => "bd-new";
const clearBriefSpy = vi.fn();

vi.mock("./agentBrief", () => ({
  attachBrief: (id: string, prompt: string) => attachBriefImpl(id, prompt),
  clearBrief: (...a: unknown[]) => clearBriefSpy(...a),
  briefForLaunch: () => undefined,
  hasUndeliveredBrief: () => false,
  resetAgentBriefs: () => {},
}));
vi.mock("./landInAgent", () => ({
  landInAgent: (projectId: string, id: string) => landInAgentImpl(projectId, id),
}));
vi.mock("./tasks", () => ({ createBeadFull: (...a: unknown[]) => createBeadImpl(...a) }));

import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useSettingsStore } from "../stores/settingsStore";
import { markProjectVisited, resetVisitedProjects } from "./sessionProjects";
import { spawnBuildAgentInProject } from "./buildAgentSpawn";
import { openTraceKinds } from "../perfTrace";
import type { Project } from "../types";

function project(): Project {
  const id = useProjectStore.getState().addProject("Demo", "/tmp/demo");
  return useProjectStore.getState().projects.find((p) => p.id === id)!;
}

// CAPTURED BEFORE ANY TEST STUBS THEM. zustand's `setState` MERGES, and actions live in state, so a
// stub installed by one test survives into every later test in the file — which silently turned the
// `close(id)` pin below into a test that passed because `open` never ran (roborev 59660).
const realOpen = useRuntimeStore.getState().open;
const realRequestComposeFocus = useUiStore.getState().requestComposeFocus;

const agentIds = (projectId: string) =>
  (useProjectStore.getState().projects.find((p) => p.id === projectId)?.agents ?? []).map((a) => a.id);

beforeEach(() => {
  useProjectStore.setState({ projects: [], selectedProjectId: null });
  useRuntimeStore.setState({ branchStatus: {}, workflowStage: {}, openAgentIds: [] });
  useSettingsStore.setState({
    maxConcurrentWorkers: 3,
    effectiveMaxConcurrentWorkers: 3,
    machineMaxConcurrentWorkers: 3,
    concurrencyBound: "cpu",
    concurrencyBasis: "CPU-bound: 18 cores × 2 agents per core",
  });
  resetVisitedProjects();
  // Put the real actions back — see `realOpen`. Without this the file's tests are order-dependent.
  useRuntimeStore.setState({ open: realOpen } as never);
  useUiStore.setState({ requestComposeFocus: realRequestComposeFocus } as never);
  attachBriefImpl = () => {};
  landInAgentImpl = () => {};
  createBeadImpl = async () => "bd-new";
  clearBriefSpy.mockClear();
});

describe("spawnBuildAgentInProject: a failure BEFORE launch leaves nothing behind", () => {
  it("a throw from attachBrief refuses AND removes the row, rather than returning a live-looking id", () => {
    attachBriefImpl = () => {
      throw new Error("attachBrief blew up");
    };
    const p = project();

    const id = spawnBuildAgentInProject(p, { prompt: "watch this PR" });

    // Not merely "it did not throw": the contract is that a non-answer means nothing was created,
    // so the refusal and the empty store have to hold together. Returning an id here is what would
    // make `dispatchOne` hold the lease for 90 minutes over an agent with no prompt.
    expect(id).toBeNull();
    expect(agentIds(p.id)).toEqual([]);
    expect(clearBriefSpy).toHaveBeenCalled();
  });

  it("a throw from the MOUNT step does the same — the damage there is largest, not smallest", () => {
    // `landInAgent` is what mounts the pane and drives the PTY launch. A swallowed failure here is
    // the case where "returns an id" is most obviously a lie: nothing will ever start.
    landInAgentImpl = () => {
      throw new Error("landInAgent blew up");
    };
    const p = project();

    const id = spawnBuildAgentInProject(p, { prompt: "watch this PR" });

    expect(id).toBeNull();
    expect(agentIds(p.id)).toEqual([]);
  });

  it("BACKGROUND too — the only shape the babysit dispatcher produces", () => {
    // The two cases above take the FOREGROUND path, whose mount step is `landInAgent`. Background
    // does not call it at all: it calls `useRuntimeStore.getState().open(id)` directly. So without
    // this, the branch belonging to the one caller that makes this contract load-bearing —
    // `babysitDispatcher.dispatchOne`, which always passes `background: true` — was untested.
    const p = project();
    markProjectVisited(p.id); // background refuses outright for a project not on screen
    useRuntimeStore.setState({
      open: () => {
        throw new Error("open blew up");
      },
    } as never);

    const id = spawnBuildAgentInProject(p, { prompt: "watch this PR", background: true });

    expect(id).toBeNull();
    expect(agentIds(p.id)).toEqual([]);
  });

  it("the teardown also closes the PERSISTED open-set entry, not just the row", () => {
    // The case the two above cannot reach: `open(id)` SUCCEEDS and the brief then throws. `open`
    // writes into `openAgentIds`, which is persisted, so removing the row alone would strand the id
    // in localStorage until something happened to run the reconcile prune — and a reconcile has no
    // row left to match it against.
    attachBriefImpl = () => {
      throw new Error("attachBrief blew up");
    };
    const p = project();
    markProjectVisited(p.id);

    const id = spawnBuildAgentInProject(p, { prompt: "watch this PR", background: true });

    expect(id).toBeNull();
    expect(agentIds(p.id)).toEqual([]);
    // The scenario actually ran: `open` succeeded and the BRIEF is what threw. Without this the test
    // silently degrades into the `open`-throws shape, where `openAgentIds` is empty because nothing
    // was ever added rather than because the teardown removed it.
    expect(clearBriefSpy).toHaveBeenCalled();
    expect(useRuntimeStore.getState().openAgentIds).toEqual([]);
  });

  it("and cancels the perf trace, so a failed spawn cannot haunt the jank monitor", () => {
    // `perfStart` inserts into a module-level map whose only removers are `perfEnd`/`perfCancel`,
    // and neither can ever fire for a torn-down row — the pane that would call them never exists.
    // `openTraceKinds()` is the jank monitor's only attribution channel on macOS WKWebView and
    // reports every entry still in the map, so a leaked entry misattributes every later stall in the
    // session to a spawn that ended long ago, growing monotonically with each failure.
    attachBriefImpl = () => {
      throw new Error("attachBrief blew up");
    };
    const p = project();
    markProjectVisited(p.id);

    expect(spawnBuildAgentInProject(p, { prompt: "watch this PR", background: true })).toBeNull();

    expect(clearBriefSpy).toHaveBeenCalled(); // the intended path ran
    expect(openTraceKinds() ?? "").not.toMatch(/spawn/);
  });
});

describe("spawnBuildAgentInProject: a failure AFTER launch keeps the agent", () => {
  it("returns the id when only the cosmetic tail fails — a running agent is not unmade", () => {
    // PINNED AT A REACHABLE SITE. The obvious candidate — the auto-bead tail — cannot throw
    // synchronously: `createBeadFull` is `async`, so it can only reject, and the existing
    // `.then().catch()` already absorbs that. A mock that throws synchronously there would be
    // testing a shape the real module can never produce, which proves nothing about the branch.
    //
    // `requestComposeFocus` is a real synchronous call that runs AFTER `launched` is set, on the
    // unbriefed foreground spawn. Tearing the row down here would release the babysit lease out from
    // under a driver already replying on a human's PR — the opposite failure, and the worse one.
    const focusSpy = vi.fn(() => {
      throw new Error("requestComposeFocus blew up");
    });
    useUiStore.setState({ requestComposeFocus: focusSpy } as never);
    const p = project();

    const id = spawnBuildAgentInProject(p, {});

    expect(focusSpy).toHaveBeenCalled(); // the throw site really was reached
    expect(id).toBeTruthy();
    expect(agentIds(p.id)).toContain(id);
    expect(clearBriefSpy).not.toHaveBeenCalled();
  });
});
