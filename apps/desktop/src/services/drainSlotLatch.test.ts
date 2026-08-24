import { describe, it, expect, beforeEach } from "vitest";
import {
  busyDrainSlotCount,
  isDrainSlotBusy,
  busyDrainSlots,
  claimDrainSlot,
  releaseDrainSlot,
  resetDrainSlotsForTests,
} from "./drainSlotLatch";
import { drainSlotAgentId, isDrainSlotAgentId } from "./drainSlotRunner";

describe("drainSlotLatch (per-slot in-flight set)", () => {
  beforeEach(() => resetDrainSlotsForTests());

  it("claims distinct slots in parallel and counts them", () => {
    expect(claimDrainSlot("a")).toBe(true);
    expect(claimDrainSlot("b")).toBe(true);
    // The SIDE EFFECT: both are in flight at once — the whole point of the bounded fleet.
    expect(busyDrainSlotCount()).toBe(2);
    expect(busyDrainSlots().sort()).toEqual(["a", "b"]);
    expect(isDrainSlotBusy("a")).toBe(true);
  });

  it("refuses a re-claim of a slot already in flight (no double-run)", () => {
    expect(claimDrainSlot("a")).toBe(true);
    expect(claimDrainSlot("a")).toBe(false); // already held
    expect(busyDrainSlotCount()).toBe(1);
  });

  it("release frees the slot so it can be re-claimed", () => {
    claimDrainSlot("a");
    releaseDrainSlot("a");
    expect(isDrainSlotBusy("a")).toBe(false);
    expect(busyDrainSlotCount()).toBe(0);
    expect(claimDrainSlot("a")).toBe(true); // reusable after release
  });
});

describe("drain slot agent ids", () => {
  it("are distinct per index and never equal the hourly id", () => {
    expect(drainSlotAgentId(0)).toBe("__sparkle_self__-drain-0");
    expect(drainSlotAgentId(1)).not.toBe(drainSlotAgentId(0));
    expect(drainSlotAgentId(0)).not.toBe("__sparkle_self__"); // never the hourly/interactive slot
  });

  it("recognises a drain-slot id and rejects the hourly id", () => {
    expect(isDrainSlotAgentId(drainSlotAgentId(2))).toBe(true);
    expect(isDrainSlotAgentId("__sparkle_self__")).toBe(false);
    expect(isDrainSlotAgentId("some-other-agent")).toBe(false);
  });
});
