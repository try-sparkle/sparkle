// @vitest-environment jsdom
//
// THE ROW MUST BE ABLE TO SAY WHAT IT MEASURED (bead `sparkle-pgkbn4`).
//
// A release-cut agent that had tagged, built and published v0.114.0 sat under "Local: Nothing Yet".
// The counts on its row were not wrong arithmetic — they were CORRECT ABOUT A BRANCH NOBODY MEANT:
// Rust had resolved it onto a stale, empty `sparkle/agent-<id>` ref left behind when the agent
// renamed its branch. Nothing on screen named that branch, so the only way to discover it was to
// open a terminal and re-derive the resolution by hand.
//
// These assert what the user can READ, not that a prop was threaded: the branch name is on screen,
// a parked reading says the tree is elsewhere, and an older Rust build (no field) prints nothing
// rather than a blank or a guessed name.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AgentDetailLines } from "./AgentDetailLines";
import type { BranchStatus } from "../services/branchStatus";

const bs = (over: Partial<BranchStatus>): BranchStatus => ({
  ahead: 1,
  behind: 0,
  dirty: false,
  filesChanged: 1,
  insertions: 1,
  deletions: 0,
  ...over,
});

function draw(b?: BranchStatus) {
  return render(
    <AgentDetailLines
      worktreePath="/tmp/wt"
      rootPath="/tmp/root"
      bs={b}
      baseBranch="main"
      isWorker={false}
      busy={false}
      progressPct={null}
      workerCount={0}
      onLand={() => {}}
      onRefresh={() => {}}
    />,
  );
}

afterEach(cleanup);

describe("the measured branch on an agent's detail card", () => {
  it("names the branch the counts were measured on", () => {
    draw(bs({ branch: "sparkle/ci-hosted-outage-not-a-test-failure", worktreeOnBranch: true }));
    expect(screen.getByTestId("measured-branch").textContent).toContain(
      "sparkle/ci-hosted-outage-not-a-test-failure",
    );
  });

  it("says the tree is elsewhere when the worktree is parked", () => {
    // The one reading where the numbers deliberately are NOT about the files on disk. Saying only
    // the branch name here would be true and still misleading.
    draw(bs({ branch: "sparkle/agent-abc", worktreeOnBranch: false }));
    const el = screen.getByTestId("measured-branch");
    expect(el.textContent).toContain("sparkle/agent-abc");
    expect(el.textContent).toContain("checked out elsewhere");
  });

  it("does not claim 'elsewhere' when the tree IS on the branch", () => {
    // The paired negative: without it, a component that ALWAYS appended the caveat would pass the
    // test above while telling every healthy agent its tree was somewhere else.
    draw(bs({ branch: "sparkle/agent-abc", worktreeOnBranch: true }));
    expect(screen.getByTestId("measured-branch").textContent).not.toContain("elsewhere");
  });

  it("prints nothing at all when the Rust build predates the field", () => {
    // `undefined` is "this build cannot tell you", not "no branch". A blank line or a guessed
    // `sparkle/agent-<id>` would re-create the exact confusion this exists to remove.
    draw(bs({}));
    expect(screen.queryByTestId("measured-branch")).toBeNull();
  });

  it("prints nothing when there is no branch status at all", () => {
    draw(undefined);
    expect(screen.queryByTestId("measured-branch")).toBeNull();
  });
});
