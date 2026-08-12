import { describe, it, expect, beforeEach, vi } from "vitest";

// accountStore reaches Tauri for its command wrappers; the pin surface under test is pure +
// localStorage, so a stub invoke keeps the import side-effect-free (same shape as accountSwitch.test).
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { buildSwitchAllPlan, isSwitchComplete, type FleetProject } from "./accountSwitch";
import { getPin, clearAllPins } from "./accountStore";
import { CONCIERGE_ACCOUNT_KEY } from "./accountSelection";

beforeEach(() => clearAllPins());

// The manual "switch every agent + the concierge to one account" plan builder. Two guarantees the
// feature lives or dies by, both asserted as SIDE EFFECTS (the resulting plan / the recorded pin),
// never as a precondition:
//   1. EVERY agent across EVERY project is enrolled — not a subset.
//   2. The concierge is pinned to the same account (it has no pane, so it can't be in `pending`).
describe("buildSwitchAllPlan — the manual switch-all plan", () => {
  function fleet(): FleetProject[] {
    return [
      { agents: [{ id: "a1" }, { id: "a2" }] },
      { agents: [{ id: "b1" }] },
      { agents: [{ id: "c1" }, { id: "c2" }, { id: "c3" }] },
    ];
  }

  it("targets ALL agents across ALL projects, not a subset", () => {
    // 6 agents spread over 3 projects. A builder that only read projects[0], or filtered by a
    // `fromAccountId`, would enroll fewer than 6 — this is the mutation-provable assertion.
    const plan = buildSwitchAllPlan(fleet(), "target-acct");
    expect(plan.pending.sort()).toEqual(["a1", "a2", "b1", "c1", "c2", "c3"]);
    expect(plan.pending.length).toBe(6);
    expect(plan.toAccountId).toBe("target-acct");
    expect(plan.moved).toEqual([]);
    // No single account is being LEFT — the field is unused on an in-progress plan.
    expect(plan.fromAccountId).toBe("");
    // A brand-new plan with pending agents is not complete.
    expect(isSwitchComplete(plan)).toBe(false);
  });

  it("pins the CONCIERGE to the target account so it migrates too", () => {
    expect(getPin(CONCIERGE_ACCOUNT_KEY)).toBeUndefined();
    buildSwitchAllPlan(fleet(), "target-acct");
    // The side effect: the concierge key now names the target. Removing the setPin call in the
    // builder makes this read `undefined` and fails — it is the mutation guard for effect #2.
    expect(getPin(CONCIERGE_ACCOUNT_KEY)).toBe("target-acct");
  });

  it("also accepts an injected setPin, and records the concierge through it", () => {
    const setPinFn = vi.fn();
    buildSwitchAllPlan(fleet(), "target-acct", setPinFn);
    expect(setPinFn).toHaveBeenCalledWith(CONCIERGE_ACCOUNT_KEY, "target-acct");
  });

  it("de-dupes an agent id that appears twice across projects", () => {
    const plan = buildSwitchAllPlan(
      [{ agents: [{ id: "dup" }] }, { agents: [{ id: "dup" }, { id: "solo" }] }],
      "target-acct",
    );
    expect(plan.pending.sort()).toEqual(["dup", "solo"]);
  });

  it("still pins the concierge when the fleet is EMPTY (nothing to enroll)", () => {
    // No panes to move, but the concierge is always running — it must still be carried over.
    const plan = buildSwitchAllPlan([], "target-acct");
    expect(plan.pending).toEqual([]);
    expect(getPin(CONCIERGE_ACCOUNT_KEY)).toBe("target-acct");
    expect(isSwitchComplete(plan)).toBe(true);
  });
});
