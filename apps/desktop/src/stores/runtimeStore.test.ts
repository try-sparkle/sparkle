import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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
const agentWorkflowState = vi.fn();
vi.mock("../services/branchStatus", () => ({
  agentBranchStatus: (...a: unknown[]) => agentBranchStatus(...a),
  agentWorkflowState: (...a: unknown[]) => agentWorkflowState(...a),
}));

// Spy the bead-write wrappers (keep the rest of beads.ts real) so the programmatic-status tests
// assert which write fires per transition without touching Tauri/`bd`.
const claimBead = vi.fn();
const closeBead = vi.fn();
const labelBead = vi.fn();
vi.mock("../services/beads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/beads")>();
  return {
    ...actual,
    claimBead: (...a: unknown[]) => claimBead(...a),
    closeBead: (...a: unknown[]) => closeBead(...a),
    labelBead: (...a: unknown[]) => labelBead(...a),
  };
});

// Mocked Chief sync so the store-glue tests don't touch Tauri/Chief.
const syncProjectMarkdown = vi.fn();
vi.mock("../services/chiefSync", () => ({
  syncProjectMarkdown: (...a: unknown[]) => syncProjectMarkdown(...a),
  MARKDOWN_DIRS: ["PRD", "docs/superpowers/specs"],
}));

async function freshStore() {
  vi.resetModules();
  const mod = await import("./runtimeStore");
  return mod.useRuntimeStore;
}

// Fresh runtime + settings + project stores from the SAME post-reset module graph, so state set
// on these instances is the state `runChiefSync` reads.
async function freshModules() {
  vi.resetModules();
  const runtime = await import("./runtimeStore");
  const settings = await import("./settingsStore");
  const projects = await import("./projectStore");
  return { runtime, settings, projects };
}

beforeEach(() => {
  agentBranchStatus.mockReset();
  agentWorkflowState.mockReset();
  syncProjectMarkdown.mockReset();
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

  // : a removed worktree must stop being polled, while transient errors keep retrying.
  it("pollBranchStatus stops re-polling once the worktree is gone", async () => {
    const useRuntimeStore = await freshStore();
    agentBranchStatus.mockRejectedValue(
      new Error("git status --porcelain failed: fatal: cannot change to '/gone': No such file or directory"),
    );
    await useRuntimeStore.getState().pollBranchStatus("/root", "p1", "a1", "main");
    expect(agentBranchStatus).toHaveBeenCalledTimes(1);
    // A second poll for the same agent must early-return without touching the backend again.
    await useRuntimeStore.getState().pollBranchStatus("/root", "p1", "a1", "main");
    expect(agentBranchStatus).toHaveBeenCalledTimes(1);
  });

  it("pollBranchStatus keeps retrying after a transient (non-fatal) git error", async () => {
    const useRuntimeStore = await freshStore();
    agentBranchStatus.mockRejectedValue(new Error("git boom"));
    await useRuntimeStore.getState().pollBranchStatus("/root", "p1", "a1", "main");
    await useRuntimeStore.getState().pollBranchStatus("/root", "p1", "a1", "main");
    expect(agentBranchStatus).toHaveBeenCalledTimes(2);
  });

  it("isWorktreeGoneError matches only the structural gone-worktree signatures", async () => {
    const { isWorktreeGoneError } = await import("./runtimeStore");
    // git's chdir-to-CWD failure (deleted worktree dir) and the structural not-a-repo case latch…
    expect(isWorktreeGoneError(new Error("fatal: cannot change to '/x': No such file or directory"))).toBe(true);
    expect(isWorktreeGoneError(new Error("fatal: not a git repository"))).toBe(true);
    // …but a bare "no such file or directory" (e.g. a missing pathspec/config) must NOT latch, nor
    // any other transient error — a false positive would silently stop polling for the app's life.
    expect(isWorktreeGoneError(new Error("error: pathspec 'x' did not match; No such file or directory"))).toBe(false);
    expect(isWorktreeGoneError(new Error("git boom"))).toBe(false);
    expect(isWorktreeGoneError("plain string")).toBe(false);
  });
});

describe("runtimeStore — workflowShipped sticky latch (review #13591)", () => {
  const wsState = (p: Record<string, unknown>) => ({
    inLocalMain: false,
    inOriginMain: false,
    inParent: false,
    aheadOfBase: 0,
    prState: null,
    prNumber: null,
    prUrl: null,
    ...p,
  });
  const bsStatus = (ahead: number) => ({
    ahead,
    behind: 0,
    dirty: false,
    filesChanged: 1,
    insertions: 1,
    deletions: 0,
  });

  it("latches on first reach of main and stays true after the bar resets to a new cycle", async () => {
    const { runtime, projectId, agentId } = await setup("build");
    const store = runtime.useRuntimeStore;

    // Ship: committed work whose tip is in local main → stage advances to "merged".
    store.getState().setBranchStatus(agentId, bsStatus(1));
    agentWorkflowState.mockResolvedValue(wsState({ inLocalMain: true }));
    await store.getState().refreshWorkflowStage("/root", projectId, agentId);
    expect(store.getState().workflowStage[agentId]).toBe("merged");
    expect(store.getState().workflowShipped[agentId]).toBe(true);

    // New cycle: fresh un-landed commits, tip-relative signals fallen back → the bar resets…
    store.getState().setBranchStatus(agentId, bsStatus(2));
    agentWorkflowState.mockResolvedValue(wsState({}));
    await store.getState().refreshWorkflowStage("/root", projectId, agentId);
    expect(store.getState().workflowStage[agentId]).toBe("building_saved");
    // …but the sticky ✓ latch survives — that's the whole point of the separate flag.
    expect(store.getState().workflowShipped[agentId]).toBe(true);
  });

  it("close() clears the sticky latch so a reused id doesn't inherit a stale ✓", async () => {
    const { runtime, agentId } = await setup("build");
    const store = runtime.useRuntimeStore;
    store.getState().setWorkflowShipped(agentId, true);
    store.getState().close(agentId);
    expect(store.getState().workflowShipped[agentId]).toBeUndefined();
  });
});

// sparkle-v7d0 #1: the Pushed/Shipped stages must update LIVE from the Rust workflow state. Before
// the wire-up, applyWorkflowState never passed ws.pushed / ws.shipped to deriveLiveStage, so "Pushed"
// only lit via a PR probe and "Shipped" was unreachable. These pin the store→engine plumbing.
describe("runtimeStore — pushed/shipped wired live (sparkle-v7d0)", () => {
  const wsState = (p: Record<string, unknown>) => ({
    inLocalMain: false,
    inOriginMain: false,
    inParent: false,
    aheadOfBase: 0,
    prState: null,
    prNumber: null,
    prUrl: null,
    ...p,
  });
  const bsStatus = (ahead: number) => ({
    ahead,
    behind: 0,
    dirty: false,
    filesChanged: 1,
    insertions: 1,
    deletions: 0,
  });

  it("advances to Pushed from ws.pushed even with no PR open", async () => {
    const { runtime, projectId, agentId } = await setup("build");
    const store = runtime.useRuntimeStore;
    // Committed work, branch pushed to origin, but no PR yet (prState null).
    store.getState().setBranchStatus(agentId, bsStatus(1));
    agentWorkflowState.mockResolvedValue(wsState({ pushed: true }));
    await store.getState().refreshWorkflowStage("/root", projectId, agentId);
    expect(store.getState().workflowStage[agentId]).toBe("pushed");
  });

  it("advances to Shipped from ws.shipped once real work exists", async () => {
    const { runtime, projectId, agentId } = await setup("build");
    const store = runtime.useRuntimeStore;
    store.getState().setBranchStatus(agentId, bsStatus(1));
    agentWorkflowState.mockResolvedValue(wsState({ inLocalMain: true, pushed: true, shipped: true }));
    await store.getState().refreshWorkflowStage("/root", projectId, agentId);
    expect(store.getState().workflowStage[agentId]).toBe("shipped");
  });

  it("does NOT ship a no-op branch: shipped is gated on committed work", async () => {
    const { runtime, projectId, agentId } = await setup("build");
    const store = runtime.useRuntimeStore;
    // No commits (ahead 0), no prior watermark, but Rust reports shipped (a tip trivially in a tag):
    // committedSeen stays closed, so the stage must not jump to Shipped.
    store.getState().setBranchStatus(agentId, bsStatus(0));
    agentWorkflowState.mockResolvedValue(wsState({ shipped: true }));
    await store.getState().refreshWorkflowStage("/root", projectId, agentId);
    expect(store.getState().workflowStage[agentId]).toBe("building_unsaved");
  });
});

// Seed a connected PAT + a project with one agent of the given kind; returns ids + handles.
async function setup(kind: "build" | "think") {
  const { runtime, settings, projects } = await freshModules();
  settings.useSettingsStore.getState().setChiefPat("pat_x");
  const projectId = projects.useProjectStore.getState().addProject("Sparkle-Desktop", "/root");
  const agentId = projects.useProjectStore.getState().addAgent(projectId, { kind });
  return { runtime, settings, projects, projectId, agentId };
}

describe("scheduleChiefSync — debounced per-project sync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    syncProjectMarkdown.mockReset();
    syncProjectMarkdown.mockResolvedValue({
      chiefProjectId: "project_known",
      docState: {},
      uploaded: [],
      deletedAssetIds: [],
    });
  });
  afterEach(() => vi.useRealTimers());

  it("coalesces rapid schedules into a single sync after the debounce window", async () => {
    const { runtime: mod, projectId, agentId } = await setup("build");
    mod.scheduleChiefSync(projectId, agentId);
    mod.scheduleChiefSync(projectId, agentId);
    mod.scheduleChiefSync(projectId, agentId);
    expect(syncProjectMarkdown).not.toHaveBeenCalled(); // nothing yet — still within the window
    await vi.advanceTimersByTimeAsync(mod.CHIEF_SYNC_DEBOUNCE_MS + 1);
    expect(syncProjectMarkdown).toHaveBeenCalledTimes(1);
  });
});

describe("runChiefSync — store glue ()", () => {

  it("skips Think agents (they have no worktree / commits)", async () => {
    const { runtime, projectId, agentId } = await setup("think");
    await runtime.runChiefSync(projectId, agentId);
    expect(syncProjectMarkdown).not.toHaveBeenCalled();
  });

  it("does nothing without a connected PAT", async () => {
    const { runtime, settings, projectId, agentId } = await setup("build");
    settings.useSettingsStore.setState({ chiefPat: "" });
    await runtime.runChiefSync(projectId, agentId);
    expect(syncProjectMarkdown).not.toHaveBeenCalled();
  });

  it("persists a newly-created Chief project id and persists the project doc-state ledger", async () => {
    const { runtime, settings, projectId, agentId } = await setup("build");
    syncProjectMarkdown.mockResolvedValue({
      chiefProjectId: "project_created",
      docState: { "PRD/main.md": { hash: "h1", assetId: "asset_1" } },
      uploaded: ["PRD/main.md"],
      deletedAssetIds: [],
    });

    await runtime.runChiefSync(projectId, agentId);

    // Passed the stored marker (none yet) + project name through to the sync service.
    expect(syncProjectMarkdown).toHaveBeenCalledWith(
      expect.objectContaining({ pat: "pat_x", projectName: "Sparkle-Desktop", agentId }),
    );
    expect(settings.useSettingsStore.getState().chiefProjectByProject[projectId]).toBe(
      "project_created",
    );
    expect(settings.useSettingsStore.getState().chiefDocStateByProject["project_created"]).toEqual({
      "PRD/main.md": { hash: "h1", assetId: "asset_1" },
    });
  });

  it("runs only one sync per project at a time (no create-create race)", async () => {
    const { runtime, projectId, agentId } = await setup("build");
    let release!: () => void;
    syncProjectMarkdown.mockReturnValue(
      new Promise((resolve) => {
        release = () =>
          resolve({ chiefProjectId: "p", docState: {}, uploaded: [], deletedAssetIds: [] });
      }),
    );

    const first = runtime.runChiefSync(projectId, agentId); // takes the lock, awaits
    await runtime.runChiefSync(projectId, agentId); // sees in-flight, returns immediately

    expect(syncProjectMarkdown).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it("backs off a failing endpoint per project, retries after cooldown, resets on success ()", async () => {
    const { runtime, projectId, agentId } = await setup("build");
    runtime.__resetChiefSyncBackoff();
    vi.useFakeTimers();
    try {
      syncProjectMarkdown.mockRejectedValueOnce(new TypeError("Load failed"));
      await runtime.runChiefSync(projectId, agentId);
      expect(syncProjectMarkdown).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1_000); // within the 5s base cooldown → skipped
      await runtime.runChiefSync(projectId, agentId);
      expect(syncProjectMarkdown).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(5_000); // past cooldown → retried, succeeds, clears backoff
      syncProjectMarkdown.mockResolvedValueOnce({
        chiefProjectId: "p",
        docState: {},
        uploaded: [],
        deletedAssetIds: [],
      });
      await runtime.runChiefSync(projectId, agentId);
      expect(syncProjectMarkdown).toHaveBeenCalledTimes(2);

      // Success cleared the per-project backoff entry — next run executes immediately (no cooldown).
      syncProjectMarkdown.mockResolvedValueOnce({
        chiefProjectId: "p",
        docState: {},
        uploaded: [],
        deletedAssetIds: [],
      });
      await runtime.runChiefSync(projectId, agentId);
      expect(syncProjectMarkdown).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after repeated failures and drops to a quiet hourly re-probe ()", async () => {
    const { runtime, projectId, agentId } = await setup("build");
    runtime.__resetChiefSyncBackoff();
    syncProjectMarkdown.mockRejectedValue(new TypeError("Load failed"));
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      // Drive 10 consecutive failures. Each retry needs the prior cooldown to elapse first; the
      // backoff caps at 5 min, so advancing 5 min between runs guarantees every attempt fires.
      for (let i = 0; i < 10; i++) {
        await runtime.runChiefSync(projectId, agentId);
        vi.advanceTimersByTime(5 * 60_000);
      }
      expect(syncProjectMarkdown).toHaveBeenCalledTimes(10);

      // Having given up, the next run is now in the HOUR-long cooldown: 5 min later it stays quiet.
      await runtime.runChiefSync(projectId, agentId);
      expect(syncProjectMarkdown).toHaveBeenCalledTimes(10);

      // Past the hour it re-probes exactly once (self-healing if the endpoint recovers).
      vi.advanceTimersByTime(60 * 60_000);
      await runtime.runChiefSync(projectId, agentId);
      expect(syncProjectMarkdown).toHaveBeenCalledTimes(11);

      // Log volume is bounded: one line on the first failure, one on the give-up transition — not
      // one per attempt (the flood this fixes).
      const syncLogs = debug.mock.calls.filter(
        (c) => typeof c[0] === "string" && c[0].includes("chief project sync"),
      );
      expect(syncLogs).toHaveLength(2);
    } finally {
      vi.useRealTimers();
      debug.mockRestore();
    }
  });

  it("does not re-log the first-failure line on an intermittently flapping endpoint ()", async () => {
    const { runtime, projectId, agentId } = await setup("build");
    runtime.__resetChiefSyncBackoff();
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.useFakeTimers();
    const syncLogCount = () =>
      debug.mock.calls.filter(
        (c) => typeof c[0] === "string" && c[0].includes("chief project sync"),
      ).length;
    try {
      // Flap pattern: each failure is followed by a success, which clears the backoff and resets the
      // consecutive-failure counter — so every failure is a fresh fails===1. 's give-up
      // (10 in a row) is therefore never reached. Pre- this logged on every single flap.
      for (let i = 0; i < 5; i++) {
        syncProjectMarkdown.mockRejectedValueOnce(new TypeError("Load failed"));
        await runtime.runChiefSync(projectId, agentId);
        vi.advanceTimersByTime(10_000); // past the 5s base cooldown, far under the 1h relog window
        syncProjectMarkdown.mockResolvedValueOnce({
          chiefProjectId: "p",
          docState: {},
          uploaded: [],
          deletedAssetIds: [],
        });
        await runtime.runChiefSync(projectId, agentId);
        vi.advanceTimersByTime(10_000);
      }
      // Only the first flap's failure logged; the rest inside the quiet window are suppressed.
      expect(syncLogCount()).toBe(1);

      // Once the quiet window elapses, a fresh failure logs again — the unhealthy signal is preserved.
      vi.advanceTimersByTime(60 * 60_000);
      syncProjectMarkdown.mockRejectedValueOnce(new TypeError("Load failed"));
      await runtime.runChiefSync(projectId, agentId);
      expect(syncLogCount()).toBe(2);
    } finally {
      vi.useRealTimers();
      debug.mockRestore();
    }
  });

  it("falls back to a workflow agent's worktree when triggered via a Think or Shell agent's id", async () => {
    const { runtime, settings, projects } = await freshModules();
    settings.useSettingsStore.getState().setChiefPat("pat_x");
    const projectId = projects.useProjectStore.getState().addProject("Sparkle-Desktop", "/root");
    const thinkAgentId = projects.useProjectStore.getState().addAgent(projectId, { kind: "think" });
    // Shell also has no worktree — fallback must skip it and pick the Build agent.
    projects.useProjectStore.getState().addAgent(projectId, { kind: "shell" });
    const buildAgentId = projects.useProjectStore.getState().addAgent(projectId, { kind: "build" });
    syncProjectMarkdown.mockResolvedValue({
      chiefProjectId: "project_x",
      docState: {},
      uploaded: [],
      deletedAssetIds: [],
    });

    await runtime.runChiefSync(projectId, thinkAgentId);

    // Think + shell have no worktree; the Build agent's id must be used for the sync.
    expect(syncProjectMarkdown).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: buildAgentId }),
    );
  });

  it("skips the docState write when the tree is unchanged (no uploads or deletes)", async () => {
    const { runtime, settings, projectId, agentId } = await setup("build");
    settings.useSettingsStore.setState({
      chiefProjectByProject: { [projectId]: "project_known" },
      chiefDocStateByProject: {
        project_known: { "PRD/main.md": { hash: "h1", assetId: "asset_1" } },
      },
    });
    // Simulate a no-op run: nothing changed, sync returns the same (or empty) ledger.
    syncProjectMarkdown.mockResolvedValue({
      chiefProjectId: "project_known",
      docState: { "PRD/main.md": { hash: "h1", assetId: "asset_1" } },
      uploaded: [],
      deletedAssetIds: [],
    });

    await runtime.runChiefSync(projectId, agentId);

    // The ledger in the store must be UNCHANGED — no write triggered.
    expect(settings.useSettingsStore.getState().chiefDocStateByProject["project_known"]).toEqual({
      "PRD/main.md": { hash: "h1", assetId: "asset_1" },
    });
    // Confirm syncProjectMarkdown was called (so the run did execute).
    expect(syncProjectMarkdown).toHaveBeenCalledTimes(1);
  });
});

describe("runtimeStore — programmatic bead writes on stage transitions (review #16104/16105)", () => {
  const wsState = (p: Record<string, unknown> = {}) => ({
    inLocalMain: false,
    inOriginMain: false,
    inParent: false,
    aheadOfBase: 0,
    prState: null,
    ...p,
  });
  const bsStatus = (ahead: number) => ({
    ahead,
    behind: 0,
    dirty: false,
    filesChanged: 0,
    insertions: 0,
    deletions: 0,
  });
  beforeEach(() => {
    // The wrappers return Promises in real life — the hook does `.catch()` on the result.
    claimBead.mockReset().mockResolvedValue(undefined);
    closeBead.mockReset().mockResolvedValue(undefined);
    labelBead.mockReset().mockResolvedValue(undefined);
  });

  it("claims a bead-bound agent on a forward transition into a building stage", async () => {
    const { runtime, projects, projectId, agentId } = await setup("build");
    projects.useProjectStore.getState().setAgentBeadId(projectId, agentId, "bd-1");
    const store = runtime.useRuntimeStore;
    store.getState().setBranchStatus(agentId, bsStatus(1)); // → building_saved
    agentWorkflowState.mockResolvedValue(wsState({}));
    await store.getState().refreshWorkflowStage("/root", projectId, agentId);
    expect(claimBead).toHaveBeenCalledWith("/root", "bd-1");
  });

  it("does NOT reopen a closed bead on a backward (cycle-reset) transition", async () => {
    const { runtime, projects, projectId, agentId } = await setup("build");
    projects.useProjectStore.getState().setAgentBeadId(projectId, agentId, "bd-2");
    const store = runtime.useRuntimeStore;
    // First reach Merged → close.
    store.getState().setBranchStatus(agentId, bsStatus(1));
    agentWorkflowState.mockResolvedValue(wsState({ inLocalMain: true }));
    await store.getState().refreshWorkflowStage("/root", projectId, agentId);
    expect(closeBead).toHaveBeenCalledWith("/root", "bd-2");
    claimBead.mockReset();
    // New cycle: fresh commits, signals fallen back → the bar resets BACKWARD to a building stage.
    store.getState().setBranchStatus(agentId, bsStatus(2));
    agentWorkflowState.mockResolvedValue(wsState({}));
    await store.getState().refreshWorkflowStage("/root", projectId, agentId);
    expect(claimBead).not.toHaveBeenCalled(); // forward-only guard: no reopen
  });

  it("latches a bead CLOSED in a prior session instead of re-claiming it every poll", async () => {
    // Repro of the every-tick "issue not claimable: status closed" log spam: a bead closed in a
    // PRIOR session has its in-memory lifecycle watermark reset on relaunch, so a building-stage
    // agent re-attempts the claim each poll. bd rejects claiming a closed issue; without the latch
    // the 30s poll re-fails forever. The claim must be attempted once, recognized as already-closed,
    // and latched so subsequent polls don't re-attempt it.
    const { runtime, projects, projectId, agentId } = await setup("build");
    projects.useProjectStore.getState().setAgentBeadId(projectId, agentId, "bd-7");
    const store = runtime.useRuntimeStore;
    claimBead
      .mockReset()
      .mockRejectedValue(new Error("Error claiming bd-7: issue not claimable: status closed"));
    store.getState().setBranchStatus(agentId, bsStatus(1)); // building_saved ⇒ target in_progress
    agentWorkflowState.mockResolvedValue(wsState({}));

    // First poll: attempts the claim, recognizes the already-closed status, latches WITHOUT throwing.
    await store.getState().refreshWorkflowStage("/root", projectId, agentId);
    await new Promise((r) => setTimeout(r, 0)); // flush the fire-and-forget syncBeadLifecycle
    expect(claimBead).toHaveBeenCalledTimes(1);

    // Second poll: the watermark is now latched at `closed`, so the claim is NOT re-attempted — the
    // fix (before it, the same claim re-fired and re-failed every tick for the app's lifetime).
    await store.getState().refreshWorkflowStage("/root", projectId, agentId);
    await new Promise((r) => setTimeout(r, 0));
    expect(claimBead).toHaveBeenCalledTimes(1);
  });

  it("fires no bead write for an agent with no bead", async () => {
    const { runtime, projectId, agentId } = await setup("build");
    const store = runtime.useRuntimeStore;
    store.getState().setBranchStatus(agentId, bsStatus(1));
    agentWorkflowState.mockResolvedValue(wsState({}));
    await store.getState().refreshWorkflowStage("/root", projectId, agentId);
    expect(claimBead).not.toHaveBeenCalled();
    expect(closeBead).not.toHaveBeenCalled();
  });
});

describe("runtimeStore — multi-window open-set merge ()", () => {
  it("open() UNIONs against the shared persisted set instead of clobbering another window's ids", async () => {
    const useRuntimeStore = await freshStore();
    const { open } = useRuntimeStore.getState();
    // Window A opens its own two agents.
    open("a1");
    open("a2");
    // Window B (another window, SAME localStorage key) has since persisted its own open agent on top.
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({ state: { openAgentIds: ["a1", "a2", "b1"] }, version: 0 }),
    );
    // Window A opens a3. The naive whole-array write would persist [a1,a2,a3] and DROP b1.
    open("a3");
    const persisted = JSON.parse(localStorage.getItem(STORE_KEY) as string);
    expect(persisted.state.openAgentIds).toContain("b1"); // window B's agent survives
    expect(persisted.state.openAgentIds).toContain("a3"); // window A's new agent is added
    expect(persisted.state.openAgentIds).toEqual(
      expect.arrayContaining(["a1", "a2", "a3", "b1"]),
    );
  });

  it("close() removes ONLY the closed id and preserves another window's persisted ids", async () => {
    const useRuntimeStore = await freshStore();
    const { open, close } = useRuntimeStore.getState();
    open("a1");
    open("a2");
    // Another window persisted b1 into the shared set.
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({ state: { openAgentIds: ["a1", "a2", "b1"] }, version: 0 }),
    );
    close("a2");
    const persisted = JSON.parse(localStorage.getItem(STORE_KEY) as string);
    expect(persisted.state.openAgentIds).toContain("b1"); // not clobbered
    expect(persisted.state.openAgentIds).not.toContain("a2"); // the closed id is gone
    expect(persisted.state.openAgentIds).toContain("a1");
  });

  it("mergeOpenAgentIds unions preserving in-memory order then persisted extras, adding new id last", async () => {
    const { mergeOpenAgentIds } = await import("./runtimeStore");
    expect(mergeOpenAgentIds(["a1", "a2"], ["a1", "a2", "b1"], "a3")).toEqual([
      "a1",
      "a2",
      "b1",
      "a3",
    ]);
    // No-op add (already present) doesn't duplicate.
    expect(mergeOpenAgentIds(["a1"], ["a1", "b1"], "a1")).toEqual(["a1", "b1"]);
    // Undefined add just unions.
    expect(mergeOpenAgentIds(["a1"], ["b1"])).toEqual(["a1", "b1"]);
  });

  it("readPersistedOpenAgentIds tolerates a missing / malformed blob", async () => {
    const { readPersistedOpenAgentIds } = await import("./runtimeStore");
    expect(readPersistedOpenAgentIds()).toEqual([]); // nothing persisted yet
    localStorage.setItem(STORE_KEY, "not json{");
    expect(readPersistedOpenAgentIds()).toEqual([]);
    localStorage.setItem(STORE_KEY, JSON.stringify({ state: { openAgentIds: "nope" } }));
    expect(readPersistedOpenAgentIds()).toEqual([]);
  });
});

describe("runtimeStore — setStatus ref stability (sparkle-f2uz)", () => {
  it("keeps the status map reference stable on a redundant same-value tick, and swaps it on a real change", async () => {
    const useRuntimeStore = await freshStore();
    const { setStatus } = useRuntimeStore.getState();
    setStatus("a", "working");
    const ref1 = useRuntimeStore.getState().status;
    // A redundant tick of the SAME status must NOT allocate a new map — whole-map subscribers
    // (sidebar / TopBar) would otherwise re-render for nothing.
    setStatus("a", "working");
    expect(useRuntimeStore.getState().status).toBe(ref1);
    // A genuine change swaps the reference (and re-renders, as intended).
    setStatus("a", "idle");
    expect(useRuntimeStore.getState().status).not.toBe(ref1);
    expect(useRuntimeStore.getState().status["a"]).toBe("idle");
  });
});
