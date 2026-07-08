// selfReportMetrics — an in-memory, SESSION-SCOPED tally of the Phase-2c gate signals: how often
// in-app Claude agents SELF-REPORT (via the sparkle-control MCP tools + their own aiTitle/pinned
// names) versus falling back to the PAID Haiku paths (agent naming + attention summary). It mirrors
// the PostHog events in @sparkle/core (SELF_REPORT_CONTROL_OP / AGENT_NAMING_OUTCOME /
// ATTENTION_BODY_SOURCE) so the founder can eyeball coverage locally with NO PostHog key configured.
//
// PRIVACY: this store holds COUNTS ONLY, keyed by non-identifying enums (op name, naming-outcome,
// attention-source). It NEVER stores agent names, activity text, prompts, file paths, or branch
// names. NOT persisted and NEVER hits the network — it resets to zero on every app launch, which is
// exactly what a "this session" readout wants.
import { create } from "zustand";

/** The sparkle-control ops we tally (the controlListener dispatch surface). */
export type ControlOp =
  | "rename_agent"
  | "set_agent_activity"
  | "set_theme"
  | "get_config"
  | "set_config"
  | "get_state"
  // Phase-3 breadth ops (pin/order/zoom/model/navigate). Tallied like the rest so the counter
  // typechecks and any future coverage readout can see them.
  | "pin_agent"
  | "unpin_agent"
  | "set_agent_model"
  | "set_agent_ordering"
  | "set_zoom"
  | "navigate";

/** The mutually-exclusive result of one auto-naming trigger (see agentNaming.namingOutcome). */
export type NamingOutcome =
  | "ai_title" // Claude Code's own session title won — no call
  | "self_named" // the agent pinned its own name (rename_agent) or the user did — no call
  | "deferred_first_turn" // self-reporting agent's first prompt — deferred to let it self-name
  | "paid_haiku_fallback" // actually spent a paid generate_agent_name call
  | "skipped_thin"; // nothing worth naming (thin/tactical/unchanged) — no call

/** What supplied a needs-you notification body. */
export type AttentionSource =
  | "self_report" // a fresh set_agent_activity narration supplied the body
  | "paid_haiku" // the paid summarize_attention screen-scrape supplied it
  | "generic_fallback"; // neither — the generic reason copy was used

interface SelfReportMetricsState {
  /** op → count of successful sparkle-control invocations this session. */
  controlOps: Record<ControlOp, number>;
  /** naming outcome → count this session. */
  namingOutcomes: Record<NamingOutcome, number>;
  /** attention body source → count this session. */
  attentionSources: Record<AttentionSource, number>;
  recordControlOp: (op: ControlOp) => void;
  recordNamingOutcome: (outcome: NamingOutcome) => void;
  recordAttentionSource: (source: AttentionSource) => void;
  /** Zero everything (test hook + a possible future "reset session" affordance). */
  reset: () => void;
}

const emptyControlOps = (): Record<ControlOp, number> => ({
  rename_agent: 0,
  set_agent_activity: 0,
  set_theme: 0,
  get_config: 0,
  set_config: 0,
  get_state: 0,
  pin_agent: 0,
  unpin_agent: 0,
  set_agent_model: 0,
  set_agent_ordering: 0,
  set_zoom: 0,
  navigate: 0,
});

const emptyNamingOutcomes = (): Record<NamingOutcome, number> => ({
  ai_title: 0,
  self_named: 0,
  deferred_first_turn: 0,
  paid_haiku_fallback: 0,
  skipped_thin: 0,
});

const emptyAttentionSources = (): Record<AttentionSource, number> => ({
  self_report: 0,
  paid_haiku: 0,
  generic_fallback: 0,
});

export const useSelfReportMetrics = create<SelfReportMetricsState>((set) => ({
  controlOps: emptyControlOps(),
  namingOutcomes: emptyNamingOutcomes(),
  attentionSources: emptyAttentionSources(),
  recordControlOp: (op) =>
    set((s) => ({ controlOps: { ...s.controlOps, [op]: s.controlOps[op] + 1 } })),
  recordNamingOutcome: (outcome) =>
    set((s) => ({
      namingOutcomes: { ...s.namingOutcomes, [outcome]: s.namingOutcomes[outcome] + 1 },
    })),
  recordAttentionSource: (source) =>
    set((s) => ({
      attentionSources: { ...s.attentionSources, [source]: s.attentionSources[source] + 1 },
    })),
  reset: () =>
    set({
      controlOps: emptyControlOps(),
      namingOutcomes: emptyNamingOutcomes(),
      attentionSources: emptyAttentionSources(),
    }),
}));

/**
 * Naming coverage: self-report/aiTitle successes over (self-report + paid Haiku). `deferred_first_turn`
 * (still pending) and `skipped_thin` (nothing to name) are neither a covered win nor a paid loss, so
 * they're excluded from BOTH sides of the ratio. `pct` is null when there's no signal yet (0/0). Pure.
 */
export function namingCoverage(outcomes: Record<NamingOutcome, number>): {
  covered: number;
  paid: number;
  pct: number | null;
} {
  const covered = outcomes.ai_title + outcomes.self_named;
  const paid = outcomes.paid_haiku_fallback;
  const total = covered + paid;
  return { covered, paid, pct: total === 0 ? null : covered / total };
}

/**
 * Attention coverage: self-report bodies over (self-report + paid Haiku). `generic_fallback` is the
 * no-ask / errored case (no summary was needed), so it's excluded from the denominator. `pct` is null
 * when there's no signal yet. Pure.
 */
export function attentionCoverage(sources: Record<AttentionSource, number>): {
  selfReport: number;
  paid: number;
  pct: number | null;
} {
  const selfReport = sources.self_report;
  const paid = sources.paid_haiku;
  const total = selfReport + paid;
  return { selfReport, paid, pct: total === 0 ? null : selfReport / total };
}
