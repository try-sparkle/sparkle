// AN AGENT WAITING ON LIVE BACKGROUND TASKS READS GREEN — AND THE SAME AGENT IDLE READS GRAY.
//
// The founder's bug (bead sparkle-262p7): the "Improve Sparkle" agent delegates through Task
// subagents / background agents and holds ZERO worker child TABS, so `engine/inMotion`'s
// worker-carried-motion rule never fires and it settled to `idle` (GRAY) the instant its turn
// closed — while its delegates were still running. The fix promotes an idle agent with live
// background tasks back to `working` (GREEN) through the ONE shared composition every surface reads.
//
// BOTH SIDES GO THROUGH THE REAL FUNCTIONS (`publishedStatusFor` for the feed/TopBar, `rollupViewFor`
// for the Build column), and the signal is the REAL window-local registry the status engine writes —
// no inline re-implementation of the chain, which `publishedRollupAgreement.test.ts` records as
// worse than no test. The pair is the point: the SAME childless idle head is asserted GREEN with a
// live count and GRAY without one, so an assertion that passed before the wiring (a vacuous test)
// cannot survive — revert `withBackgroundTaskGreen` from composeRollup and the "with tasks" case
// goes red.
import { describe, it, expect, beforeEach } from "vitest";
import { publishedStatusFor, rollupViewFor } from "./useAttentionNotifications";
import { bandOfStatus } from "./engine/buildSections";
import { bandOfRollup } from "./engine/workerRollup";
import {
  noteBackgroundTasks,
  _resetBackgroundTaskRegistryForTests,
} from "./services/backgroundTaskRegistry";
import type { AgentTab, AgentTabStatus } from "./types";

function mk(id: string, kind: AgentTab["kind"], parentId: string | null): AgentTab {
  return {
    id, name: id, kind, parentId, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: true, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,
  } as AgentTab;
}

const stageOf = () => "building" as never;

/** The published status + the column's rolled-up band for one head, both through the real chain. */
function surfacesFor(agents: AgentTab[], status: Record<string, AgentTabStatus>, id: string) {
  const openIds = new Set(agents.map((a) => a.id));
  const published = publishedStatusFor(agents, status, openIds, {}, stageOf);
  const { dotOf } = rollupViewFor(agents, status, openIds, {}, stageOf);
  return { published: published[id], columnBand: bandOfRollup(dotOf(id)) };
}

describe("green while waiting on background tasks (childless head — the Improve-Sparkle shape)", () => {
  beforeEach(() => _resetBackgroundTaskRegistryForTests());

  // A build/head agent with NO worker children — exactly the Improve-Sparkle topology.
  const soloHead = [mk("p1", "build", null)];

  it("WITH live background tasks: an idle head is GREEN (working / running)", () => {
    noteBackgroundTasks("p1", 2);
    const { published, columnBand } = surfacesFor(soloHead, { p1: "idle" }, "p1");
    // The side effect, not the precondition: the published status the dot reads, and the column band.
    expect(published).toBe("working");
    expect(bandOfStatus(published!)).toBe("running");
    expect(columnBand).toBe("running");
  });

  it("WITHOUT background tasks: the SAME idle head is GRAY (idle / done) — the paired case", () => {
    // registry empty (reset in beforeEach)
    const { published, columnBand } = surfacesFor(soloHead, { p1: "idle" }, "p1");
    expect(published).toBe("idle");
    expect(bandOfStatus(published!)).toBe("done");
    expect(columnBand).toBe("done");
  });

  it("RED WINS: a waiting head with live background tasks stays RED — motion never repaints an ask", () => {
    noteBackgroundTasks("p1", 1);
    const { published, columnBand } = surfacesFor(soloHead, { p1: "waiting" }, "p1");
    expect(published).toBe("waiting");
    expect(columnBand).toBe("needs_you");
  });

  it("promotes ONLY idle: a `done` head with a stale count stays gray/done, never resurrected green", () => {
    noteBackgroundTasks("p1", 5);
    const { published, columnBand } = surfacesFor(soloHead, { p1: "done" }, "p1");
    expect(published).toBe("done");
    expect(columnBand).toBe("done");
  });
});

describe("the promotion feeds isInMotion — worker-red suppression on a delegating parent", () => {
  beforeEach(() => _resetBackgroundTaskRegistryForTests());

  // A head with a `blocked` worker (red, but NOT asking) and a background task of its own.
  const headWithBlockedWorker = [mk("p1", "build", null), mk("w1", "worker", "p1")];

  it("an idle head promoted to working by its background tasks suppresses a non-asking blocked worker", () => {
    noteBackgroundTasks("p1", 1);
    // Without the promotion, p1 is idle → NOT in motion → the blocked worker's red bubbles up and the
    // head reads needs_you. With it, p1 is in motion, so the non-asking `blocked` red is suppressed.
    const { columnBand } = surfacesFor(headWithBlockedWorker, { p1: "idle", w1: "blocked" }, "p1");
    expect(columnBand).toBe("running");
  });

  it("but a WAITING worker (a real ask) still surfaces even on a delegating parent", () => {
    noteBackgroundTasks("p1", 1);
    const { columnBand } = surfacesFor(headWithBlockedWorker, { p1: "idle", w1: "waiting" }, "p1");
    expect(columnBand).toBe("needs_you");
  });
});
