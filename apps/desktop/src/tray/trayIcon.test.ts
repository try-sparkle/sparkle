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
  it("draws three dots+counts and returns sized dimensions", () => {
    // Minimal 2D context stub — assert the drawer issues fill calls and reports width>height.
    const calls: string[] = [];
    const ctx = {
      canvas: { width: 0, height: 0 },
      fillStyle: "", font: "", textBaseline: "",
      clearRect: () => calls.push("clear"),
      beginPath: () => calls.push("begin"),
      arc: () => calls.push("arc"),
      fill: () => calls.push("fill"),
      fillText: (t: string) => calls.push("text:" + t),
      measureText: (t: string) => ({ width: t.length * 6 }),
    } as unknown as CanvasRenderingContext2D;
    const dims = drawTrayIcon(ctx, { red: 3, grey: 2, green: 5 }, 2);
    expect(calls.filter((c) => c === "arc").length).toBe(3); // three dots
    expect(calls).toContain("text:3");
    expect(calls).toContain("text:5");
    expect(dims.width).toBeGreaterThan(dims.height);
  });
});
