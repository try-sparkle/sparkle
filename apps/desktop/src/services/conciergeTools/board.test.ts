// The board domain's contract, exercised against a mocked `services/beads`.
//
// `../beads` is mocked rather than `@tauri-apps/api/core`: the normalization of bd's loose JSON is
// beads.ts's own responsibility and has its own tests, so re-deriving it here would assert the same
// thing twice and couple this file to bd's output shape. What IS this module's own is the three
// things below — the column/blocked join, the refusal vocabulary, and the partial-write behaviour.
import { describe, it, expect, vi, beforeEach } from "vitest";

const listBeads = vi.fn();
const blockedBeadIds = vi.fn();
const beadShow = vi.fn();
const createBead = vi.fn();
const claimBead = vi.fn();
const closeBead = vi.fn();
const labelBead = vi.fn();
const deleteBead = vi.fn();

vi.mock("../beads", async (importOriginal) => {
  // The pure helpers (bucketBeads, columnFor, childrenOf, isBeadsUnavailable) are kept REAL — they
  // are the logic this module composes, and stubbing them would leave the join untested.
  const actual = await importOriginal<typeof import("../beads")>();
  return {
    ...actual,
    listBeads: (...a: unknown[]) => listBeads(...a),
    blockedBeadIds: (...a: unknown[]) => blockedBeadIds(...a),
    beadShow: (...a: unknown[]) => beadShow(...a),
    createBead: (...a: unknown[]) => createBead(...a),
    claimBead: (...a: unknown[]) => claimBead(...a),
    closeBead: (...a: unknown[]) => closeBead(...a),
    labelBead: (...a: unknown[]) => labelBead(...a),
    deleteBead: (...a: unknown[]) => deleteBead(...a),
  };
});

const {
  BOARD_OPS,
  BOARD_RISK,
  listItems,
  getItem,
  readyItems,
  blockedItems,
  createItem,
  updateItem,
  deleteItem,
} = await import("./board");

const ROOT = "/repo";

function bead(id: string, over: Partial<import("../beads").Bead> = {}): import("../beads").Bead {
  return {
    id,
    title: `title ${id}`,
    description: "",
    status: "open",
    labels: [],
    parent: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listBeads.mockResolvedValue([]);
  blockedBeadIds.mockResolvedValue(new Set<string>());
  beadShow.mockResolvedValue(null);
  createBead.mockResolvedValue("");
  claimBead.mockResolvedValue(undefined);
  closeBead.mockResolvedValue(undefined);
  labelBead.mockResolvedValue(undefined);
  deleteBead.mockResolvedValue(undefined);
});

describe("classification", () => {
  it("classifies every op — an unclassified op would resolve to `deny` at the policy layer", () => {
    for (const op of BOARD_OPS) expect(BOARD_RISK[op]).toBeTruthy();
  });

  // The distinction the PRD's safety tier rests on: closing is recoverable, deleting is not.
  it("rates delete_item irreversible and update_item routine", () => {
    expect(BOARD_RISK.delete_item).toBe("irreversible");
    expect(BOARD_RISK.update_item).toBe("routine");
    expect(BOARD_RISK.list_items).toBe("read-only");
  });
});

describe("reads join the blocked set onto every row", () => {
  it("tags each item with its column and blocked flag", async () => {
    listBeads.mockResolvedValue([bead("a"), bead("b")]);
    blockedBeadIds.mockResolvedValue(new Set(["b"]));

    const r = await listItems(ROOT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.map((i) => [i.id, i.blocked])).toEqual([
      ["a", false],
      ["b", true],
    ]);
    // The column comes from the REAL columnFor, so a blocked open bead lands in `blocked`.
    expect(r.data.find((i) => i.id === "b")?.column).toBe("blocked");
  });

  it("ready_items excludes blocked and closed work", async () => {
    listBeads.mockResolvedValue([
      bead("ready"),
      bead("stuck"),
      bead("done", { status: "closed" }),
    ]);
    blockedBeadIds.mockResolvedValue(new Set(["stuck"]));

    const r = await readyItems(ROOT);
    expect(r.ok && r.data.map((i) => i.id)).toEqual(["ready"]);
  });

  // `ready_items` answers "what can I start", so returning a bead someone is ALREADY on invites a
  // second agent onto the same task. `in_progress` is its own lane in columnFor and belongs to
  // neither list — a `status !== "closed"` filter would have put it in both.
  it("puts in_progress work in NEITHER lane, matching the board's own columns", async () => {
    listBeads.mockResolvedValue([
      bead("ready"),
      bead("claimed", { status: "in_progress" }),
      bead("claimed-and-blocked", { status: "in_progress" }),
    ]);
    blockedBeadIds.mockResolvedValue(new Set(["claimed-and-blocked"]));

    const ready = await readyItems(ROOT);
    expect(ready.ok && ready.data.map((i) => i.id)).toEqual(["ready"]);

    const stuck = await blockedItems(ROOT);
    expect(stuck.ok && stuck.data.map((i) => i.id)).toEqual([]);

    // And the lanes agree with the column each row reports.
    expect(ready.ok && ready.data.every((i) => i.column === "backlog")).toBe(true);
  });

  it("blocked_items is the complement, and also excludes closed work", async () => {
    listBeads.mockResolvedValue([
      bead("ready"),
      bead("stuck"),
      bead("closed-and-blocked", { status: "closed" }),
    ]);
    blockedBeadIds.mockResolvedValue(new Set(["stuck", "closed-and-blocked"]));

    const r = await blockedItems(ROOT);
    expect(r.ok && r.data.map((i) => i.id)).toEqual(["stuck"]);
  });

  it("get_item returns the item with its children, and null for an unknown id", async () => {
    beadShow.mockResolvedValue(bead("epic"));
    listBeads.mockResolvedValue([bead("kid", { parent: "epic" }), bead("other")]);

    const found = await getItem(ROOT, "epic");
    expect(found.ok).toBe(true);
    if (found.ok) {
      expect(found.data?.item.id).toBe("epic");
      expect(found.data?.children.map((c) => c.id)).toEqual(["kid"]);
    }

    beadShow.mockResolvedValue(null);
    const missing = await getItem(ROOT, "nope");
    expect(missing.ok && missing.data).toBeNull();
  });
});

describe("a project without beads is a supported state, not a failure", () => {
  // "no beads database found" is the substring `isBeadsUnavailable` keys on, and beads.ts documents
  // it as the stable contract. Reported as its own refusal so the concierge says "this project has
  // no beads database" instead of reporting a crash.
  it("reports beads-unavailable rather than an internal error", async () => {
    listBeads.mockRejectedValue(new Error("no beads database found for /repo"));

    const r = await listItems(ROOT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("beads-unavailable");
    expect(r.message).toMatch(/bd init/);
  });

  it("passes a genuine failure through as beads-failed", async () => {
    listBeads.mockRejectedValue(new Error("disk on fire"));

    const r = await listItems(ROOT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect([r.reason, r.message]).toEqual(["beads-failed", "disk on fire"]);
  });
});

describe("writes", () => {
  it("create_item returns the new id", async () => {
    const r = await createItem(ROOT, "a task", "body");
    expect(createBead).toHaveBeenCalledWith(ROOT, "a task", "body");
    expect(r.ok && r.data).toEqual({ id: "" });
  });

  // `bd create` returning something unparseable must not read as a success with no id — the caller
  // would have no handle to the thing it just filed.
  it("refuses when bd creates nothing it can name", async () => {
    createBead.mockResolvedValue(null);
    const r = await createItem(ROOT, "a task", "");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("create-failed");
  });

  it("maps status onto the right bd verb and reports what it applied", async () => {
    const started = await updateItem(ROOT, "x", { status: "in_progress" });
    expect(claimBead).toHaveBeenCalledWith(ROOT, "x");
    expect(started.ok && started.data.applied).toEqual(["status=in_progress"]);

    const done = await updateItem(ROOT, "x", { status: "closed", addLabels: ["shipped"] });
    expect(closeBead).toHaveBeenCalledWith(ROOT, "x");
    expect(labelBead).toHaveBeenCalledWith(ROOT, "add", "x", "shipped");
    expect(done.ok && done.data.applied).toEqual(["status=closed", "+shipped"]);
  });

  // The reason updateItem uses allSettled: a failing label must not cancel the status change that
  // was also asked for. Both are attempted; the op still refuses so the caller retries.
  it("attempts every change even when one fails, then refuses", async () => {
    labelBead.mockRejectedValue(new Error("label rejected"));

    const r = await updateItem(ROOT, "x", { status: "closed", addLabels: ["shipped"] });
    expect(closeBead).toHaveBeenCalledWith(ROOT, "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect([r.reason, r.message]).toEqual(["beads-failed", "label rejected"]);
  });

  it("delete_item wraps the destructive bd call and echoes the id", async () => {
    const r = await deleteItem(ROOT, "gone");
    expect(deleteBead).toHaveBeenCalledWith(ROOT, "gone");
    expect(r.ok && r.data).toEqual({ id: "gone" });
  });
});
