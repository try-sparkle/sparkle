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
  PROBE_KILL_WAIT_MS,
  PROBE_TIMEOUT_MS,
  refusalDetail,
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
  it("an UNPUSHED park is a gate: the pass never spawns and the row goes blocked", async () => {
    harness.parkImpl = () => Promise.resolve({ parked: false, reason: "unpushed" });

    await withWarnSpy(async (warn) => {
      await runImprovementPass("always");

      // The side effect is the claim: no `claude` was spawned against a base we cannot describe.
      expectNoRunInvoked();
      expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).toBe("blocked");
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
      expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).toBe("blocked");
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
      expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).toBe("blocked");
      expectNoRunInvoked();
    });
  });

  // A decline is PERMANENT for the reasons that reach it — a stash cannot save a commit, so nothing
  // in the pass, the app, or the next hour's park can clear `unpushed`. A red row with no text is
  // then the same shape the Rust side just removed, relocated from "runs forever from a stale base"
  // to "never runs again". So the reason is written where someone will actually read it. roborev
  // 55239.
  it("writes a readable reason and remedy where the user (and the concierge) will see it", async () => {
    harness.parkImpl = () => Promise.resolve({ parked: false, reason: "unpushed" });

    await withWarnSpy(async () => {
      await runImprovementPass("always");

      // `attentionScreen` is what the pane shows for a red agent, what the phone relays, and what
      // `read_agent_terminal` returns at tier (b) — so this one write reaches every surface.
      const screen = useRuntimeStore.getState().attentionScreen[SPARKLE_AGENT_ID] ?? "";
      expect(screen).toBe(refusalDetail("unpushed"));
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
    for (const reason of ["unpushed", "dirty", "no-base", "checkout-failed", "something-new"]) {
      const text = refusalDetail(reason);
      expect(text.length, reason).toBeGreaterThan(40);
      expect(text, reason).toMatch(/Improve Sparkle/);
    }
    // The fallback still names the machine token, so a reason nobody wrote copy for is at least
    // diagnosable from what the user can see.
    expect(refusalDetail("something-new")).toContain("something-new");
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
        expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).toBe("blocked");
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
        expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).toBe("blocked");
      });
    });

    it("a probe that throws is swallowed — the pass still ends blocked, with the latch released", async () => {
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
        expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).toBe("blocked");
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

// THE WIRING, not the helper. `services/sparkleTranscript` had its own unit tests and the whole suite
// still went green with BOTH of its call sites deleted (roborev 55363) — the vacuous shape AGENTS.md
// calls the #1 fleet-wide finding. What has to hold is the end-to-end fact the user asked for: while
// an hourly pass is running, with no pane and no PTY anywhere, `read_agent_terminal` on the Improve
// Sparkle agent returns what that agent is saying.
describe("readable while a headless pass runs", () => {
  const TRANSCRIPT = "/home/u/.claude/projects/-wt-sparkle-self/this-pass.jsonl";
  const SAID = "I looked at the logs and I'd prioritise the park refusal.";

  beforeEach(() => {
    vi.useFakeTimers();
    resetHarness();
    // A worktree Claude has run in: the resolve answers, and the transcript has an assistant turn.
    harness.invokeImpl = (cmd) => {
      if (cmd === "claude_latest_session_path") return Promise.resolve(TRANSCRIPT);
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
