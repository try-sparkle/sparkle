import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture the exact (event, props) pairs the wrappers emit so we can assert the PRIVACY contract:
// props must contain ONLY the non-identifying enum/count keys — never agent names, activity text,
// prompts, file paths, or branch names. (PostHog masking does NOT scrub explicit props, so this is
// the guarantee.)
const captured: Array<{ event: string; props: Record<string, unknown> | undefined }> = [];
vi.mock("../analytics", () => ({
  capture: (event: string, props?: Record<string, unknown>) => captured.push({ event, props }),
}));

import {
  reportControlOp,
  reportNamingOutcome,
  reportAttentionSource,
} from "./selfReportObservability";
import { useSelfReportMetrics } from "../stores/selfReportMetrics";

// The ONLY prop keys any self-report event may carry.
const ALLOWED_KEYS = new Set([
  "op",
  "caller_kind",
  "target_kind",
  "outcome",
  "kind",
  "source",
  "status",
]);
// Values that are always safe: the fixed enums we emit. Anything outside this set in a prop value
// would be a red flag for an identifying leak.
const ALLOWED_VALUES = new Set<unknown>([
  // ops
  "rename_agent",
  "set_agent_activity",
  "set_theme",
  "get_config",
  "set_config",
  "get_state",
  // kinds (+ the unresolved sentinel)
  "build",
  "worker",
  "think",
  "shell",
  "unknown",
  // naming outcomes
  "ai_title",
  "self_named",
  "deferred_first_turn",
  "paid_haiku_fallback",
  "skipped_thin",
  // attention sources
  "self_report",
  "paid_haiku",
  "generic_fallback",
  // statuses (needs-you tier + neighbours)
  "waiting",
  "approval",
  "errored",
  "running",
  "idle",
]);

describe("selfReportObservability wrappers — emit event + bump counter, privacy-safe props", () => {
  beforeEach(() => {
    captured.length = 0;
    useSelfReportMetrics.getState().reset();
  });

  it("reportControlOp emits self_report_control_op with only {op, caller_kind, target_kind} and bumps the counter", () => {
    reportControlOp("rename_agent", "build", "worker");
    expect(captured).toHaveLength(1);
    expect(captured[0]!.event).toBe("self_report_control_op");
    expect(captured[0]!.props).toEqual({ op: "rename_agent", caller_kind: "build", target_kind: "worker" });
    expect(useSelfReportMetrics.getState().controlOps.rename_agent).toBe(1);
  });

  it("collapses an unresolved caller/target kind to the non-identifying 'unknown'", () => {
    reportControlOp("get_state", undefined, undefined);
    expect(captured[0]!.props).toEqual({ op: "get_state", caller_kind: "unknown", target_kind: "unknown" });
  });

  it("reportNamingOutcome emits agent_naming_outcome with only {outcome, kind} and bumps the counter", () => {
    reportNamingOutcome("paid_haiku_fallback", "worker");
    expect(captured[0]!.event).toBe("agent_naming_outcome");
    expect(captured[0]!.props).toEqual({ outcome: "paid_haiku_fallback", kind: "worker" });
    expect(useSelfReportMetrics.getState().namingOutcomes.paid_haiku_fallback).toBe(1);
  });

  it("reportAttentionSource emits attention_body_source with only {source, status, kind} and bumps the counter", () => {
    reportAttentionSource("self_report", "waiting", "build");
    expect(captured[0]!.event).toBe("attention_body_source");
    expect(captured[0]!.props).toEqual({ source: "self_report", status: "waiting", kind: "build" });
    expect(useSelfReportMetrics.getState().attentionSources.self_report).toBe(1);
  });

  it("NEVER puts identifying data in props — every key is allow-listed and every value is a known enum", () => {
    // Exercise all three wrappers across kinds/outcomes/sources.
    reportControlOp("set_agent_activity", "worker", "worker");
    reportNamingOutcome("ai_title", "build");
    reportNamingOutcome("skipped_thin", "shell");
    reportAttentionSource("paid_haiku", "approval", "worker");
    reportAttentionSource("generic_fallback", "errored", "build");
    for (const { props } of captured) {
      expect(props).toBeDefined();
      for (const [k, v] of Object.entries(props!)) {
        expect(ALLOWED_KEYS.has(k)).toBe(true);
        expect(ALLOWED_VALUES.has(v)).toBe(true);
        // Belt-and-suspenders: no prop value is free text like a name/path/branch.
        expect(typeof v === "string" && v.includes("/")).toBe(false);
        expect(typeof v === "string" && v.includes(" ")).toBe(false);
      }
    }
  });
});
