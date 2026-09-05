// @vitest-environment jsdom
//
// SparkleAgentPane.prepare() arg assembly (bead sparkle-4xwk.1): the spawned `claude` exec string
// must reflect the consent mode read at prepare() time — "never" gets NO --add-dir for the log dir
// and the chat-only opening prompt; "always"/"case_by_case" grant the log dir; resume skips the
// mission prompt entirely. Backend pieces (repo clone, worktree, preflight) and heavy leaf
// components are mocked so the pane renders without Tauri.
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const captured = vi.hoisted(() => ({ props: [] as Array<{ args: string[]; resuming: boolean }> }));

vi.mock("./Terminal", () => ({
  Terminal: (props: { args: string[]; resuming: boolean }) => {
    captured.props.push(props);
    return null;
  },
}));
vi.mock("./Composer", () => ({ Composer: () => null }));
vi.mock("./Onboarding", () => ({ Onboarding: () => null }));
vi.mock("./PinnedPrompt", () => ({ PinnedPrompt: () => null }));
vi.mock("./SparkleConsentBanner", () => ({ SparkleConsentBanner: () => null }));
vi.mock("../services/worktree", () => ({
  createAgentWorktree: vi.fn(() => Promise.resolve({ path: "/wt/sparkle-self", branch: "sparkle/agent-self" })),
  installWorktreeGuard: vi.fn(() => Promise.resolve()),
  installInboxDrainHooks: vi.fn(() => Promise.resolve("/app-data/hook-events/__sparkle_self__.jsonl")),
  assertWorkspaceIntegrity: vi.fn(() => Promise.resolve()),
  acquireWorktreeLease: vi.fn(() => Promise.resolve()),
  releaseWorktreeLease: vi.fn(() => Promise.resolve()),
}));
vi.mock("../preflight", () => ({
  checkClaude: vi.fn(() => Promise.resolve({ installed: true, path: "/usr/local/bin/claude" })),
  claudeHasSession: vi.fn(() => Promise.resolve(false)),
}));
// Mocked to assert the WIRING. The helper's own behaviour (worktree → tier (d) → the agent's words)
// is covered end-to-end in services/sparkleTranscript.test.ts; what was unguarded is that this pane
// calls it at all — the suite went green with both call sites deleted (roborev 55363).
vi.mock("../services/sparkleTranscript", () => ({ registerSparkleTranscript: vi.fn() }));
// The control-MCP bridge. Spread from the real module so nothing else in the pane's import graph
// loses an export; only the two calls this pane makes are stubbed. `startControlBridge` is the seam
// the paired negative below drives — a bridge that cannot start must leave the spawn exactly as it
// is today, not half-wired.
vi.mock("../services/orchestrationLaunch", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/orchestrationLaunch")>();
  return {
    ...real,
    startControlBridge: vi.fn(() =>
      Promise.resolve({ socketPath: "/tmp/sparkle-ctrl-test.sock", token: "test-token" }),
    ),
    controlMcpPaths: vi.fn(() =>
      Promise.resolve({ nodePath: "/usr/bin/node", serverPath: "/app/mcp-control/server.js" }),
    ),
  };
});
// Keep the REAL persona/prompt builders (they're what we assert on); mock only the Tauri call.
vi.mock("../services/sparkleAgent", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/sparkleAgent")>();
  return {
    ...real,
    ensureSparkleRepo: vi.fn(() =>
      Promise.resolve({ repoPath: "/app-data/", logDir: "/app-data/logs/sparkle", defaultBranch: "main" }),
    ),
  };
});

import { SparkleAgentPane } from "./SparkleAgentPane";
import { claudeHasSession } from "../preflight";
import { useSettingsStore, DEFAULT_SPARKLE_CONSENT } from "../stores/settingsStore";
// The vi.mock above spreads importOriginal, so these are the real exported constants — the
// same ones the headless mirror asserts on, so a reword cannot desynchronize the two suites.
import { GH_AUTH_ASK_USER, GH_AUTH_UNATTENDED_STOP } from "../services/sparkleAgent";
import { registerSparkleTranscript } from "../services/sparkleTranscript";
import { startControlBridge } from "../services/orchestrationLaunch";

const LOG_DIR = "/app-data/logs/sparkle";

/** Render the pane, wait for prepare() to hand the spawn to Terminal, return the exec string. */
async function spawned(): Promise<{ exec: string; resuming: boolean }> {
  render(<SparkleAgentPane visible agentId="__sparkle_self__" />);
  await waitFor(() => expect(captured.props.length).toBeGreaterThan(0));
  const props = captured.props[captured.props.length - 1]!;
  // args = ["-l", "-c", "<exec string>"] — the exec string is what claude actually runs with.
  return { exec: props.args[2] ?? "", resuming: props.resuming };
}

beforeEach(() => {
  captured.props.length = 0;
  useSettingsStore.getState().setSparkleImprovementConsent(DEFAULT_SPARKLE_CONSENT);
  (claudeHasSession as Mock).mockResolvedValue(false);
  (startControlBridge as Mock).mockResolvedValue({
    socketPath: "/tmp/sparkle-ctrl-test.sock",
    token: "test-token",
  });
});
afterEach(() => cleanup());

describe("SparkleAgentPane — spawn arg assembly per consent mode", () => {
  it("fresh session includes the mission prompt; resume does not", async () => {
    const fresh = await spawned();
    expect(fresh.resuming).toBe(false);
    expect(fresh.exec).toContain("Start your first improvement pass");

    cleanup();
    captured.props.length = 0;
    (claudeHasSession as Mock).mockResolvedValue(true);
    const resumed = await spawned();
    expect(resumed.resuming).toBe(true);
    expect(resumed.exec).toContain("--continue");
    expect(resumed.exec).not.toContain("Start your first improvement pass");
  });

  it("exports SPARKLE_INBOX_AGENT on BOTH fresh and resumed spawns (bead sparkle-ei7keg)", async () => {
    // Drives the REAL call site, not buildClaudeExec directly: the defect this guards is a call
    // site that forgets to pass the id, which a unit test of the builder cannot see. Both paths are
    // asserted because a resumed pane is the same agent with the same inbox — and reopening is the
    // common case, so an export emitted only on a fresh spawn would fail almost every time.
    const fresh = await spawned();
    expect(fresh.exec).toContain("export SPARKLE_INBOX_AGENT='__sparkle_self__'; ");

    cleanup();
    captured.props.length = 0;
    (claudeHasSession as Mock).mockResolvedValue(true);
    const resumed = await spawned();
    expect(resumed.resuming).toBe(true);
    expect(resumed.exec).toContain("export SPARKLE_INBOX_AGENT='__sparkle_self__'; ");
  });

  it('consent "never" spawns with NO --add-dir for the log dir and the chat-only prompt', async () => {
    useSettingsStore.getState().setSparkleImprovementConsent("never");
    const { exec } = await spawned();
    expect(exec).not.toContain("--add-dir");
    // The log dir must not leak in through any flag or the persona text either.
    expect(exec).not.toContain(LOG_DIR);
    expect(exec).toContain("Introduce yourself briefly as the Sparkle Improvement Agent");
    expect(exec).not.toContain("Start your first improvement pass");
  });

  it("spawns an ATTENDED persona — the pane IS the user sitting in the chat", async () => {
    // The mirror of the headless assertion in improvementPass.watchdog.test.ts, and the side where
    // a regression is silent: this pane's user can clear an auth failure in seconds, so handing
    // them "leave it committed, count the PR as not submitted" wastes a submission they could have
    // unblocked. Asserted here rather than trusted to the call site, because the call site is
    // exactly what this branch got wrong twice.
    const { exec } = await spawned();
    expect(exec).toContain(GH_AUTH_ASK_USER);
    expect(exec).not.toContain(GH_AUTH_UNATTENDED_STOP);
  });

  it('consent "always" grants the log dir via --add-dir', async () => {
    useSettingsStore.getState().setSparkleImprovementConsent("always");
    const { exec } = await spawned();
    expect(exec).toContain(`--add-dir '${LOG_DIR}'`);
    expect(exec).toContain("no per-PR approval is needed");
  });

  it('consent "case_by_case" (default) grants the log dir via --add-dir', async () => {
    const { exec } = await spawned();
    expect(exec).toContain(`--add-dir '${LOG_DIR}'`);
    expect(exec).toContain("MUST NOT submit a PR on your own");
  });

  it("registers its WORKTREE so the concierge can still read this agent unmounted", async () => {
    // The pane is where the user talks to this agent, and it is unmounted the moment they look
    // anywhere else — at which point tiers (a)-(c) of the concierge's read chain are all empty for
    // it. The worktree, not a resolved file: a fresh spawn writes a new transcript AFTER this point,
    // so a file pinned here would be the previous session's for the whole session.
    await spawned();
    expect(registerSparkleTranscript).toHaveBeenCalledWith("__sparkle_self__", "/wt/sparkle-self");
  });
});

// ── The sparkle-control MCP, bead sparkle-hdlhox ────────────────────────────────────────────────
//
// THE DEFECT THIS GUARDS. This pane assembled its exec with appendSystemPrompt / inboxAgentId /
// addDirs / initialPrompt and NO mcpConfig — `grep -ci mcp` on the component returned 0 — while
// AgentPane's generic branch passed `mcpConfig: controlMcpConfig`. So Improve Sparkle had no
// sparkle-control tools at all: it could not read `get_state({scope:"fleet"})` (the app-global
// address book) and could not call `send_peer_message` to reach the concierge at
// `sparkle:concierge`. The whole cross-agent channel (bead sparkle-179b2s) was already on main and
// this one agent could not see it, which is why it reported itself blind.
//
// Asserted at the REAL call site, not on buildClaudeExec: the builder has always handled mcpConfig
// correctly. What was missing is a call site passing it, and only driving prepare() can see that.
describe("SparkleAgentPane — sparkle-control MCP wiring (bead sparkle-hdlhox)", () => {
  it("spawns with --mcp-config carrying the sparkle-control server and this agent's id", async () => {
    const { exec } = await spawned();
    expect(exec).toContain("--mcp-config");
    expect(exec).toContain("sparkle-control");
    // The anti-spoofing caller identity: ops arriving on the shared socket are stamped with this,
    // so a wrong id here would make every per-agent op resolve to the wrong agent.
    expect(exec).toContain('"SPARKLE_AGENT_ID":"__sparkle_self__"');
    // NOT strict: the user's own global MCP servers must still load, matching AgentPane's generic
    // branch. --strict-mcp-config would silently drop them.
    expect(exec).not.toContain("--strict-mcp-config");
  });

  it("tells the persona the channel exists ONLY when the bridge actually came up", async () => {
    // Two halves of one rule. Advertising tools that are not there yields confusing "tool not
    // found" attempts (AgentPane.tsx:985-989), so the protocol prose is gated on the same value
    // that produces the flag — never emitted unconditionally.
    const up = await spawned();
    expect(up.exec).toContain("CONTROLLING THE SPARKLE UI");

    cleanup();
    captured.props.length = 0;
    (startControlBridge as Mock).mockRejectedValue(new Error("bridge unavailable"));
    const down = await spawned();
    expect(down.exec).not.toContain("--mcp-config");
    expect(down.exec).not.toContain("CONTROLLING THE SPARKLE UI");
  });

  it("still spawns a WORKING agent when the bridge is down — degrades, never fails", async () => {
    // The brief's hard constraint: the channel must degrade safely when the other side is absent.
    // A bridge failure must cost the agent its cross-agent tools and NOTHING else — the pane still
    // reaches Terminal with its persona, its log dir and its mission prompt intact.
    (startControlBridge as Mock).mockRejectedValue(new Error("bridge unavailable"));
    const { exec } = await spawned();
    expect(exec).toContain("Start your first improvement pass");
    expect(exec).toContain(`--add-dir '${LOG_DIR}'`);
    expect(exec).toContain("export SPARKLE_INBOX_AGENT='__sparkle_self__'; ");
  });
});
