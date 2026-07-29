// The DIFF domain (concierge PRD section J).
//
// The invariants worth guarding here are not "does it call git" — they are the ones that make the
// answer TRUSTWORTHY: the range excludes other people's work, truncation is never silent, and a
// missing branch is reported as the supported state it is rather than as an error.
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { useProjectStore } from "../../stores/projectStore";
import {
  DIFF_OPS,
  DIFF_RISK,
  listChangedFiles,
  readFileDiff,
  listCommits,
} from "./diff";

const invokeMock = vi.mocked(invoke);
const AGENT = "agent-1";

function seedAgent(over: Record<string, unknown> = {}) {
  useProjectStore.setState({
    projects: [
      {
        id: "p1",
        name: "sparkle",
        rootPath: "/repo",
        defaultBranch: "main",
        agents: [{ id: AGENT, name: "Retry logic", baseBranch: "main", ...over } as never],
      } as never,
    ],
  });
}

/** A WORKER: cut from its parent's branch, but with `baseBranch` recording the project default —
 *  which is what the store really does (`addAgent`/`adoptWorker`), and what made this a bug. */
function seedWorker(over: Record<string, unknown>) {
  useProjectStore.setState({
    projects: [
      {
        id: "p1",
        name: "sparkle",
        rootPath: "/repo",
        defaultBranch: "main",
        agents: [
          {
            id: "w1",
            name: "Worker",
            kind: "worker",
            parentId: "orch-9",
            baseBranch: "main",
            ...over,
          } as never,
        ],
      } as never,
    ],
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({ files: [], totalFiles: 0, truncated: false });
  seedAgent();
});

describe("the surface is read-only by construction", () => {
  // The whole domain sits in the read-only tier, which is what lets it answer without an approval
  // round-trip. That is a claim about the implementation, so it is asserted rather than assumed —
  // and the policy layer derives its default decision from this map.
  it("classifies every op read-only", () => {
    expect(Object.values(DIFF_RISK).every((r) => r === "read-only")).toBe(true);
    expect(Object.keys(DIFF_RISK).sort()).toEqual([...DIFF_OPS].sort());
  });

});

// THE RANGE IS THE WHOLE POINT.
//
// Two-dot (`base..head`) shows the literal difference between two trees, which attributes everything
// that landed on the base since the agent branched TO THIS AGENT. A stale branch is the normal state
// in this repo, not an edge case, so two-dot would make the tool actively misleading rather than
// merely incomplete. Three-dot diffs against the merge base — the agent's own work.
describe("the range attributes only the agent's own work", () => {
  it("passes the agent's base and its own branch, not a caller-supplied ref", async () => {
    await listChangedFiles(AGENT);

    const [, args] = invokeMock.mock.calls[0]!;
    expect(args).toMatchObject({ cwd: "/repo", base: "main", head: `sparkle/agent-${AGENT}` });
  });

  it("falls back to the project's default branch when the agent has no base recorded", async () => {
    seedAgent({ baseBranch: null });
    await listChangedFiles(AGENT);

    expect(invokeMock.mock.calls[0]![1]).toMatchObject({ base: "main" });
  });

  // A WORKER'S BASE IS ITS PARENT'S BRANCH. The store records baseBranch = the project default for
  // a worker even though `create_worktree_from_local` cuts its branch from the PARENT's. Using
  // baseBranch made the merge base "where the ORCHESTRATOR branched from main", so a worker that
  // touched one file reported the orchestrator's commits and every sibling's merged work as its own
  // — the exact mis-attribution three-dot exists to prevent, through the wrong base.
  it("bases a WORKER on its parent's branch, not the project default", async () => {
    seedWorker({ parentBranch: "sparkle/agent-orch-9" });

    await listChangedFiles("w1");
    expect(invokeMock.mock.calls[0]![1]).toMatchObject({
      base: "sparkle/agent-orch-9",
      head: "sparkle/agent-w1",
    });
  });

  it("derives the parent's branch when parentBranch was never persisted", async () => {
    seedWorker({});

    await listChangedFiles("w1");
    expect(invokeMock.mock.calls[0]![1]).toMatchObject({ base: "sparkle/agent-orch-9" });
  });

  // Reads the project ROOT, not the agent's worktree: a spun-down worker's worktree is gone while
  // its branch survives, and AGENTS.md is explicit that the branch is still the evidence. Reading
  // from the worktree would make exactly that case uninspectable.
  it("reads from the project root, so a torn-down worktree is still inspectable", async () => {
    await listCommits(AGENT);
    expect(invokeMock.mock.calls[0]![1]).toMatchObject({ cwd: "/repo" });
  });
});

describe("failures are told apart", () => {
  it("refuses an unknown agent with an id the caller can act on", async () => {
    const r = await listChangedFiles("nope");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("unknown-agent");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  // WHICH ref failed decides what we may CLAIM. Both surface as git's one "ambiguous argument"
  // message, so the Rust side rev-parses each and names the one that failed — a regex over that
  // message cannot tell them apart, and the two support opposite statements.
  it("reports a branchless agent as `no-branch`, not as a git error", async () => {
    invokeMock.mockRejectedValue(new Error("missing-head: sparkle/agent-1"));

    const r = await listChangedFiles(AGENT);
    expect(!r.ok && r.reason).toBe("no-branch");
    expect(!r.ok && r.message).toMatch(/hasn't committed/);
  });

  // A base ref this repo cannot resolve (a stale or never-fetched default branch) is a problem with
  // the REPO. Reporting it as "it hasn't committed anything" tells the human an agent did no work
  // while its branch sits there with commits on it — a false negative about the thing AGENTS.md
  // calls the evidence.
  it("does NOT claim an agent has no work when it is the BASE that won't resolve", async () => {
    invokeMock.mockRejectedValue(new Error("missing-base: main"));

    const r = await listChangedFiles(AGENT);
    expect(!r.ok && r.reason).toBe("missing-base");
    expect(!r.ok && r.message).not.toMatch(/hasn't committed/);
    expect(!r.ok && r.message).toMatch(/main/);
  });

  it("still surfaces a genuine git failure as one", async () => {
    invokeMock.mockRejectedValue(new Error("git diff failed: not a git repository"));

    const r = await listChangedFiles(AGENT);
    expect(!r.ok && r.reason).toBe("git-failed");
  });

  // EVERY op must classify the same way. diff_commits was missing the ref prelude while the TS
  // fallback regex was removed in the same change, so list_commits on a branchless agent regressed
  // from the supported `no-branch` state to a raw `fatal: ambiguous argument` reaching the
  // concierge — which is also the promise the sparkle_diff description makes and server.test.ts
  // pins. Asserted per op rather than for one of the three.
  it.each([
    ["list_changed_files", () => listChangedFiles(AGENT)],
    ["read_file_diff", () => readFileDiff(AGENT, "a.ts")],
    ["list_commits", () => listCommits(AGENT)],
  ] as const)("%s reports a branchless agent as no-branch", async (_name, call) => {
    invokeMock.mockRejectedValue(new Error("missing-head: sparkle/agent-1"));

    const r = await call();
    expect(!r.ok && r.reason).toBe("no-branch");
  });

  it("refuses read_file_diff with no path rather than diffing everything", async () => {
    const r = await readFileDiff(AGENT, "  ");
    expect(!r.ok && r.reason).toBe("bad-args");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

// TRUNCATION IS PART OF THE ANSWER, NOT A DIAGNOSTIC.
//
// A caller that cannot tell a whole change from its first N files will describe a fragment as the
// change — the confident-and-wrong failure this surface exists not to have.
describe("truncation reaches the caller", () => {
  it("carries totalFiles and truncated through untouched", async () => {
    invokeMock.mockResolvedValue({
      base: "main",
      head: "sparkle/agent-1",
      files: [{ path: "a.ts", added: 3, removed: 1, binary: false }],
      totalFiles: 900,
      truncated: true,
    });

    const r = await listChangedFiles(AGENT);
    expect(r.ok).toBe(true);
    expect(r.ok && r.data.truncated).toBe(true);
    // The real count survives, so "that's all of them" and "that's 1 of 900" stay distinguishable.
    expect(r.ok && r.data.totalFiles).toBe(900);
  });

  it("carries BOTH shortfalls through for a clipped patch", async () => {
    invokeMock.mockResolvedValue({
      path: "a.ts",
      text: "@@ -1 +1 @@",
      truncated: true,
      omittedLines: 1,
      omittedBytes: 204_800,
    });

    const r = await readFileDiff(AGENT, "a.ts");
    expect(r.ok && r.data.omittedLines).toBe(1);
    // The line count alone understates a dropped minified bundle by orders of magnitude.
    expect(r.ok && r.data.omittedBytes).toBe(204_800);
  });

  // A caller may ask for LESS than the module's cap; the ceiling itself lives in Rust so a
  // hallucinated `limit: 5_000_000` cannot widen it.
  it("forwards a lower limit, and null when none was given", async () => {
    await listChangedFiles(AGENT, 5);
    expect(invokeMock.mock.calls[0]![1]).toMatchObject({ limit: 5 });

    invokeMock.mockClear();
    await listChangedFiles(AGENT);
    expect(invokeMock.mock.calls[0]![1]).toMatchObject({ limit: null });
  });
});
