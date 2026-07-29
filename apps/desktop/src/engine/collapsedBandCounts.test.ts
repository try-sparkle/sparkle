// THE FILTER CHIPS MUST SEE THROUGH A FOLD.
//
// The report: the chips read "0 red / 4 green / 1 gray", every visible row was green, and behind a
// "+17" fold sat fourteen workers that were blocked and needed input. A column that reports
// perfect health while fourteen rows one fold away are stuck is worse than no column at all.
//
// The chips count TOP-LEVEL rows only — one chip tick per head, not per descendant — so the only
// thing that can carry a folded worker's red up to the count is the ROLLUP (engine/workerRollup),
// which is what `bandCounts` bands each head by. This file pins that path end to end, through the
// exact composition the sidebar uses (`rollupViewFor` → `bandOfRollup`), rather than through
// `rollupDot` in isolation — the isolated unit was never the part that broke. Three surfaces
// independently decide what a row looks like and they have drifted before (see workerRollup's
// header); a test that stops at the pure function would not have caught any of those.
//
// It also pins the ONE case where a folded red legitimately does NOT reach the chip — an in-motion
// parent swallowing a `blocked` (not-an-ask) worker — because that suppression is deliberate,
// documented in two other modules, and is the most likely explanation for the report. Pinning it
// makes the boundary explicit instead of leaving the next reader to rediscover it.
import { describe, expect, it } from "vitest";
import { rollupViewFor } from "../useAttentionNotifications";
import { bandOfRollup } from "./workerRollup";
import type { StatusBand } from "./buildSections";
import type { AgentTab, AgentTabStatus } from "../types";

function mkAgent(id: string, over: Partial<AgentTab> = {}): AgentTab {
  return {
    id,
    name: id,
    kind: "build",
    parentId: null,
    runtime: "local",
    worktreePath: null,
    branch: null,
    baseBranch: "main",
    lastPrompt: "",
    promptHistory: [],
    namePinned: true,
    autoNameBasis: null,
    autoNameVariants: null,
    shellCommand: null,
    ...over,
  } as AgentTab;
}

const worker = (id: string, parentId: string) => mkAgent(id, { kind: "worker", parentId });

/** The sidebar's own `bandCounts`: one tick per TOP-LEVEL row, banded by the rollup. Mirrors
 *  AgentSidebar's useMemo exactly — if that changes shape, this should be updated with it. */
function bandCounts(
  agents: readonly AgentTab[],
  status: Record<string, AgentTabStatus>,
): Record<StatusBand, number> {
  // `lastObserved` is `{}`: these cases drive the rollup purely from `status`, and an empty map is
  // what the sibling agreement test passes for the same reason. (The 4th parameter arrived on main
  // after this file was written; vitest does not typecheck, so only `tsc` catches the arity.)
  const { dotOf } = rollupViewFor(agents, status, new Set<string>(), {}, () => "building_unsaved");
  const counts: Record<StatusBand, number> = { needs_you: 0, running: 0, done: 0 };
  for (const a of agents) {
    if (a.parentId) continue; // top-level rows only, as the chips do
    counts[bandOfRollup(dotOf(a.id))] += 1;
  }
  return counts;
}

describe("filter chips — collapsed descendants are counted", () => {
  // THE REPORTED SHAPE, in miniature: a head that is itself calm, folded over workers that are
  // asking for input. The chip must find it. `waiting` is an ASK — the user is being blocked right
  // now — so no suppression rule may swallow it, however busy the parent looks.
  it("a calm head folded over workers that need input counts as RED, not green", () => {
    const agents = [
      mkAgent("head"),
      worker("w1", "head"),
      worker("w2", "head"),
      worker("w3", "head"),
    ];
    const counts = bandCounts(agents, {
      head: "idle",
      w1: "waiting",
      w2: "waiting",
      w3: "working",
    });

    expect(counts.needs_you).toBe(1);
    expect(counts.running).toBe(0);
    expect(counts.done).toBe(0);
  });

  // The exact false-health readout from the report: several heads, all reading green/gray, while a
  // fold hides workers that need you. If the rollup is ever unwired from the counts, `needs_you`
  // drops to 0 here and this test says so.
  it("does not report 0-red while a folded worker is asking (the reported readout)", () => {
    const agents = [
      mkAgent("h1"),
      ...Array.from({ length: 14 }, (_, i) => worker(`w${i}`, "h1")),
      mkAgent("h2"),
      mkAgent("h3"),
    ];
    const status: Record<string, AgentTabStatus> = { h1: "idle", h2: "working", h3: "done" };
    for (let i = 0; i < 14; i += 1) status[`w${i}`] = "waiting";

    const counts = bandCounts(agents, status);

    expect(counts.needs_you).toBeGreaterThan(0);
    expect(counts.needs_you).toBe(1); // one HEAD is red — the chips count rows, not descendants
  });

  // Mixed subtree → orange, and orange files under "Needs you" on purpose (bandOfRollup): the whole
  // reason the colour exists is that something under the row wants you.
  it("counts a mixed red+green subtree under Needs you", () => {
    const agents = [mkAgent("head"), worker("w1", "head"), worker("w2", "head")];
    const counts = bandCounts(agents, { head: "idle", w1: "waiting", w2: "working" });

    expect(counts.needs_you).toBe(1);
    expect(counts.running).toBe(0);
  });

  // THE DELIBERATE EXCEPTION, pinned so it is a decision rather than a surprise. `blocked` is red
  // but it is NOT an ask — nothing is waiting on the human's answer; the worker merely went quiet.
  // A parent that is visibly progressing swallows it (engine/workerAttention.withRedWorkerAttention
  // does the same, and workerRollup mirrors it deliberately). This is the most plausible reading of
  // the reported "0 red while 14 were blocked": if those workers were `blocked` rather than
  // `waiting`, the column was applying this rule, not losing the count.
  it("an in-motion parent still swallows a non-asking `blocked` worker — by design", () => {
    const agents = [mkAgent("head"), worker("w1", "head")];
    const counts = bandCounts(agents, { head: "working", w1: "blocked" });

    expect(counts.needs_you).toBe(0);
    expect(counts.running).toBe(1);
  });

  // …but the suppression is scoped to a parent that is MOVING. A resting head must still surface a
  // blocked worker, or a wedged subtree under a finished orchestrator is invisible forever.
  it("a RESTING parent surfaces a blocked worker", () => {
    const agents = [mkAgent("head"), worker("w1", "head")];
    const counts = bandCounts(agents, { head: "idle", w1: "blocked" });

    expect(counts.needs_you).toBe(1);
  });
});
