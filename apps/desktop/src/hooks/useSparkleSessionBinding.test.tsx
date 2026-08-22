// @vitest-environment jsdom
//
// THE THIRD READER HAD NO TEST, WHICH IS THE WHOLE DEFECT REPEATING ITSELF.
//
// Three readers resolved an agent's transcript without the per-account CLAUDE_CONFIG_DIR its
// `claude` was spawned with, so all three scanned `$HOME/.claude` and found nothing for an
// account-spawned agent. Two of them got payload assertions when they were fixed; this one did not
// — and the suites that already exercise it stub `claude_latest_session_path` by ignoring `args`
// entirely, so DELETING the third argument here (reintroducing the exact omission) left the whole
// suite green.
//
// That is the "defaulted seam" from AGENTS.md, and it is precisely how the original bug survived:
// the line that carries the real value is covered by nothing, so its absence is invisible. These
// rows assert the SIDE EFFECT — the payload that goes over the wire.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { useSparkleSessionBinding } from "./useSparkleSessionBinding";
import { forgetAgentTranscriptPath, noteAgentConfigDir } from "../services/agentTranscriptRegistry";
import { SPARKLE_AGENT_ID } from "../services/sparkleAgent";

const WORKTREE = "/home/u/wt/sparkle-self";
const ACCOUNT = "/home/u/Library/Application Support/ai.sparkle.desktop/accounts/acct-7";

function Harness({ agentId }: { agentId: string | null }) {
  useSparkleSessionBinding(agentId, WORKTREE);
  return null;
}

const flush = async () => {
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
};
const latestSessionCalls = () =>
  invoke.mock.calls.filter(([cmd]) => cmd === "claude_latest_session_path");

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(`${ACCOUNT}/projects/-home-u-wt-sparkle-self/sess-1.jsonl`);
  localStorage.clear();
  forgetAgentTranscriptPath(SPARKLE_AGENT_ID);
});
afterEach(cleanup);

describe("useSparkleSessionBinding", () => {
  it("resolves the session under the agent's OWN account, not $HOME/.claude", async () => {
    noteAgentConfigDir(SPARKLE_AGENT_ID, ACCOUNT);
    render(<Harness agentId={SPARKLE_AGENT_ID} />);
    await flush();

    expect(latestSessionCalls()[0]?.[1]).toMatchObject({
      worktreePath: WORKTREE,
      configDir: ACCOUNT,
    });
  });

  it("omits the config dir when none is recorded, so the default root still works", async () => {
    // `undefined` here is NOT the fail-closed UNKNOWN of the session binding: it means "no account
    // override", and Rust's fallback to $HOME/.claude is the right answer for an agent spawned under
    // the default config. This fix must never make a currently-working pane worse.
    render(<Harness agentId={SPARKLE_AGENT_ID} />);
    await flush();

    const payload = latestSessionCalls()[0]?.[1] as Record<string, unknown> | undefined;
    expect(payload).toBeDefined();
    expect(payload?.configDir ?? null).toBeNull();
  });

  it("re-resolves when the config dir lands AFTER the first render", async () => {
    // The binding routinely arrives after the pane paints (it comes from a spawn or a hook event),
    // which is why the hook subscribes rather than reading once. Without the subscription the agent
    // stays on a scan that already came back empty.
    render(<Harness agentId={SPARKLE_AGENT_ID} />);
    await flush();
    const before = latestSessionCalls().length;

    await act(async () => {
      noteAgentConfigDir(SPARKLE_AGENT_ID, ACCOUNT);
    });
    await flush();

    const after = latestSessionCalls();
    expect(after.length).toBeGreaterThan(before);
    expect(after[after.length - 1]?.[1]).toMatchObject({ configDir: ACCOUNT });
  });

  it("does nothing at all for an ordinary build agent", async () => {
    noteAgentConfigDir("ordinary-agent", ACCOUNT);
    render(<Harness agentId="ordinary-agent" />);
    await flush();

    expect(latestSessionCalls()).toEqual([]);
  });
});
