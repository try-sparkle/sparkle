import { describe, it, expect, vi, beforeEach } from "vitest";

// The module under test WRAPS the existing services — it must never reimplement git — so the
// services themselves are what we mock. A test that passes here is evidence the wrapper delegates.
const m = vi.hoisted(() => ({
  refreshAgentBranch: vi.fn(),
  landAgentBranch: vi.fn(),
  pushAgentBranch: vi.fn(),
  openAgentPr: vi.fn(),
  deleteAgentBranch: vi.fn(),
  deleteAgentBranchIfMerged: vi.fn(),
  agentBranchStatus: vi.fn(),
  agentWorkflowState: vi.fn(),
  projectAgentsStatus: vi.fn(),
  fetchOpenPrs: vi.fn(),
  mergePr: vi.fn(),
  statuses: {} as Record<string, string>,
  projects: [] as Array<{ rootPath: string }>,
}));

vi.mock("../branchStatus", () => ({
  refreshAgentBranch: m.refreshAgentBranch,
  landAgentBranch: m.landAgentBranch,
  pushAgentBranch: m.pushAgentBranch,
  openAgentPr: m.openAgentPr,
  deleteAgentBranch: m.deleteAgentBranch,
  deleteAgentBranchIfMerged: m.deleteAgentBranchIfMerged,
  agentBranchStatus: m.agentBranchStatus,
  agentWorkflowState: m.agentWorkflowState,
  projectAgentsStatus: m.projectAgentsStatus,
}));

vi.mock("../openPrs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../openPrs")>();
  return { ...actual, fetchOpenPrs: m.fetchOpenPrs, mergePr: m.mergePr };
});

// The busy gate reads LIVE status from the store rather than trusting a caller-supplied flag —
// the caller here is an LLM, and "is this agent still working" must not be its word to give.
vi.mock("../../stores/runtimeStore", () => ({
  useRuntimeStore: { getState: () => ({ status: m.statuses }) },
}));

// A model-supplied `root` is a path into the user's disk, so it is checked against the projects the
// human actually added — same store the integration layer resolves roots from.
vi.mock("../../stores/projectStore", () => ({
  useProjectStore: { getState: () => ({ projects: m.projects }) },
}));

import {
  WORKFLOW_OPERATIONS,
  WORKFLOW_RISK,
  riskOf,
  describeWorkflowTools,
  resolveLandTarget,
  refreshAgentBranchTool,
  landAgentBranchTool,
  pushAgentBranchTool,
  openAgentPrTool,
  mergePrTool,
  deleteAgentBranchTool,
  deleteAgentBranchIfMergedTool,
  agentBranchStatusTool,
  agentWorkflowStateTool,
  projectAgentsStatusTool,
  projectOpenPrsTool,
  prChecksStatusTool,
  agentLandedCheckTool,
  type AgentWorkflowContext,
  type WorkflowOperation,
} from "./workflow";

const build: AgentWorkflowContext = {
  root: "/repo",
  projectId: "p1",
  agentId: "a1",
  kind: "build",
  baseBranch: "main",
  defaultBranch: "main",
};
const worker: AgentWorkflowContext = {
  root: "/repo",
  projectId: "p1",
  agentId: "w1",
  kind: "worker",
  parentId: "a1",
  baseBranch: "main",
  defaultBranch: "main",
};

beforeEach(() => {
  for (const fn of Object.values(m)) if (typeof fn === "function") (fn as ReturnType<typeof vi.fn>).mockReset();
  for (const k of Object.keys(m.statuses)) delete m.statuses[k];
  m.projects.length = 0;
  m.projects.push({ rootPath: "/repo" });
});

describe("risk classification", () => {
  it("classifies EVERY operation (the map is exhaustive over the union)", () => {
    // Compile-time half: `WORKFLOW_RISK` is a Record over the union, so an unclassified new
    // operation is a tsc error. This type assertion fails the typecheck if that ever loosens.
    type Unclassified = Exclude<WorkflowOperation, keyof typeof WORKFLOW_RISK>;
    const _noneUnclassified: Unclassified extends never ? true : never = true;
    expect(_noneUnclassified).toBe(true);

    // Runtime half: the advertised operation LIST and the risk map agree, so neither can drift.
    expect([...WORKFLOW_OPERATIONS].sort()).toEqual(Object.keys(WORKFLOW_RISK).sort());
    for (const op of WORKFLOW_OPERATIONS) {
      expect(WORKFLOW_RISK[op].risk).toBeTruthy();
      expect(WORKFLOW_RISK[op].summary.length).toBeGreaterThan(0);
    }
  });

  it("puts each dangerous operation in the class the policy layer expects", () => {
    expect(riskOf("delete_agent_branch")).toBe("irreversible");
    expect(riskOf("delete_agent_branch_if_merged")).toBe("irreversible");
    expect(riskOf("land_agent_branch")).toBe("mutates-main");
    expect(riskOf("merge_pr")).toBe("mutates-main");
    expect(riskOf("push_agent_branch")).toBe("outward-facing");
    expect(riskOf("open_agent_pr")).toBe("outward-facing");
    expect(riskOf("refresh_agent_branch")).toBe("rewrites-branch");
    expect(riskOf("agent_branch_status")).toBe("read-only");
    expect(riskOf("agent_workflow_state")).toBe("read-only");
    expect(riskOf("project_agents_status")).toBe("read-only");
    expect(riskOf("project_open_prs")).toBe("read-only");
    expect(riskOf("pr_checks_status")).toBe("read-only");
    expect(riskOf("agent_landed_check")).toBe("read-only");
  });

  it("requires confirmation for everything that is not read-only", () => {
    for (const op of WORKFLOW_OPERATIONS) {
      const profile = WORKFLOW_RISK[op];
      expect(profile.requiresConfirmation).toBe(profile.risk !== "read-only");
    }
  });

  it("describes every tool for the model, risk included", () => {
    const described = describeWorkflowTools();
    expect(described).toHaveLength(WORKFLOW_OPERATIONS.length);
    expect(described.every((d) => d.risk && d.summary)).toBe(true);
  });
});

describe("refresh_agent_branch", () => {
  it("REFUSES while the agent is working, without touching git", async () => {
    m.statuses["a1"] = "working";
    const r = await refreshAgentBranchTool(build);
    expect(r).toMatchObject({ ok: false, kind: "refused", code: "agent-working", op: "refresh_agent_branch" });
    expect(m.refreshAgentBranch).not.toHaveBeenCalled();
  });

  it("rebases onto the base branch and reports ahead/behind", async () => {
    m.refreshAgentBranch.mockResolvedValue({ ok: true, ahead: 2, behind: 0 });
    const r = await refreshAgentBranchTool(build);
    expect(r).toEqual({
      ok: true,
      op: "refresh_agent_branch",
      risk: "rewrites-branch",
      data: { ahead: 2, behind: 0, base: "main" },
    });
    expect(m.refreshAgentBranch).toHaveBeenCalledWith("/repo", "p1", "a1", "main", false);
  });

  it("distinguishes a dirty refusal from a conflict failure", async () => {
    m.refreshAgentBranch.mockResolvedValue({ ok: false, reason: "dirty" });
    expect(await refreshAgentBranchTool(build)).toMatchObject({ kind: "refused", code: "dirty" });

    m.refreshAgentBranch.mockResolvedValue({ ok: false, reason: "conflict", files: ["a.ts"] });
    expect(await refreshAgentBranchTool(build)).toMatchObject({
      kind: "failed",
      code: "conflict",
      files: ["a.ts"],
    });
  });

  it("refuses when there is no base branch to rebase onto", async () => {
    const r = await refreshAgentBranchTool({ ...build, baseBranch: "" });
    expect(r).toMatchObject({ kind: "refused", code: "no-target" });
    expect(m.refreshAgentBranch).not.toHaveBeenCalled();
  });

  // The fallback used to report EVERY unhandled reason as `agent-working`, which tells the model to
  // "wait for the agent to finish" for a condition that has nothing to do with the agent. Only
  // "busy" means busy.
  it("reserves the agent-working verdict for an actual busy reason", async () => {
    m.refreshAgentBranch.mockResolvedValue({ ok: false, reason: "busy" });
    expect(await refreshAgentBranchTool(build)).toMatchObject({
      kind: "refused",
      code: "agent-working",
    });

    m.refreshAgentBranch.mockResolvedValue({ ok: false, reason: "detached-head" });
    const r = await refreshAgentBranchTool(build);
    expect(r).toMatchObject({ kind: "failed", code: "unknown-error" });
    if (!r.ok) {
      expect(r.message).toContain("detached-head");
      expect(r.message).not.toMatch(/still working/i);
    }
  });
});

describe("land_agent_branch", () => {
  it("lands a build agent into the project default and a worker into its orchestrator branch", () => {
    expect(resolveLandTarget(build)).toBe("main");
    expect(resolveLandTarget(worker)).toBe("sparkle/agent-a1");
  });

  it("merges locally and reports the merge SHA", async () => {
    m.landAgentBranch.mockResolvedValue({ ok: true, target: "main", mergeSha: "abc123" });
    const r = await landAgentBranchTool(build);
    expect(r).toEqual({
      ok: true,
      op: "land_agent_branch",
      risk: "mutates-main",
      data: { target: "main", mergeSha: "abc123" },
    });
    expect(m.landAgentBranch).toHaveBeenCalledWith("/repo", "a1", "main", false);
  });

  it("REFUSES to land under a live agent — its own, or the orchestrator it targets", async () => {
    m.statuses["w1"] = "working";
    expect(await landAgentBranchTool(worker)).toMatchObject({ kind: "refused", code: "agent-working" });
    expect(m.landAgentBranch).not.toHaveBeenCalled();

    delete m.statuses["w1"];
    m.statuses["a1"] = "working";
    m.landAgentBranch.mockResolvedValue({ ok: false, reason: "busy", files: [] });
    expect(await landAgentBranchTool(worker)).toMatchObject({ kind: "refused", code: "target-busy" });
    expect(m.landAgentBranch).toHaveBeenCalledWith("/repo", "w1", "sparkle/agent-a1", true);
  });

  it("maps each land failure to its own code", async () => {
    const cases: [string, string, "refused" | "failed"][] = [
      ["dirty", "dirty", "refused"],
      ["nothing-to-land", "nothing-to-land", "refused"],
      ["target-not-checked-out", "target-not-checked-out", "refused"],
      ["no-branch", "no-branch", "refused"],
      ["no-target", "no-target", "refused"],
      ["conflict", "conflict", "failed"],
      ["merge-failed", "merge-failed", "failed"],
    ];
    for (const [reason, code, kind] of cases) {
      m.landAgentBranch.mockResolvedValue({ ok: false, reason, files: [] });
      expect(await landAgentBranchTool(build)).toMatchObject({ ok: false, kind, code });
    }
  });

  // `reason` is a closed union in TypeScript but it is DESERIALIZED FROM RUST across IPC, so tsc's
  // exhaustiveness is not a runtime guarantee. Without a default arm the switch fell off the end of
  // the try and resolved `undefined` — from a function whose contract is "always a typed result" —
  // and the caller crashed on `result.ok`.
  it("returns a typed failure for a reason it has never heard of, instead of undefined", async () => {
    m.landAgentBranch.mockResolvedValue({ ok: false, reason: "brand-new-reason", files: [] });
    const r = await landAgentBranchTool(build);
    expect(r).toBeDefined();
    expect(r).toMatchObject({ ok: false, kind: "failed", code: "unknown-error" });
    if (!r.ok) expect(r.message).toContain("brand-new-reason");
  });
});

describe("push_agent_branch", () => {
  it("pushes the agent branch to origin", async () => {
    m.pushAgentBranch.mockResolvedValue("pushed");
    const r = await pushAgentBranchTool(build);
    expect(r).toEqual({
      ok: true,
      op: "push_agent_branch",
      risk: "outward-facing",
      data: { outcome: "pushed", branch: "sparkle/agent-a1" },
    });
    expect(m.pushAgentBranch).toHaveBeenCalledWith("/repo", "a1");
  });

  it("reports no-remote as a refusal, not an error", async () => {
    m.pushAgentBranch.mockResolvedValue("no-remote");
    expect(await pushAgentBranchTool(build)).toMatchObject({ kind: "refused", code: "no-remote" });
  });

  it("tells an expired-auth push apart from an unknown git failure", async () => {
    m.pushAgentBranch.mockRejectedValue(new Error("fatal: Authentication failed for 'https://github.com/x'"));
    const auth = await pushAgentBranchTool(build);
    expect(auth).toMatchObject({ kind: "failed", code: "auth-failed" });
    expect(auth.ok).toBe(false);
    if (!auth.ok) expect(auth.message).toContain("Authentication failed");

    m.pushAgentBranch.mockRejectedValue("fatal: the disk exploded");
    expect(await pushAgentBranchTool(build)).toMatchObject({ kind: "failed", code: "unknown-error" });

    m.pushAgentBranch.mockRejectedValue("! [rejected] main -> main (non-fast-forward)");
    expect(await pushAgentBranchTool(build)).toMatchObject({
      kind: "failed",
      code: "rejected-non-fast-forward",
    });
  });

  // Rust rejects with the BARE string "no-branch" when the agent has no branch to push. That is a
  // precisely known, actionable condition and there is a code for it — reporting "unknown git
  // failure" sends the model looking for a git problem that isn't there.
  it("names the no-branch rejection instead of calling it an unknown git failure", async () => {
    m.pushAgentBranch.mockRejectedValue("no-branch");
    expect(await pushAgentBranchTool(build)).toMatchObject({ kind: "failed", code: "no-branch" });
  });

  // "Anything that isn't no-remote is a successful push" would report `pushed` for any outcome
  // string Rust adds later — the same assert-don't-observe failure as the delete tools.
  it("does not report a push it cannot vouch for", async () => {
    for (const bogus of [undefined, null, "queued", ""]) {
      m.pushAgentBranch.mockResolvedValue(bogus);
      const r = await pushAgentBranchTool(build);
      expect(r).toMatchObject({ ok: false, kind: "failed", code: "unknown-error" });
      expect(JSON.stringify(r)).not.toMatch(/"outcome":"pushed"/);
    }
  });
});

describe("open_agent_pr", () => {
  it("opens a PR against the land target and returns its URL", async () => {
    m.openAgentPr.mockResolvedValue("https://github.com/o/r/pull/7");
    const r = await openAgentPrTool(build, "Do the thing");
    expect(r).toEqual({
      ok: true,
      op: "open_agent_pr",
      risk: "outward-facing",
      data: { url: "https://github.com/o/r/pull/7", target: "main", title: "Do the thing" },
    });
    expect(m.openAgentPr).toHaveBeenCalledWith("/repo", "a1", "main", "Do the thing");
  });

  it("refuses a blank title instead of opening a nameless PR", async () => {
    expect(await openAgentPrTool(build, "   ")).toMatchObject({
      kind: "refused",
      code: "invalid-request",
    });
    expect(m.openAgentPr).not.toHaveBeenCalled();
  });

  it("separates 'a PR already exists' from 'gh is unusable' from 'not pushed yet'", async () => {
    m.openAgentPr.mockRejectedValue("a pull request for branch sparkle/agent-a1 already exists");
    expect(await openAgentPrTool(build, "t")).toMatchObject({ kind: "refused", code: "pr-exists" });

    m.openAgentPr.mockRejectedValue("gh: command not found");
    expect(await openAgentPrTool(build, "t")).toMatchObject({ kind: "failed", code: "gh-unavailable" });

    m.openAgentPr.mockRejectedValue("gh auth login required: You are not logged into any GitHub hosts");
    expect(await openAgentPrTool(build, "t")).toMatchObject({ kind: "failed", code: "auth-failed" });

    m.openAgentPr.mockRejectedValue("must first push the current branch to a remote");
    expect(await openAgentPrTool(build, "t")).toMatchObject({ kind: "refused", code: "not-pushed" });
  });
});

describe("merge_pr", () => {
  const openPr = {
    number: 7,
    title: "t",
    headRefName: "sparkle/agent-a1",
    url: "u",
    checks: "passing" as const,
    mergeable: "mergeable" as const,
  };

  it("CANNOT be asked to squash or to auto-merge", async () => {
    // AGENTS.md: a squash rewrites commits so the branch tip stops being an ancestor of main and
    // Sparkle can no longer prove the work landed; `--auto` is not a guard on this repo (auto-merge
    // is off, so gh merges IMMEDIATELY with checks pending). The type forbids both; this is the
    // runtime backstop for the unstructured JSON an LLM sends.
    for (const bad of [{ method: "squash" }, { method: "rebase" }, { auto: true }, { squash: true }]) {
      const r = await mergePrTool({ root: "/repo", number: 7, ...bad } as never);
      expect(r).toMatchObject({ ok: false, kind: "refused", code: "invalid-request" });
    }
    expect(m.mergePr).not.toHaveBeenCalled();
    expect(m.fetchOpenPrs).not.toHaveBeenCalled();
  });

  it("merges with a MERGE COMMIT once checks are green", async () => {
    m.fetchOpenPrs.mockResolvedValue([openPr]);
    m.mergePr.mockResolvedValue(undefined);
    const r = await mergePrTool({ root: "/repo", number: 7 });
    expect(r).toEqual({
      ok: true,
      op: "merge_pr",
      risk: "mutates-main",
      data: { number: 7, method: "merge", url: "u" },
    });
    expect(m.mergePr).toHaveBeenCalledWith("/repo", 7);
  });

  it("refuses to merge over pending or failing checks, or a conflict", async () => {
    for (const row of [
      { ...openPr, checks: "pending" as const },
      { ...openPr, checks: "failing" as const },
      { ...openPr, mergeable: "conflicting" as const },
    ]) {
      m.fetchOpenPrs.mockResolvedValue([row]);
      expect(await mergePrTool({ root: "/repo", number: 7 })).toMatchObject({
        kind: "refused",
        code: "checks-blocked",
      });
    }
    expect(m.mergePr).not.toHaveBeenCalled();
  });

  it("refuses to merge blind when the PR probe could not answer", async () => {
    m.fetchOpenPrs.mockResolvedValue(null);
    expect(await mergePrTool({ root: "/repo", number: 7 })).toMatchObject({
      kind: "refused",
      code: "checks-unknown",
    });

    m.fetchOpenPrs.mockResolvedValue([{ ...openPr, number: 9 }]);
    expect(await mergePrTool({ root: "/repo", number: 7 })).toMatchObject({
      kind: "refused",
      code: "pr-not-found",
    });
    expect(m.mergePr).not.toHaveBeenCalled();
  });

  it("reports gh's own refusal when the merge itself fails", async () => {
    m.fetchOpenPrs.mockResolvedValue([openPr]);
    m.mergePr.mockRejectedValue("Pull request is not mergeable: the merge commit cannot be cleanly created");
    expect(await mergePrTool({ root: "/repo", number: 7 })).toMatchObject({
      kind: "failed",
      code: "conflict",
    });

    m.mergePr.mockRejectedValue("GraphQL: Required status checks have not passed");
    expect(await mergePrTool({ root: "/repo", number: 7 })).toMatchObject({
      kind: "failed",
      code: "checks-blocked",
    });
  });
});

describe("delete_agent_branch", () => {
  it("deletes the branch and says so", async () => {
    m.deleteAgentBranch.mockResolvedValue("deleted");
    const r = await deleteAgentBranchTool(build);
    expect(r).toEqual({
      ok: true,
      op: "delete_agent_branch",
      risk: "irreversible",
      data: { branch: "sparkle/agent-a1", deleted: true, outcome: "deleted" },
    });
    expect(m.deleteAgentBranch).toHaveBeenCalledWith("/repo", "a1");
  });

  it("REFUSES to delete under a live agent", async () => {
    m.statuses["a1"] = "working";
    expect(await deleteAgentBranchTool(build)).toMatchObject({ kind: "refused", code: "agent-working" });
    expect(m.deleteAgentBranch).not.toHaveBeenCalled();
  });

  it("reports a still-checked-out branch as its own failure", async () => {
    m.deleteAgentBranch.mockRejectedValue("error: Cannot delete branch used by worktree at /wt");
    expect(await deleteAgentBranchTool(build)).toMatchObject({
      kind: "failed",
      code: "branch-checked-out",
    });
  });

  // The delete commands are IDEMPOTENT: a branch that was already gone resolves exactly like a real
  // delete. Reporting `deleted: true` for it tells the human a ref was destroyed when nothing was.
  it("does not claim a delete for a branch that was already absent", async () => {
    m.deleteAgentBranch.mockResolvedValue("already-absent");
    const r = await deleteAgentBranchTool(build);
    expect(r).toMatchObject({ ok: true, data: { deleted: false, outcome: "already-absent" } });
  });

  // THE FALSE-REPORT GUARD. The Rust command reports success whether it deleted or kept the branch,
  // so an outcome this layer does not recognize (an older binary, a renamed variant) must read as
  // "I cannot confirm", never as a delete.
  it("says it cannot confirm, rather than 'deleted', for an outcome it does not recognize", async () => {
    for (const bogus of [undefined, null, "", "sort-of-deleted", 42]) {
      m.deleteAgentBranch.mockResolvedValue(bogus);
      const r = await deleteAgentBranchTool(build);
      expect(r).toMatchObject({ ok: false, kind: "failed", code: "unknown-error" });
      expect(JSON.stringify(r)).not.toMatch(/"deleted":true/);
    }
  });
});

describe("delete_agent_branch_if_merged", () => {
  it("deletes only when the command says it deleted", async () => {
    m.deleteAgentBranchIfMerged.mockResolvedValue("deleted");
    expect(await deleteAgentBranchIfMergedTool(build)).toEqual({
      ok: true,
      op: "delete_agent_branch_if_merged",
      risk: "irreversible",
      data: { branch: "sparkle/agent-a1", deleted: true, outcome: "deleted" },
    });
  });

  // THE HIGH FINDING. The Rust command NEVER rejects for an unlanded branch — it silently keeps it
  // and returns Ok — so this refusal has to come from the OBSERVED outcome. Proving it with a
  // mocked rejection (which the service cannot produce) is false confidence.
  it("reports 'kept, not merged' from the outcome the command actually returned", async () => {
    m.deleteAgentBranchIfMerged.mockResolvedValue("kept-not-merged");
    const r = await deleteAgentBranchIfMergedTool(build);
    expect(r).toMatchObject({ ok: false, kind: "refused", code: "not-merged" });
    expect(JSON.stringify(r)).not.toMatch(/"deleted":true/);
  });

  it("does not claim a delete for a branch that was already absent", async () => {
    m.deleteAgentBranchIfMerged.mockResolvedValue("already-absent");
    expect(await deleteAgentBranchIfMergedTool(build)).toMatchObject({
      ok: true,
      data: { deleted: false, outcome: "already-absent" },
    });
  });

  it("says it cannot confirm, rather than 'deleted', for an outcome it does not recognize", async () => {
    for (const bogus of [undefined, null, "kept", 0]) {
      m.deleteAgentBranchIfMerged.mockResolvedValue(bogus);
      const r = await deleteAgentBranchIfMergedTool(build);
      expect(r).toMatchObject({ ok: false, kind: "failed", code: "unknown-error" });
      expect(JSON.stringify(r)).not.toMatch(/"deleted":true/);
    }
  });

  it("still maps a thrown 'not fully merged' and a checked-out branch to their own codes", async () => {
    m.deleteAgentBranchIfMerged.mockRejectedValue("error: the branch 'x' is not fully merged");
    expect(await deleteAgentBranchIfMergedTool(build)).toMatchObject({
      kind: "refused",
      code: "not-merged",
    });

    m.deleteAgentBranchIfMerged.mockRejectedValue("error: Cannot delete branch used by worktree at /wt");
    expect(await deleteAgentBranchIfMergedTool(build)).toMatchObject({
      kind: "failed",
      code: "branch-checked-out",
    });
  });

  it("REFUSES to delete under a live agent", async () => {
    m.statuses["a1"] = "working";
    expect(await deleteAgentBranchIfMergedTool(build)).toMatchObject({
      kind: "refused",
      code: "agent-working",
    });
    expect(m.deleteAgentBranchIfMerged).not.toHaveBeenCalled();
  });
});

describe("agent_landed_check", () => {
  const state = (over: Record<string, unknown>) => ({
    inLocalMain: false,
    inOriginMain: false,
    inParent: false,
    aheadOfBase: 3,
    prState: null,
    prNumber: null,
    prUrl: null,
    ...over,
  });

  it("answers by ANCESTRY, not by watching CI", async () => {
    m.agentWorkflowState.mockResolvedValue(state({ inOriginMain: true, inLocalMain: true }));
    const r = await agentLandedCheckTool(build);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toMatchObject({ verdict: "landed", where: "origin-default", basis: "ancestry" });
    // Local refs only — no PR/CI probe is needed to answer "did this reach main".
    expect(m.agentWorkflowState).toHaveBeenCalledWith("/repo", "a1", "", false);
  });

  it("says 'local only' when the work is in the local default but not confirmed on origin", async () => {
    m.agentWorkflowState.mockResolvedValue(state({ inLocalMain: true }));
    const r = await agentLandedCheckTool(build);
    if (r.ok) expect(r.data).toMatchObject({ verdict: "landed", where: "local-default" });
  });

  it("catches a squash-landed branch, whose tip is no longer an ancestor", async () => {
    m.agentWorkflowState.mockResolvedValue(state({ landed: true }));
    const r = await agentLandedCheckTool(build);
    if (r.ok) expect(r.data).toMatchObject({ verdict: "landed-squashed", basis: "merge-equivalence" });
  });

  it("says not-landed with the caveat that local refs may be stale", async () => {
    m.agentWorkflowState.mockResolvedValue(state({}));
    const r = await agentLandedCheckTool(build);
    if (r.ok) {
      expect(r.data).toMatchObject({ verdict: "not-landed", aheadOfBase: 3 });
      expect(r.data.caveat).toMatch(/fetch/i);
    }
  });

  it("says UNKNOWN rather than guessing when the probe fails", async () => {
    m.agentWorkflowState.mockRejectedValue("git exploded");
    const r = await agentLandedCheckTool(build);
    if (r.ok) expect(r.data).toMatchObject({ verdict: "unknown" });
  });

  it("never answers the SHIPPED question, even when the state carries a shipped flag", async () => {
    m.agentWorkflowState.mockResolvedValue(state({ inOriginMain: true, shipped: true }));
    const r = await agentLandedCheckTool(build);
    if (r.ok) expect(JSON.stringify(r.data)).not.toMatch(/shipped/i);
  });
});

describe("pr_checks_status", () => {
  it("reports that it CANNOT supply a step count, so red is not proof of a test failure", async () => {
    m.fetchOpenPrs.mockResolvedValue([
      {
        number: 7,
        title: "t",
        headRefName: "h",
        url: "u",
        checks: "failing" as const,
        mergeable: "unknown" as const,
      },
    ]);
    const r = await prChecksStatusTool("/repo", 7);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.stepsExecuted).toBeNull();
      expect(r.data.stepCountAvailable).toBe(false);
      expect(r.data.ambiguity).toMatch(/zero steps|infrastructure|unavailable/i);
    }
  });

  it("has no ambiguity note when the checks are green", async () => {
    m.fetchOpenPrs.mockResolvedValue([
      {
        number: 7,
        title: "t",
        headRefName: "h",
        url: "u",
        checks: "passing" as const,
        mergeable: "mergeable" as const,
      },
    ]);
    const r = await prChecksStatusTool("/repo", 7);
    if (r.ok) expect(r.data.ambiguity).toBeNull();
  });

  it("fails honestly when the probe cannot answer", async () => {
    m.fetchOpenPrs.mockResolvedValue(null);
    expect(await prChecksStatusTool("/repo", 7)).toMatchObject({ kind: "failed", code: "probe-failed" });
  });
});

describe("read-only passthroughs", () => {
  it("returns branch status", async () => {
    m.agentBranchStatus.mockResolvedValue({ ahead: 1, behind: 0, dirty: false, filesChanged: 0, insertions: 0, deletions: 0 });
    const r = await agentBranchStatusTool(build);
    expect(r).toMatchObject({ ok: true, risk: "read-only" });
    expect(m.agentBranchStatus).toHaveBeenCalledWith("/repo", "p1", "a1", "main");
  });

  it("returns workflow state, passing the worker's parent branch through", async () => {
    m.agentWorkflowState.mockResolvedValue({ inLocalMain: false, inOriginMain: false, inParent: false, aheadOfBase: 0, prState: null, prNumber: null, prUrl: null });
    await agentWorkflowStateTool(worker, { probeGitHub: true });
    expect(m.agentWorkflowState).toHaveBeenCalledWith("/repo", "w1", "sparkle/agent-a1", true);
  });

  it("returns the project roster status", async () => {
    m.projectAgentsStatus.mockResolvedValue([]);
    const r = await projectAgentsStatusTool("/repo", "p1", [], false);
    expect(r).toMatchObject({ ok: true, op: "project_agents_status" });
  });

  it("tells 'no open PRs' apart from 'could not look'", async () => {
    m.fetchOpenPrs.mockResolvedValue([]);
    const empty = await projectOpenPrsTool("/repo");
    expect(empty).toMatchObject({ ok: true });
    if (empty.ok) expect(empty.data.prs).toEqual([]);

    m.fetchOpenPrs.mockResolvedValue(null);
    expect(await projectOpenPrsTool("/repo")).toMatchObject({ kind: "failed", code: "probe-failed" });
  });

  it("surfaces an unexpected read failure as a typed result instead of throwing", async () => {
    m.agentBranchStatus.mockRejectedValue("boom");
    const r = await agentBranchStatusTool(build);
    expect(r).toMatchObject({ ok: false, kind: "failed", code: "unknown-error" });
  });
});

// ---------------------------------------------------------------------------------------------

describe("the PR probe's scope is stated, not implied", () => {
  const row = {
    number: 7,
    title: "t",
    headRefName: "h",
    url: "u",
    checks: "passing" as const,
    mergeable: "mergeable" as const,
  };

  // `fetchOpenPrs` is `gh pr list --author @me --limit 100`. Presenting it as "the repo's open PRs"
  // makes the concierge say "no PRs are waiting" for a repo full of other people's PRs.
  it("says whose PRs, and how many, the list actually covers", async () => {
    m.fetchOpenPrs.mockResolvedValue([]);
    const r = await projectOpenPrsTool("/repo");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.scope).toMatch(/authored|@me/i);
    if (r.ok) expect(r.data.scope).toMatch(/100/);
  });

  it("does not call someone else's open PR 'merged or closed'", async () => {
    m.fetchOpenPrs.mockResolvedValue([{ ...row, number: 9 }]);
    const merge = await mergePrTool({ root: "/repo", number: 7 });
    expect(merge).toMatchObject({ kind: "refused", code: "pr-not-found" });
    if (!merge.ok) expect(merge.message).toMatch(/authored|@me/i);

    const checks = await prChecksStatusTool("/repo", 7);
    expect(checks).toMatchObject({ code: "pr-not-found" });
    if (!checks.ok) expect(checks.message).toMatch(/authored|@me/i);
  });

  it("still describes each tool the model sees", () => {
    const described = describeWorkflowTools();
    const prs = described.find((d) => d.op === "project_open_prs");
    expect(prs?.summary).toMatch(/authored|@me/i);
  });
});

describe("a model-supplied root is checked against the projects the human added", () => {
  // Agent-scoped operations take their root from a vetted context. These four take a bare `root`,
  // and `mergePrTool`'s own comment says the request came off the wire — so an unvetted path would
  // run `gh pr merge` (a mutates-main action) in a repo the human never named.
  const foreign = "/tmp/somebody-elses-repo";

  it("refuses merge_pr against an unregistered root, without touching gh", async () => {
    const r = await mergePrTool({ root: foreign, number: 7 });
    expect(r).toMatchObject({ ok: false, kind: "refused", code: "invalid-request" });
    expect(m.fetchOpenPrs).not.toHaveBeenCalled();
    expect(m.mergePr).not.toHaveBeenCalled();
  });

  it("refuses the read-only probes against an unregistered root too", async () => {
    expect(await projectOpenPrsTool(foreign)).toMatchObject({ ok: false, code: "invalid-request" });
    expect(await prChecksStatusTool(foreign, 7)).toMatchObject({ ok: false, code: "invalid-request" });
    expect(await projectAgentsStatusTool(foreign, "p1", [], false)).toMatchObject({
      ok: false,
      code: "invalid-request",
    });
    expect(m.fetchOpenPrs).not.toHaveBeenCalled();
    expect(m.projectAgentsStatus).not.toHaveBeenCalled();
  });

  it("accepts a registered root, trailing slash and all", async () => {
    m.fetchOpenPrs.mockResolvedValue([]);
    expect(await projectOpenPrsTool("/repo/")).toMatchObject({ ok: true });
  });

  it("refuses everything when the project list cannot be read — fails CLOSED", async () => {
    m.projects.length = 0;
    expect(await mergePrTool({ root: "/repo", number: 7 })).toMatchObject({
      ok: false,
      code: "invalid-request",
    });
    expect(m.mergePr).not.toHaveBeenCalled();
  });
});

describe("the busy gate covers every LIVE status, not just 'working'", () => {
  // waiting / approval / blocked all mean a live PTY mid-turn with a possibly half-written worktree.
  // The module's own rationale ("acting on a half-written tree") applies to all of them, and unlike
  // a human clicking Land, a model cannot see the state it is acting on.
  const LIVE = ["working", "waiting", "approval", "blocked"];
  const NOT_LIVE = ["idle", "done", "stopped", "errored", "unmerged"];

  it.each(LIVE)("refuses to rebase, land or delete under a %s agent", async (status) => {
    m.statuses["a1"] = status;
    expect(await refreshAgentBranchTool(build)).toMatchObject({ ok: false, code: "agent-working" });
    expect(await landAgentBranchTool(build)).toMatchObject({ ok: false, code: "agent-working" });
    expect(await deleteAgentBranchTool(build)).toMatchObject({ ok: false, code: "agent-working" });
    expect(await deleteAgentBranchIfMergedTool(build)).toMatchObject({ ok: false, code: "agent-working" });
    expect(m.refreshAgentBranch).not.toHaveBeenCalled();
    expect(m.landAgentBranch).not.toHaveBeenCalled();
    expect(m.deleteAgentBranch).not.toHaveBeenCalled();
  });

  it.each(NOT_LIVE)("lets the work through for a %s agent", async (status) => {
    m.statuses["a1"] = status;
    m.deleteAgentBranch.mockResolvedValue("deleted");
    expect(await deleteAgentBranchTool(build)).toMatchObject({ ok: true });
  });

  it("refuses to land into an orchestrator branch whose agent is waiting on the human", async () => {
    m.statuses["a1"] = "waiting"; // the PARENT, mid-turn
    m.landAgentBranch.mockResolvedValue({ ok: false, reason: "busy", files: [] });
    expect(await landAgentBranchTool(worker)).toMatchObject({ ok: false, code: "target-busy" });
    expect(m.landAgentBranch).toHaveBeenCalledWith("/repo", "w1", "sparkle/agent-a1", true);
  });
});

describe("agent_landed_check knows a worker's integration target", () => {
  const state = (over: Record<string, unknown>) => ({
    inLocalMain: false,
    inOriginMain: false,
    inParent: false,
    aheadOfBase: 3,
    prState: null,
    prNumber: null,
    prUrl: null,
    ...over,
  });

  // A worker lands into its ORCHESTRATOR's branch (resolveLandTarget), so work contained there is
  // landed on its target. Calling it "not-landed, 3 ahead" is the at-risk signal that pushes the
  // concierge to land work that is already integrated.
  it("counts containment in the orchestrator branch as landed, with the caveat that says where", async () => {
    m.agentWorkflowState.mockResolvedValue(state({ inParent: true }));
    const r = await agentLandedCheckTool(worker);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toMatchObject({ verdict: "landed", where: "parent-branch", basis: "ancestry" });
      expect(r.data.caveat).toMatch(/default branch/i);
    }
    expect(m.agentWorkflowState).toHaveBeenCalledWith("/repo", "w1", "sparkle/agent-a1", false);
  });

  it("prefers the default branch when the work reached BOTH", async () => {
    m.agentWorkflowState.mockResolvedValue(state({ inParent: true, inOriginMain: true }));
    const r = await agentLandedCheckTool(worker);
    if (r.ok) expect(r.data).toMatchObject({ verdict: "landed", where: "origin-default" });
  });

  it("ignores inParent for a build agent, which has no orchestrator to land into", async () => {
    m.agentWorkflowState.mockResolvedValue(state({ inParent: true }));
    const r = await agentLandedCheckTool(build);
    if (r.ok) expect(r.data).toMatchObject({ verdict: "not-landed" });
  });

  it("still says not-landed for a worker whose work is in neither", async () => {
    m.agentWorkflowState.mockResolvedValue(state({}));
    const r = await agentLandedCheckTool(worker);
    if (r.ok) expect(r.data).toMatchObject({ verdict: "not-landed", aheadOfBase: 3 });
  });
});
