import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useAuthStore } from "../stores/authStore";
import { useProjectStore } from "../stores/projectStore";
import { buildConciergeFeed } from "./conciergeFeed";
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

// --- the concierge tool spine. Mocked so this file tests the LISTENER's gate (who may call it, and
//     what is forwarded), not the registry — which has its own suite next door. ---
interface ToolCallOnTheWire {
  domain: string;
  op: string;
  args: unknown;
  toolCallId: string;
}
// Captures BOTH arguments. The second one (the policy option) is what makes the human's per-tool
// settings load-bearing, and dropping it here would let `{ policy: configuredToolPolicy }` be
// deleted from the call site with every test still green — a silent revert to "allow everything"
// (roborev 54247, finding 2).
// Return type is the REAL reply union, not the inferred shape of the happy-path literal: dispatch
// is total, so a test that needs a refusal (`denied`, `needs-approval`, `bad-args`…) must be able to
// return one without a cast.
const dispatchConciergeToolMock = vi.fn(
  async (_call: ToolCallOnTheWire, _opts?: { policy?: unknown }): Promise<ConciergeToolReply> => ({
    ok: true,
    domain: "workspace",
    op: "list_projects",
    data: [{ id: "p1" }],
  }),
);
// The PR-claim registry. Mocked so this file tests the HANDLER's decisions — which root it resolves
// to, and whether it defers to a live holder — rather than the Rust registry, which has its own
// suite. Asserting the ARGUMENT is the point: a handler that forwards the agent's raw worktree path
// writes a claim the merge gate can never find, and reports `ok: true` while doing it.
const setPrClaimMock = vi.fn(async (root: string, number: number, agentId: string) => ({
  root,
  number,
  agentId,
  note: null,
  claimedAtMs: 0,
  expiresAtMs: 0,
}));
const releasePrClaimMock = vi.fn(async (_root: string, _number: number, _agentId: string) => true);
const fetchPrClaimsMock = vi.fn(async (_root: string) => [] as unknown[]);
vi.mock("./mergeGuard/prClaims", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mergeGuard/prClaims")>();
  return {
    ...actual,
    setPrClaim: (...a: unknown[]) => setPrClaimMock(...(a as [string, number, string])),
    releasePrClaim: (...a: unknown[]) => releasePrClaimMock(...(a as [string, number, string])),
    fetchPrClaims: (...a: unknown[]) => fetchPrClaimsMock(...(a as [string])),
  };
});

vi.mock("./conciergeTools/registry", () => ({
  dispatchConciergeTool: (...a: unknown[]) =>
    dispatchConciergeToolMock(...(a as [ToolCallOnTheWire, { policy?: unknown }?])),
}));

import { configuredToolPolicy } from "./conciergeTools/policyBinding";
import { useSettingsStore } from "../stores/settingsStore";
import {
  startControlListener,
  isControlOpSuccess,
  CONCIERGE_CALLER_AGENT_ID,
  type ControlRequest,
} from "./controlListener";
import { useSelfReportMetrics } from "../stores/selfReportMetrics";
// The thinking indicator's source of truth — asserted here because this file owns the one call site
// that records it.
import {
  _resetConciergeActivityForTests,
  useConciergeActivityStore,
} from "./conciergeActivity";
import { useConciergeAudit, _resetConciergeAuditForTests } from "./conciergeAudit";
import type { ConciergeToolReply } from "./conciergeTools/registry";


// The concierge's AI-enhancements gate (bead sparkle-4562) is a real precondition for a turn and
// for every tool call, so these suites — which test the mechanics, not the entitlement — open it
// explicitly. `aiGate.concierge.test.ts` is where the gate's own behaviour is asserted.
function openConciergeAiGate() {
  useSettingsStore.setState({ aiConcierge: true });
  useAuthStore.setState({
    me: { clerkUserId: "u1", entitled: true, balanceCents: 5_000, tokenVersion: 1 },
    creditFloorCents: 0,
  } as never);
}

const fire = (req: ControlRequest) => firedHandler!({ payload: req });
const flush = () => new Promise((r) => setTimeout(r, 0));
const lastReply = () => controlResponds.at(-1)!.result as Record<string, unknown>;

describe("controlListener", () => {
  let cleanup: (() => void) | undefined;
  let projectId: string;
  let callerId: string;
  let otherId: string;

  beforeEach(async () => {
    openConciergeAiGate();
    firedHandler = undefined;
    invokeMock.mockClear();
    unlistenMock.mockClear();
    controlResponds.length = 0;
    setConfigCalls.length = 0;
    setConfigValuesCalls.length = 0;
    dispatchConciergeToolMock.mockClear();
    setPrClaimMock.mockClear();
    releasePrClaimMock.mockClear();
    fetchPrClaimsMock.mockClear();
    fetchPrClaimsMock.mockResolvedValue([]);
    releasePrClaimMock.mockResolvedValue(true);
    // The audit log is module-level state; without this, entries from an earlier case would make
    // the length assertions below pass or fail on suite ordering.
    _resetConciergeAuditForTests();
    _resetConciergeActivityForTests();
    // A BOOTED app: config has been read, and the human has set no per-tool overrides. Without the
    // hydrated flag the policy layer deliberately holds back `allow` for anything that can change
    // something, since it cannot yet tell "no rule" from "a rule we haven't loaded".
    useSettingsStore.setState({ conciergeToolPolicy: {}, conciergeToolPolicyHydrated: true });
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

  // ONE AGENT, ONE NAME. `get_state` named rows off `agent.name` while the concierge's needs-you
  // feed named them through `agentDisplayName` — two rules, so the same id could carry two names on
  // screen at once. It did: an agent that had renamed itself "Concierge Issue Triage" was still
  // called "Debug Sparkle concierge agent control and capacity issues" in the feed, because
  // `selfNameAgent` clears `autoNameVariants` but deliberately keeps `aiTitle` (the auto-namer's
  // race anchor) and `aiTitle` led the display chain.
  //
  // Asserted by comparing the TWO SURFACES against each other, with the exact pair of strings from
  // the report, rather than against one hard-coded expectation — the defect was a disagreement, so a
  // test that only pinned one side would have kept passing through it.
  //
  // (Routing get_state through the shared rule is a DEDUPLICATION, not the behavioral fix: for an
  // authoritative name `a.name` was already right. The fix is in `agentDisplayName`, and it is what
  // this test fails on if it regresses.)
  it("get_state and the concierge feed give one agent ONE name", async () => {
    const store = useProjectStore.getState();
    // The agent names itself — the sparkle-control `rename_agent` path — over a session title Claude
    // Code had already derived from its first turn. `selfNameAgent` keeps `aiTitle` on purpose (it
    // is the auto-namer's race anchor), which is what used to leave the feed showing the old one.
    const STALE_TITLE = "Debug Sparkle concierge agent control and capacity issues";
    const CHOSEN = "Concierge Issue Triage";
    store.applyAiTitle(projectId, callerId, STALE_TITLE);
    store.selfNameAgent(projectId, callerId, CHOSEN);
    useRuntimeStore.getState().setStatus(callerId, "working");
    fire({ reqId: "nm1", op: "get_state", callerAgentId: callerId, payload: {} });
    await flush();
    const res = lastReply() as { agents: Array<Record<string, unknown>> };
    const rosterName = res.agents.find((a) => a.id === callerId)!.name;

    // The needs-you feed the concierge receives, built from the same store.
    const feed = buildConciergeFeed({
      projects: useProjectStore.getState().projects,
      status: { [callerId]: "working" },
    });
    const feedName = feed.projects
      .flatMap((p) => p.agents)
      .find((a) => a.id === callerId)!.name;

    expect(rosterName).toBe(feedName);
    expect(rosterName).toBe(CHOSEN);
    expect(feedName).not.toBe(STALE_TITLE);
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

  // AN ORCHESTRATOR'S ROW MUST NOT READ CALM WHILE ITS WORKERS DO NOT. `status` is the agent's own
  // PTY state, and a head sits `idle` between delegations — so a concierge (or any caller) reading
  // this roster was told a head with nine working children was idle, and told a head with a blocked
  // child was idle too, with nothing on the row to tell either from a dead one. `rollupDot` carries
  // engine/workerRollup's answer alongside the own-status; `status` is deliberately unchanged.
  describe("get_state — rollupDot reports the subtree a head stands in for", () => {
    it("reports green for an idle head whose worker is WORKING", async () => {
      useRuntimeStore.getState().setStatus(callerId, "idle");
      useRuntimeStore.getState().setStatus(otherId, "working");
      fire({ reqId: "rd1", op: "get_state", callerAgentId: callerId, payload: {} });
      await flush();
      const res = lastReply() as { agents: Array<Record<string, unknown>> };
      const head = res.agents.find((a) => a.id === callerId)!;
      // Both facts, neither redefined: the head's own PTY state AND what its subtree says.
      expect(head.status).toBe("idle");
      expect(head.rollupDot).toBe("green");
    });

    it("reports red for an idle head whose worker is BLOCKED", async () => {
      useRuntimeStore.getState().setStatus(callerId, "idle");
      useRuntimeStore.getState().setStatus(otherId, "blocked");
      fire({ reqId: "rd2", op: "get_state", callerAgentId: callerId, payload: {} });
      await flush();
      const res = lastReply() as { agents: Array<Record<string, unknown>> };
      const head = res.agents.find((a) => a.id === callerId)!;
      expect(head.status).toBe("idle");
      expect(head.rollupDot).toBe("red");
    });

    it("counts workers the SCOPE dropped — an omitted row still moves its head's dot", async () => {
      // The whole point: scope "active" narrows what comes back, and a caller must not conclude a
      // head is calm because the row that disagrees was filtered out of the reply. Here the worker
      // is `blocked` (so it survives "active" on status) but the head is asked about under "self",
      // which returns the head alone.
      useRuntimeStore.getState().setStatus(callerId, "idle");
      useRuntimeStore.getState().setStatus(otherId, "blocked");
      fire({ reqId: "rd3", op: "get_state", callerAgentId: callerId, payload: { scope: "self" } });
      await flush();
      const res = lastReply() as { agents: Array<Record<string, unknown>> };
      expect(res.agents).toHaveLength(1);
      expect(res.agents[0]!.rollupDot).toBe("red");
    });

    it("leaves a worker row and a childless row reporting their own tier", async () => {
      useRuntimeStore.getState().setStatus(callerId, "idle");
      useRuntimeStore.getState().setStatus(otherId, "working");
      const lone = useProjectStore.getState().addAgent(projectId, { kind: "build" })!;
      useRuntimeStore.getState().setStatus(lone, "waiting");
      fire({ reqId: "rd4", op: "get_state", callerAgentId: callerId, payload: { scope: "all" } });
      await flush();
      const res = lastReply() as { agents: Array<Record<string, unknown>> };
      expect(res.agents.find((a) => a.id === otherId)!.rollupDot).toBe("green");
      expect(res.agents.find((a) => a.id === lone)!.rollupDot).toBe("red");
    });

    // roborev 54742: THE MISSING OBSERVATION MUST NOT BECOME A CALM CLAIM. `status` is window-local
    // and control:request is broadcast, so the window that answers may have no entry for a worker
    // mounted elsewhere (or one just spawned, whose pane has not mounted). Those workers default to
    // "stopped", which bands to `done` and contributes NOTHING — so a head whose whole fleet is
    // invisible from here published `gray`, documented as "nothing running and nothing asking".
    // That is the same false negative agentLiveness exists to stop, and under scope "self" the
    // caller gets no worker rows at all, so it cannot repair the reading itself.
    it("reports null — not gray — for a head whose worker has NO status entry", async () => {
      useRuntimeStore.getState().setStatus(callerId, "idle");
      // otherId (worker, parentId = callerId) deliberately has no status entry: liveness "unknown".
      fire({ reqId: "rd5", op: "get_state", callerAgentId: callerId, payload: {} });
      await flush();
      const res = lastReply() as { agents: Array<Record<string, unknown>> };
      const head = res.agents.find((a) => a.id === callerId)!;
      expect(head.status).toBe("idle"); // own PTY state, unchanged
      expect(head.rollupDot).toBeNull();
    });

    it("reports null for a head whose worker is open only in ANOTHER window", async () => {
      useRuntimeStore.getState().setStatus(callerId, "idle");
      useRuntimeStore.setState({ openAgentIds: [otherId] } as never); // liveness "other-window"
      fire({ reqId: "rd6", op: "get_state", callerAgentId: callerId, payload: { scope: "self" } });
      await flush();
      const res = lastReply() as { agents: Array<Record<string, unknown>> };
      expect(res.agents).toHaveLength(1);
      expect(res.agents[0]!.rollupDot).toBeNull();
    });

    // The suppression is ONE-SIDED on purpose. Withholding an OBSERVED alarm because some OTHER
    // worker is invisible would trade the false negative for a worse one: an alarm someone actually
    // saw, dropped. red/orange are evidence ("this row was seen asking"); green/gray are absence
    // claims, and only an absence claim can be falsified by a row this window cannot see.
    it("keeps an OBSERVED red even when a sibling worker is unobserved", async () => {
      useRuntimeStore.getState().setStatus(callerId, "idle");
      useRuntimeStore.getState().setStatus(otherId, "blocked");
      useProjectStore.getState().addAgent(projectId, { kind: "worker", parentId: callerId }); // no status
      fire({ reqId: "rd7", op: "get_state", callerAgentId: callerId, payload: {} });
      await flush();
      const res = lastReply() as { agents: Array<Record<string, unknown>> };
      expect(res.agents.find((a) => a.id === callerId)!.rollupDot).toBe("red");
    });

    // GREEN IS AN ABSENCE CLAIM TOO. "work is running under this row" reads as "and nothing under it
    // is asking" — which the invisible worker may well be doing.
    it("reports null for a green head when a sibling worker is unobserved", async () => {
      useRuntimeStore.getState().setStatus(callerId, "idle");
      useRuntimeStore.getState().setStatus(otherId, "working");
      useProjectStore.getState().addAgent(projectId, { kind: "worker", parentId: callerId }); // no status
      fire({ reqId: "rd8", op: "get_state", callerAgentId: callerId, payload: {} });
      await flush();
      const res = lastReply() as { agents: Array<Record<string, unknown>> };
      expect(res.agents.find((a) => a.id === callerId)!.rollupDot).toBeNull();
    });

    // …and a FULLY observed subtree still answers. Withholding gray whenever any row is defaulted
    // would make the field useless in the ordinary single-window case, which is most of them.
    it("still reports gray when the whole subtree IS observed", async () => {
      useRuntimeStore.getState().setStatus(callerId, "idle");
      useRuntimeStore.getState().setStatus(otherId, "done");
      fire({ reqId: "rd9", op: "get_state", callerAgentId: callerId, payload: {} });
      await flush();
      const res = lastReply() as { agents: Array<Record<string, unknown>> };
      expect(res.agents.find((a) => a.id === callerId)!.rollupDot).toBe("gray");
    });
  });

  // roborev #53441: the caller is definitionally live — it is making the call — but nothing
  // guarantees it a status entry (a different window may answer; a fresh worker's pane has not
  // mounted). Without an explicit clause it could omit ITSELF, which also made "active" inconsistent
  // with "self". Every other scope test sets the caller's status first, so this case was uncovered.
  it("get_state scope 'active' always includes the CALLER, with no status entry and no open id", async () => {
    useRuntimeStore.setState({ status: {}, openAgentIds: [] } as never);
    fire({ reqId: "s8", op: "get_state", callerAgentId: callerId, payload: {} });
    await flush();
    const res = lastReply() as { agents: Array<Record<string, unknown>>; omittedIds: string[] };
    expect(res.agents.map((a) => a.id)).toContain(callerId);
    expect(res.omittedIds).not.toContain(callerId);
  });

  it("get_state omits omittedIds for scope 'self' — the cheap scope must not ship the whole backlog", async () => {
    for (let i = 0; i < 5; i++) useProjectStore.getState().addAgent(projectId, { kind: "build" });
    fire({ reqId: "s9", op: "get_state", callerAgentId: callerId, payload: { scope: "self" } });
    await flush();
    const res = lastReply() as { agents: unknown[]; omitted: number; omittedIds: string[] };
    expect(res.agents).toHaveLength(1);
    expect(res.omitted).toBe(6); // exact count still reported…
    expect(res.omittedIds).toEqual([]); // …but no id list, which "self" cannot act on anyway
  });

  it("get_state caps omittedIds while keeping the exact count, so truncation stays visible", async () => {
    useRuntimeStore.getState().setStatus(callerId, "working");
    useRuntimeStore.getState().setStatus(otherId, "working");
    for (let i = 0; i < 25; i++) useProjectStore.getState().addAgent(projectId, { kind: "build" });
    fire({ reqId: "s10", op: "get_state", callerAgentId: callerId, payload: {} });
    await flush();
    const res = lastReply() as { omitted: number; omittedIds: string[] };
    expect(res.omitted).toBe(25);
    expect(res.omittedIds).toHaveLength(20);
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

  // roborev 53476: once "active" started keeping rows on evidence OTHER than a live status entry,
  // those rows still reported status "stopped" — the documented value for "no process at all" and
  // the one workerAttention paints RED. A caller polling its fleet could read a live worker as dead
  // and respawn it. `liveness` is what tells the two apart, so each clause is pinned to its label.
  it("get_state labels a row with a live status entry as liveness 'local' (status is authoritative)", async () => {
    useRuntimeStore.getState().setStatus(callerId, "working");
    useRuntimeStore.getState().setStatus(otherId, "waiting");
    fire({ reqId: "s9", op: "get_state", callerAgentId: callerId, payload: {} });
    await flush();
    const res = lastReply() as { agents: Array<Record<string, unknown>> };
    expect(res.agents.find((a) => a.id === otherId)).toMatchObject({
      status: "waiting",
      liveness: "local",
    });
  });

  it("get_state labels an agent open in ANOTHER window as 'other-window' (status unobservable here)", async () => {
    useRuntimeStore.getState().setStatus(callerId, "working");
    useRuntimeStore.setState({ openAgentIds: [otherId] } as never); // open, but no status HERE
    fire({ reqId: "s10", op: "get_state", callerAgentId: callerId, payload: {} });
    await flush();
    const res = lastReply() as { agents: Array<Record<string, unknown>> };
    const worker = res.agents.find((a) => a.id === otherId)!;
    // `status` still defaults to "stopped" — that is exactly why the label has to be here. Note the
    // label says "this window cannot see it", NOT "it is alive": openAgentIds is cleared only on
    // close and survives relaunch, so a finished worker can sit here indefinitely (roborev 53552).
    expect(worker).toMatchObject({ status: "stopped", liveness: "other-window" });
  });

  it("get_state labels a just-spawned worker (no entry, not open) as 'unknown'", async () => {
    useRuntimeStore.getState().setStatus(callerId, "working");
    useRuntimeStore.setState({ openAgentIds: [] } as never); // otherId: worker, parentId=callerId
    fire({ reqId: "s11", op: "get_state", callerAgentId: callerId, payload: {} });
    await flush();
    const res = lastReply() as { agents: Array<Record<string, unknown>> };
    const worker = res.agents.find((a) => a.id === otherId)!;
    expect(worker).toMatchObject({ status: "stopped", liveness: "unknown" });
    // The point of the field: "stopped" here is a DEFAULT, not an observation, so it must not be
    // readable as "this worker died" — only the "local" label carries an actual status reading.
    expect(worker.liveness).not.toBe("local");
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

  // ── The user's communication guidelines (append-only) ──────────────────────────────────────
  it("append_communication_guideline writes the rule and STAMPS the attribution", async () => {
    // Attribution is not a parameter. With no approval step in front of this write, the record of
    // who added a rule is the only thing that makes an unwanted one findable in the editor — so the
    // caller does not get to author, understate, or omit it.
    invokeMock.mockClear();
    fire({
      reqId: "cg1",
      op: "append_communication_guideline",
      callerAgentId: callerId,
      payload: { rule: "  Be terse.  " },
    });
    await flush();
    expect(lastReply()).toMatchObject({ ok: true });
    expect(invokeMock).toHaveBeenCalledWith("append_concierge_guideline", {
      rule: "  Be terse.  ",
      attribution: "Sparkle",
    });
  });

  it("append_communication_guideline refuses an empty rule without touching the file", async () => {
    invokeMock.mockClear();
    fire({
      reqId: "cg2",
      op: "append_communication_guideline",
      callerAgentId: callerId,
      payload: { rule: "   " },
    });
    await flush();
    expect(lastReply()).toMatchObject({ ok: false });
    expect(invokeMock).not.toHaveBeenCalledWith("append_concierge_guideline", expect.anything());
  });

  it("append_communication_guideline reports a REFUSED write instead of claiming success", async () => {
    // The concierge is about to tell the user it saved their preference. It must not say that
    // about a write Rust rejected (over the size cap), or the user will believe a rule is in force
    // that was never written.
    invokeMock.mockImplementationOnce(async () => {
      throw new Error("guidelines file is too large");
    });
    fire({
      reqId: "cg3",
      op: "append_communication_guideline",
      callerAgentId: callerId,
      payload: { rule: "Be terse." },
    });
    await flush();
    expect(lastReply()).toMatchObject({ ok: false });
  });

  it("append_communication_guideline denies an unattended worker", async () => {
    // Privileged, like every other write here: a worker must not edit how the app talks to the human.
    fire({
      reqId: "cg4",
      op: "append_communication_guideline",
      callerAgentId: otherId,
      payload: { rule: "Be terse." },
    });
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

  it("tallies a successful guidelines append — the counter the type guard could not prove", async () => {
    // A RUNTIME assertion, deliberately. This op reached the ControlOp union and the counter's key
    // map but not TALLIED_OPS, so it tallied zero forever with a green build; the first fix added a
    // parallel type-level record that did not actually constrain the Set (roborev 54896 → 55029).
    // A type assertion cannot observe a value — only this can.
    useSelfReportMetrics.getState().reset();
    fire({
      reqId: "m3",
      op: "append_communication_guideline",
      callerAgentId: callerId,
      payload: { rule: "Be terse." },
    });
    await flush();
    expect(useSelfReportMetrics.getState().controlOps.append_communication_guideline).toBe(1);
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

  // ── concierge caller identity (bead sparkle-9a8j, design A7.3) ────────────────────────────
  //
  // The reserved id can ONLY be minted by Rust, on the concierge's own control socket — a request
  // on the shared socket claiming it is rejected there (bridge.rs
  // `shared_socket_rejects_a_request_claiming_the_reserved_concierge_id`). By the time an event
  // reaches this listener the id is therefore a fact about which socket it arrived on. These tests
  // cover THIS half: given that id, what the frontend gate does with it.
  describe("claim_pr / release_pr — intent an agent can state and the concierge can read", () => {
    it("resolves a WORKTREE path to its project root — the likely input, and the silent failure", async () => {
      // An agent's cwd IS its worktree, and the tool asks for "the project root". Forwarding it raw
      // writes a claim under a key the merge gate looks up by exact string and never finds: the
      // agent is told ok, believes the PR is held, and nothing blocks. False assurance is worse
      // than no claim.
      const wt = "/tmp/demo-worktrees/agent-1";
      useProjectStore.setState({
        projects: [
          { id: projectId, name: "Demo", rootPath: "/tmp/demo", agents: [{ id: callerId, worktreePath: wt }] },
        ],
      } as never);
      fire({ reqId: "c1", op: "claim_pr", callerAgentId: callerId, payload: { root: wt, number: 806 } });
      await flush();
      expect(lastReply()).toMatchObject({ ok: true });
      expect(setPrClaimMock).toHaveBeenCalled();
      expect(setPrClaimMock.mock.calls[0]![0]).toBe("/tmp/demo");
    });

    it("canonicalizes a trailing separator to the registered spelling", async () => {
      fire({ reqId: "c2", op: "claim_pr", callerAgentId: callerId, payload: { root: "/tmp/demo/", number: 806 } });
      await flush();
      expect(setPrClaimMock.mock.calls[0]![0]).toBe("/tmp/demo");
    });

    it("REFUSES an unknown root instead of writing an unfindable claim", async () => {
      fire({ reqId: "c3", op: "claim_pr", callerAgentId: callerId, payload: { root: "/nowhere", number: 806 } });
      await flush();
      expect(lastReply()).toMatchObject({ ok: false });
      expect(setPrClaimMock).not.toHaveBeenCalled();
    });

    it("stamps the CALLER as claimant and ignores an agentId in the payload", async () => {
      fire({
        reqId: "c4",
        op: "claim_pr",
        callerAgentId: callerId,
        payload: { root: "/tmp/demo", number: 806, agentId: otherId, targetAgentId: otherId },
      });
      await flush();
      expect(setPrClaimMock.mock.calls[0]![2]).toBe(callerId);
    });

    it("will not take over a lapsed claim whose holder is STILL RUNNING", async () => {
      // Rust judges takeover on the clock alone (it has no roster), so past the TTL it would let
      // anyone overwrite the row — handing ownership to a second agent while the first is alive and
      // believes it holds the PR. Liveness is knowable here, so the decision is made here.
      fetchPrClaimsMock.mockResolvedValue([
        { root: "/tmp/demo", number: 806, agentId: otherId, note: "draining roborev", claimedAtMs: 0, expiresAtMs: 0 },
      ]);
      fire({ reqId: "c5", op: "claim_pr", callerAgentId: callerId, payload: { root: "/tmp/demo", number: 806 } });
      await flush();
      expect(lastReply()).toMatchObject({ ok: false });
      // "registered", not "running": the predicate is roster PRESENCE, and a remedy string has to
      // be true under the conditions that triggered it — telling a caller to wait for the holder to
      // "stop" points at a transition that may never happen.
      const err = String((lastReply() as { error: string }).error);
      expect(err).toContain("still registered");
      expect(err).not.toContain("still running");
      expect(err).toContain("grace"); // and it names the ceiling that WILL clear the block
      expect(setPrClaimMock).not.toHaveBeenCalled();
    });

    it("DOES take over once the holder has left the roster", async () => {
      fetchPrClaimsMock.mockResolvedValue([
        { root: "/tmp/demo", number: 806, agentId: "a-ghost", note: null, claimedAtMs: 0, expiresAtMs: 0 },
      ]);
      fire({ reqId: "c6", op: "claim_pr", callerAgentId: callerId, payload: { root: "/tmp/demo", number: 806 } });
      await flush();
      expect(lastReply()).toMatchObject({ ok: true });
      expect(setPrClaimMock).toHaveBeenCalled();
    });

    it("REFUSES when the registry is unreadable — it will not write over a holder it never saw", async () => {
      fetchPrClaimsMock.mockResolvedValue(null as never);
      fire({ reqId: "c7", op: "claim_pr", callerAgentId: callerId, payload: { root: "/tmp/demo", number: 806 } });
      await flush();
      expect(lastReply()).toMatchObject({ ok: false });
      expect(setPrClaimMock).not.toHaveBeenCalled();
    });

    it("a release aimed at an unknown root does NOT drop the same PR number in another project", async () => {
      // PR numbers are per-repo, so #806 exists in every project. A blind sweep would release the
      // caller's still-live claim in project B and report success.
      const otherProject = useProjectStore.getState().addProject("Other", "/tmp/other");
      expect(otherProject).toBeTruthy();
      fetchPrClaimsMock.mockImplementation(async (root: string) =>
        root === "/tmp/other"
          ? [{ root: "/tmp/other", number: 806, agentId: "someone-else", note: null, claimedAtMs: 0, expiresAtMs: 0 }]
          : [],
      );
      releasePrClaimMock.mockResolvedValue(false);
      fire({ reqId: "r3", op: "release_pr", callerAgentId: callerId, payload: { root: "/nowhere", number: 806 } });
      await flush();
      // The other project's claim belongs to a DIFFERENT agent, so it must never be touched.
      expect(releasePrClaimMock).not.toHaveBeenCalledWith("/tmp/other", 806, callerId);
    });

    it("SWEEPS to the caller's own project when the root does not resolve, and names it", async () => {
      // The positive path the sweep exists for: a claimant whose root stopped resolving (its cwd is
      // a subdirectory, the project was re-added) can still let go of its own PR. Without this the
      // whole block could be deleted with the suite still green.
      fetchPrClaimsMock.mockImplementation(async (root: string) =>
        root === "/tmp/demo"
          ? [{ root: "/tmp/demo", number: 806, agentId: callerId, note: null, claimedAtMs: 0, expiresAtMs: 0 }]
          : [],
      );
      releasePrClaimMock.mockImplementation(async (root: string) => root === "/tmp/demo");
      fire({
        reqId: "r4",
        op: "release_pr",
        callerAgentId: callerId,
        payload: { root: "/tmp/demo/apps/desktop", number: 806 },
      });
      await flush();
      expect(releasePrClaimMock).toHaveBeenCalledWith("/tmp/demo", 806, callerId);
      // The reply must say WHICH root it released — with a sweep in play, `released: true` alone
      // does not tell the caller what it just let go of.
      expect(lastReply()).toMatchObject({ ok: true, released: true, root: "/tmp/demo" });
    });

    it("never sweeps a project the CALLER is not registered under, even for its own claim", async () => {
      // PR numbers are per-repo, so one agent can legitimately hold #806 in two projects. Walking
      // every root would release whichever came first — dropping a live claim in a project the
      // caller never named, and reporting success. Ownership cannot catch it: the caller IS owner.
      useProjectStore.getState().addProject("Other", "/tmp/other");
      fetchPrClaimsMock.mockImplementation(async (root: string) => [
        { root, number: 806, agentId: callerId, note: null, claimedAtMs: 0, expiresAtMs: 0 },
      ]);
      releasePrClaimMock.mockResolvedValue(true);
      fire({ reqId: "r5", op: "release_pr", callerAgentId: callerId, payload: { root: "/nope", number: 806 } });
      await flush();
      expect(releasePrClaimMock).not.toHaveBeenCalledWith("/tmp/other", 806, callerId);
    });

    it("releases against the resolved project root", async () => {
      fire({ reqId: "r1", op: "release_pr", callerAgentId: callerId, payload: { root: "/tmp/demo/", number: 806 } });
      await flush();
      expect(lastReply()).toMatchObject({ ok: true, released: true });
      expect(releasePrClaimMock.mock.calls[0]![0]).toBe("/tmp/demo");
    });

    it("does NOT report a clean no-op when the root was never recognised", async () => {
      // The claimant would be told there was nothing to release while its claim sits in the
      // registry, still blocking — the false-assurance shape, on the release side.
      releasePrClaimMock.mockResolvedValue(false);
      fire({ reqId: "r2", op: "release_pr", callerAgentId: callerId, payload: { root: "/nowhere", number: 806 } });
      await flush();
      const reply = lastReply() as { ok: boolean; error?: string };
      expect(reply.ok).toBe(false);
      expect(String(reply.error)).toContain("not a project Sparkle knows");
    });
  });

  describe("set_agent_goal / set_agent_goal_met", () => {
    it("writes the rich goal record with its TTL", async () => {
      fire({
        reqId: "g1",
        op: "set_agent_goal",
        callerAgentId: callerId,
        payload: { goal: "land the guardrails", ttlMs: 900_000 },
      });
      await flush();
      expect(lastReply()).toMatchObject({ ok: true });
      const agent = useProjectStore.getState().projects.flatMap((p) => p.agents).find((a) => a.id === callerId)!;
      expect(agent.goal?.text).toBe("land the guardrails");
      expect(agent.goal?.ttlMs).toBe(900_000);
      expect(agent.goal?.metAt).toBeUndefined();
    });

    it("reports the goal STATE through get_state, not just a met flag", async () => {
      useProjectStore.getState().setAgentGoal(projectId, callerId, "ship it");
      fire({ reqId: "g2", op: "get_state", callerAgentId: callerId, payload: { scope: "self" } });
      await flush();
      const res = lastReply() as { agents: Array<{ goal?: { text: string; state: string; met: boolean } | null }> };
      expect(res.agents[0]!.goal).toMatchObject({ text: "ship it", state: "unmet", met: false });
    });

    it("marks the CALLER's goal met and IGNORES a target in the payload", async () => {
      // Declaring a different, live agent finished latches its metAt: auto-continue stops and the
      // stall surface renders it done. One wrong id must not be able to do that.
      useProjectStore.getState().setAgentGoal(projectId, callerId, "mine");
      useProjectStore.getState().setAgentGoal(projectId, otherId, "theirs");
      fire({
        reqId: "g3",
        op: "set_agent_goal_met",
        callerAgentId: callerId,
        payload: { met: true, targetAgentId: otherId },
      });
      await flush();
      const agents = useProjectStore.getState().projects.flatMap((p) => p.agents);
      expect(agents.find((a) => a.id === callerId)!.goal?.metAt).toBeDefined();
      expect(agents.find((a) => a.id === otherId)!.goal?.metAt).toBeUndefined();
    });

    it("REFUSES when there is no goal to mark, rather than reporting a bare success", async () => {
      // `setAgentGoalMet` early-returns unchanged with no goal record, so `{ ok: true }` would tell
      // the caller it is done while the concierge goes on reading `goal: null`.
      fire({ reqId: "g4", op: "set_agent_goal_met", callerAgentId: callerId, payload: { met: true } });
      await flush();
      expect(lastReply()).toMatchObject({ ok: false });
      expect(String((lastReply() as { error: string }).error)).toContain("no goal");
    });
  });

  describe("concierge caller", () => {
    it("may run a PRIVILEGED op even though it resolves to no agent tab", async () => {
      fire({ reqId: "c1", op: "set_theme", callerAgentId: CONCIERGE_CALLER_AGENT_ID, payload: { theme: "dark" } });
      await flush();
      expect(lastReply()).toEqual({ ok: true });
      expect(useUiStore.getState().themePref).toBe("dark");
    });

    it("must ASK before writing config, unlike a Build agent (roborev 54226)", async () => {
      // Deliberate behaviour change. The concierge clears `callerMayAdminister` outright, so this
      // used to be a silent global config write. Its prompt is a snapshot of untrusted agent and
      // TERMINAL output, which made that a prompt-injection path into machine-wide settings — text
      // in some agent's terminal could talk the concierge into a config write. `set_config` now
      // defaults to `ask` in the policy layer's `app` domain, and nothing has approved this call.
      fire({
        reqId: "c2",
        op: "set_config",
        callerAgentId: CONCIERGE_CALLER_AGENT_ID,
        payload: { path: "workers.max_concurrent", value: 9 },
      });
      await flush();
      expect(lastReply()).toMatchObject({ ok: false });
      expect(setConfigCalls).toEqual([]); // the gate is BEFORE the mutation, not after
    });

    it("still runs the routine UI ops without asking", async () => {
      // The other half of the trade: gating everything would make the concierge useless. `navigate`
      // is visible, trivially undone, and a core concierge move ("put me where the work is").
      fire({
        reqId: "c2b",
        op: "navigate",
        callerAgentId: CONCIERGE_CALLER_AGENT_ID,
        payload: { view: "board" },
      });
      await flush();
      expect(lastReply()).toEqual({ ok: true });
    });

    it("admitting it does NOT widen the gate: a worker and an unknown id are still refused", async () => {
      // The regression that matters — an over-broad arm (e.g. "any caller findAgent can't resolve")
      // would let both of these through, and both tests below would still be the only signal.
      fire({ reqId: "c3", op: "set_theme", callerAgentId: otherId, payload: { theme: "light" } });
      await flush();
      expect(lastReply()).toMatchObject({ ok: false });
      fire({ reqId: "c4", op: "set_theme", callerAgentId: "ghost-caller", payload: { theme: "light" } });
      await flush();
      expect(lastReply()).toMatchObject({ ok: false });
      // A near-miss on the reserved id is NOT the reserved id.
      fire({ reqId: "c5", op: "set_theme", callerAgentId: "sparkle:concierge2", payload: { theme: "light" } });
      await flush();
      expect(lastReply()).toMatchObject({ ok: false });
      expect(useUiStore.getState().themePref).toBe("auto"); // none of the three changed it
    });

    it("REFUSES a per-agent op with no targetAgentId instead of mutating a random agent", async () => {
      const before = useProjectStore.getState().projects[0]!.agents.map((a) => ({ ...a }));
      fire({ reqId: "c6", op: "rename_agent", callerAgentId: CONCIERGE_CALLER_AGENT_ID, payload: { name: "Nobody" } });
      await flush();
      // A TYPED refusal: a stable machine-readable code, not just prose the brain must parse.
      expect(lastReply()).toMatchObject({ ok: false, code: "target_required" });
      // And nothing moved — in particular no agent got renamed "Nobody".
      expect(useProjectStore.getState().projects[0]!.agents).toEqual(before);
    });

    it("refuses EVERY per-agent op without a target, not just rename", async () => {
      const cases: Array<[string, Record<string, unknown>]> = [
        ["rename_agent", { name: "Nobody" }],
        ["set_agent_activity", { activity: "narrating nothing" }],
        ["unpin_agent", {}],
        ["set_agent_model", { model: "claude-opus-4-8" }],
      ];
      for (const [op, payload] of cases) {
        fire({ reqId: `c7-${op}`, op, callerAgentId: CONCIERGE_CALLER_AGENT_ID, payload });
        await flush();
        expect(lastReply(), `${op} must refuse a targetless concierge call`).toMatchObject({
          ok: false,
          code: "target_required",
        });
      }
    });

    it("runs a per-agent op normally once it names a target", async () => {
      fire({
        reqId: "c8",
        op: "set_agent_activity",
        callerAgentId: CONCIERGE_CALLER_AGENT_ID,
        payload: { targetAgentId: otherId, activity: "told by the concierge" },
      });
      await flush();
      expect(lastReply()).toEqual({ ok: true });
      expect(
        useProjectStore.getState().projects[0]!.agents.find((a) => a.id === otherId)!.activity,
      ).toBe("told by the concierge");
    });

    it("still defaults an ORDINARY caller's per-agent op to itself (the refusal is concierge-only)", async () => {
      fire({ reqId: "c9", op: "set_agent_activity", callerAgentId: callerId, payload: { activity: "self narrated" } });
      await flush();
      expect(lastReply()).toEqual({ ok: true });
      expect(
        useProjectStore.getState().projects[0]!.agents.find((a) => a.id === callerId)!.activity,
      ).toBe("self narrated");
    });

    it("get_state works, and the concierge is not IN the roster it can read", async () => {
      fire({ reqId: "c10", op: "get_state", callerAgentId: CONCIERGE_CALLER_AGENT_ID, payload: { scope: "all" } });
      await flush();
      const all = lastReply() as { agents: Array<{ id: string }> };
      expect(all.agents).toHaveLength(2); // it can read the whole roster...
      // ...and is not one of the rows. `scope: "self"` filters on the caller's own row, so it
      // returns none — which is why the identity has to travel in a field of its own (next suite).
      expect(all.agents.map((a) => a.id)).not.toContain(CONCIERGE_CALLER_AGENT_ID);
    });
  });

  // ── `self` — WHO IS ASKING (bead sparkle-4w09) ──────────────────────────────────────────────────
  //
  // The bug: `scope: "self"` returned `agents: []` for the concierge and nothing else, so the one
  // caller that most needed to know who it was got an EMPTY SUCCESS. These cases assert the reply
  // now CARRIES the answer, not merely that an identity constant exists somewhere — an assertion on
  // a recorded constant would pass against the broken code, which is the vacuous-test failure.
  describe("get_state → self", () => {
    // The full round trip for the caller the bead is about: ask with the cheap scope, get told who
    // you are, which project you are pointed at, and what you are doing.
    it("answers scope 'self' for the CONCIERGE with an identity, not an empty roster", async () => {
      useProjectStore.setState({ selectedProjectId: projectId } as never);
      fire({
        reqId: "self-1",
        op: "get_state",
        callerAgentId: CONCIERGE_CALLER_AGENT_ID,
        payload: { scope: "self" },
      });
      await flush();
      const res = lastReply() as { agents: unknown[]; self: Record<string, unknown> | null };
      // The roster half is still legitimately empty — the concierge has no row and we do not fake
      // one. What changed is that the reply no longer STOPS there.
      expect(res.agents).toEqual([]);
      expect(res.self).toEqual({
        id: CONCIERGE_CALLER_AGENT_ID,
        kind: "concierge",
        name: "Sparkle",
        // The precondition the per-agent ops default on — false is why they refuse below.
        isAgent: false,
        projectId,
        projectName: "Demo",
        activity: null, // nothing observed yet this run
      });
    });

    // THE NON-VACUOUS HALF. `activity` is not a stored field the concierge can set; it is read back
    // out of the OBSERVED tool recorder that drives the human's thinking indicator. Driving a real
    // concierge_tool call through dispatch and then reading it here proves the wiring, not that an
    // object literal has the key.
    it("reports what the concierge is ACTUALLY doing, from the observed tool recorder", async () => {
      useProjectStore.setState({ selectedProjectId: projectId } as never);
      fire({
        reqId: "self-2a",
        op: "concierge_tool",
        callerAgentId: CONCIERGE_CALLER_AGENT_ID,
        payload: { domain: "workspace", op: "list_projects", args: {}, toolCallId: "tc-self" },
      });
      await flush();
      // Sanity: the indicator's own store saw it, so the read below is reading something real.
      expect(useConciergeActivityStore.getState().latest).toMatchObject({
        domain: "workspace",
        op: "list_projects",
        outcome: "done",
      });
      fire({
        reqId: "self-2b",
        op: "get_state",
        callerAgentId: CONCIERGE_CALLER_AGENT_ID,
        payload: { scope: "self" },
      });
      await flush();
      const res = lastReply() as { self: { activity: string | null } };
      // The settled past tense, phrased by engine/conciergeActivityLine — the same sentence the
      // human is reading in the column, not a second account of it.
      expect(res.self.activity).toBe("Looked over your projects");
    });

    it("gives an ORDINARY agent caller its own row as `self`, on every scope", async () => {
      useProjectStore.getState().setAgentActivity(projectId, callerId, "wiring the seam");
      for (const scope of ["self", "active", "all"] as const) {
        fire({ reqId: `self-3-${scope}`, op: "get_state", callerAgentId: callerId, payload: { scope } });
        await flush();
        const res = lastReply() as { self: Record<string, unknown> | null };
        expect(res.self, `scope ${scope} must still say who is asking`).toMatchObject({
          id: callerId,
          kind: "build",
          isAgent: true,
          projectId,
          projectName: "Demo",
          activity: "wiring the seam",
        });
      }
    });

    // An id that resolves to nothing is described as nothing. Inventing an identity for a stale or
    // spoofed caller would be the same lie the empty roster was, one field over.
    it("reports self: null for a caller that resolves to no agent at all", async () => {
      fire({ reqId: "self-4", op: "get_state", callerAgentId: "ghost-agent", payload: { scope: "all" } });
      await flush();
      expect((lastReply() as { self: unknown }).self).toBeNull();
    });

    // The other half of the bead: the defaulting REFUSES BY NAME rather than no-opping — and now
    // the refusal and `self.isAgent` tell the same story instead of contradicting each other.
    it("refuses a targetless per-agent op by name, citing the identity it DOES have", async () => {
      fire({ reqId: "self-5", op: "rename_agent", callerAgentId: CONCIERGE_CALLER_AGENT_ID, payload: { name: "X" } });
      await flush();
      const reply = lastReply() as { ok: boolean; code: string; error: string };
      expect(reply).toMatchObject({ ok: false, code: "target_required" });
      expect(reply.error).toContain("no agent row of its own");
    });
  });

  // ── concierge_tool — the one op that reaches agent lifecycle, git, the workspace and a PTY ─────
  //
  // Its gate is deliberately narrower than every other privileged op's. `callerMayAdminister` says
  // "any interactive agent", which is right for the theme and wrong for this, so the handler demands
  // the RESERVED id exactly. Every test below asserts the registry was never reached, not merely
  // that `ok` was false — a refusal that still ran the tool is the failure that matters.
  describe("concierge_tool", () => {
    const toolPayload = {
      domain: "workspace",
      op: "list_projects",
      args: { some: "args" },
      toolCallId: "tc-42",
    };

    it("forwards the concierge's call to the registry and replies with the registry's reply verbatim", async () => {
      fire({
        reqId: "t1",
        op: "concierge_tool",
        callerAgentId: CONCIERGE_CALLER_AGENT_ID,
        payload: toolPayload,
      });
      await flush();
      expect(dispatchConciergeToolMock).toHaveBeenCalledTimes(1);
      // The frozen wire contract, unchanged in both directions.
      expect(dispatchConciergeToolMock.mock.calls[0]![0]).toEqual({
        domain: "workspace",
        op: "list_projects",
        args: { some: "args" },
        toolCallId: "tc-42",
      });
      // The seam is CONNECTED — the human's configured policy is handed to the registry, not the
      // permissive default. Without this assertion the wiring can be deleted silently.
      expect(dispatchConciergeToolMock.mock.calls[0]![1]).toEqual({
        policy: configuredToolPolicy,
      });
      expect(lastReply()).toEqual({
        ok: true,
        domain: "workspace",
        op: "list_projects",
        data: [{ id: "p1" }],
      });
    });

    // THE AUDIT LOG (services/conciergeAudit) shares this seam — it is the one place every
    // concierge_tool call passes through. Asserted HERE rather than only on the store, because what
    // can silently break is the WIRING: drop these two lines and the store keeps working perfectly
    // while nothing is ever recorded.
    it("records the call in the audit log, and settles it with the reply", async () => {
      fire({
        reqId: "t1z",
        op: "concierge_tool",
        callerAgentId: CONCIERGE_CALLER_AGENT_ID,
        payload: toolPayload,
      });
      await flush();

      const entries = useConciergeAudit.getState().entries;
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        toolCallId: "tc-42", // carried for display; the join key is minted in the audit module
        domain: "workspace",
        op: "list_projects",
        outcome: "ok",
      });
    });

    // The entries that answer "why didn't it do what I asked?" are the REFUSED ones — and dispatch
    // is TOTAL, so a denial arrives as an ordinary resolved reply, not a throw.
    it("records a REFUSED call with its code and message", async () => {
      dispatchConciergeToolMock.mockImplementationOnce(async () => ({
        ok: false,
        domain: "workflow",
        op: "merge_pr",
        code: "needs-approval",
        message: "merge_pr needs your go-ahead.",
      }));
      fire({
        reqId: "t1y",
        op: "concierge_tool",
        callerAgentId: CONCIERGE_CALLER_AGENT_ID,
        payload: { domain: "workflow", op: "merge_pr", args: { number: 7 }, toolCallId: "tc-77" },
      });
      await flush();

      expect(useConciergeAudit.getState().entries[0]).toMatchObject({
        toolCallId: "tc-77",
        outcome: "refused",
        code: "needs-approval",
        message: "merge_pr needs your go-ahead.",
      });
    });

    // THE THINKING INDICATOR'S ONLY SOURCE OF TRUTH (services/conciergeActivity). The concierge
    // column tells the human "Reading Kraken Auth's terminal…" on the strength of this recording, so
    // if the wiring is dropped the column silently reverts to three dots with nothing failing.
    it("records the call for the thinking indicator, in flight and then settled", async () => {
      let inFlight: unknown;
      dispatchConciergeToolMock.mockImplementationOnce(async () => {
        // Sampled INSIDE dispatch: the tense the human sees while the tool is running.
        inFlight = useConciergeActivityStore.getState().latest;
        return { ok: true, domain: "workspace", op: "list_projects", data: [] };
      });
      fire({
        reqId: "t1a",
        op: "concierge_tool",
        callerAgentId: CONCIERGE_CALLER_AGENT_ID,
        payload: toolPayload,
      });
      await flush();
      expect(inFlight).toMatchObject({
        domain: "workspace",
        op: "list_projects",
        outcome: "running",
      });
      expect(useConciergeActivityStore.getState().latest).toMatchObject({ outcome: "done" });
    });

    // THE REPLY'S OWN `ok` DECIDES THE TENSE. This dispatch is total, so a policy denial and an
    // ask-tier tool awaiting the human's approval are ordinary resolved replies — and settling them
    // as successes made the column announce "Merged PR #753" for a merge that never happened, above
    // the very approval request it was still waiting on.
    it.each([
      ["a policy denial", { code: "denied" }],
      ["an unapproved ask-tier tool", { code: "needs-approval" }],
      ["a bad-args refusal", { code: "bad-args" }],
    ])("settles %s as refused, not as done", async (_label, over) => {
      dispatchConciergeToolMock.mockImplementationOnce(
        async () =>
          ({ ok: false, domain: "workflow", op: "merge_pr", message: "no", ...over }) as never,
      );
      fire({
        reqId: "t1c",
        op: "concierge_tool",
        callerAgentId: CONCIERGE_CALLER_AGENT_ID,
        payload: { domain: "workflow", op: "merge_pr", args: { number: 753 }, toolCallId: "tc" },
      });
      await flush();
      expect(useConciergeActivityStore.getState().latest).toMatchObject({ outcome: "refused" });
    });

    // A refused caller must not be able to put a line in the human's thread. The recording sits
    // AFTER the reserved-id check for exactly this reason.
    it("records nothing for a caller the reserved-id gate refuses", async () => {
      fire({
        reqId: "t1b",
        op: "concierge_tool",
        callerAgentId: "sparkle:concierge2",
        payload: toolPayload,
      });
      await flush();
      expect(useConciergeActivityStore.getState().latest).toBeNull();
    });

    it("coerces a non-string domain/op to \"\" rather than handing the registry a number", async () => {
      fire({
        reqId: "t2",
        op: "concierge_tool",
        callerAgentId: CONCIERGE_CALLER_AGENT_ID,
        payload: { domain: 7, op: null, args: {}, toolCallId: "tc-43" },
      });
      await flush();
      expect(dispatchConciergeToolMock.mock.calls[0]![0]).toMatchObject({ domain: "", op: "" });
    });

    it("refuses a BUILD agent — an interactive caller passes the tier gate but not this one", async () => {
      fire({ reqId: "t3", op: "concierge_tool", callerAgentId: callerId, payload: toolPayload });
      await flush();
      const reply = lastReply();
      expect(reply.ok).toBe(false);
      // Shaped like every other concierge_tool reply, so the caller can branch on `code`.
      expect(reply).toMatchObject({ code: "forbidden", domain: "workspace", op: "list_projects" });
      expect(dispatchConciergeToolMock).not.toHaveBeenCalled();
    });

    it("refuses a WORKER at the privileged tier gate, before the handler is even reached", async () => {
      fire({ reqId: "t4", op: "concierge_tool", callerAgentId: otherId, payload: toolPayload });
      await flush();
      const reply = lastReply();
      expect(reply.ok).toBe(false);
      // The tier-gate wording — proof that concierge_tool is classified `privileged`, not `free`.
      expect(String(reply.error)).toContain("interactive (non-worker) agents");
      expect(dispatchConciergeToolMock).not.toHaveBeenCalled();
    });

    // The near-miss is the one worth spelling out: the check is `===` on the reserved id, so no
    // prefix, suffix or lookalike gets through. The others cover the fail-closed rule for a caller
    // that resolves to nothing at all.
    it.each([
      ["a near-miss id", "sparkle:concierge2"],
      ["a prefix of the reserved id", "sparkle:concierg"],
      ["an unresolvable id", "ghost-agent-does-not-exist"],
      ["an empty id", ""],
    ])("refuses %s and never reaches the registry", async (_label, callerAgentId) => {
      fire({ reqId: `t5-${callerAgentId}`, op: "concierge_tool", callerAgentId, payload: toolPayload });
      await flush();
      expect(lastReply().ok).toBe(false);
      expect(dispatchConciergeToolMock).not.toHaveBeenCalled();
    });

    it("does not weaken the OTHER ops for anyone: an ordinary agent can still rename itself", async () => {
      fire({ reqId: "t6", op: "rename_agent", callerAgentId: callerId, payload: { name: "Still Fine" } });
      await flush();
      expect(lastReply()).toEqual({ ok: true });
    });
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
