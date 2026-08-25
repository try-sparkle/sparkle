// EPIC SIZE GUIDANCE ON THE REAL CREATE PATH — bead `sparkle-o05vcs.4`.
//
// ══ THE TEST THE WHOLE FOUNDER DECISION RIDES ON ══════════════════════════════════════════════
// "Warn above ~8 children suggesting a split. DO NOT REFUSE — he explicitly wants flex." A guard
// that quietly hardened into a gate would look identical from the guidance module's own tests: the
// band would be right, the sentence would be right, and the bead would never get filed. So the
// central assertion here is a SIDE EFFECT and not a string — `beadsCreate` WAS called, with the
// oversized epic as the parent, and the create came back `ok`.
//
// Deliberately a separate file from `board.epicGate.test.ts`: that file is the gate's own suite and
// is being edited on another branch (bead `sparkle-o05vcs.2`), and this suite asserts the opposite
// property — that nothing here refuses. Two files merge; two forks of one file do not.
//
// `board.ts` itself is NOT modified by this bead. The guidance reaches the model through
// `describeCandidates`, which `board.ts` already renders — which is why the refusal assertions
// below pass against an unedited `board.ts`.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Bead } from "../beads";
import type { BeadSummary } from "../beadsCommands";

const listBeads = vi.fn();
const blockedBeadIds = vi.fn();

vi.mock("../beads", async (importOriginal) => {
  // `isEpic` / `childrenOf` stay REAL — they are the ONE epic resolver
  // (scripts/lib/epic-membership-guard.sh), and the child COUNT this bead's guidance reads is
  // theirs. Stubbing them would assert the band against a fake number.
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

/** One epic sitting at exactly the top of the band (8 children) — so the item being filed is the
 *  one that takes it out of band — beside a small epic that must stay silent. Both are epics BY
 *  STRUCTURE, so the real resolver has to do the work. */
function storeWithAFatEpic(): Bead[] {
  return [
    bead("", { title: "Board column rendering" }),
    ...Array.from({ length: 8 }, (_, i) =>
      bead(`.${i + 1}`, { title: `Board chore ${i + 1}`, parent: "" }),
    ),
    bead("sparkle-relay", { title: "Relay reconnect backoff", type: "epic" }),
    bead("sparkle-relay.1", { title: "Relay jitter", parent: "sparkle-relay" }),
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  listBeads.mockResolvedValue(storeWithAFatEpic());
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

describe("guidance, never enforcement", () => {
  // ★ THE CENTRAL ASSERTION. The epic is already at the top of the band and this child takes it
  // out of band — and the item is STILL FILED, under that very epic. If this ever goes red because
  // a refusal was added, the founder's decision has been relitigated, not tightened.
  it("still files the item under an epic that is already at the top of the band", async () => {
    const r = await createItem(ROOT, "Board column drag target", "", undefined, {
      decision: "",
      reason: "same board rendering work",
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.parent).toBe("");
    expect(r.data.epicDecision).toBe("existing");
    // The side effect, not the return shape: `bd create` actually ran, with that parent.
    expect(beadsCreate).toHaveBeenCalledWith(
      ROOT,
      expect.objectContaining({ title: "Board column drag target", parent: "" }),
    );
  });

  // The same store, filed way past the flex allowance. There is no second, stricter threshold at
  // which the advice becomes a gate — the sentence sharpens and the bead is still filed.
  it("still files when the epic is far past the flex allowance", async () => {
    listBeads.mockResolvedValue([
      bead("sparkle-huge", { title: "Board column rendering" }),
      ...Array.from({ length: 30 }, (_, i) =>
        bead(`sparkle-huge.${i + 1}`, { title: `Board chore ${i + 1}`, parent: "sparkle-huge" }),
      ),
    ]);

    const r = await createItem(ROOT, "Board column drag target", "", undefined, {
      decision: "sparkle-huge",
      reason: "same board rendering work",
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.parent).toBe("sparkle-huge");
    expect(beadsCreate).toHaveBeenCalledTimes(1);
  });
});

describe("the suggestion reaches the model where it is choosing", () => {
  // The epic-decision refusal is the moment the model picks an epic. `board.ts` already renders the
  // candidate list there, so the guidance arrives with no change to `board.ts` at all.
  it("shows a split suggestion beside the oversized candidate", async () => {
    const r = await createItem(ROOT, "Board column drag target", "", undefined, {});

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("");
    expect(r.message).toContain("8 open / 8 children");
    expect(r.message).toMatch(/splitting/i);
    // Even inside the refusal — which is about the MISSING DECISION, not about size — the size
    // advice never reads as a size rejection.
    expect(r.message).not.toMatch(/too many children|cannot file under|can't file under/i);
  });

  it("says nothing about splitting when the related epics are inside the band", async () => {
    listBeads.mockResolvedValue([
      bead("sparkle-relay", { title: "Relay reconnect backoff", type: "epic" }),
      bead("sparkle-relay.1", { title: "Relay jitter", parent: "sparkle-relay" }),
    ]);

    const r = await createItem(ROOT, "Relay reconnect jitter", "", undefined, {});

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("sparkle-relay");
    expect(r.message).not.toMatch(/split/i);
  });
});
