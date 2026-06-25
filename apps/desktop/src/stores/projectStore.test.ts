import { describe, it, expect, beforeEach } from "vitest";
import { useProjectStore, migratePersisted } from "./projectStore";

describe("projectStore default/base branch", () => {
  beforeEach(() => useProjectStore.setState({ projects: [], selectedProjectId: null }));

  it("a new project starts with a null defaultBranch that can be set", () => {
    const id = useProjectStore.getState().addProject("Demo", "/tmp/demo");
    expect(useProjectStore.getState().projects[0]!.defaultBranch).toBeNull();
    useProjectStore.getState().setDefaultBranch(id, "main");
    expect(useProjectStore.getState().projects[0]!.defaultBranch).toBe("main");
  });

  it("a new agent records baseBranch from the project's defaultBranch", () => {
    const pid = useProjectStore.getState().addProject("Demo", "/tmp/demo");
    useProjectStore.getState().setDefaultBranch(pid, "main");
    const aid = useProjectStore.getState().addAgent(pid);
    const agent = useProjectStore.getState().projects[0]!.agents.find((a) => a.id === aid)!;
    expect(agent.baseBranch).toBe("main");
  });

  it("setDefaultBranch keeps empty/whitespace from persisting as a broken base", () => {
    const id = useProjectStore.getState().addProject("Demo", "/tmp/demo");
    useProjectStore.getState().setDefaultBranch(id, "   ");
    expect(useProjectStore.getState().projects[0]!.defaultBranch).toBeNull();
  });

  it("migrate backfills defaultBranch/baseBranch/auto-naming on legacy persisted data", () => {
    // Legacy payload predates the new fields entirely.
    const legacy = {
      projects: [{ id: "p", name: "Old", rootPath: "/x", agents: [{ id: "a", name: "A" }] }],
      selectedProjectId: null,
    } as unknown;
    const out = migratePersisted(legacy, 0) as {
      projects: Array<{
        defaultBranch: unknown;
        agents: Array<{
          baseBranch: unknown;
          namePinned: unknown;
          autoNameBasis: unknown;
          autoNameVariants: unknown;
        }>;
      }>;
    };
    expect(out.projects[0]!.defaultBranch).toBeNull();
    expect(out.projects[0]!.agents[0]!.baseBranch).toBeNull();
    // A pre-existing name is treated as user-chosen, so it's pinned (won't auto-rename).
    expect(out.projects[0]!.agents[0]!.namePinned).toBe(true);
    expect(out.projects[0]!.agents[0]!.autoNameBasis).toBeNull();
    // Width-fitted name variants are backfilled to null (display falls back to `name`).
    expect(out.projects[0]!.agents[0]!.autoNameVariants).toBeNull();
  });
});

describe("projectStore auto-naming", () => {
  beforeEach(() => useProjectStore.setState({ projects: [], selectedProjectId: null }));

  it("a fresh default-named agent is unpinned; auto-rename applies and records the basis", () => {
    const pid = useProjectStore.getState().addProject("Demo", "/tmp/demo");
    const aid = useProjectStore.getState().addAgent(pid);
    let agent = useProjectStore.getState().projects[0]!.agents.find((a) => a.id === aid)!;
    expect(agent.namePinned).toBe(false);

    useProjectStore.getState().autoRenameAgent(pid, aid, "Fix Login Bug", "fix the login bug");
    agent = useProjectStore.getState().projects[0]!.agents.find((a) => a.id === aid)!;
    expect(agent.name).toBe("Fix Login Bug");
    expect(agent.autoNameBasis).toBe("fix the login bug");
    expect(agent.namePinned).toBe(false);
  });

  it("a manual rename pins the name and blocks subsequent auto-renames", () => {
    const pid = useProjectStore.getState().addProject("Demo", "/tmp/demo");
    const aid = useProjectStore.getState().addAgent(pid);
    useProjectStore.getState().renameAgent(pid, aid, "My Agent");
    useProjectStore.getState().autoRenameAgent(pid, aid, "Auto Name", "some prompt");
    const agent = useProjectStore.getState().projects[0]!.agents.find((a) => a.id === aid)!;
    expect(agent.name).toBe("My Agent");
    expect(agent.namePinned).toBe(true);
  });

  it("a manual rename clears the auto-name variants (pinned = name only)", () => {
    const pid = useProjectStore.getState().addProject("Demo", "/tmp/demo");
    const aid = useProjectStore.getState().addAgent(pid);
    // Auto-name first so variants are populated, then rename by hand.
    useProjectStore.getState().autoRenameAgent(pid, aid, "Fix Login", "fix the login bug", {
      short: "Fix Login",
      medium: "Fix The Login Redirect",
      long: "Fix The Login Redirect Loop On Mobile Safari",
    });
    let agent = useProjectStore.getState().projects[0]!.agents.find((a) => a.id === aid)!;
    expect(agent.autoNameVariants).not.toBeNull();

    useProjectStore.getState().renameAgent(pid, aid, "My Agent");
    agent = useProjectStore.getState().projects[0]!.agents.find((a) => a.id === aid)!;
    expect(agent.name).toBe("My Agent");
    // Variants must be wiped so the sidebar shows the chosen name, not the stale auto-name.
    expect(agent.autoNameVariants).toBeNull();
  });

  it("unpinning re-enables auto-rename", () => {
    const pid = useProjectStore.getState().addProject("Demo", "/tmp/demo");
    const aid = useProjectStore.getState().addAgent(pid);
    useProjectStore.getState().renameAgent(pid, aid, "My Agent");
    useProjectStore.getState().setNamePinned(pid, aid, false);
    useProjectStore.getState().autoRenameAgent(pid, aid, "Auto Name", "some prompt");
    const agent = useProjectStore.getState().projects[0]!.agents.find((a) => a.id === aid)!;
    expect(agent.name).toBe("Auto Name");
  });
});

// Pure migration tests — no store instantiation, so they don't depend on a localStorage shim
// (the action-based suite above needs one; see the test-env bead).
describe("projectStore migration — Brainstorm/Build (v3)", () => {
  it("v3 backfills kind=build and parentId=null on agents lacking them", () => {
    // A v1 record has the branch fields but predates the Brainstorm/Build split.
    const v1 = {
      projects: [
        {
          id: "p",
          name: "Old",
          rootPath: "/x",
          defaultBranch: "main",
          agents: [{ id: "a", name: "A", baseBranch: "main" }],
        },
      ],
      selectedProjectId: null,
    } as unknown;
    const out = migratePersisted(v1, 1) as {
      projects: Array<{ agents: Array<{ kind: unknown; parentId: unknown }> }>;
    };
    expect(out.projects[0]!.agents[0]!.kind).toBe("build");
    expect(out.projects[0]!.agents[0]!.parentId).toBeNull();
  });

  it("from v0 also lands kind=build + null base (runs both migration steps)", () => {
    const legacy = {
      projects: [{ id: "p", name: "Old", rootPath: "/x", agents: [{ id: "a", name: "A" }] }],
      selectedProjectId: null,
    } as unknown;
    const out = migratePersisted(legacy, 0) as {
      projects: Array<{ agents: Array<{ kind: unknown; parentId: unknown; baseBranch: unknown }> }>;
    };
    expect(out.projects[0]!.agents[0]!.kind).toBe("build");
    expect(out.projects[0]!.agents[0]!.parentId).toBeNull();
    expect(out.projects[0]!.agents[0]!.baseBranch).toBeNull();
  });
});
