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
});
