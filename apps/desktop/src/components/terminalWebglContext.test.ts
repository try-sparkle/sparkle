import { describe, it, expect, vi } from "vitest";
import {
  releaseGlContext,
  findWebglCanvas,
  onWebglContextLostImmediately,
} from "./terminalWebgl";

// Build a fake canvas that answers getContext("webgl2") with a context exposing
// WEBGL_lose_context. jsdom has no WebGL at all, so a structural fake is the only way to assert
// this behavior in a unit test.
function fakeGlCanvas() {
  const loseContext = vi.fn();
  const gl = {
    getExtension: vi.fn((name: string) => (name === "WEBGL_lose_context" ? { loseContext } : null)),
  };
  return {
    loseContext,
    gl,
    canvas: { getContext: vi.fn((id: string) => (id === "webgl2" ? gl : null)) },
  };
}

// A 2d render layer: xterm's link/cursor layers own a "2d" context, and a canvas can only ever
// have one context type, so asking them for "webgl2" yields null.
function fake2dCanvas() {
  return { getContext: vi.fn((id: string) => (id === "2d" ? {} : null)) };
}

// THE LEAK. xterm's WebglAddon.dispose() only does `removeChild(canvas)` — the string
// "loseContext" appears nowhere in @xterm/addon-webgl 0.19.0. So the GPU context survives dispose
// until GC, contexts accumulate past the engine's measured 16, and the engine evicts the OLDEST —
// which under Sparkle's churn is the terminal the human is looking at. releaseGlContext is the
// deterministic hand-back.
describe("releaseGlContext", () => {
  it("CALLS WEBGL_lose_context.loseContext() — the only deterministic way to free the context", () => {
    const { canvas, loseContext } = fakeGlCanvas();
    releaseGlContext(canvas);
    // The side effect, not the lookup: a test that only asserted getExtension was called would
    // pass against a body that fetched the extension and never used it.
    expect(loseContext).toHaveBeenCalledTimes(1);
  });

  it("asks for the context by the SAME type xterm allocates (webgl2, not webgl)", () => {
    // Requesting "webgl" would return null for a canvas holding a webgl2 context, so the release
    // would silently no-op and the leak would survive with a green test.
    const { canvas, loseContext } = fakeGlCanvas();
    releaseGlContext(canvas);
    expect(canvas.getContext).toHaveBeenCalledWith("webgl2");
    expect(loseContext).toHaveBeenCalled();
  });

  it("no-ops on a null canvas and on a canvas with no GL context", () => {
    expect(() => releaseGlContext(null)).not.toThrow();
    expect(() => releaseGlContext(undefined)).not.toThrow();
    expect(() => releaseGlContext(fake2dCanvas())).not.toThrow();
  });

  it("swallows a throwing getContext (context already destroyed during teardown)", () => {
    const canvas = {
      getContext: () => {
        throw new Error("context destroyed");
      },
    };
    expect(() => releaseGlContext(canvas)).not.toThrow();
  });

  it("survives an engine that lacks the WEBGL_lose_context extension", () => {
    const canvas = { getContext: () => ({ getExtension: () => null }) };
    expect(() => releaseGlContext(canvas)).not.toThrow();
  });
});

// The addon exposes no handle to its canvas, so we probe for it. Getting this wrong means
// releaseGlContext is handed the wrong canvas and the leak persists.
describe("findWebglCanvas", () => {
  it("picks the WebGL canvas out of xterm's mix of 2d render layers", () => {
    const target = fakeGlCanvas();
    const root = {
      querySelectorAll: () => [fake2dCanvas(), fake2dCanvas(), target.canvas],
    };
    expect(findWebglCanvas(root)).toBe(target.canvas);
  });

  it("returns null when no canvas holds a WebGL context (DOM-renderer fallback)", () => {
    const root = { querySelectorAll: () => [fake2dCanvas(), fake2dCanvas()] };
    expect(findWebglCanvas(root)).toBeNull();
  });

  it("returns null for a null root and skips a canvas whose getContext throws", () => {
    expect(findWebglCanvas(null)).toBeNull();
    const target = fakeGlCanvas();
    const thrower = {
      getContext: () => {
        throw new Error("nope");
      },
    };
    const root = { querySelectorAll: () => [thrower, target.canvas] };
    expect(findWebglCanvas(root)).toBe(target.canvas);
  });
});

// THE 3-SECOND GARBAGE WINDOW. xterm's own webglcontextlost handler preventDefaults and then waits
// 3000ms before firing onContextLoss — and if the engine restores the context in the meantime it
// never fires at all. Either way the terminal renders through a dead context for up to three
// seconds. This listener is what makes the fallback immediate.
describe("onWebglContextLostImmediately", () => {
  it("runs the fallback SYNCHRONOUSLY inside the webglcontextlost dispatch (no 3s wait)", () => {
    const listeners: Record<string, Array<() => void>> = {};
    const canvas = {
      addEventListener: (type: string, fn: () => void) => {
        (listeners[type] ??= []).push(fn);
      },
      removeEventListener: vi.fn(),
    };
    const onLost = vi.fn();
    onWebglContextLostImmediately(canvas, onLost);

    expect(onLost).not.toHaveBeenCalled(); // nothing before the event
    expect(listeners["webglcontextlost"]).toHaveLength(1);
    listeners["webglcontextlost"]?.forEach((fn) => fn());
    // Called during the dispatch itself — no timer, no fake-clock advance needed. If the
    // implementation deferred this behind a setTimeout, this assertion fails.
    expect(onLost).toHaveBeenCalledTimes(1);
  });

  it("falls back only ONCE even if the event is dispatched repeatedly", () => {
    const listeners: Array<() => void> = [];
    const canvas = {
      addEventListener: (_t: string, fn: () => void) => listeners.push(fn),
      removeEventListener: vi.fn(),
    };
    const onLost = vi.fn();
    onWebglContextLostImmediately(canvas, onLost);
    listeners.forEach((fn) => fn());
    listeners.forEach((fn) => fn());
    listeners.forEach((fn) => fn());
    // Re-running teardown would dispose an already-disposed addon and re-release a freed slot.
    expect(onLost).toHaveBeenCalledTimes(1);
  });

  it("subscribes to webglcontextlost specifically, and unsubscribes THAT handler on cleanup", () => {
    const added: Array<[string, () => void]> = [];
    const removed: Array<[string, () => void]> = [];
    const canvas = {
      addEventListener: (t: string, fn: () => void) => added.push([t, fn]),
      removeEventListener: (t: string, fn: () => void) => removed.push([t, fn]),
    };
    const stop = onWebglContextLostImmediately(canvas, vi.fn());
    expect(added.map(([t]) => t)).toEqual(["webglcontextlost"]);
    stop();
    // Same type AND same function identity — removing a different closure would leak the listener
    // onto a canvas we are about to hand back to the engine.
    expect(removed).toEqual(added);
  });

  it("returns a no-op unsubscriber for a null canvas (DOM-renderer fallback, nothing to watch)", () => {
    const stop = onWebglContextLostImmediately(null, vi.fn());
    expect(() => stop()).not.toThrow();
  });
});
