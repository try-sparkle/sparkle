import { describe, it, expect, vi } from "vitest";
import { recoverFromWebglContextLoss } from "./terminalWebgl";

// When the GPU drops the WebGL context, xterm's addon can't recover and fires onContextLoss.
// recoverFromWebglContextLoss must dispose the addon, clear the caller's ref, AND force a
// repaint — disposing alone swaps the renderer but paints no frame, leaving the terminal
// blank/stale until the next PTY write (the bug observed in the session logs).
describe("recoverFromWebglContextLoss", () => {
  it("disposes the addon, clears the ref, and repaints the full viewport", () => {
    const webgl = { dispose: vi.fn() };
    const term = { refresh: vi.fn(), rows: 24 };
    const onDisposed = vi.fn();

    recoverFromWebglContextLoss(webgl, term, onDisposed);

    expect(webgl.dispose).toHaveBeenCalledOnce();
    expect(onDisposed).toHaveBeenCalledOnce();
    expect(term.refresh).toHaveBeenCalledWith(0, 23);
  });

  it("disposes in order: addon first, then ref cleared, then repaint", () => {
    const order: string[] = [];
    const webgl = { dispose: () => order.push("dispose") };
    const term = { refresh: () => order.push("refresh"), rows: 10 };

    recoverFromWebglContextLoss(webgl, term, () => order.push("onDisposed"));

    expect(order).toEqual(["dispose", "onDisposed", "refresh"]);
  });

  it("still disposes and clears the ref when the terminal is already gone", () => {
    const webgl = { dispose: vi.fn() };
    const onDisposed = vi.fn();

    expect(() => recoverFromWebglContextLoss(webgl, null, onDisposed)).not.toThrow();
    expect(webgl.dispose).toHaveBeenCalledOnce();
    expect(onDisposed).toHaveBeenCalledOnce();
  });

  it("swallows a refresh error from a torn-down terminal", () => {
    const webgl = { dispose: vi.fn() };
    const term = {
      refresh: () => {
        throw new Error("terminal disposed");
      },
      rows: 24,
    };

    expect(() => recoverFromWebglContextLoss(webgl, term, () => {})).not.toThrow();
    expect(webgl.dispose).toHaveBeenCalledOnce();
  });
});
