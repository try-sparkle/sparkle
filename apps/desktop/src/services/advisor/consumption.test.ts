// A VERDICT IS TAKEN ONCE PER CONSUMER — asserted through the two real production functions.
//
// ══ WHY THIS EXISTS ═════════════════════════════════════════════════════════════════════════════
//
// A held verdict used to be a plain READ, and neither consumer runs exactly once. `prepareHandoff`
// is reached from the board's Start and Build It buttons, the concierge's `promote_plan_to_build`,
// and the sweep's `sendToBuildAwaited`, so one epic is handed off repeatedly — and every later seed
// re-injected the SAME findings block, telling an orchestrator about a review a previous
// orchestrator already acted on. At the decompose seam it was worse than untidy: a sweep retry after
// a cleared `decompose-failed` badge would spend ANOTHER planner call re-litigating findings the
// previous round already addressed, so the documented "exactly ONE revision round" bound held only
// within a single `decomposeEpic` call rather than per verdict.
//
// Every assertion below is on what the CONSUMER receives — the seed string, the revision note — not
// on the bookkeeping set. Reading the set would pass against a version that tracks delivery
// perfectly and then ignores it.
import { beforeEach, describe, expect, it } from "vitest";

import { advisorBriefFor, advisorRevisionNote } from "./index";
import { holdVerdict, resetHeldVerdicts, type AdvisorVerdict } from "./findings";

const EPIC = "sparkle-epic1";
const SEED = "Build epic sparkle-epic1 — read PRD/x.md.";

const HIGH: AdvisorVerdict = {
  model: "claude-opus-5",
  taskId: "task-7",
  findings: [
    { lens: "collision", severity: "high", summary: "PR #2130 already changes sendToBuild.ts" },
  ],
};

beforeEach(() => {
  resetHeldVerdicts();
});

describe("the seed channel", () => {
  it("folds the findings in ONCE, and leaves every later seed untouched", () => {
    holdVerdict(EPIC, HIGH);
    const first = advisorBriefFor(EPIC, SEED);
    expect(first).toContain("ADVISOR FINDINGS");
    expect(first).toContain("PR #2130 already changes sendToBuild.ts");

    // THE SIDE EFFECT: the second handoff's orchestrator is told nothing, because the first one was
    // already told. The mission itself must still be intact — a consumed verdict must not eat it.
    const second = advisorBriefFor(EPIC, SEED);
    expect(second).toBe(SEED);
    expect(second).not.toMatch(/advisor/i);
  });

  it("a NEW verdict is deliverable again — consumption bounds repeats, not fresh reviews", () => {
    // THE PAIRED HALF. A delivery mark that outlived the verdict would silently suppress a genuine
    // re-review, and nothing observable would say so: the seed would simply look like a first
    // handoff forever.
    holdVerdict(EPIC, HIGH);
    expect(advisorBriefFor(EPIC, SEED)).toContain("ADVISOR FINDINGS");
    expect(advisorBriefFor(EPIC, SEED)).toBe(SEED);

    holdVerdict(EPIC, {
      ...HIGH,
      taskId: "task-8",
      findings: [{ lens: "scope", severity: "high", summary: "a second pass found something new" }],
    });
    const afterRerun = advisorBriefFor(EPIC, SEED);
    expect(afterRerun).toContain("a second pass found something new");
  });

  it("a DIFFERENT epic is unaffected by this one's delivery", () => {
    holdVerdict(EPIC, HIGH);
    holdVerdict("sparkle-epic2", HIGH);
    expect(advisorBriefFor(EPIC, SEED)).toContain("ADVISOR FINDINGS");
    expect(advisorBriefFor("sparkle-epic2", SEED)).toContain("ADVISOR FINDINGS");
  });
});

describe("the revision channel", () => {
  it("yields the note ONCE, so a retried decompose does not re-spend a planner call", async () => {
    holdVerdict(EPIC, HIGH);
    const first = await advisorRevisionNote(EPIC);
    expect(first).toContain("PR #2130 already changes sendToBuild.ts");
    // `null` is what `decomposeEpic` reads as "no revision round" — the second decompose makes ONE
    // `structuredJson` call rather than two.
    expect(await advisorRevisionNote(EPIC)).toBeNull();
  });

  it("is INDEPENDENT of the seed channel — one consumer does not blind the other", async () => {
    // The two are different consumers with different jobs. Sharing one mark would mean whichever ran
    // first silently robbed the other, and which runs first depends on the order a human clicked.
    holdVerdict(EPIC, HIGH);
    expect(advisorBriefFor(EPIC, SEED)).toContain("ADVISOR FINDINGS");
    expect(await advisorRevisionNote(EPIC)).toContain("PR #2130 already changes sendToBuild.ts");
  });

  it("still returns null when the findings are not high, consumed or not", async () => {
    holdVerdict(EPIC, {
      ...HIGH,
      findings: [{ lens: "scope", severity: "medium", summary: "a bit big" }],
    });
    expect(await advisorRevisionNote(EPIC)).toBeNull();
    // …and the seed still gets it, because a medium finding IS worth telling the orchestrator.
    expect(advisorBriefFor(EPIC, SEED)).toContain("a bit big");
  });
});
