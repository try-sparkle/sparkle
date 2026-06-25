import { describe, it, expect, beforeEach, vi } from "vitest";

// zustand's persist middleware needs a Web Storage. Node/vitest has none, so we
// install a minimal in-memory one and re-import the store fresh per test (the
// store hydrates from storage at creation, so each case starts clean / seeded).
class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}

const STORE_KEY = "sparkle-runtime";

// Mocked branch-status backend so pollBranchStatus tests don't touch Tauri/git.
const agentBranchStatus = vi.fn();
vi.mock("../services/branchStatus", () => ({
  agentBranchStatus: (...a: unknown[]) => agentBranchStatus(...a),
}));

// Mocked Chief sync so the store-glue tests don't touch Tauri/Chief.
const syncAgentMarkdown = vi.fn();
vi.mock("../services/chiefSync", () => ({
  syncAgentMarkdown: (...a: unknown[]) => syncAgentMarkdown(...a),
  MARKDOWN_DIRS: ["PRD", "docs/superpowers/specs"],
}));

async function freshStore() {
  vi.resetModules();
  const mod = await import("./runtimeStore");
  return mod.useRuntimeStore;
}

// Fresh runtime + settings + project stores from the SAME post-reset module graph, so state set
// on these instances is the state `syncMarkdownToChief` reads.
async function freshModules() {
  vi.resetModules();
  const runtime = await import("./runtimeStore");
  const settings = await import("./settingsStore");
  const projects = await import("./projectStore");
  return { runtime, settings, projects };
}

beforeEach(() => {
  agentBranchStatus.mockReset();
  syncAgentMarkdown.mockReset();
  (globalThis as unknown as { localStorage: Storage }).localStorage =
    new MemoryStorage() as unknown as Storage;
});

describe("runtimeStore — persist + reconcile ()", () => {
  it("reconcile keeps only agent ids that still exist", async () => {
    const useRuntimeStore = await freshStore();
    const { open, reconcile } = useRuntimeStore.getState();
    open("a");
    open("b");
    open("c");

    reconcile(["a", "c"]); // "b" was deleted from projects

    expect(useRuntimeStore.getState().openAgentIds).toEqual(["a", "c"]);
  });

  it("persists openAgentIds but NOT live status", async () => {
    const useRuntimeStore = await freshStore();
    const { open, setStatus } = useRuntimeStore.getState();
    open("a");
    setStatus("a", "working");

    const persisted = JSON.parse(localStorage.getItem(STORE_KEY) as string);
    expect(persisted.state.openAgentIds).toContain("a");
    // status is live-only — it must never be restored on next launch.
    expect(persisted.state.status).toBeUndefined();
    // branchStatus is live-only too — it must never be persisted.
    expect(persisted.state.branchStatus).toBeUndefined();
  });

  it("restores openAgentIds from storage on next launch", async () => {
    // Simulate a prior session having persisted two open agents.
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({ state: { openAgentIds: ["x", "y"] }, version: 0 }),
    );

    const useRuntimeStore = await freshStore();

    expect(useRuntimeStore.getState().openAgentIds).toEqual(["x", "y"]);
    // status / branchStatus always boot clean regardless of what was stored.
    expect(useRuntimeStore.getState().status).toEqual({});
    expect(useRuntimeStore.getState().branchStatus).toEqual({});
  });
});

describe("runtimeStore branch status", () => {
  it("pollBranchStatus stores the fetched status", async () => {
    const useRuntimeStore = await freshStore();
    const s = { ahead: 1, behind: 3, dirty: false, filesChanged: 2, insertions: 9, deletions: 1 };
    agentBranchStatus.mockResolvedValue(s);
    await useRuntimeStore.getState().pollBranchStatus("/root", "p1", "a1", "main");
    expect(useRuntimeStore.getState().branchStatus["a1"]).toEqual(s);
    expect(agentBranchStatus).toHaveBeenCalledWith("/root", "p1", "a1", "main");
  });

  it("pollBranchStatus swallows errors (no throw, no store change)", async () => {
    const useRuntimeStore = await freshStore();
    agentBranchStatus.mockRejectedValue(new Error("git boom"));
    await expect(
      useRuntimeStore.getState().pollBranchStatus("/root", "p1", "a1", "main"),
    ).resolves.toBeUndefined();
    expect(useRuntimeStore.getState().branchStatus["a1"]).toBeUndefined();
  });

  it("pollBranchStatus retains a pre-existing status when a later poll fails", async () => {
    const useRuntimeStore = await freshStore();
    const old = { ahead: 5, behind: 0, dirty: true, filesChanged: 1, insertions: 1, deletions: 0 };
    useRuntimeStore.setState({ branchStatus: { a1: old } });
    agentBranchStatus.mockRejectedValue(new Error("git boom"));
    await useRuntimeStore.getState().pollBranchStatus("/root", "p1", "a1", "main");
    expect(useRuntimeStore.getState().branchStatus["a1"]).toEqual(old);
  });
});

describe("syncMarkdownToChief — store glue ()", () => {
  // Seed a connected PAT + a project with one agent of the given kind; returns ids + handles.
  async function setup(kind: "build" | "brainstorm") {
    const { runtime, settings, projects } = await freshModules();
    settings.useSettingsStore.getState().setChiefPat("pat_x");
    const projectId = projects.useProjectStore.getState().addProject("Sparkle-Desktop", "/root");
    const agentId = projects.useProjectStore.getState().addAgent(projectId, { kind });
    return { runtime, settings, projectId, agentId };
  }

  it("skips Brainstorm agents (they have no worktree / commits)", async () => {
    const { runtime, projectId, agentId } = await setup("brainstorm");
    await runtime.syncMarkdownToChief(projectId, agentId);
    expect(syncAgentMarkdown).not.toHaveBeenCalled();
  });

  it("does nothing without a connected PAT", async () => {
    const { runtime, settings, projectId, agentId } = await setup("build");
    settings.useSettingsStore.setState({ chiefPat: "" });
    await runtime.syncMarkdownToChief(projectId, agentId);
    expect(syncAgentMarkdown).not.toHaveBeenCalled();
  });

  it("persists a newly-created Chief project id and advances the agent's watermark", async () => {
    const { runtime, settings, projectId, agentId } = await setup("build");
    syncAgentMarkdown.mockResolvedValue({
      headSha: "head1",
      uploaded: ["PRD/main.md @ head1"],
      chiefProjectId: "project_created",
    });

    await runtime.syncMarkdownToChief(projectId, agentId);

    // Passed the stored marker (none yet) + project name through to the sync service.
    expect(syncAgentMarkdown).toHaveBeenCalledWith(
      expect.objectContaining({ pat: "pat_x", projectName: "Sparkle-Desktop", agentId }),
    );
    expect(settings.useSettingsStore.getState().chiefProjectByProject[projectId]).toBe(
      "project_created",
    );
    expect(settings.useSettingsStore.getState().chiefSyncByAgent[agentId]).toBe("head1");
  });

  it("runs only one sync per agent at a time (no create-create race)", async () => {
    const { runtime, projectId, agentId } = await setup("build");
    let release!: () => void;
    syncAgentMarkdown.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ headSha: "h", uploaded: [], chiefProjectId: "p" });
      }),
    );

    const first = runtime.syncMarkdownToChief(projectId, agentId); // takes the lock, awaits
    await runtime.syncMarkdownToChief(projectId, agentId); // sees in-flight, returns immediately

    expect(syncAgentMarkdown).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it("backs off a failing endpoint, then retries after the cooldown and resets on success ()", async () => {
    const { runtime, projectId, agentId } = await setup("build");
    runtime.__resetChiefSyncBackoff();
    vi.useFakeTimers();
    try {
      // First tick: the endpoint is unreachable → throws, arming the backoff (base 5s).
      syncAgentMarkdown.mockRejectedValueOnce(new TypeError("Load failed"));
      await runtime.syncMarkdownToChief(projectId, agentId);
      expect(syncAgentMarkdown).toHaveBeenCalledTimes(1);

      // A tick well within the cooldown is skipped entirely — no second fetch at the dead endpoint.
      vi.advanceTimersByTime(1_000);
      await runtime.syncMarkdownToChief(projectId, agentId);
      expect(syncAgentMarkdown).toHaveBeenCalledTimes(1);

      // Past the cooldown the sync is attempted again; this time it succeeds and clears the backoff.
      vi.advanceTimersByTime(5_000);
      syncAgentMarkdown.mockResolvedValueOnce({ headSha: "h", uploaded: [], chiefProjectId: "p" });
      await runtime.syncMarkdownToChief(projectId, agentId);
      expect(syncAgentMarkdown).toHaveBeenCalledTimes(2);

      // Backoff was reset by the success, so the very next tick runs immediately (no cooldown).
      syncAgentMarkdown.mockResolvedValueOnce({ headSha: "h", uploaded: [], chiefProjectId: "p" });
      await runtime.syncMarkdownToChief(projectId, agentId);
      expect(syncAgentMarkdown).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
