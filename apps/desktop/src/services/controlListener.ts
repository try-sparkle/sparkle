// Frontend half of the app-level sparkle-control round-trip. Mirrors orchestrationListener.ts, but
// with one crucial difference: this is a SINGLETON APP-LEVEL surface, not per-build-agent. There is
// exactly one control bridge (one socket + token) started once at app boot, and it is available to
// EVERY agent kind (Build, Think, worker) — any in-app Claude can drive the Sparkle UI first-person.
//
// The Rust bridge emits a "control:request" Tauri event whenever any agent's sparkle-control MCP
// server calls an op. This listener dispatches on payload.op, mutates the relevant Zustand store (or
// invokes the existing Rust config commands), and replies EXACTLY once via control_respond.
//
// Identity model: the app-level socket is shared, so we cannot derive the caller from the socket the
// way the orchestrator does. Instead each agent's control-MCP child has SPARKLE_AGENT_ID injected at
// spawn (its AgentTab.id); the server stamps that as `callerAgentId` server-side (not caller-supplied
// in the tool args), preserving anti-spoofing. Per-agent ops (rename / activity) default their
// target to callerAgentId when `targetAgentId` is omitted.
//
// ONE caller is not an agent tab: the concierge brain (see CONCIERGE_CALLER_AGENT_ID). It connects
// on a SECOND, dedicated control socket whose every request Rust stamps with a reserved id, so its
// identity is structural rather than claimed. Everything below that says "the caller" still means
// an AgentTab id, except where the reserved id is called out explicitly.
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  canSelfMarkMet,
  selfMarkRefusal,
  parseGoalVerify,
  type GoalVerify,
  type GoalVerifyEvidence,
} from "@sparkle/core";
import { safeUnlisten } from "./safeUnlisten";
import { startControlBridge, controlRespond } from "./orchestrationLaunch";
import { useProjectStore } from "../stores/projectStore";
import { sideOf } from "../engine/pairs";
import { ZOOM_COLUMNS, isZoomColumn, type ZoomColumn } from "../engine/columnZoom";
import {
  useRuntimeStore,
  mergeOpenAgentIds,
  readPersistedOpenAgentIds,
} from "../stores/runtimeStore";
import { useUiStore, type ThemePref } from "../stores/uiStore";
import type { StatusBand } from "../engine/buildSections";
import { rollupDotAccessor } from "../engine/workerRollup";
import { agentDisplayName } from "../engine/agentDisplayName";
import { sparkleAgentIdFor, SPARKLE_AGENT_DISPLAY_NAME } from "./sparkleAgent";
import { sparkleActivityLine } from "./sparkleBusy";
import { APP_WINDOW_LABEL } from "../windowContext";
import { getConfig, setConfigValue, setConfigValues } from "./config";
import { appendConciergeGuideline } from "./conciergeGuidelines";
import { getModelCatalog } from "./models";
import { dispatchConciergeTool, type ConciergeToolReply } from "./conciergeTools/registry";
// THE CHIEF ACCESS-CONTROL CORE — pure, IO-free, and deliberately in its own module so the two gates
// can be unit-tested without a socket or a live token. This file is the ENFORCEMENT POINT that calls
// them; see the block above `handleChiefTool` for why the refusal cannot live anywhere else.
import {
  checkChiefTool,
  resolveChiefProject,
  type ChiefCaller,
  type ChiefClient,
} from "./chiefScope";
// What the concierge is doing right now, for the thread's thinking indicator. Recorded from the one
// call site that both sees every tool call and knows it came from the concierge — and read back by
// `selfIdentity` below, so the concierge can be told what it is doing rather than only the human.
import { noteConciergeToolCall, useConciergeActivityStore } from "./conciergeActivity";
import { conciergeActivityLine } from "../engine/conciergeActivityLine";
import { noteConciergeAuditCall } from "./conciergeAudit";
// The DURABLE half of "here is what I actually did" (bead sparkle-kr2jz). The thinking indicator
// renders one line and erases it when the turn ends, so the moment a reply lands "I sent it" and "I
// imagined sending it" look identical. A receipt outlives the turn; the classifier decides which
// calls earn one.
import { settleConciergeReceipt } from "./conciergeReceiptSettle";
import { currentConciergeTurnOrigin } from "./conciergeReceipts";
import { CONCIERGE_RECEIPT_APP_OPS } from "./conciergeReceiptClassifier";
import { conciergeToolConfigPath } from "./conciergeTools/policy";
import { appOpPolicy, chiefOpPolicy, configuredToolPolicy } from "./conciergeTools/policyBinding";
import {
  CHIEF_CALL_TOOL_ARG,
  chiefPolicyOpFor,
  type ChiefOp,
} from "./conciergeTools/chief";
import { createChiefMcpClient, resolveChiefPat } from "./chiefMcp";
import { chiefCallerFor, createChiefRegistry, type ChiefRegistry } from "./chiefRegistry";
import { APP_TOOL_NAMES, type AppToolName } from "./conciergeTools/policy";
import { reportControlOp } from "./selfReportObservability";
import { livenessOf } from "./agentLiveness";
// The one assembly of goal + stall + thrash, shared with conciergeTools/terminal.getAgentStatus so
// the roster sweep and the single-agent read cannot disagree about who is stalled.
import { goalReading, landedEvidenceFor, stallReadingFor, thrashReadingFor } from "./agentGoalReading";
// CALM FIRST, THEN ROLL UP — applied to the raw status map before any bucketing, so a row's own
// status, its rollup dot and its stall verdict cannot disagree about a never-briefed agent.
import { withNewAgentCalm } from "../engine/newAgentAttention";
import { normalizeAgentName } from "../engine/decodeEntities";
import { useInteractionStore } from "../stores/interactionStore";
import { setPrClaim, releasePrClaim, fetchPrClaims, findClaim } from "./mergeGuard/prClaims";
import type { ControlOp } from "../stores/selfReportMetrics";
import type { AgentTab, AgentTabStatus } from "../types";

const EVENT = "control:request";

/**
 * The RESERVED `callerAgentId` for the concierge brain (bead `sparkle-9a8j`, design A7.3).
 *
 * MIRRORS `CONCIERGE_CALLER_AGENT_ID` in `src-tauri/src/bridge.rs`, which is where the id is
 * actually MINTED — the Rust bridge stamps it on every request arriving on the concierge's own
 * control socket, and REJECTS any request on the shared socket that claims it. So by the time a
 * `control:request` event reaches this file, seeing this id is proof the request came in on that
 * socket. It is a structural fact, not a claim, which is what lets `callerMayAdminister` admit it
 * without weakening its fail-closed rule for everyone else.
 *
 * Never an AgentTab id (those are UUIDs; the colon makes collision impossible), so `findAgent` can
 * never resolve it and per-agent ops must not try — see `resolveTargetId`.
 *
 * The two literals must stay in step; the Rust test `concierge_caller_id_is_mirrored_in_typescript`
 * reads THIS FILE and fails if they drift.
 */
export const CONCIERGE_CALLER_AGENT_ID = "sparkle:concierge";

/** The ops we tally as self-report signals (must match ControlOp). Any op outside this set (an
 *  unknown op → the dispatch default) is never counted. */
/**
 * Which control ops feed the self-report counter — the TABLE, and the Set below is DERIVED from it.
 *
 * ══ WHY A TABLE AND NOT A SET LITERAL (roborev 54896, then 55029) ═══════════════════════════════
 * `append_communication_guideline` reached the `ControlOp` union and the counter's key map but not
 * the Set, so a successful append tallied zero forever with a green build. The first attempt at a
 * fix added a parallel `Record<ControlOp, true>` beside the Set and called it an exhaustiveness
 * check — but nothing tied a key in that record to membership in the Set, so the identical bug
 * still typechecked: add the op to the record, forget the literal, tally nothing. The reverse drift
 * was just as silent.
 *
 * Deriving the Set from this table is what actually makes it unrepresentable. A new op is a
 * compile error HERE, and answering it is a boolean — so "not tallied" is a decision someone typed
 * `false` for, not a line nobody wrote.
 */
const TALLY: Record<ControlOp, boolean> = {
  rename_agent: true,
  set_agent_activity: true,
  set_theme: true,
  get_config: true,
  set_config: true,
  get_state: true,
  pin_agent: true,
  unpin_agent: true,
  set_agent_model: true,
  set_agent_ordering: true,
  set_zoom: true,
  navigate: true,
  // The op NAME only — never the rule text, which is the most identifying payload on this surface
  // (see selfReportMetrics' privacy note).
  append_communication_guideline: true,
  // Counts how often the concierge actually reaches for a tool. The op name only — the domain and
  // op INSIDE the payload are not recorded (see selfReportMetrics' privacy note).
  concierge_tool: true,
  // Counts how often Chief is reached at all. The op name only — never the Chief tool, the project
  // or the arguments, all of which name real client work (see selfReportMetrics' privacy note).
  chief_tool: true,
  // Intent signals — see the mergeGuard module. Tallied like the rest; the op name only, never the
  // goal text or the claim note.
  set_agent_goal: true,
  set_agent_goal_met: true,
  claim_pr: true,
  release_pr: true,
};
const TALLIED_OPS = new Set<ControlOp>(
  (Object.keys(TALLY) as ControlOp[]).filter((op) => TALLY[op]),
);
/** The per-agent ops whose target may differ from the caller (default to caller when omitted). */
const PER_AGENT_OPS = new Set<ControlOp>([
  "rename_agent",
  "set_agent_activity",
  "set_agent_goal",
  "pin_agent",
  "unpin_agent",
  "set_agent_model",
]);
// NOTE: `claim_pr`, `release_pr` and `set_agent_goal_met` are deliberately NOT here. Every other per-agent op can name a
// target; a claim cannot. The claimant IS the caller, stamped by the bridge — letting a payload
// name it would let one agent claim a PR "as" another, which is exactly the confused-deputy hole
// the bridge closes by construction for every other identity on this surface. `set_agent_goal_met`
// is the same shape: an agent may only mark its OWN goal (only the reserved concierge id may name a
// target), so `targetKind` must mirror the CALLER. Leaving it in this set made
// `reportControlOpSuccess` resolve the ignored payload target instead, tallying a self-report
// against another agent's kind.

/**
 * The safety tier for EVERY control op — the single, explicit gate table (PRD §10/§11: the bridge
 * must ENFORCE which ops are free vs privileged, not leave it ad-hoc per handler).
 *
 * - `free`: pure reads + self-report ops any agent may run on its own initiative (naming itself,
 *   narrating its activity, reading state/config). No caller check.
 * - `privileged`: ops that mutate the human's GLOBAL app state (theme, config, ordering, zoom,
 *   navigation) or another agent's settings (pin/unpin/model). Require an interactive (non-worker)
 *   caller via `callerMayAdminister` — an unattended worker must not change the human's UI on its
 *   own. Enforced centrally in `dispatch()` before the op runs.
 *
 * The table is EXHAUSTIVE over ControlOp, so adding a new op forces an explicit tier decision (a
 * missing entry fails the typecheck). NOTE: only two tiers today. A future third tier (e.g.
 * "human-confirm" for ops that spend money / change the model) is an open founder decision (PRD
 * §10) — it would slot in as another union member here + a matching branch in dispatch.
 */
const CONTROL_OP_TIERS: Record<ControlOp, "free" | "privileged"> = {
  get_state: "free",
  rename_agent: "free",
  set_agent_activity: "free",
  // get_config is a read of non-sensitive workflow/worker settings — free, matching its previously
  // ungated behavior (only writes are privileged).
  get_config: "free",
  set_theme: "privileged",
  set_config: "privileged",
  // Phase-3 breadth ops — all privileged: they mutate the human's global UI (ordering, zoom,
  // navigation) or another agent's settings (pin/unpin/model), so an unattended worker must not
  // run them on its own initiative.
  pin_agent: "privileged",
  unpin_agent: "privileged",
  set_agent_model: "privileged",
  set_agent_ordering: "privileged",
  set_zoom: "privileged",
  navigate: "privileged",
  // Writes the file that shapes how the app speaks to the human, on every turn. Privileged for the
  // same reason as the rest of this block: an unattended worker must not edit it on its own.
  append_communication_guideline: "privileged",
  // The concierge's tool spine. PRIVILEGED, and then some: the tier gate here is the ordinary
  // "no unattended workers" check, and `handleConciergeTool` narrows it further to the ONE reserved
  // caller. Both gates matter — this op reaches agent lifecycle, git, the workspace and a PTY, so a
  // near-miss caller id must not get within reach of it. See the handler.
  concierge_tool: "privileged",
  // FREE, AND THAT IS NOW A DECISION RATHER THAN AN OMISSION (roborev 63142). Until `chief_tool`
  // joined the `ControlOp` union this lookup returned `undefined` for it, so the privileged branch
  // was skipped by accident. Free is nonetheless the right tier: Chief is work an unattended build
  // agent legitimately does, and the thing that must gate it is not "is this caller interactive"
  // but WHICH project and WHICH verb — `handleChiefTool`'s two gates, plus the concierge autonomy
  // gate in `dispatch`. A `privileged` tier here would deny every worker its bound project while
  // leaving the concierge (which clears that check outright) exactly as reachable as before.
  chief_tool: "free",
  // FREE because it is SELF-REPORT — an agent saying what it is trying to finish, the same class of
  // thing as `set_agent_activity`. It also has to be reachable by an UNATTENDED worker: the
  // auto-continue prompt tells a resumed agent to report through this family, and a tier that denied
  // workers would make that instruction a dead end for exactly the agents it is aimed at.
  //
  // ⚠️ UNLIKE `claim_pr`/`release_pr` BELOW, THIS ONE IS TARGETABLE. It is in `PER_AGENT_OPS`, it is
  // not caller-stamped, and it deliberately CAN reach another agent — a worker in the caller's own
  // subtree. The closure that makes that safe is `mayWriteAgentFieldFor`, not the tier: `free` here is a
  // statement about WHO MAY CALL IT, and says nothing about whose goal they may write. Do not read
  // the "neither op can touch another agent" note below as covering this entry; it does not, and a
  // previous edit left it looking as though it did (roborev 55599).
  set_agent_goal: "free",
  // Caller-stamped: an agent may only mark its OWN goal met (only the reserved concierge id may name
  // a target), because declaring a different live agent finished latches its `metAt` and renders a
  // possibly-stalled agent done.
  set_agent_goal_met: "free",
  // FREE, like `set_agent_activity` and for the same reason: an agent's report about its OWN work. A
  // worker that cannot say "I am landing this myself" is a worker whose intent stays invisible, which
  // is the failure this whole surface exists to fix — gating it behind interactive-only would
  // reintroduce #806 for exactly the agents most likely to be holding a PR. Neither of THESE TWO can
  // touch another agent: the claimant is the bridge-stamped caller, and the registry refuses a release
  // by anyone else.
  claim_pr: "free",
  release_pr: "free",
};

/**
 * Control ops the concierge policy gate does NOT consult (roborev 54255, finding 3).
 *
 * `concierge_tool` is exempt because its own handler applies the policy to the INNER { domain, op }
 * — the thing that actually needs gating. The other two are RETIRED: their handlers refuse
 * unconditionally and neither is registered in the MCP server, so they are deliberately absent from
 * `APP_TOOL_NAMES` and must keep returning their own "was removed" explanation rather than a
 * policy refusal blaming a Settings row that does not exist.
 */
const CONCIERGE_EXEMPT_OPS = new Set<ControlOp>([
  "concierge_tool",
  "pin_agent",
  "set_agent_ordering",
  // Retired 2026-07-31 with agent pinning, joining the two above. Exempt rather than classified so
  // the refusing handler is UNREACHABLE from the concierge instead of being advertised as a
  // togglable Settings row for a tool that can only decline.
  "unpin_agent",
]);

/**
 * STRUCTURAL COVERAGE CHECK — every control op is either policy-classified or explicitly exempt.
 *
 * Without this, adding a control op later makes it silently unreachable for the concierge: the gate
 * denies any op the policy layer cannot classify, so the new op would fail with an error blaming a
 * Settings toggle the human never touched, and no test or typecheck would catch it. Keyed off
 * `AppToolName` so the failure is a COMPILE error at the moment the op is added, naming the op.
 *
 * Purely a type-level assertion; it costs nothing at runtime.
 */
type _ConciergeGateCoversEveryControlOp = {
  [K in Exclude<ControlOp, ControlOpExemptFromConciergePolicy>]: K extends AppToolName
    ? true
    : ["control op is missing from APP_TOOL_NAMES in conciergeTools/policy.ts", K];
};
type ControlOpExemptFromConciergePolicy =
  | "concierge_tool"
  | "pin_agent"
  | "set_agent_ordering"
  | "unpin_agent"
  // EXEMPT FROM *THIS* CHECK ONLY, AND NOT FROM THE GATE — the one place these two lists differ,
  // so read the difference rather than pattern-matching the name (roborev 63142). This type asks
  // "is the op classified in `APP_TOOL_NAMES`", and `chief_tool` deliberately is not: its policy
  // rows live in the CHIEF domain (`conciergeTools/chief.ts`), keyed by the inner verb, because the
  // wrapper name is not something a human would ever set a rule for. `dispatch` gates it by
  // translating to that inner verb via `chiefPolicyOpFor`. Note it is absent from the RUNTIME
  // `CONCIERGE_EXEMPT_OPS` set above, and that asymmetry is the whole point: adding it there would
  // skip the gate and restore the hole this branch just closed.
  | "chief_tool";
// Instantiating it is what makes the mapped type actually check.
const _conciergeGateCoverage: _ConciergeGateCoversEveryControlOp = {
  get_state: true,
  get_config: true,
  rename_agent: true,
  set_agent_activity: true,
  append_communication_guideline: true,
  set_theme: true,
  set_config: true,
  set_agent_model: true,
  set_zoom: true,
  navigate: true,
  set_agent_goal: true,
  set_agent_goal_met: true,
  claim_pr: true,
  release_pr: true,
};
void _conciergeGateCoverage;

/** The Tauri event payload the Rust bridge emits for every sparkle-control op (frozen contract). */
export interface ControlRequest {
  reqId: string;
  op: string;
  /** The agent that made the call — stamped server-side from SPARKLE_AGENT_ID, not caller-supplied. */
  callerAgentId: string;
  payload: Record<string, unknown>;
  /**
   * Absolute unix-epoch milliseconds at which this request expires — the moment its CALLER stops
   * waiting. Supplied by the control client, carried through `bridge.rs`, and honoured here by
   * `dispatch` dropping the op unrun (see `expiredBy`).
   *
   * `number | null` AND optional, deliberately, which is not the same thing as `?: number`:
   *
   *  - `null` is what the WIRE actually produces. Rust serialises it from an `Option`-shaped value,
   *    and serde's derive emits the key with a `null` value for `None` — it omits the key only under
   *    `#[serde(skip_serializing_if)]`. TypeScript's `?: number` means `number | undefined`, which
   *    does NOT include `null`, so a type written that way describes a shape the bridge cannot send
   *    (AGENTS.md's serde rule; bead `sparkle-16y6h` is the case where that mismatch silently
   *    disabled a whole feature).
   *  - ABSENT is what an OLDER Rust build produces — one that predates the deadline contract and
   *    emits no such key at all.
   *
   * Both mean the same thing to us: NO DEADLINE IS KNOWN, so never skip. Only a finite number is a
   * deadline. Erring the other way — treating an unreadable deadline as "expired" — would make this
   * listener silently drop every op on a mixed build, which is far worse than doing redundant work.
   */
  deadlineAtMs?: number | null;
}

let unlisten: UnlistenFn | undefined;
// Single-flight start guard: shared by every caller so two concurrent first-callers can't both
// register the listener (which would double-dispatch every event → a doubled reply per reqId). Reset
// by teardown so a later start (e.g. after HMR) can re-arm.
let startPromise: Promise<() => void> | undefined;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Locate an agent by id across ALL projects (the control socket is app-global, so a per-agent op
 *  carries no projectId — we resolve it here). Returns the owning projectId + the agent record. */
function findAgent(agentId: string): { projectId: string; agent: AgentTab } | undefined {
  for (const p of useProjectStore.getState().projects) {
    const agent = p.agents.find((a) => a.id === agentId);
    if (agent) return { projectId: p.id, agent };
  }
  return undefined;
}

/** Resolve the target of a per-agent op: an explicit STRING `targetAgentId`, else the caller. Guards
 *  against an unsound cast — a non-string targetAgentId (e.g. a number from a misbehaving client) is
 *  ignored rather than treated as a bogus id, so it falls back to the caller instead of erroring.
 *
 *  Returns `undefined` for the CONCIERGE caller with no explicit target. "Default to the caller" is
 *  meaningless there: the concierge is not an agent, so there is no own row to rename or narrate.
 *  Defaulting anyway would hand `findAgent` an id that resolves to nothing — which today reads as
 *  `unknown agent sparkle:concierge`, an error blaming a target the caller never named. Worse, if a
 *  future refactor ever made an unresolved target fall back to "the selected agent", a targetless
 *  concierge call would silently mutate whichever row the human happened to be looking at. Making
 *  the absence explicit here is what lets each handler refuse with `targetRequired` instead. */
function resolveTargetId(req: ControlRequest): string | undefined {
  const t = req.payload.targetAgentId;
  if (typeof t === "string" && t) return t;
  if (req.callerAgentId === CONCIERGE_CALLER_AGENT_ID) return undefined;
  return req.callerAgentId;
}

/**
 * May this caller write `targetId`'s AGENT-OWNED FIELDS? Yourself, your own worker subtree, or the
 * concierge. (Formerly `mayWriteGoalFor` — the rule was never goal-specific, only its name was.)
 *
 * ONE PREDICATE FOR EVERY SUCH FIELD, deliberately. It was written for `set_agent_goal`, whose
 * threat `handleSetGoal` spells out: the goal text is replayed verbatim into the target's PTY by
 * `continuePrompt`, and clearing a goal is the documented opt-out from auto-continue, so an
 * unrestricted target is both an injection channel and a way to silence another agent's resume loop
 * (roborev 55549). `rename_agent` and `set_agent_activity` were simply MISSED when that closure went
 * in — they kept resolving a caller-supplied `targetAgentId` with no ownership test at all, so any
 * agent on the shared control socket could rewrite any other agent's two most human-facing fields
 * after one free-tier `get_state` to enumerate the roster.
 *
 * Their blast radius is not code execution, it is DECEPTION OF THE OPERATOR: the human reads `name`
 * and `activity` as an agent's own first-person report of what it is and what it is doing, so a
 * prompt-injected worker that renames a stalled agent to look healthy, or writes a reassuring
 * activity line onto an agent doing something else, makes the roster lie exactly where it is
 * trusted. Same reasoning, same closure.
 *
 * KEEP IT ONE FUNCTION. Two near-identical authorisation predicates is how one of them gets fixed
 * and the other does not — which is the bug this generalisation closes. A field whose rule is
 * genuinely stricter belongs in its own handler and says so: `set_agent_goal_met` is caller-stamped
 * (self only, concierge excepted) because marking another agent met latches its `metAt`, and that is
 * a narrower rule than ownership, not a second copy of it.
 *
 * FAILS CLOSED on an unresolvable caller: no id means we cannot establish ownership, and the only
 * safe answer to "does this anonymous caller own that agent" is no.
 */
function mayWriteAgentFieldFor(req: ControlRequest, targetId: string): boolean {
  if (req.callerAgentId === CONCIERGE_CALLER_AGENT_ID) return true;
  const caller = (req.callerAgentId || "").trim();
  if (!caller) return false;
  if (caller === targetId) return true;
  // Walk UP from the target: an orchestrator owns its workers at any depth, matching how
  // `rollupDot` folds a nested head's subtree into its parent. Bounded by the roster size so a
  // corrupted parent cycle cannot spin here.
  const byId = new Map(
    useProjectStore
      .getState()
      .projects.flatMap((p) => p.agents)
      .map((a) => [a.id, a] as const),
  );
  let cursor = byId.get(targetId)?.parentId ?? null;
  for (let hops = 0; cursor && hops <= byId.size; hops++) {
    if (cursor === caller) return true;
    cursor = byId.get(cursor)?.parentId ?? null;
  }
  return false;
}

/** The name the human sees on the concierge — used as its `self.name` so the identity get_state
 *  reports is the one the human would recognise, not an internal id. */
export const CONCIERGE_SELF_NAME = "Sparkle";

/**
 * WHO THE CALLER IS — the `self` block on every `get_state` reply (bead `sparkle-4w09`).
 *
 * This exists because the concierge had no answer to "who am I". `scope: "self"` filters the roster
 * on `a.id === callerAgentId`, and the concierge's reserved id matches no AgentTab, so that scope
 * came back `agents: []` — an EMPTY SUCCESS, which is the failure mode this whole surface is being
 * cleaned of: a call that looks like it worked and told the caller nothing. The roster filter is not
 * wrong (the concierge really has no row), so the fix is not to fake a row — it is to answer the
 * question the caller was actually asking, in a field the roster cannot hold.
 *
 * `isAgent` is the load-bearing field, not decoration: it is exactly the precondition the per-agent
 * ops (`rename_agent`, `set_agent_activity`, `set_agent_model`) default on. `false`
 * means `targetRequired` will refuse a targetless call, so a caller can learn that from one read
 * instead of from a refusal.
 *
 * `null` is a real answer: an UNRESOLVABLE caller (a stale or malformed id) is not described as
 * anything. Inventing an identity for an id that resolves to nothing would be the same lie one
 * layer up.
 *
 * `projectId` IS THE ANSWERING WINDOW'S SELECTION. `selectedProjectId` is per-window (each window
 * owns its current project) and `control:request` is broadcast to every window, whichever replies
 * first. That is not a caveat to hide — it is the SAME default the concierge's own tools apply when
 * a `projectId` is omitted (`conciergeTools/lifecycle.ts` reads `state.selectedProjectId`), so this
 * field tells a caller what "the selected project" will mean for its next call.
 *
 * There is deliberately no window field. The concierge is app-global — one headless brain on one
 * dedicated socket, not a per-window child — so it is not BOUND to a window, and reporting the
 * label of whichever window happened to answer would read as a binding that does not exist.
 */
export interface SelfIdentity {
  /** The caller's id: the reserved `sparkle:concierge` for the concierge, else its AgentTab id. */
  id: string;
  /** "concierge", or the AgentTab kind ("build" | "worker" | "shell"). */
  kind: string;
  name: string;
  /** Does this caller have a roster row? `false` ⇒ per-agent ops REQUIRE an explicit targetAgentId. */
  isAgent: boolean;
  projectId: string | null;
  projectName: string | null;
  /** For an agent: its own `set_agent_activity` line.
   *
   *  For the concierge: the LAST TOOL CALL OBSERVED THIS APP RUN — which is not the same claim as
   *  "what it is doing right now", and the difference is load-bearing (roborev 55358). The human's
   *  thinking indicator applies two gates this cannot: it renders only while the concierge is
   *  typing, and only when `latest.seq` is above the floor the CURRENT turn recorded, precisely so a
   *  line left over from a previous turn — or from a proactive push nobody watched — is not
   *  presented as live. That floor is per-turn state owned by the indicator, unreachable from this
   *  layer, and `conciergeActivity` says so itself: "Consumers decide for themselves whether it is
   *  recent enough to show (see `seq`)."
   *
   *  So this field is honest about a WEAKER thing: a call was observed, and this was the most recent
   *  one, at some point since the app started. A caller must not read it as "this turn". */
  activity: string | null;
}

/** Build the caller's {@link SelfIdentity}, or `null` when the caller resolves to nothing. */
function selfIdentity(req: ControlRequest): SelfIdentity | null {
  const { projects, selectedProjectId } = useProjectStore.getState();
  if (req.callerAgentId === CONCIERGE_CALLER_AGENT_ID) {
    const project = projects.find((p) => p.id === selectedProjectId);
    // OBSERVED, never predicted — conciergeActivity records what dispatch actually ran, so this is
    // the same sentence the column renders, phrased by the same function. It is NOT gated to the
    // current turn the way the indicator is (see the field's doc): no per-turn floor is readable
    // here, so this is the last call seen this app run, which may be an old one.
    const latest = useConciergeActivityStore.getState().latest;
    return {
      id: CONCIERGE_CALLER_AGENT_ID,
      kind: "concierge",
      name: CONCIERGE_SELF_NAME,
      isAgent: false,
      projectId: project?.id ?? null,
      projectName: project?.name ?? null,
      activity: latest ? (conciergeActivityLine(latest)?.text ?? null) : null,
    };
  }
  const found = findAgent(req.callerAgentId);
  if (!found) return null;
  return {
    id: found.agent.id,
    kind: found.agent.kind,
    name: found.agent.name,
    isAgent: true,
    projectId: found.projectId,
    projectName: projects.find((p) => p.id === found.projectId)?.name ?? null,
    activity: found.agent.activity ?? null,
  };
}

/** The typed refusal for a per-agent op invoked without saying WHICH agent, by a caller that has no
 *  own agent to default to.
 *
 *  `code` is the machine-readable half — the concierge brain is an LLM reading a tool result, and a
 *  stable code is what lets it retry with a target rather than pattern-match English prose. It is
 *  deliberately NOT a silent `{ ok: true }` no-op: a caller that believes it renamed an agent and
 *  did not is exactly the failure mode `handlePinAgent` refuses for the same reason.
 *
 *  The WHY half of the message is derived from the caller rather than hardcoded to the concierge:
 *  today the concierge is the only caller `resolveTargetId` can return `undefined` for, but a helper
 *  that names a cause it did not check would misattribute the moment a second such caller exists —
 *  and a wrong explanation is worse than a generic one. (roborev 54149.) */
function targetRequired(op: string, req: ControlRequest): Record<string, unknown> {
  // The concierge HAS an identity now (get_state's `self`), so "it is not an agent" on its own
  // reads as a flat contradiction of the field one op over. What it does not have is a ROSTER ROW,
  // which is the precise thing a per-agent default needs — say that, and point at the field that
  // says so before the call.
  const why =
    req.callerAgentId === CONCIERGE_CALLER_AGENT_ID
      ? "the concierge has an identity (get_state's `self`) but no agent row of its own, so there " +
        "is nothing to default the target to"
      : "this caller has no own agent to default the target to";
  return { ok: false, code: "target_required", error: `${op} requires an explicit targetAgentId: ${why}` };
}

/** The typed refusal for a per-agent WRITE aimed at an agent the caller does not own — the reply
 *  half of `mayWriteAgentFieldFor`, shared by every op behind it so the three cannot drift into
 *  three failure shapes a caller has to decode separately.
 *
 *  `code: "not_yours"` is the stable machine-readable half (the concierge brain is an LLM reading a
 *  tool result, and the UI decodes one code, not prose). NOT a silent `{ ok: true }` no-op: a caller
 *  that believes it renamed an agent and did not is the failure every other handler here refuses
 *  for, and a silent success is strictly worse than a refusal — neither the caller nor anyone
 *  reading a log can tell it was denied.
 *
 *  `what` completes "is not yours to …" and `why` states the harm, so the message names the specific
 *  field rather than a generic denial. The remedy clause is shared: it lists exactly the three
 *  callers the predicate admits, so an agent that reads it learns the rule instead of retrying. */
function notYours(targetId: string, what: string, why: string): Record<string, unknown> {
  return {
    ok: false,
    code: "not_yours",
    error:
      `agent ${targetId} is not yours to ${what} — ${why}, so only the agent itself, an ` +
      `orchestrator above it, or the concierge may write it.`,
  };
}

/** How much of the roster get_state returns. The roster is the single largest thing this API can
 *  put into an agent's context — it is ~250 chars per agent and PERMANENT (an MCP tool result is
 *  never evicted for the rest of the session), so a 57-agent roster cost ~3,500 tokens EVERY call.
 *  Most of those rows were dormant closed tabs (status "stopped") that no caller was asking about,
 *  which is why "active" — not "all" — is the default.
 *
 *  "active" is a ROSTER FILTER, NOT A PROCESS CHECK, and the name oversells it. It keeps: agents
 *  this window has a status entry for, plus any with an open pane app-wide, plus the caller and the
 *  caller's own workers. The open-pane set is persisted and cleared only on close, so after a
 *  relaunch every tab that was open at quit is in it with no router having reported, and a finished
 *  worker whose pane is still open elsewhere stays in "active" indefinitely. It was described as
 *  "agents with a live process" until roborev 53556 pointed out that that is the same overclaim
 *  `liveness` had just been corrected for, one level up — and the more dangerous one, since a caller
 *  that trusts the scope contract ("I asked for live processes, I got N rows, so N workers are
 *  running") never reaches the per-row `liveness` field at all. Count rows here, never processes. */
export type StateScope = "self" | "active" | "all";

/** Coerce the caller-supplied `scope` to a known value, defaulting to the cheap one. Unknown or
 *  non-string input falls back to "active" rather than erroring: the MCP layer already rejects a
 *  bad enum, so anything odd arriving here is a misbehaving client, and quietly serving it the
 *  narrow (safe, cheap) roster beats failing a read op. */
function resolveScope(raw: unknown): StateScope {
  return raw === "self" || raw === "all" || raw === "active" ? raw : "active";
}

/** Max ids reported in `omittedIds`. The field is a convenience for resolving a specific dropped
 *  agent, not a second roster — left unbounded it would grow with the dormant-tab backlog and give
 *  back the context cost the scope was added to remove. `omitted` remains the exact count. */
const OMITTED_IDS_CAP = 20;

/** How much this window actually KNOWS about a row's status — reported per agent alongside `status`.
 *
 *  Necessary because `status` defaults to "stopped" for an agent with no runtime entry, and "stopped"
 *  is also the documented value for "no process at all". Once scope "active" started keeping rows on
 *  evidence OTHER than a live status entry (open in another window; the caller; the caller's own
 *  child), the reply contradicted itself: a scope then advertised as "agents with a live process"
 *  (that wording is gone — see StateScope) handing
 *  back rows labelled dead. An orchestrator polling its fleet would read a live worker as "stopped"
 *  — the same value workerAttention paints RED — and could reasonably conclude it died and respawn
 *  it. `liveness` is the field that tells the two apart. Found by roborev 53476.
 *
 *  THE TYPE AND THE RULE NOW LIVE IN `services/agentLiveness`, re-exported here so existing importers
 *  and the doc trail above keep working. They moved because the same mistake was live in a second
 *  place — `conciergeTools/terminal.getAgentStatus` was reporting `needsYou: false` for agents it had
 *  never observed — and a rule stated in one handler cannot be inherited by another surface. Read
 *  that module for the vocabulary and for why neither non-local label is a liveness assertion.
 *  (roborev 53476 added the field, 53552 corrected what it is allowed to claim.) */
export type { AgentLiveness } from "./agentLiveness";

/** Whether a caller may run PRIVILEGED ops (set_theme / set_config). Fails CLOSED: the caller must
 *  resolve to a known, NON-worker (interactive) agent. Workers run unattended and auto-approve every
 *  tool call (dangerouslySkipPermissions), so persona prose alone can't stop one from changing the
 *  human's global theme/config — the dispatcher enforces it. An UNRESOLVABLE caller (stale, spoofed,
 *  or malformed id) is also denied: SPARKLE_AGENT_ID is injected by the app and stamped server-side,
 *  so a legitimate interactive caller always resolves to one of its own agent tabs.
 *
 *  EXACTLY ONE caller is admitted without resolving to an agent tab: the concierge (bead
 *  `sparkle-9a8j`). It is the human's own front-of-house assistant, acting on the human's behalf in
 *  the app they are looking at — the same standing an interactive Build/Think agent has, and the
 *  opposite of an unattended worker. It cannot resolve to a tab because it is a headless `claude -p`
 *  child rather than a tab, so the fail-closed rule below would deny it every privileged op forever.
 *
 *  This arm does NOT weaken the anti-spoofing property, because the id it admits is unforgeable
 *  rather than trusted: Rust mints it from WHICH SOCKET the request arrived on and rejects the same
 *  id on the shared socket (`bridge.rs resolve_control_caller`). A worker, a stale id, an empty id
 *  and any other unresolvable id are all still denied by the line below — and a worker that claims
 *  the reserved id never reaches this function at all; its request is refused in Rust.
 *
 *  Note this is deliberately NOT "the concierge is trusted because it said so". If the reserved id
 *  could arrive on the shared socket, this arm WOULD be a hole — which is exactly why the Rust
 *  rejection is tested (`shared_socket_rejects_a_request_claiming_the_reserved_concierge_id`) rather
 *  than assumed. */
function callerMayAdminister(callerAgentId: string): boolean {
  if (callerAgentId === CONCIERGE_CALLER_AGENT_ID) return true;
  const kind = findAgent(callerAgentId)?.agent.kind;
  return kind != null && kind !== "worker";
}

/**
 * The GOAL / STALLED / THRASHING fields on one `get_state` row — compact, and absent when there is
 * nothing to say.
 *
 * WHY THIS IS ON THE ROSTER AT ALL. The roster is the one call an orchestrator or the concierge
 * makes routinely, and until now every gray row looked identical: an agent that stopped mid-write on
 * a file and one that shipped its PR both read `idle`. Finding the first therefore meant a human
 * remembering what each of ~35 agents was doing. These fields make that a SWEEP.
 *
 * WHY IT IS SO TERSE. Every byte here is permanently resident in the caller's context and is paid
 * for on every call, over every agent. So the shape is deliberately the index rather than the
 * article — `get_agent_status` carries the causes, the retry counters and the sentences:
 *
 *   • `goal` — only for an agent that HAS one; text + state + time left. `escalationReason` rides
 *     along only when the state is `escalated`, because that is the row a human has to pick up.
 *   • `stall` — only for a RESTING row (the `active` verdict is already implied by `status`), and as
 *     the bare verdict string. `stallCauses` only when it is actually stalled.
 *   • `thrashing` — only when a thrash reading exists AND says something is wrong. Its ABSENCE is
 *     therefore two different facts (not watched / watched and fine), which is exactly why it is
 *     never a `false`: a caller must not read "no field" as "confirmed healthy", and if it needs to
 *     know which, `get_agent_status` distinguishes them.
 */
/** How much free-form goal prose a ROSTER row may carry. Short enough that twenty of them are noise
 *  against a ~3.5k-token payload, long enough to recognise the objective. Truncation is marked with
 *  an ellipsis so a reader can tell a capped string from a short one and go ask `get_agent_status`. */
const ROSTER_TEXT_CAP = 120;

function capForRoster(text: string): string {
  return text.length <= ROSTER_TEXT_CAP ? text : `${text.slice(0, ROSTER_TEXT_CAP - 1)}…`;
}

function goalAndStallFields(
  agent: AgentTab,
  status: AgentTabStatus,
  now: number,
): Record<string, unknown> {
  const goal = goalReading(agent.goal, now);
  const stall = stallReadingFor(agent.id, status, agent.goal, now);
  const thrash = thrashReadingFor(agent.id, agent.goal, now);
  return {
    ...(goal
      ? {
          goal: {
            // CAPPED, because this payload's own rationale is a token budget and goal text is
            // DESIGNED to be instruction-length: `AgentGoal.text` is documented as "replayed to the
            // agent when auto-continue restarts it, so it has to read as an instruction", and
            // `continuePrompt` interpolates it whole. Nothing bounds it on the write path either. So
            // an orchestrator setting a 2KB objective on each of twenty workers turned a ~3.5k-token
            // permanently-resident roster into ~15k (roborev 55308). This is the index, not the
            // article — `get_agent_status` is per-agent, on demand, and carries the full strings.
            text: capForRoster(goal.text),
            state: goal.state,
            remainingMs: goal.remainingMs,
            ...(goal.escalationReason !== undefined
              ? { escalationReason: capForRoster(goal.escalationReason) }
              : {}),
          },
        }
      : {}),
    ...(stall.verdict === "active" ? {} : { stall: stall.verdict }),
    ...(stall.verdict === "stalled" ? { stallCauses: stall.causes } : {}),
    ...(thrash?.thrashing ? { thrashing: thrash.verdict } : {}),
  };
}

/** get_state → the full agent roster (across every project) + the current theme preference. Status
 *  comes from the live runtimeStore (keyed by agentId globally); an agent with no live status reads
 *  as "stopped" (not running), the same default the sidebar uses.
 *
 *  This defaulted to "idle" until 2026-07-26, and the comment claimed that matched the sidebar — it
 *  did not (AgentSidebar and agentOrdering both default to "stopped"). The two are NOT
 *  interchangeable: "idle" means the agent finished its turn and is waiting on you, "stopped" means
 *  it has no process at all. Every persisted-but-closed tab therefore reported as a live agent that
 *  had just finished, which is exactly the wrong read when you are asking this API "what is my fleet
 *  doing" — a roster of 51 dormant tabs came back looking like 51 agents idling for your attention.
 *
 *  STATUS VOCABULARY, since this crosses the MCP boundary and callers branch on it:
 *    working                      — actively producing output
 *    waiting | approval | errored — needs you NOW (the red tier that pings)
 *    blocked                      — went quiet; red, but nothing is waiting on your answer
 *    unmerged                     — finished, committed work not yet on main (gray, not an alarm)
 *    idle | done                  — finished its turn, nothing left for you
 *    stopped                      — no live process (also the default for an agent with no entry)
 *
 *  That last parenthetical is the trap, so every row also carries `liveness` (see AgentLiveness):
 *  "stopped" + liveness "local" means the agent really is stopped, while "stopped" + "other-window"
 *  or "unknown" means this window simply has no entry for it. Branch on `liveness` before you
 *  conclude an agent is dead.
 *
 *  `status` IS THE AGENT'S OWN PTY STATE AND SAYS NOTHING ABOUT ITS WORKERS. For an orchestrator
 *  that is the wrong question almost always: a head sits `idle` between delegations, so it reads
 *  `idle` with nine workers grinding and reads `idle` with a worker blocked on a question — a
 *  caller had no way to tell either from a head that had genuinely finished. Every row therefore
 *  also carries `rollupDot`, engine/workerRollup's summary of the subtree:
 *    green  — work is running under this row (or the row itself is running)
 *    red    — something under this row needs you (or the row itself does; own-red wins outright)
 *    orange — the subtree disagrees: some workers running, some needing you
 *    gray   — nothing running and nothing asking
 *    null   — WITHHELD: this window cannot see the whole subtree, so it will not claim it is calm.
 *  A worker row and a childless row report their own tier, so it is safe to read on every row.
 *  It is computed over the FULL agent list, before the scope filter — a worker omitted from this
 *  reply still moves its head's dot, which is the point.
 *
 *  THE `null` ARM IS THE SAME LESSON AS `liveness`, ONE FIELD OVER (roborev 54742). The dot is
 *  derived from the SAME window-local `status` map, so a worker mounted in another window — or one
 *  just spawned, whose pane has not mounted — defaults to "stopped", bands to `done`, and
 *  contributes NOTHING to its head's roll-up. A head whose whole fleet is invisible from here
 *  therefore rolled up to `gray`, which the list above defines as "nothing running and nothing
 *  asking": a missing observation turned into a confident claim of calm. Under `scope: "self"` the
 *  caller gets no worker rows at all, so it cannot repair that reading from `liveness` either.
 *
 *  The withholding is ONE-SIDED, and deliberately so: `red`/`orange` are still reported even when a
 *  sibling worker is unobserved. Those are EVIDENCE — something under this row was seen asking, and
 *  a row nobody can see cannot un-ask it. `green` and `gray` are ABSENCE claims ("nothing under here
 *  needs you"), and an unobserved worker is exactly what falsifies them. Dropping an observed alarm
 *  to say "unknown" would trade this false negative for a worse one.
 *
 *  A row may also carry `goal`, `stall`/`stallCauses` and `thrashing` — see `goalAndStallFields` for
 *  the shape and for why each is absent rather than empty. They are what make "who is stuck?" a
 *  sweep over this reply instead of a human reading gray rows one at a time. */
function handleGetState(req: ControlRequest): {
  agents: unknown[];
  self: SelfIdentity | null;
  scope: StateScope;
  totalAgents: number;
  omitted: number;
  omittedIds: string[];
  theme: ThemePref;
  models: string[];
  statusFilter: Record<StatusBand, boolean>;
  /** Text size PER COLUMN — see handleSetZoom for why this is a map and not a number. */
  zoomByColumn: Record<ZoomColumn, number>;
} {
  const { projects } = useProjectStore.getState();
  const status = useRuntimeStore.getState().status;
  const ui = useUiStore.getState();
  const scope = resolveScope(req.payload.scope);
  // Liveness for scope "active" must NOT come from `status` alone. That map is window-local and
  // never persisted (runtimeStore: "live-only"), while control:request is broadcast to EVERY window
  // and whichever replies first answers — so a window has no status entries for agents mounted in
  // OTHER windows. Filtering on status alone would DROP those agents entirely (they read as
  // "stopped"), turning a merely-mislabeled row into a missing one, and the same gap opens
  // transiently after relaunch before each pane's router has reported. `openAgentIds` IS persisted
  // and merged across windows (), so the union of it and this window's live statuses is
  // the app-wide signal. Found by roborev #53406.
  const openIds = new Set(
    mergeOpenAgentIds(useRuntimeStore.getState().openAgentIds, readPersistedOpenAgentIds()),
  );
  // THE HEAD ROW'S SUBTREE, as one accessor over EVERY agent — deliberately built before the scope
  // filter below, and from the unfiltered list rather than `agents`. The narrowing is exactly what
  // makes this field necessary: a caller must never conclude a head is calm because the worker that
  // disagrees was dropped from the reply (or, in the UI, folded out of sight).
  //
  // ONE clock for the whole roster, so two rows can never disagree about whether a goal expired
  // between them — and so the calm map below and the goal readings share a single `now`.
  const now = Date.now();
  const allAgents = projects.flatMap((p) => p.agents);
  // CALM FIRST, THEN ROLL UP (roborev 55028's rule in useRosterPublisher, and roborev 55525 for
  // getting it wrong here). `withNewAgentCalm` rewrites a spawned-but-never-briefed agent's `idle` /
  // `blocked` to `new`, and it has to be applied to the RAW map before anything is bucketed or
  // folded. Correcting only the row's own `status` — which is what this surface did first — moved the
  // contradiction instead of removing it: `bandOfStatus("new")` is `done` while the uncorrected
  // `blocked` still bucketed as `needs_you`, so one row said calm-gray and "something here needs you"
  // at the same time, and because the same map feeds `descendantsOf`, an unbriefed WORKER bubbled a
  // red dot into its head's row. That false "an agent needs you" is precisely what
  // engine/newAgentAttention exists to remove.
  const calmStatus = withNewAgentCalm(
    allAgents,
    status,
    now,
    useInteractionStore.getState().lastAt,
  );
  // `ownStatusOf` is left at its default (== `statusOf`) because no `withRedWorkerAttention` has been
  // composited into this map, which is the case that parameter exists to defend against. It is also
  // the same map the `status` field reports below, so a row's dot and its own-status are always
  // derived from one source and cannot contradict each other. KEEP THAT TRUE: if you correct the
  // status a row reports, correct the map this reads, not the row.
  const dotOf = rollupDotAccessor(allAgents, (id) => calmStatus[id] ?? "stopped");
  // DIRECT children per head, `kind === "worker"` ONLY (roborev 54843) — matching
  // `rollupDotAccessor`'s own rule that only worker rows are folded into a parent's dot. Building
  // this from every child regardless of kind let a non-worker child (which cannot itself change the
  // dot) still withhold it.
  const childrenOf = new Map<string, string[]>();
  for (const a of projects.flatMap((p) => p.agents)) {
    if (a.kind !== "worker" || !a.parentId) continue;
    const kids = childrenOf.get(a.parentId);
    if (kids) kids.push(a.id);
    else childrenOf.set(a.parentId, [a.id]);
  }
  /** Every worker descendant, at any depth — a nested head's own dot folds into its parent's
   *  regardless of how deep it sits, so an unobservable grandchild must withhold the same way an
   *  unobservable direct child does. */
  const descendantsOf = (id: string): string[] => {
    const direct = childrenOf.get(id) ?? [];
    return direct.flatMap((kid) => [kid, ...descendantsOf(kid)]);
  };
  const lastObserved = useRuntimeStore.getState().lastObserved;
  /** Has THIS window ever actually read this agent's status — now, or as a recorded prior reading?
   *
   *  `livenessOf(...) === "local"` alone conflates "never observed" with "ran, then closed" — both
   *  report `"unknown"` once the pane is gone, because `close()` removes the id from both `status`
   *  and `openAgentIds`. That makes the ordinary terminal state of a settled fleet (workers finish,
   *  panes close) permanently withhold its dot. `lastObserved` (sparkle-w340) exists precisely to
   *  keep a "ran, then closed" reading distinguishable from one this window never saw, so a worker
   *  with an entry there counts as observed even with no live status and no open pane. */
  const wasObserved = (id: string): boolean =>
    livenessOf(id, status, openIds) === "local" || lastObserved[id] !== undefined;
  /** The subtree dot, or `null` when this window cannot see enough of the subtree to claim calm.
   *
   *  ONE-SIDED by design (roborev 54742). `red`/`orange` are EVIDENCE — a worker was observed
   *  asking, and a worker nobody can see cannot un-ask it — so they are reported regardless. `green`
   *  and `gray` are ABSENCE claims ("nothing under here needs you"), and an unobserved worker is
   *  precisely what falsifies them: it defaults to "stopped", bands to `done`, and contributes
   *  nothing, so a head whose whole fleet is invisible rolled up to a confident `gray`. Withholding
   *  only the absence claims fixes the false negative without trading it for a worse one. */
  const observableDotOf = (id: string): ReturnType<typeof dotOf> | null => {
    const dot = dotOf(id);
    if (dot === "red" || dot === "orange") return dot;
    const kids = descendantsOf(id);
    if (!kids.length) return dot; // a childless or worker row speaks only for itself
    return kids.every(wasObserved) ? dot : null;
  };
  // THE USER'S BUILD AGENTS. `all` — the list every count below is derived from — is this plus the
  // app-owned Improve Sparkle row appended after it; see the block below.
  const rosterAgents = projects.flatMap((p) =>
    p.agents.map((a) => ({
      id: a.id,
      // The SHARED rule (engine/agentDisplayName), not `a.name`. A bare `a.name` is right only for
      // an agent whose name is authoritative; for an auto-named one it is the creation-time fallback
      // while every other surface shows the derived title, so the roster and the concierge's
      // needs-you feed (services/conciergeFeed, which has always used this rule) could name the same
      // id two different things. They did — see the header of agentDisplayName for the pair that
      // sent a user chasing a bug that did not exist.
      name: agentDisplayName(a),
      kind: a.kind,
      // FROM THE SHARED CALMED MAP (roborev 55451, then 55525). `stall` is omitted when the verdict
      // is `active` on the documented grounds that "`active` is already implied by `status`", so
      // publishing the RAW status here made the row self-contradictory for a briefless, freshly
      // spawned agent: `status: "idle"` with an unmet goal and no `stall` key. Reading `calmStatus`
      // — the same map `dotOf` above and `stallReadingFor` below resolve to — is what makes all
      // three agree.
      status: calmStatus[a.id] ?? "stopped",
      // What the row's disc says once its workers are counted — "green" | "red" | "orange" | "gray"
      // (engine/workerRollup). ADDITIVE: `status` above keeps meaning the agent's OWN PTY state, so
      // nothing that already branches on it is redefined. Read this one to answer "is anything under
      // this row asking for me?", which `status` cannot answer for an orchestrator: a head sits
      // `idle` between delegations whether its nine workers are grinding, blocked, or gone.
      // Childless and worker rows report their own tier here, so there is no special case.
      // `null` when the subtree is not fully observable from here — see `observableDotOf`.
      rollupDot: observableDotOf(a.id),
      // Says whether `status` above is authoritative or merely defaulted — see AgentLiveness. A row
      // kept by scope "active" on evidence other than a live status entry still reads "stopped", so
      // without this the caller cannot tell a dead agent from one this window just cannot see.
      liveness: livenessOf(a.id, status, openIds),
      parentId: a.parentId,
      activity: a.activity ?? null,
      // THE SWEEP FIELDS. Without them, finding the agent that stopped mid-task means a human
      // noticing a gray row by eye — `status` cannot tell "idle and finished" from "idle and
      // stalled", and both render identically. With them, a concierge or an orchestrator can scan
      // the roster it is already paying for and ask "who is stuck?".
      //
      // COMPACT AND ABSENT-BY-DEFAULT, because this payload is the single largest thing the control
      // API puts into a context window (~3.5k tokens for a big roster) and it is PERMANENT. So: no
      // prose, no sub-objects for a row with nothing to say, and nothing at all for the common case
      // of an agent with no goal that is not resting. `get_agent_status` is where the full readings
      // (causes, detail sentences, retry counters) live — this is the index, not the article.
      // THE CALMED MAP, like `status` and `dotOf` (roborev 55588). This still passed the RAW status,
      // so the "one derivation" claim above was two derivations that merely agreed: the row's status
      // came from `calmStatus` while its `stall` came from `stallReadingFor` re-deriving the
      // correction internally. They coincide today because `correctedStatusFor` is idempotent, but
      // nothing pinned that — change the inputs here (a filtered list, a different clock) and the
      // fields silently disagree again, which is the defect this was meant to fix.
      ...goalAndStallFields(a, calmStatus[a.id] ?? "stopped", now),
    })),
  );
  // ── THE IMPROVE-SPARKLE ROW ───────────────────────────────────────────────────────────────────
  //
  // THE BUG THIS CLOSES (bead sparkle-x0pvw). The concierge pulled the FULL roster — scope "all",
  // 47 agents — and the app's own Improve Sparkle agent was not in it. Its id was therefore
  // undiscoverable, so when the founder asked the concierge to unstick it from a wedged login
  // screen, the concierge could do nothing: not refused by policy, simply unaddressable. The terminal
  // ops had ALREADY been able to reach it since 462c32f79 (services/knownAgents, arm 2) — that commit
  // documented the id in three tool descriptions precisely because this roster does not list it, and
  // said outright that a capability nobody can discover is, from the user's seat, the bug.
  //
  // WHY IT WAS ABSENT, AND WHY THIS IS NOT AN OVERTURN. The omission is by DATA SOURCE, one level
  // upstream of any predicate: `all` above flat-maps `projects[].agents`, and the app-owned Sparkle
  // agent is deliberately never a member of that array (services/knownAgents:42-45 — persistence,
  // reaping, worker rollups and the sidebar's ordering all iterate it). That reasoning still holds
  // and `projectStore` is untouched here. Only the WIRE REPLY gains a row.
  //
  // IT ALSO FIXES AN INCONSISTENCY THIS REPLY ALREADY HAD. Improve Sparkle's WORKERS are ordinary
  // roster rows carrying `parentId === <the sparkle id>` (AgentSidebar builds its `+N` from exactly
  // that predicate), so before this the reply emitted workers whose parent was not in it and whose
  // rollup belonged to no head. The head row gives them a parent that exists.
  //
  // BEFORE THE SCOPE FILTER, deliberately: `totalAgents`, `omitted` and `omittedIds` are all derived
  // from `all`, so appending here keeps every one of them arithmetically correct with no other edit.
  // It needs no special case in the "active" filter either — the pane's id is in `openAgentIds`
  // whenever it is open, so the existing `openIds.has(a.id)` clause carries it.
  const sparkleId = sparkleAgentIdFor(APP_WINDOW_LABEL);
  // ONE READING for both the status and the activity below, off the SAME clock `now` every other
  // field here uses — two calls milliseconds apart could report a pass as running for one field and
  // finished for the other, which is the self-contradictory row this reply already had to be fixed
  // for once (roborev 55451/55525, the calm-map notes above).
  const sparkleBusy = sparkleActivityLine(now);
  const sparkleRow = {
    id: sparkleId,
    // THE NAME THE ROW ON SCREEN USES, not `SPARKLE_AGENT_NAME` (which is the @-mention handle,
    // "Sparkle"). A roster and a screen naming one id two different things is the failure
    // engine/agentDisplayName's header was written about, and the founder calls this agent
    // "Improve Sparkle".
    name: SPARKLE_AGENT_DISPLAY_NAME,
    // `"build"`, NOT a fourth `AgentKind`. This row is a wire shape, not an `AgentTab`, and
    // `AgentKind` is switched on exhaustively across the app — a new variant would ripple through
    // all of it to describe an agent services/knownAgents already calls "a build-ish agent with a
    // PTY". `appOwned` below is what actually distinguishes it.
    kind: "build" as const,
    // "working" WHILE A HEADLESS PASS IS IN FLIGHT, even with no pane open — and that is a
    // correctness fix, not a cosmetic one. This agent has TWO bodies: the interactive pane (which
    // owns the PTY the status map tracks) and the hourly `claude -p` pass, which has no pane at all.
    // Reading the pane's map alone reports "stopped" for an agent that is at that moment mutating
    // its worktree, and "stopped" is exactly what the scope-"active" filter below drops — so the one
    // state in which the concierge most needs to see this row is the state that hid it. Saying
    // "working" is both true and sufficient: the existing `a.status !== "stopped"` clause then
    // carries the row, with no special case in the filter.
    status: sparkleBusy ? "working" : (calmStatus[sparkleId] ?? "stopped"),
    rollupDot: observableDotOf(sparkleId),
    liveness: livenessOf(sparkleId, status, openIds),
    parentId: null,
    // THE SHARED BUSY RULE (services/sparkleBusy), the same one the write gate refuses on — so the
    // roster can never say "idle" about an agent the very next send will refuse as busy. That
    // disagreement is worse than either fact alone: a model reads a refusal contradicting the roster
    // as a broken tool and retries.
    activity: sparkleBusy,
    // THE ONE FIELD NO OTHER ROW CARRIES, and it is absent rather than `false` on them — this reply
    // is the largest thing the control API puts in a context window and the budget is permanent.
    // It says: the app owns this agent, so the destructive lifecycle ops (discard/close/ship/save)
    // will refuse it. Without it a caller can only learn that by being refused.
    appOwned: true as const,
  };
  const all = [...rosterAgents, sparkleRow];
  const agents = all.filter((a) => {
    if (scope === "all") return true;
    // A ROW filter, and the concierge has no row — so this is legitimately empty for it. That is
    // why the reply's `self` block is unconditional: "which of these rows is me" and "who am I" are
    // different questions, and only the first one the roster can answer. See SelfIdentity.
    if (scope === "self") return a.id === req.callerAgentId;
    // "active" = has a live status, OR is open in ANY window, OR is one of the caller's own
    // children. That last clause is not a nicety: "stopped" is also what an agent with NO runtime
    // entry reads as, which is exactly a just-spawned worker (no pane mounted yet) or a permanently
    // stranded one — the case workerAttention paints RED as needing you. Without it an orchestrator
    // that calls spawn_worker twice and then get_state() sees `agents: [self], omitted: 2` and
    // concludes its workers do not exist. Your own fleet is never hidden from you. roborev #53407.
    // The caller FIRST: it is definitionally live (it is making this call), but it has no
    // guaranteed status entry — the window answering may not be the one hosting it, and a
    // just-spawned worker's pane has not mounted, so neither `status` nor `openAgentIds` covers it.
    // Without this clause a fresh worker calls get_state() and does not find ITSELF in the roster,
    // which also made "active" inconsistent with "self" (that scope always returns the caller).
    // roborev #53441.
    return (
      a.id === req.callerAgentId ||
      openIds.has(a.id) ||
      a.status !== "stopped" ||
      a.parentId === req.callerAgentId
    );
  });
  const omittedAll = all.filter((a) => !agents.includes(a)).map((a) => a.id);
  // `omittedIds` exists so a caller can resolve a SPECIFIC dropped agent instead of re-reading the
  // whole roster — which only makes sense for "active". Under "self" the caller asked for exactly
  // one agent, so every other agent is "omitted": on the motivating 57-agent roster that would ship
  // 56 ids (~600 permanently-resident tokens) back to the scope that is supposed to be nearly free.
  // Capped as well, so the field can never grow with the dormant-tab backlog; `omitted` stays the
  // EXACT count either way, so the truncation is always visible. roborev #53441.
  const omittedIds = scope === "active" ? omittedAll.slice(0, OMITTED_IDS_CAP) : [];
  // Additive Phase-3 fields so an agent can read before writing: the model ids it may pass to
  // set_agent_model and the current zoom. Existing fields (agents, theme) are unchanged.
  // `agentOrdering` was dropped when the sidebar stopped sorting by status; `statusFilter` replaces
  // it as the one view preference a caller might want to read (which status bands are on screen).
  //
  // `totalAgents`/`omitted`/`omittedIds` are NOT decoration: the default scope hides rows, and a
  // silently truncated roster reads as "that's everyone" when it isn't. Reporting what was dropped
  // is what lets a caller resolve a specific agent without re-asking with scope:"all".
  return {
    agents,
    // WHO IS ASKING — sent on EVERY scope, not only "self". The roster answers "who else is there";
    // nothing answered "who am I", and for the concierge nothing could: its reserved id matches no
    // row, so `scope: "self"` returned an empty roster and a caller reading it learned nothing
    // (bead `sparkle-4w09`). ~150 chars against a roster that runs several thousand, so it is
    // unconditional rather than another scope the caller has to know to ask for. See SelfIdentity.
    self: selfIdentity(req),
    scope,
    totalAgents: all.length,
    omitted: omittedAll.length,
    // The dropped IDS, not just a count: a caller that needs one omitted agent can resolve it
    // directly instead of paying for a full scope:"all" re-read, which was the whole point of
    // narrowing the roster. Ids are ~40 chars vs the ~226 chars a full row costs.
    omittedIds,
    theme: ui.themePref,
    models: getModelCatalog().map((m) => m.id),
    statusFilter: ui.statusFilter,
    // PER COLUMN — there is no single zoom any more. See handleSetZoom.
    zoomByColumn: ui.zoomByColumn,
  };
}

/** rename_agent → set THAT agent's name (defaults to the caller). Rejects an unknown/blank target.
 *  This is an AGENT naming itself (or a sub-agent it spawned), so it routes through `selfNameAgent`:
 *  the name becomes authoritative (freezes auto-naming) but the row is NOT pinned — no pin chip, no
 *  anchor. Using the manual `renameAgent` here (which sets namePinned) made every self-name look
 *  pinned and un-unpinnable (the next self-name re-pinned it) — bug sparkle-pel7. */
function handleRename(req: ControlRequest): Record<string, unknown> {
  const targetId = resolveTargetId(req);
  if (!targetId) return targetRequired("rename_agent", req);
  // SAME CLOSURE AS THE GOAL WRITE — this op was missed when that one was added. Until then any
  // agent on the shared socket could rename any other: `get_state` is free-tier, so enumerating the
  // roster is one call away, and the name is what the human reads as an agent's own account of
  // itself. Renaming a stalled agent to something reassuring is a lie told in the operator's own
  // trusted surface, which is the whole point of the roster.
  if (!mayWriteAgentFieldFor(req, targetId)) {
    return notYours(
      targetId,
      "rename",
      "its name is that agent's own first-person report of what it is, and the human reads the roster as such",
    );
  }
  const name = req.payload.name;
  if (typeof name !== "string" || !name.trim()) return { ok: false, error: "name is required" };
  const found = findAgent(targetId);
  if (!found) return { ok: false, error: `unknown agent ${targetId}` };
  // Model-authored text: decode HTML entities before storing. An agent that means "A & B" routinely
  // emits "A &amp; B" in its tool arguments, and the app is not the escaper — storing it verbatim is
  // what put "Pane Mounting &amp; Resize Perf" on the ladder. See engine/decodeEntities.
  useProjectStore.getState().selfNameAgent(found.projectId, targetId, normalizeAgentName(name));
  return { ok: true };
}

/** set_agent_activity → set THAT agent's live "what I'm building now" line (defaults to caller). */
function handleSetActivity(req: ControlRequest): Record<string, unknown> {
  const targetId = resolveTargetId(req);
  if (!targetId) return targetRequired("set_agent_activity", req);
  // See `handleRename`: the same hole, and the more dangerous half of it. The activity line is the
  // live "what I'm building now" the human scans to tell a working agent from a stuck one, and it is
  // also what the app reuses as a notification body — so an unowned write both misdescribes the
  // agent on the roster and can put attacker-chosen prose in front of the human out of band.
  if (!mayWriteAgentFieldFor(req, targetId)) {
    return notYours(
      targetId,
      "narrate",
      "its activity line is that agent's own first-person report of what it is doing, and the human reads the roster as such",
    );
  }
  const activity = req.payload.activity;
  if (typeof activity !== "string") return { ok: false, error: "activity must be a string" };
  const found = findAgent(targetId);
  if (!found) return { ok: false, error: `unknown agent ${targetId}` };
  useProjectStore.getState().setAgentActivity(found.projectId, targetId, activity);
  return { ok: true };
}

/**
 * set_agent_goal → set THAT agent's standing objective (defaults to caller).
 *
 * Writes the RICH goal record from engine/agentGoal (text + TTL + met/unmet + retry counters), not
 * a bare string: that model already exists and already has consumers — goalContinuation decides
 * whether an idle turn is auto-restarted from it, and agentStall decides whether an idle row reads
 * "done" or "stalled". A second, flatter goal field here would have given those two a different
 * answer than the one the concierge reads, which is the whole failure this surface exists to end.
 *
 * The op this adds is the READ half's other end: the model was set-able in-app but unreachable from
 * an agent, and unreadable by the concierge. An empty `goal` clears it, which is the documented
 * opt-out from auto-continue.
 *
 * IT ROUTES, IT DOES NOT DECIDE — and the `"agent"` actor below is the whole reason that matters.
 * This op defaults to the CALLER and is free-tier, so every rule about what a goal DOES has to live
 * in `projectStore` + `engine/agentGoal`, where the actor distinction can be enforced once:
 *   • empty/whitespace text CLEARS the goal. It must never reach `newGoal`, which THROWS on empty
 *     rather than driving twenty restarts with a prompt reading "GOAL: " and nothing after it.
 *   • the same text again keeps the retry counters but re-arms the lifecycle (`setAt`, `metAt`), so
 *     an agent re-stating its objective each round neither refills its budget nor stays stuck `met`.
 *   • GENUINELY NEW text from an AGENT inherits the old goal's `totalContinues` and any escalation —
 *     across a clear as well as a rewording (`GoalDebt`). Without that, `MAX_CONTINUES_TOTAL` and a
 *     human's escalation were both one free tool call from vacuous (roborev 55339, 55451).
 */
function handleSetGoal(req: ControlRequest): Record<string, unknown> {
  const targetId = resolveTargetId(req);
  if (!targetId) return targetRequired("set_agent_goal", req);
  // THE WRITE HALF NEEDS THE SAME CLOSURE THE `met` HALF HAS (roborev 55549). `set_agent_goal_met` is
  // caller-stamped because touching another live agent's goal state is a confused-deputy hole — and the
  // SETTER reaches the same state by another door, so leaving it freely targetable made that guard
  // decorative:
  //   • `set_agent_goal {targetAgentId: B, goal: ""}` drops B's goal, which IS the documented opt-out
  //     from auto-continue — so A can silence B's resume loop and change how B's row reads.
  //   • worse, `continuePrompt` replays `goal.text` VERBATIM into B's terminal on every restart, so a
  //     targeted set is an unauthenticated cross-agent prompt-injection channel into B's PTY.
  //
  // Scoped rather than caller-stamped outright, because an ORCHESTRATOR setting goals on its own
  // workers is a legitimate advertised use and already inside the trust boundary — it spawns them and
  // writes to their terminals by design. What is NOT legitimate is reaching a sibling or an unrelated
  // agent's fleet. So: yourself, your own worker subtree, or the concierge (whose reserved id the
  // bridge stamps server-side, and which is the human-driven surface).
  if (!mayWriteAgentFieldFor(req, targetId)) {
    return notYours(targetId, "set a goal on", "its text is replayed into that agent's terminal");
  }
  const goal = req.payload.goal;
  if (typeof goal !== "string") return { ok: false, error: "goal must be a string" };
  const ttlMs = typeof req.payload.ttlMs === "number" && req.payload.ttlMs > 0 ? req.payload.ttlMs : undefined;
  // HOW the goal is checked, when the caller stated it. Optional at this seam on purpose: making it
  // required would refuse every existing caller, and an unverified goal is still better than none.
  // But a MALFORMED `verify` is refused rather than dropped — silently discarding it would hand back
  // `{ ok: true }` for a goal the caller believes is verified and which is in fact self-markable,
  // which is worse than either accepting or refusing outright.
  //
  // `null` IS NOT "not stated" — it is the DELIBERATE TAKE-BACK, and it is the only route by which a
  // stated check ever leaves an agent. It has to exist and it has to be restricted. Without it the
  // check was un-droppable for the life of the persisted record, so one voluntarily-verified goal
  // turned into a permanent regime where the agent could never close any later goal itself; the only
  // release that did fire was `releaseGoalDebt` on any typed line, which is incidental rather than a
  // take-back and shed the check by accident instead (roborev 55933). Concierge-only because that is
  // the human-driven surface whose reserved id the bridge stamps server-side — an agent allowed to
  // pass `null` would simply drop its own check, which is the bypass this all exists to close.
  let verify: GoalVerify | null | undefined;
  if (req.payload.verify === null) {
    if (req.callerAgentId !== CONCIERGE_CALLER_AGENT_ID) {
      return {
        ok: false,
        code: "verify_not_yours",
        // THE REMEDY MUST BE FOLLOWABLE (AGENTS.md: a remedy string is an instruction the agent WILL
        // follow, so it needs the same analysis as the path it replaces). This used to end "or state
        // a different check instead" — which is now false for exactly the checks that reach this
        // refusal: an owed `command`/`human` check is sticky, so stating a different one silently
        // does nothing and the agent is left believing it acted (roborev 57801).
        error:
          "clearing a goal's check is a human take-back, not something the agent it binds may do. " +
          "Ask the concierge to drop it. Stating a WEAKER check is refused for the same reason — " +
          "the order is human > command > landed, so you can bind yourself harder but never looser. " +
          "On an UNCHANGED goal two more swaps are refused even though the rank allows them: a " +
          "`command` check may only be re-stated with the identical `cmd`, and `landed` may not " +
          "become `command` (that trades git's answer for a string you wrote). Both lift on new " +
          "goal text. If your goal's check is `landed`, you do not need a take-back at all: mark it " +
          "met once the work is on origin/main.",
      };
    }
    verify = null;
  } else if (req.payload.verify !== undefined) {
    const parsed = parseGoalVerify(req.payload.verify);
    if (!parsed.ok) return { ok: false, code: parsed.reason, error: parsed.message };
    verify = parsed.verify;
  }
  const found = findAgent(targetId);
  if (!found) return { ok: false, error: `unknown agent ${targetId}` };
  // `"agent"`: see the docstring. Everything reaching this handler came off the control socket.
  useProjectStore.getState().setAgentGoal(found.projectId, targetId, goal, ttlMs, "agent", verify);
  // Report the goal AS IT NOW STANDS, read back out of the store rather than echoed from the args.
  // The store may have done something other than what the caller literally asked (a re-asserted goal
  // keeps its counters; an empty text dropped it), and the caller is about to tell a human what
  // happened. `cleared` distinguishes the two without the caller having to compare texts.
  const stored = findAgent(targetId)?.agent.goal;
  const reading = goalReading(stored, Date.now());
  if (!reading) return { ok: true, cleared: true };
  // A STATED check can be SILENTLY REFUSED while the goal is still set (bead sparkle-4n1nk). The
  // store never weakens a binding standing check: `set_agent_goal {verify:{kind:"landed"}}` over an
  // owed `human`/`command` keeps the OLD check — `mayReplaceVerify` refuses the trade in BOTH doors
  // (projectStore's same-text re-assert and `chargeGoalDebt`'s new-text path). The goal-set half
  // succeeds either way, so a bare `{ ok: true, goal }` could not be told apart from "goal set AND
  // your check applied": a caller that stated `landed` to make its goal self-closable would read
  // `ok: true`, believe verification was accepted, and proceed to latch a goal it in fact cannot.
  // `verifyRefused` is the honest bit — the caller asked for one check and the goal now carries a
  // DIFFERENT one. Derived by comparing the stated check to the one the store actually KEPT, so it
  // reflects the side effect (what binds the goal) rather than re-deriving the refusal rule here, and
  // so it stays correct if that rule changes. Absent on genuine success: an accepted check (including
  // a STRENGTHENING the store takes, where `stored` then equals the stated check) and every call that
  // stated no check at all (`verify` is null/undefined) both leave it off.
  const verifyRefused = verify != null && !sameGoalVerify(verify, stored?.verify);
  return verifyRefused ? { ok: true, goal: reading, verifyRefused: true } : { ok: true, goal: reading };
}

/** Do two checks name the SAME verification? Kind must match, and `command` must agree on `cmd` — a
 *  different cmd is a different check (trading `pnpm test parser` for `true` is a refused weakening,
 *  not the same check). An `undefined` stored side is "no check now", which never equals a stated one. */
function sameGoalVerify(stated: GoalVerify, stored: GoalVerify | undefined): boolean {
  if (stored === undefined || stated.kind !== stored.kind) return false;
  if (stated.kind === "command" && stored.kind === "command") return stated.cmd === stored.cmd;
  return true;
}

/**
 * set_agent_goal_met → the agent's own way to say it is finished.
 *
 * Exposed alongside the setter deliberately. `metAt` is the ONLY thing that makes an idle agent
 * legitimately done — a turn ending does not set it — so without a way to say so an agent that
 * genuinely finished keeps being auto-continued, and the concierge keeps reading it as outstanding.
 */
function handleSetGoalMet(req: ControlRequest): Record<string, unknown> {
  // CALLER-STAMPED FOR AGENTS, TARGETABLE ONLY BY THE CONCIERGE.
  //
  // Agent-to-agent spoofing is the threat: marking a DIFFERENT live agent met latches its `metAt`,
  // so auto-continue never restarts it and `agentStall` renders it "done" — a false "done" on a
  // stalled agent, which is the failure the goal feature exists to end. So an agent may only mark
  // its OWN goal, and a non-self `targetAgentId` in its payload is REFUSED — not ignored.
  //
  // The distinction is the whole fix. Ignoring the field meant marking the CALLER instead and
  // replying `{ ok: true }`: the same false "done", relocated onto whoever made the call, with a
  // success reply so nothing told it. "Passing it is harmless" was also the reasoning that put the
  // field back in the agent-facing schema once already. It is withheld there now (mcp-control's
  // server.ts); this branch is the backstop for a payload that carries it regardless.
  //
  // The concierge is the exception, and it has to be: it is the human-driven surface that sweeps
  // for stalls, it has no agent row to default to, and closing out a finished agent's goal is the
  // action that sweep exists to enable. The bridge stamps its reserved id server-side, so this is
  // not a hole an agent can climb through. Without this branch the tool was still advertised to it
  // and always failed with "unknown agent sparkle:concierge" — blaming a target it never named.
  const isConcierge = req.callerAgentId === CONCIERGE_CALLER_AGENT_ID;
  const asked = typeof req.payload.targetAgentId === "string" ? req.payload.targetAgentId.trim() : "";
  const own = (req.callerAgentId || "").trim();
  let targetId: string;
  if (isConcierge) {
    if (!asked) return targetRequired("set_agent_goal_met", req);
    targetId = asked;
  } else if (!own) {
    // A NON-CONCIERGE CALLER WITH NO STAMPED ID cannot be helped by `targetRequired`, whose remedy
    // is "pass an explicit targetAgentId" — a target from this caller is discarded two lines down,
    // so a model that follows that advice retries forever on the same refusal. The real cause is
    // upstream of the payload: the bridge had no id to stamp. Say that instead.
    return {
      ok: false,
      code: "caller_unidentified",
      error:
        "set_agent_goal_met needs an identifiable caller: an agent may only mark its OWN goal, " +
        "and this connection carries no agent id for the bridge to stamp (SPARKLE_AGENT_ID is " +
        "unset on it). Passing a targetAgentId will not help — it is refused for any caller but " +
        "the concierge.",
    };
  } else {
    // NAMING A PEER IS REFUSED, NOT QUIETLY REDIRECTED. Silently falling back to `own` would mark
    // the CALLER done on a call that meant someone else — and reply `{ ok: true }`, so nothing
    // tells it. That is the exact false-"done"-on-an-unfinished-agent this tool exists to prevent,
    // merely relocated onto the caller. The schema no longer offers agents the field (see
    // mcp-control/src/server.ts), so this is the backstop for a payload that carries it anyway.
    if (asked && asked !== own) {
      return {
        ok: false,
        code: "target_refused",
        error:
          `set_agent_goal_met cannot mark ${asked}: an agent may only mark its OWN goal met. ` +
          "Marking another agent's goal met stops it being auto-continued and renders it finished " +
          "while it is still stalled. Omit targetAgentId to mark your own.",
      };
    }
    targetId = own;
  }
  const met = req.payload.met;
  if (typeof met !== "boolean") return { ok: false, error: "met must be a boolean" };
  const found = findAgent(targetId);
  if (!found) return { ok: false, error: `unknown agent ${targetId}` };
  // NOTHING TO MARK is not a success. `setAgentGoalMet` early-returns unchanged when there is no
  // goal record, so a bare `{ ok: true }` would tell the caller it is done while the concierge goes
  // on reading `goal: null` — false assurance, on the one field that decides whether an idle agent
  // is finished or stalled.
  //
  // TYPED, not just prose. A caller that has to string-match an error message to tell "you asked for
  // something impossible" from "the app broke" will get it wrong, and this is the refusal an agent
  // hits on the one path it is instructed to take (`continuePrompt` tells it to mark its goal met).
  if (!found.agent?.goal) {
    return {
      ok: false,
      code: "no_goal",
      error: "no goal to mark — set one with set_agent_goal first.",
    };
  }
  // ── THE SELF-REPORT GATE ────────────────────────────────────────────────────────────────────────
  // `setAgentGoalMet` LATCHES `metAt`, and `metAt` is the only signal that makes an idle agent count
  // as done. So an agent allowed to call this on a goal whose check IT would have to answer has
  // self-reported "done" — "I ran the command and it passed" is precisely the self-report the check
  // exists to replace, and nothing downstream re-verifies it. A goal with no `verify` is untouched,
  // which is the compatibility path for every goal that predates the field (it never claimed to be
  // verifiable).
  //
  // FOUR THINGS THIS DELIBERATELY DOES NOT REFUSE:
  //   • the CONCIERGE. It is the human-driven surface that sweeps for stalls and closes out finished
  //     work; refusing it would leave a verified goal with no one able to close it at all. Its id is
  //     stamped server-side by the bridge, so this is not a hole an agent can climb through.
  //   • `met: false`. Reopening a goal is the opposite of a false "done" — it re-arms auto-continue.
  //     Refusing it would trap an agent that noticed its own premature close.
  //   • a goal with no stated check. See above.
  //   • a `{kind:"landed"}` goal WHOSE WORK GIT SAYS IS ON ORIGIN/MAIN (sparkle-vfkqz). That is not
  //     the agent's word — `landedEvidenceFor` computes it from the branch's reachability, polled
  //     independently of anything the agent says, and the agent supplies no part of it. Refusing it
  //     anyway is what escalated two FINISHED agents to the founder over already-merged PRs, three
  //     auto-continues each. The gate exists to stop an agent calling UNLANDED work done; firing it
  //     on landed work inverts it and buries the real escalations in false red.
  //
  // The evidence is gathered ONLY for the kind that consumes it. `landedEvidenceFor` is cheap
  // (already-polled window state, no git call), but reading it for a `human` goal would suggest
  // ancestry has some bearing there — it does not, and `canSelfMarkMet` ignores it for every other
  // kind precisely so a landed branch can never launder a human sign-off.
  const goal = found.agent.goal;
  // `stated` always rides along: `selfMarkRefusal` uses it to decide WHAT TO TELL the agent (whether
  // to mention the concierge take-back), never whether the goal may close — `canSelfMarkMet` reads
  // only `landed`. Passing it is what stops the refusal asking the agent a question it cannot answer
  // (roborev 57819). `landed` is still gathered only for the kind that consumes it.
  const evidence: GoalVerifyEvidence = {
    ...(goal.verify?.kind === "landed" ? { landed: landedEvidenceFor(targetId) } : {}),
    // TWO BITS, because there are three populations and the refusal says something different to
    // each (roborev 57825, then 57827): `stated` = a caller ever chose this check; `chosenHere` =
    // they chose it for THIS goal rather than one it was carried from. Sent unconditionally — the
    // absent-flag (legacy) case is a meaningful `false`, not a reason to omit them.
    stated: goal.verifyStated === true,
    chosenHere: goal.verifyStated === true && goal.verifyInherited !== true,
  };
  if (!isConcierge && met && !canSelfMarkMet(goal.verify, evidence) && goal.verify) {
    return {
      ok: false,
      code: "goal_not_self_markable",
      error: selfMarkRefusal(goal.verify, evidence),
    };
  }
  useProjectStore.getState().setAgentGoalMet(found.projectId, targetId, met);
  return { ok: true, met };
}

/** The claimant of a PR is ALWAYS `req.callerAgentId` — the id the Rust bridge stamped from the
 *  socket, never anything in the payload.
 *
 *  Every other per-agent op on this surface accepts a `targetAgentId`; a claim must not. A claim is
 *  a statement about who will do the landing, so letting a payload name someone else would let one
 *  agent speak for another — and the whole value of a claim is that the concierge can trust who
 *  made it. Same confused-deputy reasoning the bridge already applies to `buildAgentId`. */
function claimant(req: ControlRequest): string {
  return (req.callerAgentId || "").trim();
}

/**
 * Turn whatever an agent called "the project root" into the spelling the merge gate will look up,
 * or null if it is not a project we know.
 *
 * THIS IS A CORRECTNESS GATE, NOT TIDYING. `merge_pr` finds a claim by exact root string. An agent's
 * cwd is its WORKTREE (`…/worktrees/<uuid>/…`), not the project root, and the tool description asks
 * for "the project root path" — so the overwhelmingly likely input is a path the reader can never
 * match. Storing it anyway returns `{ ok: true }`, the agent believes the PR is held, and nothing
 * blocks. A claim that reports success but cannot block is worse than no claim: it is exactly the
 * false assurance that produced #806. So: canonicalize, accept a registered root, map a known
 * worktree back to its project, and otherwise refuse and say which roots are real.
 */
function resolveProjectRoot(input: string): string | null {
  const want = input.trim().replace(/[/\\]+$/, "");
  if (!want) return null;
  const norm = (p: string) => (p || "").trim().replace(/[/\\]+$/, "");
  try {
    const { projects } = useProjectStore.getState();
    const direct = projects.find((p) => norm(p.rootPath) === want);
    if (direct) return norm(direct.rootPath);
    const owning = projects.find((p) =>
      (p.agents ?? []).some((a) => a.worktreePath && norm(a.worktreePath) === want),
    );
    return owning ? norm(owning.rootPath) : null;
  } catch {
    return null;
  }
}

/**
 * The only roots a release may search: the project the CALLER is registered under, plus the raw
 * input. Deliberately NOT every registered root.
 *
 * `claim_pr` accepts any registered root, so one agent can legitimately hold #806 in two projects —
 * and PR numbers are per-repo, so those are different PRs. A sweep over every root walks them in
 * store order and releases whichever it reaches first, which can drop a still-live claim in a
 * project the caller never named and report success. The ownership check cannot catch that: the
 * caller IS the owner. Scoping to the caller's own project is the narrowest thing that still does
 * what the sweep was added for — let a claimant whose root stopped resolving release its own PR.
 */
function candidateRoots(input: string, agentId: string): string[] {
  const norm = (p: string) => (p || "").trim().replace(/[/\\]+$/, "");
  try {
    const mine = useProjectStore
      .getState()
      .projects.filter((p) => (p.agents ?? []).some((a) => a.id === agentId));
    return [...new Set([...mine.map((p) => norm(p.rootPath)), norm(input)])].filter(Boolean);
  } catch {
    return [norm(input)].filter(Boolean);
  }
}

/**
 * The claim currently on this PR: the holder, `"unreadable"`, or null for genuinely unclaimed.
 *
 * THREE STATES, because `fetchPrClaims` returns null for "could not look" and collapsing that into
 * "nobody holds this" is the exact conflation its own docstring forbids — and here it would let a
 * takeover overwrite a live holder we never saw, since Rust permits any takeover past the TTL. Its
 * sibling `agentIsPresent` already fails closed on an unreadable store; these two must not disagree
 * about which direction is safe.
 */
async function existingClaimHolder(
  root: string,
  number: number,
): Promise<{ agentId: string; note: string | null } | "unreadable" | null> {
  try {
    const claims = await fetchPrClaims(root);
    if (claims === null) return "unreadable";
    const found = findClaim(claims, root, number);
    return found ? { agentId: found.agentId, note: found.note } : null;
  } catch {
    return "unreadable";
  }
}

/** Is this agent still on the roster? Mirrors `claimantIsPresent` in conciergeTools/workflow.ts:
 *  roster PRESENCE, not runtime status, because the status map is window-local. Unreadable → true,
 *  so we fail toward protecting the existing holder. */
function agentIsPresent(agentId: string): boolean {
  try {
    const projects = useProjectStore.getState().projects;
    if (!Array.isArray(projects)) return true;
    if (projects.some((p) => !Array.isArray(p.agents))) return true;
    return projects.flatMap((p) => p.agents).some((a) => a.id === agentId);
  } catch {
    return true;
  }
}

/** The registered project roots, for a refusal that tells the caller what to pass instead. */
function knownRootsHint(): string {
  try {
    const roots = useProjectStore.getState().projects.map((p) => p.rootPath);
    return roots.length ? ` Known project roots: ${roots.join(", ")}.` : "";
  } catch {
    return "";
  }
}

/** claim_pr → record "I will land this PR myself" where the concierge's merge gate can read it. */
async function handleClaimPr(req: ControlRequest): Promise<Record<string, unknown>> {
  const agentId = claimant(req);
  if (!agentId) return { ok: false, error: "claim_pr needs an identifiable caller" };
  const root = req.payload.root;
  const number = req.payload.number;
  if (typeof root !== "string" || !root.trim())
    return { ok: false, error: "root (the project path) is required" };
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0)
    return { ok: false, error: "number must be a positive PR number" };
  const resolved = resolveProjectRoot(root);
  if (!resolved)
    return {
      ok: false,
      error: `"${root}" is not a project Sparkle knows, so a claim written against it could never be found by the merge gate. Pass the PROJECT root (not your worktree).${knownRootsHint()}`,
    };
  const note = typeof req.payload.note === "string" ? req.payload.note : null;
  const ttlSeconds =
    typeof req.payload.ttlSeconds === "number" ? req.payload.ttlSeconds : undefined;
  // THE TAKEOVER DECISION BELONGS HERE, not in the registry. Rust judges a claim on the clock alone
  // — it has no roster — so past the TTL it lets anyone overwrite the row. But the TS rule is that a
  // LAPSED claim still blocks while its claimant is alive (an agent in a long turn cannot renew), so
  // a clock-only takeover hands PR ownership to a second agent while the first is still working and
  // believes it holds it: #806 through the new mechanism. Liveness is knowable here, so decide here.
  const holder = await existingClaimHolder(resolved, number);
  if (holder === "unreadable") {
    return {
      ok: false,
      error: `Could not read the claim registry, so I cannot tell whether an agent already holds PR #${number}. Refusing rather than writing over a holder I never saw — retry in a moment.`,
    };
  }
  if (holder && holder.agentId !== agentId && agentIsPresent(holder.agentId)) {
    // "REGISTERED", not "running". `agentIsPresent` is roster PRESENCE by design (the runtime
    // status map is window-local), so a stopped-but-still-open tab counts as present. Saying "it is
    // still running, wait for it to stop" would send the caller to wait for a transition that may
    // never come — a remedy string is an instruction, and it has to be true under the conditions
    // that triggered the refusal. Name the real ceiling instead.
    return {
      ok: false,
      error: `PR #${number} is held by agent ${holder.agentId}, which is still registered in Sparkle${holder.note ? ` (${holder.note})` : ""}. Ask it to release_pr. Failing that, the claim is dropped automatically once it passes its TTL plus a two-hour grace window — Sparkle does not require the agent to stop first.`,
    };
  }
  try {
    const claim = await setPrClaim(resolved, number, agentId, note, ttlSeconds);
    return { ok: true, claim };
  } catch (e) {
    // A refusal here is the single most actionable thing this op produces ("someone else holds
    // it"), so it is surfaced verbatim rather than flattened into a generic failure.
    return { ok: false, error: errMsg(e) };
  }
}

/** release_pr → give up a claim early. Only the claimant can; the registry enforces that. */
async function handleReleasePr(req: ControlRequest): Promise<Record<string, unknown>> {
  const agentId = claimant(req);
  if (!agentId) return { ok: false, error: "release_pr needs an identifiable caller" };
  const root = req.payload.root;
  const number = req.payload.number;
  if (typeof root !== "string" || !root.trim())
    return { ok: false, error: "root (the project path) is required" };
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0)
    return { ok: false, error: "number must be a positive PR number" };
  // PERMISSIVE, unlike `claim_pr` — and the asymmetry is the point. A claim that cannot be found is
  // FALSE ASSURANCE, so writing one under an unresolvable root has to fail. A release that cannot be
  // found protects nothing; refusing it only prolongs a block, and if the project was closed or the
  // agent's worktree path was cleared since the claim was written, the claimant would lose the only
  // way to let go of its own PR for the full TTL + grace. So try the resolved spelling, then the raw
  // one. This is not an authorization hole: the registry still refuses a release by a non-owner.
  const resolved = resolveProjectRoot(root);
  try {
    // `released: false` is not an error — there was simply nothing to release. Reported as the
    // observed outcome rather than folded into `ok`, which would claim we tore something down.
    let released = await releasePrClaim(resolved ?? root.trim(), number, agentId);
    // Try every registered root before giving up. Rust canonicalizes on both write and read, so the
    // raw-vs-canonical retry alone could never find anything the first call missed; what DOES go
    // wrong is a claim written under a root this session can no longer resolve (project closed,
    // worktree path cleared). The registry still refuses a non-owner, so this is not an
    // authorization hole — it is the difference between releasing the claim and stranding it.
    // ONLY sweep when we could not resolve the root, and only release a root that ACTUALLY holds
    // this agent's claim. PR numbers are per-repo, so #806 exists in every project — a blind sweep
    // could drop the caller's still-live claim on the same number in a DIFFERENT project and report
    // success. A recognized root is already the answer; there is nothing to search for.
    let releasedFrom: string | null = released ? (resolved ?? root.trim()) : null;
    if (!released && !resolved) {
      for (const candidate of candidateRoots(root, agentId)) {
        const claims = await fetchPrClaims(candidate);
        const mine = claims ? findClaim(claims, candidate, number) : null;
        if (!mine || mine.agentId !== agentId) continue;
        released = await releasePrClaim(candidate, number, agentId);
        if (released) {
          releasedFrom = candidate;
          break;
        }
      }
    }
    if (!released && !resolved) {
      // Never report a clean no-op for a root we did not recognise: the claimant would be told
      // there was nothing to release while its claim sits in the registry, still blocking. That is
      // the false-assurance shape `claim_pr` refuses for, on the release side.
      return {
        ok: false,
        released: false,
        error: `Nothing was released, and "${root}" is not a project Sparkle knows — so this may not be where your claim lives.${knownRootsHint()}`,
      };
    }
    // Name WHICH root was released: with a sweep in play, "released: true" alone does not tell the
    // caller what it just let go of.
    return { ok: true, released, ...(releasedFrom ? { root: releasedFrom } : {}) };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

/** set_theme → the app-wide theme preference (uiStore.setThemePref). Privileged: the tier gate in
 *  dispatch() already rejected a worker/unresolvable caller before we get here. */
function handleSetTheme(req: ControlRequest): Record<string, unknown> {
  const theme = req.payload.theme;
  if (theme !== "auto" && theme !== "light" && theme !== "dark") {
    return { ok: false, error: 'theme must be "auto" | "light" | "dark"' };
  }
  useUiStore.getState().setThemePref(theme);
  return { ok: true };
}

/**
 * append_communication_guideline → add one attributed rule to the user's guidelines file.
 *
 * THE GROWTH MECHANISM. The file is injected into the concierge's own system prompt every turn, so
 * this op lets a stated preference ("stop pasting file:line at me") become a durable rule instead
 * of something the user re-explains next week. The founder chose auto-append-then-announce over an
 * approval gate: this writes immediately and the concierge says that it did.
 *
 * ATTRIBUTION IS MANDATORY AND SERVER-SIDE, not a field the caller fills in freely. With no
 * approval step, the record of who added a rule is the ONLY thing that makes an unwanted one
 * findable in the editor afterwards — so the caller does not get to author it, understate it, or
 * omit it. A rule written through this op always says the concierge wrote it.
 *
 * Privileged, like every other write op here: an unattended worker must not be able to edit how the
 * app talks to the human.
 */
async function handleAppendGuideline(req: ControlRequest): Promise<Record<string, unknown>> {
  const rule = req.payload.rule;
  if (typeof rule !== "string" || rule.trim() === "") {
    return { ok: false, error: "rule is required (non-empty)" };
  }
  try {
    const text = await appendConciergeGuideline(rule, "Sparkle");
    return { ok: true, guidelines: text };
  } catch (e) {
    // Rust refused (empty after trimming, or the file would exceed its cap). Report it rather than
    // resolving ok — the concierge is about to TELL the user it saved a rule, and it must not say
    // that about a write that did not happen.
    return { ok: false, error: String(e) };
  }
}

/** get_config → the merged effective SparkleConfig (existing get_config Rust command). */
async function handleGetConfig(): Promise<Record<string, unknown>> {
  const eff = await getConfig();
  return { config: eff.config };
}

/** set_config → write config into the global config file. Privileged: the tier gate in dispatch()
 *  already rejected a worker/unresolvable caller before we get here.
 *
 *  Accepts scalars AND nested objects (Phase-3 widening — the server schema allows arbitrary JSON,
 *  but the old handler rejected anything non-scalar). A scalar writes one dotted key via
 *  set_config_value. An OBJECT sets a whole sub-table at once: it is flattened to dotted scalar
 *  leaves and written atomically via set_config_values (one config-changed event, all-or-nothing).
 *  Arrays / null fall through to set_config_value, where the Rust config layer validates and rejects
 *  them with a clear error (the TOML config schema is scalar-only) rather than us pre-guessing. */
async function handleSetConfig(req: ControlRequest): Promise<Record<string, unknown>> {
  const path = req.payload.path;
  const value = req.payload.value;
  if (typeof path !== "string" || !path) return { ok: false, error: "path is required" };
  if (value === undefined) return { ok: false, error: "value is required" };
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const flat = flattenConfig(path, value as Record<string, unknown>);
    if (Object.keys(flat).length === 0) return { ok: false, error: "value object is empty" };
    await setConfigValues(flat as unknown as Record<string, boolean | number | string>);
  } else {
    await setConfigValue(path, value as boolean | number | string);
  }
  return { ok: true };
}

/** Flatten a nested config object into dotted-path → leaf entries (e.g. `{ drift: { behind: 3 } }`
 *  at prefix "workflow" → `{ "workflow.drift.behind": 3 }`). Leaves (scalars, arrays, null) are kept
 *  verbatim for the Rust config layer to validate. Pure. */
function flattenConfig(prefix: string, value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const key = `${prefix}.${k}`;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      Object.assign(out, flattenConfig(key, v as Record<string, unknown>));
    } else {
      out[key] = v;
    }
  }
  return out;
}

/** pin_agent → RETIRED. Sidebar rows are no longer sorted by status, so there is no attention sort
 *  to anchor a row against: position is the row's workflow stage (engine/buildSections.ts) plus the
 *  human's own drag order within that stage. An agent choosing its own row index would fight the
 *  human's arrangement for no benefit, so this is refused rather than silently accepted — a no-op
 *  `{ok: true}` would let a caller believe it had moved itself. */
function handlePinAgent(_req: ControlRequest): Record<string, unknown> {
  return {
    ok: false,
    error:
      "pin_agent was removed: rows are grouped by workflow stage and ordered by the human's drag arrangement, so there is no row anchor to set",
  };
}

/** unpin_agent → REMOVED, exactly as `pin_agent` above was, and for the same reason carried one
 *  step further. Agent pinning is gone: rows are grouped by workflow stage, so there was never an
 *  anchor for `pin_agent` to set, and this op's remaining job — releasing the NAME freeze — went
 *  with the pin chip it was the undo for.
 *
 *  THE FREEZE ITSELF IS NOT GONE, and that is why this is a removal rather than a no-op that
 *  reports success. `namePinned` is still set by a manual rename and is still what stops the
 *  auto-namer overwriting it seconds later. There is simply no longer a control that clears it —
 *  renaming the agent again is how you change its name. An op that silently returned `ok` here
 *  would tell a caller it had released a freeze that is still very much on. */
function handleUnpinAgent(): Record<string, unknown> {
  return {
    ok: false,
    error:
      "unpin_agent was removed along with agent pinning: a manual rename still freezes the name, and renaming the agent again is how to change it",
  };
}

/** set_agent_model → set THAT agent's Claude model (defaults to caller). Validates `model` against
 *  the live catalog (the Default sentinel is always the catalog head), rejecting an unknown id. */
function handleSetAgentModel(req: ControlRequest): Record<string, unknown> {
  const targetId = resolveTargetId(req);
  if (!targetId) return targetRequired("set_agent_model", req);
  const model = req.payload.model;
  if (typeof model !== "string" || !model.trim()) return { ok: false, error: "model is required" };
  if (!getModelCatalog().some((m) => m.id === model)) {
    return { ok: false, error: `unknown model ${model}` };
  }
  const found = findAgent(targetId);
  if (!found) return { ok: false, error: `unknown agent ${targetId}` };
  useProjectStore.getState().setAgentModel(found.projectId, targetId, model);
  return { ok: true };
}

/** set_agent_ordering → RETIRED alongside pin_agent. The sidebar has exactly one ordering now
 *  (workflow stage, then the human's drag order), so there is no mode to choose. Refused rather
 *  than accepted-and-ignored, for the same reason as handlePinAgent. */
function handleSetAgentOrdering(_req: ControlRequest): Record<string, unknown> {
  return {
    ok: false,
    error:
      "set_agent_ordering was removed: the Build column always groups rows by workflow stage, ordered by the human's drag arrangement",
  };
}

/** set_zoom → a column's text zoom. Privileged.
 *
 *  THE WIRE CONTRACT IS UNCHANGED AND STAYS BACKWARD COMPATIBLE. `{ zoom }` alone used to set the
 *  one global number; text size is per-column now, so a payload with no `column` sets EVERY column.
 *  That is the honest translation of what the old op meant — "make the text this big" — and it keeps
 *  existing callers (apps/mcp-control, bridge.rs CONTROL_OPS) working exactly as they read.
 *
 *  An OPTIONAL `column` addresses one region. It is validated against the known set rather than
 *  trusted: an unrecognised name is refused outright, because silently falling back to "all columns"
 *  would make a typo resize the user's whole cockpit. */
function handleSetZoom(req: ControlRequest): Record<string, unknown> {
  const zoom = req.payload.zoom;
  if (typeof zoom !== "number" || !Number.isFinite(zoom)) {
    return { ok: false, error: "zoom must be a number" };
  }
  const column = req.payload.column;
  const ui = useUiStore.getState();
  if (column === undefined || column === null) {
    for (const key of ZOOM_COLUMNS) ui.setColumnZoom(key, zoom); // each clamped in the store
    return { ok: true, columns: ZOOM_COLUMNS.length };
  }
  if (!isZoomColumn(column)) {
    return {
      ok: false,
      error: `column must be one of: ${ZOOM_COLUMNS.join(", ")}`,
    };
  }
  ui.setColumnZoom(column, zoom); // clamped to [ZOOM_MIN=0.7, ZOOM_MAX=1.8] in the store
  return { ok: true, column };
}

/** navigate → move the UI to a view. "sparkle"/"board" set the special view; "agent" opens the
 *  agent (runtimeStore.open), selects it, and clears the special view. Global. Privileged. */
function handleNavigate(req: ControlRequest): Record<string, unknown> {
  const view = req.payload.view;
  if (view === "sparkle") {
    useUiStore.getState().setActiveSpecial(view);
    return { ok: true };
  }
  // "board" IS STILL A VALID VIEW ON THE WIRE — the contract is frozen and mirrored in bridge.rs
  // CONTROL_OPS and apps/mcp-control, so it must keep working. What changed is underneath: the
  // board is per-column state now, not a window-global special view, so this projects the request
  // onto the column the scoped project actually occupies rather than setting one global that the
  // primary pair was the only reader of.
  if (view === "board") {
    const ui = useUiStore.getState();
    const { projects, selectedProjectId } = useProjectStore.getState();
    const scoped = projects.find((p) => p.id === selectedProjectId) ?? null;
    // openPlanBoard, not setWorkMode: this op means "show me the board", and with the Sparkle pane
    // up a bare mode write moves the chevron while the stage keeps showing Sparkle — and still
    // returns ok. Before the per-column split this path wrote `activeSpecial = "board"`, which
    // REPLACED "sparkle"; the split is what dropped that, so this is a regression, not a gap.
    ui.openPlanBoard(sideOf(ui.pairAssignment, scoped?.id ?? ""));
    return { ok: true };
  }
  if (view === "agent") {
    const agentId = req.payload.agentId;
    if (typeof agentId !== "string" || !agentId.trim()) {
      return { ok: false, error: "agentId is required for view 'agent'" };
    }
    const found = findAgent(agentId);
    if (!found) return { ok: false, error: `unknown agent ${agentId}` };
    useRuntimeStore.getState().open(agentId);
    useProjectStore.getState().selectAgent(found.projectId, agentId);
    useUiStore.getState().setActiveSpecial(null);
    return { ok: true };
  }
  return { ok: false, error: 'view must be "sparkle" | "board" | "agent"' };
}

/**
 * concierge_tool → the concierge's four tool domains (services/conciergeTools/registry).
 *
 * THE FROZEN WIRE CONTRACT, mirrored in `bridge.rs` CONTROL_OPS and in apps/mcp-control:
 *   payload → { domain, op, args, toolCallId }
 *   reply   → { ok: true, domain, op, data } | { ok: false, domain, op, code, message }
 *
 * CONCIERGE-ONLY, and stricter than every other op here. `callerMayAdminister` (the tier gate in
 * `dispatch`) admits any interactive non-worker agent, which is the right rule for "change the
 * human's theme" and the WRONG one for this: a single call can spawn or discard an agent, merge a
 * PR, move a folder on disk, or type into another agent's terminal. So the caller must be EXACTLY
 * `CONCIERGE_CALLER_AGENT_ID` — a build agent, a Think agent, a worker, an unresolvable caller and a
 * near-miss like "sparkle:concierge2" are all refused. `===` on the reserved id is the whole check,
 * which is why it cannot be fooled by a prefix or a suffix.
 *
 * That id is not a claim. Rust mints it from WHICH SOCKET the request arrived on and rejects it on
 * the shared socket (`bridge.rs resolve_control_caller`), so by the time it reaches this function
 * seeing it is proof of origin — the same structural fact `callerMayAdminister` documents.
 *
 * The refusal is shaped like every other reply on this op (`{ ok:false, domain, op, code, message }`)
 * so the concierge — an LLM reading a tool result — can branch on `code` rather than pattern-match
 * prose, exactly as it does for `unknown-op` or `bad-args`.
 *
 * The refusal's PROSE half is not one fixed sentence, because "use the ordinary sparkle-control ops"
 * is false for one domain — see {@link refusedCallerRemedy}.
 */
/**
 * WHAT A REFUSED CALLER SHOULD DO INSTEAD — derived from the tool it asked for, not fixed prose.
 *
 * The generic half ("drive the app through the ordinary sparkle-control ops") is true for every
 * domain but ONE. There is no ordinary control op that photographs anything: the `screenshot`
 * domain (`capture_window`, `capture_agent`) exists only behind `concierge_tool`. So an agent asked
 * for a before/after screenshot read a refusal that named a remedy which does not exist for what it
 * wanted, and had to go find the real path by reading the scripts directory.
 *
 * Naming the visual harness closes that. It is safe under the SAME condition that produced the
 * refusal — the harness renders app surfaces in a headless browser inside the caller's own checkout,
 * so it reaches neither the human's screen nor the running app, which is the whole reason
 * `capture_window` is concierge-only (it photographs a screen region; see conciergeTools/screenshot).
 *
 * And it says what the harness CANNOT do. A remedy is an instruction the reader will follow, so an
 * agent told "capture the app" that silently gets fixture-rendered surfaces would report live state
 * it never saw. The limitation belongs in the sentence, not in the README it may not open.
 */
function refusedCallerRemedy(domain: string, op: string): string {
  const wantsAPicture =
    domain === "screenshot" || op === "capture_window" || op === "capture_agent";
  return wantsAPicture
    ? "No ordinary control op takes a picture, so there is nothing here to fall back to. The " +
        "supported path for an agent is the visual harness — `pnpm --filter @sparkle/desktop " +
        "visual:capture` (see apps/desktop/scripts/visual/README.md). Note what it is: it renders " +
        "the app's surfaces in a headless browser from its own fixtures, so it shows what the code " +
        "draws, NOT the live window or the human's screen. Do not report its output as live state."
    : "Agents drive the app through the ordinary sparkle-control ops.";
}

async function handleConciergeTool(req: ControlRequest): Promise<ConciergeToolReply> {
  // WHICH USER MESSAGE THIS CALL BELONGS TO, read HERE at entry rather than in the `finally` below.
  // The gap between the two is the whole point: a displaced turn settles after the next bubble is
  // already awaiting, so a read at settle time would attribute this send to a message that did not
  // cause it — and the concierge paints that attribution as a black "sent to an agent" card, which
  // is a delivery claim. See `setConciergeTurnOrigin` in ./conciergeReceipts (roborev 62737).
  const originBubbleId = currentConciergeTurnOrigin() ?? undefined;
  // Read defensively: this payload was assembled by a model's MCP client, and the reply has to name
  // the domain/op it was asked about even when they arrive as the wrong type.
  const domain = typeof req.payload.domain === "string" ? req.payload.domain : "";
  // `toolOp`, NOT `op`. bridgeClient FLATTENS this payload into the wire envelope and writes the
  // envelope's own reserved fields (id/token/op/callerAgentId) AFTER the spread, so an inner field
  // called `op` was overwritten by the envelope's `op` ("concierge_tool") and then stripped by the
  // Rust bridge as reserved. The handler read an empty string and EVERY op-dispatched tool failed
  // with `unknown-op`, while `get_state` — which carries no inner op — worked. That shipped in
  // v0.55.0. The `op` fallback below is read-only compatibility for an older MCP server bundled
  // beside a newer app; it can be dropped once no such pairing exists.
  const op =
    typeof req.payload.toolOp === "string"
      ? req.payload.toolOp
      : typeof req.payload.op === "string"
        ? req.payload.op
        : "";
  if (req.callerAgentId !== CONCIERGE_CALLER_AGENT_ID) {
    return {
      ok: false,
      domain,
      op,
      code: "forbidden",
      message: `concierge_tool is only callable by the concierge. ${refusedCallerRemedy(domain, op)}`,
    };
  }
  // `toolCallId` is minted by the MCP server, never by the model. A blank one is not rejected here:
  // it is the registry's authority constructor that refuses on it, and that refusal is the one that
  // explains what a tool write needs.
  const toolCallId = typeof req.payload.toolCallId === "string" ? req.payload.toolCallId : "";
  // TELL THE COLUMN WHAT THE CONCIERGE IS DOING (services/conciergeActivity → the thread's thinking
  // indicator). Recorded HERE rather than inside the registry because this is the point at which the
  // call is known to be the CONCIERGE'S: the reserved-caller check above has already run, so a
  // refused near-miss caller can never put a line in the human's thread. Started before dispatch and
  // settled in the `finally`, so the indicator's tense follows the real call and even a dispatch
  // that somehow threw cannot strand the column mid-sentence.
  //
  // SETTLED WITH THE REPLY'S OWN `ok`, which is the whole correctness of the line. This dispatch is
  // TOTAL — a policy denial, an ask-tier tool awaiting the human's approval, `bad-args`,
  // `unknown-op` and `internal-error` are all ordinary resolved replies — so a settle that assumed
  // success reported a refused merge as "Merged PR #753", in the same column that was showing the
  // approval request for it. `ok` starts FALSE so a throw settles as an attempt too.
  const settleActivity = noteConciergeToolCall(domain, op, req.payload.args);
  // The AUDIT LOG shares this seam for the same reason the indicator does: it is the one place every
  // `concierge_tool` call passes through. It records the ATTEMPT, so a denial, an unapproved
  // ask-tier call, `bad-args` and `unknown-op` are all in the record — those are precisely the
  // entries that answer "why didn't it do the thing I asked?".
  //
  // The `toolCallId` passed here is carried for DISPLAY and correlation only, and may be the empty
  // string — the line above normalises a missing/non-string one and deliberately does not reject it.
  // So the audit module mints its own join key rather than keying on this: every blank-id call would
  // otherwise share one key, and a settler would stamp the oldest such row (roborev 55160). Do not
  // "simplify" that counter away.
  const settleAudit = noteConciergeAuditCall(toolCallId, domain, op, req.payload.args);
  // Defaults describe a call that THREW past the dispatch — which is not the same as a refusal the
  // dispatch produced, so it gets its own code rather than borrowing `internal-error`'s.
  let auditReply: { ok: boolean; code?: string; message?: string } = {
    ok: false,
    code: "no-reply",
    message: "The call ended without producing a reply.",
  };
  let ok = false;
  // The reply's `data`, kept for the indicator's settle. A SPAWN is the one call whose subject does
  // not exist until it returns — it creates the agent it is about — so its id is here and nowhere
  // else, and without carrying it the column could only ever say "Started a new agent": a line with
  // no identity, which the reader cannot click and cannot watch take on a name. Every other op
  // ignores this (see `conciergeActivityResultSubject`).
  let okData: unknown;
  try {
    // Total by contract — it resolves to a reply for an unknown domain, bad args, or an internal
    // error, so nothing here needs a catch of its own (dispatch's outer one stays as the backstop).
    //
    // `configuredToolPolicy` is what makes the human's per-tool allow/ask/deny settings
    // load-bearing. Passing it here is the ONE wiring line the registry's policy seam was built for.
    // Omitting it would silently fall back to `permissiveToolPolicy` — every tool allowed — which is
    // why the default is a NAMED export rather than an inline `() => ({ tier: "allow" })`: a missing
    // policy is visible in review instead of looking like the intended behaviour.
    const reply = await dispatchConciergeTool(
      { domain, op, args: req.payload.args, toolCallId },
      { policy: configuredToolPolicy },
    );
    ok = reply.ok === true;
    if (reply.ok) okData = reply.data;
    auditReply = reply.ok
      ? { ok: true }
      : { ok: false, code: reply.code, message: reply.message };
    return reply;
  } finally {
    settleActivity(ok, okData);
    settleAudit(auditReply);
    // `okData` for the same reason the indicator takes it: a SPAWN's subject does not exist until
    // the call returns, so its agent id is in the reply and nowhere else. `auditReply.message` is
    // the refusal in the tool's own words — already human-fit at the registry — and is undefined on
    // success, which is exactly when a receipt must not carry a reason.
    // `auditReply.code` is what distinguishes a REFUSAL from a DEFERRAL — see the guard at the top
    // of the settler (roborev 57852). Without it, an ask-tier call records a permanent "refused".
    settleConciergeReceipt(
      domain,
      op,
      req.payload.args,
      ok,
      okData,
      auditReply.message,
      auditReply.code,
      // Captured at ENTRY, above — not read here. See the note at the top of this function.
      originBubbleId,
    );
  }
}

// ── CHIEF: the ONE enforcement point for who may reach which Chief project ───────────────────────
//
// WHY THE REFUSAL IS HERE AND NOWHERE ELSE (bead `sparkle-8rr0c`). `--allowedTools` DOES NOT GATE
// MCP TOOLS — measured on CLI 2.1.220 (bead `sparkle-xbka`; see the comment at
// src-tauri/src/concierge.rs:57-68), where only `--disallowedTools` blocks. So Chief scoping cannot
// be enforced by a spawn flag, cannot be enforced by a tool description, and certainly cannot be
// enforced by persona prose, which is a suggestion an agent is free to talk itself out of. The only
// mechanism left is a refusal inside this handler, judged against the identity the APP stamps
// (`req.callerAgentId`, minted by Rust from WHICH SOCKET the request arrived on) rather than any
// value the caller supplies. Every other op on this surface already works that way; this one has to.
//
// The decisions themselves are NOT here. They live in the pure `./chiefScope` module, which reads no
// store and does no IO, so the security core is unit-testable without a socket or a live token. This
// file supplies the two things that module cannot know: WHO is calling (from the stamped id) and
// WHAT the token can see (from the injected client).

/** The control op every Chief tool call travels on — first-class tools and the `chief_call` escape
 *  hatch alike. ONE op, deliberately: the hatch takes the same gates as the named tools because it
 *  arrives here in the same shape, so there is no second path to keep in step. */
export const CHIEF_TOOL_OP = "chief_tool";

/** Chief's project catalog is not scoped to a project, so it does not travel through the project
 *  gate — see the early return in {@link handleChiefTool}. */
const CHIEF_LIST_PROJECTS_TOOL = "list_projects";

/**
 * The live Chief client, or `null` when Chief is not connected.
 *
 * INJECTED, NOT REACHED FOR. `handleChiefTool` never constructs a client and never imports a
 * transport — it reads this. That is the shape bead `sparkle-lgbwf` asks for: the seam a test drives
 * is the SAME seam production writes, so there is no defaulted-at-the-call-site line that only the
 * shipped app executes. The proxy module registers the real client here at startup; a test registers
 * a stub. Neither path is special-cased.
 *
 * `null` is a real state and gets its own refusal rather than a thrown error: an agent that asks for
 * Chief before the token is wired deserves to be told that, not to read a stack trace.
 */
let chiefClient: ChiefClient | null = null;
/**
 * The catalog cache in front of {@link chiefClient}, rebuilt whenever the client is replaced.
 *
 * WHY IT IS HERE AND NOT AT THE CALL SITE. `createChiefRegistry` exists precisely because "fetching
 * 348 rows per tool call is the obvious waste", and after the four Chief branches merged it was
 * referenced by nothing but its own test — so the handler fetched the whole catalog from the network
 * on EVERY Chief call, including the burst reads the surface is meant for, and the half of the
 * feature built to prevent that was dead code (roborev 63105, 63043). Wrapping here rather than
 * asking every caller to remember means there is no second path that bypasses the cache.
 *
 * It is rebuilt on every `setChiefClient` because a cache keyed to a retired client would serve one
 * token's catalog to the next — and the PAT changing is exactly when the visible project set does.
 */
let chiefRegistry: ChiefRegistry | null = null;

/** Register (or clear, with `null`) the Chief client this handler calls. Idempotent; last write
 *  wins. Called by {@link connectChief} at startup and by tests with a stub — see {@link chiefClient}. */
export function setChiefClient(client: ChiefClient | null): void {
  chiefClient = client;
  chiefRegistry = client ? createChiefRegistry(client) : null;
}

/**
 * Connect the real Chief transport, or clear it when no PAT is reachable.
 *
 * THE LINE THAT MAKES THE FEATURE EXIST. Until this landed, `createChiefMcpClient` was referenced
 * only by `chiefMcp.test.ts` and `setChiefClient` only by `controlListener.test.ts`, so `chiefClient`
 * was `null` in every real run and all twelve Chief tools answered `chief_unavailable` — the whole
 * surface inert, end to end, with three suites green (roborev 63105). That is the same
 * shipped-inert-seam failure as the missing `CONTROL_OPS` entry, one layer up, and it is why the
 * test below drives THIS function rather than calling `setChiefClient` itself.
 *
 * Returns whether Chief ended up connected, so the caller can log it; never throws, because a
 * missing token is an ordinary state (Chief is optional) and must not take the control listener
 * down with it.
 */
export async function connectChief(
  deps: { createClient?: typeof createChiefMcpClient; resolvePat?: () => Promise<string> } = {},
): Promise<boolean> {
  const create = deps.createClient ?? createChiefMcpClient;
  const resolve = deps.resolvePat ?? resolveChiefPat;
  try {
    // GUARDED ON THE PAT BEING RESOLVABLE. With no token every call would reach the network and come
    // back unauthorized, which reads to a model as "Chief is broken" rather than "Chief is not set
    // up" — and `handleChiefTool`'s `chief_unavailable` says the latter, correctly, when the client
    // is null.
    const pat = await resolve();
    if (!pat) {
      setChiefClient(null);
      return false;
    }
    setChiefClient(create({ resolvePat: resolve }));
    return true;
  } catch {
    // A keychain read can fail (locked, denied, no Rust side in a test harness). Chief is optional,
    // so this is a state, not an error: clear the client and let the refusal explain itself.
    setChiefClient(null);
    return false;
  }
}

/** The reply shape for {@link CHIEF_TOOL_OP}. `ok: false` always carries `code` + `error`; `ok: true`
 *  always names the project it ran against, because the tool surface asks the model to STATE which
 *  Chief project it used and a reply that omits it makes that instruction unfollowable. */
export interface ChiefToolReply {
  ok: boolean;
  /** The UPSTREAM tool name that was judged — the same string both gates were applied to. */
  tool: string;
  code?: string;
  error?: string;
  /** Which Chief project the call ran against, and whether it was asked for or came from the
   *  binding. Present on every success except `list_projects`, which is not project-scoped. */
  project?: { id: string; name: string; source: "requested" | "primary" };
  text?: string;
  data?: unknown;
  /** `list_projects` only: what this caller may reach, and whether that is everything. */
  projects?: Array<{ id: string; name: string; description?: string; default?: boolean }>;
  scope?: "all" | "bound";
  detail?: string;
}

/**
 * Build the caller's Chief scope from the STAMPED identity — the anti-spoofing property, and the
 * whole reason this function takes a `ControlRequest` rather than an agent id.
 *
 * `req.callerAgentId` is written by the Rust bridge from the socket the request arrived on and is
 * stripped from the payload before the frontend sees it (`CONTROL_RESERVED_FIELDS` in bridge.rs), so
 * a tool payload naming a different agent cannot change the answer here. Nothing in the payload is
 * consulted. A caller that resolves to no agent gets `null` — fail closed, never a default scope.
 */
function callerScopeFor(req: ControlRequest): ChiefCaller | null {
  const { projects, selectedProjectId } = useProjectStore.getState();
  // ONE DEFINITION OF SCOPE, IMPORTED (roborev 63105). This function used to build the `ChiefCaller`
  // itself, so the merge landed TWO implementations named `chiefCallerFor` — one here on the
  // production path, one in `chiefRegistry.ts` reachable from nothing — that disagreed on two real
  // cases, and the merge was textually clean because each lived in its own file. The registry's
  // version is the one whose rules are documented and tested, so this resolves WHO the caller is
  // (the part that needs the request and the store) and delegates WHAT THEY MAY REACH to it.
  //
  // The two divergences that were live: a project with `chiefProjectIds: []` but a leftover
  // `chiefPrimaryId` was refused as `out_of_scope` "the binding is inconsistent" instead of the
  // intended `unbound` "ask the human to bind one"; and a binding holding `[""]` read as a
  // NON-EMPTY allowed set, so `isChiefBound` (the UI's answer) and the refusal path disagreed about
  // whether the project was bound at all — the exact disagreement `isChiefBound`'s doc-comment says
  // must not exist.
  //
  // The anti-spoofing property is unchanged and is why this still takes a `ControlRequest`:
  // `req.callerAgentId` is stamped by the Rust bridge from the socket and stripped from the payload
  // (`CONTROL_RESERVED_FIELDS` in bridge.rs), so a payload naming another agent cannot move the
  // answer. Nothing in the payload is consulted, and a caller resolving to no agent gets `null` —
  // fail closed, never a default scope.
  if (req.callerAgentId === CONCIERGE_CALLER_AGENT_ID) {
    // The concierge reaches every project the token can see, so its binding contributes only a
    // DEFAULT — the selected Sparkle project's primary, if it has one. With no primary it is asked
    // to name a project rather than served one of 348 (see `resolveChiefProject`'s "ambiguous").
    return chiefCallerFor(
      "concierge",
      projects.find((p) => p.id === selectedProjectId),
    );
  }
  const found = findAgent(req.callerAgentId);
  if (!found) return null;
  return chiefCallerFor(
    "agent",
    projects.find((p) => p.id === found.projectId),
    found.agent.id,
  );
}

/**
 * Run one Chief tool call through both gates, then — and only then — through the network.
 *
 * THE ORDER IS LOAD-BEARING, and it is why the verb gate runs before the catalog is fetched:
 *   1. resolve the caller from the stamped identity (never from the payload);
 *   2. `checkChiefTool` — WHICH VERB. A denied verb makes NO Chief call at all, not even the
 *      catalog read, so a build agent asking for `delete_asset` costs Chief nothing;
 *   3. `resolveChiefProject` — WHICH PROJECT, against the catalog the token can actually see. An
 *      out-of-scope project makes no project-scoped call;
 *   4. `client.callTool` — the only line that reaches a project's data.
 *
 * `chief_call` is not a second path. The escape hatch sends its `tool` argument in the same
 * `chiefTool` field a first-class tool sends, so it is judged by the same two gates in the same
 * order — there is no route to a denied verb through it.
 */
/** One Chief call, read out of a raw control payload. */
interface ParsedChiefCall {
  /** The upstream tool name, trimmed. Empty when the payload named none. */
  tool: string;
  /** The project the caller asked for, by id or by name. Absent means "use my binding". */
  requested?: string;
  /** The named tool's own arguments. Always an object — a non-object is read as `{}`. */
  args: Record<string, unknown>;
}

/**
 * Read a `chief_tool` payload. ONE parser, called by BOTH the concierge policy gate and the handler.
 *
 * Shared rather than duplicated because the two readings must agree by construction: the gate judges
 * a tool name and the handler runs one, and a second copy that trimmed differently (or read a
 * differently-spelled key) would let the human approve one verb while another executed. That is not
 * hypothetical — it is the same two-readers-of-one-shape failure `conciergeTools/chief.ts` documents
 * at `CHIEF_CALL_TOOL_ARG`, and it fails silently in the direction that matters.
 *
 * Read defensively: this payload was assembled by a model's MCP client. Note the field names —
 * `chiefTool`, not `tool`-as-`op`: bridgeClient flattens the payload into the wire envelope and
 * writes `id`/`token`/`op`/`callerAgentId` AFTER the spread, so a payload field with one of those
 * names is overwritten and then stripped (the v0.55.0 `unknown-op` bug; see envelopeCollision).
 */
function parseChiefCall(payload: Record<string, unknown>): ParsedChiefCall {
  const rawArgs = payload.args;
  return {
    tool: typeof payload.chiefTool === "string" ? payload.chiefTool.trim() : "",
    requested: typeof payload.project === "string" ? payload.project : undefined,
    args:
      typeof rawArgs === "object" && rawArgs !== null && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>)
        : {},
  };
}

async function handleChiefTool(req: ControlRequest): Promise<ChiefToolReply> {
  const { tool, requested, args } = parseChiefCall(req.payload);

  if (!tool) {
    return {
      ok: false,
      tool,
      code: "bad-args",
      error:
        "Refused: no Chief tool was named. A first-class tool sends its own name; `chief_call` " +
        "needs its `tool` argument. No Chief call was made.",
    };
  }

  const caller = callerScopeFor(req);
  if (!caller) {
    return {
      ok: false,
      tool,
      code: "unknown_caller",
      error:
        `Refused: caller ${req.callerAgentId || "(unidentified)"} resolves to no agent, so its ` +
        `Chief scope cannot be established. Scope is never defaulted. No Chief call was made.`,
    };
  }

  // GATE 1 — THE VERB. Before the client is even read, so a denied verb cannot be told apart from a
  // denied verb on a disconnected Chief by making a call.
  const verb = checkChiefTool(caller, tool);
  if (!verb.ok) return { ok: false, tool, code: verb.reason, error: verb.message };

  const client = chiefClient;
  const registry = chiefRegistry;
  if (!client || !registry) {
    return {
      ok: false,
      tool,
      code: "chief_unavailable",
      error:
        "Chief is not connected in this app right now, so no Chief tool can run. This is a wiring " +
        "or credential state, not a scope refusal — ask the human to connect Chief in Settings.",
    };
  }

  try {
    // THROUGH THE CACHE, not the raw client. `list_projects` is the same 348 rows for every call in
    // a burst, and the TTL registry in front of it is the whole reason it is not re-fetched per
    // tool call (roborev 63105/63043). The one tool that must see through the cache is the catalog
    // read itself — a human who just created a Chief project and asks for the list expects to see
    // it — so that one forces a refresh.
    const catalog = await registry.listProjects(tool === CHIEF_LIST_PROJECTS_TOOL);

    // `list_projects` is not project-scoped — Chief reads `X-Project-Id` per request and this tool
    // takes none — so it skips the project gate by construction. It is still SCOPED: an agent is
    // shown its bound set and nothing else, which is the honest answer to "what can I reach" and
    // stops the catalog itself from being an enumeration of 348 client projects.
    if (tool === CHIEF_LIST_PROJECTS_TOOL) {
      // Spelled out as a loop rather than a ternary + `.filter(p => …)`, because this is a SCOPING
      // decision and has to be provable like the two gates above. A ternary arm is not its own line,
      // and `mutation-check.sh` cannot mutate an arrow function (its `<`/`>` inversion turns `=>`
      // into `=<` and the mutant never parses) — so both of the idiomatic spellings are lines a
      // mutation check can never judge, which would leave the filter covered by nothing but a
      // reviewer's eye.
      let visible = catalog;
      if (caller.allowed !== "all") {
        const reachable = caller.allowed;
        visible = [];
        for (const p of catalog) if (reachable.includes(p.project_id)) visible.push(p);
      }
      return {
        ok: true,
        tool,
        scope: caller.allowed === "all" ? "all" : "bound",
        projects: visible.map((p) => ({
          id: p.project_id,
          name: p.name,
          description: p.description,
          default: p.default,
        })),
        // An empty list for a bound caller is genuinely ambiguous — no binding, or a binding whose
        // ids the token cannot see — so say which rather than letting it read as "Chief is empty".
        detail:
          caller.allowed !== "all" && visible.length === 0
            ? "This Sparkle project is not bound to any Chief project the token can see, so there " +
              "is nothing to reach. Ask the human to bind one."
            : undefined,
      };
    }

    // GATE 2 — WHICH PROJECT.
    const decision = resolveChiefProject(caller, requested, catalog);
    if (!decision.ok) return { ok: false, tool, code: decision.reason, error: decision.message };

    const result = await client.callTool(decision.projectId, tool, args);
    return {
      // Chief's own error flag is carried through rather than flattened: a tool that ran and failed
      // upstream is a different fact from one this app refused, and a caller must be able to tell.
      ok: result.isError !== true,
      tool,
      project: {
        id: decision.projectId,
        name: decision.projectName,
        source: decision.source,
      },
      text: result.text,
      data: result.data,
    };
  } catch (e) {
    return {
      ok: false,
      tool,
      code: "chief_error",
      error: `Chief call failed: ${errMsg(e)}`,
    };
  }
}

/** Did a handler's result represent a successful op? A `{ error }` reply (unknown op, thrown error)
 *  is a failure; an explicit `{ ok }` reply follows its flag; the read ops (get_state / get_config)
 *  carry neither field and always succeed when they return. Pure. */
export function isControlOpSuccess(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const r = result as Record<string, unknown>;
  if ("error" in r) return false;
  if ("ok" in r) return r.ok === true;
  return true;
}

/** Phase-2c self-report signal (sparkle-rl84): on a SUCCESSFUL sparkle-control op, tally it (op +
 *  caller/target kinds — all non-identifying enums). rename_agent / set_agent_activity are the
 *  primary self-report signals we're measuring against the paid fallbacks. */
function reportControlOpSuccess(req: ControlRequest, result: unknown): void {
  if (!isControlOpSuccess(result)) return;
  if (!TALLIED_OPS.has(req.op as ControlOp)) return;
  const op = req.op as ControlOp;
  const callerKind = findAgent(req.callerAgentId)?.agent.kind;
  // For per-agent ops the target may be a different agent; for the rest the op targets the app, so
  // there's no distinct target — mirror the caller kind (never anything identifying).
  const targetId = resolveTargetId(req);
  const targetKind =
    PER_AGENT_OPS.has(op) ? (targetId ? findAgent(targetId)?.agent.kind : undefined) : callerKind;
  reportControlOp(op, callerKind, targetKind);
}

// ── Abandoned requests: don't spend a starved frontend on replies nobody will read ───────────────
//
// THE FAILURE THIS EXISTS FOR (bead `sparkle-4rgb1`). A `sample` of a real three-minute app hang
// caught five bridge threads parked in `bridge::wait_pending` for the whole window — two of them on
// the control socket — while the Rust main thread sat ~95% idle. Nothing was deadlocked: Rust was
// waiting on frontend replies that never came, because the JS thread was not running. `set_agent_goal`
// is a synchronous Zustand write that cannot take thirty seconds, so a thirty-second timeout on it
// means the webview never got a slice at all.
//
// Two mismatched timeouts then turn a transient slowdown into a sustained one. The Rust bridge waits
// 600s; the control client gives up after 10-30s and, for the retryable ops, RE-SENDS up to three
// times — each retry emitting a fresh `control:request` event. So the frontend eventually performs
// the work for every call that was abandoned long ago, and it is handed roughly 3× the work at
// exactly the moment it has the least capacity to do it. Every one of those replies goes to a caller
// that has already left.
//
// Dropping that work is the most direct way to hand the capacity back. It is also SAFE in a way a
// timeout normally is not: the deadline is the caller's OWN, so skipping cannot lose an answer
// anyone is still waiting for — the Rust pending entry is gone by then and the reply would have
// been discarded on arrival regardless.

/**
 * Session-scoped tally of requests dropped unrun, keyed by op. Counts only — same privacy rule as
 * `stores/selfReportMetrics`: an op NAME is a non-identifying enum, the payload never is.
 *
 * IN THIS FILE rather than in `selfReportObservability` / `useSelfReportMetrics`, which is where the
 * success tally lives, for one reason worth stating so the next reader does not think it an
 * oversight: those two record a `ControlOp` SUCCESS and feed the Phase-2c self-report coverage ratio,
 * and a skipped request is neither — folding it in would corrupt that ratio, and giving it its own
 * PostHog event needs a new `ANALYTICS_EVENTS` member in `@sparkle/core`. Graduating this to that
 * mechanism is a follow-up; until then a reader is a `controlExpiredSkipCounts()` away from the
 * answer, which is the point — the alternative is inferring the drop rate from its absence.
 */
const expiredSkipsByOp = new Map<string, number>();

/** How many requests we have dropped unrun this session, by op. A snapshot — mutating it is inert. */
export function controlExpiredSkipCounts(): Record<string, number> {
  return Object.fromEntries(expiredSkipsByOp);
}

/** Zero the tally (test hook, mirroring `useSelfReportMetrics.reset`). */
export function _resetControlExpiredSkipsForTests(): void {
  expiredSkipsByOp.clear();
}

/**
 * Has this request's caller already given up? True ONLY for a finite `deadlineAtMs` now in the past.
 *
 * Absent, `null`, `NaN` and `Infinity` all answer NO — see the field's own doc for why an unreadable
 * deadline must fail towards doing the work. Pure; `Date.now()` is read by the caller so the
 * production call site is the one the tests drive (AGENTS.md's defaulted-seam trap: a `deps = clock`
 * parameter that every test overrides leaves the real call site covered by nothing).
 */
function expiredBy(req: ControlRequest, now: number): number | null {
  const d = req.deadlineAtMs;
  if (typeof d !== "number" || !Number.isFinite(d)) return null;
  return now > d ? now - d : null;
}

/** Record one dropped request: bump the tally and say so, since the caller never will. */
function reportControlOpExpired(req: ControlRequest, lateByMs: number): void {
  expiredSkipsByOp.set(req.op, (expiredSkipsByOp.get(req.op) ?? 0) + 1);
  // The op name and a duration only — never the payload, which is the identifying part.
  console.warn(`[control] skipped expired ${req.op}: caller gave up ${lateByMs}ms ago`);
}

/** Dispatch one op and reply EXACTLY once. Any thrown error becomes an `{ error }` reply so a
 *  handler failure can't leave the bridge blocked for its full timeout. */
async function dispatch(req: ControlRequest): Promise<void> {
  try {
    // FIRST GATE, BEFORE EVERY OTHER ONE — and the ordering is the whole point, not an accident of
    // where the code was pasted. An expired request must cost NOTHING: not a handler, not a receipt,
    // and specifically not a POLICY EVALUATION, because `appOpPolicy` is not a pure read — an
    // `ask`-tier verdict RAISES AN APPROVAL REQUEST in the human's concierge column. Evaluating the
    // policy for a call nobody is waiting on would put a question on the human's screen about work
    // that will never run, and under the retry storm this gate exists for it would put the same
    // question there three times. So: expiry, then tiers, then the concierge policy.
    //
    // We still reply. The Rust pending entry is already gone, so `respond` is a harmless no-op — but
    // this function's contract is "reply EXACTLY once" on every path, and a silent early return is
    // how that invariant rots into a hang the next time the timing changes. It costs one IPC call.
    const lateByMs = expiredBy(req, Date.now());
    if (lateByMs !== null) {
      reportControlOpExpired(req, lateByMs);
      await respond(req.reqId, {
        ok: false,
        // A stable machine-readable code beside the prose, like `target_required` elsewhere here —
        // a client that DOES still read this (a clock skew, a retry that raced the deadline) can
        // tell "you gave up on me" apart from a genuine refusal without parsing English.
        code: "request_expired",
        error: `${req.op} expired before the frontend reached it (${lateByMs}ms past its deadline); it was not run`,
      });
      return;
    }
    // Centralized safety gate (PRD §10/§11): a `privileged` op requires an interactive (non-worker)
    // caller. Look up the op's tier BEFORE mutating; `free` ops (and unknown ops, whose tier is
    // undefined → they fall through to the default "unknown op" reply) skip the check. This is the
    // single place the free/privileged decision is enforced — the per-handler `callerMayAdminister`
    // calls used to be scattered.
    if (CONTROL_OP_TIERS[req.op as ControlOp] === "privileged" && !callerMayAdminister(req.callerAgentId)) {
      await respond(req.reqId, {
        ok: false,
        error: `${req.op} is only permitted for interactive (non-worker) agents`,
      });
      return;
    }
    // SECOND GATE, CONCIERGE ONLY (roborev 54226, finding 1). The tier check above admits the
    // concierge outright, which is right for every other caller that clears it — an interactive
    // agent's input is the human's own typing. The concierge's is not: each turn's prompt is a
    // snapshot of live agent and TERMINAL output, text this app did not author. Leaving these ops
    // ungated therefore makes `set_config` a prompt-injection path into machine-wide configuration.
    //
    // `concierge_tool` is exempt because its own handler applies the SAME policy to the inner
    // { domain, op } — the thing that actually needs gating. Applying it here as well would judge
    // the outer wrapper name, which no policy entry describes, and deny everything.
    //
    // `chief_tool` IS GATED, and the exemption that used to sit here was a hole (roborev 63072). Its
    // stated reasoning — "the op applies its OWN two gates" — is false for this one caller:
    // `checkChiefTool` returns `{ ok: true }` unconditionally for `kind: "concierge"` BEFORE the
    // destructive denylist, and `chiefCallerFor` hands the concierge `allowed: "all"`, so both of the
    // gates it was trusted to apply are no-ops for it and the net was ZERO. That made `delete_asset`
    // against ~348 live client projects reachable from the same injected terminal text this block
    // exists to defend against.
    //
    // The other half of the old reasoning — "no policy entry describes it" — was true of the WRAPPER
    // name only. The inner Chief verbs are classified (`conciergeTools/chief.ts`), so the op judged
    // here is the inner one via `chiefPolicyOpFor`, exactly as `concierge_tool`'s handler judges its
    // inner `{ domain, op }` rather than the wrapper. `concierge_tool` stays exempt because it
    // re-applies the policy itself; this one has no such handler, so the gate is here.
    if (
      req.callerAgentId === CONCIERGE_CALLER_AGENT_ID &&
      !CONCIERGE_EXEMPT_OPS.has(req.op as ControlOp)
    ) {
      // A Chief call is judged on the verb it will actually run, read by the SAME parser the handler
      // uses, so the name on the human's approval card is the name that executes.
      const chief = req.op === CHIEF_TOOL_OP ? parseChiefCall(req.payload) : null;
      // A `chief_tool` naming no verb is the one case that skips the gate, and it is safe for a
      // reason that does not depend on remembering this: `handleChiefTool` refuses an empty tool as
      // `bad-args` before it so much as reads the client, so there is no call to approve. Gating it
      // anyway would put an approval card in front of a malformed request that provably cannot do
      // anything — and cards a human learns to dismiss are how the real ones stop being read.
      if (!chief || chief.tool) {
        // `reqId` is the approval's handle, and it has to be one the MODEL cannot choose: Rust mints
        // it as a fresh 32-hex token per round trip (bridge.rs `generate_token`), exactly as the MCP
        // server mints `toolCallId` for the concierge_tool path. Passing the payload alongside is what
        // scopes the human's answer to THIS call — approving one `set_config` write must not approve
        // the next one.
        //
        // For Chief the arguments handed over are RESHAPED, not the raw payload, and that is
        // load-bearing rather than tidying: `PER_CALL_RISK.chief_call` reads the upstream verb out of
        // `args[CHIEF_CALL_TOOL_ARG]` to escalate a destructive one to `irreversible`. Passing
        // `req.payload` (which spells it `chiefTool`) would leave that reader empty, the call would
        // fall back to the ordinary `outward-facing` class, and an explicit `chief_call = "allow"`
        // would cover `delete_chat` — the exact hole the floor exists to close, silently.
        const policyOp = chief ? chiefPolicyOpFor(chief.tool) : req.op;
        const decision = chief
          ? chiefOpPolicy(policyOp as ChiefOp, {
              requestId: req.reqId,
              args: {
                [CHIEF_CALL_TOOL_ARG]: chief.tool,
                arguments: chief.args,
                // The project the caller ASKED for, so one approval cannot be spent on a different
                // one. KNOWN LIMIT: when the payload names none this is `undefined`, and the project
                // is resolved from the binding later — inside the handler, after the catalog read the
                // verb gate deliberately runs before. So an unnamed-project approval is scoped to
                // "whatever this caller's binding resolves to", not to a fixed id.
                project: chief.requested,
              },
            })
          : appOpPolicy(req.op, { requestId: req.reqId, args: req.payload });
        if (decision.tier === "deny") {
          // Distinguish "the human switched this off" from "nobody classified this op" — the second
          // is a BUG, and blaming a Settings toggle the human never touched sends them hunting for a
          // row that isn't there (roborev 54255, finding 3).
          const known = chief !== null || APP_TOOL_NAMES.includes(req.op as AppToolName);
          await respond(req.reqId, {
            ok: false,
            // Three different refusals wear the `deny` tier, and telling a human the wrong one sends
            // them hunting for a Settings row that isn't there:
            //   - a HELD verdict carries its own reason (config not read yet — transient, retry);
            //   - an op nobody classified is a BUG, and says so rather than blaming the human;
            //   - anything else really is a switch they threw, so name the exact config path.
            error: decision.reason
              ? `${policyOp}: ${decision.reason}`
              : known
                ? `${policyOp} is turned off for the concierge in Settings → Concierge tools (${conciergeToolConfigPath(policyOp)}).`
                : `${policyOp} has no concierge policy entry, so it is refused. This is a bug — the op needs classifying in conciergeTools/policy.ts.`,
          });
          return;
        }
        if (decision.tier === "ask" && decision.approvedByUser !== true) {
          // Say what is pending, say how to retry, and name the setting. The call is NOT held open —
          // see policyBinding's header for why a concierge turn cannot wait on a human.
          await respond(req.reqId, {
            ok: false,
            error: `${policyOp} needs your go-ahead. I've put an approval request in your Sparkle column — approve it there and then tell me to go ahead, and I'll run it. To stop being asked each time, set ${conciergeToolConfigPath(policyOp)} to "Allow" in Settings → Concierge tools.`,
          });
          return;
        }
      }
    }
    let result: unknown;
    switch (req.op) {
      case "get_state":
        result = handleGetState(req);
        break;
      case "rename_agent":
        result = handleRename(req);
        break;
      case "set_agent_activity":
        result = handleSetActivity(req);
        break;
      case "set_agent_goal":
        result = handleSetGoal(req);
        break;
      case "set_agent_goal_met":
        result = handleSetGoalMet(req);
        break;
      case "claim_pr":
        result = await handleClaimPr(req);
        break;
      case "release_pr":
        result = await handleReleasePr(req);
        break;
      case "set_theme":
        result = handleSetTheme(req);
        break;
      case "get_config":
        result = await handleGetConfig();
        break;
      case "set_config":
        result = await handleSetConfig(req);
        break;
      case "pin_agent":
        result = handlePinAgent(req);
        break;
      case "unpin_agent":
        result = handleUnpinAgent();
        break;
      case "set_agent_model":
        result = handleSetAgentModel(req);
        break;
      case "set_agent_ordering":
        result = handleSetAgentOrdering(req);
        break;
      case "set_zoom":
        result = handleSetZoom(req);
        break;
      case "append_communication_guideline":
        result = await handleAppendGuideline(req);
        break;
      case "navigate":
        result = handleNavigate(req);
        break;
      case "concierge_tool":
        result = await handleConciergeTool(req);
        break;
      case CHIEF_TOOL_OP:
        result = await handleChiefTool(req);
        break;
      default:
        result = { error: `unknown op ${req.op}` };
    }
    // A RECEIPT FOR THE ONE ACTION THAT DOES NOT TRAVEL THROUGH `concierge_tool`.
    //
    // `set_agent_goal` is a top-level control op, not a registry tool, so `handleConciergeTool`'s
    // settler never sees it — and it is the op behind one of the founder's recorded frustration
    // turns verbatim: *"I don't see the goal … so I don't think I believe you."* Without this the
    // `goal` arm of the vocabulary would have no producer at all.
    //
    // GATED ON THE RESERVED CONCIERGE ID, which is what keeps it honest. This op is free-tier and
    // every agent sets its OWN goal through it constantly; those are not the concierge acting on the
    // human's behalf and have no business in the human's concierge thread. The id is not a claim —
    // Rust mints it from WHICH SOCKET the request arrived on (`bridge.rs resolve_control_caller`) —
    // so this is the same proof-of-origin check `handleConciergeTool` opens with.
    //
    // `targetAgentId` is folded in as `agentId` so the classifier reads one spelling: `resolveTargetId`
    // is where "which agent" is actually decided, and re-deriving it from the raw payload downstream
    // would be a second answer to a question this file already answers.
    //
    // KNOWN GAP, stated rather than hidden: a policy `deny`/`ask` refusal returns above this line, so
    // those get no receipt. That is the one case where the human is not left guessing — an ask-tier
    // refusal puts an approval request in their column, which is a louder surface than a receipt.
    if (req.callerAgentId === CONCIERGE_CALLER_AGENT_ID && CONCIERGE_RECEIPT_APP_OPS.includes(req.op)) {
      const r = (result ?? {}) as Record<string, unknown>;
      settleConciergeReceipt(
        "app",
        req.op,
        { ...req.payload, agentId: resolveTargetId(req) },
        isControlOpSuccess(result),
        result,
        typeof r.error === "string" ? r.error : undefined,
      );
    }
    reportControlOpSuccess(req, result);
    await respond(req.reqId, result);
  } catch (e) {
    await respond(req.reqId, { error: errMsg(e) });
  }
}

/** Reply to a round-trip op, swallowing (logging) a respond failure so it can't surface as an
 *  unhandled rejection. */
function respond(reqId: string, result: unknown): Promise<void> {
  return controlRespond(reqId, result).then(
    () => {},
    (e) => console.error("control_respond failed", reqId, e),
  );
}

/** Tear down the listener + reset module state so a fresh start (HMR / remount) can re-arm. */
function teardown(): void {
  void safeUnlisten(unlisten);
  unlisten = undefined;
  startPromise = undefined;
  // DROP THE CHIEF CLIENT TOO, for the same reason `setChiefClient` rebuilds the registry: a client
  // is bound to the PAT that was resolvable when it was built, and a teardown is exactly when that
  // may be changing (sign-out, HMR after a token edit). Holding it would serve the retired token's
  // catalog to the next start. Between teardown and re-arm, Chief fails closed as `chief_unavailable`
  // — the honest answer — and `doStart` reconnects from the current PAT.
  setChiefClient(null);
}

/** How long boot will wait on the Chief connect before giving up on it for this start. Generous —
 *  this is a hang guard, not a latency budget; a keychain that answers at all answers well inside it. */
export const CHIEF_CONNECT_TIMEOUT_MS = 10_000;

/** Resolve `p`, or `fallback` if it has not settled within `ms`. The loser is abandoned, not
 *  cancelled (there is nothing to cancel in a Tauri round trip) — it simply stops being awaited. */
async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((resolve) => {
        t = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
}

async function doStart(): Promise<() => void> {
  // Start the singleton control bridge so the socket + token exist before any agent's control-MCP
  // child connects. Best-effort: a transient bridge failure must not stop us registering the
  // listener — the bridge is idempotent and the per-spawn injection path retries start_control_bridge
  // anyway. A hard failure here just means ops can't be serviced until the bridge comes up.
  await startControlBridge().catch((e) =>
    console.error("[control] start_control_bridge failed", e),
  );
  // THE LISTENER GOES UP FIRST — Chief is not allowed to delay it (roborev 63315). `startControlBridge`
  // above has already opened the socket, so between that line and this one the bridge is ACCEPTING
  // connections with nothing listening for `control:request`; `bridge.rs` emits that event and blocks
  // on a rendezvous, so every op arriving in the gap dies as a frontend round-trip timeout. This
  // originally awaited `connectChief()` here, which widened that gap by two unbounded Tauri keychain
  // round trips — a keychain that is slow, prompts, or never settles would have delayed or
  // permanently prevented registration of the app's ONLY control listener. Optional subsystems do
  // not get to gate the mandatory one.
  unlisten = await listen<ControlRequest>(EVENT, (event) => void dispatch(event.payload));
  // NOW connect Chief, or the twelve Chief tools are decoration. `connectChief` was written with a
  // doc-comment calling itself "the line that makes the feature exist" and was then called from
  // nothing but its own test — so `chiefClient` stayed `null` in every real run and the whole
  // surface answered `chief_unavailable`, with three suites green (roborev 63105). That is the
  // identical shipped-inert-seam this file has now hit three times (the missing `CONTROL_OPS` entry,
  // the unreferenced registry cache, and this), so `startControlListener` — the app's ONE boot call —
  // is where it belongs.
  //
  // Awaited rather than fire-and-forget so the client is in place deterministically, but BOUNDED: a
  // hung keychain read must not leave `startPromise` pending forever, since every later
  // `startControlListener()` caller shares that one promise. A `chief_tool` op landing inside the
  // connect window already fails closed to the honest `chief_unavailable`, so a slow connect costs
  // nothing but Chief itself.
  const chiefUp = await withTimeout(connectChief(), CHIEF_CONNECT_TIMEOUT_MS, false);
  console.info(`[control] chief ${chiefUp ? "connected" : "not configured"}`);
  return teardown;
}

/** Start the singleton app-level control listener. Idempotent + race-safe: every call while running
 *  shares one start promise, so the listener registers exactly once. Resolves to a cleanup fn. If the
 *  start itself fails, the guard is cleared so the caller can retry. Call ONCE at app boot (Workspace)
 *  — NOT per-pane — so the control surface survives regardless of whether any Build agent exists. */
export function startControlListener(): Promise<() => void> {
  if (startPromise) return startPromise;
  startPromise = doStart().catch((e: unknown) => {
    startPromise = undefined; // allow a retry after a transient init failure
    throw e;
  });
  return startPromise;
}
