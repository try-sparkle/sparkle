import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("./ipc", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("../logger", () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import {
  EPIC_PRD_METADATA_KEY,
  epicPrdIndexFrom,
  epicPrdIndexSnapshot,
  listEpicPrd,
  loadEpicPrdIndex,
  parsePrdRef,
  resolveEpicPrdPath,
  resolveEpicPrdRef,
  resetEpicPrdIndexCache,
  setEpicPrd,
} from "./epicPrd";

beforeEach(() => {
  invoke.mockReset();
  resetEpicPrdIndexCache();
});

/** An epic whose body still carries an OLD, DIFFERENT `PRD file:` line. The disagreement is the
 *  whole point: it is the only shape in which "prefer the metadata" and "parse the prose" give
 *  different answers, so it is the only shape that can tell the new rule from the one it replaced. */
const DISAGREEING_EPIC = {
  id: "",
  description: "Ship the thing.\n\nPRD file: PRD/stale-prose-path.md",
};
const STRUCTURED = new Map([["", "PRD/recorded-in-metadata.md"]]);

describe("the key", () => {
  it("mirrors EPIC_PRD_KEY in src-tauri/src/epic_prd.rs", () => {
    // A second spelling on either side writes a key nothing reads, silently.
    expect(EPIC_PRD_METADATA_KEY).toBe("prd");
  });
});

describe("resolveEpicPrdPath — structured first, prose as fallback", () => {
  it("resolves the METADATA path even when the description names a different one", () => {
    expect(resolveEpicPrdPath(DISAGREEING_EPIC, STRUCTURED)).toBe("PRD/recorded-in-metadata.md");
  });

  it("falls back to the parsed prose path when the epic has NO metadata", () => {
    expect(resolveEpicPrdPath(DISAGREEING_EPIC, new Map())).toBe("PRD/stale-prose-path.md");
    expect(resolveEpicPrdPath(DISAGREEING_EPIC, null)).toBe("PRD/stale-prose-path.md");
    expect(resolveEpicPrdPath(DISAGREEING_EPIC)).toBe("PRD/stale-prose-path.md");
  });

  it("treats a blank metadata value as ABSENT rather than as 'no PRD'", () => {
    // A key that lost its value must degrade to the prose the epic has always carried.
    const blank = new Map([["", "   "]]);
    expect(resolveEpicPrdPath(DISAGREEING_EPIC, blank)).toBe("PRD/stale-prose-path.md");
  });

  it("returns null for an epic with neither, and for no bead at all", () => {
    expect(resolveEpicPrdPath({ id: "x", description: "no link here" }, STRUCTURED)).toBeNull();
    expect(resolveEpicPrdPath({ id: "x" }, STRUCTURED)).toBeNull();
    expect(resolveEpicPrdPath(null, STRUCTURED)).toBeNull();
    expect(resolveEpicPrdPath(undefined)).toBeNull();
  });

  it("only answers for the bead the metadata names", () => {
    const other = { id: "sparkle-other", description: "Body.\n\nPRD file: PRD/its-own.md" };
    expect(resolveEpicPrdPath(other, STRUCTURED)).toBe("PRD/its-own.md");
  });
});

describe("resolveEpicPrdRef — the same rule, with the bare filename read_prd takes", () => {
  it("splits the METADATA path, not the prose one", () => {
    expect(resolveEpicPrdRef(DISAGREEING_EPIC, STRUCTURED)).toEqual({
      relPath: "PRD/recorded-in-metadata.md",
      filename: "recorded-in-metadata.md",
    });
  });

  it("keeps spaces in a recorded path — real PRD filenames have them", () => {
    const idx = new Map([["", "PRD/my big plan.md"]]);
    expect(resolveEpicPrdRef(DISAGREEING_EPIC, idx)).toEqual({
      relPath: "PRD/my big plan.md",
      filename: "my big plan.md",
    });
  });

  it("falls back to the parsed ref with no metadata", () => {
    expect(resolveEpicPrdRef(DISAGREEING_EPIC, new Map())).toEqual({
      relPath: "PRD/stale-prose-path.md",
      filename: "stale-prose-path.md",
    });
  });
});

describe("parsePrdRef — kept, because thousands of epics have only the prose line", () => {
  it("still reads a 'PRD file:' line, spaces included", () => {
    expect(parsePrdRef("Body.\n\nPRD file: PRD/my plan.md\nScreenshot: x.png")).toEqual({
      relPath: "PRD/my plan.md",
      filename: "my plan.md",
    });
    expect(parsePrdRef("just an epic body")).toBeNull();
  });
});

describe("the commands", () => {
  it("set_epic_prd is invoked with the camelCase args the Rust command takes", async () => {
    invoke.mockResolvedValue(undefined);
    await setEpicPrd("/repo", "", "PRD/a plan.md");
    expect(invoke).toHaveBeenCalledWith("set_epic_prd", {
      projectPath: "/repo",
      id: "",
      prdPath: "PRD/a plan.md",
    });
  });

  it("list_epic_prd keeps the good rows and SKIPS the malformed ones", async () => {
    // The Rust `EpicPrdEntry` has no `Option` field today, so nothing can arrive as null — but a
    // future one would arrive as an explicit `null`, never as an absent key, and an all-or-nothing
    // parser that rejected the payload would make this feature silently inert for every epic.
    invoke.mockResolvedValue([
      { id: "a", prd: "PRD/a.md" },
      { id: "b", prd: null },
      { id: "", prd: "PRD/orphan.md" },
      { prd: "PRD/no-id.md" },
      { id: "c", prd: "   " },
      { id: "d", prd: "  PRD/d.md  " },
      null,
      "nonsense",
    ]);
    expect(await listEpicPrd("/repo")).toEqual([
      { id: "a", prd: "PRD/a.md" },
      { id: "d", prd: "PRD/d.md" },
    ]);
  });

  it("a non-array answer reads as no entries rather than throwing", async () => {
    invoke.mockResolvedValue({ oops: true });
    expect(await listEpicPrd("/repo")).toEqual([]);
  });
});

describe("the cached index", () => {
  it("resolves through the index a load produced", async () => {
    invoke.mockResolvedValue([{ id: "", prd: "PRD/recorded-in-metadata.md" }]);
    const index = await loadEpicPrdIndex("/repo");
    expect(resolveEpicPrdPath(DISAGREEING_EPIC, index)).toBe("PRD/recorded-in-metadata.md");
  });

  it("reads bd ONCE for N callers in the same window, and serves the snapshot after", async () => {
    invoke.mockResolvedValue([{ id: "", prd: "PRD/recorded-in-metadata.md" }]);
    await Promise.all([
      loadEpicPrdIndex("/repo"),
      loadEpicPrdIndex("/repo"),
      loadEpicPrdIndex("/repo"),
    ]);
    await loadEpicPrdIndex("/repo");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(epicPrdIndexSnapshot("/repo").get("")).toBe("PRD/recorded-in-metadata.md");
  });

  it("re-reads once the TTL has passed, and on force", async () => {
    invoke.mockResolvedValue([]);
    await loadEpicPrdIndex("/repo");
    await loadEpicPrdIndex("/repo", { now: Date.now() + 10 * 60_000 });
    expect(invoke).toHaveBeenCalledTimes(2);
    await loadEpicPrdIndex("/repo", { force: true });
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it("a FAILED bd read yields an empty index rather than throwing", async () => {
    // The reader then falls back to the prose link — the behaviour the app had before this field.
    invoke.mockRejectedValue(new Error("bd is busy"));
    const index = await loadEpicPrdIndex("/repo");
    expect([...index.keys()]).toEqual([]);
    expect(resolveEpicPrdPath(DISAGREEING_EPIC, index)).toBe("PRD/stale-prose-path.md");
  });

  it("a failed read is NOT cached, so the next ask tries again", async () => {
    invoke.mockRejectedValueOnce(new Error("bd is busy"));
    await loadEpicPrdIndex("/repo");
    invoke.mockResolvedValue([{ id: "", prd: "PRD/recorded-in-metadata.md" }]);
    const index = await loadEpicPrdIndex("/repo");
    expect(resolveEpicPrdPath(DISAGREEING_EPIC, index)).toBe("PRD/recorded-in-metadata.md");
  });

  it("a project with no checkout path never reaches bd", async () => {
    expect([...(await loadEpicPrdIndex(null)).keys()]).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("indexes are per project path", async () => {
    invoke.mockResolvedValueOnce([{ id: "", prd: "PRD/one.md" }]);
    await loadEpicPrdIndex("/repo-one");
    expect(epicPrdIndexSnapshot("/repo-two").size).toBe(0);
  });
});

describe("epicPrdIndexFrom", () => {
  it("maps id → path", () => {
    expect([...epicPrdIndexFrom([{ id: "a", prd: "PRD/a.md" }]).entries()]).toEqual([
      ["a", "PRD/a.md"],
    ]);
  });
});
