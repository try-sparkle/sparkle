import { describe, it, expect } from "vitest";
import { resolveComposerDrag, shouldRestoreFromBar } from "./composerDrag";

// Fixed geometry for deterministic tests (mirrors the uiStore constants closely):
// snap = the "covers the terminal input" rest height; min = open-height floor.
const opts = {
  snap: 72,
  min: 64,
  max: 600,
  snapThreshold: 24,
  minimizeThreshold: 40,
  restoreThreshold: 24,
};

describe("resolveComposerDrag", () => {
  it("dragging the handle up grows the open height", () => {
    // Far enough up to clear the snap magnet around 72.
    const r = resolveComposerDrag({ startHeight: 72, startMinimized: false, dy: 120 }, opts);
    expect(r.minimized).toBe(false);
    expect(r.height).toBe(192);
  });

  it("snaps to the cover height when released near it", () => {
    // 72 + 10 = 82 is within snapThreshold(24) of snap(72) → magnet to 72.
    const r = resolveComposerDrag({ startHeight: 72, startMinimized: false, dy: 10 }, opts);
    expect(r.minimized).toBe(false);
    expect(r.height).toBe(72);
  });

  it("dragging slightly below the floor still snaps to the cover height (not minimized)", () => {
    // raw = 72 - 20 = 52: above minimizeThreshold(40), clamps to min(64), then snaps to 72.
    const r = resolveComposerDrag({ startHeight: 72, startMinimized: false, dy: -20 }, opts);
    expect(r.minimized).toBe(false);
    expect(r.height).toBe(72);
  });

  it("dragging the handle well down minimizes and remembers the open height", () => {
    // raw = 120 - 90 = 30 ≤ minimizeThreshold(40) → minimize; keep 120 to restore to.
    const r = resolveComposerDrag({ startHeight: 120, startMinimized: false, dy: -90 }, opts);
    expect(r.minimized).toBe(true);
    expect(r.height).toBe(120);
  });

  it("clamps the open height to max when dragged way up", () => {
    const r = resolveComposerDrag({ startHeight: 72, startMinimized: false, dy: 5000 }, opts);
    expect(r.minimized).toBe(false);
    expect(r.height).toBe(600);
  });

  it("from minimized, dragging up past the restore threshold restores to the cover height", () => {
    const r = resolveComposerDrag({ startHeight: 120, startMinimized: true, dy: 30 }, opts);
    expect(r.minimized).toBe(false);
    // dy(30) is within snapThreshold of snap(72) → lands on the cover height.
    expect(r.height).toBe(72);
  });

  it("from minimized, dragging up a lot restores to a taller height", () => {
    const r = resolveComposerDrag({ startHeight: 120, startMinimized: true, dy: 220 }, opts);
    expect(r.minimized).toBe(false);
    expect(r.height).toBe(220);
  });

  it("from minimized, a small drag stays minimized", () => {
    const r = resolveComposerDrag({ startHeight: 120, startMinimized: true, dy: 8 }, opts);
    expect(r.minimized).toBe(true);
    expect(r.height).toBe(120);
  });

  it("minimizing remembers the persisted FLOOR, not a transient auto-expanded tracking height", () => {
    // startHeight = on-screen autoHeight (200, expanded for a long draft); floor = 72.
    // Dragging down to minimize must persist 72, not 200 — a draft must not resize the floor.
    const r = resolveComposerDrag(
      { startHeight: 200, startMinimized: false, dy: -170, floor: 72 },
      opts,
    );
    expect(r.minimized).toBe(true);
    expect(r.height).toBe(72);
  });

  it("a sub-threshold bar tug remembers the floor too", () => {
    const r = resolveComposerDrag(
      { startHeight: 200, startMinimized: true, dy: 8, floor: 72 },
      opts,
    );
    expect(r.minimized).toBe(true);
    expect(r.height).toBe(72);
  });

  it("falls back to startHeight as the remembered height when no floor is given", () => {
    const r = resolveComposerDrag({ startHeight: 120, startMinimized: false, dy: -90 }, opts);
    expect(r.minimized).toBe(true);
    expect(r.height).toBe(120);
  });
});

describe("shouldRestoreFromBar", () => {
  it("restores on a click (no movement) from the minimized bar", () => {
    expect(shouldRestoreFromBar({ startMinimized: true, dy: 0, stillMinimized: true })).toBe(true);
  });

  it("restores on any upward release that the snap math left minimized (dead-zone)", () => {
    expect(shouldRestoreFromBar({ startMinimized: true, dy: 12, stillMinimized: true })).toBe(true);
  });

  it("does NOT restore on a downward tug (abort intent)", () => {
    expect(shouldRestoreFromBar({ startMinimized: true, dy: -10, stillMinimized: true })).toBe(false);
  });

  it("does nothing when the drag already restored it (no longer minimized)", () => {
    expect(shouldRestoreFromBar({ startMinimized: true, dy: 40, stillMinimized: false })).toBe(false);
  });

  it("does nothing when the drag did not start minimized", () => {
    expect(shouldRestoreFromBar({ startMinimized: false, dy: 5, stillMinimized: true })).toBe(false);
  });
});
