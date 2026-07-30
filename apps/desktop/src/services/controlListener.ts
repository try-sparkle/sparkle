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
import { safeUnlisten } from "./safeUnlisten";
import { startControlBridge, controlRespond } from "./orchestrationLaunch";
import { useProjectStore } from "../stores/projectStore";
import {
  useRuntimeStore,
  mergeOpenAgentIds,
  readPersistedOpenAgentIds,
} from "../stores/runtimeStore";
import { useUiStore, type ThemePref } from "../stores/uiStore";
import type { StatusBand } from "../engine/buildSections";
import { rollupDotAccessor } from "../engine/workerRollup";
import { agentDisplayName } from "../engine/agentDisplayName";
import { getConfig, setConfigValue, setConfigValues } from "./config";
import { appendConciergeGuideline } from "./conciergeGuidelines";
import { getModelCatalog } from "./models";
import { dispatchConciergeTool, type ConciergeToolReply } from "./conciergeTools/registry";
// What the concierge is doing right now, for the thread's thinking indicator. Recorded from the one
// call site that both sees every tool call and knows it came from the concierge — and read back by
// `selfIdentity` below, so the concierge can be told what it is doing rather than only the human.
import { noteConciergeToolCall, useConciergeActivityStore } from "./conciergeActivity";
import { conciergeActivityLine } from "../engine/conciergeActivityLine";
import { noteConciergeAuditCall } from "./conciergeAudit";
import { conciergeToolConfigPath } from "./conciergeTools/policy";
import { appOpPolicy, configuredToolPolicy } from "./conciergeTools/policyBinding";
import { APP_TOOL_NAMES, type AppToolName } from "./conciergeTools/policy";
import { reportControlOp } from "./selfReportObservability";
import { livenessOf } from "./agentLiveness";
import { goalStateOf } from "../engine/agentGoal";
import { setPrClaim, releasePrClaim, fetchPrClaims, findClaim } from "./mergeGuard/prClaims";
import type { ControlOp } from "../stores/selfReportMetrics";
import type { AgentTab } from "../types";

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
  // FREE, like `set_agent_activity` and for the same reason: these are an agent's report about its
  // OWN work. A worker that cannot say "I am landing this myself" is a worker whose intent stays
  // invisible, which is the failure this whole surface exists to fix — gating it behind
  // interactive-only would reintroduce #806 for exactly the agents most likely to be holding a PR.
  // Neither op can touch another agent: the claimant is the bridge-stamped caller, and the registry
  // refuses a release by anyone else.
  set_agent_goal: "free",
  set_agent_goal_met: "free",
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
type ControlOpExemptFromConciergePolicy = "concierge_tool" | "pin_agent" | "set_agent_ordering";
// Instantiating it is what makes the mapped type actually check.
const _conciergeGateCoverage: _ConciergeGateCoversEveryControlOp = {
  get_state: true,
  get_config: true,
  rename_agent: true,
  set_agent_activity: true,
  append_communication_guideline: true,
  set_theme: true,
  set_config: true,
  unpin_agent: true,
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
 * ops (`rename_agent`, `set_agent_activity`, `unpin_agent`, `set_agent_model`) default on. `false`
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
 *  to say "unknown" would trade this false negative for a worse one. */
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
  zoom: number;
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
  // `ownStatusOf` is left at its default (== `statusOf`) because this map is `runtimeStore.status`
  // RAW — no `withRedWorkerAttention` has been composited into it, which is the case that parameter
  // exists to defend against. It is also the same map the `status` field reports below, so a row's
  // dot and its own-status are always derived from one source and cannot contradict each other.
  const dotOf = rollupDotAccessor(
    projects.flatMap((p) => p.agents),
    (id) => status[id] ?? "stopped",
  );
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
  const all = projects.flatMap((p) =>
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
      status: status[a.id] ?? "stopped",
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
      // The agent's OBJECTIVE and whether it has been MET — see engine/agentGoal. Readable here
      // because it was write-only: on 2026-07-29 PR #806's owning agent had the goal "get it
      // merged", and a concierge able to read that would not have merged the PR out from under it.
      // Flattened rather than passed whole: `met` is the field every consumer actually branches on,
      // and the retry counters are engine bookkeeping a caller must not reason about.
      // `state` and not just `met`. ESCALATED is the one state that cannot be reconstructed from the
      // other fields — `expired` is derivable from setAt+ttlMs, but a goal auto-continue has GIVEN
      // UP on and handed to a human reads identically to one still being retried if all you have is
      // `met: false`. That is the highest-value row for a human and precisely what this surface
      // exists to let the concierge sweep for. `met` stays for compatibility; the retry counters
      // really are engine bookkeeping and stay out.
      goal: a.goal
        ? {
            text: a.goal.text,
            state: goalStateOf(a.goal, Date.now()),
            met: a.goal.metAt !== undefined,
            setAt: a.goal.setAt,
            ttlMs: a.goal.ttlMs,
            ...(a.goal.escalationReason ? { escalationReason: a.goal.escalationReason } : {}),
          }
        : null,
    })),
  );
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
    zoom: ui.zoom,
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
  const name = req.payload.name;
  if (typeof name !== "string" || !name.trim()) return { ok: false, error: "name is required" };
  const found = findAgent(targetId);
  if (!found) return { ok: false, error: `unknown agent ${targetId}` };
  useProjectStore.getState().selfNameAgent(found.projectId, targetId, name);
  return { ok: true };
}

/** set_agent_activity → set THAT agent's live "what I'm building now" line (defaults to caller). */
function handleSetActivity(req: ControlRequest): Record<string, unknown> {
  const targetId = resolveTargetId(req);
  if (!targetId) return targetRequired("set_agent_activity", req);
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
 */
function handleSetGoal(req: ControlRequest): Record<string, unknown> {
  const targetId = resolveTargetId(req);
  if (!targetId) return targetRequired("set_agent_goal", req);
  const goal = req.payload.goal;
  if (typeof goal !== "string") return { ok: false, error: "goal must be a string" };
  const ttlMs = typeof req.payload.ttlMs === "number" && req.payload.ttlMs > 0 ? req.payload.ttlMs : undefined;
  const found = findAgent(targetId);
  if (!found) return { ok: false, error: `unknown agent ${targetId}` };
  useProjectStore.getState().setAgentGoal(found.projectId, targetId, goal, ttlMs);
  return { ok: true };
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
  if (!found.agent?.goal) {
    return { ok: false, error: "no goal to mark — set one with set_agent_goal first." };
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

/** unpin_agent → release THAT agent's NAME freeze so it auto-names again (defaults to caller).
 *  This used to release a row anchor as well; row anchoring no longer exists (see handlePinAgent),
 *  so the name freeze is all that remains — which is still worth exposing. */
function handleUnpinAgent(req: ControlRequest): Record<string, unknown> {
  const targetId = resolveTargetId(req);
  if (!targetId) return targetRequired("unpin_agent", req);
  const found = findAgent(targetId);
  if (!found) return { ok: false, error: `unknown agent ${targetId}` };
  useProjectStore.getState().unpinAgent(found.projectId, targetId);
  return { ok: true };
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

/** set_zoom → the terminal text zoom. Global. The store clamps to [ZOOM_MIN, ZOOM_MAX]; we only
 *  validate it is a finite number here. Privileged. */
function handleSetZoom(req: ControlRequest): Record<string, unknown> {
  const zoom = req.payload.zoom;
  if (typeof zoom !== "number" || !Number.isFinite(zoom)) {
    return { ok: false, error: "zoom must be a number" };
  }
  useUiStore.getState().setZoom(zoom); // clamped to [ZOOM_MIN=0.7, ZOOM_MAX=1.8] in the store
  return { ok: true };
}

/** navigate → move the UI to a view. "sparkle"/"board" set the special view; "agent" opens the
 *  agent (runtimeStore.open), selects it, and clears the special view. Global. Privileged. */
function handleNavigate(req: ControlRequest): Record<string, unknown> {
  const view = req.payload.view;
  if (view === "sparkle" || view === "board") {
    useUiStore.getState().setActiveSpecial(view);
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
 */
async function handleConciergeTool(req: ControlRequest): Promise<ConciergeToolReply> {
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
      message:
        "concierge_tool is only callable by the concierge. Agents drive the app through the ordinary sparkle-control ops.",
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

/** Dispatch one op and reply EXACTLY once. Any thrown error becomes an `{ error }` reply so a
 *  handler failure can't leave the bridge blocked for its full timeout. */
async function dispatch(req: ControlRequest): Promise<void> {
  try {
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
    if (
      req.callerAgentId === CONCIERGE_CALLER_AGENT_ID &&
      !CONCIERGE_EXEMPT_OPS.has(req.op as ControlOp)
    ) {
      // `reqId` is the approval's handle, and it has to be one the MODEL cannot choose: Rust mints
      // it as a fresh 32-hex token per round trip (bridge.rs `generate_token`), exactly as the MCP
      // server mints `toolCallId` for the concierge_tool path. Passing the payload alongside is what
      // scopes the human's answer to THIS call — approving one `set_config` write must not approve
      // the next one.
      const decision = appOpPolicy(req.op, { requestId: req.reqId, args: req.payload });
      if (decision.tier === "deny") {
        // Distinguish "the human switched this off" from "nobody classified this op" — the second
        // is a BUG, and blaming a Settings toggle the human never touched sends them hunting for a
        // row that isn't there (roborev 54255, finding 3).
        const known = APP_TOOL_NAMES.includes(req.op as AppToolName);
        await respond(req.reqId, {
          ok: false,
          // Three different refusals wear the `deny` tier, and telling a human the wrong one sends
          // them hunting for a Settings row that isn't there:
          //   - a HELD verdict carries its own reason (config not read yet — transient, retry);
          //   - an op nobody classified is a BUG, and says so rather than blaming the human;
          //   - anything else really is a switch they threw, so name the exact config path.
          error: decision.reason
            ? `${req.op}: ${decision.reason}`
            : known
              ? `${req.op} is turned off for the concierge in Settings → Concierge tools (${conciergeToolConfigPath(req.op)}).`
              : `${req.op} has no concierge policy entry, so it is refused. This is a bug — the op needs classifying in conciergeTools/policy.ts.`,
        });
        return;
      }
      if (decision.tier === "ask" && decision.approvedByUser !== true) {
        // Say what is pending, say how to retry, and name the setting. The call is NOT held open —
        // see policyBinding's header for why a concierge turn cannot wait on a human.
        await respond(req.reqId, {
          ok: false,
          error: `${req.op} needs your go-ahead. I've put an approval request in your Sparkle column — approve it there and then tell me to go ahead, and I'll run it. To stop being asked each time, set ${conciergeToolConfigPath(req.op)} to "Allow" in Settings → Concierge tools.`,
        });
        return;
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
        result = handleUnpinAgent(req);
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
      default:
        result = { error: `unknown op ${req.op}` };
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
}

async function doStart(): Promise<() => void> {
  // Start the singleton control bridge so the socket + token exist before any agent's control-MCP
  // child connects. Best-effort: a transient bridge failure must not stop us registering the
  // listener — the bridge is idempotent and the per-spawn injection path retries start_control_bridge
  // anyway. A hard failure here just means ops can't be serviced until the bridge comes up.
  await startControlBridge().catch((e) =>
    console.error("[control] start_control_bridge failed", e),
  );
  unlisten = await listen<ControlRequest>(EVENT, (event) => void dispatch(event.payload));
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
