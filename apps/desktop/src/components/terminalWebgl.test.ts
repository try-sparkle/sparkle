import { describe, it, expect, vi } from "vitest";
import {
  recoverFromWebglContextLoss,
  forceFullRepaint,
  settleRepaintPlan,
} from "./terminalWebgl";

// The poisoned-flag state machine: output written while a pane can't paint is cache-poisoned, and
// must be drained by exactly ONE full repaint on the next paintable settle/resize — not on every
// settle, and not lost if the pane is still hidden when a settle fires.
describe("settleRepaintPlan", () => {
  it("does a full repaint and clears the flag when poisoned AND paintable", () => {
    expect(settleRepaintPlan(true, true)).toEqual({ action: "full", poisoned: false });
  });

  it("keeps the flag set and only does a cheap refresh when poisoned but NOT paintable", () => {
    // A settle that fires while still hidden must not waste a full repaint nor drop the flag —
    // the next paintable settle/resize still needs to drain it.
    expect(settleRepaintPlan(true, false)).toEqual({ action: "refresh", poisoned: true });
  });

  it("does a cheap refresh when not poisoned (the normal streaming path)", () => {
    expect(settleRepaintPlan(false, true)).toEqual({ action: "refresh", poisoned: false });
    expect(settleRepaintPlan(false, false)).toEqual({ action: "refresh", poisoned: false });
  });
});

// The recurring "top half blank until I scroll" bug: the WebGL renderer skips any cell whose
// content matches its per-cell cache, so cells poisoned (written while the pane was hidden /
// 0-sized) never repaint on a bare term.refresh(). forceFullRepaint MUST clear the texture
// atlas (which wipes the renderer's model) FIRST, so the following refresh actually redraws.
// This is the guard the three prior refresh()-only fixes lacked.
describe("forceFullRepaint", () => {
  it("clears the WebGL model+atlas BEFORE refreshing (defeats the per-cell cache)", () => {
    const order: string[] = [];
    const webgl = { clearTextureAtlas: () => order.push("clear") };
    const term = { refresh: () => order.push("refresh"), rows: 24 };

    forceFullRepaint(webgl, term);

    // A bare refresh() (without the preceding clear) is the bug — assert the clear runs first.
    expect(order).toEqual(["clear", "refresh"]);
  });

  it("refreshes the full viewport", () => {
    const term = { refresh: vi.fn(), rows: 30 };
    forceFullRepaint({ clearTextureAtlas: vi.fn() }, term);
    expect(term.refresh).toHaveBeenCalledWith(0, 29);
  });

  it("falls back to a bare refresh when there is no WebGL renderer (DOM renderer has no cache)", () => {
    const term = { refresh: vi.fn(), rows: 10 };
    expect(() => forceFullRepaint(null, term)).not.toThrow();
    expect(term.refresh).toHaveBeenCalledWith(0, 9);
  });

  it("no-ops safely when the terminal is already gone", () => {
    const webgl = { clearTextureAtlas: vi.fn() };
    expect(() => forceFullRepaint(webgl, null)).not.toThrow();
    // Nothing to repaint — must not touch the addon either.
    expect(webgl.clearTextureAtlas).not.toHaveBeenCalled();
  });

  it("swallows errors from a torn-down terminal/addon", () => {
    const webgl = {
      clearTextureAtlas: () => {
        throw new Error("addon disposed");
      },
    };
    const term = { refresh: vi.fn(), rows: 24 };
    expect(() => forceFullRepaint(webgl, term)).not.toThrow();
  });
});

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
