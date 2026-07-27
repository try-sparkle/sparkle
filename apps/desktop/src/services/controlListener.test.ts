import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore, RUNTIME_PERSIST_KEY } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";

// --- mock the Tauri event layer: capture the registered handler so tests can fire events. ---
let firedHandler: ((e: { payload: unknown }) => void) | undefined;
const unlistenMock = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_event: string, cb: (e: { payload: unknown }) => void) => {
    firedHandler = cb;
    return Promise.resolve(unlistenMock);
  }),
}));

// --- mock invoke, routed by command name. control_respond calls are captured so we can assert the
//     reply for each reqId; get_config/set_config_value stand in for the real Rust config commands. ---
const controlResponds: Array<{ reqId: string; result: unknown }> = [];
const setConfigCalls: Array<{ path: string; value: unknown }> = [];
const setConfigValuesCalls: Array<{ values: Record<string, unknown> }> = [];
const invokeMock = vi.fn(async (cmd: string, args?: unknown) => {
  switch (cmd) {
    case "start_control_bridge":
      return { socketPath: "/tmp/control.sock", token: "tok" };
    case "control_mcp_paths":
      return { nodePath: "/node", serverPath: "/srv/control.js" };
    case "control_respond":
      controlResponds.push(args as { reqId: string; result: unknown });
      return undefined;
    case "get_config":
      return { config: { workers: { max_concurrent: 4 } }, warnings: [] };
    case "set_config_value":
      setConfigCalls.push(args as { path: string; value: unknown });
      return undefined;
    case "set_config_values":
      setConfigValuesCalls.push(args as { values: Record<string, unknown> });
      return undefined;
    default:
      return undefined;
  }
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...(a as [string, unknown])) }));

import { startControlListener, isControlOpSuccess, type ControlRequest } from "./controlListener";
import { useSelfReportMetrics } from "../stores/selfReportMetrics";

const fire = (req: ControlRequest) => firedHandler!({ payload: req });
const flush = () => new Promise((r) => setTimeout(r, 0));
const lastReply = () => controlResponds.at(-1)!.result as Record<string, unknown>;

describe("controlListener", () => {
  let cleanup: (() => void) | undefined;
  let projectId: string;
  let callerId: string;
  let otherId: string;

  beforeEach(async () => {
    firedHandler = undefined;
    invokeMock.mockClear();
    unlistenMock.mockClear();
    controlResponds.length = 0;
    setConfigCalls.length = 0;
    setConfigValuesCalls.length = 0;
    useProjectStore.setState({ projects: [], selectedProjectId: null } as never);
    // Reset BOTH liveness inputs get_state's "active" scope reads — the in-memory open set and the
    // shared persisted one (readPersistedOpenAgentIds reads localStorage) — or open ids leak between
    // tests and silently widen the roster.
    useRuntimeStore.setState({ status: {}, openAgentIds: [] } as never);
    try {
      localStorage.removeItem(RUNTIME_PERSIST_KEY);
    } catch {
      /* jsdom without localStorage — readPersistedOpenAgentIds already treats that as empty */
    }
    useUiStore.getState().setThemePref("auto");
    const store = useProjectStore.getState();
    projectId = store.addProject("Demo", "/tmp/demo");
    callerId = store.addAgent(projectId, { kind: "build" })!;
    otherId = store.addAgent(projectId, { kind: "worker", parentId: callerId })!;
    cleanup = await startControlListener();
  });
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it("starts the control bridge on init", () => {
    expect(invokeMock).toHaveBeenCalledWith("start_control_bridge");
  });

  it("get_state → replies with the agent roster + theme", async () => {
    useRuntimeStore.getState().setStatus(callerId, "working");
    useRuntimeStore.getState().setStatus(otherId, "waiting");
    useUiStore.getState().setThemePref("dark");
    fire({ reqId: "r1", op: "get_state", callerAgentId: callerId, payload: {} });
    await flush();
    const res = lastReply() as { agents: Array<Record<string, unknown>>; theme: string };
    expect(res.theme).toBe("dark");
    expect(res.agents).toHaveLength(2);
    const caller = res.agents.find((a) => a.id === callerId)!;
    expect(caller).toMatchObject({ name: expect.any(String), kind: "build", status: "working", parentId: null, activity: null });
    const worker = res.agents.find((a) => a.id === otherId)!;
    expect(worker).toMatchObject({ kind: "worker", parentId: callerId, status: "waiting" });
  });

  // An agent with NO runtime status entry reads as "stopped" (no process), not "idle" (finished its
  // turn, waiting on you). This defaulted to "idle" until 2026-07-26, which made every
  // persisted-but-closed tab report as a live agent idling for attention — see handleGetState.
  it("get_state defaults to scope 'active', dropping stopped agents but REPORTING the omission", async () => {
    // A dormant agent UNRELATED to the caller — not its child, not open, no status entry. This is
    // the only thing the "active" scope may drop; the caller's own children never qualify (#53407).
    const strangerId = useProjectStore.getState().addAgent(projectId, { kind: "build" })!;
    useRuntimeStore.getState().setStatus(callerId, "working");
    useRuntimeStore.getState().setStatus(otherId, "working");
    fire({ reqId: "s1", op: "get_state", callerAgentId: callerId, payload: {} });
    await flush();
    const res = lastReply() as { agents: Array<Record<string, unknown>>; scope: string; totalAgents: number; omitted: number };
    expect(res.scope).toBe("active");
    expect(res.agents.map((a) => a.id).sort()).toEqual([callerId, otherId].sort());
    expect(res.agents.map((a) => a.id)).not.toContain(strangerId);
    // The dropped rows must be COUNTED, not silently truncated — a narrowed roster that claims to
    // be the whole fleet is worse than an expensive one.
    expect(res.totalAgents).toBe(3);
    expect(res.omitted).toBe(1);
  });

  // roborev #53406: `status` is window-local and never persisted, but control:request is broadcast
  // to EVERY window and whichever replies first answers. An agent mounted in ANOTHER window has no
  // status entry here, so a status-only "active" filter would drop it from the roster entirely —
  // strictly worse than the mislabeling it replaced. `openAgentIds` is persisted + merged across
  // windows, so it is the app-wide liveness signal.
  it("get_state scope 'active' keeps an agent that is open in another window with no local status", async () => {
    useRuntimeStore.getState().setStatus(callerId, "working");
    // otherId: open (per the shared/persisted open set) but no status entry in THIS window.
    useRuntimeStore.setState({ openAgentIds: [otherId] } as never);
    fire({ reqId: "s5", op: "get_state", callerAgentId: callerId, payload: {} });
    await flush();
    const res = lastReply() as { agents: Array<Record<string, unknown>>; omitted: number };
    expect(res.agents.map((a) => a.id).sort()).toEqual([callerId, otherId].sort());
    expect(res.omitted).toBe(0);
  });

  // roborev #53407: "stopped" is ALSO what an agent with no runtime entry reads as — a just-spawned
  // worker (pane not mounted yet) or a stranded one. An orchestrator that spawns workers and then
  // calls get_state() must never be told its own fleet does not exist.
  it("get_state scope 'active' never hides the caller's own children, even with no status entry", async () => {
    useRuntimeStore.getState().setStatus(callerId, "working");
    useRuntimeStore.setState({ openAgentIds: [] } as never); // otherId: worker, parentId=callerId
    fire({ reqId: "s7", op: "get_state", callerAgentId: callerId, payload: {} });
    await flush();
    const res = lastReply() as { agents: Array<Record<string, unknown>>; omitted: number };
    const worker = res.agents.find((a) => a.id === otherId);
    expect(worker).toMatchObject({ kind: "worker", parentId: callerId, status: "stopped" });
    expect(res.omitted).toBe(0);
  });

  it("get_state reports the dropped IDS, not just a count, so a caller can resolve one without a full re-read", async () => {
    const strangerId = useProjectStore.getState().addAgent(projectId, { kind: "build" })!;
    useRuntimeStore.getState().setStatus(callerId, "working");
    useRuntimeStore.getState().setStatus(otherId, "working");
    useRuntimeStore.setState({ openAgentIds: [] } as never);
    fire({ reqId: "s6", op: "get_state", callerAgentId: callerId, payload: {} });
    await flush();
    const res = lastReply() as { omitted: number; omittedIds: string[] };
    expect(res.omitted).toBe(1);
    expect(res.omittedIds).toEqual([strangerId]);
  });

  it("get_state scope 'self' returns only the caller", async () => {
    useRuntimeStore.getState().setStatus(callerId, "working");
    useRuntimeStore.getState().setStatus(otherId, "working");
    fire({ reqId: "s2", op: "get_state", callerAgentId: callerId, payload: { scope: "self" } });
    await flush();
    const res = lastReply() as { agents: Array<Record<string, unknown>>; scope: string; omitted: number };
    expect(res.scope).toBe("self");
    expect(res.agents.map((a) => a.id)).toEqual([callerId]);
    expect(res.omitted).toBe(1);
  });

  it("get_state scope 'all' still returns dormant agents (the pre-scope behavior)", async () => {
    useRuntimeStore.getState().setStatus(callerId, "working"); // otherId stays "stopped"
    fire({ reqId: "s3", op: "get_state", callerAgentId: callerId, payload: { scope: "all" } });
    await flush();
    const res = lastReply() as { agents: Array<Record<string, unknown>>; scope: string; omitted: number };
    expect(res.scope).toBe("all");
    expect(res.agents).toHaveLength(2);
    expect(res.agents.find((a) => a.id === otherId)).toMatchObject({ status: "stopped" });
    expect(res.omitted).toBe(0);
  });

  it("get_state coerces an unknown scope to the cheap default rather than erroring", async () => {
    useRuntimeStore.getState().setStatus(callerId, "working");
    const strangerId = useProjectStore.getState().addAgent(projectId, { kind: "build" })!;
    fire({ reqId: "s4", op: "get_state", callerAgentId: callerId, payload: { scope: 42 } });
    await flush();
    const res = lastReply() as { scope: string; agents: Array<Record<string, unknown>> };
    expect(res.scope).toBe("active");
    // Behaves exactly like the default: caller (live) + its own worker, minus the dormant stranger.
    expect(res.agents.map((a) => a.id)).not.toContain(strangerId);
    expect(res.agents.map((a) => a.id).sort()).toEqual([callerId, otherId].sort());
  });

  it("rename_agent defaults the target to the caller and self-names (authoritative, NOT pinned)", async () => {
    fire({ reqId: "r2", op: "rename_agent", callerAgentId: callerId, payload: { name: "Parser Builder" } });
    await flush();
    expect(lastReply()).toEqual({ ok: true });
    const agent = useProjectStore.getState().projects[0]!.agents.find((a) => a.id === callerId)!;
    expect(agent.name).toBe("Parser Builder");
    // An agent naming itself must NOT look pinned: no namePinned (→ no pin chip) and no row anchor.
    // It is marked selfNamed so the auto-namer still won't clobber it. Regression sparkle-pel7.
    expect(agent.selfNamed).toBe(true);
    expect(agent.namePinned).toBe(false);
  });

  it("rename_agent does NOT re-pin after the human unpins (sparkle-pel7)", async () => {
    // Agent self-names → the human releases any pin → the agent self-names AGAIN. The row must stay
    // unpinned throughout: the second self-name must not resurrect namePinned.
    fire({ reqId: "rp1", op: "rename_agent", callerAgentId: callerId, payload: { name: "First Name" } });
    await flush();
    useProjectStore.getState().unpinAgent(projectId, callerId);
    fire({ reqId: "rp2", op: "rename_agent", callerAgentId: callerId, payload: { name: "Second Name" } });
    await flush();
    const agent = useProjectStore.getState().projects[0]!.agents.find((a) => a.id === callerId)!;
    expect(agent.name).toBe("Second Name");
    expect(agent.namePinned).toBe(false);
  });

  it("rename_agent honors an explicit targetAgentId", async () => {
    fire({ reqId: "r3", op: "rename_agent", callerAgentId: callerId, payload: { targetAgentId: otherId, name: "Sub Task" } });
    await flush();
    expect(lastReply()).toEqual({ ok: true });
    expect(useProjectStore.getState().projects[0]!.agents.find((a) => a.id === otherId)!.name).toBe("Sub Task");
  });

  it("rename_agent rejects an unknown agent id", async () => {
    fire({ reqId: "r4", op: "rename_agent", callerAgentId: callerId, payload: { targetAgentId: "nope", name: "X" } });
    await flush();
    expect(lastReply()).toMatchObject({ ok: false });
    expect(String((lastReply() as { error: string }).error)).toContain("nope");
  });

  it("rename_agent rejects a blank name", async () => {
    fire({ reqId: "r4b", op: "rename_agent", callerAgentId: callerId, payload: { name: "   " } });
    await flush();
    expect(lastReply()).toMatchObject({ ok: false });
  });

  it("set_agent_activity sets the caller's activity line", async () => {
    fire({ reqId: "r5", op: "set_agent_activity", callerAgentId: callerId, payload: { activity: "Wiring the listener" } });
    await flush();
    expect(lastReply()).toEqual({ ok: true });
    expect(useProjectStore.getState().projects[0]!.agents.find((a) => a.id === callerId)!.activity).toBe("Wiring the listener");
  });

  it("set_agent_activity rejects an unknown target", async () => {
    fire({ reqId: "r6", op: "set_agent_activity", callerAgentId: "ghost", payload: { activity: "x" } });
    await flush();
    expect(lastReply()).toMatchObject({ ok: false });
  });

  it("set_theme updates the ui theme preference", async () => {
    fire({ reqId: "r7", op: "set_theme", callerAgentId: callerId, payload: { theme: "light" } });
    await flush();
    expect(lastReply()).toEqual({ ok: true });
    expect(useUiStore.getState().themePref).toBe("light");
  });

  it("set_theme rejects an invalid theme", async () => {
    fire({ reqId: "r8", op: "set_theme", callerAgentId: callerId, payload: { theme: "neon" } });
    await flush();
    expect(lastReply()).toMatchObject({ ok: false });
    expect(useUiStore.getState().themePref).toBe("auto");
  });

  it("get_config returns the effective config", async () => {
    fire({ reqId: "r9", op: "get_config", callerAgentId: callerId, payload: {} });
    await flush();
    expect(lastReply()).toEqual({ config: { workers: { max_concurrent: 4 } } });
  });

  it("set_config writes one dotted key via set_config_value", async () => {
    fire({ reqId: "r10", op: "set_config", callerAgentId: callerId, payload: { path: "workers.max_concurrent", value: 6 } });
    await flush();
    expect(lastReply()).toEqual({ ok: true });
    expect(setConfigCalls.at(-1)).toEqual({ path: "workers.max_concurrent", value: 6 });
  });

  it("set_config rejects a missing path", async () => {
    fire({ reqId: "r11", op: "set_config", callerAgentId: callerId, payload: { value: 6 } });
    await flush();
    expect(lastReply()).toMatchObject({ ok: false });
    expect(setConfigCalls).toHaveLength(0);
  });

  it("replies with an error for an unknown op", async () => {
    fire({ reqId: "r12", op: "frobnicate", callerAgentId: callerId, payload: {} });
    await flush();
    expect(String((lastReply() as { error: string }).error)).toContain("unknown op");
  });

  it("replies exactly once per request", async () => {
    fire({ reqId: "once", op: "get_state", callerAgentId: callerId, payload: {} });
    await flush();
    expect(controlResponds.filter((r) => r.reqId === "once")).toHaveLength(1);
  });

  it("denies set_theme from an unattended worker caller", async () => {
    fire({ reqId: "w1", op: "set_theme", callerAgentId: otherId, payload: { theme: "dark" } });
    await flush();
    expect(lastReply()).toMatchObject({ ok: false });
    expect(useUiStore.getState().themePref).toBe("auto"); // unchanged
  });

  it("allows a FREE op (get_config) from an unattended worker caller (reads are not gated)", async () => {
    fire({ reqId: "free1", op: "get_config", callerAgentId: otherId, payload: {} });
    await flush();
    expect(lastReply()).toEqual({ config: { workers: { max_concurrent: 4 } } });
  });

  it("denies set_config from an unattended worker caller (no write happens)", async () => {
    fire({ reqId: "w2", op: "set_config", callerAgentId: otherId, payload: { path: "workers.max_concurrent", value: 9 } });
    await flush();
    expect(lastReply()).toMatchObject({ ok: false });
    expect(setConfigCalls).toHaveLength(0);
  });

  it("denies set_theme from an unresolvable caller (fails closed)", async () => {
    fire({ reqId: "u1", op: "set_theme", callerAgentId: "ghost-caller", payload: { theme: "dark" } });
    await flush();
    expect(lastReply()).toMatchObject({ ok: false });
    expect(useUiStore.getState().themePref).toBe("auto");
  });

  it("denies set_config from an unresolvable caller (fails closed, no write)", async () => {
    fire({ reqId: "u2", op: "set_config", callerAgentId: "ghost-caller", payload: { path: "workers.max_concurrent", value: 9 } });
    await flush();
    expect(lastReply()).toMatchObject({ ok: false });
    expect(setConfigCalls).toHaveLength(0);
  });

  it("ignores a non-string targetAgentId and falls back to the caller", async () => {
    // A misbehaving client sends a numeric targetAgentId — must not be treated as a bogus id.
    fire({ reqId: "t1", op: "set_agent_activity", callerAgentId: callerId, payload: { targetAgentId: 42, activity: "fell back to me" } });
    await flush();
    expect(lastReply()).toEqual({ ok: true });
    expect(useProjectStore.getState().projects[0]!.agents.find((a) => a.id === callerId)!.activity).toBe("fell back to me");
  });

  // ── Phase-3 breadth ops ────────────────────────────────────────────────────────────────────
  it("get_state additively reports models, statusFilter, and zoom", async () => {
    useUiStore.getState().showAllStatusBands();
    useUiStore.getState().toggleStatusBand("running");
    useUiStore.getState().setZoom(1.3);
    fire({ reqId: "gs2", op: "get_state", callerAgentId: callerId, payload: {} });
    await flush();
    const res = lastReply() as {
      models: string[];
      statusFilter: Record<string, boolean>;
      zoom: number;
    };
    expect(Array.isArray(res.models)).toBe(true);
    expect(res.models).toContain("claude-opus-4-8"); // curated catalog fallback id
    // agentOrdering was dropped with the attention sort; statusFilter took its slot.
    expect((res as Record<string, unknown>).agentOrdering).toBeUndefined();
    expect(res.statusFilter).toEqual({ needs_you: true, running: false, done: true });
    expect(res.zoom).toBe(1.3);
  });

  it("set_config accepts an OBJECT value and flattens it to dotted keys via set_config_values", async () => {
    fire({
      reqId: "sc-obj",
      op: "set_config",
      callerAgentId: callerId,
      payload: { path: "workflow.drift", value: { behind_nudge: 3, ahead_nudge: 2 } },
    });
    await flush();
    expect(lastReply()).toEqual({ ok: true });
    expect(setConfigValuesCalls.at(-1)!.values).toEqual({
      "workflow.drift.behind_nudge": 3,
      "workflow.drift.ahead_nudge": 2,
    });
  });

  it("pin_agent is REFUSED — row anchoring no longer exists", async () => {
    // Refused rather than accepted-and-ignored: a no-op {ok:true} would let a caller believe it had
    // moved itself, and the error text is where a confused agent learns why it can't.
    fire({ reqId: "pin1", op: "pin_agent", callerAgentId: callerId, payload: { targetAgentId: otherId, index: 2 } });
    await flush();
    const reply = lastReply() as { ok: boolean; error?: string };
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/pin_agent was removed/);
  });

  it("pin_agent stays privileged — a worker caller is denied before it even reaches the handler", async () => {
    fire({ reqId: "pin2", op: "pin_agent", callerAgentId: otherId, payload: { index: 0 } });
    await flush();
    expect(lastReply()).toMatchObject({ ok: false });
  });

  it("unpin_agent still releases the target's NAME freeze (build caller allowed)", async () => {
    useProjectStore.getState().renameAgent(projectId, otherId, "Human Choice");
    expect(useProjectStore.getState().projects[0]!.agents.find((a) => a.id === otherId)!.namePinned).toBe(true);
    fire({ reqId: "unpin1", op: "unpin_agent", callerAgentId: callerId, payload: { targetAgentId: otherId } });
    await flush();
    expect(lastReply()).toEqual({ ok: true });
    expect(useProjectStore.getState().projects[0]!.agents.find((a) => a.id === otherId)!.namePinned).toBe(false);
  });

  it("set_agent_model sets a catalog model and rejects an unknown one", async () => {
    fire({ reqId: "sm1", op: "set_agent_model", callerAgentId: callerId, payload: { model: "claude-opus-4-8" } });
    await flush();
    expect(lastReply()).toEqual({ ok: true });
    expect(useProjectStore.getState().projects[0]!.agents.find((a) => a.id === callerId)!.model).toBe("claude-opus-4-8");

    fire({ reqId: "sm2", op: "set_agent_model", callerAgentId: callerId, payload: { model: "not-a-real-model" } });
    await flush();
    expect(lastReply()).toMatchObject({ ok: false });
  });

  it("set_agent_model is denied for a worker caller", async () => {
    fire({ reqId: "sm3", op: "set_agent_model", callerAgentId: otherId, payload: { model: "claude-opus-4-8" } });
    await flush();
    expect(lastReply()).toMatchObject({ ok: false });
  });

  it("set_agent_ordering is REFUSED — there is only one ordering now", async () => {
    fire({ reqId: "ord1", op: "set_agent_ordering", callerAgentId: callerId, payload: { mode: "manual" } });
    await flush();
    const reply = lastReply() as { ok: boolean; error?: string };
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/set_agent_ordering was removed/);
  });

  it("set_agent_ordering stays privileged — a worker caller is denied", async () => {
    fire({ reqId: "ord2", op: "set_agent_ordering", callerAgentId: otherId, payload: { mode: "attention" } });
    await flush();
    expect(lastReply()).toMatchObject({ ok: false });
  });

  it("set_zoom sets and clamps the zoom (build caller)", async () => {
    fire({ reqId: "z1", op: "set_zoom", callerAgentId: callerId, payload: { zoom: 5 } });
    await flush();
    expect(lastReply()).toEqual({ ok: true });
    expect(useUiStore.getState().zoom).toBe(1.8); // clamped to ZOOM_MAX

    fire({ reqId: "z2", op: "set_zoom", callerAgentId: callerId, payload: { zoom: "big" } });
    await flush();
    expect(lastReply()).toMatchObject({ ok: false });
  });

  it("navigate sets a special view and denies a worker caller", async () => {
    fire({ reqId: "nav1", op: "navigate", callerAgentId: callerId, payload: { view: "board" } });
    await flush();
    expect(lastReply()).toEqual({ ok: true });
    expect(useUiStore.getState().activeSpecial).toBe("board");

    fire({ reqId: "nav2", op: "navigate", callerAgentId: otherId, payload: { view: "sparkle" } });
    await flush();
    expect(lastReply()).toMatchObject({ ok: false });
  });

  it("navigate to an agent opens+selects it and clears the special view", async () => {
    useUiStore.getState().setActiveSpecial("board");
    fire({ reqId: "nav3", op: "navigate", callerAgentId: callerId, payload: { view: "agent", agentId: otherId } });
    await flush();
    expect(lastReply()).toEqual({ ok: true });
    expect(useUiStore.getState().activeSpecial).toBe(null);
    expect(useProjectStore.getState().projects[0]!.selectedAgentId).toBe(otherId);
  });

  it("navigate to an agent requires a known agentId", async () => {
    fire({ reqId: "nav4", op: "navigate", callerAgentId: callerId, payload: { view: "agent", agentId: "ghost" } });
    await flush();
    expect(lastReply()).toMatchObject({ ok: false });
  });

  // ── Phase-2c self-report tally (sparkle-rl84) ──────────────────────────────────────────────
  it("tallies a successful control op (rename_agent) as a self-report signal", async () => {
    useSelfReportMetrics.getState().reset();
    fire({ reqId: "m1", op: "rename_agent", callerAgentId: callerId, payload: { targetAgentId: otherId, name: "Sub Task" } });
    await flush();
    expect(useSelfReportMetrics.getState().controlOps.rename_agent).toBe(1);
  });

  it("does NOT tally a FAILED op (rejected rename)", async () => {
    useSelfReportMetrics.getState().reset();
    fire({ reqId: "m2", op: "rename_agent", callerAgentId: callerId, payload: { name: "   " } }); // blank → ok:false
    await flush();
    expect(useSelfReportMetrics.getState().controlOps.rename_agent).toBe(0);
  });

  it("does NOT tally an unknown op", async () => {
    useSelfReportMetrics.getState().reset();
    fire({ reqId: "m3", op: "frobnicate", callerAgentId: callerId, payload: {} });
    await flush();
    const ops = useSelfReportMetrics.getState().controlOps;
    expect(Object.values(ops).every((n) => n === 0)).toBe(true);
  });
});

describe("isControlOpSuccess", () => {
  it("treats an explicit { ok: true } as success and { ok: false } as failure", () => {
    expect(isControlOpSuccess({ ok: true })).toBe(true);
    expect(isControlOpSuccess({ ok: false, error: "nope" })).toBe(false);
  });

  it("treats an { error } reply as failure", () => {
    expect(isControlOpSuccess({ error: "unknown op frobnicate" })).toBe(false);
  });

  it("treats a read op's field-less payload (get_state / get_config) as success", () => {
    expect(isControlOpSuccess({ agents: [], theme: "auto" })).toBe(true);
    expect(isControlOpSuccess({ config: {} })).toBe(true);
  });

  it("treats a non-object result as failure", () => {
    expect(isControlOpSuccess(undefined)).toBe(false);
    expect(isControlOpSuccess(null)).toBe(false);
    expect(isControlOpSuccess("ok")).toBe(false);
  });
});
