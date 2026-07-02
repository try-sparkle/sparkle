import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import {
  evaluateSignal,
  pollOnce,
  startDeliveryMonitor,
  stopDeliveryMonitor,
  isDeliveryMonitorRunning,
  type WatchedBead,
} from "./deliveryMonitor";

beforeEach(() => {
  invoke.mockReset();
  stopDeliveryMonitor();
});
afterEach(() => {
  stopDeliveryMonitor();
  vi.useRealTimers();
});

describe("evaluateSignal", () => {
  it("no merge sha ⇒ not in release", () => {
    expect(evaluateSignal("b1", null, ["v1.0.0"])).toEqual({ beadId: "b1", inRelease: false, tags: [] });
  });

  it("semver tag containing the commit ⇒ in release", () => {
    const s = evaluateSignal("b1", "abc123", ["v1.2.0"]);
    expect(s.inRelease).toBe(true);
    expect(s.tags).toEqual(["v1.2.0"]);
  });

  it("non-release tags don't count as a delivery", () => {
    const s = evaluateSignal("b1", "abc123", ["nightly", "latest"]);
    expect(s.inRelease).toBe(false);
    expect(s.tags).toEqual([]);
  });
});

describe("pollOnce", () => {
  it("reports shipped beads and a watching status", async () => {
    invoke.mockImplementation((_cmd: string, args: { sha: string }) =>
      Promise.resolve(args.sha === "shipped" ? ["v2.0.0"] : []),
    );
    const beads: WatchedBead[] = [
      { beadId: "a", mergeSha: "shipped" },
      { beadId: "b", mergeSha: "unshipped" },
      { beadId: "c", mergeSha: null },
    ];
    const update = await pollOnce("/repo", beads);
    expect(update.signals.find((s) => s.beadId === "a")?.inRelease).toBe(true);
    expect(update.signals.find((s) => s.beadId === "b")?.inRelease).toBe(false);
    expect(update.detectable).toBe(true);
    expect(update.status).toMatch(/watching/i);
  });

  it("no testable beads ⇒ honest can't-detect status", async () => {
    const update = await pollOnce("/repo", [{ beadId: "a", mergeSha: null }]);
    expect(update.detectable).toBe(false);
    expect(update.status).toMatch(/can't detect/i);
    // Never touched git when there's nothing to test.
    expect(invoke).not.toHaveBeenCalled();
  });

  it("swallows git errors (best-effort)", async () => {
    invoke.mockRejectedValue("git exploded");
    const update = await pollOnce("/repo", [{ beadId: "a", mergeSha: "x" }]);
    expect(update.signals[0]?.inRelease).toBe(false);
  });
});

describe("start/stop lifecycle", () => {
  it("fires an immediate tick and can be stopped", async () => {
    invoke.mockResolvedValue([]);
    const onUpdate = vi.fn();
    startDeliveryMonitor("/repo", onUpdate, () => [{ beadId: "a", mergeSha: "x" }], 999_999);
    expect(isDeliveryMonitorRunning()).toBe(true);
    // Immediate tick is async; flush microtasks.
    await vi.waitFor(() => expect(onUpdate).toHaveBeenCalled());
    stopDeliveryMonitor();
    expect(isDeliveryMonitorRunning()).toBe(false);
  });
});
