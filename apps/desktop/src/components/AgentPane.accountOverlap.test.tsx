// @vitest-environment jsdom
//
// The account pick OVERLAPS the worktree-setup block instead of running serially after it.
//
// Transcript affinity made `chooseAccountForAgent` need the worktree path, so the pick moved out of
// prepare()'s parallel prelude and down past `prepareAgentWorkspace`. The move went one step too
// far: it landed at the CONSUMPTION point, below `installWorktreeGuard` → `installAgentHooks` →
// `assertWorkspaceIntegrity` → `await claudeP`. That block routinely outruns `ACCOUNT_CACHE_TTL_MS`
// (5s) — a cold `git worktree add` plus three read-modify-writes of one settings file — so the
// snapshot warmed at the top of prepare() had expired by the time the pick ran, and the pick
// re-issued the whole 4-command account load serially, plus the new one-read_dir-per-account
// `claude_session_accounts` probe, with nothing overlapping either. On a resurrection sweep that is
// added latency in exactly the place the original early pick existed to remove it.
//
// The fix STARTS the pick the instant its only input exists (right after `prepareAgentWorkspace`
// resolves) and awaits the same promise at the old site. This file pins that ordering, which is the
// only observable difference: same call, same arguments, same single ledger entry — just earlier.
//
// The assertion is deliberately made while `installWorktreeGuard` is still PENDING. Against the
// pre-fix code the pick cannot have happened yet (it is three awaits downstream of the guard), so
// this test goes red; against the fix it has already been issued.
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  /** Resolves `installWorktreeGuard`; left unresolved for the duration of a test that wants to
   *  observe what has happened while the guard is still in flight. */
  releaseGuard: null as null | (() => void),
  /** Every `chooseAccountForAgent` call's options, in order. */
  pickCalls: [] as Array<{ agentId: string; worktreePath?: string }>,
  /** How many times the accounts snapshot was warmed — the pick must JOIN that load, not add one. */
  warmCalls: 0,
}));

vi.mock("./Terminal", () => ({ Terminal: () => null }));
vi.mock("./PinnedPrompt", () => ({ PinnedPrompt: () => null }));
vi.mock("./Onboarding", () => ({ Onboarding: () => null }));
vi.mock("./TerminalDropOverlay", () => ({ TerminalDropOverlay: () => null }));
vi.mock("./TerminalDropPill", () => ({ TerminalDropPill: () => null }));
vi.mock("../services/paneReadiness", () => ({
  setPaneReady: () => {},
  setPaneFailed: () => {},
  unregisterPane: () => {},
  notePaneRelaunch: () => {},
  paneRelaunchCount: () => 0,
}));
vi.mock("../services/conciergeDispatch", () => ({
  flushPendingSends: () => Promise.resolve(),
  abandonPendingSends: () => {},
  abandonScreenHeldSends: () => {},
  recordPromptSideEffects: () => {},
}));
// The worktree seam. `installWorktreeGuard` hands back a promise this file controls, which is what
// makes "while the guard is still running" an observable moment rather than a race.
vi.mock("../services/worktree", () => ({
  prewarmProjectCaches: vi.fn(),
  warmWorktreePool: vi.fn(() => Promise.resolve()),
  prepareAgentWorkspace: vi.fn(() => Promise.resolve({ path: "/wt", branch: "b" })),
  installWorktreeGuard: vi.fn(
    () =>
      new Promise<void>((resolve) => {
        captured.releaseGuard = () => resolve();
      }),
  ),
  installAgentHooks: vi.fn(() => Promise.resolve("/log")),
  assertWorkspaceIntegrity: vi.fn(() => Promise.resolve()),
}));
// Claude preflight never resolves here: nothing downstream of the guard is under test, and a pending
// `claudeP` keeps prepare() from wandering into the bridge/spawn machinery after the guard is freed.
vi.mock("../preflight", () => ({
  checkClaude: vi.fn(() => new Promise(() => {})),
  claudeSessionInfo: vi.fn(() => new Promise(() => {})),
}));
vi.mock("../services/branchStatus", () => ({
  projectAgentsStatus: vi.fn(() => Promise.resolve([])),
  reconcileDefaultBranch: vi.fn(() => Promise.resolve("main")),
}));
vi.mock("../services/accountSelection", () => ({
  chooseAccountForAgent: vi.fn((agentId: string, opts?: { worktreePath?: string }) => {
    captured.pickCalls.push({ agentId, worktreePath: opts?.worktreePath });
    return Promise.resolve({ chosen: null, state: { accounts: [], identities: [], usage: [] } });
  }),
  loadAccountState: vi.fn(() => {
    captured.warmCalls++;
    return Promise.resolve({ accounts: [], identities: [], usage: [] });
  }),
}));

import { AgentPane } from "./AgentPane";
import type { AgentTab, Project } from "../types";

function buildAgent(): AgentTab {
  return {
    id: "a1",
    name: "Builder",
    kind: "build",
    parentId: null,
    runtime: "local",
    worktreePath: null,
    branch: null,
    baseBranch: "main",
    lastPrompt: "",
    promptHistory: [],
  } as unknown as AgentTab;
}

const project: Project = {
  id: "p1",
  name: "Proj",
  rootPath: "/proj/root",
  defaultBranch: "main",
  createdAt: "",
  agents: [buildAgent()],
  selectedAgentId: "a1",
};

beforeEach(() => {
  captured.releaseGuard = null;
  captured.pickCalls.length = 0;
  captured.warmCalls = 0;
});
afterEach(() => {
  // Free the guard so a pane torn down mid-prepare doesn't leave a promise pinned for the next test.
  captured.releaseGuard?.();
  cleanup();
});

describe("AgentPane — account selection overlaps worktree setup", () => {
  it("issues the pick while installWorktreeGuard is STILL RUNNING, not after it", async () => {
    render(<AgentPane project={project} agent={buildAgent()} visible />);

    // The guard has been entered and is pending — this is the window the pre-fix code spent with the
    // account pick not yet started, letting the warmed snapshot age out.
    await waitFor(() => expect(captured.releaseGuard).not.toBeNull());

    // SIDE EFFECT: the pick is already in flight, carrying the worktree path affinity needs.
    await waitFor(() => expect(captured.pickCalls.length).toBe(1));
    expect(captured.pickCalls[0]).toEqual({ agentId: "a1", worktreePath: "/wt" });

    // …and the guard genuinely never finished during any of that, so "already picked" cannot be an
    // artifact of the whole block racing through. Without this the test would still pass against the
    // old ordering whenever the mocked guard resolved fast enough.
    expect(captured.releaseGuard).not.toBeNull();
  });

  it("resolves the account exactly ONCE per spawn — one pick, one ledger entry", async () => {
    // The early-start must not become an early-pick-plus-a-second-pick-later. Two resolutions would
    // write two ledger lines for one spawn, the first naming an account the agent never ran under —
    // the failure mode that kept the pick from simply being hoisted back to the top of prepare().
    render(<AgentPane project={project} agent={buildAgent()} visible />);
    await waitFor(() => expect(captured.pickCalls.length).toBe(1));

    captured.releaseGuard?.();
    // Let the hooks/integrity steps settle; `checkClaude` never resolves, so prepare() parks at the
    // await just above the old pick site. A second call would have been issued by now.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(captured.pickCalls.length).toBe(1);
  });

  it("does not add a second accounts-snapshot load — the pick joins the warm one", async () => {
    // The warm at the top of prepare() and the pick below `wt` are ONE snapshot load: loadAccountState
    // de-dupes an in-flight request. AgentPane must therefore call the warm exactly once per prepare,
    // and the pick must go through `chooseAccountForAgent` (which reuses that load) rather than
    // issuing its own.
    render(<AgentPane project={project} agent={buildAgent()} visible />);
    await waitFor(() => expect(captured.pickCalls.length).toBe(1));
    expect(captured.warmCalls).toBe(1);
  });
});
