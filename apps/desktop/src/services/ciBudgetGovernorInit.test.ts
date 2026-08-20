import { describe, it, expect, afterEach } from "vitest";
import { ciLoadFromHealth, applyFleetConfig } from "./ciBudgetGovernorInit";
import { ciBudgetGovernor } from "./ciBudgetGovernor";
import type { PipelineHealth } from "../stores/pipelineHealthStore";
import type { EffectiveConfig } from "./config";

// A health reading with a given releaseInProgress, plus a ci_runners component (which the mapping no
// longer reads for the decision, but production always includes it — proving it is ignored).
const health = (releaseInProgress: boolean | null | undefined): PipelineHealth =>
  ({
    overall: "healthy",
    components: [{ id: "ci_runners", name: "CI", state: "warning", detail: "busy" }],
    ...(releaseInProgress === undefined ? {} : { releaseInProgress }),
  }) as PipelineHealth;

const eff = (fleet: { ci_budget: number; ci_lease_secs: number } | undefined): EffectiveConfig =>
  ({ config: { fleet }, warnings: [] }) as unknown as EffectiveConfig;

afterEach(() => {
  // Leave the shared singleton inert so no other test file inherits a budget.
  ciBudgetGovernor.configure({ budget: 0, leaseMs: 900_000, loadProbe: () => ({ releaseInProgress: null }) });
});

describe("ciLoadFromHealth — the Rust→TS release signal boundary (fail-safe on UNKNOWN)", () => {
  it("maps a busy release runner to a hold signal", () => {
    expect(ciLoadFromHealth(health(true))).toEqual({ releaseInProgress: true });
  });

  it("maps an idle release runner to no hold", () => {
    expect(ciLoadFromHealth(health(false))).toEqual({ releaseInProgress: false });
  });

  it("a NULL field (Rust Option::None on the wire) is UNKNOWN, not 'no release'", () => {
    expect(ciLoadFromHealth(health(null))).toEqual({ releaseInProgress: null });
  });

  it("an ABSENT field (older backend) is UNKNOWN, not 'no release'", () => {
    expect(ciLoadFromHealth(health(undefined))).toEqual({ releaseInProgress: null });
  });

  it("a missing reading is UNKNOWN", () => {
    expect(ciLoadFromHealth(null)).toEqual({ releaseInProgress: null });
  });
});

describe("applyFleetConfig — [fleet] knobs reach the singleton (with clamping + s→ms)", () => {
  it("applies ci_budget and converts ci_lease_secs to ms", () => {
    applyFleetConfig(eff({ ci_budget: 3, ci_lease_secs: 120 }));
    expect(ciBudgetGovernor.budgetValue).toBe(3);
    expect(ciBudgetGovernor.leaseMsValue).toBe(120_000);
  });

  it("clamps a negative budget to 0 and floors fractional values", () => {
    applyFleetConfig(eff({ ci_budget: -5, ci_lease_secs: 2.9 }));
    expect(ciBudgetGovernor.budgetValue).toBe(0);
    expect(ciBudgetGovernor.leaseMsValue).toBe(2000); // floor(2.9) = 2 → 2000ms
  });

  it("leaves the governor UNCHANGED when [fleet] is absent (old backend → no silent throttle)", () => {
    ciBudgetGovernor.configure({ budget: 7, leaseMs: 5000 });
    applyFleetConfig(eff(undefined));
    expect(ciBudgetGovernor.budgetValue).toBe(7); // untouched, not reset to a default
    expect(ciBudgetGovernor.leaseMsValue).toBe(5000);
  });
});
