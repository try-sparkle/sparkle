// @vitest-environment jsdom
//
// AgentPane's claude spawns carry SPARKLE_INBOX_AGENT — the Stop hook's ownership proof (bead
// sparkle-ei7keg, a P0 trust bug: the founder's queued messages were consumed by a roborev reviewer
// that happened to share the agent's worktree, and the agent never saw them).
//
// WHY THIS RENDERS THE PANE INSTEAD OF UNIT-TESTING buildClaudeExec. Both facts have to hold, and
// only one of them is visible from the builder:
//
//   1. `buildClaudeExec` emits the export when it is asked to — `services/claudeSpawn.test.ts`.
//   2. The CALL SITES actually ask. That is a property of AgentPane, and a call site that forgets
//      the option is exactly the defect: it compiles, every unit test stays green, and the agent
//      silently stops receiving messages at its turn boundaries. AGENTS.md calls this the defaulted
//      seam — the production line is the one nothing drives.
//
// Both claude branches are covered because they are separate call sites with separate option
// objects: the WORKER branch and the GENERIC branch. (The build branch goes through
// assembleBuildSpawn, pinned in services/orchestrationLaunch.test.ts.)
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  /** Every Terminal mount's argv, in order. args[2] is the `zsh -l -c` exec string. */
  mounts: [] as string[][],
}));

vi.mock("./Terminal", () => ({
  Terminal: (p: { args: string[] }) => {
    captured.mounts.push(p.args);
    return null;
  },
}));
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
vi.mock("../services/worktree", () => ({
  prewarmProjectCaches: vi.fn(),
  warmWorktreePool: vi.fn(() => Promise.resolve()),
  // THESE TWO MOCKS MODEL THE REAL DERIVATION RATHER THAN RETURNING CONSTANTS, and that is what
  // makes the coupling test below able to fail. Production creates the worktree in a directory named
  // after the AgentTab.id, then calls `installAgentHooks(wt.path, …)` (AgentPane.tsx:697), and
  // `hooks.rs::event_log_path` keys the event log by that worktree's BASENAME. Returning a hardcoded
  // `/log/a1.jsonl` alongside a `/wt` worktree modelled a state production cannot produce (the real
  // basename would be `wt`), and made every "does the exported id match the hook's id" assertion a
  // comparison of two literals this file had chosen — i.e. unfalsifiable.
  // Signature mirrors production: (rootPath, projectId, agentId, agentBase) — the worktree
  // directory is named after the AGENT ID, which is the fact the whole coupling rests on.
  prepareAgentWorkspace: vi.fn((_root: string, projectId: string, agentId: string) =>
    Promise.resolve({ path: `/wt/${projectId}/${agentId}`, branch: "b" }),
  ),
  installWorktreeGuard: vi.fn(() => Promise.resolve()),
  installAgentHooks: vi.fn((wt: string) =>
    Promise.resolve(`/appdata/hook-events/${wt.slice(wt.lastIndexOf("/") + 1)}.jsonl`),
  ),
  assertWorkspaceIntegrity: vi.fn(() => Promise.resolve()),
}));
// A found claude and NO prior session, so prepare() reaches the spawn assembly on the fresh path.
vi.mock("../preflight", () => ({
  checkClaude: vi.fn(() => Promise.resolve({ installed: true, path: "/bin/claude" })),
  claudeSessionInfo: vi.fn(() => Promise.resolve({ hasSession: false, latestSessionId: null })),
}));
vi.mock("../services/branchStatus", () => ({
  projectAgentsStatus: vi.fn(() => Promise.resolve([])),
  reconcileDefaultBranch: vi.fn(() => Promise.resolve("main")),
}));
// The BUILD branch's bridge/path lookups are the only Tauri round-trips it makes before assembling
// the spawn — stub them so that branch reaches `assembleBuildSpawn`, which stays REAL (it is the
// code under test on that path). `startControlBridge`/`controlMcpPaths` are left alone: their
// `invoke` rejects under jsdom, so `control` comes out undefined — which is exactly the case that
// matters here, since the ownership proof must NOT be routed through the control wiring.
vi.mock("../services/orchestrationLaunch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/orchestrationLaunch")>()),
  startOrchestrationBridge: vi.fn(() =>
    Promise.resolve({ socketPath: "/tmp/orch.sock", token: "tok" }),
  ),
  stopOrchestrationBridge: vi.fn(() => Promise.resolve()),
  orchestratorMcpPaths: vi.fn(() =>
    Promise.resolve({ nodePath: "/bin/node", serverPath: "/res/server.js" }),
  ),
}));
vi.mock("../services/accountSelection", () => ({
  chooseAccountForAgent: vi.fn(() =>
    Promise.resolve({ chosen: null, state: { accounts: [], identities: [], usage: [] } }),
  ),
  loadAccountState: vi.fn(() => Promise.resolve({ accounts: [], identities: [], usage: [] })),
}));

import { AgentPane } from "./AgentPane";
import type { AgentTab, Project } from "../types";

function buildAgent(kind: string): AgentTab {
  return {
    id: "a1",
    name: "Agent",
    kind,
    parentId: null,
    parentBranch: "sparkle/parent",
    runtime: "local",
    worktreePath: null,
    branch: null,
    baseBranch: "main",
    task: "do the thing",
    lastPrompt: "",
    promptHistory: [],
  } as unknown as AgentTab;
}

function projectFor(agent: AgentTab): Project {
  return {
    id: "p1",
    name: "Proj",
    rootPath: "/proj/root",
    defaultBranch: "main",
    createdAt: "",
    agents: [agent],
    selectedAgentId: agent.id,
  };
}

/** Render the pane and return the exec string it hands Terminal. */
async function execFor(kind: string): Promise<string> {
  captured.mounts.length = 0;
  // CLEAR MOCK CALL HISTORY PER RENDER, or the coupling test below reads the WRONG render's calls.
  // This repo's vitest config sets no `clearMocks`/`restoreMocks` and `test-setup.ts` only registers
  // RTL cleanup, so `prepareAgentWorkspace`/`installAgentHooks` otherwise accumulate across all four
  // tests in this file. Every test here uses the same project and agent id, so the three branches
  // produce identical `/wt/p1/a1` → `/appdata/hook-events/a1.jsonl` pairs — meaning a branch that
  // stopped calling `installAgentHooks` altogether would still find a sibling branch's call in the
  // history and pass. That is the same coincidence-of-literals this file exists to stop relying on.
  // `clearAllMocks` clears CALLS, not implementations, so the derivation-modelling mocks survive.
  vi.clearAllMocks();
  const agent = buildAgent(kind);
  render(<AgentPane project={projectFor(agent)} agent={agent} visible />);
  await waitFor(() => expect(captured.mounts.length).toBeGreaterThan(0));
  return captured.mounts[0]?.[2] ?? "";
}

afterEach(() => cleanup());

describe("AgentPane — every claude spawn carries the inbox ownership proof (sparkle-ei7keg)", () => {
  it("the WORKER branch exports SPARKLE_INBOX_AGENT with this agent's id", async () => {
    const exec = await execFor("worker");
    expect(exec).toContain("export SPARKLE_INBOX_AGENT='a1'; ");
    // Prove we are on the branch we think we are — a worker is the auto-approving one.
    expect(exec).toContain("--dangerously-skip-permissions");
  });

  it("the GENERIC branch exports it too", async () => {
    const exec = await execFor("claude");
    expect(exec).toContain("export SPARKLE_INBOX_AGENT='a1'; ");
    expect(exec).not.toContain("--dangerously-skip-permissions");
  });

  it("the BUILD branch exports it too — through assembleBuildSpawn, not through `control`", async () => {
    // A third call site with its own option object. It hands the id to assembleBuildSpawn as its
    // OWN field rather than reusing `control.agentId`, because the control bridge is best-effort:
    // under jsdom its `invoke` rejects, so this render has no control wiring at all — and the
    // export must still be there. That is the whole point of not deriving it from `control`.
    const exec = await execFor("build");
    expect(exec).toContain("export SPARKLE_INBOX_AGENT='a1'; ");
    expect(exec).toContain("--strict-mcp-config"); // we really are on the build branch
    expect(exec).not.toContain("SPARKLE_AGENT_ID"); // …with the control server absent
  });

  /**
   * THE CROSS-LAYER INVARIANT: the id the pane EXPORTS must be the id the hook DERIVES.
   *
   * Two layers have to agree on one id and nothing types them together. The pane exports
   * `AgentTab.id`. The hook derives its id from the event-log path — `hooks.rs::event_log_path`
   * keys the log by the worktree BASENAME, and `sparkle-hook.mjs::inboxPaths` derives the inbox
   * from that log path. They agree only because the worktree directory is named after the agent id.
   * If that diverges, `mayDrain` compares unequal, the agent refuses to drain its OWN inbox, and
   * turn-boundary delivery stops permanently and silently — the same symptom as the P0 here.
   *
   * WHAT MAKES THIS FALSIFIABLE, because two earlier versions were not. Asserting
   * `expect(exported).toBe("a1")` compares two literals this file chose. So does deriving the
   * hook-side id from a HARDCODED `installAgentHooks` return value — that was the second attempt,
   * and it was no better: `basename("/log/a1.jsonl")` is just `"a1"` spelled differently, and
   * mutating that fixture proves nothing about production. The grip comes from the MOCKS ABOVE
   * modelling the real derivation instead: the worktree path is built from the agent id the pane
   * passes, and the log path is derived from that worktree path. The two sides are then genuinely
   * independent, and a pane that exported anything other than the worktree basename — a session id,
   * a branch name, a display name — goes red.
   *
   * STILL NOT COVERED, deliberately stated rather than implied: that the worktree directory really
   * is named after `AgentTab.id`, and that `event_log_path` really takes its basename. Both are
   * Rust and neither runs here, so this pins the TypeScript half of the chain and the mocks encode
   * the Rust half as an assumption. A Rust-side test owns that.
   */
  it("exports the id the hook derives from the worktree it was actually given", async () => {
    const exec = await execFor("worker");
    const exported = /export SPARKLE_INBOX_AGENT='([^']*)'/.exec(exec)?.[1];
    expect(exported).toBeTruthy();

    const { prepareAgentWorkspace, installAgentHooks } = await import("../services/worktree");

    // The worktree the pane prepared, and the log path it asked the hook installer for. Read from
    // the RECORDED CALL rather than re-invoking the mock: a pane that stopped calling
    // `installAgentHooks`, or called it with something other than the worktree path, must fail here
    // rather than be handed a fresh return value it never actually used.
    // `.at(-1)`, not `[0]`: with history cleared per render there is exactly one call here, and
    // reading the LAST one means this still names THIS render's call rather than an earlier test's
    // if the clearing is ever removed.
    const wtPath = (await vi.mocked(prepareAgentWorkspace).mock.results.at(-1)!.value).path as string;
    expect(vi.mocked(installAgentHooks).mock.calls.at(-1)?.[0]).toBe(wtPath);
    const logPath = (await vi.mocked(installAgentHooks).mock.results.at(-1)!.value) as string;

    const { inboxPaths, mayDrain } = await import("../../src-tauri/resources/sparkle-hook.mjs");
    // The id the HOOK will compare against, derived the way the hook derives it.
    const hookSideId = inboxPaths(logPath).agentId;

    expect(mayDrain({ SPARKLE_INBOX_AGENT: exported }, hookSideId)).toBe(true);
    // The negative half, so the assertion above cannot pass by `mayDrain` being permissive.
    expect(mayDrain({ SPARKLE_INBOX_AGENT: `${exported}-drifted` }, hookSideId)).toBe(false);
  });
});
