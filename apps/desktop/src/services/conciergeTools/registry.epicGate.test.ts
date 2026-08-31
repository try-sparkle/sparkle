// @vitest-environment jsdom
//
// THE WIRE, for the epic gate (bead `sparkle-xelans.3`). board.epicGate.test.ts proves the DOMAIN
// refuses; this file proves the two arguments survive the registry, and — the half that is easy to
// break by "tightening" the schema — that a create with NO epic decision still REACHES the domain,
// so what the caller gets back is the refusal that names candidate epics rather than a bare
// `bad-args: epicDecision Required` that teaches nothing.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

/** `./board` is the seam under observation: the registry's job on this op is to FORWARD, so the
 *  assertion is on what arrived, and a real bd call is neither available nor the point. */
const createItem = vi.fn();
vi.mock("./board", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./board")>();
  return { ...actual, createItem: (...a: unknown[]) => createItem(...a) };
});

const { dispatchConciergeTool, REGISTRY_CODES } = await import("./registry");
const { useProjectStore } = await import("../../stores/projectStore");

const TOOL_CALL_ID = "tc-epic-1";
let projectId = "";

beforeEach(() => {
  vi.clearAllMocks();
  createItem.mockResolvedValue({
    ok: true,
    op: "create_item",
    risk: "routine",
    data: {
      id: "",
      parent: null,
      epicDecision: "none",
      epicCreated: false,
      reasonRecorded: true,
    },
  });
  projectId = useProjectStore.getState().addProject("Demo", "/tmp/demo");
});

function dispatch(args: Record<string, unknown>) {
  return dispatchConciergeTool({
    domain: "board",
    op: "create_item",
    args: { projectId, ...args },
    toolCallId: TOOL_CALL_ID,
  });
}

describe("board.create_item carries the epic decision across the registry", () => {
  it("forwards the decision and the reason to the domain", async () => {
    await dispatch({
      title: "Column drag target",
      body: "the drag half",
      epicDecision: "sparkle-board",
      epicReason: "this is the drag half of the board column work",
    });

    expect(createItem).toHaveBeenCalledWith("/tmp/demo", "Column drag target", "the drag half", undefined, {
      decision: "sparkle-board",
      reason: "this is the drag half of the board column work",
    });
  });

  // THE ONE THAT BREAKS IF THE PREFLIGHT EVER GETS THE CONTRACT (bead `sparkle-vphgrl`).
  // `createItemArgs` DOES require `epicDecision`; `routeOwningRefusal` relaxes it for the PREFLIGHT
  // alone, so the call still reaches the domain — the only layer that can read the store for the
  // candidate epics a zod message cannot compute. Preflight the unrelaxed contract and this reds.
  it("still reaches the domain when the decision is missing, so the refusal can carry candidates", async () => {
    createItem.mockResolvedValue({
      ok: false,
      op: "create_item",
      risk: "routine",
      reason: "epic-decision-required",
      message: "…\n\nExisting epics that look related to this item:\n  • sparkle-board — …",
    });

    const r = await dispatch({ title: "Column drag target" });

    expect(createItem).toHaveBeenCalledWith("/tmp/demo", "Column drag target", "", undefined, {
      decision: undefined,
      reason: undefined,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("epic-decision-required");
    expect(r.code).not.toBe(REGISTRY_CODES.badArgs);
    expect(r.message).toContain("sparkle-board");
  });

  // `.strict()` still applies. A snake_case typo must be REFUSED rather than silently ignored —
  // an ignored `epic_decision` reads to the model as an answer it gave and the gate never saw.
  it("refuses a misspelled epic argument instead of dropping it", async () => {
    const r = await dispatch({
      title: "Column drag target",
      epic_decision: "none",
      epicReason: "a chore",
    });

    expect(createItem).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe(REGISTRY_CODES.badArgs);
    expect(r.message).toContain("epic_decision");
  });
});
