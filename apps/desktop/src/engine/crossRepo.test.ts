// Bead `sparkle-pgh1ue` — an agent whose work lands in a DIFFERENT repo than the project it is
// bound to must never render as though it has done nothing.
//
// THE CASE ON THE FOUNDER'S SCREEN, reproduced in `the founder's case` below and used as the
// end-to-end assertion for both halves: agent `Drodio Publishing MCP Images`, bound to the `sparkle`
// project, every commit landed in `drodio/drodio-website`, merged as PR #253 at `79b157a`. Its
// bound-project branch holds zero commits BY DESIGN, so every reading `agent_workflow_state` can
// take is an honest zero — and the row read "LOCAL: NOTHING YET" while the work was shipped.
import { describe, expect, it } from "vitest";
import {
  assignmentRepos,
  crossRepoAccessors,
  crossRepoReading,
  detectCrossRepoTarget,
  isCrossRepo,
  landedStampLabel,
  normalizeRepoSlug,
  parseLandedStamp,
  prNumberFromReference,
  repoReferencesIn,
  stageFromLandedStamp,
  type LandedElsewhere,
} from "./crossRepo";
import { deriveLiveStage } from "./workflowStage";
import {
  honestStageMeta,
  sectionOfRow,
  sectionFromReadings,
  sectionMeta,
  stageChipIsSilent,
} from "./buildSections";
import type { BranchStatus, WorkflowState } from "../services/branchStatus";

const NOW = 1_700_000_000_000;

/** The bound project reads an HONEST ZERO for a cross-repo agent — no commits, clean tree, no PR.
 *  Everything below is measured against exactly this, because it is what the probe really returns. */
const BOUND_ZERO: { bs: BranchStatus; ws: WorkflowState } = {
  bs: { ahead: 0, behind: 0, dirty: false, filesChanged: 0, insertions: 0, deletions: 0, worktreeOnBranch: true },
  ws: {
    inLocalMain: false,
    inOriginMain: false,
    inParent: false,
    aheadOfBase: 0,
    landed: false,
    landedOnOrigin: false,
    pushed: false,
    shipped: false,
    hasRemote: true,
    prState: null,
    prNumber: null,
    prUrl: null,
  },
};

describe("normalizeRepoSlug", () => {
  it("accepts the shapes an agent actually writes", () => {
    expect(normalizeRepoSlug("drodio/drodio-website")).toBe("drodio/drodio-website");
    expect(normalizeRepoSlug("Drodio/Drodio-Website")).toBe("drodio/drodio-website");
    expect(normalizeRepoSlug("drodio/drodio-website#253")).toBe("drodio/drodio-website");
    expect(normalizeRepoSlug("https://github.com/drodio/drodio-website/pull/253")).toBe(
      "drodio/drodio-website",
    );
    expect(normalizeRepoSlug("github.com/drodio/sparkle")).toBe("drodio/sparkle");
    expect(normalizeRepoSlug("git@github.com:drodio/sparkle.git")).toBe("drodio/sparkle");
  });

  it("REFUSES anything that is not unambiguously owner/repo", () => {
    // The refusals are the load-bearing half: a lenient slug parse becomes a wrong status.
    expect(normalizeRepoSlug("apps/desktop/src/engine")).toBeNull();
    expect(normalizeRepoSlug("owner")).toBeNull();
    expect(normalizeRepoSlug("")).toBeNull();
    expect(normalizeRepoSlug(null)).toBeNull();
    expect(normalizeRepoSlug(42)).toBeNull();
    expect(normalizeRepoSlug("apps/..")).toBeNull();
    // A non-GitHub forge is not a slug this app can resolve.
    expect(normalizeRepoSlug("https://gitlab.com/owner/repo")).toBeNull();
  });
});

describe("prNumberFromReference", () => {
  it("reads the number out of both reference shapes", () => {
    expect(prNumberFromReference("drodio/drodio-website#253")).toBe(253);
    expect(prNumberFromReference("https://github.com/drodio/drodio-website/pull/253")).toBe(253);
    expect(prNumberFromReference("drodio/drodio-website")).toBeUndefined();
  });
});

describe("parseLandedStamp", () => {
  it("normalizes a whole reference passed in `repo`", () => {
    const parsed = parseLandedStamp(
      { repo: "https://github.com/Drodio/Drodio-Website/pull/253", state: "merged", sha: "79b157a" },
      NOW,
    );
    expect(parsed).toEqual({
      ok: true,
      stamp: {
        repo: "drodio/drodio-website",
        prNumber: 253,
        sha: "79b157a",
        state: "merged",
        stampedAt: NOW,
      },
    });
  });

  it("refuses a payload with no resolvable repo, and says what to send", () => {
    const parsed = parseLandedStamp({ pr: 253 }, NOW);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("owner/repo");
  });

  it("refuses an unknown state rather than silently dropping it", () => {
    const parsed = parseLandedStamp({ repo: "a/b", state: "landed" }, NOW);
    expect(parsed.ok).toBe(false);
  });

  it("refuses shipped:true without a merge — a release cannot precede the merge", () => {
    expect(parseLandedStamp({ repo: "a/b", state: "open", shipped: true }, NOW).ok).toBe(false);
    expect(parseLandedStamp({ repo: "a/b", state: "merged", shipped: true }, NOW).ok).toBe(true);
  });

  it("takes the timestamp from its caller, never from the clock", () => {
    const parsed = parseLandedStamp({ repo: "a/b" }, 12345);
    expect(parsed.ok && parsed.stamp.stampedAt).toBe(12345);
  });
});

describe("stageFromLandedStamp", () => {
  it("maps state to a real ladder stage", () => {
    const base = { repo: "a/b", stampedAt: NOW };
    expect(stageFromLandedStamp({ ...base, state: "merged" })).toBe("merged");
    expect(stageFromLandedStamp({ ...base, state: "merged", shipped: true })).toBe("shipped");
    expect(stageFromLandedStamp({ ...base, state: "open" })).toBe("pull_request");
    expect(stageFromLandedStamp({ ...base, state: "closed" })).toBe("pushed");
  });

  it("floors an unstated state at `pushed`, NOT at merged", () => {
    // A bare stamp must not manufacture a merge. Over-claiming here would be the same class of
    // wrong status this module exists to remove, aimed the other way.
    expect(stageFromLandedStamp({ repo: "a/b", stampedAt: NOW })).toBe("pushed");
  });
});

describe("detectCrossRepoTarget — the assignment-time guard", () => {
  const BOUND = "drodio/sparkle";

  it("finds a repo the task names via a GitHub URL", () => {
    expect(
      detectCrossRepoTarget("Publish the MCP images at https://github.com/drodio/drodio-website", BOUND),
    ).toBe("drodio/drodio-website");
  });

  it("finds the `owner/repo#N` shorthand and the word `repo`", () => {
    expect(detectCrossRepoTarget("follow up on drodio/drodio-website#253", BOUND)).toBe(
      "drodio/drodio-website",
    );
    expect(detectCrossRepoTarget("work in the repo drodio/drodio-website", BOUND)).toBe(
      "drodio/drodio-website",
    );
    expect(detectCrossRepoTarget("this lands in the drodio/drodio-website repository", BOUND)).toBe(
      "drodio/drodio-website",
    );
  });

  it("does NOT fire on the bound repo named explicitly", () => {
    expect(detectCrossRepoTarget("see https://github.com/drodio/sparkle/pull/9", BOUND)).toBeNull();
    expect(detectCrossRepoTarget("drodio/sparkle#2370", BOUND)).toBeNull();
  });

  it("does NOT fire on file paths — the false positive that would break every other row", () => {
    // This is the assertion that keeps the guard from becoming a worse bug than the one it fixes.
    const prose =
      "Edit apps/desktop/src/engine/workflowStage.ts and scripts/tests/run.sh, then check src/lib.";
    expect(repoReferencesIn(prose)).toEqual([]);
    expect(detectCrossRepoTarget(prose, BOUND)).toBeNull();
  });

  it("FAILS CLOSED when the bound slug is unknown", () => {
    // A cold `repoSlug` cache reads null. Guessing there would mark ordinary agents cross-repo.
    expect(detectCrossRepoTarget("https://github.com/drodio/drodio-website", null)).toBeNull();
    expect(detectCrossRepoTarget("https://github.com/drodio/drodio-website", undefined)).toBeNull();
  });

  it("FAILS CLOSED on silence", () => {
    expect(detectCrossRepoTarget("Fix the flaky test", BOUND)).toBeNull();
    expect(detectCrossRepoTarget("", BOUND)).toBeNull();
    expect(detectCrossRepoTarget(null, BOUND)).toBeNull();
  });

  it("scans the whole text on repeat calls (a stateful /g regex would miss the second)", () => {
    const text = "ship https://github.com/drodio/drodio-website/pull/253";
    expect(detectCrossRepoTarget(text, BOUND)).toBe("drodio/drodio-website");
    expect(detectCrossRepoTarget(text, BOUND)).toBe("drodio/drodio-website");
  });
});

describe("the founder's case: bound to sparkle, landed in drodio-website", () => {
  const BOUND = "drodio/sparkle";
  const TASK =
    "Publish the MCP images for the site. The work lands in https://github.com/drodio/drodio-website.";

  const STAMP: LandedElsewhere = {
    repo: "drodio/drodio-website",
    prNumber: 253,
    sha: "79b157a",
    state: "merged",
    stampedAt: NOW,
  };

  /** The row's stage, exactly as `runtimeStore.refreshWorkflowStage` computes it. */
  const stageOf = (reading: ReturnType<typeof crossRepoReading>) =>
    deriveLiveStage({
      kind: "build",
      bs: BOUND_ZERO.bs,
      ws: BOUND_ZERO.ws,
      prev: null,
      pushed: BOUND_ZERO.ws.pushed,
      shipped: BOUND_ZERO.ws.shipped,
      crossRepo: reading,
    });

  it("BASELINE: with no cross-repo signal at all, the honest zero really does read as nothing yet", () => {
    // The bug, pinned. Nothing here is wrong about the BRANCH — it is answering the wrong question,
    // which is why the fix has to come from a signal the branch cannot carry.
    const stage = deriveLiveStage({
      kind: "build",
      bs: BOUND_ZERO.bs,
      ws: BOUND_ZERO.ws,
      prev: null,
    });
    expect(stage).toBe("building_unsaved");
    expect(sectionOfRow(stage, false)).toBe("local_none");
    expect(sectionMeta("local_none").label).toBe("Local: Nothing Yet");
  });

  it("(a) THE STAMP resolves the row to merged — preferred over the bound-project reading", () => {
    const reading = crossRepoReading({ landedElsewhere: STAMP, taskText: TASK, boundSlug: BOUND });
    expect(stageOf(reading)).toBe("merged");
    expect(sectionOfRow("merged", false, reading)).toBe("remote_merged");
  });

  it("(a) a shipped stamp reaches the top rung", () => {
    const reading = crossRepoReading({
      landedElsewhere: { ...STAMP, shipped: true },
      taskText: TASK,
      boundSlug: BOUND,
    });
    expect(stageOf(reading)).toBe("shipped");
    expect(sectionOfRow("shipped", false, reading)).toBe("remote_shipped");
  });

  it("(b) WITHOUT a stamp the row reads `tracked elsewhere`, NEVER `nothing yet`", () => {
    const reading = crossRepoReading({ taskText: TASK, boundSlug: BOUND });
    expect(reading.assignedRepo).toBe("drodio/drodio-website");
    expect(isCrossRepo(reading)).toBe(true);

    const stage = stageOf(reading);
    const section = sectionOfRow(stage, false, reading);
    expect(section).toBe("tracked_elsewhere");
    expect(section).not.toBe("local_none");
    expect(sectionMeta(section).label).toBe("Tracked Elsewhere");
  });

  it("(b) makes NO claim about progress — it is honest ignorance, not optimism", () => {
    const reading = crossRepoReading({ taskText: TASK, boundSlug: BOUND });
    // The guard must not invent a merge it cannot substantiate; the stage stays where the bound
    // reading left it and only the SECTION changes.
    expect(stageOf(reading)).toBe("building_unsaved");
  });

  it("(b) survives a row nobody ever polled — the case that reads `undefined` today", () => {
    const reading = crossRepoReading({ taskText: TASK, boundSlug: BOUND });
    expect(sectionFromReadings(undefined, undefined, undefined)).toBeUndefined();
    expect(sectionFromReadings(undefined, undefined, reading)).toBe("tracked_elsewhere");
  });

  it("a same-repo agent is untouched by both halves", () => {
    const reading = crossRepoReading({
      taskText: "Fix pr-checks.sh; see https://github.com/drodio/sparkle/pull/2370",
      boundSlug: BOUND,
    });
    expect(isCrossRepo(reading)).toBe(false);
    expect(stageOf(reading)).toBe("building_unsaved");
    expect(sectionOfRow("building_unsaved", false, reading)).toBe("local_none");
  });

  it("the row can name the evidence for its claim", () => {
    expect(landedStampLabel(STAMP)).toBe("drodio/drodio-website#253 · merged");
    expect(landedStampLabel({ ...STAMP, shipped: true })).toBe("drodio/drodio-website#253 · shipped");
    expect(landedStampLabel({ repo: "a/b", stampedAt: NOW })).toBe("a/b · pushed");
  });
});

describe("a stamp does not resurrect a no-op branch's own bogus signals", () => {
  it("still refuses to claim more than the stamp states", () => {
    // A `{ repo }`-only stamp on a branch with nothing local floors at `pushed` and no further —
    // the stamp raises the row to what it PROVES, not to whatever the ladder's top is.
    const reading = crossRepoReading({ landedElsewhere: { repo: "a/b", stampedAt: NOW } });
    const stage = deriveLiveStage({
      kind: "build",
      bs: BOUND_ZERO.bs,
      ws: BOUND_ZERO.ws,
      prev: null,
      crossRepo: reading,
    });
    expect(stage).toBe("pushed");
  });
});

// ── The four defects roborev 67500 found in the first cut ───────────────────────────────────────
// Each is a case where the fix, as first written, replaced one wrong status with another. They are
// kept together because they share a theme: a new rung is only an improvement if every consumer of
// the old one moved with it.

describe("the cross-repo rung must not steal a row that holds REAL at-risk edits", () => {
  const reading = crossRepoReading({
    taskText: "work in https://github.com/drodio/drodio-website",
    boundSlug: "drodio/sparkle",
  });

  it("holdsWork === true OUTRANKS the cross-repo route", () => {
    // "Tracked Elsewhere" says Sparkle cannot measure this row. For a dirty, attributable worktree
    // that is measurably false — we just measured it — and it would drop the data-loss warning,
    // which is the most consequential copy in the column.
    expect(sectionOfRow("building_unsaved", true, reading)).toBe("local_uncommitted");
  });

  it("but `false` and `undefined` both reach it — neither is evidence of work at risk HERE", () => {
    expect(sectionOfRow("building_unsaved", false, reading)).toBe("tracked_elsewhere");
    expect(sectionOfRow("building_unsaved", undefined, reading)).toBe("tracked_elsewhere");
  });

  it("a row with measurable COMMITTED work keeps its true rung, whatever else it also did", () => {
    // Only the bottom rung is ever re-routed: a stage at or past `building_saved` is a real reading
    // of this repo, and trading it for "we cannot tell" would discard information.
    expect(sectionOfRow("building_saved", undefined, reading)).toBe("local_committed");
    expect(sectionOfRow("pull_request", undefined, reading)).toBe("remote_pr");
  });
});

describe("the honesty helpers moved to the new rung with it", () => {
  it("does NOT claim unsaved work on a tracked-elsewhere row", () => {
    // Both helpers were keyed on the literal `local_none`, which is where the founder's own row used
    // to file. Moving it to a new rung without moving these hands it back the exact sentence three
    // passes were spent removing.
    expect(stageMetaDetailOf("tracked_elsewhere")).not.toContain("closing now loses this work");
    expect(stageChipIsSilent("building_unsaved", "tracked_elsewhere")).toBe(true);
  });

  it("…and does not claim the tree is EMPTY either — it asserts nothing about the worktree", () => {
    // The rung is reached on `holdsWork !== true`, which includes `undefined` — and
    // `uncommittedWorkEvidence` returns `undefined` for a tree that is DIRTY BUT PARKED. Borrowing
    // `local_none`'s "no edits in the working tree — nothing here is at risk" would therefore
    // reassure a user about a tree that is dirty: the same false-reassurance class, inverted
    // (roborev 67613). So the two rungs get DIFFERENT copy, and this pins that they differ.
    const elsewhere = honestStageMeta("building_unsaved", "tracked_elsewhere");
    const none = honestStageMeta("building_unsaved", "local_none");
    expect(elsewhere.label).toBe("Tracked Elsewhere");
    expect(elsewhere.detail).not.toContain("working tree");
    expect(elsewhere.detail).not.toContain("at risk");
    expect(elsewhere.detail).toContain("another repository");
    expect(elsewhere.detail).not.toBe(none.detail);
  });

  it("still does the same for local_none, and still leaves every other rung alone", () => {
    expect(honestStageMeta("building_unsaved", "local_none").label).toBe("Nothing Built Yet");
    expect(honestStageMeta("building_unsaved", "local_none").detail).toContain("nothing here is at risk");
    expect(honestStageMeta("building_unsaved", "local_uncommitted").label).toBe(
      "Building Locally (Unsaved)",
    );
    expect(stageChipIsSilent("building_unsaved", "local_uncommitted")).toBe(false);
    // A row that really did commit keeps its own meta on the new rung too — the override is scoped
    // to `building_unsaved`, not to the section.
    expect(honestStageMeta("building_saved", "tracked_elsewhere").label).toBe(
      "Building Locally (Committed & Saved)",
    );
    expect(stageChipIsSilent("building_saved", "tracked_elsewhere")).toBe(false);
  });
});

function stageMetaDetailOf(section: "tracked_elsewhere" | "local_none"): string {
  return honestStageMeta("building_unsaved", section).detail;
}

describe("the guard reads a DURABLE assignment, so the rung cannot oscillate with chat", () => {
  const BOUND = "drodio/sparkle";

  it("latches the repos an opening assignment named, capped", () => {
    expect(assignmentRepos("ship it in https://github.com/drodio/drodio-website")).toEqual([
      "drodio/drodio-website",
    ]);
    expect(assignmentRepos("no repos here")).toEqual([]);
    expect(assignmentRepos(null)).toEqual([]);
    const many = assignmentRepos(
      "a/b#1 c/d#2 e/f#3 g/h#4 i/j#5 k/l#6",
    );
    expect(many.length).toBeLessThanOrEqual(4);
  });

  it("stores REFERENCES, not a verdict — so a cold bound slug does not fail closed forever", () => {
    // The latch happens at assignment time, when `slugForRoot` may still be a cache miss. Comparing
    // then would bake in "not cross-repo" permanently; comparing at read time recovers.
    const latched = assignmentRepos("see https://github.com/drodio/drodio-website");
    expect(crossRepoReading({ assignmentRepos: latched, boundSlug: null }).assignedRepo).toBeUndefined();
    expect(crossRepoReading({ assignmentRepos: latched, boundSlug: BOUND }).assignedRepo).toBe(
      "drodio/drodio-website",
    );
  });

  it("ignores the bound repo among the latched references and picks the foreign one", () => {
    const latched = assignmentRepos("port drodio/sparkle#2370 into the drodio/drodio-website repo");
    expect(latched).toContain("drodio/sparkle");
    expect(crossRepoReading({ assignmentRepos: latched, boundSlug: BOUND }).assignedRepo).toBe(
      "drodio/drodio-website",
    );
  });

  it("a latched assignment naming ONLY the bound repo is not cross-repo", () => {
    const latched = assignmentRepos("fix drodio/sparkle#2370");
    expect(isCrossRepo(crossRepoReading({ assignmentRepos: latched, boundSlug: BOUND }))).toBe(false);
  });
});

describe("crossRepoAccessors — ONE builder, so every ladder consumer agrees", () => {
  const BOUND = "drodio/sparkle";
  const AGENTS = [
    { id: "head", parentId: null },
    { id: "worker", parentId: "head", task: "publish to https://github.com/drodio/drodio-website" },
    { id: "loner", parentId: null },
  ];

  it("answers per-row for the agent that actually carries the signal", () => {
    const { own } = crossRepoAccessors(AGENTS, BOUND);
    expect(own("worker")?.assignedRepo).toBe("drodio/drodio-website");
    expect(own("head")).toBeUndefined();
    expect(own("loner")).toBeUndefined();
  });

  it("rolls a head up over its subtree, exactly as headStageOf does", () => {
    // A head is bucketed by its least-advanced worker, so answering from its own record alone would
    // file it under "Local: Nothing Yet" while a worker beneath it did all its work elsewhere.
    const { head } = crossRepoAccessors(AGENTS, BOUND);
    expect(head("head")?.assignedRepo).toBe("drodio/drodio-website");
    expect(head("loner")).toBeUndefined();
  });

  it("a row's OWN stamp beats a worker's, since the head is the row being described", () => {
    const withStamp = [
      { id: "head", parentId: null, landedElsewhere: { repo: "x/y", stampedAt: NOW } },
      ...AGENTS.slice(1),
    ];
    expect(crossRepoAccessors(withStamp, BOUND).head("head")?.stamp?.repo).toBe("x/y");
  });

  it("fails closed with an unresolved bound slug, for every row", () => {
    const { own, head } = crossRepoAccessors(AGENTS, null);
    expect(own("worker")).toBeUndefined();
    expect(head("head")).toBeUndefined();
  });
});
