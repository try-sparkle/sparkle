import { afterEach, describe, expect, it, vi } from "vitest";

import { ASK_LABEL, askBeadBody, asksIn, seenLabel } from "@sparkle/core";

import {
  captureAsksFrom,
  openAsksNow,
  refreshOpenAsks,
  resetAskQueueForTest,
  startAskQueue,
} from "./conciergeAskQueue";
import type { Bead } from "./beads";

const AT = 1_700_000_000_000;

function bead(over: Partial<Bead> & Pick<Bead, "id" | "title">): Bead {
  return {
    description: "",
    status: "open",
    labels: [ASK_LABEL],
    ...over,
  } as Bead;
}

/** A bead that already holds a captured ask, keyed the way the real filing path keys it. */
function askBeadFor(id: string, sentence: string, over: Partial<Bead> = {}): Bead {
  const ask = asksIn(sentence, "t0", AT).asks[0]!;
  return bead({ id, title: sentence, description: askBeadBody(ask), ...over });
}

interface Harness {
  beadsByProject: Record<string, Bead[]>;
  createBead: ReturnType<typeof vi.fn>;
  labelBead: ReturnType<typeof vi.fn>;
  listBeads: ReturnType<typeof vi.fn>;
}

function wire(
  beadsByProject: Record<string, Bead[]>,
  opts: { projects?: Array<{ id: string; rootPath: string }>; pinned?: string | null } = {},
): Harness {
  const projects = opts.projects ?? [{ id: "p1", rootPath: "/repo/one" }];
  const listBeads = vi.fn(async (path: string) => beadsByProject[path] ?? []);
  const createBead = vi.fn(async () => "sparkle-new1");
  const labelBead = vi.fn(async () => undefined);
  startAskQueue({
    projects: () => projects,
    pinnedProjectId: () => opts.pinned ?? projects[0]?.id ?? null,
    listBeads,
    createBead,
    labelBead,
    now: () => AT,
  });
  return { beadsByProject, createBead, labelBead, listBeads };
}

afterEach(() => {
  resetAskQueueForTest();
  vi.restoreAllMocks();
});

describe("reading the queue", () => {
  it("surfaces an open ask filed in a PREVIOUS session", async () => {
    // The point of the whole feature: this bead was written by a context that no longer exists.
    wire({ "/repo/one": [askBeadFor("sparkle-aaa1", "build ten homepage designs")] });
    await refreshOpenAsks();
    expect(openAsksNow()).toEqual([
      { beadId: "sparkle-aaa1", sentence: "build ten homepage designs", timesAsked: 1 },
    ]);
  });

  it("does not surface a closed ask", async () => {
    wire({
      "/repo/one": [askBeadFor("sparkle-aaa1", "build ten homepage designs", { status: "closed" })],
    });
    await refreshOpenAsks();
    expect(openAsksNow()).toEqual([]);
  });

  it("ignores beads that are not asks", async () => {
    wire({ "/repo/one": [bead({ id: "sparkle-x", title: "unrelated work", labels: [] })] });
    await refreshOpenAsks();
    expect(openAsksNow()).toEqual([]);
  });

  it("reads across EVERY project, so a moved pin cannot hide his backlog", async () => {
    wire(
      {
        "/repo/one": [askBeadFor("sparkle-aaa1", "build ten homepage designs")],
        "/repo/two": [askBeadFor("sparkle-bbb2", "research the Gary Tan ideas")],
      },
      {
        projects: [
          { id: "p1", rootPath: "/repo/one" },
          { id: "p2", rootPath: "/repo/two" },
        ],
        pinned: "p1",
      },
    );
    await refreshOpenAsks();
    expect(openAsksNow().map((a) => a.beadId).sort()).toEqual(["sparkle-aaa1", "sparkle-bbb2"]);
  });

  it("a project whose board cannot be read does not blank the others", async () => {
    const h = wire(
      { "/repo/two": [askBeadFor("sparkle-bbb2", "research the Gary Tan ideas")] },
      {
        projects: [
          { id: "p1", rootPath: "/repo/one" },
          { id: "p2", rootPath: "/repo/two" },
        ],
      },
    );
    h.listBeads.mockImplementation(async (p: string) => {
      if (p === "/repo/one") throw new Error("bd not installed");
      return h.beadsByProject[p] ?? [];
    });
    await refreshOpenAsks();
    expect(openAsksNow().map((a) => a.beadId)).toEqual(["sparkle-bbb2"]);
  });

  // roborev 61877 (High). The cache used to be assigned unconditionally, so a sweep in which EVERY
  // project read threw produced an empty list and silently blanked it — rendering "we could not
  // look" as "you are owed nothing", which is the exact defect this whole file exists to remove.
  // `bd` failing fleet-wide is ordinary: one locked store or a `bd` upgrade does it to all at once.
  it("KEEPS the last good answer when every project read fails", async () => {
    const h = wire({ "/repo/one": [askBeadFor("sparkle-aaa1", "build ten homepage designs")] });
    await refreshOpenAsks();
    expect(openAsksNow()).toHaveLength(1);

    h.listBeads.mockRejectedValue(new Error("bd is unavailable"));
    await refreshOpenAsks();
    expect(openAsksNow().map((a) => a.beadId)).toEqual(["sparkle-aaa1"]);
  });

  it("DOES empty when the board is readable and genuinely holds nothing", async () => {
    // The paired case, so "keep the old answer" cannot be satisfied by never updating at all.
    const h = wire({ "/repo/one": [askBeadFor("sparkle-aaa1", "build ten homepage designs")] });
    await refreshOpenAsks();
    expect(openAsksNow()).toHaveLength(1);

    h.beadsByProject["/repo/one"] = [];
    await refreshOpenAsks();
    expect(openAsksNow()).toEqual([]);
  });

  it("empties when the last project is removed — no projects is a complete reading", async () => {
    wire({}, { projects: [] });
    await refreshOpenAsks();
    expect(openAsksNow()).toEqual([]);
  });

  it("files nothing when no board could be read, so a repeat cannot be duplicated", async () => {
    const h = wire({ "/repo/one": [] });
    h.listBeads.mockRejectedValue(new Error("bd is unavailable"));
    const out = await captureAsksFrom("build ten homepage designs", "turn-x");
    expect(h.createBead).not.toHaveBeenCalled();
    expect(out.filed).toEqual([]);
  });

  it("reports the recurrence count from the label", async () => {
    wire({
      "/repo/one": [
        askBeadFor("sparkle-aaa1", "build ten homepage designs", {
          labels: [ASK_LABEL, seenLabel(3)],
        }),
      ],
    });
    await refreshOpenAsks();
    expect(openAsksNow()[0]?.timesAsked).toBe(3);
  });
});

describe("capturing what he just said", () => {
  it("files a new ask as a labelled bead", async () => {
    const h = wire({ "/repo/one": [] });
    const out = await captureAsksFrom("build ten homepage designs for drodio.com", "turn-1");
    expect(h.createBead).toHaveBeenCalledTimes(1);
    const [path, title, body, labels] = h.createBead.mock.calls[0]!;
    expect(path).toBe("/repo/one");
    expect(title).toBe("build ten homepage designs for drodio.com");
    expect(body).toContain("build ten homepage designs for drodio.com");
    expect(labels).toBe(ASK_LABEL);
    expect(out.filed).toHaveLength(1);
  });

  it("writes nothing at all when he asked for nothing", async () => {
    const h = wire({ "/repo/one": [] });
    await captureAsksFrom("what happened to the homepage designs?", "turn-1");
    expect(h.createBead).not.toHaveBeenCalled();
    expect(h.labelBead).not.toHaveBeenCalled();
  });

  it("bumps the existing bead on a re-ask instead of filing a duplicate", async () => {
    const h = wire({ "/repo/one": [askBeadFor("sparkle-aaa1", "build ten homepage designs")] });
    const out = await captureAsksFrom("Please build ten homepage designs!", "turn-2");
    expect(h.createBead).not.toHaveBeenCalled();
    expect(h.labelBead).toHaveBeenCalledWith("/repo/one", "add", "sparkle-aaa1", seenLabel(2));
    expect(out.bumped).toEqual([{ beadId: "sparkle-aaa1", to: 2 }]);
  });

  it("adds the new rung BEFORE removing the old one", async () => {
    const h = wire({
      "/repo/one": [
        askBeadFor("sparkle-aaa1", "build ten homepage designs", {
          labels: [ASK_LABEL, seenLabel(2)],
        }),
      ],
    });
    await captureAsksFrom("build ten homepage designs", "turn-3");
    // A crash between the two calls must leave the bead reading as escalated, never as
    // never-repeated — so the order is load-bearing, not incidental.
    const actions = h.labelBead.mock.calls.map((c) => [c[1], c[3]]);
    expect(actions).toEqual([
      ["add", seenLabel(3)],
      ["remove", seenLabel(2)],
    ]);
  });

  it("files a FRESH bead citing the old one when he re-asks something already closed", async () => {
    const h = wire({
      "/repo/one": [askBeadFor("sparkle-aaa1", "build ten homepage designs", { status: "closed" })],
    });
    const out = await captureAsksFrom("build ten homepage designs", "turn-4");
    expect(out.reasked).toHaveLength(1);
    expect(out.reasked[0]?.closedBeadId).toBe("sparkle-aaa1");
    expect(h.createBead.mock.calls[0]?.[2]).toContain("sparkle-aaa1");
  });

  it("bumps the bead in the project it actually lives in, not the pinned one", async () => {
    const h = wire(
      {
        "/repo/one": [],
        "/repo/two": [askBeadFor("sparkle-bbb2", "build ten homepage designs")],
      },
      {
        projects: [
          { id: "p1", rootPath: "/repo/one" },
          { id: "p2", rootPath: "/repo/two" },
        ],
        pinned: "p1",
      },
    );
    await captureAsksFrom("build ten homepage designs", "turn-5");
    expect(h.labelBead).toHaveBeenCalledWith("/repo/two", "add", "sparkle-bbb2", seenLabel(2));
  });

  it("makes the new ask visible to the very next turn", async () => {
    // Capture refreshes the cache, so the ask is in context immediately rather than up to a poll
    // interval later — the window in which he could ask again and be told nothing is open.
    const h = wire({ "/repo/one": [] });
    h.createBead.mockImplementation(async () => {
      h.beadsByProject["/repo/one"] = [askBeadFor("sparkle-new1", "build ten homepage designs")];
      return "sparkle-new1";
    });
    await captureAsksFrom("build ten homepage designs", "turn-6");
    expect(openAsksNow().map((a) => a.beadId)).toEqual(["sparkle-new1"]);
  });

  it("never throws at the caller when the board is unwritable", async () => {
    const h = wire({ "/repo/one": [] });
    h.createBead.mockRejectedValue(new Error("bd exploded"));
    await expect(captureAsksFrom("build ten homepage designs", "turn-7")).resolves.toMatchObject({
      filed: [],
    });
  });

  it("does nothing before the queue is wired", async () => {
    resetAskQueueForTest();
    await expect(captureAsksFrom("build ten homepage designs", "turn-8")).resolves.toMatchObject({
      filed: [],
    });
    expect(openAsksNow()).toEqual([]);
  });
});
