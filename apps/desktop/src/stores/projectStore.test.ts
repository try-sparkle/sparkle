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
    useProjectStore.getState().unpinAgent(pid, aid);
    useProjectStore.getState().autoRenameAgent(pid, aid, "Auto Name", "some prompt");
    const agent = useProjectStore.getState().projects[0]!.agents.find((a) => a.id === aid)!;
    expect(agent.name).toBe("Auto Name");
  });
});

describe("projectStore applyAiTitle (Claude Code session title)", () => {
  beforeEach(() => useProjectStore.setState({ projects: [], selectedProjectId: null }));
  const agentOf = (pid: string, aid: string) =>
    useProjectStore.getState().projects[0]!.agents.find((a) => a.id === aid)!;

  it("applies Claude Code's title as the name, records aiTitle, and derives fitting variants", () => {
    const pid = useProjectStore.getState().addProject("Demo", "/tmp/demo");
    const aid = useProjectStore.getState().addAgent(pid); // "Build 1" default
    useProjectStore.getState().applyAiTitle(pid, aid, "  Debug Merged Agent On New Pop Open  ");
    const a = agentOf(pid, aid);
    expect(a.name).toBe("Debug Merged Agent On New Pop Open"); // trimmed
    expect(a.aiTitle).toBe("Debug Merged Agent On New Pop Open");
    // Width-fitting variants without a model call: caps at 4/6 words, long = full title.
    expect(a.autoNameVariants).toEqual({
      short: "Debug Merged Agent On",
      medium: "Debug Merged Agent On New Pop",
      long: "Debug Merged Agent On New Pop Open",
    });
  });

  it("overrides a prior Haiku auto-name (the title is authoritative)", () => {
    const pid = useProjectStore.getState().addProject("Demo", "/tmp/demo");
    const aid = useProjectStore.getState().addAgent(pid);
    useProjectStore.getState().autoRenameAgent(pid, aid, "Some Guess", "a thin prompt");
    useProjectStore.getState().applyAiTitle(pid, aid, "Fix False Merged Status");
    expect(agentOf(pid, aid).name).toBe("Fix False Merged Status");
  });

  it("never overrides a manually-pinned name", () => {
    const pid = useProjectStore.getState().addProject("Demo", "/tmp/demo");
    const aid = useProjectStore.getState().addAgent(pid);
    useProjectStore.getState().renameAgent(pid, aid, "My Agent");
    useProjectStore.getState().applyAiTitle(pid, aid, "Claude's Title");
    expect(agentOf(pid, aid).name).toBe("My Agent");
  });

  it("an empty/whitespace title is a no-op (no name yet, keep the default)", () => {
    const pid = useProjectStore.getState().addProject("Demo", "/tmp/demo");
    const aid = useProjectStore.getState().addAgent(pid);
    const before = agentOf(pid, aid).name;
    useProjectStore.getState().applyAiTitle(pid, aid, "   ");
    expect(agentOf(pid, aid).name).toBe(before);
    expect(agentOf(pid, aid).aiTitle).toBeUndefined();
  });

  it("autoRenameAgent does not clobber an applied ai-title (closes the in-flight Haiku race)", () => {
    // Race: a Haiku call started before any title existed, then the title poll applied an
    // ai-title while it was in flight; when the Haiku call resolves it must NOT overwrite the
    // authoritative title with its stale guess. The store is the arbiter.
    const pid = useProjectStore.getState().addProject("Demo", "/tmp/demo");
    const aid = useProjectStore.getState().addAgent(pid);
    useProjectStore.getState().applyAiTitle(pid, aid, "Authoritative Title");
    useProjectStore.getState().autoRenameAgent(pid, aid, "Late Haiku Guess", "a thin prompt");
    expect(agentOf(pid, aid).name).toBe("Authoritative Title");
  });

  it("re-applying the same title is a no-op but a changed title updates the name", () => {
    const pid = useProjectStore.getState().addProject("Demo", "/tmp/demo");
    const aid = useProjectStore.getState().addAgent(pid);
    useProjectStore.getState().applyAiTitle(pid, aid, "First Title");
    const ref1 = useProjectStore.getState().projects[0]!.agents.find((a) => a.id === aid)!;
    useProjectStore.getState().applyAiTitle(pid, aid, "First Title"); // unchanged
    const ref2 = useProjectStore.getState().projects[0]!.agents.find((a) => a.id === aid)!;
    expect(ref2).toBe(ref1); // same object reference → no rewrite/re-render
    // Claude Code refined its title → the name follows.
    useProjectStore.getState().applyAiTitle(pid, aid, "Second Refined Title");
    expect(agentOf(pid, aid).name).toBe("Second Refined Title");
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

describe("projectStore shell agent", () => {
  beforeEach(() => useProjectStore.setState({ projects: [], selectedProjectId: null }));

  it("addAgent persists a shell agent's command", () => {
    const pid = useProjectStore.getState().addProject("Demo", "/tmp/demo");
    const aid = useProjectStore
      .getState()
      .addAgent(pid, { kind: "shell", name: "npm run build", shellCommand: "npm run build" });
    const agent = useProjectStore.getState().projects[0]!.agents.find((a) => a.id === aid)!;
    expect(agent.kind).toBe("shell");
    expect(agent.shellCommand).toBe("npm run build");
    expect(agent.namePinned).toBe(true); // explicit name → pinned, won't auto-rename
  });

  it("migrate normalizes a PR #62 v4-collision record (shellCommand but no autoNameVariants)", () => {
    // PR #62 shipped shellCommand as v4 on its own branch; main used v4=autoNameVariants. A store
    // saved under #62's v4 reports version 4, so the version-gated `< 4` block is skipped. The
    // unconditional safety net must still backfill autoNameVariants (and leave shellCommand intact).
    const collided = {
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
              kind: "shell",
              parentId: null,
              lastPrompt: "",
              shellCommand: "npm run build", // present (it was #62's v4 addition)
              // autoNameVariants intentionally absent — main's v4 block is skipped for version 4
            },
          ],
        },
      ],
      selectedProjectId: null,
    } as unknown;
    const out = migratePersisted(collided, 4) as {
      projects: Array<{ agents: Array<{ autoNameVariants: unknown; shellCommand: unknown; promptHistory: unknown }> }>;
    };
    const agent = out.projects[0]!.agents[0]!;
    expect(agent.autoNameVariants).toBeNull(); // backfilled by the safety net despite version 4
    expect(agent.shellCommand).toBe("npm run build"); // preserved
    expect(agent.promptHistory).toEqual([]); // also normalized
  });
});

// Pure migration tests — no store instantiation, so they don't depend on a localStorage shim
// (the action-based suite above needs one; see the test-env bead).
describe("projectStore migration — Think/Build (v3)", () => {
  it("v3 backfills kind=build and parentId=null on agents lacking them", () => {
    // A v1 record has the branch fields but predates the Think/Build split.
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

describe("projectStore migration — shell/shellCommand (v4)", () => {
  it("v4 backfills shellCommand: null on agents that predate the shell kind", () => {
    // A v3 record has kind/parentId but no shellCommand field.
    const v3 = {
      projects: [
        {
          id: "p",
          name: "Old",
          rootPath: "/x",
          defaultBranch: "main",
          agents: [{ id: "a", name: "Build 1", kind: "build", parentId: null, baseBranch: "main" }],
        },
      ],
      selectedProjectId: null,
    } as unknown;
    const out = migratePersisted(v3, 3) as {
      projects: Array<{ agents: Array<{ shellCommand: unknown }> }>;
    };
    expect(out.projects[0]!.agents[0]!.shellCommand).toBeNull();
  });

  it("v4 migration preserves an existing shellCommand value", () => {
    // A record that somehow already has shellCommand set (e.g. written by a newer client
    // then loaded by an older one and re-migrated) must not clobber the value.
    const withShell = {
      projects: [
        {
          id: "p",
          name: "P",
          rootPath: "/x",
          agents: [{ id: "a", name: "Shell 1", kind: "shell", shellCommand: "npm test" }],
        },
      ],
      selectedProjectId: null,
    } as unknown;
    const out = migratePersisted(withShell, 3) as {
      projects: Array<{ agents: Array<{ shellCommand: unknown }> }>;
    };
    expect(out.projects[0]!.agents[0]!.shellCommand).toBe("npm test");
  });
});

describe("projectStore migration — brainstorm→think rename (v7)", () => {
  it("remaps the legacy 'brainstorm' agent kind to 'think'", () => {
    // A v6 record persisted before the Think rename still carries kind: "brainstorm".
    const v6 = {
      projects: [
        {
          id: "p",
          name: "P",
          rootPath: "/x",
          defaultBranch: "main",
          agents: [
            { id: "a", name: "Brainstorm", kind: "brainstorm", parentId: null, baseBranch: null },
            { id: "b", name: "Build 1", kind: "build", parentId: null, baseBranch: "main" },
          ],
        },
      ],
      selectedProjectId: null,
    } as unknown;
    const out = migratePersisted(v6, 6) as {
      projects: Array<{ agents: Array<{ id: string; kind: unknown }> }>;
    };
    expect(out.projects[0]!.agents[0]!.kind).toBe("think");
    // Non-brainstorm kinds are left untouched.
    expect(out.projects[0]!.agents[1]!.kind).toBe("build");
  });
});
