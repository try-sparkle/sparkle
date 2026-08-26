// The PRD readers, driven through their REAL production entry points, against the one shape that
// can tell the new rule from the old one: an epic whose recorded `prd` metadata and whose prose
// `PRD file:` line name DIFFERENT paths. Asserting that both routes agree when they say the same
// thing proves nothing — it passes just as well against `parsePrdRef(description)` alone.
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("./ipc", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("../logger", () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { resetEpicPrdIndexCache } from "./epicPrd";
import { decomposeEpic, generateTasks, type DecomposeDeps, type GenerateDeps } from "./tasks";

const PROSE_PATH = "PRD/stale-prose-path.md";
const METADATA_PATH = "PRD/recorded-in-metadata.md";

const EPIC = {
  id: "sparkle-ep",
  title: "Foo epic",
  description: `Do foo.\n\nPRD file: ${PROSE_PATH}`,
};

/** `list_epic_prd` answers with `rows`; every other command acknowledges. */
function ipcAnswers(rows: { id: string; prd: string }[]): void {
  invoke.mockImplementation(async (cmd: string) => (cmd === "list_epic_prd" ? rows : undefined));
}

function decomposeDeps(over: Partial<DecomposeDeps> = {}) {
  const plan = { epic: { title: "E", description: "d" }, tasks: [{ title: "T0", description: "" }] };
  const structuredJson = vi.fn().mockResolvedValue(plan);
  const createBeadFull = vi.fn().mockResolvedValue("sparkle-ep.1");
  const beadDepAdd = vi.fn().mockResolvedValue(undefined);
  const readPrd = vi.fn().mockResolvedValue("---\nepic: null\ntasks: []\n---\n\n# The plan\n");
  const writePrd = vi.fn().mockResolvedValue("ok");
  const deps: DecomposeDeps = {
    structuredJson: structuredJson as unknown as DecomposeDeps["structuredJson"],
    createBeadFull,
    beadDepAdd,
    readPrd,
    writePrd,
    ...over,
  };
  return { deps, readPrd, structuredJson };
}

beforeEach(() => {
  invoke.mockReset();
  resetEpicPrdIndexCache();
});

describe("decomposeEpic reads the epic's PRD through the structured field", () => {
  it("reads the METADATA path, not the different one the description still names", async () => {
    ipcAnswers([{ id: "sparkle-ep", prd: METADATA_PATH }]);
    const { deps, readPrd } = decomposeDeps();

    await decomposeEpic(deps, { projectPath: "/repo", epic: EPIC });

    expect(readPrd).toHaveBeenCalledWith("/repo", "recorded-in-metadata.md");
    expect(readPrd).not.toHaveBeenCalledWith("/repo", "stale-prose-path.md");
  });

  it("PAIRED NEGATIVE — with no metadata for this epic it reads the PARSED prose path", async () => {
    ipcAnswers([{ id: "some-other-epic", prd: METADATA_PATH }]);
    const { deps, readPrd } = decomposeDeps();

    await decomposeEpic(deps, { projectPath: "/repo", epic: EPIC });

    expect(readPrd).toHaveBeenCalledWith("/repo", "stale-prose-path.md");
  });

  it("BACKFILLS the field for a prose-only epic, so the next reader gets it structurally", async () => {
    ipcAnswers([]);
    const { deps } = decomposeDeps();

    await decomposeEpic(deps, { projectPath: "/repo", epic: EPIC });

    expect(invoke).toHaveBeenCalledWith("set_epic_prd", {
      projectPath: "/repo",
      id: "sparkle-ep",
      prdPath: PROSE_PATH,
    });
  });

  it("does NOT re-write the field an epic already carries", async () => {
    ipcAnswers([{ id: "sparkle-ep", prd: METADATA_PATH }]);
    const { deps } = decomposeDeps();

    await decomposeEpic(deps, { projectPath: "/repo", epic: EPIC });

    expect(invoke).not.toHaveBeenCalledWith("set_epic_prd", expect.anything());
  });

  it("a bd write that fails does not cost the epic its decomposition", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_epic_prd") return [];
      throw new Error("bd is busy");
    });
    const { deps, readPrd } = decomposeDeps();

    const res = await decomposeEpic(deps, { projectPath: "/repo", epic: EPIC });

    expect(res.taskIds).toEqual(["sparkle-ep.1"]);
    expect(readPrd).toHaveBeenCalledWith("/repo", "stale-prose-path.md");
  });

  it("an epic with NEITHER plans from its title+body, and records nothing", async () => {
    ipcAnswers([]);
    const { deps, readPrd, structuredJson } = decomposeDeps();
    const bare = { id: "sparkle-bare", title: "Bare", description: "No link here." };

    await decomposeEpic(deps, { projectPath: "/repo", epic: bare });

    expect(readPrd).not.toHaveBeenCalled();
    expect(structuredJson).toHaveBeenCalledWith(
      expect.any(String),
      "# Bare\n\nNo link here.",
      undefined,
      expect.anything(),
    );
    expect(invoke).not.toHaveBeenCalledWith("set_epic_prd", expect.anything());
  });
});

describe("generateTasks records the field as it writes the prose back-link", () => {
  function generateDeps() {
    const structuredJson = vi.fn().mockResolvedValue({
      epics: [
        { title: "Epic One", description: "one", tasks: [{ title: "T0", description: "" }] },
        { title: "Epic Two", description: "two", tasks: [{ title: "T1", description: "" }] },
      ],
    });
    let n = 0;
    const createBeadFull = vi.fn().mockImplementation(async () => `sparkle-${++n}`);
    const deps: GenerateDeps = {
      structuredJson: structuredJson as unknown as GenerateDeps["structuredJson"],
      createBeadFull,
      beadDepAdd: vi.fn().mockResolvedValue(undefined),
      writePrd: vi.fn().mockResolvedValue("ok"),
    };
    return { deps, createBeadFull };
  }

  it("records the SAME path for every epic it creates, from the same argument", async () => {
    ipcAnswers([]);
    const { deps } = generateDeps();

    const res = await generateTasks(deps, {
      projectPath: "/repo",
      prdFilename: "a plan.md",
      prdContent: "# A plan",
      prdRelPath: "PRD/a plan.md",
    });

    // Two epics were created; both carry the structured field, both pointing at the one PRD.
    for (const id of res.epicIds) {
      expect(invoke).toHaveBeenCalledWith("set_epic_prd", {
        projectPath: "/repo",
        id,
        prdPath: "PRD/a plan.md",
      });
    }
  });

  it("a failed metadata write does not undo the epic or its children", async () => {
    invoke.mockRejectedValue(new Error("bd is busy"));
    const { deps, createBeadFull } = generateDeps();

    const res = await generateTasks(deps, {
      projectPath: "/repo",
      prdFilename: "a plan.md",
      prdContent: "# A plan",
      prdRelPath: "PRD/a plan.md",
    });

    expect(res.epicIds).toHaveLength(2);
    expect(res.taskIds).toHaveLength(2);
    expect(createBeadFull).toHaveBeenCalledTimes(4);
  });
});
