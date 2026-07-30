import { describe, it, expect, vi } from "vitest";
import { forceFullRepaint, settleRepaintPlan } from "./terminalWebgl";

// NOTE: the `recoverFromWebglContextLoss` suite that used to live at the bottom of this file was
// removed with the function itself — Terminal's teardownWebgl replaced it (it additionally releases
// the GPU context and the concurrency permit). Its behavior is covered by
// terminalWebglContext.test.ts and Terminal.webglContextCap.test.tsx.

// The poisoned-flag state machine: output written while a pane can't paint is cache-poisoned, and
// must be drained by exactly ONE full repaint on the next paintable settle/resize — not on every
// settle, and not lost if the pane is still hidden when a settle fires.
describe("settleRepaintPlan", () => {
  it("does a full repaint and clears the flag when poisoned AND paintable", () => {
    expect(settleRepaintPlan(true, true)).toEqual({ action: "full", poisoned: false });
  });

  it("SKIPS painting a hidden pane but keeps the flag set (poisoned, not paintable)", () => {
    // A settle that fires while still hidden must not waste any paint on an off-screen pane, and
    // must not drop the flag — the become-active reveal (or the next paintable settle) drains it.
    expect(settleRepaintPlan(true, false)).toEqual({ action: "skip", poisoned: true });
  });

  it("does a cheap refresh when paintable and not poisoned (the normal streaming path)", () => {
    expect(settleRepaintPlan(false, true)).toEqual({ action: "refresh", poisoned: false });
  });

  it("SKIPS painting an off-screen pane even when not poisoned (no wasted refresh while hidden)", () => {
    // Bead sparkle-6x3g: with many background agents streaming, a refresh on an invisible pane is
    // pure wasted DOM work. Nothing to paint while hidden — skip regardless of the poisoned flag.
    expect(settleRepaintPlan(false, false)).toEqual({ action: "skip", poisoned: false });
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

