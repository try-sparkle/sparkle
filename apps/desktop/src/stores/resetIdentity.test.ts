import { describe, it, expect, beforeEach } from "vitest";
import { useProjectStore } from "./projectStore";
import { useRuntimeStore } from "./runtimeStore";

// When an agent slot's worktree is wiped and recreated and the agent starts a FRESH Claude session
// (nothing to `claude --resume`), the pane must not keep displaying the PRIOR occupant's identity —
// its auto-name (e.g. "Recent Prompts Hover Expand") and its sticky workflow progress watermark.
// These pin the two store-level resets that prepare() invokes on a fresh (non-resume) start.

describe("projectStore.resetAutoName", () => {
  beforeEach(() => useProjectStore.setState({ projects: [], selectedProjectId: null }));

  it("clears an auto-name back to the kind default and drops auto-name metadata (unpinned agent)", () => {
    const pid = useProjectStore.getState().addProject("Demo", "/tmp/demo");
    const aid = useProjectStore.getState().addAgent(pid);
    const defaultName = useProjectStore
      .getState()
      .projects[0]!.agents.find((a) => a.id === aid)!.name; // "Build 1"

    // The slot picks up an auto-name + metadata from a prior conversation.
    useProjectStore
      .getState()
      .autoRenameAgent(pid, aid, "Recent Prompts Hover Expand", "an old prompt", {
        title: "Recent Prompts Hover Expand",
        description: "shows recent prompts on hover",
      });
    expect(
      useProjectStore.getState().projects[0]!.agents.find((a) => a.id === aid)!.name,
    ).toBe("Recent Prompts Hover Expand");

    useProjectStore.getState().resetAutoName(pid, aid);

    const reset = useProjectStore.getState().projects[0]!.agents.find((a) => a.id === aid)!;
    expect(reset.name).toBe(defaultName);
    expect(reset.autoNameBasis).toBeNull();
    expect(reset.autoNameVariants).toBeNull();
    expect(reset.aiTitle).toBeUndefined();
  });

  it("leaves a never-auto-named agent's record reference untouched (no needless re-render on first launch)", () => {
    const pid = useProjectStore.getState().addProject("Demo", "/tmp/demo");
    const aid = useProjectStore.getState().addAgent(pid);
    const before = useProjectStore.getState().projects[0]!.agents.find((a) => a.id === aid)!;

    useProjectStore.getState().resetAutoName(pid, aid);

    const after = useProjectStore.getState().projects[0]!.agents.find((a) => a.id === aid)!;
    expect(after).toBe(before); // identical reference → store bailed, no subscriber churn
  });

  it("is a no-op on a pinned (manually renamed) agent — the user's name is preserved", () => {
    const pid = useProjectStore.getState().addProject("Demo", "/tmp/demo");
    const aid = useProjectStore.getState().addAgent(pid);
    useProjectStore.getState().renameAgent(pid, aid, "My Custom Name");

    useProjectStore.getState().resetAutoName(pid, aid);

    const a = useProjectStore.getState().projects[0]!.agents.find((x) => x.id === aid)!;
    expect(a.name).toBe("My Custom Name");
    expect(a.namePinned).toBe(true);
  });
});

describe("runtimeStore.resetProgress", () => {
  beforeEach(() =>
    useRuntimeStore.setState({
      status: {},
      openAgentIds: [],
      branchStatus: {},
      workflowStage: {},
      workflowShipped: {},
    }),
  );

  it("clears the agent's live status + sticky workflow watermark but keeps it in the open set", () => {
    const id = "agent-1";
    useRuntimeStore.getState().open(id);
    useRuntimeStore.getState().setStatus(id, "working");
    useRuntimeStore.getState().setBranchStatus(id, {
      ahead: 2,
      behind: 1,
      dirty: true,
      filesChanged: 3,
      insertions: 10,
      deletions: 4,
    });
    useRuntimeStore.getState().setWorkflowStage(id, "building_saved");
    useRuntimeStore.getState().setWorkflowShipped(id, true);

    useRuntimeStore.getState().resetProgress(id);

    const s = useRuntimeStore.getState();
    expect(s.status[id]).toBeUndefined();
    expect(s.branchStatus[id]).toBeUndefined();
    expect(s.workflowStage[id]).toBeUndefined();
    expect(s.workflowShipped[id]).toBeUndefined();
    // It's a fresh run in the SAME slot — the pane stays mounted/open.
    expect(s.openAgentIds).toContain(id);
  });
});
