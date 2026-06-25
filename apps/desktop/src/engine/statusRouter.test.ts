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
