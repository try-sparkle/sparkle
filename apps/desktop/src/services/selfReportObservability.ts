// Phase-2c gate instrumentation (sparkle-rl84). Thin wrappers that, at each self-report/paid-fallback
// decision point, do BOTH things in one place: emit the privacy-safe PostHog event AND bump the
// always-local in-memory counter (useSelfReportMetrics). Keeping them together means an instrumentation
// site can't drift out of sync between the two surfaces.
//
// PRIVACY: every prop below is a NON-IDENTIFYING enum — an op name, an agent `kind`
// (build/worker/think/shell), an outcome/source enum, or a status. NO agent names, activity text,
// prompt content, file paths, or branch names ever reach a prop. PostHog masking does NOT scrub
// explicit props, so this allow-list of enum-only props IS the privacy guarantee. If you extend these,
// only add more enums/booleans/counts — never free text.
import { capture } from "../analytics";
import { ANALYTICS_EVENTS } from "@sparkle/core";
import {
  useSelfReportMetrics,
  type AttentionSource,
  type ControlOp,
  type NamingOutcome,
} from "../stores/selfReportMetrics";
import type { AgentKind, AgentTabStatus } from "../types";

/** Agent kind for a prop, collapsing an unresolvable caller/target to the non-identifying "unknown". */
type KindProp = AgentKind | "unknown";
const kindProp = (k: AgentKind | undefined): KindProp => k ?? "unknown";

/**
 * A Claude agent successfully invoked a sparkle-control tool — the PRIMARY self-report signal
 * (rename_agent / set_agent_activity especially). `callerKind`/`targetKind` may be undefined when the
 * agent id doesn't resolve (stale/spoofed); they collapse to "unknown".
 */
export function reportControlOp(
  op: ControlOp,
  callerKind: AgentKind | undefined,
  targetKind: AgentKind | undefined,
): void {
  capture(ANALYTICS_EVENTS.SELF_REPORT_CONTROL_OP, {
    op,
    caller_kind: kindProp(callerKind),
    target_kind: kindProp(targetKind),
  });
  useSelfReportMetrics.getState().recordControlOp(op);
}

/** The outcome of one auto-naming trigger (self-report/aiTitle vs paid Haiku fallback vs skip). */
export function reportNamingOutcome(outcome: NamingOutcome, kind: AgentKind): void {
  capture(ANALYTICS_EVENTS.AGENT_NAMING_OUTCOME, { outcome, kind });
  useSelfReportMetrics.getState().recordNamingOutcome(outcome);
}

/** What supplied a needs-you notification body (self-report vs paid Haiku vs generic). */
export function reportAttentionSource(
  source: AttentionSource,
  status: AgentTabStatus,
  kind: AgentKind,
): void {
  capture(ANALYTICS_EVENTS.ATTENTION_BODY_SOURCE, { source, status, kind });
  useSelfReportMetrics.getState().recordAttentionSource(source);
}
