import { describe, it, expect } from "vitest";
import {
  ACTIVITY_FRESH_MS,
  stampActivity,
  selfReportBody,
} from "./useAttentionNotifications";

// Phase-2b: when an agent FRESHLY self-reported "what I'm building" (AgentTab.activity, via the
// sparkle-control set_agent_activity op) right as it crossed into a needs-you state, we use that
// text as the notification body and SKIP the paid Haiku ask-summary. Because `activity` carries no
// timestamp, freshness is derived from state visible in the hook: stampActivity observes activity
// CHANGES across effect runs, and selfReportBody applies the recency window. These are the guard
// that decides whether the paid call is skipped, so they carry the correctness weight.

describe("stampActivity — observes activity changes across effect runs", () => {
  it("stamps a first sighting as unknown age (at = 0), even when a value is already present", () => {
    // A value present on the very first sighting = restored from a previous session's persisted
    // state; its real age is unknown, so it must NOT count as a fresh in-session narration.
    const out = stampActivity({}, [{ id: "a", activity: "Restored line" }], 1000);
    expect(out.a).toEqual({ value: "Restored line", at: 0 });
  });

  it("stamps `now` when a KNOWN value changes (the agent just re-narrated)", () => {
    const prev = { a: { value: "old", at: 0 } };
    const out = stampActivity(prev, [{ id: "a", activity: "new task" }], 5000);
    expect(out.a).toEqual({ value: "new task", at: 5000 });
  });

  it("keeps the prior stamp when the value is unchanged (age is measured from first appearance)", () => {
    const prev = { a: { value: "same", at: 4200 } };
    const out = stampActivity(prev, [{ id: "a", activity: "same" }], 9999);
    expect(out.a).toEqual({ value: "same", at: 4200 });
  });

  it("trims whitespace and treats blank/undefined activity as the empty value", () => {
    expect(stampActivity({}, [{ id: "a", activity: "  hi  " }], 1).a!.value).toBe("hi");
    expect(stampActivity({}, [{ id: "a", activity: "   " }], 1).a!.value).toBe("");
    expect(stampActivity({}, [{ id: "a" }], 1).a!.value).toBe("");
  });

  it("prunes departed agents so a return gets a fresh first-sighting (at = 0)", () => {
    const prev = { a: { value: "x", at: 100 }, b: { value: "y", at: 200 } };
    const out = stampActivity(prev, [{ id: "b", activity: "y" }], 300);
    expect(out.a).toBeUndefined(); // pruned
    expect(out.b).toEqual({ value: "y", at: 200 }); // unchanged → kept
    // 'a' returning later is a first sighting again → unknown age.
    expect(stampActivity(out, [{ id: "a", activity: "x" }], 400).a).toEqual({ value: "x", at: 0 });
  });
});

describe("selfReportBody — precedence gate for the notification body", () => {
  const now = 100_000;

  it("uses a FRESH in-session narration for a WAITING body (→ Haiku is skipped)", () => {
    const stamp = { value: "Wiring the relay", at: now - 2_000 }; // 2s old, well inside the window
    expect(selfReportBody("Wiring the relay", stamp, now, "waiting")).toBe("Wiring the relay");
  });

  it("does NOT substitute narration for an APPROVAL body — approval must describe the action, so it keeps Haiku", () => {
    const stamp = { value: "Wiring the relay", at: now - 2_000 }; // fresh, but wrong signal for an approval ask
    expect(selfReportBody("Wiring the relay", stamp, now, "approval")).toBeNull();
  });

  it("falls back (null) when the narration is STALE (older than the freshness window)", () => {
    const stamp = { value: "Old thing", at: now - (ACTIVITY_FRESH_MS + 1) };
    expect(selfReportBody("Old thing", stamp, now, "waiting")).toBeNull();
  });

  it("treats a first-sighting stamp (at = 0) as stale → null (persisted-restore is not fresh)", () => {
    expect(selfReportBody("Restored", { value: "Restored", at: 0 }, now, "waiting")).toBeNull();
  });

  it("falls back (null) when there is no narration at all", () => {
    expect(selfReportBody(undefined, undefined, now, "waiting")).toBeNull();
    expect(selfReportBody("   ", { value: "", at: now }, now, "waiting")).toBeNull();
    expect(selfReportBody("x", undefined, now, "waiting")).toBeNull(); // never observed → no stamp
  });

  it("never fires for non-ask statuses — errored/idle keep their existing generic copy", () => {
    const fresh = { value: "Building X", at: now };
    expect(selfReportBody("Building X", fresh, now, "errored")).toBeNull();
    expect(selfReportBody("Building X", fresh, now, "idle")).toBeNull();
    expect(selfReportBody("Building X", fresh, now, undefined)).toBeNull();
  });

  it("accepts a narration exactly at the freshness boundary, rejects one just past it", () => {
    const at = now - ACTIVITY_FRESH_MS; // exactly at the edge
    expect(selfReportBody("edge", { value: "edge", at }, now, "waiting")).toBe("edge");
    expect(selfReportBody("edge", { value: "edge", at: at - 1 }, now, "waiting")).toBeNull();
  });
});
