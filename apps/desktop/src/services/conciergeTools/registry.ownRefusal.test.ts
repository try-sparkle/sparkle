// @vitest-environment jsdom
//
// AN OP CAN DECLARE A FIELD REQUIRED **AND** OWN ITS REFUSAL — bead `sparkle-vphgrl`.
//
// ══ WHAT WAS BROKEN ════════════════════════════════════════════════════════════════════════════
// `dispatchConciergeTool` preflights every call against the route's schema before any domain code
// runs. One schema did two jobs, so a `z.string()` field answered its own absence with a generic
// `bad-args: \`epicDecision\`: Required` and the op — the only layer that can read the store to say
// what to pass instead — was never reached. The author had to pick: a machine-checkable contract,
// or an error the caller can act on.
//
// ══ WHAT THESE TESTS ARE CAREFUL NOT TO BE ════════════════════════════════════════════════════
// "the schema marks the field required" is the vacuous shape here — it asserts a declaration, and
// would pass against a build that answered every such call with the untaught refusal. So NOTHING
// below asserts the declaration. Every assertion is a SIDE EFFECT observed through the real
// dispatch path: a call omitting an owned field comes back carrying the op's own computed text, and
// a call omitting a field nobody owns still comes back `bad-args`.
//
// The other half — that the contract really does declare those fields required — needs no test,
// because `routeOwningRefusal` throws while the route table is being built if a field it names is
// optional. Loosen `epicDecision` back to `.optional()` and this file does not fail an assertion,
// it fails to IMPORT, along with every other suite that touches the registry. An import-time throw
// is a stronger guard than an assertion and cannot be deleted without deleting the seam.
//
// The board tests below drive the REAL `board.createItem` through the REAL registry route — only
// the bd process seams (`services/beads`, `services/beadsCommands`) are mocked — so the teaching
// text asserted is the one a caller actually receives, candidate epics and all.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bead } from "../beads";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

const listBeads = vi.fn();
vi.mock("../beads", async (importOriginal) => {
  // `isEpic` / `childrenOf` stay REAL — they are the one epic resolver, and stubbing them would
  // leave the candidate list asserted against a fake.
  const actual = await importOriginal<typeof import("../beads")>();
  return { ...actual, listBeads: (...a: unknown[]) => listBeads(...a) };
});

const beadsCreate = vi.fn();
vi.mock("../beadsCommands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../beadsCommands")>();
  return { ...actual, beadsCreate: (...a: unknown[]) => beadsCreate(...a) };
});

const { dispatchConciergeTool, REGISTRY_CODES } = await import("./registry");
const { useProjectStore } = await import("../../stores/projectStore");

const ROOT = "/tmp/own-refusal-demo";
let projectId = "";

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

/** An epic BY MEMBERSHIP (it has a child), so nothing here depends on a `type` field. */
const STORE: Bead[] = [
  bead("sparkle-column", { title: "Board column drag and drop" }),
  bead("sparkle-column.1", { title: "drag handle", parent: "sparkle-column" }),
];

beforeEach(() => {
  vi.clearAllMocks();
  listBeads.mockResolvedValue(STORE);
  beadsCreate.mockRejectedValue(new Error("beadsCreate must not be reached by a refused create"));
  projectId = useProjectStore.getState().addProject("Demo", ROOT);
});

function createItem(args: Record<string, unknown>) {
  return dispatchConciergeTool({
    domain: "board",
    op: "create_item",
    args: { projectId, ...args },
    toolCallId: "tc-own-refusal",
  });
}

describe("board.create_item — required in the contract, refused by the op", () => {
  // ══ THE TEST THIS BEAD IS FOR ═════════════════════════════════════════════════════════════════
  // `epicDecision` is REQUIRED by `createItemArgs` — that is enforced at import, see the header —
  // and a call omitting it still reaches the op, which refuses with the sentence it computed: the
  // syntax it wants, and the epics it found by reading the store. Hand the preflight the unrelaxed
  // contract instead and every expectation below reds with `bad-args`.
  it("still answers a missing epicDecision with the op's own teaching text, not bad-args", async () => {
    const r = await createItem({ title: "Column drag target", body: "the drag half" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("epic-decision-required");
    expect(r.code).not.toBe(REGISTRY_CODES.badArgs);
    expect(r.message).toContain("epicDecision");
    expect(r.message).toContain("Existing epics that look related");
    expect(r.message).toContain("sparkle-column");
    // Nothing was filed on the way to being taught.
    expect(beadsCreate).not.toHaveBeenCalled();
  });

  // The second owned field, so the pair cannot be half-wired: `epicReason` is relaxed for the
  // preflight too, and its absence gets the op's own sentence rather than `bad-args`.
  it("lets the op explain why a reason is the point, rather than refusing at the gate", async () => {
    const r = await createItem({ title: "Column drag target", epicDecision: "none" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("epic-reason-required");
    expect(r.message).toContain("epicReason");
    expect(beadsCreate).not.toHaveBeenCalled();
  });

  // THE RELAXATION IS NARROW, observed where it matters: `title` sits in the same schema and was
  // never named, so its requirement is still dispatch's to enforce and still answers `bad-args`. A
  // `relaxOwned` that relaxed the whole object rather than the named mask reds here.
  it("leaves a field it does not own to dispatch's generic bad-args", async () => {
    const r = await createItem({ epicDecision: "none", epicReason: "a chore" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe(REGISTRY_CODES.badArgs);
    expect(r.message).toContain("title");
    expect(beadsCreate).not.toHaveBeenCalled();
  });
});
