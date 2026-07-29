// The regression this file pins: a CLOSED agent's branch was never looked at, so an agent holding
// unmerged commits read as empty. See the module header of statusPollTargets.ts for the full story.
import { describe, expect, it } from "vitest";
import { splitStatusPollTargets } from "./statusPollTargets";

type A = { id: string; kind: string; parentId: string | null };
const agent = (id: string, kind = "build", parentId: string | null = null): A => ({
  id,
  kind,
  parentId,
});

const ids = (xs: readonly A[]) => xs.map((a) => a.id);

describe("splitStatusPollTargets", () => {
  // ── THE BUG ────────────────────────────────────────────────────────────────────────────────────
  // Agent 532be93b ("Build 4") sat with 11 unpushed commits on its branch and the app showed it as
  // idle-with-no-activity, one click away from being closed as empty. Its pane was closed, and a
  // closed pane meant NOBODY ever ran git for it: branchStatus stayed undefined, resolveStage fell
  // to `building_unsaved`, hasUnmergedCommittedWork said false, and the `unmerged` escalation that
  // exists precisely to say "this branch still needs you" never fired.
  it("polls a CLOSED agent — the branch that holds unmerged work is the one nobody is looking at", () => {
    const agents = [agent("open-1"), agent("closed-1")];
    const { probed, local } = splitStatusPollTargets(agents, ["open-1"]);

    expect(ids(probed)).toEqual(["open-1"]);
    // Before the fix this was `[]` and "closed-1" was polled by nothing at all.
    expect(ids(local)).toEqual(["closed-1"]);
  });

  it("covers every non-shell agent exactly once, so no row can fall through the gap", () => {
    const agents = [
      agent("open-build"),
      agent("open-worker", "worker", "open-build"),
      agent("closed-build"),
      agent("closed-worker", "worker", "closed-build"),
      agent("closed-think", "think"),
    ];
    const { probed, local } = splitStatusPollTargets(agents, ["open-build", "open-worker"]);

    const covered = [...ids(probed), ...ids(local)].sort();
    expect(covered).toEqual([
      "closed-build",
      "closed-think",
      "closed-worker",
      "open-build",
      "open-worker",
    ]);
    // Polling one agent in both batches would spend the work twice and let the second result
    // clobber the first (the batches disagree on purpose — only `probed` asks GitHub).
    expect(new Set(covered).size).toBe(covered.length);
  });

  // The pre-existing rule this change must not regress: a worker's "Merged" reads its PARENT's
  // stage, so an open worker drags its closed orchestrator into the PROBED batch — it needs the PR
  // state, not just local git.
  it("keeps a closed orchestrator of an OPEN worker in the probed batch, not the local one", () => {
    const agents = [agent("head"), agent("w", "worker", "head")];
    const { probed, local } = splitStatusPollTargets(agents, ["w"]);

    expect(ids(probed).sort()).toEqual(["head", "w"]);
    expect(ids(local)).toEqual([]);
  });

  // shell agents have no git workflow at all. Rust skips them anyway, so including them would buy
  // nothing and cost a round trip per tick.
  it("never polls a shell agent, open or closed", () => {
    const agents = [agent("sh-open", "shell"), agent("sh-closed", "shell")];
    const { probed, local } = splitStatusPollTargets(agents, ["sh-open"]);

    expect(ids(probed)).toEqual([]);
    expect(ids(local)).toEqual([]);
  });

  it("returns the agents' own order, so the batch stays stable tick to tick", () => {
    const agents = [agent("c1"), agent("c2"), agent("c3")];
    const { local } = splitStatusPollTargets(agents, []);
    expect(ids(local)).toEqual(["c1", "c2", "c3"]);
  });
});
