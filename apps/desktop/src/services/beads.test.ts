// apps/desktop/src/services/beads.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import {
  listBeads,
  beadShow,
  columnFor,
  bucketBeads,
  childrenOf,
  DELIVERED_LABEL,
  type Bead,
} from "./beads";

afterEach(() => {
  invokeMock.mockReset();
});

function bead(partial: Partial<Bead> & { id: string }): Bead {
  return {
    title: "",
    description: "",
    status: "open",
    labels: [],
    parent: null,
    ...partial,
  };
}

describe("listBeads", () => {
  it("parses + normalizes the bd --json array, tolerating varied/missing keys", async () => {
    invokeMock.mockResolvedValue(
      JSON.stringify([
        {
          id: "sparkle-1",
          title: "First",
          description: "desc",
          status: "open",
          issue_type: "task",
          priority: 1,
          labels: ["a", "b"],
          parent: "sparkle-0",
        },
        // missing description + labels, type under `type`, status `in-progress` variant
        { id: "sparkle-2", title: "Second", status: "in-progress", type: "epic" },
      ]),
    );
    const beads = await listBeads("/proj");
    expect(invokeMock).toHaveBeenCalledWith("list_beads", { projectPath: "/proj" });
    expect(beads).toEqual([
      {
        id: "sparkle-1",
        title: "First",
        description: "desc",
        status: "open",
        type: "task",
        priority: 1,
        labels: ["a", "b"],
        parent: "sparkle-0",
      },
      {
        id: "sparkle-2",
        title: "Second",
        description: "",
        status: "in_progress",
        type: "epic",
        priority: undefined,
        labels: [],
        parent: null,
      },
    ]);
  });

  it("throws a clear error on non-array JSON", async () => {
    invokeMock.mockResolvedValue('{"id":"x"}');
    await expect(listBeads("/proj")).rejects.toThrow(/Expected list_beads to return a JSON array/);
  });

  it("throws a clear error on parse failure", async () => {
    invokeMock.mockResolvedValue("zsh: command not found: bd");
    await expect(listBeads("/proj")).rejects.toThrow(/Failed to parse list_beads JSON output/);
  });
});

describe("beadShow", () => {
  it("returns the single bead from the one-element array", async () => {
    invokeMock.mockResolvedValue(JSON.stringify([{ id: "sparkle-9", title: "Nine" }]));
    const b = await beadShow("/proj", "sparkle-9");
    expect(invokeMock).toHaveBeenCalledWith("bead_show", { projectPath: "/proj", id: "sparkle-9" });
    expect(b?.id).toBe("sparkle-9");
    expect(b?.title).toBe("Nine");
  });

  it("returns null when the array is empty", async () => {
    invokeMock.mockResolvedValue("[]");
    expect(await beadShow("/proj", "missing")).toBeNull();
  });
});

describe("columnFor", () => {
  it("open -> backlog", () => {
    expect(columnFor(bead({ id: "a", status: "open" }))).toBe("backlog");
  });
  it("in_progress -> inProgress", () => {
    expect(columnFor(bead({ id: "a", status: "in_progress" }))).toBe("inProgress");
  });
  it("closed without delivered label -> done", () => {
    expect(columnFor(bead({ id: "a", status: "closed", labels: ["other"] }))).toBe("done");
  });
  it("closed with delivered label -> delivered", () => {
    expect(columnFor(bead({ id: "a", status: "closed", labels: [DELIVERED_LABEL] }))).toBe(
      "delivered",
    );
  });
});

describe("bucketBeads", () => {
  it("groups by column and preserves input order within a column", () => {
    const beads = [
      bead({ id: "b1", status: "open" }),
      bead({ id: "ip1", status: "in_progress" }),
      bead({ id: "d1", status: "closed" }),
      bead({ id: "del1", status: "closed", labels: [DELIVERED_LABEL] }),
      bead({ id: "b2", status: "open" }),
      bead({ id: "d2", status: "closed" }),
    ];
    const board = bucketBeads(beads);
    expect(board.backlog.map((b) => b.id)).toEqual(["b1", "b2"]);
    expect(board.inProgress.map((b) => b.id)).toEqual(["ip1"]);
    expect(board.done.map((b) => b.id)).toEqual(["d1", "d2"]);
    expect(board.delivered.map((b) => b.id)).toEqual(["del1"]);
  });
});

describe("childrenOf", () => {
  it("matches by explicit parent and by id prefix, excluding the epic itself", () => {
    const beads = [
      bead({ id: "epic-1" }),
      bead({ id: "epic-1.1" }),
      bead({ id: "epic-1.2" }),
      bead({ id: "other", parent: "epic-1" }),
      bead({ id: "unrelated" }),
      bead({ id: "epic-10" }), // prefix-ish but not "epic-1." — must NOT match
    ];
    const kids = childrenOf(beads, "epic-1");
    expect(kids.map((b) => b.id)).toEqual(["epic-1.1", "epic-1.2", "other"]);
  });
});
