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
import { useUiStore, type ThemePref } from "../stores/uiStore";
import { getConfig, setConfigValue } from "./config";
import type { AgentTab } from "../types";

const EVENT = "control:request";

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
function handleGetState(): { agents: unknown[]; theme: ThemePref } {
  const { projects } = useProjectStore.getState();
  const status = useRuntimeStore.getState().status;
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
  return { agents, theme: useUiStore.getState().themePref };
}

/** rename_agent → set THAT agent's name (defaults to the caller). Rejects an unknown/blank target. */
function handleRename(req: ControlRequest): Record<string, unknown> {
  const targetId = resolveTargetId(req);
  const name = req.payload.name;
  if (typeof name !== "string" || !name.trim()) return { ok: false, error: "name is required" };
  const found = findAgent(targetId);
  if (!found) return { ok: false, error: `unknown agent ${targetId}` };
  useProjectStore.getState().renameAgent(found.projectId, targetId, name);
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

/** set_theme → the app-wide theme preference (uiStore.setThemePref). Denied for worker callers —
 *  an unattended worker must not change the human's global appearance on its own initiative. */
function handleSetTheme(req: ControlRequest): Record<string, unknown> {
  if (!callerMayAdminister(req.callerAgentId)) {
    return { ok: false, error: "set_theme is only permitted for interactive (non-worker) agents" };
  }
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

/** set_config → write one dotted key to the global config file (existing set_config_value command).
 *  Denied for worker callers — writing global app config unattended is out of a worker's remit. */
async function handleSetConfig(req: ControlRequest): Promise<Record<string, unknown>> {
  if (!callerMayAdminister(req.callerAgentId)) {
    return { ok: false, error: "set_config is only permitted for interactive (non-worker) agents" };
  }
  const path = req.payload.path;
  const value = req.payload.value;
  if (typeof path !== "string" || !path) return { ok: false, error: "path is required" };
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return { ok: false, error: "value must be a string, number, or boolean" };
  }
  await setConfigValue(path, value);
  return { ok: true };
}

/** Dispatch one op and reply EXACTLY once. Any thrown error becomes an `{ error }` reply so a
 *  handler failure can't leave the bridge blocked for its full timeout. */
async function dispatch(req: ControlRequest): Promise<void> {
  try {
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
      default:
        result = { error: `unknown op ${req.op}` };
    }
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
