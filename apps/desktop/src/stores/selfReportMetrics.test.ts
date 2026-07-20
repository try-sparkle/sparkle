import { describe, it, expect, beforeEach } from "vitest";
import {
  useSelfReportMetrics,
  namingCoverage,
  attentionCoverage,
} from "./selfReportMetrics";

describe("useSelfReportMetrics — session-scoped increments", () => {
  beforeEach(() => {
    useSelfReportMetrics.getState().reset();
  });

  it("starts every counter at zero", () => {
    const s = useSelfReportMetrics.getState();
    expect(Object.values(s.controlOps).every((n) => n === 0)).toBe(true);
    expect(Object.values(s.namingOutcomes).every((n) => n === 0)).toBe(true);
    expect(Object.values(s.attentionSources).every((n) => n === 0)).toBe(true);
  });

  it("bumps a control op only for the op passed (no cross-talk)", () => {
    const { recordControlOp } = useSelfReportMetrics.getState();
    recordControlOp("rename_agent");
    recordControlOp("rename_agent");
    recordControlOp("set_agent_activity");
    const s = useSelfReportMetrics.getState();
    expect(s.controlOps.rename_agent).toBe(2);
    expect(s.controlOps.set_agent_activity).toBe(1);
    expect(s.controlOps.get_state).toBe(0);
  });

  it("bumps naming outcomes independently", () => {
    const { recordNamingOutcome } = useSelfReportMetrics.getState();
    recordNamingOutcome("ai_title");
    recordNamingOutcome("paid_haiku_fallback");
    recordNamingOutcome("paid_haiku_fallback");
    const s = useSelfReportMetrics.getState();
    expect(s.namingOutcomes.ai_title).toBe(1);
    expect(s.namingOutcomes.paid_haiku_fallback).toBe(2);
    expect(s.namingOutcomes.self_named).toBe(0);
  });

  it("bumps attention sources independently", () => {
    const { recordAttentionSource } = useSelfReportMetrics.getState();
    recordAttentionSource("self_report");
    recordAttentionSource("generic_fallback");
    const s = useSelfReportMetrics.getState();
    expect(s.attentionSources.self_report).toBe(1);
    expect(s.attentionSources.paid_haiku).toBe(0);
    expect(s.attentionSources.generic_fallback).toBe(1);
  });

  it("reset() zeroes every tally", () => {
    const st = useSelfReportMetrics.getState();
    st.recordControlOp("rename_agent");
    st.recordNamingOutcome("ai_title");
    st.recordAttentionSource("self_report");
    st.reset();
    const s = useSelfReportMetrics.getState();
    expect(s.controlOps.rename_agent).toBe(0);
    expect(s.namingOutcomes.ai_title).toBe(0);
    expect(s.attentionSources.self_report).toBe(0);
  });

  it("holds ONLY count keys — no identifying free-text ever lands in the store", () => {
    const st = useSelfReportMetrics.getState();
    st.recordControlOp("set_agent_activity");
    st.recordNamingOutcome("paid_haiku_fallback");
    const s = useSelfReportMetrics.getState();
    // Every stored value is a number; keys are the fixed enum set, never agent names / activity text.
    for (const rec of [s.controlOps, s.namingOutcomes, s.attentionSources]) {
      for (const v of Object.values(rec)) expect(typeof v).toBe("number");
    }
    expect(Object.keys(s.controlOps).sort()).toEqual(
      [
        "get_config", "get_state", "rename_agent", "set_agent_activity", "set_config", "set_theme",
        // Phase-3 breadth ops.
        "pin_agent", "unpin_agent", "set_agent_model", "set_agent_ordering", "set_zoom", "navigate",
      ].sort(),
    );
  });
});

describe("namingCoverage", () => {
  const base = {
    ai_title: 0,
    self_named: 0,
    deferred_first_turn: 0,
    paid_haiku_fallback: 0,
    skipped_thin: 0,
    named_from_session_title_backfill: 0,
    work_haiku_backstop: 0,
    work_backstop_skipped: 0,
  };

  it("returns null pct when there is no naming signal (0/0)", () => {
    expect(namingCoverage(base)).toEqual({ covered: 0, paid: 0, pct: null });
  });

  it("counts ai_title + self_named as covered, paid_haiku as paid", () => {
    const c = namingCoverage({ ...base, ai_title: 2, self_named: 1, paid_haiku_fallback: 1 });
    expect(c.covered).toBe(3);
    expect(c.paid).toBe(1);
    expect(c.pct).toBeCloseTo(0.75, 5);
  });

  it("excludes deferred and skipped from BOTH sides of the ratio", () => {
    const c = namingCoverage({ ...base, ai_title: 1, deferred_first_turn: 5, skipped_thin: 9 });
    expect(c.covered).toBe(1);
    expect(c.paid).toBe(0);
    expect(c.pct).toBe(1); // 1 / (1 + 0)
  });

  it("groups the name-from-work outcomes: session-title backfill=covered, work Haiku backstop=paid, skip=neither", () => {
    const c = namingCoverage({
      ...base,
      named_from_session_title_backfill: 3, // free Tier-1 win → covered
      work_haiku_backstop: 1, // paid Tier-2 call → paid
      work_backstop_skipped: 4, // no basis, default kept → excluded from both sides
    });
    expect(c.covered).toBe(3);
    expect(c.paid).toBe(1);
    expect(c.pct).toBeCloseTo(0.75, 5); // 3 / (3 + 1)
  });
});

describe("attentionCoverage", () => {
  it("returns null pct when there is no attention signal (0/0)", () => {
    expect(attentionCoverage({ self_report: 0, paid_haiku: 0, generic_fallback: 0 })).toEqual({
      selfReport: 0,
      paid: 0,
      pct: null,
    });
  });

  it("excludes generic_fallback from the denominator", () => {
    const c = attentionCoverage({ self_report: 3, paid_haiku: 1, generic_fallback: 10 });
    expect(c.selfReport).toBe(3);
    expect(c.paid).toBe(1);
    expect(c.pct).toBeCloseTo(0.75, 5);
  });
});
