// runImprovementPass's hung-pass watchdog + event plumbing (roborev #24516/#24983/#24984):
// a pass that never emits done/error must be killed at PASS_TIMEOUT_MS with the latch released
// (one wedged claude -p must not silently end the hourly loop), and a done event must win the
// race against the timer. Tauri invoke/listen and the worktree/preflight seams are mocked; the
// REAL runtimeStore carries the status assertions.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

type Handler = (ev: { payload: unknown }) => void;
const harness = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  invokes: [] as Array<{ cmd: string; args: unknown }>,
  // Per-test overrides, keyed by COMMAND/EVENT NAME (not call order, so a future extra
  // invoke/listen in the pass preamble can't silently absorb a planted rejection). Reset in
  // beforeEach; return undefined to fall through to the default behavior.
  invokeImpl: undefined as ((cmd: string) => Promise<void> | undefined) | undefined,
  listenImpl: undefined as ((name: string) => Promise<() => void> | undefined) | undefined,
  // Same override shape for the fresh-base parking step, so a test can make it reject. Typed as the
  // service's own ParkOutcome, not `unknown`: the pass reads `park.parked` / `park.reason`, so a
  // planted shape that doesn't satisfy it must be a type error here rather than a silent pass.
  parkImpl: (() => Promise.resolve({ parked: true, reason: "parked" })) as () => Promise<
    import("./worktree").ParkOutcome
  >,
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
  parkWorktreeOnBase: vi.fn(() => harness.parkImpl()),
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

import {
  cancelImprovementPass,
  IMPROVEMENT_RETRY_MS,
  isPassRunning,
  PASS_TIMEOUT_MS,
  passRetryDueAt,
  resetPassRetryForTests,
  runImprovementPass,
} from "./improvementPass";
import {
  GH_AUTH_ASK_USER,
  GH_AUTH_UNATTENDED_STOP,
  SPARKLE_AGENT_ID,
  SPARKLE_PROJECT_ID,
} from "./sparkleAgent";
import { useRuntimeStore } from "../stores/runtimeStore";

/** Let the pass's async preamble (preflight → repo → worktree → listeners → invoke) settle
 *  under fake timers: drain microtasks until the run invoke has been recorded. */
async function untilRunInvoked() {
  for (let i = 0; i < 50 && !harness.invokes.some((c) => c.cmd === "sparkle_improve_run"); i++) {
    await Promise.resolve();
  }
  expect(harness.invokes.some((c) => c.cmd === "sparkle_improve_run")).toBe(true);
}

/** Put every harness field AND all mock call history back to its default. ONE place on purpose: the
 *  two describes below had near-identical setup, and the omission that let a whole describe run
 *  against a rejecting `parkImpl` was exactly a field missing from the second copy.
 *
 *  `clearAllMocks` is part of the contract, not an extra: the vitest config sets neither `clearMocks`
 *  nor `restoreMocks`, so call history otherwise accumulates across the whole file — which is what
 *  made the park-order test pass on a previous test's park. It clears calls/results only, leaving the
 *  `vi.fn(impl)` implementations the module mocks are built on intact (unlike `resetAllMocks`). */
function resetHarness() {
  harness.handlers.clear();
  harness.invokes.length = 0;
  harness.invokeImpl = undefined;
  harness.listenImpl = undefined;
  harness.parkImpl = () => Promise.resolve({ parked: true, reason: "parked" });
  vi.clearAllMocks();
  resetPassRetryForTests();
  useRuntimeStore.getState().setStatus(SPARKLE_AGENT_ID, "stopped");
}

/** The two warnings the park guard can emit, quoted from improvementPass.ts. Shared so the positive
 *  assertions and `warnedStaleBase` cannot drift from each other by a typo — a mistyped literal
 *  inside the negative helper would otherwise return false forever and pass silently. */
const STALE_BASE_WARNING = "improvement pass: starting from a stale base —";
const PARK_FAILED_WARNING = "improvement pass: could not park the worktree on a fresh base:";

/** Run `fn` with `console.warn` stubbed, always restoring it. A spy restored by a trailing call is
 *  left installed for the rest of the file the moment an assertion above it throws — the same
 *  cross-test leakage this suite keeps having to remove, so the scaffold lives in one place. */
async function withWarnSpy(fn: (warn: MockInstance<typeof console.warn>) => Promise<void>) {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await fn(warn);
  } finally {
    warn.mockRestore();
  }
}

/** Did the stale-base warning fire? Asserted on the MESSAGE alone: `expect.anything()` does not
 *  match null/undefined, so a regression that warned with a missing reason would slip past a
 *  `not.toHaveBeenCalledWith(msg, expect.anything())`.
 *
 *  What protects the literal is the SHARED CONSTANT, not the annotation: DOM's `Console.warn` is
 *  `(...data: any[]): void`, so `calls` is `any[][]` and `c[0]` is `any` no matter how the spy is
 *  typed. `MockInstance<typeof console.warn>` is a readability tidy-up over
 *  `ReturnType<typeof vi.spyOn>`, nothing more — don't inline STALE_BASE_WARNING believing the type
 *  would catch a typo, because it would not, and this helper would then return false forever. */
function warnedStaleBase(warn: MockInstance<typeof console.warn>): boolean {
  return warn.mock.calls.some((c) => c[0] === STALE_BASE_WARNING);
}

describe("runImprovementPass watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHarness();
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

  it.each(["always", "case_by_case"] as const)(
    "%s: the headless pass sends an UNATTENDED persona, whatever the consent mode",
    async (consent) => {
      // The call site is the thing two previous attempts got wrong, and until now only the pure
      // function was covered. This pass is headless for EVERY mode that reaches it (never returns
      // early), so an edit that passes attended:true here would tell an hourly run to wait on a
      // user confirmation that can never arrive — with the sparkleAgent unit tests still green.
      // Premise, stated rather than inherited: the default invoke mock resolves undefined for
      // sparkle_submit_capability, which becomes the "unknown" verdict — and `unknown` is the only
      // reason the auth-advice block is emitted at all (a blocked verdict suppresses it). A harness
      // change that returned a blocked verdict by default would otherwise fail this test with
      // nothing wrong in the code under test.
      const pass = runImprovementPass(consent);
      await untilRunInvoked();

      const run = harness.invokes.find((c) => c.cmd === "sparkle_improve_run");
      const persona = (run?.args as { persona?: string } | undefined)?.persona ?? "";
      // On the exported constants: the same strings are asserted in the opposite direction in
      // sparkleAgent.test.ts, and copying the prose into a second suite means a reword breaks two
      // files that never mention each other.
      expect(persona).not.toContain(GH_AUTH_ASK_USER);
      expect(persona).toContain(GH_AUTH_UNATTENDED_STOP);

      harness.handlers.get("sparkle_improve:done")?.({ payload: { sessionId: "s", text: "" } });
      await pass;
    },
  );

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

  it("parks the worktree on a fresh base BEFORE spawning the pass", async () => {
    // The staleness fix: createAgentWorktree reuses an existing worktree untouched, so without an
    // explicit park each hourly pass inherits the previous pass's topic branch and drifts further
    // behind main. Parking must happen, with the agent's real repo/base, ahead of the run.
    //
    // The ORDER is the whole claim, so it is asserted directly rather than inferred from "was
    // called" — which is what this test did originally, and it could not fail for the regression it
    // exists to catch. invocationCallOrder is monotonic across mocks, so comparing the park against
    // the `sparkle_improve_run` invoke pins the sequence. (Call history is per-test: resetHarness
    // clears it, so these orders are this test's own.)
    const { parkWorktreeOnBase } = await import("./worktree");
    const { invoke } = await import("@tauri-apps/api/core");

    const pass = runImprovementPass("always");
    await untilRunInvoked();

    expect(parkWorktreeOnBase).toHaveBeenCalledWith(
      "/app-data/oss",
      SPARKLE_PROJECT_ID,
      SPARKLE_AGENT_ID,
      "main",
    );
    const parkOrder = vi.mocked(parkWorktreeOnBase).mock.invocationCallOrder[0];
    const runIndex = vi.mocked(invoke).mock.calls.findIndex((c) => c[0] === "sparkle_improve_run");
    expect(runIndex).toBeGreaterThanOrEqual(0);
    // findIndex above proves the entry exists, but `noUncheckedIndexedAccess` still types the lookup
    // as possibly-undefined. -1 rather than a non-null assertion: if it ever IS missing the
    // comparison fails loudly instead of being asserted away.
    const runOrder = vi.mocked(invoke).mock.invocationCallOrder[runIndex] ?? -1;
    expect(parkOrder).toBeLessThan(runOrder);

    harness.handlers.get("sparkle_improve:done")?.({ payload: { sessionId: "s", text: "" } });
    await pass;
  });

  it("a DECLINED park is not a gate either: the pass runs and the stale base is warned about", async () => {
    // Between "parked" and "threw" sits the case the service actually branches on: park returns
    // parked: false for a reason other than already-fresh (a dirty or unpushed worktree it refuses
    // to move). That must warn and continue, never skip the user's hourly pass.
    harness.parkImpl = () => Promise.resolve({ parked: false, reason: "dirty" });

    await withWarnSpy(async (warn) => {
      const pass = runImprovementPass("always");
      await untilRunInvoked();
      harness.handlers.get("sparkle_improve:done")?.({ payload: { sessionId: "s", text: "" } });
      await pass;

      expect(warn).toHaveBeenCalledWith(STALE_BASE_WARNING, "dirty");
      expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).toBe("idle");
      expect(isPassRunning()).toBe(false);
    });
  });

  it("an ALREADY-FRESH worktree is not a stale base and must not warn", async () => {
    // The other half of the service's guard (`!park.parked && park.reason !== "already-fresh"`).
    // Nothing pinned it, so deleting that second clause — turning every ordinary fresh-worktree
    // pass into a spurious stale-base warning, once an hour, forever — kept the suite green.
    const { parkWorktreeOnBase } = await import("./worktree");
    harness.parkImpl = () => Promise.resolve({ parked: false, reason: "already-fresh" });

    await withWarnSpy(async (warn) => {
      const pass = runImprovementPass("always");
      await untilRunInvoked();
      harness.handlers.get("sparkle_improve:done")?.({ payload: { sessionId: "s", text: "" } });
      await pass;

      // Positive anchor first, so the negative assertion is scoped to a park that demonstrably
      // happened: on its own, "did not warn" is equally satisfied by the whole park step being
      // deleted. resetHarness clears call history, so this sees THIS test's park only.
      expect(parkWorktreeOnBase).toHaveBeenCalled();
      expect(warnedStaleBase(warn)).toBe(false);
      expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).toBe("idle");
      expect(isPassRunning()).toBe(false);
    });
  });

  it("a failed park is advisory: the pass still runs", async () => {
    // Parking is a freshness optimization, never a gate — a git/network failure there must not
    // cost the user their hourly pass. The THROW branch of the same guard as the two tests above,
    // so it pins its warning for the same reason they pin theirs (and stops the rejection printing
    // a real warn into the test output).
    harness.parkImpl = () => Promise.reject(new Error("git exploded"));

    await withWarnSpy(async (warn) => {
      const pass = runImprovementPass("always");
      await untilRunInvoked();
      harness.handlers.get("sparkle_improve:done")?.({ payload: { sessionId: "s", text: "" } });
      await pass;

      expect(warn).toHaveBeenCalledWith(PARK_FAILED_WARNING, expect.any(Error));
      expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).toBe("idle");
      expect(isPassRunning()).toBe(false);
    });
  });

  it("an external cancel settles the pass at once instead of leaving it to the watchdog", async () => {
    // The interactive pane's prepare() kills the pass so two claude processes never share the
    // worktree. Rust stays silent on that path, so before this settled the promise the latch
    // stayed set for the rest of the 30-minute window (skipping any hourly tick inside it) and
    // the pass was finally reported as a timeout that never happened.
    const pass = runImprovementPass("always");
    await untilRunInvoked();
    expect(isPassRunning()).toBe(true);

    await cancelImprovementPass();
    await pass;

    expect(isPassRunning()).toBe(false);
    // A deliberate handoff is not a failure — "blocked" would read as "needs your attention".
    expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).toBe("idle");
    expect(harness.handlers.size).toBe(0);

    // And the watchdog is disarmed: no second, spurious cancel half an hour later.
    const cancels = harness.invokes.filter((c) => c.cmd === "sparkle_improve_cancel").length;
    await vi.advanceTimersByTimeAsync(PASS_TIMEOUT_MS * 2);
    expect(harness.invokes.filter((c) => c.cmd === "sparkle_improve_cancel").length).toBe(cancels);
  });

  it("cancelling when no pass is running is a harmless no-op", async () => {
    // The pane calls this unconditionally in prepare(), and again after a pass has already
    // settled on its own — neither may throw or disturb the settled status.
    const pass = runImprovementPass("always");
    await untilRunInvoked();
    harness.handlers.get("sparkle_improve:done")?.({
      payload: { sessionId: "s1", text: 'IMPROVE_RESULT: {"submitted": 1, "awaitingApproval": 0, "summary": "ok"}' },
    });
    await pass;
    expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).toBe("idle");

    await expect(cancelImprovementPass()).resolves.toBeUndefined();
    expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).toBe("idle");
    expect(isPassRunning()).toBe(false);
  });

  it("the watchdog's own cancel still reports a timeout, not a cancellation", async () => {
    // Ordering guard: the watchdog cancels AND settles. Its synchronous settle must win over
    // the cancel hook, or a genuinely hung pass would be quietly recorded as a handoff and
    // stop parking on "blocked".
    await withWarnSpy(async (warn) => {
      const pass = runImprovementPass("always");
      await untilRunInvoked();

      await vi.advanceTimersByTimeAsync(PASS_TIMEOUT_MS);
      await pass;

      expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).toBe("blocked");
      expect(warn).toHaveBeenCalledWith(
        "improvement pass failed:",
        expect.stringContaining("timed out"),
      );
    });
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

describe("connectivity re-attempt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Via resetHarness so `parkImpl` is included: the suite above leaves it rejecting or declining,
    // and this describe only got away with omitting it because those tests happen not to run last.
    resetHarness();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const OFFLINE = "API Error: Unable to connect to API (ENOTFOUND)";

  /** Fail one whole pass with `message`, from spawn to settle. */
  async function failPassWith(message: string, freshSlot = false) {
    const pass = runImprovementPass("always", freshSlot);
    await untilRunInvoked();
    harness.handlers.get("sparkle_improve:error")?.({ payload: { message } });
    await pass;
    harness.invokes.length = 0;
  }

  it("arms one re-attempt when the pass never reached the API", async () => {
    // The lost hour this exists for: the pass died on DNS, did no work, and used to forfeit
    // the whole slot. It comes due after a short cool-off, not immediately.
    await failPassWith(OFFLINE, true);
    expect(passRetryDueAt()).toBe(Date.now() + IMPROVEMENT_RETRY_MS);
  });

  it("arms nothing for a failure that actually ran", async () => {
    await failPassWith("exited with code 1", true);
    expect(passRetryDueAt()).toBeNull();
  });

  it("gives a still-offline machine ONE extra spawn, not one per tick", async () => {
    await failPassWith(OFFLINE, true);
    expect(passRetryDueAt()).not.toBeNull();
    // The retry runs and hits the same dead network — it must NOT re-arm, or the gate would
    // fire every tick for the rest of the hour.
    await failPassWith(OFFLINE);
    expect(passRetryDueAt()).toBeNull();
  });

  it("re-earns the retry once a fresh hourly slot runs", async () => {
    await failPassWith(OFFLINE, true);
    await failPassWith(OFFLINE); // the retry; budget spent
    expect(passRetryDueAt()).toBeNull();
    await failPassWith(OFFLINE, true); // next hour — its own re-attempt
    expect(passRetryDueAt()).toBe(Date.now() + IMPROVEMENT_RETRY_MS);
  });

  it("a stale arm that never got consumed doesn't eat the next slot's retry", async () => {
    // An armed retry can go unspent for the rest of the hour — the pane guard suppresses it,
    // say. The next HOURLY run must still be treated as a fresh slot, not as that retry.
    await failPassWith(OFFLINE, true);
    expect(passRetryDueAt()).not.toBeNull(); // armed, and (pretend) never consumed
    await failPassWith(OFFLINE, true);
    expect(passRetryDueAt()).toBe(Date.now() + IMPROVEMENT_RETRY_MS);
  });

  it("arms on a network failure thrown by the pass's setup steps", async () => {
    harness.invokeImpl = (cmd) =>
      cmd === "sparkle_improve_run" ? Promise.reject(new Error("getaddrinfo ENOTFOUND")) : undefined;
    await runImprovementPass("always", true);
    expect(passRetryDueAt()).toBe(Date.now() + IMPROVEMENT_RETRY_MS);
  });
});
