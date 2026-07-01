import { describe, it, expect, vi } from "vitest";
import { bucketCounts, drawTrayIcon } from "./trayIcon";
import type { TrayRoster } from "./trayRoster";

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

describe("drawTrayIcon", () => {
  it("draws three colored numbers (no dots) and returns sized dimensions", () => {
    // Minimal 2D context stub — assert the drawer writes three numbers, draws no circles,
    // and reports width>height (the menu-bar strip is wide and short).
    const calls: string[] = [];
    const fills: string[] = [];
    const ctx = {
      canvas: { width: 0, height: 0 },
      set fillStyle(v: string) { fills.push(v); },
      get fillStyle() { return fills[fills.length - 1] ?? ""; },
      font: "", textBaseline: "", globalAlpha: 1,
      clearRect: () => calls.push("clear"),
      beginPath: () => calls.push("begin"),
      arc: () => calls.push("arc"),
      fill: () => calls.push("fill"),
      fillText: (t: string) => calls.push("text:" + t),
      measureText: (t: string) => ({ width: t.length * 6 }),
    } as unknown as CanvasRenderingContext2D;
    const dims = drawTrayIcon(ctx, { red: 3, grey: 2, green: 5 }, 2);
    expect(calls.filter((c) => c === "arc").length).toBe(0); // no dots
    expect(calls).toContain("text:3");
    expect(calls).toContain("text:2");
    expect(calls).toContain("text:5");
    expect(fills).toHaveLength(3); // one color per number
    expect(dims.width).toBeGreaterThan(dims.height);
  });
});
