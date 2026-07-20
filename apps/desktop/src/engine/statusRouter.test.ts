import { describe, it, expect, vi } from "vitest";
import { createStatusRouter, HOOK_STALE_MS } from "./statusRouter";

describe("createStatusRouter", () => {
  it("lets the screen scraper drive until hooks activate", () => {
    const emit = vi.fn();
    const r = createStatusRouter(emit);
    r.fromScreen("working");
    r.fromScreen("idle");
    expect(emit.mock.calls.map((c) => c[0])).toEqual(["working", "idle"]);
  });

  it("ignores hook-derived status before the first real event", () => {
    const emit = vi.fn();
    const r = createStatusRouter(emit);
    // HookStatusEngine emits an initial 'working' on construction — must not pre-empt the
    // scraper before a real event has arrived.
    r.fromHook("working");
    expect(emit).not.toHaveBeenCalled();
  });

  it("hands authority to hooks once activated and suppresses the scraper", () => {
    const emit = vi.fn();
    const r = createStatusRouter(emit);
    r.fromScreen("working"); // scraper drives first
    r.activate(); // a real hook event arrived
    r.fromHook("approval"); // hooks now drive
    r.fromScreen("idle"); // stale scraper guess — suppressed
    expect(emit.mock.calls.map((c) => c[0])).toEqual(["working", "approval"]);
  });

  it("reset() hands authority back to the scraper until the next activation", () => {
    const emit = vi.fn();
    const r = createStatusRouter(emit);
    r.activate(); // first run: hooks own status
    r.fromHook("working");
    r.reset(); // re-prepare: scraper drives again until the new run's first hook
    r.fromScreen("idle"); // must emit — no hook event for the new run yet
    r.activate(); // new run's first hook arrives
    r.fromScreen("working"); // suppressed again
    expect(emit.mock.calls.map((c) => c[0])).toEqual(["working", "idle"]);
  });

  it("lets a screen-detected prompt escalate a hook-idle turn to red (idle, then prompt)", () => {
    // Claude ended its turn at its own ❯ menu: the hook log only shows Stop→idle, but the
    // rendered screen shows an interactive prompt → the user really is on the hook (red).
    const emit = vi.fn();
    const r = createStatusRouter(emit);
    r.activate();
    r.fromHook("idle"); // hook says the turn ended
    r.fromScreen("waiting"); // but a selection menu is on screen
    expect(emit.mock.calls.map((c) => c[0])).toEqual(["idle", "waiting"]);
  });

  it("escalates when the prompt was already on screen before the idle hook (prompt, then idle)", () => {
    const emit = vi.fn();
    const r = createStatusRouter(emit);
    r.activate();
    r.fromScreen("waiting"); // screen prompt seen first (suppressed at this point)
    r.fromHook("idle"); // hook idle resolves against the live screen → red
    expect(emit.mock.calls.map((c) => c[0])).toEqual(["waiting"]);
  });

  it("does NOT let the screen override a hook 'working' (escalation is idle-only)", () => {
    const emit = vi.fn();
    const r = createStatusRouter(emit);
    r.activate();
    r.fromHook("working");
    r.fromScreen("waiting"); // mid-turn screen guess must not pull working to red
    expect(emit.mock.calls.map((c) => c[0])).toEqual(["working"]);
  });

  it("lets a screen mid-stream failure (errored) override even a hook 'working' (fail closed)", () => {
    // sparkle-pqxh: the agent printed an API error / fell into a self-prompt loop with its process
    // alive, so the hook stream is stuck on `working` (no Stop ever fires). The scraper's `errored`
    // must pierce that — this is the one escalation that overrides a hook `working`.
    const emit = vi.fn();
    const r = createStatusRouter(emit);
    r.activate();
    r.fromHook("working");
    r.fromScreen("errored");
    expect(emit.mock.calls.map((c) => c[0])).toEqual(["working", "errored"]);
  });

  it("a stuck hook 'idle' does not clear a live screen 'errored'", () => {
    const emit = vi.fn();
    const r = createStatusRouter(emit);
    r.activate();
    r.fromHook("working");
    r.fromScreen("errored"); // wedged → red
    r.fromHook("idle"); // a stray/stuck idle hook can't see the stall — screen failure still wins
    expect(emit.mock.calls.map((c) => c[0])).toEqual(["working", "errored"]);
  });

  it("clears the screen 'errored' override when the scraper reports progress again", () => {
    const emit = vi.fn();
    const r = createStatusRouter(emit);
    r.activate();
    r.fromHook("working");
    r.fromScreen("errored"); // wedged → red
    r.fromScreen("working"); // real progress resumed → scraper lifts the failure
    expect(emit.mock.calls.map((c) => c[0])).toEqual(["working", "errored", "working"]);
  });

  it("clears the escalation once the hook reports working again", () => {
    const emit = vi.fn();
    const r = createStatusRouter(emit);
    r.activate();
    r.fromHook("idle");
    r.fromScreen("waiting"); // → red
    r.fromHook("working"); // user answered; Claude resumed → green wins again
    expect(emit.mock.calls.map((c) => c[0])).toEqual(["idle", "waiting", "working"]);
  });

  it("does not escalate a hook 'done' (a stale menu must not re-red an exited agent)", () => {
    const emit = vi.fn();
    const r = createStatusRouter(emit);
    r.activate();
    r.fromScreen("waiting");
    r.fromHook("done");
    expect(emit.mock.calls.map((c) => c[0])).toEqual(["done"]);
  });

  it("reset() clears a remembered screen prompt so it can't escalate the next run", () => {
    const emit = vi.fn();
    const r = createStatusRouter(emit);
    r.activate();
    r.fromScreen("waiting");
    r.reset();
    r.activate();
    r.fromHook("idle"); // new run: no live screen prompt → stays idle
    expect(emit.mock.calls.map((c) => c[0])).toEqual(["idle"]);
  });

  it("before activation, the screen path forwards distinct statuses and dedups repeats", () => {
    const emit = vi.fn();
    const r = createStatusRouter(emit);
    r.fromScreen("working");
    r.fromScreen("working"); // duplicate while the scraper drives → suppressed
    r.fromScreen("idle");
    expect(emit.mock.calls.map((c) => c[0])).toEqual(["working", "idle"]);
  });

  it("self-corrects: a cleared screen prompt drops a stale escalation back to gray", () => {
    const emit = vi.fn();
    const r = createStatusRouter(emit);
    r.activate();
    r.fromHook("idle"); // turn ends
    r.fromScreen("waiting"); // ...at a menu → red
    r.fromScreen("idle"); // user answered; the menu is gone → back to gray
    expect(emit.mock.calls.map((c) => c[0])).toEqual(["idle", "waiting", "idle"]);
  });

  it("multi-turn in one run: a cleared menu does not re-red the next genuinely-done turn", () => {
    // The risky path: an escalation must not leave a stale `waiting` that re-reds a later idle.
    const emit = vi.fn();
    const r = createStatusRouter(emit);
    r.activate();
    r.fromHook("idle"); // turn 1 ends
    r.fromScreen("waiting"); // ...at a menu → red
    r.fromScreen("idle"); // answered; menu gone → gray
    r.fromHook("working"); // turn 2 runs
    r.fromHook("idle"); // turn 2 ends DONE → must stay gray, not re-red
    expect(emit.mock.calls.map((c) => c[0])).toEqual(["idle", "waiting", "idle", "working", "idle"]);
  });

  it("does not re-emit a repeated idle hook during an active escalation (dedup)", () => {
    const emit = vi.fn();
    const r = createStatusRouter(emit);
    r.activate();
    r.fromHook("idle");
    r.fromScreen("waiting"); // → red
    r.fromHook("idle"); // repeat idle while the menu is still up → no redundant re-emit
    expect(emit.mock.calls.map((c) => c[0])).toEqual(["idle", "waiting"]);
  });

  it("lets the followup judge escalate a hook-idle turn to red (idle, then judge)", () => {
    // The hook log only shows Stop→idle, but the async judge read the finished turn and decided
    // the agent is blocked on the user ("want me to land it?"). That's a real "answer me" (red).
    const emit = vi.fn();
    const r = createStatusRouter(emit);
    r.activate();
    r.fromHook("idle"); // hook says the turn ended
    r.fromJudge("waiting"); // ...but the judge says it's blocked on you
    expect(emit.mock.calls.map((c) => c[0])).toEqual(["idle", "waiting"]);
  });

  it("does NOT let the judge override a hook 'working' (escalation is idle-only)", () => {
    // A late judge verdict that lands after the user already resumed the agent must not pull a
    // live, working turn back to red.
    const emit = vi.fn();
    const r = createStatusRouter(emit);
    r.activate();
    r.fromHook("working");
    r.fromJudge("waiting");
    expect(emit.mock.calls.map((c) => c[0])).toEqual(["working"]);
  });

  it("clears the judge escalation once the hook reports working again", () => {
    const emit = vi.fn();
    const r = createStatusRouter(emit);
    r.activate();
    r.fromHook("idle");
    r.fromJudge("waiting"); // → red
    r.fromHook("working"); // user answered; Claude resumed → green wins again
    expect(emit.mock.calls.map((c) => c[0])).toEqual(["idle", "waiting", "working"]);
  });

  it("a judge verdict from a prior turn does not re-red the next genuinely-done turn", () => {
    // The stale-verdict risk: working (turn 2 opens) must drop the prior verdict so turn 2's
    // idle stays gray. (AgentPane additionally guards against applying a stale verdict at all.)
    const emit = vi.fn();
    const r = createStatusRouter(emit);
    r.activate();
    r.fromHook("idle"); // turn 1 ends
    r.fromJudge("waiting"); // ...blocked on you → red
    r.fromHook("working"); // turn 2 runs (verdict dropped)
    r.fromHook("idle"); // turn 2 ends DONE → must stay gray
    expect(emit.mock.calls.map((c) => c[0])).toEqual(["idle", "waiting", "working", "idle"]);
  });

  it("does not escalate a hook 'done' via a stale judge verdict", () => {
    const emit = vi.fn();
    const r = createStatusRouter(emit);
    r.activate();
    r.fromJudge("waiting");
    r.fromHook("done");
    expect(emit.mock.calls.map((c) => c[0])).toEqual(["done"]);
  });

  it("reset() clears a remembered judge verdict so it can't escalate the next run", () => {
    const emit = vi.fn();
    const r = createStatusRouter(emit);
    r.activate();
    r.fromJudge("waiting");
    r.reset();
    r.activate();
    r.fromHook("idle"); // new run: no live verdict → stays idle
    expect(emit.mock.calls.map((c) => c[0])).toEqual(["idle"]);
  });

  it("screen and judge both escalate the same idle to red without double-emitting", () => {
    const emit = vi.fn();
    const r = createStatusRouter(emit);
    r.activate();
    r.fromHook("idle");
    r.fromScreen("waiting"); // screen prompt → red
    r.fromJudge("waiting"); // judge agrees → already red, no redundant emit
    expect(emit.mock.calls.map((c) => c[0])).toEqual(["idle", "waiting"]);
  });

  it("a judge verdict keeps the turn red across a later scraper idle tick", () => {
    // Once the judge reds an idle turn, a benign scraper 'idle' re-resolve must not drop it back
    // to gray — the verdict is sticky until the turn reopens.
    const emit = vi.fn();
    const r = createStatusRouter(emit);
    r.activate();
    r.fromHook("idle");
    r.fromJudge("waiting"); // → red
    r.fromScreen("idle"); // scraper tick (no on-screen prompt) → must stay red
    expect(emit.mock.calls.map((c) => c[0])).toEqual(["idle", "waiting"]);
  });

  it("a screen 'working' clears a judge verdict — the agent is demonstrably running", () => {
    // The judge escalation had exactly one clear path: a non-idle HOOK event (statusRouter.ts:96).
    // The scraper was structurally forbidden from clearing it, so a judge red outlived the very
    // evidence that disproved it.
    const emit = vi.fn();
    const r = createStatusRouter(emit);
    r.activate();
    r.fromHook("idle");
    r.fromJudge("waiting"); // → red
    r.fromScreen("working"); // the agent is visibly running → the verdict is stale
    r.fromScreen("idle"); // a later benign tick must NOT resurrect the red
    expect(emit.mock.calls.map((c) => c[0])).toEqual(["idle", "waiting", "idle"]);
  });

  it("activate() is idempotent and does not itself emit", () => {
    const emit = vi.fn();
    const r = createStatusRouter(emit);
    r.activate();
    r.activate();
    expect(emit).not.toHaveBeenCalled();
    r.fromHook("done");
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenLastCalledWith("done");
  });
});

describe("hook-liveness watchdog", () => {
  // REGRESSION — founder screenshot, 2026-07-15: the agent asked "Want me to start on the
  // self-test?", the user answered "yes", and the agent resumed (transcript showed tool calls and a
  // live "Sock-hopping… 22s · thinking" spinner) — but the row stayed RED.
  //
  // With live hooks this already works: "yes" → UserPromptSubmit → fromHook("working") →
  // lastJudge = null → green. So a row stuck red PROVES hook events weren't being delivered.
  // router.activate() fires on EVERY event arrival (AgentPane.tsx:386), so hooksLive latches true
  // and a dead stream pins lastHook at "idle" forever.
  const mkClock = () => {
    let t = 0;
    return {
      now: () => t,
      advance: (ms: number) => {
        t += ms;
      },
    };
  };

  it("hands authority back to the scraper when hooks go silent while the screen says working", () => {
    const emit = vi.fn();
    const c = mkClock();
    const r = createStatusRouter(emit, c.now);
    r.activate();
    r.fromHook("idle"); // last hook: a Stop
    r.fromJudge("waiting"); // → red
    c.advance(HOOK_STALE_MS + 1);
    r.fromScreen("working"); // hooks are dead; the agent is demonstrably running
    expect(emit.mock.calls.map((x) => x[0])).toEqual(["idle", "waiting", "working"]);
  });

  it("does NOT fire while hooks are fresh — hook authority is untouched", () => {
    // A working agent with live hooks emits PreToolUse/PostToolUse constantly, so hooks cannot be
    // silent for the window while it works. This is what makes the watchdog safe.
    const emit = vi.fn();
    const c = mkClock();
    const r = createStatusRouter(emit, c.now);
    r.activate();
    r.fromHook("idle");
    c.advance(HOOK_STALE_MS - 1);
    r.fromScreen("working");
    expect(emit.mock.calls.map((x) => x[0])).toEqual(["idle"]); // hooks still own it
  });

  it("does NOT fire during a long single tool call — hooks are silent but NOT wedged", () => {
    // The counter-example to "a working agent emits tool events continuously": ONE `cargo build` or
    // test-suite run sits between its PreToolUse and PostToolUse for minutes. Hooks are legitimately
    // silent way past the window while the screen correctly reports working. Silence alone must not
    // trigger a handback, or the watchdog fires on healthy sessions and re-opens the false-green /
    // false-red class that hook authority exists to suppress. lastHook is "working" here — it AGREES
    // with the screen, so there is no contradiction and nothing to un-wedge.
    const emit = vi.fn();
    const c = mkClock();
    const r = createStatusRouter(emit, c.now);
    r.activate();
    r.fromHook("working"); // PreToolUse: a 5-minute build starts
    c.advance(HOOK_STALE_MS * 10);
    r.fromScreen("working"); // still building; hooks silent but alive
    r.fromScreen("waiting"); // a transient screen misread must STILL be suppressed by hooks
    expect(emit.mock.calls.map((x) => x[0])).toEqual(["working"]);
  });

  it("does NOT fire during a long thinking block with no tool calls", () => {
    // The founder's own screenshot showed "22s · thinking" — a no-tool-hook interval. A longer one
    // must not be read as death either: lastHook is "working" from UserPromptSubmit.
    const emit = vi.fn();
    const c = mkClock();
    const r = createStatusRouter(emit, c.now);
    r.activate();
    r.fromHook("working"); // UserPromptSubmit
    c.advance(HOOK_STALE_MS + 1);
    r.fromScreen("working");
    expect(emit.mock.calls.map((x) => x[0])).toEqual(["working"]);
  });

  it("a live stream's repeated same-status events keep it fresh despite engine dedup", () => {
    // HookStatusEngine dedups, so a run of PreToolUse/PostToolUse (all → working) reaches fromHook
    // ONCE. activate() fires on every event, so it is what carries liveness — if lastHookAt were
    // stamped only in fromHook, a busy stream would look silent and a later idle+working
    // contradiction could hand authority away while hooks were demonstrably alive.
    const emit = vi.fn();
    const c = mkClock();
    const r = createStatusRouter(emit, c.now);
    r.activate();
    r.fromHook("idle");
    // Events keep arriving every 10s, but all map to a status the engine already emitted.
    for (let i = 0; i < 5; i++) {
      c.advance(10_000);
      r.activate(); // real event arrived; no fromHook call (deduped by the engine)
    }
    r.fromScreen("working"); // only 10s since the last EVENT → stream is alive → hooks keep authority
    expect(emit.mock.calls.map((x) => x[0])).toEqual(["idle"]);
  });

  it("does NOT fire for a legitimately idle agent", () => {
    // Post-Stop, awaiting the user: hooks are silent, but the screen reports idle, not working.
    const emit = vi.fn();
    const c = mkClock();
    const r = createStatusRouter(emit, c.now);
    r.activate();
    r.fromHook("idle");
    c.advance(HOOK_STALE_MS + 1);
    r.fromScreen("idle");
    expect(emit.mock.calls.map((x) => x[0])).toEqual(["idle"]);
  });

  it("a real hook event re-activates hook authority after a handback", () => {
    const emit = vi.fn();
    const c = mkClock();
    const r = createStatusRouter(emit, c.now);
    r.activate();
    r.fromHook("idle");
    c.advance(HOOK_STALE_MS + 1);
    r.fromScreen("working"); // handback → working
    r.activate(); // hooks resume (AgentPane calls this on every event)
    r.fromHook("idle"); // and they say idle
    expect(emit.mock.calls.map((x) => x[0])).toEqual(["idle", "working", "idle"]);
  });

  it("mid_turn_death_is_not_recovered — KNOWN GAP, pinned deliberately", () => {
    // Documents a limitation rather than asserting desired behavior. If the stream dies MID-turn,
    // lastHook is frozen at "working", the idle/working contradiction never forms, and the watchdog
    // cannot fire — so resolve() answers "working" for every screen report and the row pins GREEN
    // until reset() (a re-prepare), even across a real on-screen prompt.
    //
    // Why it is pinned rather than fixed: the only available signal is silence, and silence cannot
    // distinguish a dead stream from a legitimate long tool call (see the long-tool-call test
    // above). Any threshold that catches this also misfires on slow builds, trading a false green
    // for a false red on healthy sessions. The gap predates this watchdog — the pre-watchdog router
    // behaved identically — so nothing regressed; it is simply not covered.
    //
    // If this is ever fixed, DELETE this test — do not "make it pass".
    const emit = vi.fn();
    const c = mkClock();
    const r = createStatusRouter(emit, c.now);
    r.activate();
    r.fromHook("working"); // turn is open; the emitter is clobbered right about here
    c.advance(HOOK_STALE_MS * 100);
    r.fromScreen("waiting"); // a REAL prompt is on screen and the user is blocked
    expect(emit.mock.calls.map((x) => x[0])).toEqual(["working"]); // ...but the row stays green
  });

  it("reset() clears the hook timestamp", () => {
    const emit = vi.fn();
    const c = mkClock();
    const r = createStatusRouter(emit, c.now);
    r.activate();
    r.fromHook("idle");
    r.reset();
    c.advance(HOOK_STALE_MS + 1);
    r.activate();
    r.fromScreen("working"); // no lastHookAt → watchdog can't fire on a stale ghost
    expect(emit.mock.calls.map((x) => x[0])).toEqual(["idle"]);
  });
});
