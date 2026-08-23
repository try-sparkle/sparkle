import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the IPC binding + the store so the NO-OPTIONS production path (the defaulted seams) is what
// the last test drives — not an injected mock. Hoisted refs so the factories can close over them.
const autosaveWorktreeWip = vi.fn();
const getProjectsState = vi.fn();
vi.mock("./worktree", () => ({
  autosaveWorktreeWip: (...a: unknown[]) => autosaveWorktreeWip(...a),
}));
vi.mock("../stores/projectStore", () => ({
  useProjectStore: { getState: () => ({ projects: getProjectsState() }) },
}));

import {
  autosaveCandidates,
  filterOwnedCandidates,
  sweepOnce,
  startWorkerAutosave,
  stopWorkerAutosave,
  isWorkerAutosaveRunning,
  AUTOSAVE_INTERVAL_MS,
  type AutosaveCandidate,
  type AutosaveWip,
  type OwnsProject,
} from "./workerAutosave";
import type { Project, AgentTab } from "../types";
import type { AutosaveOutcome } from "./worktree";

function agent(over: Partial<AgentTab>): AgentTab {
  return {
    id: "a1",
    name: "a1",
    kind: "worker",
    parentId: "build1",
    runtime: "local",
    worktreePath: "/wt/a1",
    branch: "sparkle/a1",
    baseBranch: "main",
    lastPrompt: "",
    promptHistory: [],
    ...over,
  } as AgentTab;
}

function project(id: string, agents: AgentTab[]): Project {
  return {
    id,
    name: id,
    rootPath: `/repo/${id}`,
    defaultBranch: "main",
    createdAt: "2026-01-01",
    agents,
    selectedAgentId: null,
  } as Project;
}

const snapshotted = (files = 3): Promise<AutosaveOutcome> =>
  Promise.resolve({ kind: "snapshotted", sha: "deadbeef", refName: "refs/sparkle-autosave/a1", files });
const clean = (): Promise<AutosaveOutcome> =>
  Promise.resolve({ kind: "nothing-to-commit", sha: null, refName: null, files: 0 });
const midOp = (): Promise<AutosaveOutcome> =>
  Promise.resolve({ kind: "skipped-mid-operation", sha: null, refName: null, files: 0 });

const ownsAll: OwnsProject = async () => true;

beforeEach(() => {
  autosaveWorktreeWip.mockReset();
  getProjectsState.mockReset();
});
afterEach(() => {
  stopWorkerAutosave();
  vi.useRealTimers();
});

describe("autosaveCandidates (enumeration)", () => {
  it("includes a worker that has a worktree", () => {
    expect(autosaveCandidates([project("p1", [agent({ id: "w1", worktreePath: "/wt/w1" })])])).toEqual([
      { projectId: "p1", agentId: "w1" },
    ]);
  });

  it("includes a build agent that has a worktree", () => {
    expect(
      autosaveCandidates([project("p1", [agent({ id: "b1", kind: "build", parentId: null })])]),
    ).toEqual([{ projectId: "p1", agentId: "b1" }]);
  });

  it("SKIPS an agent with no worktree (nothing to snapshot)", () => {
    expect(autosaveCandidates([project("p1", [agent({ id: "w1", worktreePath: null })])])).toEqual([]);
  });

  it("SKIPS a shell terminal even if it has a worktree", () => {
    expect(
      autosaveCandidates([
        project("p1", [agent({ id: "s1", kind: "shell", parentId: null, worktreePath: "/wt/s1" })]),
      ]),
    ).toEqual([]);
  });

  it("spans multiple projects", () => {
    expect(
      autosaveCandidates([
        project("p1", [agent({ id: "w1", worktreePath: "/wt/w1" })]),
        project("p2", [agent({ id: "w2", worktreePath: "/wt/w2" })]),
      ]),
    ).toEqual([
      { projectId: "p1", agentId: "w1" },
      { projectId: "p2", agentId: "w2" },
    ]);
  });
});

describe("filterOwnedCandidates (window ownership)", () => {
  it("keeps only candidates whose project this window owns", async () => {
    const cands: AutosaveCandidate[] = [
      { projectId: "mine", agentId: "w1" },
      { projectId: "theirs", agentId: "w2" },
    ];
    const owns: OwnsProject = async (pid) => pid === "mine";
    expect(await filterOwnedCandidates(cands, owns)).toEqual([{ projectId: "mine", agentId: "w1" }]);
  });

  it("resolves ownership ONCE per distinct project, not per candidate", async () => {
    const cands: AutosaveCandidate[] = [
      { projectId: "p1", agentId: "w1" },
      { projectId: "p1", agentId: "w2" },
      { projectId: "p2", agentId: "w3" },
    ];
    const owns = vi.fn<OwnsProject>().mockResolvedValue(true);
    await filterOwnedCandidates(cands, owns);
    expect(owns).toHaveBeenCalledTimes(2);
  });

  it("treats a throwing ownership probe as NOT mine (at-most-one-handler default)", async () => {
    const owns: OwnsProject = async () => {
      throw new Error("probe failed");
    };
    expect(await filterOwnedCandidates([{ projectId: "p1", agentId: "w1" }], owns)).toEqual([]);
  });
});

describe("sweepOnce (the side effect)", () => {
  it("SNAPSHOTS each candidate — asserts the call reaches autosaveWorktreeWip", async () => {
    const autosave = vi.fn<AutosaveWip>().mockReturnValue(snapshotted());
    const r = await sweepOnce(
      [
        { projectId: "p1", agentId: "w1" },
        { projectId: "p1", agentId: "w2" },
      ],
      autosave,
    );
    expect(autosave).toHaveBeenCalledTimes(2);
    expect(autosave).toHaveBeenCalledWith("p1", "w1");
    expect(autosave).toHaveBeenCalledWith("p1", "w2");
    expect(r).toEqual({ swept: 2, snapshotted: 2 });
  });

  it("PAIRED: no candidates ⇒ no snapshot is ever attempted", async () => {
    const autosave = vi.fn<AutosaveWip>().mockReturnValue(snapshotted());
    expect(await sweepOnce([], autosave)).toEqual({ swept: 0, snapshotted: 0 });
    expect(autosave).not.toHaveBeenCalled();
  });

  it("a clean tree is attempted but not counted as a snapshot", async () => {
    const autosave = vi.fn<AutosaveWip>().mockReturnValue(clean());
    const r = await sweepOnce([{ projectId: "p1", agentId: "w1" }], autosave);
    expect(autosave).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ swept: 1, snapshotted: 0 });
  });

  it("a mid-operation worktree is attempted but not counted (left alone by the command)", async () => {
    const autosave = vi.fn<AutosaveWip>().mockReturnValue(midOp());
    const r = await sweepOnce([{ projectId: "p1", agentId: "w1" }], autosave);
    expect(r).toEqual({ swept: 1, snapshotted: 0 });
  });

  it("is best-effort: one candidate rejecting does not stop the others", async () => {
    const autosave = vi
      .fn<AutosaveWip>()
      .mockRejectedValueOnce(new Error("index.lock"))
      .mockReturnValueOnce(snapshotted());
    const r = await sweepOnce(
      [
        { projectId: "p1", agentId: "bad" },
        { projectId: "p1", agentId: "good" },
      ],
      autosave,
    );
    expect(autosave).toHaveBeenCalledTimes(2);
    expect(r).toEqual({ swept: 2, snapshotted: 1 });
  });
});

describe("start/stop lifecycle (the timer drives the side effect)", () => {
  it("on each interval tick, snapshots every owned live worktree — and none before the first tick", async () => {
    vi.useFakeTimers();
    const autosave = vi.fn<AutosaveWip>().mockReturnValue(snapshotted());
    const projects = [project("p1", [agent({ id: "w1", worktreePath: "/wt/w1" })])];

    startWorkerAutosave({ intervalMs: 1000, getProjects: () => projects, autosave, ownsProject: ownsAll });
    expect(isWorkerAutosaveRunning()).toBe(true);
    expect(autosave).not.toHaveBeenCalled(); // no immediate sweep

    await vi.advanceTimersByTimeAsync(1000);
    expect(autosave).toHaveBeenCalledTimes(1);
    expect(autosave).toHaveBeenCalledWith("p1", "w1");

    await vi.advanceTimersByTimeAsync(1000);
    expect(autosave).toHaveBeenCalledTimes(2);
  });

  it("a non-owning window snapshots ZERO candidates", async () => {
    vi.useFakeTimers();
    const autosave = vi.fn<AutosaveWip>().mockReturnValue(snapshotted());
    const projects = [project("p1", [agent({ id: "w1", worktreePath: "/wt/w1" })])];
    startWorkerAutosave({
      intervalMs: 1000,
      getProjects: () => projects,
      autosave,
      ownsProject: async () => false,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(autosave).not.toHaveBeenCalled();
  });

  it("stop halts further ticks", async () => {
    vi.useFakeTimers();
    const autosave = vi.fn<AutosaveWip>().mockReturnValue(snapshotted());
    const projects = [project("p1", [agent({ id: "w1", worktreePath: "/wt/w1" })])];
    startWorkerAutosave({ intervalMs: 1000, getProjects: () => projects, autosave, ownsProject: ownsAll });
    await vi.advanceTimersByTimeAsync(1000);
    expect(autosave).toHaveBeenCalledTimes(1);
    stopWorkerAutosave();
    expect(isWorkerAutosaveRunning()).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(autosave).toHaveBeenCalledTimes(1);
  });

  it("exposes a sane default cadence", () => {
    expect(AUTOSAVE_INTERVAL_MS).toBeGreaterThanOrEqual(60_000);
  });

  // THE DEFAULTED SEAMS: drive startWorkerAutosave() with NO options, so the real defaults
  // (autosaveWorktreeWip via the mocked ./worktree, and the projectStore via the mocked store) are
  // what run. Deleting `opts.autosave ?? autosaveWorktreeWip` or pointing getProjects at the wrong
  // store slice makes THIS test red — the seam is not covered only by injection.
  it("with NO options, reads the real store and calls the real autosave binding", async () => {
    vi.useFakeTimers();
    autosaveWorktreeWip.mockReturnValue(snapshotted());
    getProjectsState.mockReturnValue([project("p1", [agent({ id: "w1", worktreePath: "/wt/w1" })])]);

    startWorkerAutosave({ intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);

    expect(getProjectsState).toHaveBeenCalled();
    expect(autosaveWorktreeWip).toHaveBeenCalledWith("p1", "w1");
  });
});
