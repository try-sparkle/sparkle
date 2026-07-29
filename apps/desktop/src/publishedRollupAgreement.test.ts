// THE BUILD COLUMN AND EVERY OTHER SURFACE MUST BAND THE SAME FLEET IDENTICALLY.
//
// Two expressions compute a row's band. The column uses `bandOfRollup(rollupViewFor(...).dotOf(id))`
// — that is what paints its disc. The concierge feed, the TopBar cluster and
// engine/ladderSelection.firstLadderRowId use `bandOfStatus(publishedStatusFor(...)[id])`. They must
// agree, or selection is handed to a row the column is not rendering and the digest reports a fleet
// the user cannot see.
//
// This has already broken twice: once when the rollup was column-local (green diverged everywhere),
// and once when firstLadderRowId called the rollup accessor WITHOUT the dismissal/in-motion inputs
// the sidebar passes. A previous attempt at this file modelled the "other surface" side with an
// inline re-implementation of the published chain, which is worse than no test: it asserted that my
// model of the chain agreed with itself. BOTH SIDES HERE GO THROUGH THE REAL FUNCTIONS, and both
// come from the one exported composition, so a drift in `withRedWorkerAttention`, `isInMotion`,
// `withDismissedAlerts` or the promotion step shows up as a failure rather than passing quietly.
import { describe, expect, it } from "vitest";
import { publishedStatusFor, rollupViewFor } from "./useAttentionNotifications";
import { bandOfStatus } from "./engine/buildSections";
import { bandOfRollup } from "./engine/workerRollup";
import type { AgentAlertRecord, AgentTab, AgentTabStatus } from "./types";

function mk(id: string, kind: AgentTab["kind"], parentId: string | null, alert?: AgentAlertRecord) {
  return {
    id, name: id, kind, parentId, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: true, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null, alert,
  } as AgentTab;
}

/** An acknowledged alarm episode: isAlertSuppressed is `dismissedSeq === seq`. */
const DISMISSED: AgentAlertRecord = { seq: 1, lastRed: "waiting", dismissedSeq: 1 };

type Case = {
  name: string;
  agents: AgentTab[];
  status: Record<string, AgentTabStatus>;
  /** The band BOTH sides must report for the head. Stated, not derived, so a change that moves both
   *  sides together still has to be justified against a written expectation. */
  expect: "needs_you" | "running" | "done";
};

const HEAD_WITH_TWO = [mk("p1", "build", null), mk("w1", "worker", "p1"), mk("w2", "worker", "p1")];
const HEAD_DISMISSED = [
  mk("p1", "build", null, DISMISSED),
  mk("w1", "worker", "p1"),
  mk("w2", "worker", "p1"),
];

const CASES: Case[] = [
  { name: "all green", agents: HEAD_WITH_TWO, status: { p1: "idle", w1: "working", w2: "working" }, expect: "running" },
  { name: "all red", agents: HEAD_WITH_TWO, status: { p1: "idle", w1: "waiting", w2: "errored" }, expect: "needs_you" },
  { name: "all grey", agents: HEAD_WITH_TWO, status: { p1: "idle", w1: "idle", w2: "done" }, expect: "done" },
  { name: "green + red", agents: HEAD_WITH_TWO, status: { p1: "idle", w1: "working", w2: "waiting" }, expect: "needs_you" },
  { name: "green + grey", agents: HEAD_WITH_TWO, status: { p1: "idle", w1: "working", w2: "done" }, expect: "running" },
  { name: "red + grey", agents: HEAD_WITH_TWO, status: { p1: "idle", w1: "waiting", w2: "done" }, expect: "needs_you" },
  { name: "own red beats green workers", agents: HEAD_WITH_TWO, status: { p1: "waiting", w1: "working", w2: "working" }, expect: "needs_you" },
  { name: "head working, workers calm", agents: HEAD_WITH_TWO, status: { p1: "working", w1: "idle", w2: "done" }, expect: "running" },
  // The in-motion rule: a `blocked` worker is red but is not ASKING, so it must not paint a parent
  // that is visibly producing output.
  { name: "head in motion + blocked worker", agents: HEAD_WITH_TWO, status: { p1: "working", w1: "blocked", w2: "working" }, expect: "running" },
  { name: "head in motion + WAITING worker still asks", agents: HEAD_WITH_TWO, status: { p1: "working", w1: "waiting", w2: "working" }, expect: "needs_you" },
  { name: "childless head", agents: [mk("p1", "build", null)], status: { p1: "idle" }, expect: "done" },
  // THE DISMISSAL ROWS — absent from the first attempt at this matrix, and the half that drove both
  // shipped divergences. "Dismiss Alert" is used mostly on heads whose red bubbled from a worker.
  { name: "dismissed head, red workers only", agents: HEAD_DISMISSED, status: { p1: "idle", w1: "waiting", w2: "blocked" }, expect: "done" },
  // …but dismissal silences an ALARM, not the news that work is still running.
  { name: "dismissed head, red AND working worker", agents: HEAD_DISMISSED, status: { p1: "idle", w1: "waiting", w2: "working" }, expect: "running" },
];

describe("the column and the published map band identically", () => {
  for (const c of CASES) {
    it(c.name, () => {
      const status = c.status as Record<string, AgentTabStatus>;
      const openIds = new Set(c.agents.map((a) => a.id));
      const stageOf = () => "building" as never;

      const published = publishedStatusFor(c.agents, status, openIds, {}, stageOf);
      const { dotOf } = rollupViewFor(c.agents, status, openIds, {}, stageOf);

      const feedBand = bandOfStatus(published["p1"]!);
      const columnBand = bandOfRollup(dotOf("p1"));

      expect(columnBand, `${c.name}: column band`).toBe(c.expect);
      expect(feedBand, `${c.name}: published band (column says ${columnBand})`).toBe(c.expect);
    });
  }
});

describe("the promotion does not destroy the status it writes over", () => {
  const agents = [mk("p1", "build", null), mk("w1", "worker", "p1")];
  const openIds = new Set(["p1", "w1"]);

  // `unmerged` bands `done`, so the needs_you guard alone let it be overwritten with `working` —
  // silently losing "Needs merge" from the label, from conciergeRecap's classification and from
  // isCalmBand (which would then stop desaturating an un-landed branch).
  it("keeps `unmerged` on a head that has a working worker", () => {
    const published = publishedStatusFor(
      agents,
      { p1: "idle", w1: "working" },
      openIds,
      {},
      // Committed-but-unlanded: what withUnmergedWork escalates on.
      () => "building_saved" as never,
    );
    expect(published["p1"]).toBe("unmerged");
  });

  it("still promotes a plain idle head with a working worker", () => {
    const published = publishedStatusFor(
      agents,
      { p1: "idle", w1: "working" },
      openIds,
      {},
      () => "merged" as never,
    );
    expect(published["p1"]).toBe("working");
  });

  // The out-param the away-recap reads: a promoted head must be distinguishable from one that is
  // genuinely working, or the recap reports it as having finished a job it never started.
  it("reports which heads were promoted, and only those", () => {
    const promoted = new Set<string>();
    publishedStatusFor(agents, { p1: "idle", w1: "working" }, openIds, {}, () => "merged" as never, promoted);
    expect([...promoted]).toEqual(["p1"]);
  });

  it("reports nothing when the head is working under its own steam", () => {
    const promoted = new Set<string>();
    publishedStatusFor(agents, { p1: "working", w1: "working" }, openIds, {}, () => "merged" as never, promoted);
    expect(promoted.size).toBe(0);
  });
});
