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
  assertWorkspaceIntegrity: vi.fn(() => Promise.resolve()),
}));
vi.mock("../preflight", () => ({
  checkClaude: vi.fn(() => Promise.resolve({ installed: true, path: "/usr/local/bin/claude" })),
  claudeHasSession: vi.fn(() => Promise.resolve(false)),
}));
// Mocked to assert the WIRING. The helper's own behaviour (worktree → tier (d) → the agent's words)
// is covered end-to-end in services/sparkleTranscript.test.ts; what was unguarded is that this pane
// calls it at all — the suite went green with both call sites deleted (roborev 55363).
vi.mock("../services/sparkleTranscript", () => ({ registerSparkleTranscript: vi.fn() }));
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
