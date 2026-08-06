import { describe, it, expect, vi } from "vitest";
import type { AgentTabStatus } from "@sparkle/ui";
import { createStatusRouter, HOOK_STALE_MS, withScreenReason, type StatusTransition } from "./statusRouter";

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

  it("mid_turn_death_is_not_recovered — KNOWN GAP, pinned deliberately (minus the session-limit carve-out)", () => {
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
    // NARROWED, NOT DELETED (PRD §6c). Exactly ONE screen now pierces the frozen hook: Claude Code's
    // session-limit picker, which carries a REASON CODE saying so (see the suite below). That is a
    // carve-out on the evidence, not a weakening of the rule — silence is still not a signal, and a
    // prompt the classifier cannot NAME still leaves the row green, which is what this test pins.
    // Only widen it with another named screen; never with a bare `waiting`.
    const emit = vi.fn();
    const c = mkClock();
    const r = createStatusRouter(emit, c.now);
    r.activate();
    r.fromHook("working"); // turn is open; the emitter is clobbered right about here
    c.advance(HOOK_STALE_MS * 100);
    r.fromScreen("waiting"); // a REAL prompt is on screen and the user is blocked
    expect(emit.mock.calls.map((x) => x[0])).toEqual(["working"]); // ...but the row stays green
    // The carve-out is by SCREEN, not by band: the same `waiting`, reported again with no reason,
    // still does not pierce. So an approval dialog, an AskUserQuestion menu and a /model picker all
    // keep today's behaviour, and only the named screen is exempt.
    r.fromScreen("approval");
    expect(emit.mock.calls.map((x) => x[0])).toEqual(["working"]);
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

// ── The session-limit pierce (PRD/sparkle/claude-account-identity-truth.md §6c) ─────────────────
//
// The founder's whole fleet was parked on Claude Code's session-limit picker while every row read
// GREEN. The classifier was never the defect — `screenAwaitsInput` matched that screen all along.
// The defect was here: a session limit lands MID-TURN, so no `Stop` hook ever fires, `lastHook`
// freezes at "working", and the screen escalation below `if (hook !== "idle") return hook` only ever
// lifts a hook-IDLE turn. The screen's verdict was arbitrated away every time.

/** Report a screen status the way statusEngine does when the viewport IS the session-limit picker:
 *  the reason rides beside the call for its synchronous duration. */
const fromPicker = (r: ReturnType<typeof createStatusRouter>, s: Parameters<typeof r.fromScreen>[0] = "waiting") =>
  withScreenReason("session-limit-picker", () => r.fromScreen(s));

describe("createStatusRouter — the session-limit picker pierces hook authority", () => {
  const mkClock = () => {
    let t = 0;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  };

  it("THE TEST: a frozen `working` hook + a session-limit viewport resolves to `waiting` with the reason", () => {
    // This is the founder's screen, reduced to its two facts. Against the router as it stood, the
    // last assertion read ["working"] — the row stayed green.
    const emit = vi.fn();
    const transitions: StatusTransition[] = [];
    const c = mkClock();
    const r = createStatusRouter(emit, c.now, (t) => transitions.push(t));
    r.activate();
    r.fromHook("working"); // the turn opens; the limit lands inside it, so no Stop ever follows
    c.advance(HOOK_STALE_MS * 100); // …and the hook stays frozen there for as long as you like
    fromPicker(r);
    expect(emit.mock.calls.map((x) => x[0])).toEqual(["working", "waiting"]);
    expect(transitions.at(-1)?.reason).toBe("session-limit-picker");
    // The band is `waiting`, not `blocked` — deliberately, because `blocked` raises no banner and no
    // dock badge, so the fleet would have gone red and still paged nobody.
    expect(transitions.at(-1)?.to).toBe("waiting");
    // And the frozen hook is still exactly what it was: the pierce overrides it, it does not repair it.
    expect(transitions.at(-1)?.lastHook).toBe("working");
  });

  it("does NOT retract merely because the picker left the screen", () => {
    // The whole reason the pierce is latched. If it retracted on "picker gone", the instant a
    // recovery service pressed Esc the row would fall through to the STILL frozen `working` hook and
    // go green whether or not the resume took — back to the invisible-green state that was reported.
    const emit = vi.fn();
    const c = mkClock();
    const r = createStatusRouter(emit, c.now);
    r.activate();
    r.fromHook("working");
    fromPicker(r);
    r.fromScreen("idle"); // Esc landed: the dialog is gone and the screen is calm…
    r.fromScreen("idle"); // …and stays calm, because a walled agent prints nothing
    expect(emit.mock.calls.map((x) => x[0])).toEqual(["working", "waiting"]); // still red
  });

  it("retracts on POSITIVE PROGRESS — new agent output", () => {
    const emit = vi.fn();
    const c = mkClock();
    const r = createStatusRouter(emit, c.now);
    r.activate();
    r.fromHook("working");
    fromPicker(r);
    r.fromScreen("working"); // the spinner is redrawing again: the agent really did resume
    expect(emit.mock.calls.map((x) => x[0])).toEqual(["working", "waiting", "working"]);
  });

  it("releases when the SESSION ENDS, so an exited agent is not red forever", () => {
    // The pierce is held until POSITIVE PROGRESS, and the only progress signal is `working`. But a
    // dead process can never emit one: `SessionEnd` maps to `done` (hookEvents.ts) and the PTY exit
    // maps to `done` too, and neither is `working`. So an agent that exits while parked on the picker
    // — the user quits Claude, the pane is closed, the process is killed — kept resolving to
    // `waiting` until a re-prepare.
    //
    // That is a permanently red "Needs you" row on a session that is OVER: the exact inverse of the
    // false-green defect this pierce exists to end, and worse than it, because a green row on a live
    // agent self-corrects the moment the agent speaks again while this one never does. The `errored`
    // override this is modelled on has no such hole — it self-clears on any non-errored screen.
    const emit = vi.fn();
    const c = mkClock();
    const r = createStatusRouter(emit, c.now);
    r.activate();
    r.fromHook("working"); // the turn opens; the limit lands inside it, so no Stop ever follows
    fromPicker(r);
    expect(emit.mock.calls.map((x) => x[0])).toEqual(["working", "waiting"]);
    r.fromHook("done"); // SessionEnd — the user quit, or the pane was closed
    expect(emit.mock.calls.map((x) => x[0])).toEqual(["working", "waiting", "done"]);
    // …and it stays released: a later screen report must not resurrect the pierce on a dead session.
    r.fromScreen("idle");
    expect(emit.mock.calls.map((x) => x[0])).toEqual(["working", "waiting", "done"]);
  });

  it("releases on a screen-reported exit too (the scraper path's `done`)", () => {
    // Same hole, reached through the scraper: StatusEngine.exit() publishes `done`, and on an agent
    // whose hooks never activated that is the only witness there is.
    const emit = vi.fn();
    const c = mkClock();
    const r = createStatusRouter(emit, c.now);
    fromPicker(r);
    r.fromScreen("done");
    expect(emit.mock.calls.map((x) => x[0])).toEqual(["waiting", "done"]);
  });

  it("retracts on POSITIVE PROGRESS — a real tool event on the hook stream", () => {
    const emit = vi.fn();
    const c = mkClock();
    const r = createStatusRouter(emit, c.now);
    r.activate();
    r.fromHook("idle"); // this run's turn had closed…
    fromPicker(r); // …and the picker is up (a resume walked straight back into the wall)
    expect(emit.mock.calls.map((x) => x[0])).toEqual(["idle", "waiting"]);
    r.fromHook("working"); // PreToolUse: the agent is executing again
    expect(emit.mock.calls.map((x) => x[0])).toEqual(["idle", "waiting", "working"]);
  });

  it("a hook `idle` is NOT progress — Claude's idle Notification fires while the picker sits unanswered", () => {
    const emit = vi.fn();
    const c = mkClock();
    const r = createStatusRouter(emit, c.now);
    r.activate();
    r.fromHook("working");
    fromPicker(r);
    r.fromHook("idle"); // the ~60s "waiting for your input" ping — that IS the unanswered dialog
    expect(emit.mock.calls.map((x) => x[0])).toEqual(["working", "waiting"]);
  });

  it("an `errored` screen still outranks it, and is not reported as a session limit", () => {
    const emit = vi.fn();
    const transitions: StatusTransition[] = [];
    const c = mkClock();
    const r = createStatusRouter(emit, c.now, (t) => transitions.push(t));
    r.activate();
    r.fromHook("working");
    fromPicker(r);
    r.fromScreen("errored"); // the agent went on to wedge on an API banner
    expect(emit.mock.calls.map((x) => x[0])).toEqual(["working", "waiting", "errored"]);
    expect(transitions.at(-1)?.reason).toBeNull();
  });

  it("reports the reason even when the row was ALREADY `waiting` for some other prompt", () => {
    // The common real path: the picker's footer streams past mid-turn, so the engine paints
    // `waiting` off the stream ~2s before it reads the viewport. Same colour, materially different
    // fact — the consumer that acts on the reason has to hear about it, so the transition record
    // fires without a redundant status emit.
    const emit = vi.fn();
    const transitions: StatusTransition[] = [];
    const c = mkClock();
    const r = createStatusRouter(emit, c.now, (t) => transitions.push(t));
    r.activate();
    r.fromHook("idle");
    r.fromScreen("waiting"); // some prompt is up; nothing yet says which
    expect(emit.mock.calls.map((x) => x[0])).toEqual(["idle", "waiting"]);
    fromPicker(r); // the viewport read names it
    expect(emit.mock.calls.map((x) => x[0])).toEqual(["idle", "waiting"]); // no redundant emit…
    expect(transitions.map((t) => t.reason)).toEqual([null, null, "session-limit-picker"]); // …but it IS reported
  });

  it("holds the pierce on the scraper-driven path too (hooks never activated)", () => {
    const emit = vi.fn();
    const c = mkClock();
    const r = createStatusRouter(emit, c.now);
    fromPicker(r); // no hooks at all: the scraper owns the row
    r.fromScreen("idle"); // Esc landed, screen calm — but nothing proves the agent resumed
    expect(emit.mock.calls.map((x) => x[0])).toEqual(["waiting"]);
    r.fromScreen("working");
    expect(emit.mock.calls.map((x) => x[0])).toEqual(["waiting", "working"]);
  });

  it("an `errored` screen outranks the pierce on the SCRAPER path too, and keeps its own band", () => {
    // The hooks-live path gets this right via `resolve`'s ordering, but the scraper path took a
    // different branch that overrode the incoming status unconditionally once the latch was set —
    // including `errored` (roborev 58141). Two things went wrong at once, and both are asserted:
    // the band was downgraded from `errored` to `waiting`, AND `resolveReason()` correctly returns
    // null for an errored screen, so the transition carried NO reason. An agent that wedged on an
    // API banner after hitting the limit was reported as merely needing an answer, with the one
    // field a consumer acts on stripped off.
    const emit = vi.fn();
    const c = mkClock();
    const transitions: StatusTransition[] = [];
    const r = createStatusRouter(emit, c.now, (t) => transitions.push(t));
    fromPicker(r); // no hooks: the scraper owns the row
    expect(emit.mock.calls.map((x) => x[0])).toEqual(["waiting"]);
    r.fromScreen("errored"); // the process died on top of the picker
    expect(emit.mock.calls.map((x) => x[0])).toEqual(["waiting", "errored"]);
    expect(transitions.at(-1)?.reason).toBeNull();
  });

  it("reset() drops the pierce — a re-prepare is a new run", () => {
    const emit = vi.fn();
    const c = mkClock();
    const r = createStatusRouter(emit, c.now);
    r.activate();
    r.fromHook("working");
    fromPicker(r);
    r.reset();
    r.fromScreen("idle");
    expect(emit.mock.calls.map((x) => x[0])).toEqual(["working", "waiting", "idle"]);
  });

  it("the reason does not leak past the synchronous call that carried it", () => {
    // The hand-off slot is the one piece of module state here, so pin that it is scoped to a single
    // emit. A later screen report from ANY agent must not inherit it.
    const emit = vi.fn();
    const c = mkClock();
    const other = createStatusRouter(vi.fn(), c.now);
    const r = createStatusRouter(emit, c.now);
    fromPicker(other); // a DIFFERENT agent is the one at the picker
    r.activate();
    r.fromHook("working");
    r.fromScreen("waiting"); // this one merely has some prompt on screen
    expect(emit.mock.calls.map((x) => x[0])).toEqual(["working"]); // …so it stays green
  });
});

// A screen emit carrying the tool-approval reason, the way statusEngine delivers it.
const fromApprovalPrompt = (r: ReturnType<typeof createStatusRouter>, s: AgentTabStatus = "waiting") =>
  withScreenReason("tool-approval-prompt", () => r.fromScreen(s));

describe("createStatusRouter — an approval prompt pierces hook authority", () => {
  it("THE TEST: a frozen `working` hook + an on-screen approval prompt is NOT green", () => {
    // The founder's second sighting of the invisible-green state, one case over from the session
    // limit: an MCP tool-approval dialog (`rename_agent`) also opens MID-TURN, so no Stop fires,
    // `lastHook` freezes at "working", and the idle-only escalation never gets a look. Against the
    // router as it stood, the last assertion read ["working"] — the whole fleet rendered green while
    // every agent sat on an unanswered "Approve?" dialog.
    const emit = vi.fn();
    const transitions: StatusTransition[] = [];
    const r = createStatusRouter(emit, () => 0, (t) => transitions.push(t));
    r.activate();
    r.fromHook("working");
    fromApprovalPrompt(r);
    expect(emit.mock.calls.map((x) => x[0])).toEqual(["working", "waiting"]);
    expect(transitions.at(-1)?.reason).toBe("tool-approval-prompt");
    // The frozen hook is overridden, not repaired.
    expect(transitions.at(-1)?.lastHook).toBe("working");
  });

  it("keeps the engine's band — a risky action reads `approval`, not a flattened `waiting`", () => {
    // statusEngine picks approval-vs-waiting from whether a dangerous action was seen. The router
    // must carry that through rather than flattening it, or a destructive-action prompt is reported
    // as an ordinary question. (`attention.needsAttention()` covers both, so either way it pages —
    // this is about the row telling the truth.)
    const emit = vi.fn();
    const r = createStatusRouter(emit);
    r.activate();
    r.fromHook("working");
    fromApprovalPrompt(r, "approval");
    expect(emit.mock.calls.map((x) => x[0])).toEqual(["working", "approval"]);
  });

  it("a REASONLESS screen `waiting` still does not pierce (the idle-only rule is untouched)", () => {
    // The guard on the whole change. Only a VIEWPORT-CONFIRMED prompt — one statusEngine tagged with
    // the reason after re-reading the rendered grid — may override a hook `working`. A bare
    // mid-turn screen guess must keep losing to the hook, or the prose-question false-red the hook
    // migration killed comes straight back.
    const emit = vi.fn();
    const r = createStatusRouter(emit);
    r.activate();
    r.fromHook("working");
    r.fromScreen("waiting");
    expect(emit.mock.calls.map((x) => x[0])).toEqual(["working"]);
  });

  it("retracts on POSITIVE PROGRESS — the human answered and the agent resumed", () => {
    // Unlike the session-limit latch, this pierce is NOT latched: it tracks the latest screen emit.
    // A session limit needs the latch because a machine may press Esc without the wall actually
    // lifting, so "the picker is gone" proves nothing. An approval dialog has no such gap — the only
    // thing that dismisses it is a human answering it, and the agent then visibly resumes.
    const emit = vi.fn();
    const r = createStatusRouter(emit);
    r.activate();
    r.fromHook("working");
    fromApprovalPrompt(r);
    r.fromScreen("working"); // the answer landed; the spinner is redrawing again
    expect(emit.mock.calls.map((x) => x[0])).toEqual(["working", "waiting", "working"]);
  });

  it("self-corrects: a screen that stops reporting the prompt drops the pierce", () => {
    // The property the session-limit latch deliberately gives up, and the one this family of bugs
    // keeps re-learning: a red that cannot retract becomes a stale "Needs you" row. Because the
    // pierce is recomputed from the newest screen emit, a calm screen releases it immediately.
    const emit = vi.fn();
    const r = createStatusRouter(emit);
    r.activate();
    r.fromHook("working");
    fromApprovalPrompt(r);
    r.fromScreen("idle"); // dialog gone, turn quiet — the frozen hook is the only claim left
    expect(emit.mock.calls.map((x) => x[0])).toEqual(["working", "waiting", "working"]);
  });

  it("an `errored` screen still outranks it, and is not reported as an approval", () => {
    // Same ordering `resolve` already gives the session-limit picker: a crashed agent is the more
    // urgent read of the same screen.
    const emit = vi.fn();
    const transitions: StatusTransition[] = [];
    const r = createStatusRouter(emit, () => 0, (t) => transitions.push(t));
    r.activate();
    r.fromHook("working");
    fromApprovalPrompt(r);
    r.fromScreen("errored");
    expect(emit.mock.calls.map((x) => x[0])).toEqual(["working", "waiting", "errored"]);
    expect(transitions.at(-1)?.reason).toBeNull();
  });

  it("the session-limit picker outranks it — a walled agent is not merely awaiting an approval", () => {
    const emit = vi.fn();
    const transitions: StatusTransition[] = [];
    const r = createStatusRouter(emit, () => 0, (t) => transitions.push(t));
    r.activate();
    r.fromHook("working");
    fromApprovalPrompt(r);
    withScreenReason("session-limit-picker", () => r.fromScreen("waiting"));
    expect(transitions.at(-1)?.reason).toBe("session-limit-picker");
  });

  it("releases when the SESSION ENDS on the hook stream, so an exited agent is not red forever", () => {
    // The hole the session-limit pierce documents and handles with its own `done` clause, which this
    // one failed to mirror. `approvalPrompt` is recomputed in fromScreen, so a hook `done`
    // (SessionEnd / PTY exit) left it standing and `resolve` returned it OVER the `done` — a
    // permanently red "Needs you" row on a session that is over. Worse than the false green it
    // replaces, because a false green on a LIVE agent self-corrects the moment the agent speaks
    // again, and a dead process never speaks.
    const emit = vi.fn();
    const r = createStatusRouter(emit);
    r.activate();
    r.fromHook("working");
    fromApprovalPrompt(r);
    expect(emit.mock.calls.map((x) => x[0])).toEqual(["working", "waiting"]);
    r.fromHook("done"); // the agent exited while the dialog was still up
    expect(emit.mock.calls.map((x) => x[0])).toEqual(["working", "waiting", "done"]);
  });

  it("a prompt reported AFTER the session ended cannot RE-RAISE the pierce", () => {
    // The durable half, and why clearing the flag when the `done` arrived was not enough. A dead
    // session emits no further hook events, so `lastHook` stays `done` while the SCREEN can still
    // speak: statusEngine's armed re-check re-raises `tool-approval-prompt` off any viewport
    // `screenAwaitsInput` still matches — a leftover `❯` frame, or once `claude` exits, the bare
    // shell prompt underneath. That re-raise outranked the terminal `done` and pinned the row red
    // again, permanently. (`sessionLimitPicker` is not exposed this way: only the actual picker text
    // can re-set it, whereas a plain shell prompt satisfies this reason.)
    const emit = vi.fn();
    const transitions: StatusTransition[] = [];
    const r = createStatusRouter(emit, () => 0, (t) => transitions.push(t));
    r.activate();
    r.fromHook("working");
    fromApprovalPrompt(r);
    r.fromHook("done");
    expect(emit.mock.calls.map((x) => x[0])).toEqual(["working", "waiting", "done"]);
    // Snapshot the COUNT, not `at(-1)`: a fully-absorbed late emit pushes no transition at all, so
    // `transitions.at(-1)` would still be the one `fromHook("done")` produced and the assertion
    // would pass without observing this call. The real claim is that nothing came out of it.
    const before = transitions.length;
    fromApprovalPrompt(r); // a late re-check against a still-prompt-shaped viewport
    expect(emit.mock.calls.map((x) => x[0])).toEqual(["working", "waiting", "done"]);
    expect(transitions.length).toBe(before);
  });

  it("a later non-`done` hook cannot resurrect the pierce either", () => {
    // `resolve`'s `hook !== "done"` gate MASKS the flag; it does not clear it. Leaving the release
    // to the gate alone meant the flag survived the session end, so the next hook status that is not
    // `done` — a SessionStart after `/clear`, a trailing Notification, a UserPromptSubmit on a
    // resumed session — lifted the mask and brought back the OLD band with no new screen evidence.
    const emit = vi.fn();
    const transitions: StatusTransition[] = [];
    const r = createStatusRouter(emit, () => 0, (t) => transitions.push(t));
    r.activate();
    r.fromHook("working");
    fromApprovalPrompt(r);
    r.fromHook("done");
    // A NON-IDLE hook is the discriminator here. A later hook `idle` would resolve to `waiting`
    // anyway via the long-standing idle-only screen escalation (`lastScreen` is still the prompt),
    // which would pass whether or not the pierce had been cleared — it would prove nothing about
    // this flag. `working` (a UserPromptSubmit on a resumed session) can only come back red if the
    // stale `approvalPrompt` outranked it.
    r.fromHook("working");
    expect(emit.mock.calls.map((x) => x[0])).toEqual(["working", "waiting", "done", "working"]);
    expect(transitions.at(-1)?.reason).toBeNull();
  });

  it("reset() drops the pierce — a re-prepare is a new run", () => {
    const emit = vi.fn();
    const r = createStatusRouter(emit);
    r.activate();
    r.fromHook("working");
    fromApprovalPrompt(r);
    r.reset();
    r.fromScreen("idle");
    expect(emit.mock.calls.map((x) => x[0])).toEqual(["working", "waiting", "idle"]);
  });

  it("the reason does not leak to another agent's router", () => {
    const emit = vi.fn();
    const other = createStatusRouter(vi.fn());
    const r = createStatusRouter(emit);
    fromApprovalPrompt(other); // a DIFFERENT agent is the one at the dialog
    r.activate();
    r.fromHook("working");
    r.fromScreen("waiting");
    expect(emit.mock.calls.map((x) => x[0])).toEqual(["working"]);
  });
});
