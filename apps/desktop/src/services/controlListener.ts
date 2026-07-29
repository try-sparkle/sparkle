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
import { getConfig, setConfigValue, setConfigValues } from "./config";
import { getModelCatalog } from "./models";
import { dispatchConciergeTool, type ConciergeToolReply } from "./conciergeTools/registry";
// What the concierge is doing right now, for the thread's thinking indicator. Recorded from the one
// call site that both sees every tool call and knows it came from the concierge.
import { noteConciergeToolCall } from "./conciergeActivity";
import { conciergeToolConfigPath } from "./conciergeTools/policy";
import { appOpPolicy, configuredToolPolicy } from "./conciergeTools/policyBinding";
import { APP_TOOL_NAMES, type AppToolName } from "./conciergeTools/policy";
import { reportControlOp } from "./selfReportObservability";
import { livenessOf } from "./agentLiveness";
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
const TALLIED_OPS = new Set<ControlOp>([
  "rename_agent",
  "set_agent_activity",
  "set_theme",
  "get_config",
  "set_config",
  "get_state",
  "pin_agent",
  "unpin_agent",
  "set_agent_model",
  "set_agent_ordering",
  "set_zoom",
  "navigate",
  // Counts how often the concierge actually reaches for a tool. The op name only — the domain and
  // op INSIDE the payload are not recorded (see selfReportMetrics' privacy note).
  "concierge_tool",
]);
/** The per-agent ops whose target may differ from the caller (default to caller when omitted). */
const PER_AGENT_OPS = new Set<ControlOp>([
  "rename_agent",
  "set_agent_activity",
  "pin_agent",
  "unpin_agent",
  "set_agent_model",
]);

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
  // The concierge's tool spine. PRIVILEGED, and then some: the tier gate here is the ordinary
  // "no unattended workers" check, and `handleConciergeTool` narrows it further to the ONE reserved
  // caller. Both gates matter — this op reaches agent lifecycle, git, the workspace and a PTY, so a
  // near-miss caller id must not get within reach of it. See the handler.
  concierge_tool: "privileged",
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
  set_theme: true,
  set_config: true,
  unpin_agent: true,
  set_agent_model: true,
  set_zoom: true,
  navigate: true,
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
  const why =
    req.callerAgentId === CONCIERGE_CALLER_AGENT_ID
      ? "the concierge is not an agent, so there is no caller to default the target to"
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
 *  conclude an agent is dead. */
function handleGetState(req: ControlRequest): {
  agents: unknown[];
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
  const all = projects.flatMap((p) =>
    p.agents.map((a) => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      status: status[a.id] ?? "stopped",
      // Says whether `status` above is authoritative or merely defaulted — see AgentLiveness. A row
      // kept by scope "active" on evidence other than a live status entry still reads "stopped", so
      // without this the caller cannot tell a dead agent from one this window just cannot see.
      liveness: livenessOf(a.id, status, openIds),
      parentId: a.parentId,
      activity: a.activity ?? null,
    })),
  );
  const agents = all.filter((a) => {
    if (scope === "all") return true;
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
  let ok = false;
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
    return reply;
  } finally {
    settleActivity(ok);
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
