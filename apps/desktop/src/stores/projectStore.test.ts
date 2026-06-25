import { describe, it, expect, beforeEach } from "vitest";
import { useProjectStore, migratePersisted, PROMPT_HISTORY_LIMIT } from "./projectStore";

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

describe("projectStore prompt history", () => {
  beforeEach(() => useProjectStore.setState({ projects: [], selectedProjectId: null }));

  const seed = () => {
    const pid = useProjectStore.getState().addProject("Demo", "/tmp/demo");
    const aid = useProjectStore.getState().addAgent(pid);
    return { pid, aid };
  };
  const agentOf = (aid: string) =>
    useProjectStore.getState().projects[0]!.agents.find((a) => a.id === aid)!;

  it("a fresh agent starts with an empty prompt history", () => {
    const { aid } = seed();
    expect(agentOf(aid).promptHistory).toEqual([]);
  });

  it("appendPrompt sets lastPrompt, appends oldest-first, and returns the new entry's id", () => {
    const { pid, aid } = seed();
    const id1 = useProjectStore.getState().appendPrompt(pid, aid, "first");
    const id2 = useProjectStore.getState().appendPrompt(pid, aid, "second");
    const agent = agentOf(aid);
    expect(agent.lastPrompt).toBe("second");
    expect(agent.promptHistory.map((e) => e.text)).toEqual(["first", "second"]);
    // The returned id matches the appended entry, so the caller can key a scroll marker to it.
    expect(agent.promptHistory[0]!.id).toBe(id1);
    expect(agent.promptHistory[1]!.id).toBe(id2);
    expect(id1).not.toBe(id2);
    expect(typeof agent.promptHistory[0]!.at).toBe("number");
  });

  it("keeps identical prompts as distinct entries (each is its own conversation point)", () => {
    const { pid, aid } = seed();
    useProjectStore.getState().appendPrompt(pid, aid, "same");
    useProjectStore.getState().appendPrompt(pid, aid, "same");
    expect(agentOf(aid).promptHistory).toHaveLength(2);
  });

  it("caps the history to the most recent PROMPT_HISTORY_LIMIT entries", () => {
    const { pid, aid } = seed();
    for (let i = 0; i < PROMPT_HISTORY_LIMIT + 5; i++) {
      useProjectStore.getState().appendPrompt(pid, aid, `p${i}`);
    }
    const hist = agentOf(aid).promptHistory;
    expect(hist).toHaveLength(PROMPT_HISTORY_LIMIT);
    // The oldest five fell off; the newest is retained.
    expect(hist[0]!.text).toBe("p5");
    expect(hist[hist.length - 1]!.text).toBe(`p${PROMPT_HISTORY_LIMIT + 4}`);
  });

  it("migrate (v5) backfills promptHistory as [] without seeding from lastPrompt", () => {
    // A v4 record already has autoNameVariants but predates the prompt-history field.
    const v4 = {
      projects: [
        {
          id: "p",
          name: "Old",
          rootPath: "/x",
          defaultBranch: "main",
          agents: [
            {
              id: "a",
              name: "A",
              kind: "build",
              parentId: null,
              lastPrompt: "old prompt",
              autoNameVariants: null,
            },
          ],
        },
      ],
      selectedProjectId: null,
    } as unknown;
    const out = migratePersisted(v4, 4) as {
      projects: Array<{ agents: Array<{ promptHistory: unknown }> }>;
    };
    expect(out.projects[0]!.agents[0]!.promptHistory).toEqual([]);
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
