// runImprovementPass's hung-pass watchdog + event plumbing (roborev #24516/#24983/#24984):
// a pass that never emits done/error must be killed at PASS_TIMEOUT_MS with the latch released
// (one wedged claude -p must not silently end the hourly loop), and a done event must win the
// race against the timer. Tauri invoke/listen and the worktree/preflight seams are mocked; the
// REAL runtimeStore carries the status assertions.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (ev: { payload: unknown }) => void;
const harness = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  invokes: [] as Array<{ cmd: string; args: unknown }>,
  // Per-test overrides, keyed by COMMAND/EVENT NAME (not call order, so a future extra
  // invoke/listen in the pass preamble can't silently absorb a planted rejection). Reset in
  // beforeEach; return undefined to fall through to the default behavior.
  invokeImpl: undefined as ((cmd: string) => Promise<void> | undefined) | undefined,
  listenImpl: undefined as ((name: string) => Promise<() => void> | undefined) | undefined,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args?: unknown) => {
    harness.invokes.push({ cmd, args });
    return harness.invokeImpl?.(cmd) ?? Promise.resolve();
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: Handler) => {
    const override = harness.listenImpl?.(name);
    if (override) return override;
    harness.handlers.set(name, handler);
    return Promise.resolve(() => harness.handlers.delete(name));
  }),
}));
vi.mock("../preflight", () => ({
  checkClaude: vi.fn(() => Promise.resolve({ installed: true, path: "/usr/local/bin/claude" })),
}));
vi.mock("./worktree", () => ({
  createAgentWorktree: vi.fn(() => Promise.resolve({ path: "/wt/sparkle-self", branch: "b" })),
  installWorktreeGuard: vi.fn(() => Promise.resolve()),
  assertWorkspaceIntegrity: vi.fn(() => Promise.resolve()),
}));
vi.mock("./sparkleAgent", async (importOriginal) => {
  const real = await importOriginal<typeof import("./sparkleAgent")>();
  return {
    ...real,
    ensureSparkleRepo: vi.fn(() =>
      Promise.resolve({ repoPath: "/app-data/oss", logDir: "/app-data/logs", defaultBranch: "main" }),
    ),
  };
});

import { isPassRunning, PASS_TIMEOUT_MS, runImprovementPass } from "./improvementPass";
import { SPARKLE_AGENT_ID } from "./sparkleAgent";
import { useRuntimeStore } from "../stores/runtimeStore";

/** Let the pass's async preamble (preflight → repo → worktree → listeners → invoke) settle
 *  under fake timers: drain microtasks until the run invoke has been recorded. */
async function untilRunInvoked() {
  for (let i = 0; i < 50 && !harness.invokes.some((c) => c.cmd === "sparkle_improve_run"); i++) {
    await Promise.resolve();
  }
  expect(harness.invokes.some((c) => c.cmd === "sparkle_improve_run")).toBe(true);
}

describe("runImprovementPass watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    harness.handlers.clear();
    harness.invokes.length = 0;
    harness.invokeImpl = undefined;
    harness.listenImpl = undefined;
    useRuntimeStore.getState().setStatus(SPARKLE_AGENT_ID, "stopped");
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("kills a silent pass at PASS_TIMEOUT_MS, releases the latch, and parks on blocked", async () => {
    const pass = runImprovementPass("always");
    await untilRunInvoked();
    expect(isPassRunning()).toBe(true);

    // No done/error ever arrives — the watchdog must fire.
    await vi.advanceTimersByTimeAsync(PASS_TIMEOUT_MS);
    await pass;

    expect(harness.invokes.some((c) => c.cmd === "sparkle_improve_cancel")).toBe(true);
    expect(isPassRunning()).toBe(false);
    expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).toBe("blocked");
    // Listeners were torn down, so a late event can't touch a future pass.
    expect(harness.handlers.size).toBe(0);
  });

  it("a done event beats the timer: no cancel, latch released, status from IMPROVE_RESULT", async () => {
    const pass = runImprovementPass("case_by_case");
    await untilRunInvoked();

    harness.handlers.get("sparkle_improve:done")?.({
      payload: {
        sessionId: "s1",
        text: 'IMPROVE_RESULT: {"submitted": 0, "awaitingApproval": 1, "summary": "drafted"}',
      },
    });
    await pass;

    expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).toBe("approval");
    expect(isPassRunning()).toBe(false);
    expect(harness.invokes.some((c) => c.cmd === "sparkle_improve_cancel")).toBe(false);
    // The now-dead timer must not fire anything later.
    await vi.advanceTimersByTimeAsync(PASS_TIMEOUT_MS * 2);
    expect(harness.invokes.some((c) => c.cmd === "sparkle_improve_cancel")).toBe(false);
  });

  it("an error event settles as failure without cancel", async () => {
    const pass = runImprovementPass("always");
    await untilRunInvoked();
    harness.handlers.get("sparkle_improve:error")?.({ payload: { message: "boom" } });
    await pass;
    expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).toBe("blocked");
    expect(isPassRunning()).toBe(false);
    expect(harness.invokes.some((c) => c.cmd === "sparkle_improve_cancel")).toBe(false);
    expect(harness.handlers.size).toBe(0);
  });

  it("a rejecting sparkle_improve_run tears down fully via the fail path", async () => {
    // The fail → finish wiring: a Rust-side rejection (e.g. "a pass is already running") must
    // clear the timer, unlisten, release the latch, and park on blocked — same teardown as
    // the settle paths.
    harness.invokeImpl = (cmd) =>
      cmd === "sparkle_improve_run"
        ? Promise.reject(new Error("sparkle_improve_run: a pass is already running"))
        : undefined;

    await runImprovementPass("always");

    expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).toBe("blocked");
    expect(isPassRunning()).toBe(false);
    expect(harness.handlers.size).toBe(0);
    // The watchdog timer was cleared: nothing fires later.
    await vi.advanceTimersByTimeAsync(PASS_TIMEOUT_MS * 2);
    expect(harness.invokes.some((c) => c.cmd === "sparkle_improve_cancel")).toBe(false);
  });

  it("a partial listen failure still unlistens the fulfilled registration", async () => {
    // The leak this suite's service fix exists for (roborev #24516 → 23912a26): done registers,
    // error rejects → the fulfilled done handle must still be torn down, the pass must park on
    // blocked with the latch released, and no run must be spawned.
    harness.listenImpl = (name) =>
      name === "sparkle_improve:error"
        ? Promise.reject(new Error("event bus unavailable"))
        : undefined;

    await runImprovementPass("always");

    expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).toBe("blocked");
    expect(isPassRunning()).toBe(false);
    // The one that DID register was unlistened — this is the assertion that catches the leak.
    expect(harness.handlers.size).toBe(0);
    expect(harness.invokes.some((c) => c.cmd === "sparkle_improve_run")).toBe(false);
    await vi.advanceTimersByTimeAsync(PASS_TIMEOUT_MS * 2);
    expect(harness.invokes.some((c) => c.cmd === "sparkle_improve_cancel")).toBe(false);
  });
});
