import { describe, it, expect } from "vitest";
import {
  BUILD_SECTIONS,
  STATUS_BANDS,
  allBandsVisible,
  bandOfStatus,
  flattenSections,
  groupAgentsByStage,
  sectionOfRow,
  sectionOfStage,
  ASKING_BANDS,
  isAskingIsolated,
  type StatusBand,
} from "./buildSections";
import { bandCountLabel } from "./statusBandLabels";
import { WORKFLOW_STAGES, stageIndex, type WorkflowStageId } from "./workflowStage";
import { AGENT_STATUS } from "../theme/colors";
import type { AgentTabStatus } from "../types";

const row = (id: string) => ({ id });

// Build the (stageOf, statusOf) pair the grouper wants from two plain maps, defaulting anything
// unlisted to the calm/start values so a test only has to state what it cares about.
function lookups(
  stages: Record<string, WorkflowStageId>,
  statuses: Record<string, AgentTabStatus> = {},
) {
  return {
    stageOf: (id: string) => stages[id] ?? "building_unsaved",
    statusOf: (id: string): AgentTabStatus => statuses[id] ?? "idle",
  };
}

describe("the stage ladder", () => {
  it("covers EVERY workflow stage — no stage can fall out of the column", () => {
    // The guard that matters: add an 11th stage to workflowStage.ts and this fails until you say
    // where it lives. A stage with no section would make its rows silently vanish from the sidebar.
    for (const stage of WORKFLOW_STAGES) {
      const section = sectionOfStage(stage.id);
      expect(BUILD_SECTIONS.map((s) => s.id)).toContain(section);
    }
  });

  it("orders the sections Local-first, then Remote", () => {
    expect(BUILD_SECTIONS.map((s) => s.id)).toEqual([
      // `tracked_elsewhere` sits OUTSIDE the Local→Remote scale entirely, above it (bead
      // `sparkle-pgh1ue`). The ladder below measures "how far toward safely on remote main"; this
      // rung says the work is in a repository this project cannot measure and makes no progress
      // claim at all. Interleaving it among rungs that DO make one would imply a position on a scale
      // it has none on — so it goes first, where it implies nothing about the ladder under it.
      "tracked_elsewhere",
      // `local_none` is FIRST OF THE MEASURED RUNGS — least advanced of all. A row that holds
      // nothing has not started, so it sorts above one holding unsaved edits (sparkle-biezi).
      "local_none",
      "local_uncommitted",
      "local_committed",
      "local_merged",
      "remote_pushed",
      "remote_pr",
      "remote_merged",
      "remote_shipped",
    ]);
  });

  it("folds the pre-build planning stages into Local: Uncommitted", () => {
    expect(sectionOfStage("thought")).toBe("local_uncommitted");
    expect(sectionOfStage("specd")).toBe("local_uncommitted");
    expect(sectionOfStage("planned")).toBe("local_uncommitted");
    expect(sectionOfStage("building_unsaved")).toBe("local_uncommitted");
  });

  it("gives pushed-to-remote its own rung, distinct from committed and from PR", () => {
    // The reassurance rung: "backed up somewhere other than this laptop" is its own fact, and
    // collapsing it into either neighbor would hide the moment the work stops being at risk.
    expect(sectionOfStage("building_saved")).toBe("local_committed");
    expect(sectionOfStage("pushed")).toBe("remote_pushed");
    expect(sectionOfStage("pull_request")).toBe("remote_pr");
  });

  it("keeps merged-to-LOCAL-main on the Local side of the boundary", () => {
    expect(sectionOfStage("merged_local")).toBe("local_merged");
    expect(sectionOfStage("merged")).toBe("remote_merged");
  });

  it("does not claim a Local section's work is unpushed — only that the remote is unconfirmed", () => {
    // `merged_local` says "seen on local main, not yet on origin main"; it does NOT prove the branch
    // was never pushed (a pushed branch can land locally and settle here). Copy that told such a
    // user their work is "still only on this machine" would be false, and false in the alarming
    // direction, on the one distinction this ladder exists to teach.
    const local = BUILD_SECTIONS.find((s) => s.id === "local_merged")!;
    expect(local.detail).not.toMatch(/never pushed|only on this machine/i);
    expect(local.detail).toMatch(/not confirmed on the remote/i);
  });

  it("keeps the DELIBERATE inversion: merged_local outranks pull_request in the ladder", () => {
    // The module's one intentional deviation from the engine's monotonic stage index: `merged_local`
    // is engine stage 8, LATER than `pull_request` (7), yet it sits EARLIER in the ladder — because
    // the ladder measures "how far toward being safely on remote main", and local-only-main work is
    // behind an open PR by that measure. Without this case, moving merged_local to a post-PR slot
    // (the very remedy sectionOfStage's comment suggests) passes the whole suite and the reasoning
    // survives only as a comment.
    expect(stageIndex("merged_local")).toBeGreaterThan(stageIndex("pull_request"));
    const ladder = BUILD_SECTIONS.map((s) => s.id);
    expect(ladder.indexOf("local_merged")).toBeLessThan(ladder.indexOf("remote_pr"));

    // And end-to-end through the grouper, which is what actually decides rendered position.
    const groups = groupAgentsByStage(
      [row("pr"), row("localmain")],
      (id) => (id === "pr" ? "pull_request" : "merged_local"),
      () => "idle",
      allBandsVisible(),
    );
    expect(groups.map((g) => g.id)).toEqual(["local_merged", "remote_pr"]);
  });

  it("puts the Local→Remote boundary exactly once, and never lets a Remote section precede a Local one", () => {
    // `tracked_elsewhere` is EXCLUDED BY ID, not by a loosened label test. It is neither side of the
    // boundary — it is the rung for work this project cannot measure at all — and a label-shaped
    // exemption ("anything not starting with Local:") would quietly re-admit any future section that
    // happened to be named the same way. Naming it keeps this guard at full force: add a real remote
    // section above a local one and this still fails.
    const measured = BUILD_SECTIONS.filter((s) => s.id !== "tracked_elsewhere");
    const kinds = measured.map((s) => (s.label.startsWith("Local:") ? "local" : "remote"));
    // Every local section comes before every remote section — one clean boundary, no interleaving.
    expect(kinds.lastIndexOf("local")).toBeLessThan(kinds.indexOf("remote"));
    // …and the excluded rung really is the only unmeasured one, so the filter above cannot silently
    // grow to cover a section that should have been on the scale.
    expect(BUILD_SECTIONS.length - measured.length).toBe(1);
  });
});

describe("status bands", () => {
  it("maps every status to a band — no status can be unfilterable", () => {
    const statuses = Object.keys(AGENT_STATUS) as AgentTabStatus[];
    for (const s of statuses) {
      expect(STATUS_BANDS.map((b) => b.id)).toContain(bandOfStatus(s));
    }
  });

  it("bands agree EXACTLY with the AGENT_STATUS color tiers, except `lapsed`", () => {
    // This is the contract that makes the filter predictable: a chip hides precisely the rows whose
    // dot is that chip's color. If someone recolors a status without rebanding it, this fails.
    //
    // `lapsed` (AMBER, 2026-08-06) is the ONE deliberate exception: it rides in the gray `done` band
    // rather than earning a fifth chip. The exception is NAMED rather than the loop being loosened,
    // so the guard keeps all of its force — a second status drifting off its band still fails here,
    // and deleting `lapsed` from the taxonomy fails the companion assertion below rather than
    // silently leaving a dead exemption behind. See the StatusBand comment in buildSections.ts for
    // why the fifth band was built and then withdrawn.
    const statuses = Object.keys(AGENT_STATUS) as AgentTabStatus[];
    const colorOfBand: Record<StatusBand, string> = {
      needs_you: AGENT_STATUS.waiting.color,
      questions: AGENT_STATUS.questions.color,
      running: AGENT_STATUS.working.color,
      done: AGENT_STATUS.idle.color,
    };
    const EXEMPT: readonly AgentTabStatus[] = ["lapsed"];
    for (const s of statuses) {
      if (EXEMPT.includes(s)) continue;
      expect(AGENT_STATUS[s].color).toBe(colorOfBand[bandOfStatus(s)]);
    }
    // The exemption is real, and it is exactly one status wide.
    expect(statuses).toContain("lapsed");
    expect(AGENT_STATUS.lapsed.color).not.toBe(colorOfBand[bandOfStatus("lapsed")]);
    expect(statuses.filter((s) => AGENT_STATUS[s].color !== colorOfBand[bandOfStatus(s)])).toEqual([
      "lapsed",
    ]);
  });

  it("puts every red-tier status in Needs you", () => {
    for (const s of ["waiting", "approval", "blocked", "errored"] as const) {
      expect(bandOfStatus(s)).toBe("needs_you");
    }
  });

  it("puts `unmerged` in Done, not Needs you — the stage section carries the landing fact now", () => {
    // `unmerged` is gray (it stopped being an alarm on 2026-07-26). Under the ladder its "how far
    // did the work get" meaning is expressed by WHICH SECTION the row sits in, so the band is just
    // "this agent isn't asking you anything".
    expect(bandOfStatus("unmerged")).toBe("done");
  });

  it("defaults to all three bands visible", () => {
    expect(allBandsVisible()).toEqual({ needs_you: true, questions: true, running: true, done: true });
  });
});

// bandCountLabel lives in engine/statusBandLabels; these cases stay here because they pin the
// CONTRACT the chips in this ladder depend on. statusBandLabels.test.ts covers it from its own side.
describe("bandCountLabel — count and label agree in number", () => {
  it("inflects the verb in 'Needs you' at the n=1 boundary", () => {
    expect(bandCountLabel("needs_you", 1)).toBe("1 Needs you");
    expect(bandCountLabel("needs_you", 2)).toBe("2 Need you");
    expect(bandCountLabel("needs_you", 27)).toBe("27 Need you");
  });

  it("leaves the non-verb labels uninflected", () => {
    expect(bandCountLabel("running", 1)).toBe("1 Running");
    expect(bandCountLabel("running", 4)).toBe("4 Running");
    expect(bandCountLabel("done", 1)).toBe("1 Done");
    expect(bandCountLabel("done", 9)).toBe("9 Done");
  });

  it("handles zero with the plural form", () => {
    // "0 Need you" — English takes the plural for zero, not the singular.
    expect(bandCountLabel("needs_you", 0)).toBe("0 Need you");
    expect(bandCountLabel("done", 0)).toBe("0 Done");
  });

  it("covers every band, so no surface has to hand-write a label", () => {
    for (const b of STATUS_BANDS) {
      expect(bandCountLabel(b.id, 3)).toMatch(/^3 \S/);
    }
  });
});

describe("grouping rows into sections", () => {
  const all = allBandsVisible();

  it("returns ONLY non-empty sections, in ladder order", () => {
    const agents = [row("a"), row("b")];
    const { stageOf, statusOf } = lookups({ a: "pull_request", b: "building_unsaved" });
    const groups = groupAgentsByStage(agents, stageOf, statusOf, all);
    // Nothing is committed/pushed/merged, so those rungs don't render at all.
    expect(groups.map((g) => g.id)).toEqual(["local_uncommitted", "remote_pr"]);
    expect(groups[0]!.rows.map((r) => r.id)).toEqual(["b"]);
    expect(groups[1]!.rows.map((r) => r.id)).toEqual(["a"]);
  });

  it("preserves input order within a section — that order IS the user's drag arrangement", () => {
    const agents = [row("c"), row("a"), row("b")];
    const { stageOf, statusOf } = lookups({ a: "building_saved", b: "building_saved", c: "building_saved" });
    const groups = groupAgentsByStage(agents, stageOf, statusOf, all);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.rows.map((r) => r.id)).toEqual(["c", "a", "b"]);
  });

  it("does NOT reorder rows when a status changes — the whole point of the ladder", () => {
    const agents = [row("a"), row("b"), row("c")];
    const stages: Record<string, WorkflowStageId> = {
      a: "building_saved",
      b: "building_saved",
      c: "building_saved",
    };
    // Same three rows, same stages, wildly different statuses across the two calls.
    const calm = groupAgentsByStage(
      agents,
      lookups(stages, { a: "idle", b: "idle", c: "idle" }).stageOf,
      lookups(stages, { a: "idle", b: "idle", c: "idle" }).statusOf,
      all,
    );
    const noisy = groupAgentsByStage(
      agents,
      lookups(stages, { a: "idle", b: "waiting", c: "working" }).stageOf,
      lookups(stages, { a: "idle", b: "waiting", c: "working" }).statusOf,
      all,
    );
    // Under the OLD attention sort, `b` (waiting, rank 0) would have jumped to the top and `c`
    // (working, rank 2) to the bottom. Position must now be immune to status entirely.
    expect(flattenSections(calm).map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(flattenSections(noisy).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("moves a row between sections ONLY when its stage advances", () => {
    const agents = [row("a")];
    const before = groupAgentsByStage(agents, () => "building_saved", () => "idle", all);
    const after = groupAgentsByStage(agents, () => "pull_request", () => "idle", all);
    expect(before.map((g) => g.id)).toEqual(["local_committed"]);
    expect(after.map((g) => g.id)).toEqual(["remote_pr"]);
  });

  it("hides rows whose band is toggled off", () => {
    const agents = [row("red"), row("green"), row("gray")];
    const { stageOf, statusOf } = lookups(
      { red: "building_saved", green: "building_saved", gray: "building_saved" },
      { red: "waiting", green: "working", gray: "idle" },
    );
    const onlyRed = groupAgentsByStage(agents, stageOf, statusOf, {
      needs_you: true,
      questions: false,
      running: false,
      done: false,
    });
    expect(flattenSections(onlyRed).map((r) => r.id)).toEqual(["red"]);

    const noRed = groupAgentsByStage(agents, stageOf, statusOf, {
      needs_you: false,
      questions: true,
      running: true,
      done: true,
    });
    expect(flattenSections(noRed).map((r) => r.id)).toEqual(["green", "gray"]);
  });

  it("hides a section the filter emptied, but keeps sections that still have rows", () => {
    const agents = [row("a"), row("b")];
    const { stageOf, statusOf } = lookups(
      { a: "building_unsaved", b: "pull_request" },
      { a: "working", b: "idle" },
    );
    // Turn Running off: the Uncommitted section loses its only row and must disappear entirely.
    const groups = groupAgentsByStage(agents, stageOf, statusOf, {
      needs_you: true,
      questions: true,
      running: false,
      done: true,
    });
    expect(groups.map((g) => g.id)).toEqual(["remote_pr"]);
  });

  it("returns nothing when every band is filtered off", () => {
    const agents = [row("a"), row("b")];
    const { stageOf, statusOf } = lookups({ a: "building_saved", b: "pull_request" });
    const groups = groupAgentsByStage(agents, stageOf, statusOf, {
      // `questions: false` is load-bearing here, not filler: the test's name claims EVERY band is
      // off, and a missed band would leave it asserting something weaker than it says.
      needs_you: false,
      questions: false,
      running: false,
      done: false,
    });
    expect(groups).toEqual([]);
  });

  it("is id-preserving — the output is always a subset of the input, never a copy or a clone", () => {
    const a = row("a");
    const b = row("b");
    const { stageOf, statusOf } = lookups({ a: "building_saved", b: "pull_request" });
    const flat = flattenSections(groupAgentsByStage([a, b], stageOf, statusOf, all));
    // Identity, not just equality: selection is tracked by id and re-renders key off object identity.
    expect(flat[0]).toBe(a);
    expect(flat[1]).toBe(b);
  });
});

describe("sectionOfRow — a row that holds NOTHING is not 'Uncommitted' (sparkle-biezi)", () => {
  // The founder, on agent 11a52157: "I don't know why it's still in local uncommitted." Its
  // worktree was spotless and it had authored zero commits — it babysat somebody else's PR. But
  // `gitDerivedStage` maps `ahead === 0` to `building_unsaved` whether or not the tree is dirty, so
  // it filed under a heading that says its work is one close away from being lost.

  it("routes a positively-read EMPTY worktree to `local_none`", () => {
    expect(sectionOfRow("building_unsaved", false)).toBe("local_none");
  });

  it("leaves a genuinely DIRTY worktree in `local_uncommitted`", () => {
    // The heading's claim ("closing this agent loses them") has to stay true of everything left in
    // it, which is the whole reason the split was worth making.
    expect(sectionOfRow("building_unsaved", true)).toBe("local_uncommitted");
  });

  it("keeps an UNREAD worktree in `local_uncommitted` — absence of evidence earns nothing", () => {
    // The load-bearing arm. `undefined` means "never polled" or "parked tree, dirt not ours". If it
    // fell through to `local_none` the column would tell the founder "nothing here is at risk"
    // about a row nobody had looked at — the same false claim as before, pointing the other way.
    expect(sectionOfRow("building_unsaved", undefined)).toBe("local_uncommitted");
  });

  it("splits the pre-build planning stages the same way", () => {
    for (const stage of ["thought", "specd", "planned"] as const) {
      expect(sectionOfRow(stage, false)).toBe("local_none");
      expect(sectionOfRow(stage, true)).toBe("local_uncommitted");
      expect(sectionOfRow(stage, undefined)).toBe("local_uncommitted");
    }
  });

  it("NEVER re-routes a row that has committed work, whatever its tree says", () => {
    // Only the `local_uncommitted` rung is ambiguous. Every other stage means commits exist, so the
    // worktree's cleanliness says nothing about which rung the row belongs on — and a `merged` row
    // landing in "Nothing Yet" because its tree happens to be clean would be a far worse lie than
    // the one this fixes.
    for (const stage of ["building_saved", "pushed", "pull_request", "merged_local", "merged", "shipped"] as const) {
      for (const holds of [true, false, undefined]) {
        expect(sectionOfRow(stage, holds)).toBe(sectionOfStage(stage));
      }
    }
  });

  it("groupAgentsByStage without the accessor behaves exactly as before", () => {
    // Back-compat is the reason the parameter is optional: a caller with no worktree reading must
    // not be forced to invent one, and omitting it must not quietly move rows.
    const agents = [{ id: "a" }, { id: "b" }];
    const groups = groupAgentsByStage(
      agents,
      () => "building_unsaved",
      () => "idle",
      allBandsVisible(),
    );
    expect(groups.map((g) => g.id)).toEqual(["local_uncommitted"]);
  });

  it("groupAgentsByStage splits one bucket into two when the accessor disagrees per row", () => {
    const agents = [{ id: "empty" }, { id: "dirty" }, { id: "unread" }];
    const groups = groupAgentsByStage(
      agents,
      () => "building_unsaved",
      () => "idle",
      allBandsVisible(),
      undefined,
      (id) => (id === "empty" ? false : id === "dirty" ? true : undefined),
    );
    expect(groups.map((g) => g.id)).toEqual(["local_none", "local_uncommitted"]);
    expect(groups[0]?.rows.map((r) => r.id)).toEqual(["empty"]);
    // The unread row rides with the dirty one — conservative, and input order is preserved.
    expect(groups[1]?.rows.map((r) => r.id)).toEqual(["dirty", "unread"]);
  });
});

// ── the "Needs you" pill must not hide the band that also needs you ───────────────────────────
//
// There were TWO copies of this predicate (the pill's pressed state and its click), both spelled
// `needs_you && !running && !done`. They drifted the instant a fourth band landed: the read
// answered "isolated" while `questions` was also showing, and the click narrowed to `needs_you`
// ALONE — switching blue OFF. `questions` means the agent cannot proceed without you exactly as
// `waiting`/`approval` do, so a control the founder reads as "show me what needs me" was hiding
// work he owed. One seam, derived from STATUS_BANDS, so a fifth band is a decision here rather
// than a silent omission (bead sparkle-qogah).
describe("isAskingIsolated — the asking bands, and only those", () => {
  const f = (o: Partial<Record<StatusBand, boolean>>): Record<StatusBand, boolean> => ({
    needs_you: false,
    questions: false,
    running: false,
    done: false,
    ...o,
  });

  it("is true when exactly the asking bands are on", () => {
    expect(isAskingIsolated(f({ needs_you: true, questions: true }))).toBe(true);
  });

  // The regression the old spelling allowed: `needs_you` alone READ as isolated, so the pill showed
  // pressed for a filter that had blue switched off.
  it("is FALSE for needs_you alone — that state hides the questions band", () => {
    expect(isAskingIsolated(f({ needs_you: true }))).toBe(false);
  });

  it("is false when a calm band is also on", () => {
    expect(isAskingIsolated(f({ needs_you: true, questions: true, done: true }))).toBe(false);
  });

  it("is false when everything is showing", () => {
    expect(
      isAskingIsolated(f({ needs_you: true, questions: true, running: true, done: true })),
    ).toBe(false);
  });

  // Every asking band is one `engine/attention` treats as "cannot proceed without you".
  it("names exactly the bands that mean the agent is stuck on the user", () => {
    expect([...ASKING_BANDS].sort()).toEqual(["needs_you", "questions"]);
  });
});
