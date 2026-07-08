import { describe, it, expect, vi } from "vitest";
import {
  updateFrontmatter,
  generateTasks,
  decomposeEpic,
  parsePrdRef,
  TASK_PLAN_SYSTEM,
  EPIC_PLAN_SYSTEM,
  type GenerateDeps,
  type DecomposeDeps,
  type TaskPlan,
  type EpicPlan,
} from "./tasks";

describe("updateFrontmatter", () => {
  it("replaces epic/tasks in an existing block and preserves the rest", () => {
    const md = [
      "---",
      'title: "Foo"',
      "epic: null",
      "tasks: []",
      "---",
      "",
      "# Foo",
      "body",
    ].join("\n");
    const out = updateFrontmatter(md, { epic: "sparkle-x", tasks: ["sparkle-x.1", "sparkle-x.2"] });
    expect(out).toContain('epic: "sparkle-x"');
    expect(out).toContain('tasks: ["sparkle-x.1", "sparkle-x.2"]');
    expect(out).toContain('title: "Foo"');
    expect(out).toContain("# Foo");
  });

  it("adds epic/tasks fields when missing from an existing block", () => {
    const md = ["---", 'title: "Foo"', "---", "", "body"].join("\n");
    const out = updateFrontmatter(md, { epic: "sparkle-x", tasks: ["sparkle-x.1"] });
    expect(out).toContain('epic: "sparkle-x"');
    expect(out).toContain('tasks: ["sparkle-x.1"]');
    expect(out).toContain('title: "Foo"');
  });

  it("prepends a block when there is no frontmatter", () => {
    const out = updateFrontmatter("# Body only", { epic: "sparkle-x", tasks: [] });
    expect(out.startsWith("---\n")).toBe(true);
    expect(out).toContain('epic: "sparkle-x"');
    expect(out).toContain("tasks: []");
    expect(out).toContain("# Body only");
  });
});

function makeDeps(over: Partial<GenerateDeps> = {}) {
  const plan: TaskPlan = {
    epic: { title: "Epic Foo", description: "Do foo" },
    tasks: [
      { title: "T0", description: "first", dependsOn: [] },
      { title: "T1", description: "second", dependsOn: [0] },
      { title: "T2", description: "third", dependsOn: [0, 1] },
    ],
    decisions: ["use BYOK", "no main writes"],
  };
  const structuredJson = vi.fn().mockResolvedValue(plan);
  let n = 0;
  const createBeadFull = vi.fn().mockImplementation(async (_p, _t, _b, type: string) => {
    if (type === "epic") return "sparkle-ep";
    return `sparkle-ep.${++n}`;
  });
  const beadDepAdd = vi.fn().mockResolvedValue(undefined);
  const writePrd = vi.fn().mockResolvedValue("PRD/x.md");
  const createMemory = vi.fn().mockResolvedValue(undefined);
  const attachLabel = vi.fn().mockResolvedValue(undefined);
  const deps: GenerateDeps = {
    structuredJson: structuredJson as unknown as GenerateDeps["structuredJson"],
    createBeadFull,
    beadDepAdd,
    writePrd,
    createMemory,
    attachLabel,
    ...over,
  };
  return { deps, plan, structuredJson, createBeadFull, beadDepAdd, writePrd, createMemory, attachLabel };
}

const args = {
  projectPath: "/repo",
  prdFilename: "2026-06-27-foo.md",
  prdContent: ["---", "epic: null", "tasks: []", "---", "", "# Foo"].join("\n"),
  prdRelPath: "PRD/2026-06-27-foo.md",
  prdAssetId: "asset-1",
};

describe("generateTasks", () => {
  it("creates the epic, children, and dependency edges, then rewrites frontmatter", async () => {
    const { deps, createBeadFull, beadDepAdd, writePrd } = makeDeps();
    const res = await generateTasks(deps, args);

    // epic created with type epic + PRD back-link in the body.
    expect(createBeadFull).toHaveBeenNthCalledWith(
      1,
      "/repo",
      "Epic Foo",
      expect.stringContaining("PRD file: PRD/2026-06-27-foo.md"),
      "epic",
      "",
      "",
      "think-build-loop",
    );
    // each child parented to the epic.
    expect(createBeadFull).toHaveBeenNthCalledWith(2, "/repo", "T0", "first", "task", "sparkle-ep", "", "");
    expect(res.epicId).toBe("sparkle-ep");
    expect(res.taskIds).toEqual(["sparkle-ep.1", "sparkle-ep.2", "sparkle-ep.3"]);

    // deps: T1 dep T0; T2 dep T0 and T1. (blocked, blocker)
    expect(beadDepAdd).toHaveBeenCalledWith("/repo", "sparkle-ep.2", "sparkle-ep.1");
    expect(beadDepAdd).toHaveBeenCalledWith("/repo", "sparkle-ep.3", "sparkle-ep.1");
    expect(beadDepAdd).toHaveBeenCalledWith("/repo", "sparkle-ep.3", "sparkle-ep.2");
    expect(beadDepAdd).toHaveBeenCalledTimes(3);

    // frontmatter rewritten with the ids.
    const [, , content] = writePrd.mock.calls[0]!;
    expect(content).toContain('epic: "sparkle-ep"');
    expect(content).toContain('tasks: ["sparkle-ep.1", "sparkle-ep.2", "sparkle-ep.3"]');
  });

  it("appends epicBodyExtra to the epic body (capture screenshot back-link)", async () => {
    const { deps, createBeadFull } = makeDeps();
    await generateTasks(deps, {
      ...args,
      epicBodyExtra: "Screenshot: PRD/assets/2026-07-01-capture.png",
    });
    const epicBody = createBeadFull.mock.calls[0]![2] as string;
    expect(epicBody).toContain("PRD file: PRD/2026-06-27-foo.md");
    expect(epicBody.endsWith("Screenshot: PRD/assets/2026-07-01-capture.png")).toBe(true);
  });

  it("omits the extra line entirely when epicBodyExtra is absent", async () => {
    const { deps, createBeadFull } = makeDeps();
    await generateTasks(deps, args);
    const epicBody = createBeadFull.mock.calls[0]![2] as string;
    expect(epicBody).not.toContain("Screenshot:");
    expect(epicBody.endsWith("PRD file: PRD/2026-06-27-foo.md")).toBe(true);
  });

  it("stores decisions as memories and labels the PRD asset (best-effort)", async () => {
    const { deps, createMemory, attachLabel } = makeDeps();
    await generateTasks(deps, args);
    expect(createMemory).toHaveBeenCalledWith("use BYOK", "fact");
    expect(createMemory).toHaveBeenCalledWith("no main writes", "fact");
    expect(attachLabel).toHaveBeenCalledWith("asset-1", "sparkle-ep");
  });

  it("does not throw when best-effort memory/label fail", async () => {
    const { deps } = makeDeps({
      createMemory: vi.fn().mockRejectedValue(new Error("mem down")),
      attachLabel: vi.fn().mockRejectedValue(new Error("label down")),
    });
    await expect(generateTasks(deps, args)).resolves.toMatchObject({ epicId: "sparkle-ep" });
  });

  it("skips out-of-range and self dependency indices", async () => {
    const badPlan: TaskPlan = {
      epic: { title: "E", description: "d" },
      tasks: [
        { title: "A", description: "a", dependsOn: [5, 0] }, // 5 out of range, 0 is self
        { title: "B", description: "b", dependsOn: [0] },
      ],
    };
    const { deps, beadDepAdd } = makeDeps({
      structuredJson: vi.fn().mockResolvedValue(badPlan) as never,
    });
    await generateTasks(deps, args);
    // only B->A is valid.
    expect(beadDepAdd).toHaveBeenCalledTimes(1);
    expect(beadDepAdd).toHaveBeenCalledWith("/repo", "sparkle-ep.2", "sparkle-ep.1");
  });

  it("throws on an empty/malformed plan", async () => {
    const { deps } = makeDeps({
      structuredJson: vi.fn().mockResolvedValue({ epic: { title: "x", description: "" }, tasks: [] }) as never,
    });
    await expect(generateTasks(deps, args)).rejects.toThrow(/empty or malformed/);
  });

  it("throws (no beads created) when a task is missing a title", async () => {
    const { deps, createBeadFull } = makeDeps({
      structuredJson: vi.fn().mockResolvedValue({
        epic: { title: "E", description: "d" },
        tasks: [{ title: "ok", description: "a" }, { title: "", description: "b" }],
      }) as never,
    });
    await expect(generateTasks(deps, args)).rejects.toThrow(/no title/);
    expect(createBeadFull).not.toHaveBeenCalled();
  });

  it("dedupes repeated dependsOn indices", async () => {
    const { deps, beadDepAdd } = makeDeps({
      structuredJson: vi.fn().mockResolvedValue({
        epic: { title: "E", description: "d" },
        tasks: [
          { title: "A", description: "a" },
          { title: "B", description: "b", dependsOn: [0, 0, 0] },
        ],
      }) as never,
    });
    await generateTasks(deps, args);
    expect(beadDepAdd).toHaveBeenCalledTimes(1);
    expect(beadDepAdd).toHaveBeenCalledWith("/repo", "sparkle-ep.2", "sparkle-ep.1");
  });

  it("tolerates a missing epic description (no literal 'undefined' in the body)", async () => {
    const { deps, createBeadFull } = makeDeps({
      structuredJson: vi.fn().mockResolvedValue({
        epic: { title: "E" },
        tasks: [{ title: "A", description: "a" }],
      }) as never,
    });
    await generateTasks(deps, args);
    const epicBody = createBeadFull.mock.calls[0]![2] as string;
    expect(epicBody).not.toContain("undefined");
    expect(epicBody).toContain("PRD file:");
  });

  it("exports a usable system prompt", () => {
    expect(TASK_PLAN_SYSTEM).toContain("dependsOn");
  });
});

// ── generateTasks: the native multi-epic EpicPlan path ───────────────────────────────────────────

/** A generateTasks deps set whose structuredJson returns a multi-epic EpicPlan. Each epic bead gets
 *  a distinct id (ep-1, ep-2, …) and its children id off that epic (ep-1.1, ep-2.1, …), so the
 *  flattened taskIds + per-epic parenting are observable. */
function makeMultiEpicDeps(plan: EpicPlan, over: Partial<GenerateDeps> = {}) {
  const structuredJson = vi.fn().mockResolvedValue(plan);
  let epics = 0;
  const childCounters: Record<string, number> = {};
  const createBeadFull = vi.fn().mockImplementation(
    async (_p: string, _t: string, _b: string, type: string, parent: string) => {
      if (type === "epic") {
        const id = `ep-${++epics}`;
        childCounters[id] = 0;
        return id;
      }
      childCounters[parent] = (childCounters[parent] ?? 0) + 1;
      return `${parent}.${childCounters[parent]}`;
    },
  );
  const beadDepAdd = vi.fn().mockResolvedValue(undefined);
  const writePrd = vi.fn().mockResolvedValue("PRD/x.md");
  const deps: GenerateDeps = {
    structuredJson: structuredJson as unknown as GenerateDeps["structuredJson"],
    createBeadFull,
    beadDepAdd,
    writePrd,
    ...over,
  };
  return { deps, structuredJson, createBeadFull, beadDepAdd, writePrd };
}

describe("generateTasks (multi-epic EpicPlan)", () => {
  const twoEpicPlan: EpicPlan = {
    epics: [
      {
        title: "Epic One",
        description: "first deliverable",
        tasks: [
          { title: "A0", description: "a0" },
          { title: "A1", description: "a1", dependsOn: [0] },
        ],
      },
      {
        title: "Epic Two",
        description: "second deliverable",
        tasks: [
          { title: "B0", description: "b0" },
          { title: "B1", description: "b1", dependsOn: [0] },
          { title: "B2", description: "b2", dependsOn: [0, 1] },
        ],
      },
    ],
    decisions: ["split by deliverable"],
  };

  it("prompts with EPIC_PLAN_SYSTEM and creates one bead per epic with its own children", async () => {
    const { deps, structuredJson, createBeadFull, beadDepAdd } = makeMultiEpicDeps(twoEpicPlan);
    const res = await generateTasks(deps, args);

    expect(structuredJson).toHaveBeenCalledWith(EPIC_PLAN_SYSTEM, args.prdContent);

    // Two epic beads, each with the SAME PRD back-link; children parented to their own epic.
    expect(createBeadFull).toHaveBeenNthCalledWith(
      1, "/repo", "Epic One", expect.stringContaining("PRD file: PRD/2026-06-27-foo.md"),
      "epic", "", "", "think-build-loop",
    );
    expect(createBeadFull).toHaveBeenNthCalledWith(2, "/repo", "A0", "a0", "task", "ep-1", "", "");
    expect(createBeadFull).toHaveBeenNthCalledWith(3, "/repo", "A1", "a1", "task", "ep-1", "", "");
    expect(createBeadFull).toHaveBeenNthCalledWith(
      4, "/repo", "Epic Two", expect.stringContaining("PRD file: PRD/2026-06-27-foo.md"),
      "epic", "", "", "think-build-loop",
    );
    expect(createBeadFull).toHaveBeenNthCalledWith(5, "/repo", "B0", "b0", "task", "ep-2", "", "");

    // Result surfaces every epic; epicId stays = epicIds[0]; taskIds flattened in epic order.
    expect(res.epicIds).toEqual(["ep-1", "ep-2"]);
    expect(res.epicId).toBe("ep-1");
    expect(res.taskIds).toEqual(["ep-1.1", "ep-1.2", "ep-2.1", "ep-2.2", "ep-2.3"]);

    // Dependency indices are LOCAL to each epic: A1→A0 within ep-1; B1→B0, B2→B0/B1 within ep-2.
    expect(beadDepAdd).toHaveBeenCalledWith("/repo", "ep-1.2", "ep-1.1");
    expect(beadDepAdd).toHaveBeenCalledWith("/repo", "ep-2.2", "ep-2.1");
    expect(beadDepAdd).toHaveBeenCalledWith("/repo", "ep-2.3", "ep-2.1");
    expect(beadDepAdd).toHaveBeenCalledWith("/repo", "ep-2.3", "ep-2.2");
    expect(beadDepAdd).toHaveBeenCalledTimes(4);
  });

  it("writes epic:/tasks:/epics: back into the frontmatter", async () => {
    const { deps, writePrd } = makeMultiEpicDeps(twoEpicPlan);
    await generateTasks(deps, args);
    const [, , content] = writePrd.mock.calls[0]!;
    expect(content).toContain('epic: "ep-1"');
    expect(content).toContain('epics: ["ep-1", "ep-2"]');
    expect(content).toContain('tasks: ["ep-1.1", "ep-1.2", "ep-2.1", "ep-2.2", "ep-2.3"]');
  });

  it("applies epicBodyExtra to the FIRST epic only", async () => {
    const { deps, createBeadFull } = makeMultiEpicDeps(twoEpicPlan);
    await generateTasks(deps, { ...args, epicBodyExtra: "Screenshot: PRD/assets/shot.png" });
    const firstEpicBody = createBeadFull.mock.calls[0]![2] as string;
    const secondEpicBody = createBeadFull.mock.calls[3]![2] as string;
    expect(firstEpicBody.endsWith("Screenshot: PRD/assets/shot.png")).toBe(true);
    expect(secondEpicBody).not.toContain("Screenshot:");
    expect(secondEpicBody.endsWith("PRD file: PRD/2026-06-27-foo.md")).toBe(true);
  });

  it("rejects an EpicPlan with no epics", async () => {
    const { deps } = makeMultiEpicDeps({ epics: [] });
    await expect(generateTasks(deps, args)).rejects.toThrow(/empty or malformed/);
  });

  it("rejects an epic that has no tasks", async () => {
    const { deps, createBeadFull } = makeMultiEpicDeps({
      epics: [
        { title: "Full", description: "", tasks: [{ title: "T", description: "" }] },
        { title: "Empty", description: "", tasks: [] },
      ],
    });
    await expect(generateTasks(deps, args)).rejects.toThrow(/empty or malformed/);
    expect(createBeadFull).not.toHaveBeenCalled();
  });
});

describe("parsePrdRef", () => {
  it("extracts the relative path and bare filename from a 'PRD file:' line", () => {
    const body = "Do the thing.\n\nPRD file: PRD/2026-07-01-foo.md";
    expect(parsePrdRef(body)).toEqual({
      relPath: "PRD/2026-07-01-foo.md",
      filename: "2026-07-01-foo.md",
    });
  });

  it("returns null when the body has no PRD reference", () => {
    expect(parsePrdRef("just an epic body")).toBeNull();
    expect(parsePrdRef("")).toBeNull();
  });

  it("captures a path containing spaces to the end of the line", () => {
    const body = "Body.\n\nPRD file: PRD/my plan.md\nScreenshot: x.png";
    expect(parsePrdRef(body)).toEqual({ relPath: "PRD/my plan.md", filename: "my plan.md" });
  });
});

// ── decomposeEpic ──────────────────────────────────────────────────────────────────────────────

function makeDecomposeDeps(over: Partial<DecomposeDeps> = {}) {
  const plan: TaskPlan = {
    epic: { title: "ignored", description: "ignored" },
    tasks: [
      { title: "T0", description: "first", dependsOn: [] },
      { title: "T1", description: "second", dependsOn: [0] },
    ],
  };
  const structuredJson = vi.fn().mockResolvedValue(plan);
  let n = 0;
  const createBeadFull = vi.fn().mockImplementation(async () => `sparkle-ep.${++n}`);
  const beadDepAdd = vi.fn().mockResolvedValue(undefined);
  const prdMarkdown = ["---", "epic: null", "tasks: []", "---", "", "# Foo PRD"].join("\n");
  const readPrd = vi.fn().mockResolvedValue(prdMarkdown);
  const writePrd = vi.fn().mockResolvedValue("PRD/2026-07-01-foo.md");
  const deps: DecomposeDeps = {
    structuredJson: structuredJson as unknown as DecomposeDeps["structuredJson"],
    createBeadFull,
    beadDepAdd,
    readPrd,
    writePrd,
    ...over,
  };
  return { deps, prdMarkdown, structuredJson, createBeadFull, beadDepAdd, readPrd, writePrd };
}

const epicWithPrd = {
  id: "sparkle-ep",
  title: "Foo epic",
  description: "Do foo.\n\nPRD file: PRD/2026-07-01-foo.md",
};

describe("decomposeEpic", () => {
  it("plans from the PRD content and creates children + edges under the EXISTING epic", async () => {
    const { deps, prdMarkdown, structuredJson, createBeadFull, beadDepAdd, readPrd } =
      makeDecomposeDeps();
    const res = await decomposeEpic(deps, { projectPath: "/repo", epic: epicWithPrd });

    expect(readPrd).toHaveBeenCalledWith("/repo", "2026-07-01-foo.md");
    // The plan is prompted from the PRD markdown, not the epic body.
    expect(structuredJson).toHaveBeenCalledWith(TASK_PLAN_SYSTEM, prdMarkdown);
    // NO epic bead is created — children only, parented to the existing epic id.
    expect(createBeadFull).toHaveBeenCalledTimes(2);
    expect(createBeadFull).toHaveBeenNthCalledWith(1, "/repo", "T0", "first", "task", "sparkle-ep", "", "");
    expect(createBeadFull).toHaveBeenNthCalledWith(2, "/repo", "T1", "second", "task", "sparkle-ep", "", "");
    expect(res.taskIds).toEqual(["sparkle-ep.1", "sparkle-ep.2"]);
    // T1 depends on T0 (blocked, blocker).
    expect(beadDepAdd).toHaveBeenCalledTimes(1);
    expect(beadDepAdd).toHaveBeenCalledWith("/repo", "sparkle-ep.2", "sparkle-ep.1");
  });

  it("writes the epic + task ids back into the PRD frontmatter when a PRD exists", async () => {
    const { deps, writePrd } = makeDecomposeDeps();
    await decomposeEpic(deps, { projectPath: "/repo", epic: epicWithPrd });
    expect(writePrd).toHaveBeenCalledTimes(1);
    const [path, filename, content] = writePrd.mock.calls[0]!;
    expect(path).toBe("/repo");
    expect(filename).toBe("2026-07-01-foo.md");
    expect(content).toContain('epic: "sparkle-ep"');
    expect(content).toContain('tasks: ["sparkle-ep.1", "sparkle-ep.2"]');
  });

  it("falls back to title+body when the epic has no PRD reference (and skips the write-back)", async () => {
    const { deps, structuredJson, readPrd, writePrd } = makeDecomposeDeps();
    const epic = { id: "sparkle-ep", title: "Bare epic", description: "no prd here" };
    await decomposeEpic(deps, { projectPath: "/repo", epic });
    expect(readPrd).not.toHaveBeenCalled();
    expect(writePrd).not.toHaveBeenCalled();
    const [, user] = structuredJson.mock.calls[0]!;
    expect(user).toContain("Bare epic");
    expect(user).toContain("no prd here");
  });

  it("falls back to title+body when the PRD read fails (and skips the write-back)", async () => {
    const { deps, structuredJson, writePrd } = makeDecomposeDeps({
      readPrd: vi.fn().mockRejectedValue(new Error("gone")),
    });
    await decomposeEpic(deps, { projectPath: "/repo", epic: epicWithPrd });
    expect(writePrd).not.toHaveBeenCalled();
    const [, user] = structuredJson.mock.calls[0]!;
    expect(user).toContain("Foo epic");
  });

  it("treats an empty/whitespace-only PRD as missing (title+body fallback, no write-back)", async () => {
    const { deps, structuredJson, writePrd } = makeDecomposeDeps({
      readPrd: vi.fn().mockResolvedValue("  \n"),
    });
    await decomposeEpic(deps, { projectPath: "/repo", epic: epicWithPrd });
    expect(writePrd).not.toHaveBeenCalled();
    const [, user] = structuredJson.mock.calls[0]!;
    expect(user).toContain("Foo epic");
  });

  it("re-reads the PRD before the write-back so concurrent edits aren't clobbered", async () => {
    const planningCopy = ["---", "epic: null", "tasks: []", "---", "", "# v1"].join("\n");
    const editedCopy = ["---", "epic: null", "tasks: []", "---", "", "# v2 (edited mid-plan)"].join("\n");
    const readPrd = vi.fn().mockResolvedValueOnce(planningCopy).mockResolvedValueOnce(editedCopy);
    const { deps, structuredJson, writePrd } = makeDecomposeDeps({ readPrd });
    await decomposeEpic(deps, { projectPath: "/repo", epic: epicWithPrd });
    // Planned from the first read…
    expect(structuredJson).toHaveBeenCalledWith(TASK_PLAN_SYSTEM, planningCopy);
    // …but the write-back patches the FRESH copy.
    const [, , content] = writePrd.mock.calls[0]!;
    expect(content).toContain("# v2 (edited mid-plan)");
    expect(content).toContain('epic: "sparkle-ep"');
  });

  it("propagates a child-creation failure without any PRD write-back", async () => {
    const { deps, writePrd } = makeDecomposeDeps({
      createBeadFull: vi.fn().mockRejectedValue(new Error("bd down")),
    });
    await expect(
      decomposeEpic(deps, { projectPath: "/repo", epic: epicWithPrd }),
    ).rejects.toThrow("bd down");
    expect(writePrd).not.toHaveBeenCalled();
  });

  it("propagates a write-back failure after the children were created", async () => {
    const { deps, createBeadFull } = makeDecomposeDeps({
      writePrd: vi.fn().mockRejectedValue(new Error("disk full")),
    });
    await expect(
      decomposeEpic(deps, { projectPath: "/repo", epic: epicWithPrd }),
    ).rejects.toThrow("disk full");
    expect(createBeadFull).toHaveBeenCalledTimes(2); // children exist; caller owns the label
  });

  it("throws (no beads created) on an empty or title-less plan", async () => {
    const empty = makeDecomposeDeps({
      structuredJson: vi.fn().mockResolvedValue({ epic: { title: "x" }, tasks: [] }) as never,
    });
    await expect(
      decomposeEpic(empty.deps, { projectPath: "/repo", epic: epicWithPrd }),
    ).rejects.toThrow(/empty or malformed/);
    expect(empty.createBeadFull).not.toHaveBeenCalled();

    const untitled = makeDecomposeDeps({
      structuredJson: vi.fn().mockResolvedValue({
        epic: { title: "x" },
        tasks: [{ title: " ", description: "b" }],
      }) as never,
    });
    await expect(
      decomposeEpic(untitled.deps, { projectPath: "/repo", epic: epicWithPrd }),
    ).rejects.toThrow(/no title/);
    expect(untitled.createBeadFull).not.toHaveBeenCalled();
  });
});
