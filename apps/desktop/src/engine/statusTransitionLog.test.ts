// roborev 54741: this module had NO test file, despite `formatStatusTransition` being exported
// specifically "so the format is asserted directly, without a logger spy having to re-derive it" —
// every assertion in the original change in fact went through the spy. These tests hold the two
// things a spy cannot: the exact rendered line, and `monotonicNow`'s fallback.
import { describe, it, expect, vi, afterEach } from "vitest";
import { formatStatusTransition, monotonicNow } from "./statusTransitionLog";

describe("formatStatusTransition", () => {
  it("renders the grep contract: agent-status agent=<id> <from>-><to> trigger=<why>", () => {
    // The documented way a human reads one agent's history out of sparkle.log is
    // `grep "agent-status agent=<id>"`, so the prefix and the id must stay adjacent and literal.
    const line = formatStatusTransition({
      agentId: "11a5b085-5c20-4623-a2e6-f3c34421c742",
      from: "working",
      to: "waiting",
      trigger: "spinner-gone-settle",
      screen: "awaiting",
      monotonicMs: 3165,
    });
    expect(line).toContain("agent-status agent=11a5b085-5c20-4623-a2e6-f3c34421c742");
    expect(line).toContain("working->waiting");
    expect(line).toContain("trigger=spinner-gone-settle");
    expect(line).toContain("screen=awaiting");
    expect(line).toContain("mono=3165");
  });

  it("omits screen= entirely when no classification took place", () => {
    // The mid-stream prompt path deliberately passes no verdict. An absent field must stay absent
    // rather than render as an empty or defaulted value, so a grep for `screen=` finds only
    // transitions a classifier actually decided.
    const line = formatStatusTransition({
      agentId: "a1",
      from: "working",
      to: "waiting",
      trigger: "prompt-detected-midstream",
      monotonicMs: 10,
    });
    expect(line).not.toContain("screen=");
  });

  it("distinguishes a blank screen from a calm one", () => {
    // The distinction this whole finding is about: "the classifier read a real screen and found no
    // question" vs "there was no screen to read". Both settle to idle; only the log tells them apart.
    const calm = formatStatusTransition({
      agentId: "a1", from: "working", to: "idle", trigger: "quiet-settle", screen: "calm", monotonicMs: 1,
    });
    const blank = formatStatusTransition({
      agentId: "a1", from: "working", to: "idle", trigger: "quiet-settle", screen: "blank", monotonicMs: 1,
    });
    expect(calm).toContain("screen=calm");
    expect(blank).toContain("screen=blank");
    expect(blank).not.toContain("screen=calm");
  });

  it("renders a spawn, whose `from` is null", () => {
    const line = formatStatusTransition({
      agentId: "a1", from: null, to: "working", trigger: "spawn", monotonicMs: 0,
    });
    // Whatever stands in for "no previous status", it must not read as a real status name.
    expect(line).toContain("->working");
    expect(line).toContain("trigger=spawn");
  });
});

describe("monotonicNow", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns a rounded performance.now() when the clock is present", () => {
    vi.stubGlobal("performance", { now: () => 1234.7 });
    expect(monotonicNow()).toBe(1235);
  });

  it("degrades to 0 when performance exists but carries no now()", () => {
    vi.stubGlobal("performance", {});
    expect(monotonicNow()).toBe(0);
  });

  // THE regression. The guard was `typeof performance?.now === "function"`, which still EVALUATES
  // the `performance` binding — optional chaining guards null/undefined VALUES, not an undeclared
  // identifier. In the bare non-DOM context the guard exists for, that threw ReferenceError, and
  // because logStatusTransition runs from the StatusEngine constructor the throw took engine
  // construction down with it: precisely the outcome the comment claimed it prevented.
  //
  // Asserting this properly requires an UNDECLARED identifier, not merely an undefined property —
  // a test that only deletes the property passes against the broken code and proves nothing. `with`
  // is the one construct that can make a bare identifier reference throw on demand, so the check is
  // expressed as the source-level property the fix turns on.
  it("guards with a bare `typeof`, the only form safe on an undeclared global", () => {
    const src = monotonicNow.toString();
    expect(src).toMatch(/typeof\s+performance\s*!==\s*["']undefined["']/);
    // And the broken form must be gone: `performance?.now` still evaluates `performance`.
    expect(src).not.toMatch(/typeof\s+performance\?\./);
  });

  it("does not throw when performance is absent altogether", () => {
    vi.stubGlobal("performance", undefined);
    expect(() => monotonicNow()).not.toThrow();
    expect(monotonicNow()).toBe(0);
  });
});
