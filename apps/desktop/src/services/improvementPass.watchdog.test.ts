// runImprovementPass's hung-pass watchdog + event plumbing (roborev #24516/#24983/#24984):
// a pass that never emits done/error must be killed at PASS_TIMEOUT_MS with the latch released
// (one wedged claude -p must not silently end the hourly loop), and a done event must win the
// race against the timer. Tauri invoke/listen and the worktree/preflight seams are mocked; the
// REAL runtimeStore carries the status assertions.
//
// ⚠️ A FAILED PASS IS AMBER `lapsed`, NOT RED `blocked` — every assertion below said `blocked`
// until 2026-08-22. The rule now lives in `engine/passFailureStatus` (which is unit-tested in
// isolation); these tests are the other half of it, driving the REAL entry point and asserting the
// status the runtimeStore actually ends up holding. Red is reserved for the two shapes no other
// actor can clear: an account/quota wall (`blocked`, asserted below) and a park that has declined
// for the SAME reason PARK_DECLINE_ESCALATE_AFTER hours running (`errored`, also below).
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

type Handler = (ev: { payload: unknown }) => void;
const harness = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  invokes: [] as Array<{ cmd: string; args: unknown }>,
  // Per-test overrides, keyed by COMMAND/EVENT NAME (not call order, so a future extra
  // invoke/listen in the pass preamble can't silently absorb a planted rejection). Reset in
  // beforeEach; return undefined to fall through to the default behavior.
  // Takes `args` and may resolve a VALUE, not just void: the transcript-read assertions below need a
  // command's return (a resolved path, a transcript's text), which the default `Promise.resolve()`
  // cannot express.
  invokeImpl: undefined as ((cmd: string, args?: unknown) => Promise<unknown> | undefined) | undefined,
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
    return harness.invokeImpl?.(cmd, args) ?? Promise.resolve();
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
  // `accountSelection.loadAccountState` — reached via `accountConfigDirFor` on the pass boundary —
  // kicks two fire-and-forget refreshers whose `deps` defaults dereference these preflight exports
  // SYNCHRONOUSLY at the call site. A mock that omits them makes that dereference throw, which (before
  // the fix) the account load caught and downgraded to `failed: true`, stranding the pass's account
  // binding at null. Provide healthy, side-effect-free stand-ins so the refreshers run harmlessly.
  checkClaudeAuthStatus: vi.fn(() =>
    Promise.resolve({
      loggedIn: true,
      source: "cli",
      email: "improve@sparkle.test",
      authMethod: null,
      subscriptionType: null,
    }),
  ),
  authIsDefinitelyExpired: vi.fn(() => false),
  claudeSessionAccounts: vi.fn(() => Promise.resolve([])),
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
  PARK_DECLINE_ESCALATE_AFTER,
  parkDeclineStreakAt,
  PASS_TIMEOUT_MS,
  passRetryDueAt,
  PROBE_KILL_WAIT_MS,
  PROBE_TIMEOUT_MS,
  refusalDetail,
  resetParkDeclineStreakForTests,
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
import { forgetAgentTranscriptPath, readAgentTerminal } from "./conciergeTools/terminal";
import { agentSessionIds } from "./agentTranscriptRegistry";
import { invalidateAccountState, resetStickyAccounts } from "./accountSelection";
import { setPin, clearAllPins } from "./accountStore";

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
  // Three separate pieces of module-level account state outlive a test: the TTL-cached snapshot,
  // the sticky selection, and the last-resolved config dir. All three must go, or an account
  // planted by one test is served to the next — which is exactly how the broken-backend case
  // started reporting the PREVIOUS test's account instead of the default.
  invalidateAccountState();
  resetStickyAccounts();
  clearAllPins();
  vi.clearAllMocks();
  resetPassRetryForTests();
  // The consecutive-decline tally is module-level and OUTLIVES a test, exactly like the retry latch:
  // an unpushed decline in one case would otherwise carry a streak into the next and escalate a first
  // refusal there to `errored`. Forget it, so every test starts from a clean count.
  resetParkDeclineStreakForTests();
  useRuntimeStore.getState().setStatus(SPARKLE_AGENT_ID, "stopped");
  useRuntimeStore.getState().setAttentionScreen(SPARKLE_AGENT_ID, "");
  // The transcript registry is module-level state that OUTLIVES a test, so a pass in one case would
  // otherwise leave this agent readable in the next — which is precisely the assertion below.
  forgetAgentTranscriptPath(SPARKLE_AGENT_ID);
}

/** The two warnings the park guard can emit, quoted from improvementPass.ts. Shared so the positive
 *  assertions and `warnedRefusal` cannot drift from each other by a typo — a mistyped literal
 *  inside the negative helper would otherwise return false forever and pass silently. */
const REFUSED_WARNING = "improvement pass: refusing to run from an unknown base —";
/** The OUTER catch's warning. A park throw is deliberately not caught locally any more — it must
 *  reach this handler, which is the only one that arms the connectivity re-attempt. */
const PASS_ERRORED_WARNING = "improvement pass errored:";

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
 *  `ReturnType<typeof vi.spyOn>`, nothing more — don't inline REFUSED_WARNING believing the type
 *  would catch a typo, because it would not, and this helper would then return false forever. */
function warnedRefusal(warn: MockInstance<typeof console.warn>): boolean {
  return warn.mock.calls.some((c) => c[0] === REFUSED_WARNING);
}

/** Assert the pass never spawned. THE SIDE EFFECT, and the reason these tests exist: a refusal that
 *  warns but still runs `claude` against an unknown base is precisely the bug being fixed, and a
 *  test that only checks the warning would go green against it. */
function expectNoRunInvoked() {
  expect(harness.invokes.map((c) => c.cmd)).not.toContain("sparkle_improve_run");
}

describe("runImprovementPass watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHarness();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("kills a silent pass at PASS_TIMEOUT_MS, releases the latch, and parks on lapsed", async () => {
    const pass = runImprovementPass("always");
    await untilRunInvoked();
    expect(isPassRunning()).toBe(true);

    // No done/error ever arrives — the watchdog must fire.
    await vi.advanceTimersByTimeAsync(PASS_TIMEOUT_MS);
    await pass;

    expect(harness.invokes.some((c) => c.cmd === "sparkle_improve_cancel")).toBe(true);
    expect(isPassRunning()).toBe(false);
    expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).toBe("lapsed");
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
    expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).toBe("lapsed");
    expect(isPassRunning()).toBe(false);
    expect(harness.invokes.some((c) => c.cmd === "sparkle_improve_cancel")).toBe(false);
    expect(harness.handlers.size).toBe(0);
  });

  // ── THE COLOUR OF A FAILURE IS DECIDED BY ITS MESSAGE, AND NOTHING ELSE ────────────────────────
  //
  // These three drive the SAME real entry point through the SAME real failure path, differing only
  // in the text the pass failed with, and assert the status the runtimeStore actually ends up
  // holding. That is the point of the trio: `engine/passFailureStatus` can be unit-tested all day
  // and still be wired to nothing, and a test asserting "the classifier was called" would pass
  // against a call whose result was thrown away.

  it("a TRANSIENT failure is AMBER, and arms the slot's one re-attempt", async () => {
    const pass = runImprovementPass("always", true);
    await untilRunInvoked();
    harness.handlers.get("sparkle_improve:error")?.({
      payload: {
        message: "API Error: Connection closed mid-response. The response above may be incomplete.",
      },
    });
    await withWarnSpy(async () => {
      await pass;
    });

    // The two halves of "another actor clears this": the colour that says so, and the armed
    // re-attempt that is the actor. Asserting the colour alone would pass for a row that is amber
    // while nothing is ever coming back for it.
    expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).toBe("lapsed");
    expect(passRetryDueAt()).not.toBeNull();
  });

  it("a QUOTA WALL is RED — the one failure no retry and no next hour can clear", async () => {
    // NON-OVERRIDABLE, by the founder's instruction: the Improve Sparkle row and a build row must
    // paint an account wall the same. `statusEngine` paints a build row's wall `blocked`; this path
    // asks the SAME detector (`engine/quotaBlock`), so the two agree by construction.
    const pass = runImprovementPass("always", true);
    await untilRunInvoked();
    harness.handlers.get("sparkle_improve:error")?.({
      payload: { message: "You've hit your session limit · resets 8:40am (America/Bogota)" },
    });
    await withWarnSpy(async () => {
      await pass;
    });

    expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).toBe("blocked");
    // And it is NOT re-attempted: a wall will fail again, so the slot's retry stays unspent. This is
    // the paired half — without it, "red" could be coming from a path that simply retries anyway.
    expect(passRetryDueAt()).toBeNull();
  });

  it("a TIMEOUT is AMBER even though nothing is armed for it", async () => {
    // The 30-minute watchdog: no retry is armed (a timeout is not a connectivity shape), and the row
    // is still amber, because the NEXT HOURLY SLOT is the other actor. This is the case the amber
    // tier is easiest to get wrong on — "nothing armed" reads like "nobody is coming".
    await withWarnSpy(async () => {
      const pass = runImprovementPass("always", true);
      await untilRunInvoked();
      await vi.advanceTimersByTimeAsync(PASS_TIMEOUT_MS);
      await pass;

      expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).toBe("lapsed");
      expect(passRetryDueAt()).toBeNull();
    });
  });

  it("a rejecting sparkle_improve_run tears down fully via the fail path", async () => {
    // The fail → finish wiring: a Rust-side rejection (e.g. "a pass is already running") must
    // clear the timer, unlisten, release the latch, and park on the classified failure status —
    // same teardown as the settle paths.
    harness.invokeImpl = (cmd) =>
      cmd === "sparkle_improve_run"
        ? Promise.reject(new Error("sparkle_improve_run: a pass is already running"))
        : undefined;

    await runImprovementPass("always");

    expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).toBe("lapsed");
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

    // The trailing "stash" is load-bearing, not incidental: the widened dirt rule is OPT-IN in Rust,
    // so the pass only benefits from it by asking. Drop the argument and every park silently reverts
    // to declining on leftovers — which, now that a decline is a GATE, turns the old fixed point
    // ("runs from a stale base every hour") into a worse one ("never runs at all").
    expect(parkWorktreeOnBase).toHaveBeenCalledWith(
      "/app-data/oss",
      SPARKLE_PROJECT_ID,
      SPARKLE_AGENT_ID,
      "main",
      "stash",
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

  // PARK OR REFUSE. This pair used to assert the opposite — that a declined park warned and ran the
  // pass anyway — which is how the defect survived: an hourly `starting from a stale base` line in a
  // log nobody reads, while every pass built on whatever the last one left behind. `unpushed` is the
  // case that cannot be stashed away (a stash cannot save a commit), so it is the one that still
  // reaches this branch after the dirt policy widened, and it is what the fixture uses.
  it("an UNPUSHED park is a gate: the pass never spawns and the row goes lapsed", async () => {
    harness.parkImpl = () => Promise.resolve({ parked: false, reason: "unpushed" });

    await withWarnSpy(async (warn) => {
      await runImprovementPass("always");

      // The side effect is the claim: no `claude` was spawned against a base we cannot describe.
      expectNoRunInvoked();
      expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).toBe("lapsed");
      expect(isPassRunning()).toBe(false);
      // Loud, not silent — but the warning is the secondary assertion, never the only one.
      expect(warn).toHaveBeenCalledWith(
        REFUSED_WARNING,
        "unpushed",
        "—",
        refusalDetail("unpushed"),
      );
    });
  });

  // ESCALATION: a refusal that RECURS for the same reason must stop hiding in the silent AMBER
  // `lapsed` pill. The founder-requested prevention — the hourly loop stopped for days behind a row
  // nobody was pinged about, because the park declined every hour and the quiet tier is deliberately
  // not in the notify set. On the Nth consecutive same-reason decline the row rises to RED `errored`,
  // which IS. That threshold is what makes the amber first refusals safe: a decline that really has
  // no other actor still reaches the founder, just three hours later instead of instantly.
  it("escalates a STUCK loop to errored after N consecutive same-reason declines", async () => {
    harness.parkImpl = () => Promise.resolve({ parked: false, reason: "unpushed" });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // The refusals BELOW the threshold stay on the silent pill — no escalation, no error log.
      for (let i = 1; i < PARK_DECLINE_ESCALATE_AFTER; i++) {
        await runImprovementPass("always");
        expect(parkDeclineStreakAt()).toBe(i);
        expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).toBe("lapsed");
      }
      expect(errorSpy).not.toHaveBeenCalled();

      // The Nth consecutive refusal crosses the threshold: THE SIDE EFFECT is the notifying status.
      await runImprovementPass("always");
      expect(parkDeclineStreakAt()).toBe(PARK_DECLINE_ESCALATE_AFTER);
      expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).toBe("errored");
      // And it is loud where `lapsed` was silent: an error log naming the streak, and an attention
      // screen (tier (b), relayed to the phone) that says how long it has been stuck — not just the
      // bare remedy, so the reader learns this is a persistent loop, not a one-off.
      expect(errorSpy).toHaveBeenCalled();
      const screen = useRuntimeStore.getState().attentionScreen[SPARKLE_AGENT_ID] ?? "";
      expect(screen).toContain(String(PARK_DECLINE_ESCALATE_AFTER));
      expect(screen).toContain("in a row");
      // The pass STILL never spawned — escalation changes the signal, not the (correct) refusal.
      expectNoRunInvoked();
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("a DIFFERENT decline reason restarts the streak (only the SAME reason accumulates)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      harness.parkImpl = () => Promise.resolve({ parked: false, reason: "unpushed" });
      for (let i = 1; i < PARK_DECLINE_ESCALATE_AFTER; i++) await runImprovementPass("always");
      expect(parkDeclineStreakAt()).toBe(PARK_DECLINE_ESCALATE_AFTER - 1);

      // A refusal for a NEW reason is not a continuation of the old loop — the count restarts at 1,
      // so it does not escalate on the strength of unrelated earlier refusals.
      harness.parkImpl = () => Promise.resolve({ parked: false, reason: "no-base" });
      await runImprovementPass("always");
      expect(parkDeclineStreakAt()).toBe(1);
      expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).toBe("lapsed");
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("a SUCCESSFUL park breaks the streak, so a later refusal starts a fresh count", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      harness.parkImpl = () => Promise.resolve({ parked: false, reason: "unpushed" });
      for (let i = 1; i < PARK_DECLINE_ESCALATE_AFTER; i++) await runImprovementPass("always");
      expect(parkDeclineStreakAt()).toBe(PARK_DECLINE_ESCALATE_AFTER - 1);

      // A park that CLEARS (the base self-heals) is exactly the outcome the streak is watching for the
      // absence of — it must reset the count, or a self-healing hour would still escalate later.
      harness.parkImpl = () => Promise.resolve({ parked: true, reason: "parked" });
      const pass = runImprovementPass("always");
      await untilRunInvoked(); // the successful park proceeds to spawn the pass
      expect(parkDeclineStreakAt()).toBe(0);
      harness.handlers.get("sparkle_improve:done")?.({ payload: { sessionId: "s", text: "" } });
      await pass;

      // The next refusal is a first offence again: back to a single `lapsed`, not straight to errored.
      harness.parkImpl = () => Promise.resolve({ parked: false, reason: "unpushed" });
      await runImprovementPass("always");
      expect(parkDeclineStreakAt()).toBe(1);
      expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).toBe("lapsed");
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("an ALREADY-FRESH worktree is not a refusal: the pass runs normally", async () => {
    // The other half of the service's guard (`!park.parked && park.reason !== "already-fresh"`).
    // Nothing pinned it, so deleting that second clause kept the suite green — and now that a
    // refusal is a GATE, dropping it would block the most ordinary outcome there is (a worktree
    // already sitting on the base) once an hour, forever. The cost of the missing clause went up.
    const { parkWorktreeOnBase } = await import("./worktree");
    harness.parkImpl = () => Promise.resolve({ parked: false, reason: "already-fresh" });

    await withWarnSpy(async (warn) => {
      const pass = runImprovementPass("always");
      await untilRunInvoked(); // the side effect: `already-fresh` still SPAWNS the pass
      harness.handlers.get("sparkle_improve:done")?.({ payload: { sessionId: "s", text: "" } });
      await pass;

      // Positive anchor first, so the negative assertion is scoped to a park that demonstrably
      // happened: on its own, "did not warn" is equally satisfied by the whole park step being
      // deleted. resetHarness clears call history, so this sees THIS test's park only.
      expect(parkWorktreeOnBase).toHaveBeenCalled();
      expect(warnedRefusal(warn)).toBe(false);
      expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).toBe("idle");
      expect(isPassRunning()).toBe(false);
    });
  });

  it("a THROWN park is a gate too: the least-informed case is not the most permissive one", async () => {
    // The throw branch of the same guard. This used to be swallowed entirely — so a park that
    // rejected (it fetches, and it takes the per-repo git lock) promoted "we have no idea what the
    // base is" to the most permissive outcome available. "We do not know" is the same conclusion as
    // a decline, not a lesser one.
    harness.parkImpl = () => Promise.reject(new Error("git exploded"));

    await withWarnSpy(async (warn) => {
      await runImprovementPass("always", true);

      expectNoRunInvoked();
      expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).toBe("lapsed");
      expect(isPassRunning()).toBe(false);
      // The throw reaches the OUTER catch, not a local handler — see below.
      expect(warn).toHaveBeenCalledWith(PASS_ERRORED_WARNING, expect.any(Error));
    });
  });

  // Park is the MOST networked setup step (it fetches), and the first cut caught its throw locally
  // and returned from inside the `try` — which bypassed `armRetryIfTransient`, the only place a
  // lost-connectivity failure earns this slot's one early re-attempt. Every OTHER setup-step throw
  // (worktree creation, guard install, integrity assert) reaches the outer catch and does arm it.
  // The scheduler has already stamped `lastRunAt`, so the slot was spent either way: a connectivity
  // blip cost a full hour of no pass, where before the gate existed it cost nothing at all.
  // roborev 55239.
  it("a connectivity-shaped park throw still arms the slot's one re-attempt", async () => {
    harness.parkImpl = () => Promise.reject(new Error("getaddrinfo ENOTFOUND github.com"));

    await withWarnSpy(async () => {
      await runImprovementPass("always", true);

      // THE SIDE EFFECT: an armed retry, not merely a warning. A local catch would leave this null.
      expect(passRetryDueAt()).not.toBeNull();
      expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).toBe("lapsed");
      expectNoRunInvoked();
    });
  });

  // A decline is PERMANENT for the reasons that reach it — a stash cannot save a commit, so nothing
  // in the pass, the app, or the next hour's park can clear `unpushed`. A recoloured row with no
  // text is then the same shape the Rust side just removed, relocated from "runs forever from a
  // stale base" to "never runs again". So the reason is written where someone will actually read it.
  // roborev 55239.
  //
  // ⚠️ THIS GOT STRICTLY MORE IMPORTANT WHEN THE FIRST REFUSALS WENT AMBER, and it very nearly went
  // the other way: `runtimeStore.setStatus` DROPS `attentionScreen[agentId]` whenever the incoming
  // status is outside the red tier (sparkle-99o9a), so with the writes in their original order the
  // amber status wiped the remedy text on the next line — an amber row with no explanation anywhere,
  // which is worse than the red row the change removes. The service writes the STATUS FIRST for that
  // reason; this test is what pins it, and the assertion below is deliberately paired with the
  // status so a re-reordering cannot go green.
  it("writes a readable reason and remedy where the user (and the concierge) will see it", async () => {
    harness.parkImpl = () => Promise.resolve({ parked: false, reason: "unpushed" });

    await withWarnSpy(async () => {
      await runImprovementPass("always");

      // `attentionScreen` is what the pane shows for a red agent, what the phone relays, and what
      // `read_agent_terminal` returns at tier (b) — so this one write reaches every surface.
      const screen = useRuntimeStore.getState().attentionScreen[SPARKLE_AGENT_ID] ?? "";
      expect(screen).toBe(refusalDetail("unpushed"));
      // PAIRED WITH THE STATUS. The row is AMBER and the text is still there — asserting the text
      // alone would pass on a row that had been left red, which is the thing this change removes.
      expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).toBe("lapsed");
      // It must NAME A REMEDY, not just restate the machine token: a user told "unpushed" has no
      // way to know the thing to act on is a branch in a worktree they have never opened.
      expect(screen).toMatch(/push that branch|delete it/i);
      expect(screen).not.toMatch(/^unpushed$/);
    });
  });

  // ...AND RETRACTS IT once it stops being true. Nothing else clears `attentionScreen`, and this is
  // not cosmetic residue: it is tier (b) of `readAgentTerminal`, so a stale "can't start a pass —
  // push that branch" would be handed to the concierge as this agent's CURRENT screen and relayed in
  // the present tense while the pass it describes was running fine. This branch is what exposed it,
  // by making the agent readable at all. roborev.
  it("clears the refusal text once a later pass actually starts", async () => {
    // A refusal happens...
    harness.parkImpl = () => Promise.resolve({ parked: false, reason: "unpushed" });
    await withWarnSpy(async () => {
      await runImprovementPass("always");
    });
    expect(useRuntimeStore.getState().attentionScreen[SPARKLE_AGENT_ID]).toBeTruthy();

    // ...and the next hour the blocker is gone.
    harness.parkImpl = () => Promise.resolve({ parked: true, reason: "parked" });
    const pass = runImprovementPass("always", true);
    await untilRunInvoked();
    // THE SIDE EFFECT: cleared by the time the pass is actually running, so a read taken now cannot
    // return the old refusal.
    expect(useRuntimeStore.getState().attentionScreen[SPARKLE_AGENT_ID] ?? "").toBe("");
    harness.handlers.get("sparkle_improve:done")?.({ payload: { sessionId: "s", text: "" } });
    await pass;
  });

  // Every reason the gate can see gets a sentence — including one it does not enumerate. A refusal
  // that fell through to an empty string would put a red row on screen explaining nothing, which is
  // the state this whole surface exists to remove.
  it("has a remedy sentence for every decline reason, including an unknown one", () => {
    for (const reason of ["in-use", "unpushed", "dirty", "no-base", "checkout-failed", "something-new"]) {
      const text = refusalDetail(reason);
      expect(text.length, reason).toBeGreaterThan(40);
      expect(text, reason).toMatch(/Improve Sparkle/);
    }
    // The fallback still names the machine token, so a reason nobody wrote copy for is at least
    // diagnosable from what the user can see.
    expect(refusalDetail("something-new")).toContain("something-new");
  });

  // `in-use` is the lease-guard decline (bead sparkle-hc7hvm): a LIVE interactive session holds the
  // shared worktree, so the pass skipped rather than reset that session's branch. Its copy must read
  // as a self-clearing SKIP, not a "you must act" fault — and it must promise it runs again on its
  // own, so a user is not sent to clear a workspace that is fine. Pinning the SIDE the copy takes,
  // not just that some sentence exists.
  it("names the in-use decline as a transient, self-clearing skip", () => {
    const text = refusalDetail("in-use");
    expect(text).toMatch(/interactive session/i);
    expect(text).toMatch(/run again on its own once the session ends/i);
    // It must NOT tell the user their workspace is broken or that they must clear/push anything —
    // that is the copy the genuinely-stuck reasons carry, and following it here would be wrong.
    expect(text).not.toMatch(/push that branch|delete it|by hand/i);
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
    // A deliberate handoff is not a failure at all — not even the amber "unfinished" tier, which
    // would claim the pass still owes this hour something. It doesn't; the pane took over.
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
    // the cancel hook, or a genuinely hung pass would be quietly recorded as a handoff and land on
    // the calm `idle` instead of the "unfinished" `lapsed` a timeout earns.
    await withWarnSpy(async (warn) => {
      const pass = runImprovementPass("always");
      await untilRunInvoked();

      await vi.advanceTimersByTimeAsync(PASS_TIMEOUT_MS);
      await pass;

      expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).toBe("lapsed");
      expect(warn).toHaveBeenCalledWith(
        "improvement pass failed:",
        expect.stringContaining("timed out"),
      );
    });
  });

  // A killed pass is the single most common way a pass fails (measured: ~1 in 5), and the timeout
  // line alone cannot tell "30 minutes of edits went in the bin" from "it had already pushed".
  // These pin the after-the-kill probe that answers it — and, in the last one, pin that the probe
  // is confined to timeouts, since parking on any other failure would move the worktree out from
  // under the connectivity retry armed on the very next line.
  describe("what a killed pass left behind", () => {
    /** Park outcomes to hand back in order: index 0 is the pass's own startup park, index 1 is the
     *  post-kill probe. Positional on purpose — asserting on the SECOND call is what distinguishes
     *  a probe that ran from a startup park being miscounted as one. */
    function planParks(
      first: import("./worktree").ParkOutcome,
      ...rest: Array<import("./worktree").ParkOutcome>
    ) {
      const outcomes = [first, ...rest];
      let n = 0;
      // The clamp keeps a probe that runs when none was planned from getting `undefined` — it
      // repeats the last outcome instead, so the miscount shows up as the call-count assertion
      // failing rather than as a crash inside the service.
      harness.parkImpl = () =>
        Promise.resolve(outcomes[Math.min(n++, outcomes.length - 1)] ?? first);
      return () => n;
    }

    it("names the leftovers, and the drift they cause, when the probe declines", async () => {
      const { parkWorktreeOnBase } = await import("./worktree");
      const parks = planParks(
        { parked: true, reason: "parked" },
        { parked: false, reason: "dirty" },
      );
      await withWarnSpy(async (warn) => {
        const pass = runImprovementPass("always");
        await untilRunInvoked();
        await vi.advanceTimersByTimeAsync(PASS_TIMEOUT_MS);
        await pass;

        expect(parks()).toBe(2);
        expect(warn).toHaveBeenCalledWith(
          "improvement pass: the killed pass left work behind —",
          "dirty",
          "— the next pass will start from a stale base",
        );
        // THE PROBE MUST STAY ON "decline" — the startup park's "stash" would be actively wrong
        // here. This probe exists to REPORT what the killed pass left behind, and stashing would
        // relocate the very leftovers it is reporting on: the answer would come back "nothing at
        // risk" because asking the question had already moved it. Nothing else pins the argument,
        // and the mistake is a one-word edit that no other assertion in this file would notice.
        expect(vi.mocked(parkWorktreeOnBase).mock.calls[1]).toEqual([
          "/app-data/oss",
          SPARKLE_PROJECT_ID,
          SPARKLE_AGENT_ID,
          "main",
          "decline",
        ]);
      });
    });

    it.each(["parked", "already-fresh"] as const)(
      "reports nothing at risk when the probe comes back %s",
      async (reason) => {
        // Both shapes mean the same thing to the caller — the kill destroyed nothing — and
        // `already-fresh` is the one a declined-park regression would most easily mislabel as
        // leftovers, since it is a NOT-parked outcome that is nonetheless clean.
        planParks(
          { parked: true, reason: "parked" },
          { parked: reason === "parked", reason },
        );
        await withWarnSpy(async (warn) => {
          const pass = runImprovementPass("always");
          await untilRunInvoked();
          await vi.advanceTimersByTimeAsync(PASS_TIMEOUT_MS);
          await pass;

          expect(warn).toHaveBeenCalledWith(
            "improvement pass: the killed pass left nothing at risk in the worktree",
          );
        });
      },
    );

    it("a failure that is not a timeout is not probed at all", async () => {
      const parks = planParks({ parked: true, reason: "parked" });
      await withWarnSpy(async (warn) => {
        const pass = runImprovementPass("always");
        await untilRunInvoked();
        harness.handlers.get("sparkle_improve:error")?.({
          payload: { message: "You've hit your weekly limit" },
        });
        await pass;

        // The startup park and nothing more.
        expect(parks()).toBe(1);
        expect(warn).toHaveBeenCalledWith(
          "improvement pass failed:",
          expect.stringContaining("weekly limit"),
        );
        expect(
          warn.mock.calls.some((c) => String(c[0]).includes("the killed pass left")),
        ).toBe(false);
      });
    });

    it("an indeterminate park reason is NOT reported as lost work", async () => {
      // `no-worktree`/`no-base`/`checkout-failed` mean the probe could not conclude. Calling those
      // leftovers would put back the same ambiguity this change removes, and the stale-base
      // prediction is simply false for them.
      planParks({ parked: true, reason: "parked" }, { parked: false, reason: "no-base" });
      await withWarnSpy(async (warn) => {
        const pass = runImprovementPass("always");
        await untilRunInvoked();
        await vi.advanceTimersByTimeAsync(PASS_TIMEOUT_MS);
        await pass;

        expect(warn).toHaveBeenCalledWith(
          "improvement pass: could not tell what the killed pass left behind —",
          "no-base",
        );
        expect(
          warn.mock.calls.some((c) => String(c[0]).includes("left work behind")),
        ).toBe(false);
      });
    });

    it("does not touch the worktree until the kill invoke has returned", async () => {
      // The probe is not read-only — park stashes and checks out — so running it while the process
      // group is still being reaped would check out over a `claude` that is still writing, and
      // sample the tree before its writes stopped. Ordering is the whole guard.
      let cancelDone!: () => void;
      harness.invokeImpl = (cmd) =>
        cmd === "sparkle_improve_cancel"
          ? new Promise<void>((r) => {
              cancelDone = r;
            })
          : undefined;
      const parks = planParks({ parked: true, reason: "parked" });
      await withWarnSpy(async () => {
        const pass = runImprovementPass("always");
        await untilRunInvoked();
        await vi.advanceTimersByTimeAsync(PASS_TIMEOUT_MS);

        // Kill still in flight: the startup park and nothing more.
        expect(parks()).toBe(1);
        cancelDone();
        await pass;
        expect(parks()).toBe(2);
      });
    });

    it.each([
      ["the kill wait expires", "expire" as const],
      ["the kill invoke rejects", "reject" as const],
    ])("leaves the worktree untouched when %s", async (_name, mode) => {
      // These are the cases where the process group is most likely STILL ALIVE, which makes
      // falling through into park worst exactly where it is least safe: park stashes and checks
      // out, so it would destroy the work it exists to report on. A diagnostic is not worth a
      // worktree — no park at all, and a line that says so.
      harness.invokeImpl = (cmd) =>
        cmd === "sparkle_improve_cancel"
          ? mode === "reject"
            ? Promise.reject(new Error("kill failed"))
            : new Promise<void>(() => {}) // never returns
          : undefined;
      const parks = planParks({ parked: true, reason: "parked" });
      await withWarnSpy(async (warn) => {
        const pass = runImprovementPass("always");
        await untilRunInvoked();
        await vi.advanceTimersByTimeAsync(PASS_TIMEOUT_MS);
        await vi.advanceTimersByTimeAsync(PROBE_KILL_WAIT_MS);
        await pass;

        // The startup park and nothing more.
        expect(parks()).toBe(1);
        expect(warn).toHaveBeenCalledWith(
          "improvement pass: could not confirm the kill, so the worktree was left untouched " +
            "and unexamined",
        );
        // The bound exists so a diagnostic can never end the hourly loop.
        expect(isPassRunning()).toBe(false);
        expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).toBe("lapsed");
      });
    });

    it("a park that never returns cannot hold the hourly loop", async () => {
      // The probe is awaited BEFORE the latch is released, and park takes the per-repo git lock and
      // fetches. Unbounded, it would reintroduce the exact wedge the watchdog exists to prevent —
      // on the most common failure path.
      planParks({ parked: true, reason: "parked" });
      let n = 0;
      harness.parkImpl = () =>
        n++ === 0
          ? Promise.resolve({ parked: true, reason: "parked" })
          : new Promise(() => {}); // never settles
      await withWarnSpy(async (warn) => {
        const pass = runImprovementPass("always");
        await untilRunInvoked();
        await vi.advanceTimersByTimeAsync(PASS_TIMEOUT_MS);
        await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
        await pass;

        expect(warn).toHaveBeenCalledWith(
          "improvement pass: gave up waiting to see what the killed pass left behind",
        );
        expect(isPassRunning()).toBe(false);
        expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).toBe("lapsed");
      });
    });

    it("a probe that throws is swallowed — the pass still ends lapsed, with the latch released", async () => {
      let n = 0;
      harness.parkImpl = () =>
        n++ === 0
          ? Promise.resolve({ parked: true, reason: "parked" })
          : Promise.reject(new Error("git is busy"));
      await withWarnSpy(async (warn) => {
        const pass = runImprovementPass("always");
        await untilRunInvoked();
        await vi.advanceTimersByTimeAsync(PASS_TIMEOUT_MS);
        await expect(pass).resolves.toBeUndefined();

        expect(isPassRunning()).toBe(false);
        expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).toBe("lapsed");
        expect(warn).toHaveBeenCalledWith(
          "improvement pass: could not tell what the killed pass left behind:",
          expect.any(Error),
        );
      });
    });
  });

  it("a partial listen failure still unlistens the fulfilled registration", async () => {
    // The leak this suite's service fix exists for (roborev #24516 → 23912a26): done registers,
    // error rejects → the fulfilled done handle must still be torn down, the pass must park on
    // lapsed with the latch released, and no run must be spawned.
    harness.listenImpl = (name) =>
      name === "sparkle_improve:error"
        ? Promise.reject(new Error("event bus unavailable"))
        : undefined;

    await runImprovementPass("always");

    expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).toBe("lapsed");
    expect(isPassRunning()).toBe(false);
    // The one that DID register was unlistened — this is the assertion that catches the leak.
    expect(harness.handlers.size).toBe(0);
    expect(harness.invokes.some((c) => c.cmd === "sparkle_improve_run")).toBe(false);
    await vi.advanceTimersByTimeAsync(PASS_TIMEOUT_MS * 2);
    expect(harness.invokes.some((c) => c.cmd === "sparkle_improve_cancel")).toBe(false);
  });
});

// THE ROW IS GREEN FOR THE WHOLE PASS, INCLUDING SETUP — not only once the run invoke fires.
//
// A build agent's row goes green the instant its PTY spawns; the headless pass has no PTY and no
// StatusEngine, so its row is driven only by the explicit `setStatus` calls in the service. `working`
// used to be claimed AFTER the networked preamble (clone → worktree → fetch-heavy park), so the row
// sat GRAY (the previous pass's idle/stopped) for that whole window while the pass was actively
// working. These pin that the green now starts at the top of the work, and that it still sits BEHIND
// the Claude-installed gate so a machine that will never run is not falsely painted green.
describe("row is working from the start of the pass, not the end of setup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHarness();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is already GREEN by the time the (slow, networked) setup runs, not only at the run invoke", async () => {
    // Deterministic and timing-free: capture the row status at the exact moment the FIRST setup step
    // runs — `ensureSparkleRepo`, which on a cold start is the OSS clone (minutes) and is the head of
    // the whole preamble. Before the fix, `working` was set only after this + the worktree + the
    // fetch-heavy park, so the row still read the reset `stopped` here; the pass was actively working
    // and the dot was gray. After it, `working` is already claimed by the time setup begins.
    const { ensureSparkleRepo } = await import("./sparkleAgent");
    let statusAtSetup: string | undefined = "UNSET";
    vi.mocked(ensureSparkleRepo).mockImplementationOnce(async () => {
      statusAtSetup = useRuntimeStore.getState().status[SPARKLE_AGENT_ID];
      return { repoPath: "/app-data/oss", logDir: "/app-data/logs", defaultBranch: "main" };
    });

    const pass = runImprovementPass("always");
    await untilRunInvoked();
    harness.handlers.get("sparkle_improve:done")?.({ payload: { sessionId: "s", text: "" } });
    await pass;

    // THE SIDE EFFECT: green while the pass is still in its setup, not merely once it spawns.
    expect(statusAtSetup).toBe("working");
  });

  it("does NOT go green when Claude is not installed — the green sits behind the install gate", async () => {
    // The negative that keeps the fix from drifting into a false-green: a machine with no Claude runs
    // no turn at all, so painting it green would show work that never happens. `working` must stay
    // BELOW the `!claude.installed` return — moving it above turns this red.
    const { checkClaude } = await import("../preflight");
    vi.mocked(checkClaude).mockResolvedValueOnce({ installed: false, path: null, version: null });

    await runImprovementPass("always");

    expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).not.toBe("working");
    expectNoRunInvoked();
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

// THE WIRING, not the helper. `services/sparkleTranscript` had its own unit tests and the whole suite
// still went green with BOTH of its call sites deleted (roborev 55363) — the vacuous shape AGENTS.md
// calls the #1 fleet-wide finding. What has to hold is the end-to-end fact the user asked for: while
// an hourly pass is running, with no pane and no PTY anywhere, `read_agent_terminal` on the Improve
// Sparkle agent returns what that agent is saying.
describe("readable while a headless pass runs", () => {
  const TRANSCRIPT = "/home/u/.claude/projects/-wt-sparkle-self/this-pass.jsonl";
  /** The file's STEM is its session id — the convention `transcript.rs`'s `session_id_of` encodes,
   *  and what `registerSparkleTranscript` records off the resolve above. */
  const TRANSCRIPT_SESSION = "this-pass";
  const SAID = "I looked at the logs and I'd prioritise the park refusal.";

  beforeEach(() => {
    vi.useFakeTimers();
    resetHarness();
    // A worktree Claude has run in: the resolve answers, and the transcript has an assistant turn.
    //
    // TWO RESOLVE COMMANDS, and keeping them distinct is the point (roborev 63135).
    // `claude_latest_session_path` is the unfiltered LEARN seam — how the app DISCOVERS a session id
    // it does not have yet. `agent_own_session_path` is the READ seam, and it answers only for a
    // session the caller has already established is this agent's, which is why the stub honours the
    // filter instead of returning the path unconditionally: a stub that ignored `sessionIds` would
    // pass just as well against a reader that never sent them.
    harness.invokeImpl = (cmd, args) => {
      if (cmd === "claude_latest_session_path") return Promise.resolve(TRANSCRIPT);
      if (cmd === "agent_own_session_path") {
        const ids = (args as { sessionIds?: string[] } | undefined)?.sessionIds;
        return Promise.resolve(ids?.includes(TRANSCRIPT_SESSION) ? TRANSCRIPT : null);
      }
      if (cmd === "read_transcript_last_assistant") return Promise.resolve(SAID);
      return undefined;
    };
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers a concierge read from the transcript once the pass has started", async () => {
    // Nothing is readable before the pass — no pane, no ask-screen, no registration.
    expect((await readAgentTerminal(SPARKLE_AGENT_ID)).source).toBe("none");

    const pass = runImprovementPass("always");
    await untilRunInvoked();

    const read = await readAgentTerminal(SPARKLE_AGENT_ID);
    expect(read.source).toBe("transcript");
    expect(read.text).toContain("park refusal");

    // …and the file was found via THE PASS'S OWN worktree, not a path derived from the agent id.
    expect(harness.invokes).toEqual(
      expect.arrayContaining([
        { cmd: "claude_latest_session_path", args: { worktreePath: "/wt/sparkle-self" } },
      ]),
    );

    harness.handlers.get("sparkle_improve:done")?.({ payload: { sessionId: "s", text: "done" } });
    await pass;
  });

  it("registers nothing when the pass refuses to start", async () => {
    // The registration sits AFTER the park gate, so a refusal must leave tier (d) with nothing —
    // the refusal text (tier (b)) is the honest answer, and a transcript from a worktree this pass
    // never ran in would be last hour's conversation dressed as this one.
    //
    // ASSERTED THROUGH TIER (d) WITH TIER (b) CLEARED, which is the whole point (roborev 55513): the
    // read stops at the freshest hit, so while the ask-screen holds the refusal text, tier (d) is
    // skipped as "not needed" and never consulted. Every assertion about it is then true whether the
    // registration happened or not — including the one this test used to make. Clearing the
    // ask-screen first is what forces the chain down to the tier under test.
    harness.parkImpl = () => Promise.resolve({ parked: false, reason: "unpushed" });
    await withWarnSpy(async () => {
      await runImprovementPass("always");
    });
    expectNoRunInvoked();
    expect((await readAgentTerminal(SPARKLE_AGENT_ID)).source).toBe("attention-screen");

    useRuntimeStore.getState().setAttentionScreen(SPARKLE_AGENT_ID, "");
    const read = await readAgentTerminal(SPARKLE_AGENT_ID);
    expect(read.source).toBe("none");
    expect(read.attempts.find((a) => a.source === "transcript")?.why).toContain(
      "no transcript path is known",
    );
  });

  // WHICH SESSION IS THIS PASS'S — the binding the mounted transcript reads by, and the one thing a
  // headless pass could not previously supply (roborev 63133 / 63135). It has no pane, so
  // `AgentPane`'s gated hook writer never fires for it; the mounted pane then failed closed and
  // rendered nothing for the app-owned agent, forever.
  //
  // The discriminator is deliberate: the resolve is planted to answer with LAST hour's file, which
  // is exactly what a directory scan can see at registration time (the pass has not spawned yet and
  // spawns with no `--resume`). So an id that the scan could not have produced is proof the pass's
  // OWN announcement reached the registry — not that something bound something.
  it("binds the session the pass is actually writing, which the directory scan cannot see", async () => {
    const LAST_PASS = "/home/u/.claude/projects/-wt-sparkle-self/last-pass.jsonl";
    harness.invokeImpl = (cmd) => {
      if (cmd === "claude_latest_session_path") return Promise.resolve(LAST_PASS);
      return undefined;
    };

    const pass = runImprovementPass("always");
    await untilRunInvoked();

    // All the app can know before Claude speaks: the previous pass's session.
    expect(agentSessionIds(SPARKLE_AGENT_ID)).toEqual(["last-pass"]);

    // Rust announces the live session off Claude's own first stream line (`system/init`).
    harness.handlers
      .get("sparkle_improve:session")
      ?.({ payload: { sessionId: "this-pass-live" } });

    // ACCUMULATED, not replaced: this pass is readable AND the previous one still is.
    expect(agentSessionIds(SPARKLE_AGENT_ID)).toEqual(["last-pass", "this-pass-live"]);

    harness.handlers.get("sparkle_improve:done")?.({ payload: { sessionId: "s", text: "done" } });
    await pass;

    // The listener is torn down with its siblings, so a late announcement cannot bind an id into a
    // pass that is already over.
    expect(harness.handlers.size).toBe(0);
  });

  // THE ID ON `done` IS AUTHORITATIVE TOO, and it used to be typed, destructured and thrown away
  // (roborev 63231). `handle_event` re-assigns `session_id` on the `result` event, so a pass that
  // forked or continued mid-flight finishes in a DIFFERENT file than the one it announced at
  // `system/init` — and the early announcement is once-only by design, so nothing else can catch it.
  // That final file is the TAIL of the conversation the pane is opened to read.
  //
  // The two ids are deliberately different here: with them equal the case would pass on the
  // announcement alone and prove nothing about `done`.
  it("also binds the session the pass FINISHED in, when it differs from the announced one", async () => {
    harness.invokeImpl = (cmd) =>
      cmd === "claude_latest_session_path" ? Promise.resolve(null) : undefined;

    const pass = runImprovementPass("always");
    await untilRunInvoked();

    harness.handlers.get("sparkle_improve:session")?.({ payload: { sessionId: "announced-at-init" } });
    harness.handlers
      .get("sparkle_improve:done")
      ?.({ payload: { sessionId: "forked-and-finished-here", text: "done" } });
    await pass;

    expect(agentSessionIds(SPARKLE_AGENT_ID)).toEqual([
      "announced-at-init",
      "forked-and-finished-here",
    ]);
  });

  // …and `done` binds on its OWN, with no announcement in front of it.
  //
  // THIS CASE USED TO FIRE BOTH EVENTS WITH THE SAME ID, and so proved nothing (roborev 63251):
  // the `session` handler alone recorded "one-session", making the assertion true whether or not
  // `done` ever called `noteAgentSessionId` — it was already true against the pre-change code. Its
  // comment claimed to pin the set-add contract "at THIS call site", but the only thing it actually
  // re-asserted was the registry's dedup, which `agentTranscriptRegistry.test.ts` owns directly.
  //
  // Dropping the announcement is what makes the bind observable: this is now the only writer, so
  // deleting it empties the set. Dedup stays where it is tested on its own terms.
  it("binds the finishing id from `done` alone, with no announcement before it", async () => {
    harness.invokeImpl = (cmd) =>
      cmd === "claude_latest_session_path" ? Promise.resolve(null) : undefined;

    const pass = runImprovementPass("always");
    await untilRunInvoked();

    harness.handlers
      .get("sparkle_improve:done")
      ?.({ payload: { sessionId: "one-session", text: "done" } });
    await pass;

    expect(agentSessionIds(SPARKLE_AGENT_ID)).toEqual(["one-session"]);
  });

  // ── THE FAILING PASS BINDS ITS SESSION TOO ──────────────────────────────────────────────────
  //
  // roborev 63251, finding 3. The bind covered only the clean exit, while Rust held `session_id` on
  // the failure branch and dropped it — so the exact scenario the `done` bind exists for (a pass
  // that forked mid-flight, leaving the once-only announcement naming a different file than the
  // final one) left the tail unreadable whenever the pass FAILED, which is both the more common
  // ending and the one someone is most likely to open the pane for.
  it("binds the session a FAILED pass wrote, which is the ending most likely to be read", async () => {
    harness.invokeImpl = (cmd) =>
      cmd === "claude_latest_session_path" ? Promise.resolve(null) : undefined;

    const pass = runImprovementPass("always");
    await untilRunInvoked();

    harness.handlers
      .get("sparkle_improve:error")
      ?.({ payload: { message: "claude exited 1", sessionId: "written-then-failed" } });
    await pass;

    expect(agentSessionIds(SPARKLE_AGENT_ID)).toEqual(["written-then-failed"]);
    // The pass still ENDED — the bind is additive, not a path that swallows the failure. Asserted
    // as the teardown the settle performs, since `runImprovementPass` resolves to void and the
    // outcome is not observable from its return.
    expect(harness.handlers.size).toBe(0);
  });

  // NO CASE HERE FOR AN EMPTY SESSION ID, deliberately — and the deletion is the fix, not a gap
  // (roborev 63344).
  //
  // One stood here asserting `agentSessionIds(...) === undefined` after an error payload carrying
  // `sessionId: ""`, and it was VACUOUS in the same way as the case retired above.
  // `noteAgentSessionId` already short-circuits a blank id of its own accord
  // (`agentTranscriptRegistry.ts`: `const id = sessionId.trim(); if (id === "" …) return;`), so
  // deleting the `if (ev.payload.sessionId)` guard from the error handler leaves the registry empty
  // and that assertion green — true with and against the line it existed to pin.
  //
  // The property is owned directly by `agentTranscriptRegistry.test.ts` ("ignores blank ids rather
  // than binding an empty session"), exactly as the dedup it was retired for re-asserting. Pinning
  // it HERE instead needs the call itself observed — a spy on `noteAgentSessionId` — and the source
  // imports it as a direct named binding, so that means module-wide mocking which would take the
  // real registry away from every other case in this file. Not worth it for a property already
  // covered one layer down.
});

// ── Which Claude account the hourly pass runs under (PRD/sparkle/account-rotation.md Phase 0) ──
//
// THE BUG THIS COVERS. `sparkle_improve_run` was handed no account at all, so the pass authenticated
// from `$HOME/.claude` — the `isDefault` account — no matter which account the human had selected.
// That is one of the three separate logins they were forced to perform, and it meant an exhausted
// default account silently killed the hourly improvement loop with no way to move it.
//
// Asserted on the INVOKE PAYLOAD, because that is the entire mechanism: `configDir` reaching Rust is
// what binds the child, and nothing else in the pass observes the account.
describe("improvement pass account binding", () => {
  const ACCOUNTS = [
    { id: "def", nickname: "Default", configDir: "/home/.claude", isDefault: true, createdAt: 1 },
    { id: "work", nickname: "Work", configDir: "/data/accounts/work", isDefault: false, createdAt: 2 },
  ];

  /** The accounts backend, layered under the harness default so the rest of the pass preamble
   *  (preflight, submit-capability, …) keeps its normal `Promise.resolve()` behaviour. */
  function withAccounts() {
    harness.invokeImpl = (cmd) => {
      if (cmd === "accounts_list") return Promise.resolve(ACCOUNTS);
      if (cmd === "accounts_usage") return Promise.resolve([]);
      if (cmd === "accounts_identities") return Promise.resolve([]);
      return undefined;
    };
  }

  /** The `configDir` the pass sent to Rust. */
  function runConfigDir(): string | null | undefined {
    const call = harness.invokes.find((c) => c.cmd === "sparkle_improve_run");
    if (!call) throw new Error("expected a sparkle_improve_run invoke");
    return (call.args as { configDir?: string | null }).configDir;
  }

  /** Drive one pass to completion so the latch is released for the next test. */
  async function completePass(consent: "always" | "case_by_case" = "always") {
    const pass = runImprovementPass(consent);
    await untilRunInvoked();
    harness.handlers.get("sparkle_improve:done")?.({ payload: { sessionId: "s", text: "done" } });
    await pass;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    resetHarness();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the pass under the selected account", async () => {
    withAccounts();
    await completePass();
    expect(runConfigDir()).toBe("/home/.claude");
  });

  it("follows the account SWITCH on the next pass — the Phase 0 goal for this consumer", async () => {
    withAccounts();
    await completePass();
    expect(runConfigDir()).toBe("/home/.claude");

    // The human moves Improve Sparkle to another account. Keyed by SPARKLE_AGENT_ID, so this is the
    // same pin the interactive pane honours — the two share a worktree and must not disagree.
    setPin(SPARKLE_AGENT_ID, "work");
    invalidateAccountState();
    harness.invokes.length = 0;

    await completePass();
    expect(runConfigDir()).toBe("/data/accounts/work");
  });

  it("still runs the pass when the account backend is broken", async () => {
    // Inheriting the default account is degraded; skipping the hourly pass entirely is worse.
    harness.invokeImpl = (cmd) =>
      cmd.startsWith("accounts_") ? Promise.reject(new Error("ipc down")) : undefined;
    invalidateAccountState();
    await withWarnSpy(async () => {
      await completePass();
    });
    expect(runConfigDir()).toBeNull();
  });

  it("stays on the last known account when the lookup hiccups, rather than relocating", async () => {
    // A transient IPC failure must not move the pass to the DEFAULT account's tree. The interactive
    // pane shares this worktree and resolves its own (sticky) account, so a pass that silently
    // relocated would write its transcript where the pane will not look — the shared-conversation
    // divergence, caused by a hiccup instead of a real account change.
    withAccounts();
    setPin(SPARKLE_AGENT_ID, "work");
    await completePass();
    expect(runConfigDir()).toBe("/data/accounts/work");

    harness.invokes.length = 0;
    harness.invokeImpl = (cmd) =>
      cmd.startsWith("accounts_") ? Promise.reject(new Error("ipc hiccup")) : undefined;
    invalidateAccountState();
    await withWarnSpy(async () => {
      await completePass();
    });
    expect(runConfigDir()).toBe("/data/accounts/work");
  });
});

// ── The control MCP on the HEADLESS pass, bead sparkle-hdlhox ────────────────────────────────────
//
// The pass already DRAINS its inbox (`build_improve_exec` exports SPARKLE_INBOX_AGENT), so before
// this it could be told things and had no way to answer. Half-duplex is the original defect
// relocated: the concierge's job on this channel is to reply "that contradicts what I observe", and
// a correction the corrected party cannot respond to ends the exchange rather than starting one.
//
// Asserted at the REAL call site. The Rust unit tests cover `build_improve_exec`'s flag emission;
// what only this suite can see is whether anything ever PASSES a config to it — the same class of
// gap that left the interactive pane with no `mcpConfig` for as long as it did.
describe("headless pass — sparkle-control MCP (bead sparkle-hdlhox)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHarness();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The two invokes `buildPassControlMcp` makes, answered as the real bridge would. */
  const bridgeUp = (cmd: string): Promise<unknown> | undefined => {
    if (cmd === "start_control_bridge")
      return Promise.resolve({ socketPath: "/tmp/ctrl.sock", token: "tok" });
    if (cmd === "control_mcp_paths")
      return Promise.resolve({ nodePath: "/usr/bin/node", serverPath: "/app/server.js" });
    return undefined;
  };

  it("hands sparkle_improve_run a config naming the control server and THIS agent's id", async () => {
    harness.invokeImpl = bridgeUp;
    const pass = runImprovementPass("always");
    await untilRunInvoked();

    const run = harness.invokes.find((c) => c.cmd === "sparkle_improve_run");
    const args = run?.args as { mcpConfig?: string; persona?: string } | undefined;
    expect(args?.mcpConfig).toContain("sparkle-control");
    // The anti-spoofing caller identity. A wrong id here would make every per-agent op this pass
    // issues resolve to some other agent — silently, since the op would still succeed.
    expect(args?.mcpConfig).toContain("__sparkle_self__");
    // The tools are useless unadvertised: the discovery prose must ride with the config.
    expect(args?.persona).toContain("CONTROLLING THE SPARKLE UI");

    harness.handlers.get("sparkle_improve:done")?.({ payload: { sessionId: "s", text: "" } });
    await pass;
  });

  it("STILL RUNS when the bridge is down, with no flag and no advertisement", async () => {
    // The paired negative and the degradation contract, which matters more here than anywhere else
    // in this change: an hourly unattended pass that died because a socket was slow would be a far
    // worse regression than one with no cross-agent tools. `undefined` must reach Rust so NO flag
    // is emitted — never an empty string, which `claude` would reject and which would take the
    // whole pass down.
    harness.invokeImpl = (cmd) =>
      cmd === "start_control_bridge" ? Promise.reject(new Error("no bridge")) : undefined;
    const pass = runImprovementPass("always");
    await untilRunInvoked();

    const run = harness.invokes.find((c) => c.cmd === "sparkle_improve_run");
    const args = run?.args as { mcpConfig?: string; persona?: string } | undefined;
    expect(args?.mcpConfig).toBeUndefined();
    expect(args?.persona).not.toContain("CONTROLLING THE SPARKLE UI");
    // …and the pass itself is completely intact: same persona, same prompt, same run.
    expect(args?.persona).toContain("Sparkle Improvement Agent");

    harness.handlers.get("sparkle_improve:done")?.({ payload: { sessionId: "s", text: "" } });
    await pass;
  });

  it("still tells the headless persona about the channel even with no MCP", async () => {
    // The address book and the send are named in the persona unconditionally, because the pass may
    // be resumed by the interactive pane (which shares this worktree and DOES have the tools). The
    // channel section is not gated on the bridge; only the UI-control prose is.
    harness.invokeImpl = (cmd) =>
      cmd === "start_control_bridge" ? Promise.reject(new Error("no bridge")) : undefined;
    const pass = runImprovementPass("always");
    await untilRunInvoked();

    const run = harness.invokes.find((c) => c.cmd === "sparkle_improve_run");
    const persona = (run?.args as { persona?: string } | undefined)?.persona ?? "";
    expect(persona).toContain("sparkle:concierge");
    expect(persona).toContain("send_peer_message");

    harness.handlers.get("sparkle_improve:done")?.({ payload: { sessionId: "s", text: "" } });
    await pass;
  });
});
