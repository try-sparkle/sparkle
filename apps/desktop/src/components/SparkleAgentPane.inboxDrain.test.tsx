// @vitest-environment jsdom
//
// SparkleAgentPane REGISTERS THE INBOX-DRAIN HOOKS FOR ITS OWN WORKTREE (bead sparkle-6yrvqd).
//
// THE DEFECT THIS PINS, measured 2026-09-04. Peer messages queued to `__sparkle_self__` were never
// delivered — not once, for the inbox's entire lifetime: 114 messages on disk, `delivered: 0`. The
// cause was not addressing, eviction or priority. It was that the canonical Improve-Sparkle
// worktree's `settings.local.json` registered exactly two hook events — `PreToolUse` (the worktree
// write-guard) and `UserPromptSubmit` (a repo cadence script) — and NEITHER of them was the
// `sparkle-hook.mjs` emitter. An ordinary agent worktree registers nine, including `Stop`. The
// turn-boundary drain rides `Stop`, so it had never fired.
//
// WHY IT WAS MISSING, and this is the shape worth remembering: the ONLY caller of
// `install_event_hooks_for_worktree` was `sparkle_improve_run`, so the hook was registered as a SIDE
// EFFECT of an hourly improvement pass. This pane knew that and said so in a comment — "once a pass
// has registered the hook, the primary window's exported id IS consumed". A true sentence about a
// thing that never happened. An export whose consumer is installed by an unrelated code path is not
// a mechanism.
//
// WHY THE TEST RENDERS THE PANE INSTEAD OF UNIT-TESTING THE SERVICE. The service function is
// trivial — it forwards to a Tauri command. What broke was that NOTHING CALLED IT at the moment the
// agent was mounted, and a missing call site is invisible to a unit test of the callee: it compiles,
// every other suite stays green, and the only symptom is an agent that silently stops receiving
// messages. AGENTS.md calls this the defaulted seam — the production line nothing drives. So the
// assertion has to be made against the pane's real `prepare()`.
//
// AND WHY IT ASSERTS THE ARGUMENT, NOT MERELY THE CALL. `hooks.rs::event_log_path` keys the event
// log by the worktree's BASENAME, and `sparkle-hook.mjs::inboxPaths` derives the inbox id from that
// log's basename, which `mayDrain` then requires to equal the exported `SPARKLE_INBOX_AGENT`. Call
// it with the wrong path and every one of those still "succeeds" while the drain refuses forever —
// exactly the silent failure being fixed. The path is therefore compared against the SAME
// `wt.path` the spawn is given, so the two cannot drift apart without this going red.
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const captured = vi.hoisted(() => ({ props: [] as Array<{ args: string[]; resuming: boolean }> }));

/** The worktree `createAgentWorktree` is mocked to return — the one path everything must agree on. */
const WT_PATH = "/wt/sparkle-self";

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
  createAgentWorktree: vi.fn(() => Promise.resolve({ path: WT_PATH, branch: "sparkle/agent-self" })),
  installWorktreeGuard: vi.fn(() => Promise.resolve()),
  installInboxDrainHooks: vi.fn(() => Promise.resolve("/app-data/hook-events/sparkle-self.jsonl")),
  assertWorkspaceIntegrity: vi.fn(() => Promise.resolve()),
  acquireWorktreeLease: vi.fn(() => Promise.resolve()),
  releaseWorktreeLease: vi.fn(() => Promise.resolve()),
}));
vi.mock("../preflight", () => ({
  checkClaude: vi.fn(() => Promise.resolve({ installed: true, path: "/usr/local/bin/claude" })),
  claudeHasSession: vi.fn(() => Promise.resolve(false)),
}));
vi.mock("../services/sparkleTranscript", () => ({ registerSparkleTranscript: vi.fn() }));
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
vi.mock("../services/sparkleAgent", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/sparkleAgent")>();
  return {
    ...real,
    ensureSparkleRepo: vi.fn(() =>
      Promise.resolve({
        repoPath: "/app-data/",
        logDir: "/app-data/logs/sparkle",
        defaultBranch: "main",
      }),
    ),
  };
});

import { SparkleAgentPane } from "./SparkleAgentPane";
import { installInboxDrainHooks, assertWorkspaceIntegrity } from "../services/worktree";

/** Render the pane and wait until `prepare()` has handed a spawn to Terminal. */
async function prepared(): Promise<string> {
  render(<SparkleAgentPane visible agentId="__sparkle_self__" />);
  await waitFor(() => expect(captured.props.length).toBeGreaterThan(0));
  return captured.props[captured.props.length - 1]?.args[2] ?? "";
}

beforeEach(() => {
  captured.props.length = 0;
  (installInboxDrainHooks as Mock).mockClear();
  (installInboxDrainHooks as Mock).mockResolvedValue("/app-data/hook-events/sparkle-self.jsonl");
  (assertWorkspaceIntegrity as Mock).mockClear();
});
afterEach(cleanup);

describe("SparkleAgentPane inbox-drain hook registration", () => {
  it("registers the drain hooks for the worktree it is about to spawn in", async () => {
    await prepared();
    expect(
      (installInboxDrainHooks as Mock).mock.calls.length,
      "prepare() must register the Stop-hook inbox drain itself; relying on the hourly improvement " +
        "pass to have done it is what left 114 peer messages undelivered (sparkle-6yrvqd)",
    ).toBeGreaterThan(0);
  });

  it("registers it for the SAME worktree the spawn runs in, not some other path", async () => {
    await prepared();
    const arg = (installInboxDrainHooks as Mock).mock.calls[0]?.[0];
    expect(
      arg,
      "the event log is keyed by this worktree's basename and the inbox id is derived from that " +
        "log's basename, so a mismatched path leaves mayDrain refusing forever while every call " +
        "still reports success",
    ).toBe(WT_PATH);
  });

  // THE PAIRED NEGATIVE, and it is the one that keeps the fix from becoming a new outage. This call
  // is best-effort by design: a mailbox that cannot be registered must never stop the agent from
  // starting. Without this arm, "await it and let it throw" passes the two assertions above and
  // turns a warn into a dead pane.
  it("still spawns when the registration rejects", async () => {
    (installInboxDrainHooks as Mock).mockRejectedValue(new Error("settings.local.json is read-only"));
    const exec = await prepared();
    expect(exec, "a failed drain-hook install must not stop the pane from spawning claude").toContain(
      "claude",
    );
  });

  // ...and that the failure is not silent. The whole cost of this defect was that nothing anywhere
  // said the mailbox was dead: `inbox_send` replied "queued", `inbox_status` reported pending
  // climbing, and no log line connected the two. A swallowed catch here would rebuild that.
  it("warns when the registration rejects, rather than swallowing it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    (installInboxDrainHooks as Mock).mockRejectedValue(new Error("settings.local.json is read-only"));
    await prepared();
    const said = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(said, "a dead mailbox must leave a trace naming itself").toMatch(/inbox/i);
    warn.mockRestore();
  });

  // ORDERING. The hooks must be registered BEFORE `claude` is spawned, or the session starts with no
  // Stop hook and its first turn boundary drains nothing. `assertWorkspaceIntegrity` runs between
  // the two in production, so it is the observable marker for "prepare has moved past the install".
  it("registers before the spawn reaches Terminal", async () => {
    const order: string[] = [];
    (installInboxDrainHooks as Mock).mockImplementation(() => {
      order.push("install");
      return Promise.resolve("/app-data/hook-events/sparkle-self.jsonl");
    });
    (assertWorkspaceIntegrity as Mock).mockImplementation(() => {
      order.push("integrity");
      return Promise.resolve();
    });
    await prepared();
    expect(order.indexOf("install")).toBeGreaterThanOrEqual(0);
    expect(
      order.indexOf("install"),
      "the drain hooks must be written before claude starts; a session that begins without a Stop " +
        "hook drains nothing at its first turn boundary",
    ).toBeLessThan(order.indexOf("integrity"));
  });
});
