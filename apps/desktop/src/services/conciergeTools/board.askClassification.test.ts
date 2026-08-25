// THE CLASSIFY STEP, ON THE REAL CREATE PATH — bead `sparkle-o05vcs.2`.
//
// WHAT THESE TESTS ARE CAREFUL NOT TO BE. "`classifyAsk` was called with the title" is the vacuous
// shape here: it asserts that a mock received an argument, which stays green against a build that
// throws the verdict away and records nothing. The requirement is "record WHICH rule fired ON THE
// BEAD", so every test below drives the REAL `createItem` and asserts on the TEXT that reached the
// bead's comment thread — the place a human actually reads it three weeks later.
//
// The gate's own comment must survive alongside it. Both records ride ONE `beadsComment` call, so a
// change that starts overwriting one with the other goes red here rather than silently deleting the
// epic decision.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Bead } from "../beads";
import type { BeadSummary } from "../beadsCommands";

const listBeads = vi.fn();
const blockedBeadIds = vi.fn();

vi.mock("../beads", async (importOriginal) => {
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
const { ASK_CLASSIFICATION_MARKER } = await import("../../engine/askClassification");

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

beforeEach(() => {
  vi.clearAllMocks();
  listBeads.mockResolvedValue([bead("sparkle-relay", { title: "Relay reconnect backoff", type: "epic" })]);
  blockedBeadIds.mockResolvedValue(new Set<string>());
  beadsComment.mockResolvedValue(undefined);
  beadsDetail.mockResolvedValue({ comments: [] });
  beadsCreate.mockImplementation((_root: string, b: { title: string; parent?: string }) =>
    Promise.resolve(
      summary(b.parent ? `${b.parent}.9` : "", { title: b.title, parent: b.parent ?? null }),
    ),
  );
});

/** The text that actually reached the bead's comment thread on the last create. */
function recordedOn(beadId: string): string {
  const call = beadsComment.mock.calls.find((c) => c[1] === beadId);
  expect(call, `no comment was written on ${beadId}`).toBeTruthy();
  return String(call![2]);
}

describe("create_item records which classify rule fired, on the bead", () => {
  it("records the TASK rule for a one-finish-line ask", async () => {
    const r = await createItem(ROOT, "Fix the retry backoff jitter", "The reconnect loop retries with a fixed delay.", undefined, {
      decision: "none",
      reason: "a standalone fix, nothing else depends on it",
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // THE SIDE EFFECT: the rule id is on the bead, in a line a human reads.
    const written = recordedOn("");
    expect(written).toContain(`${ASK_CLASSIFICATION_MARKER}: task`);
    expect(written).toContain("task-one-finish-line");
    // And the gate's own record is still there — one comment, two markers.
    expect(written).toContain(EPIC_DECISION_MARKER);
  });

  it("records the 3+-PIECES rule, by id, for an ask that enumerates its pieces", async () => {
    const r = await createItem(
      ROOT,
      "Reconnect handling",
      ["- add jitter to the retry delay", "- surface the attempt count", "- log the failure reason"].join("\n"),
      undefined,
      { decision: "none", reason: "no epic exists for reconnect yet" },
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const written = recordedOn("");
    expect(written).toContain(`${ASK_CLASSIFICATION_MARKER}: epic`);
    expect(written).toContain("epic-three-plus-pieces");
    // The EVIDENCE travels too — "which rule" without "on what" is still a call nobody can argue
    // with, which is the whole thing this bead is about.
    expect(written).toContain("jitter");
  });

  it("records the MULTI-SURFACE rule for an ask that spans two surfaces", async () => {
    const r = await createItem(
      ROOT,
      "Show the agent's model in the sidebar",
      "The Rust side already knows it; the React component has to render it.",
      undefined,
      { decision: "none", reason: "small enough to stand alone" },
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const written = recordedOn("");
    expect(written).toContain(`${ASK_CLASSIFICATION_MARKER}: epic`);
    expect(written).toContain("epic-multiple-surfaces");
    expect(written).toContain("Rust core");
  });

  it("carries the rule id back to the caller so the concierge can CITE it", async () => {
    const r = await createItem(
      ROOT,
      "Reconnect handling",
      ["- add jitter to the retry delay", "- surface the attempt count", "- log the failure reason"].join("\n"),
      undefined,
      { decision: "none", reason: "no epic exists for reconnect yet" },
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.askVerdict).toBe("epic");
    expect(r.data.askRuleId).toBe("epic-three-plus-pieces");
  });

  it("classifies the task being filed, not the epic `new:` mints for it", async () => {
    // `new:` creates TWO beads. The classification is about the ASK, so it belongs on the task —
    // recording it on the epic instead would be a plausible wrong wiring that nothing else catches.
    const r = await createItem(ROOT, "Fix the retry backoff jitter", "", undefined, {
      decision: "new:Relay reliability",
      reason: "opening the epic this belongs under",
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.epicCreated).toBe(true);

    const commentedOn = beadsComment.mock.calls.map((c) => c[1]);
    expect(commentedOn).toEqual([r.data.id]);
    expect(recordedOn(r.data.id)).toContain(`${ASK_CLASSIFICATION_MARKER}: task`);
  });

  it("still files the bead when the record cannot be written, and says the record was lost", async () => {
    beadsComment.mockRejectedValue(new Error("store locked"));

    const r = await createItem(ROOT, "Fix the retry backoff jitter", "", undefined, {
      decision: "none",
      reason: "standalone",
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.id).toBe("");
    expect(r.data.reasonRecorded).toBe(false);
    // The verdict is still reported to the caller — the classification is computed, not stored,
    // so losing the comment must not lose the call itself.
    expect(r.data.askRuleId).toBe("task-one-finish-line");
  });
});
