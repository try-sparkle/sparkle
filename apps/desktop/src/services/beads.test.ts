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
  STALLED_LABEL,
  SWEEP_RESTART_PREFIX,
  sweepRestartedAt,
  bucketBeads,
  childrenOf,
  isEpic,
  buildEpicIndex,
  isEpicIndexed,
  parseCreatedBeadId,
  mergeShaOf,
  severityOf,
  SEVERITY_LABEL_PREFIX,
  recordBeadMergeSha,
  MERGED_SHA_PREFIX,
  DELIVERED_LABEL,
  ARCHIVED_LABEL,
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

describe("sweepRestartedAt", () => {
  it("reads the epoch-ms out of the marker label", () => {
    expect(sweepRestartedAt(bead({ id: "e", labels: [`${SWEEP_RESTART_PREFIX}1700000000000`] }))).toBe(
      1700000000000,
    );
  });
  it("is null when the epic carries no marker", () => {
    // NULL MEANS "the sweep has never restarted this", which the engine reads as "still owed its
    // one attempt". A 0 here would read as "restarted at the dawn of time" and escalate every
    // stalled epic on sight instead of ever restarting one.
    expect(sweepRestartedAt(bead({ id: "e", labels: ["stalled", "other"] }))).toBeNull();
  });
  it("takes the NEWEST when more than one survives", () => {
    const b = bead({
      id: "e",
      labels: [`${SWEEP_RESTART_PREFIX}100`, `${SWEEP_RESTART_PREFIX}900`],
    });
    expect(sweepRestartedAt(b)).toBe(900);
  });
  it("ignores an unparseable value rather than treating it as 0", () => {
    expect(sweepRestartedAt(bead({ id: "e", labels: [`${SWEEP_RESTART_PREFIX}garbage`] }))).toBeNull();
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
  it("closed with archived label -> archived", () => {
    expect(columnFor(bead({ id: "a", status: "closed", labels: [ARCHIVED_LABEL] }))).toBe(
      "archived",
    );
  });
  it("closed with BOTH delivered and archived -> delivered (Shipped outranks Archived)", () => {
    // A bead that actually shipped must never be hidden in the collapsed Archived pile just because
    // a low-signal sweep also stamped it. Shipped is the more informative home.
    expect(
      columnFor(bead({ id: "a", status: "closed", labels: [DELIVERED_LABEL, ARCHIVED_LABEL] })),
    ).toBe("delivered");
  });
  it("an OPEN bead carrying the archived label is still backlog, not archived", () => {
    // Archiving is a property of a CLOSED bead — the label only routes once the bead is closed, so a
    // stray label on open work cannot make it vanish from the backlog.
    expect(columnFor(bead({ id: "a", status: "open", labels: [ARCHIVED_LABEL] }))).toBe("backlog");
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
  // THE SECOND SOURCE OF BLOCKED. `bd blocked` answers "waiting on a dependency" and cannot be
  // written to; the stalled label answers "this stopped moving and a restart did not help" and
  // cannot be expressed as a dependency. They share a lane because they share a meaning to the
  // reader, so both must reach it — and the label must not need the set to be present at all,
  // which is the case the epic sweep actually produces.
  it("open AND carrying the stalled label -> blocked, with no blocked set in play", () => {
    expect(columnFor(bead({ id: "a", status: "open", labels: [STALLED_LABEL] }))).toBe("blocked");
  });
  it("the two blocked sources are independent — either one alone is enough", () => {
    expect(columnFor(bead({ id: "a", status: "open", labels: [STALLED_LABEL] }), new Set())).toBe(
      "blocked",
    );
    expect(columnFor(bead({ id: "a", status: "open", labels: [] }), new Set(["a"]))).toBe("blocked");
  });
  it("a CLOSED bead carrying the stalled label is still done, not blocked", () => {
    // Same rule the archived label already follows: a finished bead cannot be waiting on anything,
    // and a leftover mark must not drag it back into the lane the human scans for live problems.
    expect(columnFor(bead({ id: "a", status: "closed", labels: [STALLED_LABEL] }))).toBe("done");
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

  it("routes archived-labelled closed beads to the archived column, away from done", () => {
    const beads = [
      bead({ id: "d1", status: "closed" }),
      bead({ id: "arc1", status: "closed", labels: [ARCHIVED_LABEL] }),
      bead({ id: "arc2", status: "closed", labels: [ARCHIVED_LABEL] }),
      bead({ id: "del1", status: "closed", labels: [DELIVERED_LABEL] }),
    ];
    const board = bucketBeads(beads);
    // The whole point: archived beads land in their own column and DON'T flood Done.
    expect(board.archived.map((b) => b.id)).toEqual(["arc1", "arc2"]);
    expect(board.done.map((b) => b.id)).toEqual(["d1"]);
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

describe("isEpic", () => {
  // THE POINT OF THE PREDICATE. Eight real parents in this repo's store are typed feature/bug/task
  // and carry between 2 and 19 children apiece; keying epic-ness on `type` alone made every one of
  // them invisible as a plan while their children rendered as loose tasks.
  it("treats a bead with children as an epic whatever its issue_type says", () => {
    const parent = bead({ id: "p1", type: "feature" });
    const loose = bead({ id: "loose", type: "task" });
    const beads = [parent, bead({ id: "c1", parent: "p1" }), loose];
    expect(isEpic(beads, parent)).toBe(true);
    expect(isEpic(beads, loose)).toBe(false);
  });

  // The dotted id is bd's DISPLAY form of the same parent edge, so it has to count the same way.
  it("counts a dotted-id child as making its prefix an epic", () => {
    const parent = bead({ id: "p2", type: "bug" });
    expect(isEpic([parent, bead({ id: "p2.1" })], parent)).toBe(true);
  });

  // UNION, NOT REPLACEMENT. `create_plan` files a typed epic with no children yet and only then
  // decomposes it; if children were REQUIRED, a fresh plan would fail isEpic the instant it was
  // created — invisible to list_plans and refused by get_plan/promote_plan_to_build, dead-ending
  // the create → decompose → promote workflow at its first step.
  it("keeps a childless bead typed 'epic' an epic", () => {
    const fresh = bead({ id: "fresh", type: "epic" });
    expect(isEpic([fresh], fresh)).toBe(true);
  });

  it("is tolerant of bd's loose casing on the type field", () => {
    expect(isEpic([bead({ id: "e", type: "Epic" })], bead({ id: "e", type: "Epic" }))).toBe(true);
  });

  // A parentless task is the NORMAL case, not a defect — most beads have no epic and must not be
  // pushed toward one.
  it("does not treat a bead with no children and no epic type as an epic", () => {
    expect(isEpic([bead({ id: "solo" })], bead({ id: "solo" }))).toBe(false);
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

describe("severityOf", () => {
  it("reads the score from the `sev-<N>` label", () => {
    expect(severityOf(bead({ id: "b", labels: [`${SEVERITY_LABEL_PREFIX}3`] }))).toBe(3);
  });
  it("returns null when no sev label is present (renders no badge)", () => {
    expect(severityOf(bead({ id: "b", labels: ["ui", DELIVERED_LABEL] }))).toBeNull();
  });
  it("takes the MAX when duplicate sev labels linger (a decaying score writes both ways)", () => {
    expect(severityOf(bead({ id: "b", labels: [`${SEVERITY_LABEL_PREFIX}1`, `${SEVERITY_LABEL_PREFIX}5`] }))).toBe(5);
  });
  it("ignores a non-numeric or negative suffix rather than reading it as 0", () => {
    expect(severityOf(bead({ id: "b", labels: [`${SEVERITY_LABEL_PREFIX}x`] }))).toBeNull();
    expect(severityOf(bead({ id: "b", labels: [`${SEVERITY_LABEL_PREFIX}-2`] }))).toBeNull();
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


const idxBead = (
  id: string,
  status: Bead["status"],
  parent: string | null = null,
  extra: Partial<Bead> = {},
): Bead => ({ id, title: id, description: "", status, labels: [], parent, ...extra });

// ══ THE INDEX MUST BE `childrenOf` / `isEpic`, EXACTLY ════════════════════════════════════════
//
// `buildEpicIndex` exists purely for speed: the per-bead `isEpic` it replaced was a full scan of
// the store per bead, so both mode narrowings were O(N²) on the render path across every column,
// including the ~1,800-bead archived pile. A faster predicate that answers even slightly
// differently is worse than the slow one, and the difference would surface as an epic quietly
// missing from a column rather than as anything that looks like a bug.
//
// So these do not restate the rules — they CROSS-CHECK the index against the real functions over a
// fixture built to hit every branch of `childrenOf`'s two-clause match at once: a parent edge, a
// dotted id, a GRANDCHILD (matched by two different prefixes), a bead whose parent edge and dotted
// prefix name the same epic (the double-count case), a dotted id whose prefix is not a bead at all,
// and a typed epic with nothing under it.
describe("buildEpicIndex — agrees with childrenOf and isEpic on every bead", () => {
  const fixture: Bead[] = [
    idxBead("e", "open"),
    idxBead("e.1", "open", "e"), //  parent edge AND dotted prefix name the same epic
    idxBead("e.2", "in_progress"), //  dotted prefix only, no parent edge
    idxBead("e.2.a", "closed"), //  GRANDCHILD — a child of BOTH "e" and "e.2"
    idxBead("flat", "open", "e"), //  parent edge only, id shares no prefix
    idxBead("typed", "open", null, { type: "epic" }), //  declared, childless
    idxBead("orphan.7", "open"), //  dotted, but "orphan" is not a bead
    idxBead("plain", "closed"), //  neither
  ];

  it("hasChildren matches isEpic's structural half for every bead in the fixture", () => {
    const index = buildEpicIndex(fixture);
    for (const b of fixture) {
      expect({ id: b.id, epic: isEpicIndexed(index, b) }).toEqual({
        id: b.id,
        epic: isEpic(fixture, b),
      });
    }
  });

  it("statusesByParent matches childrenOf's statuses for every bead in the fixture", () => {
    const index = buildEpicIndex(fixture);
    for (const b of fixture) {
      const expected = childrenOf(fixture, b.id).map((c) => c.status);
      expect({ id: b.id, kids: index.statusesByParent.get(b.id) ?? [] }).toEqual({
        id: b.id,
        kids: expected,
      });
    }
  });

  // The grandchild is the case a "just index b.parent" implementation gets wrong, and it is stated
  // on its own because the two loops above would still pass if `e` merely lost ONE of its three
  // children — a roll-up is a summary, so a missing child can leave the verdict unchanged.
  it("counts a grandchild under BOTH its prefixes, so a roll-up cannot miss in-flight work", () => {
    const index = buildEpicIndex(fixture);
    expect(index.statusesByParent.get("e.2")).toEqual(["closed"]);
    // FOUR children, not three: "flat" reaches "e" by its parent edge while sharing no id prefix,
    // which is the other half of childrenOf's match and easy to forget when reading ids alone.
    expect(index.statusesByParent.get("e")?.slice().sort()).toEqual([
      "closed",
      "in_progress",
      "open",
      "open",
    ]);
  });

  it("records a bead only once when its parent edge and its dotted prefix name the same epic", () => {
    // "e.1" is reachable both ways. Counting it twice would make `e` look busier than it is.
    const index = buildEpicIndex([idxBead("e", "open"), idxBead("e.1", "open", "e")]);
    expect(index.statusesByParent.get("e")).toEqual(["open"]);
  });
});
