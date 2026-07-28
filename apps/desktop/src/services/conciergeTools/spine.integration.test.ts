import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAuthStore } from "../../stores/authStore";
import { useProjectStore } from "../../stores/projectStore";
import { useSettingsStore } from "../../stores/settingsStore";

/**
 * THE ONE TEST THAT EXERCISES THE WHOLE SPINE.
 *
 * The concierge tool path is `bridge.rs` → `control:request` → `controlListener.dispatch` →
 * `conciergeTools/registry` → a domain module → a real store. Every existing test covers a
 * SEGMENT of that and mocks its neighbour:
 *
 *   • `controlListener.test.ts` mocks `./conciergeTools/registry` — it tests the listener's gate
 *     (who may call, and that the policy is handed over), not what the registry does.
 *   • `registry.test.ts` mocks the backends — it tests routing and argument validation, not that
 *     the listener reaches it with the payload shape it expects.
 *   • `bridge.rs`'s `concierge_tool_survives_the_transport_not_just_the_frontend` covers the Rust
 *     allowlist, and stops at the round-trip.
 *
 * So the JUNCTIONS are untested, and they are exactly what drifts: a renamed payload field, a
 * policy that stops being threaded, a domain signature change. Any of those would leave all three
 * suites green while every real tool call failed — which is the same class of gap that let
 * `concierge_tool` sit outside the Rust allowlist with a full green suite.
 *
 * This file therefore mocks NOTHING below the listener: real registry, real policy binding, real
 * workspace domain, real store.
 */

let firedHandler: ((e: { payload: unknown }) => void) | undefined;
const unlistenMock = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_event: string, cb: (e: { payload: unknown }) => void) => {
    firedHandler = cb;
    return Promise.resolve(unlistenMock);
  }),
}));

const replies: Array<{ reqId: string; result: Record<string, unknown> }> = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: unknown) => {
    if (cmd === "start_control_bridge") return { socketPath: "/tmp/c.sock", token: "tok" };
    if (cmd === "control_mcp_paths") return { nodePath: "/node", serverPath: "/srv.js" };
    if (cmd === "control_respond") {
      replies.push(args as { reqId: string; result: Record<string, unknown> });
    }
    return undefined;
  },
}));

const { startControlListener, CONCIERGE_CALLER_AGENT_ID } = await import("../controlListener");

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

function fire(payload: Record<string, unknown>) {
  firedHandler?.({ payload });
}

async function call(domain: string, op: string, args: Record<string, unknown> = {}) {
  replies.length = 0;
  fire({
    reqId: `r-${op}`,
    op: "concierge_tool",
    callerAgentId: CONCIERGE_CALLER_AGENT_ID,
    payload: { domain, op, args, toolCallId: `tc-${op}` },
  });
  await flush();
  return replies[0]?.result;
}

describe("the concierge tool spine, end to end (nothing below the listener is mocked)", () => {
  beforeEach(async () => {
    replies.length = 0;
    // A booted app with AI enhancements live — the gate is a real precondition, asserted on its own
    // in aiGate.concierge.test.ts.
    useSettingsStore.setState({
      aiConcierge: true,
      conciergeToolPolicy: {},
      conciergeToolPolicyHydrated: true,
    });
    useAuthStore.setState({
      me: { clerkUserId: "u1", entitled: true, balanceCents: 5_000, tokenVersion: 1 },
      creditFloorCents: 0,
    } as never);
    useProjectStore.setState({
      projects: [
        { id: "p1", name: "web", rootPath: "/tmp/web", agents: [], selectedAgentId: null },
        { id: "p2", name: "api", rootPath: "/tmp/api", agents: [], selectedAgentId: null },
      ],
      selectedProjectId: "p1",
    } as never);
    await startControlListener();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("carries a real read all the way to a real store and back", async () => {
    const result = await call("workspace", "list_projects");
    // The reply shape the MCP server and the model both depend on.
    expect(result).toMatchObject({ ok: true, domain: "workspace", op: "list_projects" });
    // And it is the ACTUAL store contents, not a fixture — this is what proves the junction.
    const names = ((result?.data as Array<{ name: string }>) ?? []).map((p) => p.name).sort();
    expect(names).toEqual(["api", "web"]);
  });

  it("refuses an unknown op through the same path, without throwing", async () => {
    const result = await call("workspace", "definitely_not_an_op");
    expect(result).toMatchObject({ ok: false, code: "unknown-op" });
  });

  it("refuses an unknown DOMAIN the same way", async () => {
    const result = await call("not_a_domain", "list_projects");
    expect(result).toMatchObject({ ok: false, code: "unknown-op" });
  });

  it("validates arguments at the boundary rather than passing model input through", async () => {
    // `select_project` needs a projectId; a malformed call must be a typed refusal, not a crash
    // and not a silent no-op.
    const result = await call("workspace", "select_project", { projectId: 42 });
    expect(result?.ok).toBe(false);
    expect(String(result?.code)).toMatch(/bad-args|unknown-op/);
  });

  it("APPLIES the human's per-tool policy over this whole path", async () => {
    // The seam most likely to be silently disconnected: if the listener stops handing the policy
    // to the registry, every tool quietly becomes allowed and no other test notices.
    useSettingsStore.setState({
      conciergeToolPolicy: { list_projects: "deny" },
      conciergeToolPolicyHydrated: true,
    });
    const result = await call("workspace", "list_projects");
    expect(result).toMatchObject({ ok: false });
    expect(String(result?.code)).toMatch(/denied/);
  });

  it("refuses the whole surface when AI enhancements are off", async () => {
    useSettingsStore.setState({ aiConcierge: false });
    const result = await call("workspace", "list_projects");
    expect(result?.ok).toBe(false);
  });

  it("is reachable ONLY by the concierge — a build agent gets nothing", async () => {
    replies.length = 0;
    fire({
      reqId: "r-forbidden",
      op: "concierge_tool",
      callerAgentId: "e4a0cd29-525c-4ce7-8214-8e0411385b5e",
      payload: { domain: "workspace", op: "list_projects", args: {}, toolCallId: "tc-x" },
    });
    await flush();
    expect(replies[0]?.result).toMatchObject({ ok: false });
    // Refused for WHO it is, not for what it asked — the distinction the caller gate exists to make.
    expect(JSON.stringify(replies[0]?.result)).toMatch(/forbidden|only permitted/i);
  });
});
