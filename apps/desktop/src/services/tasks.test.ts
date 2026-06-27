import { describe, it, expect, vi } from "vitest";
import {
  updateFrontmatter,
  generateTasks,
  TASK_PLAN_SYSTEM,
  type GenerateDeps,
  type TaskPlan,
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
