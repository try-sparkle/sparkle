// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// `makePromoteDeps` is where the state machine meets the real transport, the real store and the
// real commands, and two of its lines are load-bearing SAFETY decisions that nothing else guards:
// the kill's hardcoded `runtime: "local"`, and the two-write handoff. Both would pass every other
// test in this directory if they were wrong, which is exactly why they get a file of their own.

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("../relayClient", () => ({ getRelaySocket: () => ({ emit() {}, on() {}, off() {} }) }));

const transports: Array<{ id: string; runtime: string; writes: string[]; killed: boolean }> = [];
vi.mock("../agentTransport", () => ({
  deleteCloudSession: vi.fn(),
  getTransport: (a: { id: string; runtime: string }) => {
    const rec = { ...a, writes: [] as string[], killed: false };
    transports.push(rec);
    return {
      spawn: async () => {},
      write: (d: string) => rec.writes.push(d),
      resize: () => {},
      kill: async () => {
        rec.killed = true;
      },
      detach: async () => {},
      onOutput: () => () => {},
      onExit: () => () => {},
    };
  },
}));

import { makePromoteDeps, pollSessionStatus } from "./live";
import { useProjectStore } from "../../stores/projectStore";

beforeEach(() => {
  transports.length = 0;
  invoke.mockReset().mockResolvedValue("tok");
});

describe("makePromoteDeps — killLocalPty", () => {
  it("cuts the LOCAL transport, explicitly, never the tab's own runtime", () => {
    // If this ever read the tab instead, `getTransport(...).kill()` on a cloud tab emits `unwatch`
    // and DELETE /sessions/:id — THE CUT would terminate the very cloud session it just verified
    // live, and the promotion would still report ok: true.
    void makePromoteDeps().killLocalPty("agent-1");
    expect(transports).toHaveLength(1);
    expect(transports[0]).toMatchObject({ id: "agent-1", runtime: "local" });
    expect(transports[0]!.killed).toBe(true);
  });
});

describe("makePromoteDeps — sendHandoff", () => {
  it("writes the text and the carriage return as SEPARATE frames, CR last", () => {
    // A combined `text + "\r"` is how a paste-then-submit loses its submit: the PTY has not ingested
    // the whole prompt when the CR arrives. Collapsing this would pass every other test here.
    makePromoteDeps().sendHandoff({ sessionId: "sess-1", text: "pick up where you left off" });
    expect(transports).toHaveLength(1);
    expect(transports[0]).toMatchObject({ id: "sess-1", runtime: "cloud" });
    expect(transports[0]!.writes).toEqual(["pick up where you left off", "\r"]);
  });
});

describe("makePromoteDeps — setRuntimeCloud", () => {
  it("flips the real store's tab to cloud", () => {
    useProjectStore.setState({ projects: [], selectedProjectId: null });
    const pid = useProjectStore.getState().addProject("Demo", "/tmp/demo");
    const id = useProjectStore.getState().addAgent(pid, { kind: "build" })!;
    makePromoteDeps().setRuntimeCloud({ projectId: pid, agentId: id });
    expect(
      useProjectStore.getState().projects[0]!.agents.find((a) => a.id === id)!.runtime,
    ).toBe("cloud");
  });
});

describe("makePromoteDeps — startSession", () => {
  it("forwards the promotion payload to the injected api unchanged", async () => {
    const startSession = vi.fn().mockResolvedValue({ sessionId: "s1" });
    const deps = makePromoteDeps({}, { startSession });
    await deps.startSession({
      projectId: "p",
      goal: "g",
      repoUrl: "https://example.test/r",
      promotion: { sessionId: "s1", branch: "b" },
    });
    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({ promotion: { sessionId: "s1", branch: "b" } }),
    );
  });

  it("lets a caller override any single dep", async () => {
    const kill = vi.fn().mockResolvedValue(undefined);
    await makePromoteDeps({ killLocalPty: kill }).killLocalPty("a");
    expect(kill).toHaveBeenCalledWith("a");
    expect(transports).toHaveLength(0);
  });
});

describe("pollSessionStatus", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function stubFetch(impl: (url: string, init?: RequestInit) => Response) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Promise.resolve(impl(String(url), init));
    }) as typeof fetch;
    return calls;
  }

  it("reads the status out of the { session: { status } } body", async () => {
    // The wire shape is GET /sessions/:id → { session, events }. A drift here silently disables the
    // fast-fail path (status always null → degrade to the full timeout) with nothing noticing.
    const calls = stubFetch(() => new Response(JSON.stringify({ session: { status: "active" } })));
    expect(await pollSessionStatus("sess-1")).toBe("active");
    expect(calls[0]!.url).toMatch(/\/sessions\/sess-1$/);
    expect(calls[0]!.init?.method).toBe("GET");
  });

  it("sends the desktop bearer when there is one", async () => {
    const calls = stubFetch(() => new Response(JSON.stringify({ session: { status: "active" } })));
    await pollSessionStatus("sess-1");
    expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("percent-encodes the id rather than splicing it into the path", async () => {
    const calls = stubFetch(() => new Response(JSON.stringify({ session: { status: "active" } })));
    await pollSessionStatus("a/b?c");
    expect(calls[0]!.url).toContain("a%2Fb%3Fc");
  });

  it("is null — never a throw — for every unreadable answer", async () => {
    // Null means "I couldn't check", which awaitFirstFrameLive treats as keep-waiting. Throwing or
    // inventing a status here would turn a transient read failure into a deleted sandbox.
    stubFetch(() => new Response("{}", { status: 500 }));
    expect(await pollSessionStatus("s")).toBeNull();

    stubFetch(() => new Response("not json"));
    expect(await pollSessionStatus("s")).toBeNull();

    stubFetch(() => new Response(JSON.stringify({ session: { status: 42 } })));
    expect(await pollSessionStatus("s")).toBeNull();

    stubFetch(() => new Response(JSON.stringify({ session: {} })));
    expect(await pollSessionStatus("s")).toBeNull();

    stubFetch(() => new Response(JSON.stringify({})));
    expect(await pollSessionStatus("s")).toBeNull();

    globalThis.fetch = (() => Promise.reject(new Error("offline"))) as typeof fetch;
    expect(await pollSessionStatus("s")).toBeNull();
  });

  it("still asks when the bearer can't be resolved", async () => {
    invoke.mockRejectedValue(new Error("no keyring"));
    const calls = stubFetch(() => new Response(JSON.stringify({ session: { status: "active" } })));
    expect(await pollSessionStatus("s")).toBe("active");
    expect(calls[0]!.init?.headers).toEqual({});
  });
});
