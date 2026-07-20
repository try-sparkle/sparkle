import { describe, it, expect, beforeEach } from "vitest";
import { useProjectStore, acknowledgeRemovals, isLocallyRemoved } from "./projectStore";

beforeEach(() => {
  useProjectStore.setState({ projects: [], selectedProjectId: null });
  localStorage.clear();
});

describe("setSelectedProject", () => {
  it("sets the restore hint (accepting null) without bumping lastOpenedAt", () => {
    const id = useProjectStore.getState().addProject("P", "/tmp/p");
    const old = "2000-01-01T00:00:00.000Z";
    useProjectStore.setState((s) => ({
      selectedProjectId: null,
      projects: s.projects.map((p) => (p.id === id ? { ...p, lastOpenedAt: old } : p)),
    }));
    useProjectStore.getState().setSelectedProject(id);
    expect(useProjectStore.getState().selectedProjectId).toBe(id);
    // Restore-hint write must NOT touch lastOpenedAt (Recent ordering is owned by touchProjectOpened).
    expect(useProjectStore.getState().projects[0]?.lastOpenedAt).toBe(old);
    // Null clears the hint (main window closed to no project → restart falls back to first project).
    useProjectStore.getState().setSelectedProject(null);
    expect(useProjectStore.getState().selectedProjectId).toBeNull();
  });
});

describe("touchProjectOpened", () => {
  it("updates lastOpenedAt without changing selectedProjectId", () => {
    const id = useProjectStore.getState().addProject("P", "/tmp/p");
    // Pin a known-old timestamp + simulate another window being the selected one, so the
    // assertion fails if touchProjectOpened stops bumping the field.
    const old = "2000-01-01T00:00:00.000Z";
    useProjectStore.setState((s) => ({
      selectedProjectId: "other",
      projects: s.projects.map((p) => (p.id === id ? { ...p, lastOpenedAt: old } : p)),
    }));
    useProjectStore.getState().touchProjectOpened(id);
    const after = useProjectStore.getState().projects[0]?.lastOpenedAt ?? "";
    expect(after > old).toBe(true);
    expect(useProjectStore.getState().selectedProjectId).toBe("other");
  });
});

// A worker closed via its row's × (removeAgent) must NOT be re-adopted by the disk reconcile
// (reconcileWorkersFromDisk → adoptWorker) while its on-disk manifest is still being torn down.
// removeAgent tombstones the id; adoptWorker refuses a tombstoned id until the removal propagates.
describe("removal tombstone blocks re-adoption", () => {
  it("adoptWorker refuses a just-removed worker id", () => {
    const store = useProjectStore.getState();
    const pid = store.addProject("P", "/tmp/p");
    const buildId = store.addAgent(pid, { kind: "build" });
    // Give the build agent a branch so a worker can hang off it, then adopt a worker on disk.
    useProjectStore.getState().setAgentWorktree(pid, buildId, "/wt/b", "sparkle/agent-b");
    const wid = "worker-1";
    useProjectStore
      .getState()
      .adoptWorker(pid, { id: wid, parentId: buildId, worktreePath: "/wt/w1", branch: "wb" });
    expect(useProjectStore.getState().projects[0]!.agents.some((a) => a.id === wid)).toBe(true);

    // User closes the worker row → tombstoned.
    useProjectStore.getState().removeAgent(pid, wid);
    // A reconcile pass whose disk manifest still exists tries to re-adopt it — must be refused.
    useProjectStore
      .getState()
      .adoptWorker(pid, { id: wid, parentId: buildId, worktreePath: "/wt/w1", branch: "wb" });
    expect(useProjectStore.getState().projects[0]!.agents.some((a) => a.id === wid)).toBe(false);

    // Once the removal propagates (acknowledged), the id may be adopted again.
    acknowledgeRemovals([wid]);
    useProjectStore
      .getState()
      .adoptWorker(pid, { id: wid, parentId: buildId, worktreePath: "/wt/w1", branch: "wb" });
    expect(useProjectStore.getState().projects[0]!.agents.some((a) => a.id === wid)).toBe(true);
  });

  it("closing a build agent cascade-removes AND tombstones every child worker id", () => {
    // The build-agent optimistic teardown (AgentSidebar) drops the parent's row then relies on
    // removeAgent's cascade to drop + tombstone the workers, so a background worktree-removal that
    // leaves a manifest on disk can't be reconciled back into a row (sparkle-close-resurrect).
    const store = useProjectStore.getState();
    const pid = store.addProject("P", "/tmp/p");
    const buildId = store.addAgent(pid, { kind: "build" });
    useProjectStore.getState().setAgentWorktree(pid, buildId, "/wt/b", "sparkle/agent-b");
    const w1 = "child-1";
    const w2 = "child-2";
    for (const id of [w1, w2]) {
      useProjectStore
        .getState()
        .adoptWorker(pid, { id, parentId: buildId, worktreePath: `/wt/${id}`, branch: id });
    }
    expect(useProjectStore.getState().projects[0]!.agents).toHaveLength(3);

    // Close the build agent (parent id only — removeAgent cascades to its workers).
    useProjectStore.getState().removeAgent(pid, buildId);

    // All three rows gone synchronously.
    expect(useProjectStore.getState().projects[0]!.agents).toHaveLength(0);
    // Parent AND both children tombstoned, so a lingering-manifest reconcile can't re-adopt them.
    expect(isLocallyRemoved(buildId)).toBe(true);
    expect(isLocallyRemoved(w1)).toBe(true);
    expect(isLocallyRemoved(w2)).toBe(true);
    for (const id of [w1, w2]) {
      useProjectStore
        .getState()
        .adoptWorker(pid, { id, parentId: buildId, worktreePath: `/wt/${id}`, branch: id });
    }
    expect(useProjectStore.getState().projects[0]!.agents).toHaveLength(0); // still refused

    acknowledgeRemovals([buildId, w1, w2]);
  });
});
