import { describe, it, expect, vi } from "vitest";
import {
  handleImproveSparkleClick,
  emitRevealSparkle,
  onRevealSparkle,
  focusMainWindow,
} from "./sparkleReveal";

describe("handleImproveSparkleClick", () => {
  it("main window: reveals Sparkle locally, never routes cross-window", () => {
    const activateLocal = vi.fn();
    const focusMain = vi.fn();
    const emitReveal = vi.fn();
    handleImproveSparkleClick({ isMainWindow: true, activateLocal, focusMain, emitReveal });
    expect(activateLocal).toHaveBeenCalledTimes(1);
    expect(focusMain).not.toHaveBeenCalled();
    expect(emitReveal).not.toHaveBeenCalled();
  });

  it("secondary window: focuses main + emits reveal, never activates locally (the no-op bug)", () => {
    const activateLocal = vi.fn();
    const focusMain = vi.fn();
    const emitReveal = vi.fn();
    handleImproveSparkleClick({ isMainWindow: false, activateLocal, focusMain, emitReveal });
    expect(activateLocal).not.toHaveBeenCalled();
    expect(focusMain).toHaveBeenCalledTimes(1);
    expect(emitReveal).toHaveBeenCalledTimes(1);
  });
});

// Outside Tauri (jsdom test env has no __TAURI_INTERNALS__) every binding is a safe no-op, so UI
// code can call them unconditionally — mirrors services/attention.ts's hasTauri guards.
describe("sparkleReveal Tauri guards", () => {
  it("emitRevealSparkle does not throw", () => {
    expect(() => emitRevealSparkle()).not.toThrow();
  });

  it("onRevealSparkle resolves to an unlisten fn", async () => {
    const unlisten = await onRevealSparkle(() => {});
    expect(typeof unlisten).toBe("function");
    expect(() => unlisten()).not.toThrow();
  });

  it("focusMainWindow resolves without touching the webview", async () => {
    await expect(focusMainWindow()).resolves.toBeUndefined();
  });
});
