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
  | "navigate"
  | "append_communication_guideline"
  // Intent, made legible to the other actor that can merge. `set_agent_goal` is the readable half
  // of a field that used to be write-only; claim/release let an agent say "I am landing this
  // myself" somewhere the concierge can see it. See services/mergeGuard/types.ts for the incident.
  | "set_agent_goal"
  | "set_agent_goal_met"
  // The concierge's BOUNDED lever on `escalated` (bead sparkle-hm4z9). Not a self-report at all —
  // it is the one op on this surface only the concierge may call — but it is tallied like the rest
  // so the tier table stays exhaustive (see the `chief_tool` note below for what an omission costs).
  | "set_agent_escalation"
  | "claim_pr"
  | "release_pr"
  // The concierge's tool spine (services/conciergeTools/registry). ONE op carrying a
  // { domain, op, args } envelope, so this counter answers "is the concierge actually using its
  // tools?" without recording WHICH tool — the op name is all that is stored, same as every other
  // key here, and the domain/op inside the payload is deliberately not tallied.
  | "concierge_tool"
  // Agent-to-agent peer messaging (bead `sparkle-0vl92`). The op NAME only — never `to` and never
  // the message body, which is the most identifying payload this op carries (see the privacy note).
  | "send_peer_message"
  // The Chief tool spine (services/chiefScope + controlListener's handleChiefTool). ONE op for all
  // twelve first-class `chief_*` tools and the `chief_call` hatch, same envelope reasoning as
  // `concierge_tool` above.
  //
  // IT IS A MEMBER FOR A REASON BEYOND TALLYING (roborev 63142). `CONTROL_OP_TIERS` is
  // `Record<ControlOp, …>`, and `dispatch` reads it as `CONTROL_OP_TIERS[req.op as ControlOp]` —
  // so an op named OUTSIDE this union does not fail the typecheck the tier table's doc-comment
  // promises it will. It silently evaluates to `undefined`, the `=== "privileged"` test is false,
  // and `callerMayAdminister` is skipped by OMISSION rather than by decision. `chief_tool` was in
  // exactly that state: free by accident. Adding it here is what makes the exhaustiveness claim
  // true again, and what forces the next op to state its tier.
  | "chief_tool"
  // The live browser preview (bead `sparkle-3475b.6`) — ONE op carrying open/close/list, so this
  // counter answers "are agents showing their work at all". The op NAME only, like every other key
  // here: never the route, which names the caller's real work (see the privacy note above).
  | "preview";

/** The mutually-exclusive result of one auto-naming trigger (see agentNaming.namingOutcome). */
export type NamingOutcome =
  | "ai_title" // Claude Code's own session title won — no call
  | "self_named" // the agent pinned its own name (rename_agent) or the user did — no call
  | "deferred_first_turn" // self-reporting agent's first prompt — deferred to let it self-name
  | "paid_haiku_fallback" // actually spent a paid generate_agent_name call
  | "skipped_thin" // nothing worth naming (thin/tactical/unchanged) — no call
  // Name-from-work fallback (sparkle name-from-work): a build/worker doing real work but only ever
  // handed tactical/no composer prompts, so it never left its "Build N"/"Worker N" default. These
  // fire OUTSIDE the composer path, on the sidebar poll tick.
  | "named_from_session_title_backfill" // Tier 1: applied Claude Code's aiTitle to a CLOSED default-named agent (free win)
  | "work_haiku_backstop" // Tier 2: spent a paid generate_agent_name call using the agent's WORK as basis
  | "work_backstop_skipped"; // Tier 2 declined: no usable work basis (kept the default)

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
  chief_tool: 0,
  rename_agent: 0,
  set_agent_activity: 0,
  set_agent_goal: 0,
  set_agent_goal_met: 0,
  set_agent_escalation: 0,
  claim_pr: 0,
  release_pr: 0,
  append_communication_guideline: 0,
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
  concierge_tool: 0,
  send_peer_message: 0,
  preview: 0,
});

const emptyNamingOutcomes = (): Record<NamingOutcome, number> => ({
  ai_title: 0,
  self_named: 0,
  deferred_first_turn: 0,
  paid_haiku_fallback: 0,
  skipped_thin: 0,
  named_from_session_title_backfill: 0,
  work_haiku_backstop: 0,
  work_backstop_skipped: 0,
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
  // A session-title backfill is a FREE win (Claude Code's own title), grouped with the other covered
  // wins; the work-based Haiku backstop is a PAID call, grouped with the composer-path paid fallback.
  // `work_backstop_skipped` (no usable basis, default kept) is neither, like `skipped_thin`.
  const covered = outcomes.ai_title + outcomes.self_named + outcomes.named_from_session_title_backfill;
  const paid = outcomes.paid_haiku_fallback + outcomes.work_haiku_backstop;
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
