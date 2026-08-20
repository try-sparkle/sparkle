// THE ONE REVISION ROUND at the `decomposeEpic` seam — exactly one, never two, and never zero when
// a `high` finding is held.
//
// The bound is not a guess. `.roborev.toml` measured the fix→review→fix loop over 6,281 reviews and
// it does NOT converge: 61.6% fail on the first round, then 53.5, 46.2, 46.0 … and a plateau around
// 40-48% holding through at least the fourteenth. So the assertion that matters most here is the
// NEGATIVE one — that a second round never happens, however much the advisor still has to say.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { decomposeEpic, TASK_PLAN_SYSTEM, type DecomposeDeps } from "../tasks";
import { advisorRevisionNote } from "./index";
import { holdVerdict, resetHeldVerdicts } from "./findings";

const PLAN = { tasks: [{ title: "T0", body: "first", dependsOn: [] as string[] }] };

/** The four-argument shape `decomposeEpic` calls `structuredJson` with. Spelled out so the mock's
 *  `mock.calls` is a typed tuple — an untyped `vi.fn()` infers `[]`, and every `calls[n]![i]` read
 *  below would then be a type error rather than the assertion it is meant to be. */
type PlanFn = (
  system: string,
  input: string,
  schema: undefined,
  meta: { purpose: string; project?: string },
) => Promise<unknown>;

function deps(over: Partial<DecomposeDeps> = {}) {
  const structuredJson = vi.fn<PlanFn>(async () => PLAN);
  const createBeadFull = vi.fn(
    async (
      _p: string,
      _title: string,
      _body: string,
      _type: string,
      _parent: string,
      _deps: string,
      _labels: string,
    ) => "sparkle-child",
  );
  const beadDepAdd = vi.fn(async () => {});
  const readPrd = vi.fn(async () => "");
  const writePrd = vi.fn(async () => {});
  const d = {
    structuredJson,
    createBeadFull,
    beadDepAdd,
    readPrd,
    writePrd,
    ...over,
  } as unknown as DecomposeDeps;
  return { d, structuredJson, createBeadFull };
}

const EPIC = { id: "sparkle-ep", title: "An epic", description: "no prd back-link here" };

beforeEach(() => {
  resetHeldVerdicts();
});

describe("the bounded revision round", () => {
  it("does NOT re-plan when the dep is absent — every pre-existing caller is untouched", async () => {
    // This is the compatibility assertion. With `advisorRevisionNote` unset, `decomposeEpic` makes
    // exactly ONE structuredJson call with the same four arguments it always did — which is what
    // keeps `tasks.test.ts`'s pinned assertions passing UNCHANGED.
    const { d, structuredJson } = deps();
    await decomposeEpic(d, { projectPath: "/repo", epic: EPIC });
    expect(structuredJson).toHaveBeenCalledTimes(1);
    expect(structuredJson).toHaveBeenCalledWith(
      TASK_PLAN_SYSTEM,
      expect.any(String),
      undefined,
      expect.objectContaining({ purpose: expect.stringContaining("epic into tasks") }),
    );
  });

  it("does NOT re-plan when the advisor has nothing HIGH to say", async () => {
    const { d, structuredJson } = deps({ advisorRevisionNote: async () => null });
    await decomposeEpic(d, { projectPath: "/repo", epic: EPIC });
    expect(structuredJson).toHaveBeenCalledTimes(1);
  });

  it("re-plans EXACTLY ONCE on a high finding, and the finding reaches the planner", async () => {
    const note = "[HIGH] scope: task 3 is really four";
    const { d, structuredJson } = deps({ advisorRevisionNote: async () => note });
    await decomposeEpic(d, { projectPath: "/repo", epic: EPIC });

    // EXACTLY TWO calls: the original plan, then one revision. Never three.
    expect(structuredJson).toHaveBeenCalledTimes(2);
    // The SIDE EFFECT that matters: the finding is in the second call's input. A revision round that
    // re-planned without telling the planner what to fix would be a wasted call, and it would pass a
    // test that only counted calls.
    const secondInput = structuredJson.mock.calls[1]![1] as string;
    expect(secondInput).toContain(note);
    // …and the FIRST call is unchanged — the advisor never rewrites, it appends to the same input.
    const firstInput = structuredJson.mock.calls[0]![1] as string;
    expect(secondInput.startsWith(firstInput)).toBe(true);
    // The system prompt and the 4-argument shape are identical on both calls.
    expect(structuredJson.mock.calls[1]![0]).toBe(TASK_PLAN_SYSTEM);
    expect(structuredJson.mock.calls[1]![2]).toBeUndefined();
  });

  it("uses the REVISED plan's children, not the original's", async () => {
    // Counting calls proves a second call happened; this proves it MATTERED. Without it a
    // revision round that threw the revised plan away would pass the count assertion above.
    const first = { tasks: [{ title: "ORIGINAL", body: "b", dependsOn: [] as string[] }] };
    const second = { tasks: [{ title: "REVISED", body: "b", dependsOn: [] as string[] }] };
    const structuredJson = vi
      .fn<PlanFn>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const { d, createBeadFull } = deps({
      structuredJson: structuredJson as unknown as DecomposeDeps["structuredJson"],
      advisorRevisionNote: async () => "[HIGH] scope: redo it",
    });
    await decomposeEpic(d, { projectPath: "/repo", epic: EPIC });
    expect(createBeadFull).toHaveBeenCalledTimes(1);
    expect(createBeadFull.mock.calls[0]![1]).toBe("REVISED");
  });

  it("KEEPS THE ORIGINAL PLAN when the revision fails — a lost second opinion costs nothing", async () => {
    const first = { tasks: [{ title: "ORIGINAL", body: "b", dependsOn: [] as string[] }] };
    const structuredJson = vi
      .fn<PlanFn>()
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new Error("ai_busy"));
    const { d, createBeadFull } = deps({
      structuredJson: structuredJson as unknown as DecomposeDeps["structuredJson"],
      advisorRevisionNote: async () => "[HIGH] scope: redo it",
    });
    // It must not throw: a decomposition that already succeeded must not be lost to a second opinion
    // that could not be obtained.
    await expect(decomposeEpic(d, { projectPath: "/repo", epic: EPIC })).resolves.toBeTruthy();
    expect(createBeadFull.mock.calls[0]![1]).toBe("ORIGINAL");
  });

  it("KEEPS THE ORIGINAL PLAN when the note itself could not be read", async () => {
    const { d, structuredJson } = deps({
      advisorRevisionNote: async () => {
        throw new Error("store down");
      },
    });
    await expect(decomposeEpic(d, { projectPath: "/repo", epic: EPIC })).resolves.toBeTruthy();
    expect(structuredJson).toHaveBeenCalledTimes(1);
  });
});

describe("advisorRevisionNote — what triggers a round at all", () => {
  it("returns null with no verdict held", async () => {
    expect(await advisorRevisionNote("sparkle-ep")).toBeNull();
  });

  it("returns null for a verdict whose findings are all below HIGH", async () => {
    // A medium finding is worth telling the ORCHESTRATOR (it rides the seed brief) and is not worth
    // re-running the planner over — the second half of the "exactly one round" bound.
    holdVerdict("sparkle-ep", {
      model: "claude-opus-5",
      taskId: "t",
      findings: [
        { lens: "scope", severity: "medium", summary: "m" },
        { lens: "goal", severity: "low", summary: "l" },
      ],
    });
    expect(await advisorRevisionNote("sparkle-ep")).toBeNull();
  });

  it("returns a note naming ONLY the high findings, the reviewing model, and its evidence", async () => {
    holdVerdict("sparkle-ep", {
      model: "claude-opus-5",
      taskId: "task-42",
      findings: [
        { lens: "collision", severity: "high", summary: "PR #2130 owns this file", evidence: "exit 10" },
        { lens: "scope", severity: "medium", summary: "MEDIUM-NOT-INCLUDED" },
      ],
    });
    const note = await advisorRevisionNote("sparkle-ep");
    expect(note).toContain("PR #2130 owns this file");
    expect(note).toContain("exit 10");
    expect(note).toContain("claude-opus-5");
    expect(note).toContain("task-42");
    expect(note).not.toContain("MEDIUM-NOT-INCLUDED");
    // The planner must be told it gets ONE round, and that the advisor did not rewrite anything.
    expect(note).toContain("ONE revision round");
    expect(note).toContain("did NOT rewrite the plan");
  });
});
