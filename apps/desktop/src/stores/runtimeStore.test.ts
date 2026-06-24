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

async function freshStore() {
  vi.resetModules();
  const mod = await import("./runtimeStore");
  return mod.useRuntimeStore;
}

beforeEach(() => {
  agentBranchStatus.mockReset();
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
