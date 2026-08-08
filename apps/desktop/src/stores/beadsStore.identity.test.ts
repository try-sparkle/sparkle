// An UNCHANGED poll must not churn snapshot identities.
//
// ══ WHAT THESE TESTS ARE GUARDING, AND WHY IDENTITY IS THE ASSERTION ═══════════════════════════
// `refresh` runs every 5s per watched project. It used to write a brand-new `{ beads, board,
// loadedAt }` on every success, so `AgentSidebar`'s ~60 `AgentRow`s — which select `.beads` and
// `.board` — were notified every 5s for a backlog that had not moved. zustand compares selector
// output with `Object.is`, so the assertion that corresponds to "the row did not re-render" is
// `toBe`, never `toEqual`: `toEqual` passes on the churning code too and would prove nothing.
//
// ══ EVERY POSITIVE HAS A PAIRED NEGATIVE ═══════════════════════════════════════════════════════
// A guard that always answered "unchanged" would satisfy every `toBe` here on its own, and would
// freeze the board permanently — the worst possible regression. So each "preserved" case is paired
// with a case proving the SAME setup produces a NEW reference when the content genuinely differs.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Bead } from "../services/beads";

const listBeads = vi.fn();
const blockedBeadIds = vi.fn();
const ensureBeadsDb = vi.fn();
vi.mock("../services/beads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/beads")>();
  return {
    ...actual, // real bucketBeads / isBeadsUnavailable — the bucketing under test must be the real one
    listBeads: (...a: unknown[]) => listBeads(...a),
    blockedBeadIds: (...a: unknown[]) => blockedBeadIds(...a),
    ensureBeadsDb: (...a: unknown[]) => ensureBeadsDb(...a),
  };
});

// The decompose watcher WRITES beads and spends AI; stub it so these cases never reach it.
vi.mock("../services/epicDecompose", () => ({ runDecomposeWatcherForPoll: vi.fn() }));

import {
  useBeadsStore,
  beadsPolledAt,
  snapshotUnchanged,
  COMPARED_BEAD_FIELDS,
  __resetBeadsRefreshInFlightForTest,
} from "./beadsStore";
import { useSettingsStore } from "./settingsStore";

function bead(partial: Partial<Bead> & { id: string }): Bead {
  return { title: "", description: "", status: "open", labels: [], parent: null, ...partial };
}

/** A bead with EVERY optional field populated — the fixture the field-coverage guard reads. */
function fullBead(): Required<Bead> {
  return {
    id: "sparkle-full",
    title: "t",
    description: "d",
    status: "open",
    type: "bug",
    priority: 1,
    labels: ["x", "y"],
    parent: "sparkle-parent",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
  };
}

/**
 * The two selectors `AgentRow` actually uses (AgentSidebar.tsx ~4222 / ~4228), verbatim.
 *
 * Read through these rather than off `byProject.p1` directly: the defect is about what a SUBSCRIBER
 * observes, and a test that reached past the selector could pass while the thing rows read still
 * churned.
 */
const selectBeads = (projectId: string) => useBeadsStore.getState().byProject[projectId]?.beads;
const selectBoard = (projectId: string) => useBeadsStore.getState().byProject[projectId]?.board;

/** One successful poll returning `beads`, through the real production entry point. */
async function poll(projectId: string, beads: Bead[], blocked: string[] = []): Promise<void> {
  // A FRESH array + fresh bead objects every call, exactly like a real `bd` read: the whole point
  // is that equal CONTENT arriving in new objects must not churn the store. Handing back the same
  // array would make every assertion below vacuous.
  listBeads.mockResolvedValueOnce(beads.map((b) => ({ ...b, labels: [...b.labels] })));
  blockedBeadIds.mockResolvedValueOnce(new Set(blocked));
  await useBeadsStore.getState().refresh(projectId, "/proj");
}

beforeEach(() => {
  listBeads.mockReset();
  blockedBeadIds.mockReset();
  ensureBeadsDb.mockReset();
  blockedBeadIds.mockResolvedValue(new Set<string>());
  useBeadsStore.setState({ byProject: {}, loading: {}, error: {} });
  __resetBeadsRefreshInFlightForTest();
});

afterEach(() => {
  vi.useRealTimers();
  useSettingsStore.setState({ beadsEnabled: true });
});

describe("an unchanged poll preserves snapshot identity", () => {
  it("keeps the SAME beads array, board object and entry across two identical polls", async () => {
    const content = [bead({ id: "a" }), bead({ id: "b", status: "in_progress" })];

    await poll("p1", content);
    const beads1 = selectBeads("p1");
    const board1 = selectBoard("p1");
    const entry1 = useBeadsStore.getState().byProject.p1;
    const map1 = useBeadsStore.getState().byProject;

    await poll("p1", content);

    // The side effect: what a subscriber's selector returns is IDENTICAL, so it is not notified.
    expect(selectBeads("p1")).toBe(beads1);
    expect(selectBoard("p1")).toBe(board1);
    // …and the entry + map too, which is what `BoardView` and `BeadPillHost` select.
    expect(useBeadsStore.getState().byProject.p1).toBe(entry1);
    expect(useBeadsStore.getState().byProject).toBe(map1);
    // Sanity: the poll really ran. Without this a broken mock would satisfy every `toBe` above.
    expect(listBeads).toHaveBeenCalledTimes(2);
  });

  it("PAIRED: a poll whose content CHANGED produces new beads/board/entry references", async () => {
    await poll("p1", [bead({ id: "a" })]);
    const beads1 = selectBeads("p1");
    const board1 = selectBoard("p1");
    const entry1 = useBeadsStore.getState().byProject.p1;

    await poll("p1", [bead({ id: "a" }), bead({ id: "b" })]);

    expect(selectBeads("p1")).not.toBe(beads1);
    expect(selectBoard("p1")).not.toBe(board1);
    expect(useBeadsStore.getState().byProject.p1).not.toBe(entry1);
  });

  it("a changed poll and an unchanged poll are distinguishable in the store's output", async () => {
    // The pair above proves the references differ. This proves the VALUE the UI would render
    // tracked the change — a guard that returned a new reference holding stale content would pass
    // the pair and still show the founder a board that never updates.
    await poll("p1", [bead({ id: "a", title: "first" })]);
    await poll("p1", [bead({ id: "a", title: "first" })]); // unchanged
    expect(selectBeads("p1")?.map((b) => b.title)).toEqual(["first"]);

    await poll("p1", [bead({ id: "a", title: "second" })]); // changed
    expect(selectBeads("p1")?.map((b) => b.title)).toEqual(["second"]);
    expect(selectBoard("p1")?.backlog.map((b) => b.title)).toEqual(["second"]);
  });

  it("a REORDER is a change, not a no-op — the board renders order", async () => {
    // `bucketBeads` preserves input order within each column and the columns render it, so
    // normalising (e.g. sorting by id) before comparing would freeze a genuine shuffle on screen.
    await poll("p1", [bead({ id: "a" }), bead({ id: "b" })]);
    const beads1 = selectBeads("p1");

    await poll("p1", [bead({ id: "b" }), bead({ id: "a" })]);

    expect(selectBeads("p1")).not.toBe(beads1);
    expect(selectBeads("p1")?.map((b) => b.id)).toEqual(["b", "a"]);
  });

  it("a bead moving between board columns is a change even though `beads` is identical", async () => {
    // `board = bucketBeads(beads, blocked)` and `blocked` is NOT stored, so beads alone cannot
    // decide this. Comparing only `beads` would freeze the board with `a` in the wrong column.
    const content = [bead({ id: "a", status: "open" })];
    await poll("p1", content, []);
    expect(selectBoard("p1")?.backlog.map((b) => b.id)).toEqual(["a"]);
    const board1 = selectBoard("p1");

    await poll("p1", content, ["a"]); // same beads, now blocked

    expect(selectBoard("p1")).not.toBe(board1);
    expect(selectBoard("p1")?.blocked.map((b) => b.id)).toEqual(["a"]);
    expect(selectBoard("p1")?.backlog).toEqual([]);
  });
});

describe("per-field change detection", () => {
  // A guard that compared only `id` would pass every "unchanged" case above AND the add/remove
  // pair, while silently freezing every edit the founder makes to a title, status or label. One
  // case per compared field, driven through the real `refresh`.
  const mutations: Array<[string, Partial<Bead>]> = [
    ["id", { id: "changed" }],
    ["title", { title: "changed" }],
    ["description", { description: "changed" }],
    ["status", { status: "closed" }],
    ["type", { type: "chore" }],
    ["priority", { priority: 3 }],
    ["parent", { parent: "sparkle-other" }],
    ["createdAt", { createdAt: "2027-01-01T00:00:00Z" }],
    ["updatedAt", { updatedAt: "2027-01-02T00:00:00Z" }],
    ["labels", { labels: ["x", "z"] }],
  ];

  for (const [field, patch] of mutations) {
    it(`treats a changed \`${field}\` as a real change`, async () => {
      const base = { ...fullBead() };
      await poll("p1", [base]);
      const beads1 = selectBeads("p1");

      await poll("p1", [{ ...base, ...patch }]);

      expect(selectBeads("p1")).not.toBe(beads1);
    });
  }

  it("every key of a fully-populated Bead is covered by the comparison", () => {
    // THE DRIFT GUARD. A field added to `Bead` and not added to `COMPARED_BEAD_FIELDS` would be
    // invisible to the equality check — an edit to it would silently never reach the UI. This fails
    // the moment `Bead` grows, forcing the author to extend the comparator (and the table above).
    const covered = new Set<string>([...COMPARED_BEAD_FIELDS, "labels"]);
    expect([...Object.keys(fullBead())].sort()).toEqual([...covered].sort());
    // …and the table above must exercise every one of them, or a listed-but-uncompared field would
    // still slip through.
    expect(mutations.map(([f]) => f).sort()).toEqual([...covered].sort());
  });
});

describe("snapshotUnchanged (the comparator itself)", () => {
  const mk = (beads: Bead[]) => ({
    beads,
    board: { backlog: beads, blocked: [], inProgress: [], done: [], delivered: [] },
    loadedAt: 0,
  });

  it("is true for equal content in different objects, false for a length change", () => {
    const prev = mk([bead({ id: "a" })]);
    const same = mk([bead({ id: "a" })]);
    expect(snapshotUnchanged(prev, same.beads, same.board)).toBe(true);

    const longer = mk([bead({ id: "a" }), bead({ id: "b" })]);
    expect(snapshotUnchanged(prev, longer.beads, longer.board)).toBe(false);
  });

  it("is false when only a board column differs, with identical beads", () => {
    const beads = [bead({ id: "a" })];
    const prev = mk(beads);
    const moved = {
      backlog: [],
      blocked: beads,
      inProgress: [],
      done: [],
      delivered: [],
    };
    expect(snapshotUnchanged(prev, beads, moved)).toBe(false);
  });

  it("is false when a labels array differs in length", () => {
    const prev = mk([bead({ id: "a", labels: ["x"] })]);
    const next = mk([bead({ id: "a", labels: ["x", "y"] })]);
    expect(snapshotUnchanged(prev, next.beads, next.board)).toBe(false);
  });
});

describe("freshness is stamped separately from the snapshot", () => {
  it("advances `beadsPolledAt` on an UNCHANGED poll while the snapshot stays identical", async () => {
    // THE REGRESSION THIS PAIR EXISTS FOR. `BeadPillHost`'s cross-project sweep gates on "when did
    // we last read this project". If that clock had stayed on the snapshot it would now be frozen
    // for any project whose backlog is stable — so the sweep would shell out to `bd` on every pass,
    // which is the convoy the gate exists to prevent. Both halves must hold at once.
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const content = [bead({ id: "a" })];

    await poll("p1", content);
    const beads1 = selectBeads("p1");
    const polled1 = beadsPolledAt("p1");
    expect(polled1).toBe(1_000_000);

    vi.setSystemTime(1_030_000);
    await poll("p1", content);

    expect(selectBeads("p1")).toBe(beads1); // snapshot frozen…
    expect(beadsPolledAt("p1")).toBe(1_030_000); // …freshness is not
  });

  it("`loadedAt` marks when the CONTENT changed, not when we last polled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const content = [bead({ id: "a" })];
    await poll("p1", content);
    expect(useBeadsStore.getState().byProject.p1?.loadedAt).toBe(1_000_000);

    vi.setSystemTime(1_030_000);
    await poll("p1", content); // unchanged — must not move
    expect(useBeadsStore.getState().byProject.p1?.loadedAt).toBe(1_000_000);

    vi.setSystemTime(1_060_000);
    await poll("p1", [bead({ id: "b" })]); // changed — must move
    expect(useBeadsStore.getState().byProject.p1?.loadedAt).toBe(1_060_000);
  });

  it("a FAILED poll does not stamp freshness, so the sweep retries that project", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    await poll("p1", [bead({ id: "a" })]);
    expect(beadsPolledAt("p1")).toBe(1_000_000);

    vi.setSystemTime(1_030_000);
    listBeads.mockRejectedValueOnce(new Error("bd blew up"));
    await useBeadsStore.getState().refresh("p1", "/proj");

    expect(beadsPolledAt("p1")).toBe(1_000_000); // NOT 1_030_000
  });

  it("turning beads off drops the freshness stamp with the snapshot", async () => {
    await poll("p1", [bead({ id: "a" })]);
    expect(beadsPolledAt("p1")).toBeDefined();

    useSettingsStore.setState({ beadsEnabled: false });
    await useBeadsStore.getState().refresh("p1", "/proj");

    expect(useBeadsStore.getState().byProject.p1).toBeUndefined();
    expect(beadsPolledAt("p1")).toBeUndefined();
  });
});

describe("a failed poll can never look like an unchanged success", () => {
  it("sets error, keeps the previous snapshot, and clears loading", async () => {
    await poll("p1", [bead({ id: "a" })]);
    const beads1 = selectBeads("p1");

    listBeads.mockRejectedValueOnce(new Error("bd blew up"));
    await expect(useBeadsStore.getState().refresh("p1", "/proj")).resolves.toBeUndefined();

    expect(useBeadsStore.getState().error.p1).toBe("bd blew up");
    expect(useBeadsStore.getState().loading.p1).toBe(false);
    // The previous snapshot survives — the failure path never routes through the success commit,
    // so it cannot be mistaken for "nothing changed".
    expect(selectBeads("p1")).toBe(beads1);
  });

  it("a success after a failure still clears the error, even when the content is unchanged", async () => {
    // The no-op branch returns the byProject map untouched — it must NOT also skip clearing the
    // error, or a transient `bd` failure would leave a permanent banner on a healthy board.
    const content = [bead({ id: "a" })];
    await poll("p1", content);

    listBeads.mockRejectedValueOnce(new Error("transient"));
    await useBeadsStore.getState().refresh("p1", "/proj");
    expect(useBeadsStore.getState().error.p1).toBe("transient");

    const beads1 = selectBeads("p1");
    await poll("p1", content); // identical content
    expect(useBeadsStore.getState().error.p1).toBeUndefined();
    expect(selectBeads("p1")).toBe(beads1); // …and still no churn
  });
});
