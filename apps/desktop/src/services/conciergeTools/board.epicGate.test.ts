// THE EPIC GATE — bead `sparkle-xelans.3`.
//
// WHAT THESE TESTS ARE CAREFUL NOT TO BE. "The zod schema marks `epicDecision` required" is the
// vacuous shape here: it asserts a declaration, not a behaviour, and it would pass against a build
// where the domain cheerfully filed the bead anyway. Every test below asserts the SIDE EFFECT —
// whether a bead was created, what PARENT the created row came back with, and what text landed on
// the bead's comment thread.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Bead } from "../beads";
import type { BeadSummary } from "../beadsCommands";

const listBeads = vi.fn();
const blockedBeadIds = vi.fn();

vi.mock("../beads", async (importOriginal) => {
  // `isEpic` / `childrenOf` are kept REAL. They are the ONE epic resolver
  // (scripts/lib/epic-membership-guard.sh), and stubbing them here would leave the gate's central
  // question — "is the id you named actually an epic" — asserted against a fake.
  const actual = await importOriginal<typeof import("../beads")>();
  return {
    ...actual,
    listBeads: (...a: unknown[]) => listBeads(...a),
    blockedBeadIds: (...a: unknown[]) => blockedBeadIds(...a),
  };
});

const beadsCreate = vi.fn();
const beadsComment = vi.fn();
const beadsDetail = vi.fn();

vi.mock("../beadsCommands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../beadsCommands")>();
  return {
    ...actual,
    beadsCreate: (...a: unknown[]) => beadsCreate(...a),
    beadsComment: (...a: unknown[]) => beadsComment(...a),
    beadsDetail: (...a: unknown[]) => beadsDetail(...a),
  };
});

const { createItem } = await import("./board");
const { EPIC_DECISION_MARKER } = await import("./epicDecision");

const ROOT = "/repo";

function bead(id: string, over: Partial<Bead> = {}): Bead {
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

function summary(id: string, over: Partial<BeadSummary> = {}): BeadSummary {
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

/** A store with two real epics — one typed `epic` with no children (a plan not yet broken down),
 *  one that is an epic BY STRUCTURE only — plus a plain task that is neither. The second and third
 *  are what make "is this an epic" a question the real resolver has to answer. */
function storeWithEpics(): Bead[] {
  return [
    bead("sparkle-relay", { title: "Relay reconnect backoff", type: "epic" }),
    bead("sparkle-board", { title: "Board column rendering" }),
    bead("sparkle-board.1", { title: "Column header spacing", parent: "sparkle-board" }),
    bead("sparkle-board.2", {
      title: "Column drag target",
      parent: "sparkle-board",
      status: "closed",
    }),
    bead("sparkle-loose", { title: "Board tooltip copy" }),
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  listBeads.mockResolvedValue(storeWithEpics());
  blockedBeadIds.mockResolvedValue(new Set<string>());
  beadsComment.mockResolvedValue(undefined);
  beadsDetail.mockResolvedValue({ comments: [] });
  beadsCreate.mockImplementation((_root: string, b: { title: string; parent?: string }) =>
    Promise.resolve(
      summary(b.parent ? `${b.parent}.9` : "", {
        title: b.title,
        parent: b.parent ?? null,
      }),
    ),
  );
});

describe("the gate refuses, and the refusal teaches", () => {
  // THE CENTRAL ASSERTION OF THE WHOLE BEAD. Not "the schema says required" — NOTHING WAS FILED.
  it("files nothing at all when no epic decision is supplied", async () => {
    const r = await createItem(ROOT, "Board column drag target", "", undefined, {});

    expect(beadsCreate).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("epic-decision-required");
  });

  // "required" alone teaches nothing — the founder's shape puts the candidates IN the refusal so
  // the next answer is informed rather than a blind `none`.
  it("names computed candidate epics in the refusal", async () => {
    const r = await createItem(ROOT, "Board column drag target", "", undefined, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;

    // Ranked by title/label overlap: "Board column rendering" shares two terms, and it is a real
    // epic by STRUCTURE (children) with no `epic` type anywhere on it.
    expect(r.message).toContain("sparkle-board");
    expect(r.message).toContain("Board column rendering");
    // …and it says how populated that epic is, so "is this the live one" is answerable in place.
    expect(r.message).toContain("1 open / 2 children");
    // An unrelated epic is NOT offered.
    expect(r.message).not.toContain("sparkle-relay");
    // A bead that is not an epic is never offered as one, however well its title matches.
    expect(r.message).not.toContain("sparkle-loose");
  });

  // Prose is UNPARSEABLE on purpose: reading "no epic needed" as an id would file a task under a
  // parent that does not exist, and reading it as `none` would let the gate be answered by accident.
  it("refuses an answer it cannot parse rather than guessing", async () => {
    const r = await createItem(ROOT, "Board column drag target", "", undefined, {
      decision: "no epic needed",
      reason: "it is small",
    });
    expect(beadsCreate).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("epic-decision-required");
    expect(r.message).toContain("no epic needed");
  });

  // The reason is the DURABLE half. A decision with nothing recorded behind it is the default the
  // gate exists to abolish, so it is refused even though the decision itself parsed.
  it("refuses a decision with no reason — including `none`", async () => {
    const r = await createItem(ROOT, "A chore", "", undefined, { decision: "none", reason: "  " });
    expect(beadsCreate).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("epic-reason-required");
  });

  it("refuses an epic id that does not exist, and offers the ones that do", async () => {
    const r = await createItem(ROOT, "Board column drag target", "", undefined, {
      decision: "sparkle-ghost",
      reason: "belongs with the board work",
    });
    expect(beadsCreate).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("unknown-epic");
    expect(r.message).toContain("sparkle-board");
  });

  // A task parented under a bead that is not an epic invents a hierarchy nobody declared — the
  // exact three-meanings drift `scripts/lib/epic-membership-guard.sh` exists to stop.
  it("refuses a bead that exists but is not an epic", async () => {
    const r = await createItem(ROOT, "Board column drag target", "", undefined, {
      decision: "sparkle-loose",
      reason: "looks board-ish",
    });
    expect(beadsCreate).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("not-an-epic");
  });
});

describe("`none` is first-class and unshamed", () => {
  it("files the bead with no parent and RECORDS the reason on it", async () => {
    const r = await createItem(ROOT, "Bump the changelog", "", undefined, {
      decision: "none",
      reason: "a standalone chore with no larger effort behind it",
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The created row's OWN parent, read back off the create — not the argument we passed in.
    expect(r.data.parent).toBeNull();
    expect(r.data.epicDecision).toBe("none");
    expect(r.data.reasonRecorded).toBe(true);

    // WHERE THE REASON LIVES: a comment on the created bead. The body is the original ask and is
    // never edited (AGENTS.md), so the comment thread is the only durable home for this.
    expect(beadsComment).toHaveBeenCalledWith(
      ROOT,
      "",
      `${EPIC_DECISION_MARKER}: no epic — a standalone chore with no larger effort behind it`,
    );
  });

  // A comment that fails must not undo a bead that exists — a caller that retried on it would file
  // the item twice — but it must not be reported as recorded either.
  it("still returns the bead when the comment fails, and says the reason was not recorded", async () => {
    beadsComment.mockRejectedValue(new Error("store busy"));
    const r = await createItem(ROOT, "Bump the changelog", "", undefined, {
      decision: "none",
      reason: "standalone chore",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.id).toBe("");
    expect(r.data.reasonRecorded).toBe(false);
  });
});

describe("an existing epic id parents the task under it", () => {
  it("creates the bead WITH that parent", async () => {
    const r = await createItem(ROOT, "Column drag target", "", undefined, {
      decision: "sparkle-board",
      reason: "this is the drag half of the board column work",
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // THE SIDE EFFECT, not the argument: the parent read back off the created row.
    expect(r.data.parent).toBe("sparkle-board");
    expect(r.data.epicDecision).toBe("existing");
    expect(r.data.epicCreated).toBe(false);
    expect(beadsComment).toHaveBeenCalledWith(
      ROOT,
      "sparkle-board.9",
      `${EPIC_DECISION_MARKER}: existing epic sparkle-board — this is the drag half of the board column work`,
    );
  });

  // A childless bead TYPED `epic` is a plan nobody has decomposed yet — a stage of an epic's life,
  // which `isEpic` deliberately admits. Refusing it would break create → decompose → promote.
  it("accepts a typed epic that has no children yet", async () => {
    const r = await createItem(ROOT, "Backoff jitter", "", undefined, {
      decision: "sparkle-relay",
      reason: "part of the relay reconnect effort",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.parent).toBe("sparkle-relay");
  });
});

describe("`new:<title>` mints the epic and parents the task under it", () => {
  it("creates the epic first, then the task beneath it", async () => {
    beadsCreate
      .mockResolvedValueOnce(summary("sparkle-fresh", { title: "Concierge epic hygiene" }))
      .mockResolvedValueOnce(summary("sparkle-fresh.1", { parent: "sparkle-fresh" }));

    const r = await createItem(ROOT, "Force an epic decision", "the gate", undefined, {
      decision: "new:Concierge epic hygiene",
      reason: "opens the effort this task is the first piece of",
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // ORDER MATTERS: the epic must exist before anything is parented to it, or the edge is broken.
    expect(beadsCreate).toHaveBeenNthCalledWith(
      1,
      ROOT,
      expect.objectContaining({ title: "Concierge epic hygiene", issueType: "epic" }),
    );
    expect(beadsCreate).toHaveBeenNthCalledWith(
      2,
      ROOT,
      expect.objectContaining({ title: "Force an epic decision", parent: "sparkle-fresh" }),
    );

    // The TASK's own parent, read back — the assertion that fails if the parent is dropped between
    // the two creates.
    expect(r.data.id).toBe("sparkle-fresh.1");
    expect(r.data.parent).toBe("sparkle-fresh");
    expect(r.data.epicDecision).toBe("new");
    expect(r.data.epicCreated).toBe(true);
    expect(beadsComment).toHaveBeenCalledWith(
      ROOT,
      "sparkle-fresh.1",
      `${EPIC_DECISION_MARKER}: new epic sparkle-fresh ("Concierge epic hygiene") — opens the effort this task is the first piece of`,
    );
  });

  // If the epic create fails there must be no orphan task: a task parented to an id that was never
  // created is a broken edge, and one filed with no parent silently answers `none` instead.
  it("files no task when the epic could not be created", async () => {
    beadsCreate.mockRejectedValueOnce(new Error("bd exploded"));
    const r = await createItem(ROOT, "Force an epic decision", "", undefined, {
      decision: "new:Concierge epic hygiene",
      reason: "opens the effort",
    });
    expect(r.ok).toBe(false);
    expect(beadsCreate).toHaveBeenCalledTimes(1);
  });
});
