import { describe, it, expect, vi, beforeAll } from "vitest";
import { bucketCounts, drawTrayIcon, pillRect } from "./trayIcon";
import type { TrayRoster } from "./trayRoster";

// jsdom/node has no Path2D; the painter guards on its presence, but stubbing it here lets the
// tests assert the sparkle glyph actually gets filled.
class FakePath2D {
  d: string;
  constructor(d: string) { this.d = d; }
}
beforeAll(() => { vi.stubGlobal("Path2D", FakePath2D); });

describe("bucketCounts", () => {
  it("counts red/grey/green from a roster", () => {
    const roster: TrayRoster = { counts: { red: 0, grey: 0, green: 0 }, projects: [
      { id: "p", name: "P", agents: [
        { id: "1", name: "1", kind: "build", status: "working", status_color: "", status_label: "", parent_id: null },
        { id: "2", name: "2", kind: "build", status: "waiting", status_color: "", status_label: "", parent_id: null },
        { id: "3", name: "3", kind: "build", status: "idle", status_color: "", status_label: "", parent_id: null },
      ] },
    ] };
    expect(bucketCounts(roster)).toEqual({ red: 1, grey: 1, green: 1 });
  });
  it("counts errored agent as RED", () => {
    const roster: TrayRoster = { counts: { red: 0, grey: 0, green: 0 }, projects: [
      { id: "p", name: "P", agents: [
        { id: "1", name: "1", kind: "build", status: "errored", status_color: "", status_label: "", parent_id: null },
      ] },
    ] };
    expect(bucketCounts(roster)).toEqual({ red: 1, grey: 0, green: 0 });
  });
});

describe("pillRect", () => {
  it("wraps the full width with a 4px corner radius (never fully rounded)", () => {
    const r = pillRect(64);
    expect(r.r).toBe(4);
    expect(r.x).toBe(0);
    expect(r.w).toBe(64);
    // Pill stays inside the 22px menu-bar strip and its radius is far below the capsule
    // threshold (h/2) — the founder bans fully-rounded pills.
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.y + r.h).toBeLessThanOrEqual(22);
    expect(r.r).toBeLessThan(r.h / 2);
  });
});

// Minimal 2D context stub — records the painter's calls so we can assert draw order and shapes.
function recordingCtx() {
  const calls: string[] = [];
  const fills: string[] = [];
  const ctx = {
    canvas: { width: 0, height: 0 },
    set fillStyle(v: string) { fills.push(v); },
    get fillStyle() { return fills[fills.length - 1] ?? ""; },
    font: "", textBaseline: "", globalAlpha: 1,
    clearRect: () => calls.push("clear"),
    beginPath: () => calls.push("begin"),
    moveTo: () => calls.push("moveTo"),
    lineTo: () => calls.push("lineTo"),
    arcTo: () => calls.push("arcTo"),
    closePath: () => calls.push("closePath"),
    arc: () => calls.push("arc"),
    save: () => calls.push("save"),
    restore: () => calls.push("restore"),
    translate: () => calls.push("translate"),
    scale: () => calls.push("scale"),
    fill: (p?: unknown) => calls.push(p instanceof FakePath2D ? "fillGlyph" : "fill"),
    fillText: (t: string) => calls.push("text:" + t),
    measureText: (t: string) => ({ width: t.length * 6 }),
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls, fills };
}

describe("drawTrayIcon", () => {
  it("draws three colored numbers (no dots) and returns sized dimensions", () => {
    const { ctx, calls } = recordingCtx();
    const dims = drawTrayIcon(ctx, { red: 3, grey: 2, green: 5 }, 2);
    expect(calls.filter((c) => c === "arc").length).toBe(0); // no dots
    expect(calls).toContain("text:3");
    expect(calls).toContain("text:2");
    expect(calls).toContain("text:5");
    expect(dims.width).toBeGreaterThan(dims.height);
  });

  it("paints the 4px pill background, then the sparkle glyph, then the counts", () => {
    const { ctx, calls } = recordingCtx();
    drawTrayIcon(ctx, { red: 1, grey: 0, green: 2 }, 2);
    const pill = calls.indexOf("fill");        // rounded-rect background fill
    const glyph = calls.indexOf("fillGlyph");  // Path2D sparkle fill
    const firstCount = calls.findIndex((c) => c.startsWith("text:"));
    expect(pill).toBeGreaterThanOrEqual(0);
    expect(glyph).toBeGreaterThanOrEqual(0);
    expect(firstCount).toBeGreaterThanOrEqual(0);
    expect(pill).toBeLessThan(glyph);
    expect(glyph).toBeLessThan(firstCount);
    // Rounded corners are traced with arcTo (4 corners), not full arcs.
    expect(calls.filter((c) => c === "arcTo").length).toBe(4);
  });
});
