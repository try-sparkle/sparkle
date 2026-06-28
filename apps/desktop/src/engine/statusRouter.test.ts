import { describe, it, expect, vi } from "vitest";
import { createStatusRouter } from "./statusRouter";

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
