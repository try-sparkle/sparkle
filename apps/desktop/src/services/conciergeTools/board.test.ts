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
const claimBead = vi.fn();
const closeBead = vi.fn();
const labelBead = vi.fn();
const setBeadPriority = vi.fn();
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
    claimBead: (...a: unknown[]) => claimBead(...a),
    closeBead: (...a: unknown[]) => closeBead(...a),
    labelBead: (...a: unknown[]) => labelBead(...a),
    setBeadPriority: (...a: unknown[]) => setBeadPriority(...a),
    deleteBead: (...a: unknown[]) => deleteBead(...a),
  };
});

// The COMMENT half lives on the other seam (`services/beadsCommands`), so it is mocked separately.
// `isBeadsError` is kept REAL — recognising the structured rejection is precisely what this module
// must get right, and stubbing the recogniser would leave the thing under test untested.
const beadsComment = vi.fn();
const beadsDetail = vi.fn();
const beadsCreate = vi.fn();

vi.mock("../beadsCommands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../beadsCommands")>();
  return {
    ...actual,
    beadsComment: (...a: unknown[]) => beadsComment(...a),
    beadsDetail: (...a: unknown[]) => beadsDetail(...a),
    beadsCreate: (...a: unknown[]) => beadsCreate(...a),
  };
});

const {
  BOARD_OPS,
  BOARD_RISK,
  COMMENT_PAGE_LIMIT,
  listItems,
  getItem,
  readyItems,
  blockedItems,
  listComments,
  createItem,
  updateItem,
  commentItem,
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
    commentCount: 0,
    ...over,
  };
}

/** A `BeadSummary` as `beadsCreate` returns one — the READ-BACK row, which is what makes asserting
 *  the created bead's PARENT (rather than the argument we passed) possible at all. */
function summary(
  id: string,
  over: Partial<import("../beadsCommands").BeadSummary> = {},
): import("../beadsCommands").BeadSummary {
  return {
    id,
    title: `title ${id}`,
    status: "open",
    priority: null,
    issueType: "task",
    assignee: null,
    parent: null,
    labels: [],
    description: "",
    descriptionTruncated: false,
    dependencyCount: 0,
    dependentCount: 0,
    commentCount: 0,
    createdAt: null,
    updatedAt: null,
    closedAt: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listBeads.mockResolvedValue([]);
  blockedBeadIds.mockResolvedValue(new Set<string>());
  beadShow.mockResolvedValue(null);
  claimBead.mockResolvedValue(undefined);
  closeBead.mockResolvedValue(undefined);
  labelBead.mockResolvedValue(undefined);
  setBeadPriority.mockResolvedValue(undefined);
  deleteBead.mockResolvedValue(undefined);
  beadsComment.mockResolvedValue(undefined);
  beadsDetail.mockResolvedValue({ comments: [] });
  beadsCreate.mockImplementation((_root: string, b: { parent?: string }) =>
    Promise.resolve(summary("", { parent: b.parent ?? null })),
  );
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

  // An append can destroy nothing — not the body, not an earlier comment — so it sits with the
  // ordinary bookkeeping rather than behind an approval. Gating it would put the founder back in
  // the loop for every note an agent adds, which is the round-trip this domain exists to remove.
  it("rates comment_item routine and list_comments read-only", () => {
    expect(BOARD_RISK.comment_item).toBe("routine");
    expect(BOARD_RISK.list_comments).toBe("read-only");
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
  // `none` IS A REAL ANSWER, and these tests carry the epic decision because after bead
  // `sparkle-xelans.3` there is no such thing as a create without one. See board.epicGate.test.ts
  // for the gate itself.
  const NONE = { decision: "none", reason: "a one-off chore that belongs to no larger effort" };

  it("create_item returns the new id", async () => {
    const r = await createItem(ROOT, "a task", "body", undefined, NONE);
    // No priority, no parent — the shape a `none` decision produces.
    expect(beadsCreate).toHaveBeenCalledWith(ROOT, {
      title: "a task",
      description: "body",
      priority: undefined,
      parent: undefined,
    });
    expect(r.ok && r.data.id).toBe("");
    expect(r.ok && r.data.parent).toBeNull();
  });

  // THE PRIORITY SEAM AT FILING TIME. Before this, priority could not be expressed at create at
  // all, so a triage rubric had nothing to write through.
  it("create_item forwards a priority through to the bd create", async () => {
    await createItem(ROOT, "a task", "body", 2, NONE);
    expect(beadsCreate).toHaveBeenCalledWith(
      ROOT,
      expect.objectContaining({ title: "a task", priority: "2" }),
    );
  });

  // Priority 0 is bd's HIGHEST and is the value a truthiness test silently drops — which would make
  // the seam useless for exactly the findings it exists to raise.
  it("create_item forwards priority 0 rather than treating it as absent", async () => {
    await createItem(ROOT, "urgent", "body", 0, NONE);
    expect(beadsCreate).toHaveBeenCalledWith(
      ROOT,
      expect.objectContaining({ title: "urgent", priority: "0" }),
    );
  });

  // `bd create` returning something unparseable must not read as a success with no id — the caller
  // would have no handle to the thing it just filed.
  it("refuses when bd creates nothing it can name", async () => {
    beadsCreate.mockResolvedValue(summary(""));
    const r = await createItem(ROOT, "a task", "", undefined, NONE);
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

  // THE OTHER HALF OF THE SEAM: until this existed `update_item` could change status and labels
  // only, so a priority set wrongly at filing time could never be corrected from the board.
  it("update_item sets a priority, including the highest one", async () => {
    const bumped = await updateItem(ROOT, "x", { priority: 1 });
    expect(setBeadPriority).toHaveBeenCalledWith(ROOT, "x", 1);
    expect(bumped.ok && bumped.data.applied).toEqual(["priority=1"]);

    setBeadPriority.mockClear();
    const top = await updateItem(ROOT, "x", { priority: 0 });
    expect(setBeadPriority).toHaveBeenCalledWith(ROOT, "x", 0);
    expect(top.ok && top.data.applied).toEqual(["priority=0"]);
  });

  it("update_item leaves priority alone when none was asked for", async () => {
    await updateItem(ROOT, "x", { status: "closed" });
    expect(setBeadPriority).not.toHaveBeenCalled();
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

// ══ COMMENTS — the append-only path (bead `sparkle-ddhk5x`) ═══════════════════════════════════
//
// A bead's body is the original ask and is never rewritten; everything learned afterwards goes on
// as a comment. These two ops are what make that reachable without shelling out to `bd`.
describe("comments", () => {
  function comment(over: Partial<import("../beadsCommands").BeadComment> = {}) {
    return { id: "c", author: "DROdio", text: "said a thing", createdAt: null, ...over };
  }

  it("comment_item appends through the verified seam and acks with the length, not the text", async () => {
    const r = await commentItem(ROOT, "sparkle-x", "the decision, recorded");
    expect(beadsComment).toHaveBeenCalledWith(ROOT, "sparkle-x", "the decision, recorded");
    expect(r.ok && r.data).toEqual({ id: "sparkle-x", chars: "the decision, recorded".length });
  });

  // THE REASON `attempt` had to learn a second rejection shape. `beadsCommands` rejects with a
  // structured object, not an Error — so the pre-existing `String(e)` arm would have handed the
  // concierge the literal string "[object Object]" as its explanation. This asserts the real
  // message survives, which is the only version of this test that could have caught it.
  it("carries a structured BeadsError's own message through, never [object Object]", async () => {
    beadsComment.mockRejectedValue({ kind: "storeBusy", message: "bd is busy", exitCode: 1 });
    const r = await commentItem(ROOT, "x", "hi");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("beads-failed");
    expect(r.message).toBe("bd is busy");
    expect(r.message).not.toContain("object Object");
  });

  // The two kinds that are a NORMAL state rather than a failure land on the same refusal the other
  // seam's substring match produces — a project with no `bd init` must read identically whichever
  // op noticed.
  it.each(["noWorkspace", "binaryNotFound"] as const)(
    "reports a %s rejection as beads-unavailable, not as a bug",
    async (kind) => {
      beadsComment.mockRejectedValue({ kind, message: "no beads database found", exitCode: 2 });
      const r = await commentItem(ROOT, "x", "hi");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("beads-unavailable");
    },
  );

  it("list_comments returns the thread oldest-first with nothing omitted", async () => {
    beadsDetail.mockResolvedValue({
      comments: [comment({ id: "1", text: "first" }), comment({ id: "2", text: "second" })],
    });
    const r = await listComments(ROOT, "sparkle-x");
    expect(beadsDetail).toHaveBeenCalledWith(ROOT, "sparkle-x");
    expect(r.ok && r.data.comments.map((c) => c.text)).toEqual(["first", "second"]);
    expect(r.ok && [r.data.omitted, r.data.total]).toEqual([0, 2]);
  });

  // WHICH END GETS CUT is the whole judgement in this op, so it is asserted rather than described:
  // the newest comments carry the current decision, the oldest is usually the filing note the body
  // already says. A page that dropped the other end would still be "bounded" and would be useless.
  it("bounds a long thread by dropping the OLDEST, and says how many it dropped", async () => {
    const all = Array.from({ length: COMMENT_PAGE_LIMIT + 3 }, (_, i) =>
      comment({ id: String(i), text: `c${i}` }),
    );
    beadsDetail.mockResolvedValue({ comments: all });

    const r = await listComments(ROOT, "sparkle-x");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.comments).toHaveLength(COMMENT_PAGE_LIMIT);
    expect(r.data.omitted).toBe(3);
    expect(r.data.total).toBe(COMMENT_PAGE_LIMIT + 3);
    // The newest survived and the oldest went — and order within the page is still oldest-first.
    expect(r.data.comments.at(-1)?.text).toBe(`c${COMMENT_PAGE_LIMIT + 2}`);
    expect(r.data.comments[0]?.text).toBe("c3");
  });

  // bd always sends the key, but a shape we did not agree to read must degrade to "no comments"
  // rather than throwing an internal-error at the concierge.
  it("treats a detail with no comments key as an empty thread", async () => {
    beadsDetail.mockResolvedValue({});
    const r = await listComments(ROOT, "x");
    expect(r.ok && r.data).toEqual({ id: "x", comments: [], omitted: 0, total: 0 });
  });
});
