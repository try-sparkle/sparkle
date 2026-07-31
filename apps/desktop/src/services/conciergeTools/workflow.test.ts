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
  fetchPrOwner: vi.fn(),
  mergePr: vi.fn(),
  fetchRoborevProbe: vi.fn(),
  fetchRoborevReview: vi.fn(),
  fetchPrClaims: vi.fn(),
  statuses: {} as Record<string, string>,
  projects: [] as Array<{ rootPath: string; agents?: Array<{ id: string; name: string }> }>,
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
  return {
    ...actual,
    fetchOpenPrs: m.fetchOpenPrs,
    fetchPrOwner: m.fetchPrOwner,
    mergePr: m.mergePr,
  };
});

// Only the two PROBES are mocked. `summarizeRoborev` / `roborevMergeGate` / `findClaim` /
// `viewClaim` are the REAL implementations, deliberately: the merge gate's whole job is to reach
// the same verdict as the read op, and stubbing the verdict would test the stub. What varies per
// test is what the backend answered, which is exactly what these two probes carry.
vi.mock("../mergeGuard/roborev", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mergeGuard/roborev")>();
  return { ...actual, fetchRoborevProbe: m.fetchRoborevProbe, fetchRoborevReview: m.fetchRoborevReview };
});

vi.mock("../mergeGuard/prClaims", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mergeGuard/prClaims")>();
  return { ...actual, fetchPrClaims: m.fetchPrClaims };
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

import { PR_CLAIM_GRACE_SECONDS } from "../mergeGuard/types";
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
  prOwnerTool,
  prChecksStatusTool,
  prRoborevStatusTool,
  agentLandedCheckTool,
  type AgentWorkflowContext,
  type WorkflowOperation,
} from "./workflow";
import {
  forgetAgent,
  noteHooksDead,
  noteHooksLive,
  noteProcessExit,
  noteSpinnerSeen,
  resetTurnEndAuthority,
  trackAgent,
} from "../../engine/turnEndAuthority";

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
  m.projects.push({ rootPath: "/repo", agents: [] });
  // Default the two new gates to "answered, and nothing is in the way", so every pre-existing
  // merge_pr expectation still describes a CI-only decision. Each new gate's own tests override.
  m.fetchRoborevProbe.mockResolvedValue({ enabled: true, jobs: [] });
  m.fetchPrClaims.mockResolvedValue([]);
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

describe("the busy gate reads a GUESSED idle as still-live", () => {
  // roborev on 95013a2f1. The gate used to prove "quiet mid-turn" from the `blocked` status, which
  // the engine produced after 25s of PTY silence. That status was removed because it doubled as a
  // false red alarm — so the gate now asks turnEndAuthority whether anything actually WITNESSED the
  // turn ending. Without a witness (no hooks, no spinner) `idle` means "quiet", and a six-minute
  // `pnpm test` looks identical to a finished turn. Landing under that is unrecoverable; refusing
  // costs one retry, so the ambiguity resolves toward live HERE and toward calm on the alarm path.
  beforeEach(() => resetTurnEndAuthority());

  it("REFUSES a destructive op on a tracked agent whose idle is only a guess", async () => {
    m.statuses["a1"] = "idle";
    trackAgent("a1"); // this window drives it, but nothing has witnessed a turn end
    const r = await refreshAgentBranchTool(build);
    expect(r).toMatchObject({ ok: false, kind: "refused", code: "agent-working" });
    expect(m.refreshAgentBranch).not.toHaveBeenCalled();
  });

  it("ALLOWS it once a witness exists and the turn really is over", async () => {
    m.statuses["a1"] = "idle";
    trackAgent("a1");
    noteHooksLive("a1"); // Claude's Stop event witnesses the end of every turn from here
    m.refreshAgentBranch.mockResolvedValue({ ok: true, ahead: 0, behind: 0 });
    const r = await refreshAgentBranchTool(build);
    expect(r).toMatchObject({ ok: true });
    expect(m.refreshAgentBranch).toHaveBeenCalled();
  });

  it("the spinner is the other witness — a settled screen-scraped turn is a fact too", async () => {
    m.statuses["a1"] = "idle";
    trackAgent("a1");
    noteSpinnerSeen("a1");
    m.refreshAgentBranch.mockResolvedValue({ ok: true, ahead: 0, behind: 0 });
    expect(await refreshAgentBranchTool(build)).toMatchObject({ ok: true });
  });

  it("ALLOWS ops on a witness-less agent whose PTY has EXITED", async () => {
    // roborev 54815 (High). `done`/`errored`/`stopped`/`unmerged` are terminal observations, not
    // guesses — StatusEngine.exit() sets them on the real exit, and a dead process cannot be writing
    // the worktree. Overriding them refused every op forever on a fallback-path agent that had
    // exited, with no escape short of closing the tab.
    for (const terminal of ["done", "stopped", "unmerged"] as const) {
      m.refreshAgentBranch.mockReset();
      m.refreshAgentBranch.mockResolvedValue({ ok: true, ahead: 0, behind: 0 });
      resetTurnEndAuthority();
      m.statuses["a1"] = terminal;
      trackAgent("a1"); // deliberately no hook / spinner witness
      expect(await refreshAgentBranchTool(build)).toMatchObject({ ok: true });
    }
  });

  it("REFUSES on `errored` without a witness — a wedged agent is still ALIVE", async () => {
    // roborev 55041. `errored` sits beside done/stopped/unmerged but is not terminal: statusEngine's
    // mid-stream failure branch sets it while the process keeps running (an API-error banner it kept
    // churning under, or a self-prompt loop), and statusRouter lifts that over the hook status. That
    // agent is still executing tools, so landing or deleting its branch writes a live worktree.
    m.statuses["a1"] = "errored";
    trackAgent("a1");
    expect(await refreshAgentBranchTool(build)).toMatchObject({ ok: false, code: "agent-working" });
    expect(m.refreshAgentBranch).not.toHaveBeenCalled();
  });

  it("…and ALLOWS `errored` once the PTY has actually exited", async () => {
    // The recoverable half: stopping the agent kills the PTY, which grants the exit witness, so the
    // refusal message's "wait for it to finish (or stop it)" is genuinely actionable.
    m.statuses["a1"] = "errored";
    trackAgent("a1");
    noteProcessExit("a1");
    m.refreshAgentBranch.mockResolvedValue({ ok: true, ahead: 0, behind: 0 });
    expect(await refreshAgentBranchTool(build)).toMatchObject({ ok: true });
  });

  it("a NEW engine does not inherit the previous process's exit witness", async () => {
    // roborev 55041. A `pty:exit` can land after the old engine's dispose ran forgetAgent, and
    // noteProcessExit used to CREATE a record — stranding `exited: true` with no owner. The next
    // engine for the same id ("Start again", or a reopened tab) then inherited it and the busy gate
    // was silently disabled for the whole new session.
    const oldEngine = { id: "old" };
    const newEngine = { id: "new" };
    trackAgent("a1", oldEngine);
    forgetAgent("a1", oldEngine);
    noteProcessExit("a1"); // the late exit event, arriving after teardown
    trackAgent("a1", newEngine); // a fresh, very much alive process
    m.statuses["a1"] = "idle";
    expect(await refreshAgentBranchTool(build)).toMatchObject({ ok: false, code: "agent-working" });
  });

  it("a late pty:exit cannot mark the NEW engine's live process as exited", async () => {
    // roborev 55076 (High). The likelier teardown ordering: React runs the cleanup (async unlisten +
    // kill + dispose→forgetAgent) and then re-runs the effect SYNCHRONOUSLY, so the new engine has
    // already re-tracked the id by the time the old PTY's exit round-trips from Rust. Being merely
    // non-creating does not help there — the record exists, owned by the new engine — so without an
    // owner check the dead process's exit marks a live one as finished and the gate stays open for
    // the whole session.
    const oldEngine = { id: "old" };
    const newEngine = { id: "new" };
    trackAgent("a1", oldEngine);
    forgetAgent("a1", oldEngine);
    trackAgent("a1", newEngine); // remount re-tracks BEFORE the old exit arrives
    noteProcessExit("a1", oldEngine); // the dead PTY's late news
    m.statuses["a1"] = "idle";
    expect(await refreshAgentBranchTool(build)).toMatchObject({ ok: false, code: "agent-working" });
  });

  it("a late spinner frame from a dead PTY cannot witness the NEW engine's turn", async () => {
    // roborev 55094: the second door. noteSpinnerSeen was creating and un-scoped, so one stray
    // `pty:data` frame from the old process granted `spinner: true` on the record trackAgent just
    // reset for the new engine — turning the live agent's GUESSED idle into a witnessed turn end and
    // opening the destructive-op gate.
    const oldEngine = { id: "old" };
    const newEngine = { id: "new" };
    trackAgent("a1", oldEngine);
    forgetAgent("a1", oldEngine);
    trackAgent("a1", newEngine);
    noteSpinnerSeen("a1", oldEngine); // the dead PTY's late frame
    m.statuses["a1"] = "idle";
    expect(await refreshAgentBranchTool(build)).toMatchObject({ ok: false, code: "agent-working" });
  });

  it("counts a PTY exit as a witness in its own right", async () => {
    m.statuses["a1"] = "idle";
    trackAgent("a1");
    noteProcessExit("a1");
    m.refreshAgentBranch.mockResolvedValue({ ok: true, ahead: 0, behind: 0 });
    expect(await refreshAgentBranchTool(build)).toMatchObject({ ok: true });
  });

  it("REFUSES again once the router declares the hook stream dead", async () => {
    // roborev 54815 (Medium). noteHooksLive used to latch permanently while statusRouter's watchdog
    // expires hook authority — so after any hook-stream death the row's statuses came from the time
    // heuristic again, but the gate still read them as witnessed.
    m.statuses["a1"] = "idle";
    trackAgent("a1");
    noteHooksLive("a1");
    noteHooksDead("a1");
    expect(await refreshAgentBranchTool(build)).toMatchObject({ ok: false, code: "agent-working" });
    expect(m.refreshAgentBranch).not.toHaveBeenCalled();
  });

  it("a STALE engine's dispose cannot untrack an agent a newer engine drives", async () => {
    // roborev 54815 (Medium). Terminal's cleanup can run AFTER a remount registered a newer engine
    // for the same id; an unguarded delete wiped the live engine's record, and the gate then fell
    // back to the status alone — a guessed idle mid-tool-call passing the busy check.
    const oldEngine = { id: "old" };
    const newEngine = { id: "new" };
    trackAgent("a1", oldEngine);
    trackAgent("a1", newEngine);
    forgetAgent("a1", oldEngine); // the late cleanup
    m.statuses["a1"] = "idle";
    expect(await refreshAgentBranchTool(build)).toMatchObject({ ok: false, code: "agent-working" });
  });

  it("does NOT refuse for an agent this window doesn't drive (pane elsewhere / closed)", async () => {
    // Answering "live" on an untracked id would refuse every operation forever — the gate must read
    // absence as "no information", not as evidence.
    m.statuses["a1"] = "idle";
    m.refreshAgentBranch.mockResolvedValue({ ok: true, ahead: 0, behind: 0 });
    expect(await refreshAgentBranchTool(build)).toMatchObject({ ok: true });
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
    expect(m.openAgentPr).toHaveBeenCalledWith("/repo", "p1", "a1", "main", "Do the thing");
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
      const r = await mergePrTool({ root: "/repo", projectId: "p1", number: 7, ...bad } as never);
      expect(r).toMatchObject({ ok: false, kind: "refused", code: "invalid-request" });
    }
    expect(m.mergePr).not.toHaveBeenCalled();
    expect(m.fetchOpenPrs).not.toHaveBeenCalled();
  });

  it("merges with a MERGE COMMIT once checks are green", async () => {
    m.fetchOpenPrs.mockResolvedValue([openPr]);
    m.mergePr.mockResolvedValue(undefined);
    const r = await mergePrTool({ root: "/repo", projectId: "p1", number: 7 });
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
      expect(await mergePrTool({ root: "/repo", projectId: "p1", number: 7 })).toMatchObject({
        kind: "refused",
        code: "checks-blocked",
      });
    }
    expect(m.mergePr).not.toHaveBeenCalled();
  });

  it("refuses to merge blind when the PR probe could not answer", async () => {
    m.fetchOpenPrs.mockResolvedValue(null);
    expect(await mergePrTool({ root: "/repo", projectId: "p1", number: 7 })).toMatchObject({
      kind: "refused",
      code: "checks-unknown",
    });

    m.fetchOpenPrs.mockResolvedValue([{ ...openPr, number: 9 }]);
    expect(await mergePrTool({ root: "/repo", projectId: "p1", number: 7 })).toMatchObject({
      kind: "refused",
      code: "pr-not-found",
    });
    expect(m.mergePr).not.toHaveBeenCalled();
  });

  it("reports gh's own refusal when the merge itself fails", async () => {
    m.fetchOpenPrs.mockResolvedValue([openPr]);
    m.mergePr.mockRejectedValue("Pull request is not mergeable: the merge commit cannot be cleanly created");
    expect(await mergePrTool({ root: "/repo", projectId: "p1", number: 7 })).toMatchObject({
      kind: "failed",
      code: "conflict",
    });

    m.mergePr.mockRejectedValue("GraphQL: Required status checks have not passed");
    expect(await mergePrTool({ root: "/repo", projectId: "p1", number: 7 })).toMatchObject({
      kind: "failed",
      code: "checks-blocked",
    });
  });
});

/**
 * THE #806 REGRESSION SUITE.
 *
 * Every test here sets up the state the concierge actually saw on 2026-07-29 — a PR with green
 * checks and a clean mergeable state — and asserts that it is nevertheless NOT merged. The CI gate
 * was never wrong; it was answering a narrower question than this project's definition of "clean".
 */
describe("merge_pr honours roborev, not just CI", () => {
  const openPr = {
    number: 806,
    title: "a build column and terminal on the LEFT of the concierge",
    headRefName: "sparkle/left-pair",
    url: "https://github.com/drodio/sparkle/pull/806",
    // EXACTLY the state that produced the incident: green, mergeable, ready by every GitHub signal.
    checks: "passing" as const,
    mergeable: "mergeable" as const,
  };

  function roborevJob(over: Record<string, unknown> = {}) {
    return {
      id: 55235,
      branch: "sparkle/left-pair",
      gitRef: "2ead6070",
      status: "done",
      verdict: "F",
      closed: false,
      commitSubject: "fix(theme): the quote inside ${…} is the signal",
      finishedAt: null,
      ...over,
    };
  }

  beforeEach(() => {
    m.fetchOpenPrs.mockResolvedValue([openPr]);
    m.mergePr.mockResolvedValue(undefined);
  });

  it("REFUSES while a roborev round is still in flight, over 18 green checks", async () => {
    // The literal incident: the agent said "one review still running"; the concierge merged anyway.
    m.fetchRoborevProbe.mockResolvedValue({
      enabled: true,
      jobs: [roborevJob({ status: "running", verdict: null })],
    });
    const r = await mergePrTool({ root: "/repo", projectId: "p1", number: 806 });
    expect(r).toMatchObject({ ok: false, kind: "refused", code: "roborev-pending" });
    expect(m.mergePr).not.toHaveBeenCalled();
    // The project id must REACH the probe, positionally. Adding `projectId` to the request only to
    // satisfy the type proves nothing — the mock ignores its arguments, so the test would pass
    // whether the id is forwarded, dropped, or transposed with the root (both are strings, so a
    // transposition compiles). A mis-scoped probe silently loses every owner.
    expect(m.fetchOpenPrs).toHaveBeenCalledWith("/repo", "p1");
    // It must SAY so, and name what to do — a refusal without a remedy just gets retried verbatim.
    expect((r as { message: string }).message).toMatch(/in flight/i);
    expect((r as { message: string }).message).toContain("sparkle/left-pair");
  });

  it("REFUSES over open FAIL-verdict reviews nobody has read", async () => {
    m.fetchRoborevProbe.mockResolvedValue({
      enabled: true,
      jobs: [roborevJob({ id: 55234 }), roborevJob({ id: 55235 })],
    });
    const r = await mergePrTool({ root: "/repo", projectId: "p1", number: 806 });
    expect(r).toMatchObject({ ok: false, kind: "refused", code: "roborev-unresolved" });
    expect((r as { message: string }).message).toContain("55234");
    expect(m.mergePr).not.toHaveBeenCalled();
  });

  it("REFUSES when roborev is the gate and could not be read — unknown is not clean", async () => {
    m.fetchRoborevProbe.mockResolvedValue({ enabled: true, jobs: null, error: "daemon down" });
    expect(await mergePrTool({ root: "/repo", projectId: "p1", number: 806 })).toMatchObject({
      ok: false,
      code: "roborev-unknown",
    });
    expect(m.mergePr).not.toHaveBeenCalled();
  });

  it("MERGES when roborev is not in play on this machine — the gate is a no-op, not a deadlock", async () => {
    m.fetchRoborevProbe.mockResolvedValue({ enabled: false, jobs: null });
    expect(await mergePrTool({ root: "/repo", projectId: "p1", number: 806 })).toMatchObject({ ok: true });
    expect(m.mergePr).toHaveBeenCalledWith("/repo", 806);
  });

  it("MERGES when a closed FAIL is all that is left — roborev close is somebody's judgement", async () => {
    m.fetchRoborevProbe.mockResolvedValue({ enabled: true, jobs: [roborevJob({ closed: true })] });
    expect(await mergePrTool({ root: "/repo", projectId: "p1", number: 806 })).toMatchObject({ ok: true });
    expect(m.mergePr).toHaveBeenCalled();
  });

  it("probes the PR's OWN head branch, not the agent-branch convention", async () => {
    // #806's branch was `sparkle/left-pair` — no agent id in it — which is the other half of why
    // nobody could tell who owned it. The gate must follow the PR, not a naming guess.
    m.fetchRoborevProbe.mockResolvedValue({ enabled: true, jobs: [] });
    await mergePrTool({ root: "/repo", projectId: "p1", number: 806 });
    expect(m.fetchRoborevProbe).toHaveBeenCalledWith("/repo", "sparkle/left-pair");
  });

  describe("the acknowledgement escape hatch is narrow by construction", () => {
    beforeEach(() => {
      m.fetchRoborevProbe.mockResolvedValue({
        enabled: true,
        jobs: [roborevJob({ id: 55234 }), roborevJob({ id: 55235 })],
      });
    });

    it("merges only when the caller named EVERY open finding", async () => {
      const r = await mergePrTool({
        root: "/repo",
        projectId: "p1",
        number: 806,
        roborevOverride: { acknowledgedJobIds: [55234, 55235], reason: "both are style nits I closed by hand" },
      });
      expect(r).toMatchObject({ ok: true });
      expect(m.mergePr).toHaveBeenCalled();
    });

    it("a PARTIAL acknowledgement still refuses, naming what is left", async () => {
      const r = await mergePrTool({
        root: "/repo",
        projectId: "p1",
        number: 806,
        roborevOverride: { acknowledgedJobIds: [55234], reason: "read one of them" },
      });
      expect(r).toMatchObject({ ok: false, code: "roborev-unresolved" });
      expect((r as { message: string }).message).toContain("55235");
      expect(m.mergePr).not.toHaveBeenCalled();
    });

    it("CANNOT waive a round that is still in flight, even when it names that job", async () => {
      // The distinguishing property of the whole design: there is no verdict yet to waive.
      m.fetchRoborevProbe.mockResolvedValue({
        enabled: true,
        jobs: [roborevJob({ id: 55235, status: "running", verdict: null })],
      });
      const r = await mergePrTool({
        root: "/repo",
        projectId: "p1",
        number: 806,
        roborevOverride: { acknowledgedJobIds: [55235], reason: "I am sure it will pass" },
      });
      expect(r).toMatchObject({ ok: false, code: "roborev-pending" });
      expect(m.mergePr).not.toHaveBeenCalled();
    });

    it("rejects a BOOLEAN override — waiving means naming the ids you read", async () => {
      const r = await mergePrTool({
        root: "/repo",
        projectId: "p1",
        number: 806,
        roborevOverride: true,
      } as never);
      expect(r).toMatchObject({ ok: false, code: "invalid-request" });
      expect(m.mergePr).not.toHaveBeenCalled();
    });

    it("rejects an override with no stated reason", async () => {
      const r = await mergePrTool({
        root: "/repo",
        projectId: "p1",
        number: 806,
        roborevOverride: { acknowledgedJobIds: [55234, 55235], reason: "  " },
      } as never);
      expect(r).toMatchObject({ ok: false, code: "invalid-request" });
      expect(m.mergePr).not.toHaveBeenCalled();
    });
  });
});

describe("pr_roborev_status — the read op the concierge never had", () => {
  const openPr = {
    number: 806,
    title: "t",
    headRefName: "sparkle/left-pair",
    url: "u",
    checks: "passing" as const,
    mergeable: "mergeable" as const,
  };
  function job(over: Record<string, unknown> = {}) {
    return {
      id: 1,
      branch: "sparkle/left-pair",
      gitRef: "abc",
      status: "done",
      verdict: "F",
      closed: false,
      commitSubject: "s",
      finishedAt: null,
      ...over,
    };
  }

  beforeEach(() => {
    m.fetchOpenPrs.mockResolvedValue([openPr]);
    m.fetchPrClaims.mockResolvedValue([]);
    m.fetchRoborevProbe.mockResolvedValue({ enabled: true, jobs: [] });
    m.fetchRoborevReview.mockResolvedValue("## Review Findings\n- **Severity**: High\n- **Problem**: x");
  });

  it("forwards the project id and probes the PR's OWN branch", async () => {
    await prRoborevStatusTool("/repo", "p1", 806);
    expect(m.fetchOpenPrs).toHaveBeenCalledWith("/repo", "p1");
    expect(m.fetchRoborevProbe).toHaveBeenCalledWith("/repo", "sparkle/left-pair");
  });

  it("canonicalizes the root, so a trailing slash cannot report a clean branch", async () => {
    await prRoborevStatusTool("/repo/", "p1", 806);
    expect(m.fetchRoborevProbe).toHaveBeenCalledWith("/repo", "sparkle/left-pair");
  });

  it("an unreadable PR probe is probe-failed, never a clean read", async () => {
    m.fetchOpenPrs.mockResolvedValue(null);
    expect(await prRoborevStatusTool("/repo", "p1", 806)).toMatchObject({
      ok: false,
      code: "probe-failed",
    });
  });

  it("says pr-not-found rather than inventing an answer", async () => {
    m.fetchOpenPrs.mockResolvedValue([{ ...openPr, number: 9 }]);
    expect(await prRoborevStatusTool("/repo", "p1", 806)).toMatchObject({ code: "pr-not-found" });
  });

  it("AGREES with merge_pr about what clean means — the promise in its docstring", async () => {
    m.fetchRoborevProbe.mockResolvedValue({ enabled: true, jobs: [job({ status: "running", verdict: null })] });
    const status = await prRoborevStatusTool("/repo", "p1", 806);
    expect(status).toMatchObject({ ok: true });
    const data = (status as { data: { wouldBlockMerge: boolean; roundInFlight: boolean } }).data;
    expect(data.wouldBlockMerge).toBe(true);
    expect(data.roundInFlight).toBe(true);
    // …and the merge path refuses on the same state.
    expect(await mergePrTool({ root: "/repo", projectId: "p1", number: 806 })).toMatchObject({
      code: "roborev-pending",
    });
  });

  it("an UNREADABLE review body reports severity 'unknown', not null", async () => {
    // `null` is documented as "nothing to rank". A body we could not fetch reported as null reads
    // to a model as "open reviews, nothing serious" — the exact null-is-benign conflation this
    // module exists to kill, in the field most likely to be summarized on.
    m.fetchRoborevProbe.mockResolvedValue({ enabled: true, jobs: [job()] });
    m.fetchRoborevReview.mockResolvedValue(null);
    const r = await prRoborevStatusTool("/repo", "p1", 806);
    const data = (r as { data: { highestSeverity: string | null; outstanding: Array<{ findings: unknown }> } }).data;
    expect(data.outstanding[0]!.findings).toBeNull();
    expect(data.highestSeverity).toBe("unknown");
  });

  it("caps the reviews it opens, newest first, and SAYS how many it left", async () => {
    const jobs = [1, 2, 3, 4, 5, 6].map((id) => job({ id }));
    m.fetchRoborevProbe.mockResolvedValue({ enabled: true, jobs });
    const r = await prRoborevStatusTool("/repo", "p1", 806);
    const data = (r as { data: { outstanding: Array<{ job: { id: number } }>; truncated: number } }).data;
    expect(data.outstanding.map((o) => o.job.id)).toEqual([6, 5, 4, 3, 2]);
    expect(data.truncated).toBe(1);
  });

  it("reports a clean branch as clean", async () => {
    const r = await prRoborevStatusTool("/repo", "p1", 806);
    const data = (r as { data: { wouldBlockMerge: boolean; known: boolean } }).data;
    expect(data.wouldBlockMerge).toBe(false);
    expect(data.known).toBe(true);
  });

  it("carries a REAL claim through — who holds it, and whether it blocks", async () => {
    // `expect(claim).not.toBeNull()` was vacuous: `viewClaim(null, …)` is itself a non-null wrapper,
    // so it passed with an empty registry. Assert the fields a reader acts on.
    m.projects.length = 0;
    m.projects.push({ rootPath: "/repo", agents: [{ id: "a1", name: "Left Pair" }] });
    m.fetchPrClaims.mockResolvedValue([
      {
        root: "/repo",
        number: 806,
        agentId: "a1",
        note: "roborev round 12",
        claimedAtMs: Date.now() - 1000,
        expiresAtMs: Date.now() + 600_000,
      },
    ]);
    const r = await prRoborevStatusTool("/repo", "p1", 806);
    const claim = (r as { data: { claim: { claim: { agentId: string }; blocks: boolean } | null } }).data.claim;
    expect(claim).not.toBeNull();
    expect(claim!.claim.agentId).toBe("a1");
    expect(claim!.blocks).toBe(true);
  });

  it("an UNREADABLE claim registry reports null, not an unclaimed PR", async () => {
    m.fetchPrClaims.mockResolvedValue(null);
    const r = await prRoborevStatusTool("/repo", "p1", 806);
    expect((r as { data: { claim: unknown } }).data.claim).toBeNull();
  });
});

describe("merge_pr defers to an agent that claimed the PR", () => {
  const openPr = {
    number: 806,
    title: "t",
    headRefName: "sparkle/left-pair",
    url: "u",
    checks: "passing" as const,
    mergeable: "mergeable" as const,
  };
  const NOW = Date.now();

  function claim(over: Record<string, unknown> = {}) {
    return {
      root: "/repo",
      number: 806,
      agentId: "a1",
      note: "roborev round 12 is still running; I will land it",
      claimedAtMs: NOW - 60_000,
      expiresAtMs: NOW + 600_000,
      ...over,
    };
  }

  beforeEach(() => {
    m.fetchOpenPrs.mockResolvedValue([openPr]);
    m.mergePr.mockResolvedValue(undefined);
    m.fetchRoborevProbe.mockResolvedValue({ enabled: true, jobs: [] });
    m.projects.length = 0;
    m.projects.push({ rootPath: "/repo", agents: [{ id: "a1", name: "Left Pair" }] });
  });

  it("REFUSES when a live agent said it would land this itself", async () => {
    m.fetchPrClaims.mockResolvedValue([claim()]);
    const r = await mergePrTool({ root: "/repo", projectId: "p1", number: 806 });
    expect(r).toMatchObject({ ok: false, kind: "refused", code: "pr-claimed" });
    // Name the agent and quote its reason — "someone else owns this" is only actionable with a who.
    expect((r as { message: string }).message).toContain("Left Pair");
    expect((r as { message: string }).message).toContain("roborev round 12");
    expect(m.mergePr).not.toHaveBeenCalled();
  });

  it("a merely LAPSED claim still refuses — a live agent mid-turn cannot renew", async () => {
    // Past its TTL, but the claimant is still on the roster. Merging here is #806 on a timer: the
    // owner of #806 spent one turn draining eleven roborev rounds, issuing no tool calls the whole
    // time, which is exactly the window in which its claim would have lapsed.
    m.fetchPrClaims.mockResolvedValue([claim({ expiresAtMs: NOW - 1 })]);
    expect(await mergePrTool({ root: "/repo", projectId: "p1", number: 806 })).toMatchObject({
      ok: false,
      code: "pr-claimed",
    });
    expect(m.mergePr).not.toHaveBeenCalled();
  });

  it("merges once the claim is past the GRACE CEILING — a claim cannot wedge a PR forever", async () => {
    m.fetchPrClaims.mockResolvedValue([
      claim({ expiresAtMs: NOW - PR_CLAIM_GRACE_SECONDS * 1000 - 1 }),
    ]);
    expect(await mergePrTool({ root: "/repo", projectId: "p1", number: 806 })).toMatchObject({ ok: true });
    expect(m.mergePr).toHaveBeenCalled();
  });

  it("merges when the claiming agent is GONE — a dead agent's claim is not a veto", async () => {
    m.projects.length = 0;
    m.projects.push({ rootPath: "/repo", agents: [] }); // the claimant left the roster
    m.fetchPrClaims.mockResolvedValue([claim()]);
    expect(await mergePrTool({ root: "/repo", projectId: "p1", number: 806 })).toMatchObject({ ok: true });
    expect(m.mergePr).toHaveBeenCalled();
  });

  it("ignores a live claim on a DIFFERENT PR", async () => {
    m.fetchPrClaims.mockResolvedValue([claim({ number: 805 })]);
    expect(await mergePrTool({ root: "/repo", projectId: "p1", number: 806 })).toMatchObject({ ok: true });
  });

  it("refuses when the ROSTER could not be read — an unknown claimant is not a dead one", async () => {
    // The fail-closed contract. A half-rehydrated project record (no `agents` array) used to make
    // every claimant read as gone, so the claim stopped blocking — #806 reached through the very
    // guard added to prevent it.
    m.fetchPrClaims.mockResolvedValue([claim()]);
    m.projects.length = 0;
    m.projects.push({ rootPath: "/repo" }); // `agents` missing entirely
    expect(await mergePrTool({ root: "/repo", projectId: "p1", number: 806 })).toMatchObject({
      ok: false,
      code: "pr-claimed",
    });
    expect(m.mergePr).not.toHaveBeenCalled();
  });

  it("still refuses when a claim was written with a trailing separator", async () => {
    // Admission tolerates `/repo/`; the claim reader matches by exact string. Without one canonical
    // spelling the claim silently does not exist and the gate reports clean.
    m.fetchPrClaims.mockResolvedValue([claim({ root: "/repo/" })]);
    expect(await mergePrTool({ root: "/repo/", projectId: "p1", number: 806 })).toMatchObject({ code: "pr-claimed" });
    expect(m.mergePr).not.toHaveBeenCalled();
  });

  it("refuses when the claim registry could not be read — unreadable is not unclaimed", async () => {
    m.fetchPrClaims.mockResolvedValue(null);
    expect(await mergePrTool({ root: "/repo", projectId: "p1", number: 806 })).toMatchObject({
      ok: false,
      code: "checks-unknown",
    });
    expect(m.mergePr).not.toHaveBeenCalled();
  });

  it("checks the CLAIM BEFORE roborev — 'go ask the owner' beats an inventory of findings", async () => {
    m.fetchPrClaims.mockResolvedValue([claim()]);
    m.fetchRoborevProbe.mockResolvedValue({ enabled: true, jobs: null });
    expect(await mergePrTool({ root: "/repo", projectId: "p1", number: 806 })).toMatchObject({ code: "pr-claimed" });
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
    expect(m.agentWorkflowState).toHaveBeenCalledWith("/repo", "a1", "", false, "p1");
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
    const r = await prChecksStatusTool("/repo", "p1", 7);
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
    const r = await prChecksStatusTool("/repo", "p1", 7);
    if (r.ok) expect(r.data.ambiguity).toBeNull();
  });

  it("fails honestly when the probe cannot answer", async () => {
    m.fetchOpenPrs.mockResolvedValue(null);
    expect(await prChecksStatusTool("/repo", "p1", 7)).toMatchObject({ kind: "failed", code: "probe-failed" });
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
    expect(m.agentWorkflowState).toHaveBeenCalledWith("/repo", "w1", "sparkle/agent-a1", true, "p1");
  });

  it("returns the project roster status", async () => {
    m.projectAgentsStatus.mockResolvedValue([]);
    const r = await projectAgentsStatusTool("/repo", "p1", [], false);
    expect(r).toMatchObject({ ok: true, op: "project_agents_status" });
  });

  it("tells 'no open PRs' apart from 'could not look'", async () => {
    m.fetchOpenPrs.mockResolvedValue([]);
    const empty = await projectOpenPrsTool("/repo", "p1");
    expect(empty).toMatchObject({ ok: true });
    if (empty.ok) expect(empty.data.prs).toEqual([]);

    m.fetchOpenPrs.mockResolvedValue(null);
    expect(await projectOpenPrsTool("/repo", "p1")).toMatchObject({ kind: "failed", code: "probe-failed" });
  });

  it("surfaces an unexpected read failure as a typed result instead of throwing", async () => {
    m.agentBranchStatus.mockRejectedValue("boom");
    const r = await agentBranchStatusTool(build);
    expect(r).toMatchObject({ ok: false, kind: "failed", code: "unknown-error" });
  });
});

// The concierge must attach the OWNING AGENT to every PR it names, so the human can click through
// instead of decoding a bare "#806". These cover the two halves of that contract: the id has to
// reach the model, and an unknown owner has to stay unknown.
describe("PR ownership reaches the model, and null stays null", () => {
  /** A path the human never added as a project — the root guard must reject it before any probe. */
  const unregistered = "/tmp/somebody-elses-repo";
  const row = (over: Record<string, unknown>) => ({
    number: 806,
    title: "the cockpit work",
    headRefName: "sparkle/left-pair",
    url: "https://github.com/o/r/pull/806",
    checks: "passing" as const,
    mergeable: "mergeable" as const,
    ...over,
  });

  it("passes the project id to the probe and carries agentId through for a descriptive branch", async () => {
    // `sparkle/left-pair` has no agent id to parse. Before the durable mapping the concierge could
    // only say "owner unresolved" for exactly the PRs most worth clicking into.
    m.fetchOpenPrs.mockResolvedValue([row({ agentId: "cockpit", agentIdSource: "created" })]);
    const r = await projectOpenPrsTool("/repo", "p1");
    // The lookup is per-project; a probe called without it silently loses every owner.
    expect(m.fetchOpenPrs).toHaveBeenCalledWith("/repo", "p1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.prs[0]!.agentId).toBe("cockpit");
      expect(r.data.ownership).toMatch(/null .*means UNKNOWN|UNKNOWN, not/i);
    }
  });

  it("hands the model a null owner UNCHANGED, with the do-not-guess instruction attached", async () => {
    m.fetchOpenPrs.mockResolvedValue([row({ number: 802, agentId: null })]);
    const r = await projectOpenPrsTool("/repo", "p1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.prs[0]!.agentId).toBeNull();
      // The instruction is the guard: a model that fills a null in from the branch name sends the
      // human to the wrong agent, which is worse than telling them it is unresolved.
      expect(r.data.ownership).toMatch(/do not infer|Do NOT infer/i);
    }
  });

  it("pr_owner answers by number for a PR the list cannot see, and refuses a bad one", async () => {
    m.fetchPrOwner.mockResolvedValue({
      number: 806,
      agentId: "cockpit",
      source: "created",
      branch: "sparkle/left-pair",
      reason: null,
    });
    const r = await prOwnerTool("/repo", "p1", 806);
    expect(m.fetchPrOwner).toHaveBeenCalledWith("/repo", "p1", 806);
    expect(r).toMatchObject({ ok: true, data: { agentId: "cockpit", source: "created" } });

    // An unresolvable owner is a SUCCESS carrying null + a reason — not a failure. The caller has to
    // be able to say "unresolved" out loud rather than treat it as a broken probe.
    m.fetchPrOwner.mockResolvedValue({
      number: 802,
      agentId: null,
      source: null,
      branch: "sparkle/router-skip-doomed-classify",
      reason: "No ownership record for PR #802 ... do not guess an owner.",
    });
    const unknown = await prOwnerTool("/repo", "p1", 802);
    expect(unknown.ok).toBe(true);
    if (unknown.ok) {
      expect(unknown.data.agentId).toBeNull();
      expect(unknown.data.reason).toMatch(/do not guess/i);
    }

    // Guards that come BEFORE the probe: an unregistered root and a nonsense number never reach gh.
    m.fetchPrOwner.mockClear();
    expect(await prOwnerTool(unregistered, "p1", 7)).toMatchObject({ ok: false, code: "invalid-request" });
    expect(await prOwnerTool("/repo", "p1", 0)).toMatchObject({ ok: false, code: "invalid-request" });
    expect(m.fetchPrOwner).not.toHaveBeenCalled();
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
    const r = await projectOpenPrsTool("/repo", "p1");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.scope).toMatch(/authored|@me/i);
    if (r.ok) expect(r.data.scope).toMatch(/100/);
  });

  it("does not call someone else's open PR 'merged or closed'", async () => {
    m.fetchOpenPrs.mockResolvedValue([{ ...row, number: 9 }]);
    const merge = await mergePrTool({ root: "/repo", projectId: "p1", number: 7 });
    expect(merge).toMatchObject({ kind: "refused", code: "pr-not-found" });
    if (!merge.ok) expect(merge.message).toMatch(/authored|@me/i);

    const checks = await prChecksStatusTool("/repo", "p1", 7);
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
    const r = await mergePrTool({ root: foreign, projectId: "p1", number: 7 });
    expect(r).toMatchObject({ ok: false, kind: "refused", code: "invalid-request" });
    expect(m.fetchOpenPrs).not.toHaveBeenCalled();
    expect(m.mergePr).not.toHaveBeenCalled();
  });

  it("refuses the read-only probes against an unregistered root too", async () => {
    expect(await projectOpenPrsTool(foreign, "p1")).toMatchObject({ ok: false, code: "invalid-request" });
    expect(await prChecksStatusTool(foreign, "p1", 7)).toMatchObject({ ok: false, code: "invalid-request" });
    expect(await projectAgentsStatusTool(foreign, "p1", [], false)).toMatchObject({
      ok: false,
      code: "invalid-request",
    });
    expect(m.fetchOpenPrs).not.toHaveBeenCalled();
    expect(m.projectAgentsStatus).not.toHaveBeenCalled();
  });

  it("accepts a registered root, trailing slash and all", async () => {
    m.fetchOpenPrs.mockResolvedValue([]);
    expect(await projectOpenPrsTool("/repo/", "p1")).toMatchObject({ ok: true });
  });

  it("refuses everything when the project list cannot be read — fails CLOSED", async () => {
    m.projects.length = 0;
    expect(await mergePrTool({ root: "/repo", projectId: "p1", number: 7 })).toMatchObject({
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
    expect(m.agentWorkflowState).toHaveBeenCalledWith("/repo", "w1", "sparkle/agent-a1", false, "p1");
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
