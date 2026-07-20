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
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { safeUnlisten } from "./safeUnlisten";
import { startControlBridge, controlRespond } from "./orchestrationLaunch";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore, type ThemePref, type AgentOrdering } from "../stores/uiStore";
import { getConfig, setConfigValue, setConfigValues } from "./config";
import { getModelCatalog } from "./models";
import { reportControlOp } from "./selfReportObservability";
import type { ControlOp } from "../stores/selfReportMetrics";
import type { AgentTab } from "../types";

const EVENT = "control:request";

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
};

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
 *  ignored rather than treated as a bogus id, so it falls back to the caller instead of erroring. */
function resolveTargetId(req: ControlRequest): string {
  const t = req.payload.targetAgentId;
  return typeof t === "string" && t ? t : req.callerAgentId;
}

/** Whether a caller may run PRIVILEGED ops (set_theme / set_config). Fails CLOSED: the caller must
 *  resolve to a known, NON-worker (interactive) agent. Workers run unattended and auto-approve every
 *  tool call (dangerouslySkipPermissions), so persona prose alone can't stop one from changing the
 *  human's global theme/config — the dispatcher enforces it. An UNRESOLVABLE caller (stale, spoofed,
 *  or malformed id) is also denied: SPARKLE_AGENT_ID is injected by the app and stamped server-side,
 *  so a legitimate interactive caller always resolves to one of its own agent tabs. */
function callerMayAdminister(callerAgentId: string): boolean {
  const kind = findAgent(callerAgentId)?.agent.kind;
  return kind != null && kind !== "worker";
}

/** get_state → the full agent roster (across every project) + the current theme preference. Status
 *  comes from the live runtimeStore (keyed by agentId globally); an agent with no live status yet
 *  reads as "idle" (finished-its-turn), the same default the sidebar shows. */
function handleGetState(): {
  agents: unknown[];
  theme: ThemePref;
  models: string[];
  agentOrdering: AgentOrdering;
  zoom: number;
} {
  const { projects } = useProjectStore.getState();
  const status = useRuntimeStore.getState().status;
  const ui = useUiStore.getState();
  const agents = projects.flatMap((p) =>
    p.agents.map((a) => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      status: status[a.id] ?? "idle",
      parentId: a.parentId,
      activity: a.activity ?? null,
    })),
  );
  // Additive Phase-3 fields so an agent can read before writing: the model ids it may pass to
  // set_agent_model, the current sidebar ordering mode, and the current zoom. Existing fields
  // (agents, theme) are unchanged.
  return {
    agents,
    theme: ui.themePref,
    models: getModelCatalog().map((m) => m.id),
    agentOrdering: ui.agentOrdering,
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

/** pin_agent → freeze THAT agent's sidebar row at `index` (defaults target to caller). Privileged. */
function handlePinAgent(req: ControlRequest): Record<string, unknown> {
  const targetId = resolveTargetId(req);
  const index = req.payload.index;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
    return { ok: false, error: "index must be a non-negative integer" };
  }
  const found = findAgent(targetId);
  if (!found) return { ok: false, error: `unknown agent ${targetId}` };
  useProjectStore.getState().pinAgentAt(found.projectId, targetId, index);
  return { ok: true };
}

/** unpin_agent → release THAT agent's row back into the attention sort (defaults to caller). */
function handleUnpinAgent(req: ControlRequest): Record<string, unknown> {
  const targetId = resolveTargetId(req);
  const found = findAgent(targetId);
  if (!found) return { ok: false, error: `unknown agent ${targetId}` };
  useProjectStore.getState().unpinAgent(found.projectId, targetId);
  return { ok: true };
}

/** set_agent_model → set THAT agent's Claude model (defaults to caller). Validates `model` against
 *  the live catalog (the Default sentinel is always the catalog head), rejecting an unknown id. */
function handleSetAgentModel(req: ControlRequest): Record<string, unknown> {
  const targetId = resolveTargetId(req);
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

/** set_agent_ordering → the sidebar ordering mode ("attention" | "manual"). Global. Privileged. */
function handleSetAgentOrdering(req: ControlRequest): Record<string, unknown> {
  const mode = req.payload.mode;
  if (mode !== "attention" && mode !== "manual") {
    return { ok: false, error: 'mode must be "attention" | "manual"' };
  }
  useUiStore.getState().setAgentOrdering(mode);
  return { ok: true };
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
  const targetKind = PER_AGENT_OPS.has(op)
    ? findAgent(resolveTargetId(req))?.agent.kind
    : callerKind;
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
    let result: unknown;
    switch (req.op) {
      case "get_state":
        result = handleGetState();
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
