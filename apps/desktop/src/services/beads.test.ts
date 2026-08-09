// apps/desktop/src/services/beads.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import {
  listBeads,
  blockedBeadIds,
  blockedBeadIdsOrNull,
  ensureBeadsDb,
  beadShow,
  columnFor,
  bucketBeads,
  childrenOf,
  parseCreatedBeadId,
  mergeShaOf,
  recordBeadMergeSha,
  MERGED_SHA_PREFIX,
  DELIVERED_LABEL,
  AUTO_LABEL,
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

describe("ensureBeadsDb", () => {
  it("invokes the ensure_beads_db command with the project path and returns its status", async () => {
    invokeMock.mockResolvedValue("initialized");
    await expect(ensureBeadsDb("/proj")).resolves.toBe("initialized");
    expect(invokeMock).toHaveBeenCalledWith("ensure_beads_db", { projectPath: "/proj" });
  });

  it("propagates a bd init failure as a rejection", async () => {
    invokeMock.mockRejectedValue(new Error("bd: command not found"));
    await expect(ensureBeadsDb("/proj")).rejects.toThrow("bd: command not found");
  });
});

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

  // ── THE TIMESTAMPS WERE ALWAYS ON THE WIRE ──────────────────────────────────────────────────
  // `bd list --json` returns created_at / updated_at on every row (verified against bd 1.1.2) and
  // the Rust side passes stdout through untouched — `normalizeBead` was the only thing dropping
  // them, which is why the board could not offer a date filter. MUTATION TARGET: deleting either
  // line from normalizeBead makes these undefined and fails here.
  it("carries created_at / updated_at through as createdAt / updatedAt", async () => {
    invokeMock.mockResolvedValue(
      JSON.stringify([
        {
          id: "sparkle-1",
          title: "First",
          status: "open",
          created_at: "2026-08-05T20:06:27Z",
          updated_at: "2026-08-05T20:15:52Z",
        },
      ]),
    );
    const [b] = await listBeads("/proj");
    expect(b?.createdAt).toBe("2026-08-05T20:06:27Z");
    expect(b?.updatedAt).toBe("2026-08-05T20:15:52Z");
  });

  it("also reads camelCase spellings, and leaves them undefined when bd omits them", async () => {
    invokeMock.mockResolvedValue(
      JSON.stringify([
        { id: "a", title: "camel", status: "open", createdAt: "2026-08-01T00:00:00Z" },
        { id: "b", title: "none", status: "open" },
      ]),
    );
    const [camel, none] = await listBeads("/proj");
    expect(camel?.createdAt).toBe("2026-08-01T00:00:00Z");
    // Absent, not "" — the date filter keys on undefined to mean "cannot tell", and an empty
    // string would parse to NaN down a different branch.
    expect(none?.createdAt).toBeUndefined();
    expect(none?.updatedAt).toBeUndefined();
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

// ── The blocked query has TWO failure contracts, and the difference is the whole point ──────────
//
// `beadsStore` caches this answer and reuses it between slow-cadence reads, so it must be able to
// tell "bd says nothing is blocked" from "we could not reach bd" — collapsing the second to an
// empty set would silently wipe a populated Blocked lane on one transient failure. The store's own
// suite mocks `blockedBeadIdsOrNull`, so without these cases the null-on-failure contract it
// depends on would be asserted nowhere and could be quietly removed.
describe("blockedBeadIdsOrNull vs blockedBeadIds", () => {
  it("returns the ids on success, for both", async () => {
    invokeMock.mockResolvedValue(JSON.stringify([{ id: "a" }, { id: "b" }]));
    expect([...((await blockedBeadIdsOrNull("/p")) ?? [])]).toEqual(["a", "b"]);
    expect([...(await blockedBeadIds("/p"))]).toEqual(["a", "b"]);
  });

  it("reports a REJECTED call as null, and never as an empty set", async () => {
    invokeMock.mockRejectedValue(new Error("bd exploded"));
    expect(await blockedBeadIdsOrNull("/p")).toBeNull();
  });

  it("reports UNPARSEABLE output as null too", async () => {
    invokeMock.mockResolvedValue("not json at all");
    expect(await blockedBeadIdsOrNull("/p")).toBeNull();
  });

  it("the collapsing wrapper still degrades a failure to an empty set for its own callers", async () => {
    // The concierge board/plans tools read this one and want a lane, not an error.
    invokeMock.mockRejectedValue(new Error("bd exploded"));
    const ids = await blockedBeadIds("/p");
    expect(ids).toBeInstanceOf(Set);
    expect(ids.size).toBe(0);
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

  // ── BLOCKED IS DERIVED, AND IT ONLY APPLIES TO OPEN BEADS ────────────────────────────────────
  // bd computes blocked from dependency edges; it is not a stored status (BeadStatus is only
  // open | in_progress | closed). The tempting shortcut — reading it off the `dependency_count`
  // the list payload already carries — is wrong in the direction that matters: a bead whose
  // dependencies are all CLOSED has a non-zero count and is perfectly ready.
  it("open AND in the blocked set -> blocked", () => {
    expect(columnFor(bead({ id: "a", status: "open" }), new Set(["a"]))).toBe("blocked");
  });
  it("open and NOT in the set -> backlog, and no set at all means nothing is blocked", () => {
    expect(columnFor(bead({ id: "a", status: "open" }), new Set(["other"]))).toBe("backlog");
    expect(columnFor(bead({ id: "a", status: "open" }))).toBe("backlog");
  });
  it("a bead being WORKED is not blocked, even if bd still lists it", () => {
    // Someone is on it; surfacing it as blocked would be telling the user to act on something
    // that is already moving.
    expect(columnFor(bead({ id: "a", status: "in_progress" }), new Set(["a"]))).toBe("inProgress");
  });
  it("a CLOSED bead is never blocked", () => {
    expect(columnFor(bead({ id: "a", status: "closed", labels: [] }), new Set(["a"]))).toBe("done");
    expect(
      columnFor(bead({ id: "a", status: "closed", labels: [DELIVERED_LABEL] }), new Set(["a"])),
    ).toBe("delivered");
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

  // App-generated Build-agent beads are telemetry, not backlog: one per spawn and one per
  // first-dirty-file, titled from the agent's default display name ("Build 7") with no description.
  // By 2026-07-29 they were 299 of 873 beads (34%) and 74 of the 86 cards in "Being built", so the
  // board was reporting app sessions instead of work. They stay in the DB; they just aren't cards.
  it("excludes sparkle-auto telemetry beads from every column", () => {
    const beads = [
      bead({ id: "real-open", status: "open" }),
      bead({ id: "auto-open", status: "open", labels: [AUTO_LABEL] }),
      bead({ id: "auto-ip", status: "in_progress", labels: [AUTO_LABEL] }),
      bead({ id: "auto-done", status: "closed", labels: [AUTO_LABEL] }),
      bead({ id: "auto-del", status: "closed", labels: [AUTO_LABEL, DELIVERED_LABEL] }),
      bead({ id: "real-ip", status: "in_progress" }),
    ];
    const board = bucketBeads(beads);
    expect(board.backlog.map((b) => b.id)).toEqual(["real-open"]);
    expect(board.inProgress.map((b) => b.id)).toEqual(["real-ip"]);
    expect(board.done).toEqual([]);
    expect(board.delivered).toEqual([]);
    expect(board.blocked).toEqual([]);
  });

  it("still excludes an auto bead that is also blocked", () => {
    const board = bucketBeads(
      [bead({ id: "auto-blocked", status: "open", labels: [AUTO_LABEL] })],
      new Set(["auto-blocked"]),
    );
    expect(board.blocked).toEqual([]);
    expect(board.backlog).toEqual([]);
  });
});

describe("parseCreatedBeadId", () => {
  it("extracts the id from bd's created-issue JSON", () => {
    expect(parseCreatedBeadId('{"id":"","title":"x"}')).toBe("");
    expect(parseCreatedBeadId('{"issue_id":""}')).toBe("");
  });
  it("returns null on a bd error blob or unparseable output", () => {
    expect(parseCreatedBeadId('{"error":"boom"}')).toBeNull();
    expect(parseCreatedBeadId("not json")).toBeNull();
    expect(parseCreatedBeadId("")).toBeNull();
    expect(parseCreatedBeadId("{}")).toBeNull();
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

describe("mergeShaOf", () => {
  it("reads the SHA out of the merged-sha: label", () => {
    const sha = "deadbeef1234deadbeef1234deadbeef12341234";
    expect(mergeShaOf(bead({ id: "b", status: "closed", labels: [`${MERGED_SHA_PREFIX}${sha}`] }))).toBe(sha);
  });
  it("returns null when there's no merged-sha label (e.g. shipped via PR)", () => {
    expect(mergeShaOf(bead({ id: "b", status: "closed", labels: [DELIVERED_LABEL] }))).toBeNull();
  });
  it("returns null for a blank/empty merged-sha label rather than an empty string", () => {
    expect(mergeShaOf(bead({ id: "b", labels: [`${MERGED_SHA_PREFIX}   `] }))).toBeNull();
  });
});

describe("recordBeadMergeSha", () => {
  it("adds the merged-sha:<sha> label via bead_label", async () => {
    invokeMock.mockResolvedValue(undefined);
    await recordBeadMergeSha("/proj", "bd-1", "abc123");
    expect(invokeMock).toHaveBeenCalledWith("bead_label", {
      projectPath: "/proj",
      action: "add",
      id: "bd-1",
      label: `${MERGED_SHA_PREFIX}abc123`,
    });
  });
  it("no-ops on a blank/undefined SHA (an older Rust build, or a land that couldn't resolve HEAD)", async () => {
    await recordBeadMergeSha("/proj", "bd-1", undefined);
    await recordBeadMergeSha("/proj", "bd-1", "  ");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
