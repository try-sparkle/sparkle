import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Mock the Tauri-backed trial API so we can exercise the REAL production singleton's install_id
// resolver (its __TAURI_INTERNALS__ guard + fetchTrial call) without a Tauri runtime. Hoisted, so
// it applies to the dynamic (re)imports of ./usageTelemetry in the singleton describe too.
vi.mock("./trialApi", () => ({ fetchTrial: vi.fn(), TRIAL_LIMIT: 100 }));
import { createUsageTelemetry, type UsageTelemetryDeps } from "./usageTelemetry";

const INSTALL_ID = "0123456789abcdef0123456789abcdef";

interface Captured {
  url: string;
  body: any;
}

/** A fetch stub that records every call and returns a configurable Response-like object. */
function makeFetch(
  respond: () => { ok: boolean; status: number } | Promise<{ ok: boolean; status: number }>,
) {
  const calls: Captured[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    const r = await respond();
    return { ok: r.ok, status: r.status } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function deps(overrides: Partial<UsageTelemetryDeps> = {}): UsageTelemetryDeps {
  let t = 1_000_000;
  return {
    fetch: makeFetch(() => ({ ok: true, status: 200 })).fetchImpl,
    getInstallId: async () => INSTALL_ID,
    baseUrl: "https://orch.test",
    now: () => (t += 1000), // advances 1s each read → non-zero durations
    randomUUID: () => "00000000-0000-0000-0000-000000000001",
    attempts: 2,
    delay: async () => {}, // no real timers in tests
    ...overrides,
  };
}

describe("createUsageTelemetry — payload shapes", () => {
  it("trackAppOpen posts an app_open event AND opens a session", async () => {
    const { fetchImpl, calls } = makeFetch(() => ({ ok: true, status: 200 }));
    const t = createUsageTelemetry(deps({ fetch: fetchImpl }));
    await t.trackAppOpen();

    const events = calls.find((c) => c.url.endsWith("/telemetry/events"));
    const sess = calls.find((c) => c.url.endsWith("/telemetry/session"));
    expect(events).toBeTruthy();
    expect(sess).toBeTruthy();
    expect(events!.body.install_id).toBe(INSTALL_ID);
    expect(events!.body.events[0].event).toBe("app_open");
    expect(events!.body.events[0].occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(sess!.body.install_id).toBe(INSTALL_ID);
    expect(sess!.body.session_id).toBe("00000000-0000-0000-0000-000000000001");
    expect(sess!.body.started_at).toBeTruthy();
    expect(sess!.body.ended_at).toBeUndefined();
  });

  it("trackSessionEnd closes the open session with a duration and emits session_end", async () => {
    const { fetchImpl, calls } = makeFetch(() => ({ ok: true, status: 200 }));
    const t = createUsageTelemetry(deps({ fetch: fetchImpl }));
    await t.trackAppOpen();
    calls.length = 0;
    await t.trackSessionEnd();

    const events = calls.find((c) => c.url.endsWith("/telemetry/events"));
    const sess = calls.find((c) => c.url.endsWith("/telemetry/session"));
    expect(events!.body.events[0].event).toBe("session_end");
    // same session id as the open call, and a positive duration
    expect(sess!.body.session_id).toBe("00000000-0000-0000-0000-000000000001");
    expect(sess!.body.ended_at).toBeTruthy();
    expect(sess!.body.duration_ms).toBeGreaterThan(0);
  });

  it("trackSessionEnd still records an end when no session was opened", async () => {
    const { fetchImpl, calls } = makeFetch(() => ({ ok: true, status: 200 }));
    const t = createUsageTelemetry(deps({ fetch: fetchImpl }));
    await t.trackSessionEnd();
    const sess = calls.find((c) => c.url.endsWith("/telemetry/session"));
    expect(sess).toBeTruthy();
    expect(sess!.body.ended_at).toBeTruthy();
    // No open session → no duration/started_at
    expect(sess!.body.duration_ms).toBeUndefined();
  });

  it("trackAgentSpawned posts agent_spawned with the kind property", async () => {
    const { fetchImpl, calls } = makeFetch(() => ({ ok: true, status: 200 }));
    const t = createUsageTelemetry(deps({ fetch: fetchImpl }));
    await t.trackAgentSpawned("worker");
    const events = calls.find((c) => c.url.endsWith("/telemetry/events"));
    expect(events!.body.events[0].event).toBe("agent_spawned");
    expect(events!.body.events[0].properties).toEqual({ kind: "worker" });
  });

  it("omits properties when no kind is supplied", async () => {
    const { fetchImpl, calls } = makeFetch(() => ({ ok: true, status: 200 }));
    const t = createUsageTelemetry(deps({ fetch: fetchImpl }));
    await t.trackAgentSpawned();
    const events = calls.find((c) => c.url.endsWith("/telemetry/events"));
    expect(events!.body.events[0].properties).toBeUndefined();
  });
});

describe("createUsageTelemetry — failure is always swallowed", () => {
  it("does not throw when fetch rejects (network error)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const t = createUsageTelemetry(deps({ fetch: fetchImpl as unknown as typeof fetch }));
    await expect(t.trackAppOpen()).resolves.toBeUndefined();
    await expect(t.trackSessionEnd()).resolves.toBeUndefined();
    await expect(t.trackAgentSpawned("worker")).resolves.toBeUndefined();
  });

  it("does not throw on a 5xx and retries up to `attempts`", async () => {
    const { fetchImpl, calls } = makeFetch(() => ({ ok: false, status: 503 }));
    const t = createUsageTelemetry(deps({ fetch: fetchImpl, attempts: 3 }));
    await expect(t.trackAgentSpawned()).resolves.toBeUndefined();
    // one /telemetry/events endpoint, retried 3× = 3 fetch calls
    expect(calls.length).toBe(3);
  });

  it("does NOT retry a 4xx (our bug, not transient)", async () => {
    const { fetchImpl, calls } = makeFetch(() => ({ ok: false, status: 400 }));
    const t = createUsageTelemetry(deps({ fetch: fetchImpl, attempts: 3 }));
    await t.trackAgentSpawned();
    expect(calls.length).toBe(1);
  });

  it("skips the POST entirely when install_id is unavailable", async () => {
    const { fetchImpl, calls } = makeFetch(() => ({ ok: true, status: 200 }));
    const t = createUsageTelemetry(deps({ fetch: fetchImpl, getInstallId: async () => null }));
    await t.trackAppOpen();
    await t.trackAgentSpawned("worker");
    expect(calls.length).toBe(0);
  });

  it("skips the POST when a getInstallId resolver throws", async () => {
    const { fetchImpl, calls } = makeFetch(() => ({ ok: true, status: 200 }));
    const t = createUsageTelemetry(
      deps({
        fetch: fetchImpl,
        getInstallId: async () => {
          throw new Error("tauri not ready");
        },
      }),
    );
    await expect(t.trackAppOpen()).resolves.toBeUndefined();
    expect(calls.length).toBe(0);
  });

  it("no-ops when the analytics gate is off", async () => {
    const { fetchImpl, calls } = makeFetch(() => ({ ok: true, status: 200 }));
    const t = createUsageTelemetry(deps({ fetch: fetchImpl, isEnabled: () => false }));
    await t.trackAppOpen();
    await t.trackSessionEnd();
    await t.trackAgentSpawned("worker");
    expect(calls.length).toBe(0);
  });

  it("resolves install_id at most once per launch (caches a successful resolution)", async () => {
    const { fetchImpl } = makeFetch(() => ({ ok: true, status: 200 }));
    const getInstallId = vi.fn(async () => INSTALL_ID);
    const t = createUsageTelemetry(deps({ fetch: fetchImpl, getInstallId }));
    await t.trackAppOpen();
    await t.trackAgentSpawned("worker");
    await t.trackSessionEnd();
    expect(getInstallId).toHaveBeenCalledTimes(1);
  });

  it("does NOT cache a transient null — retries resolution on the next call", async () => {
    const { fetchImpl, calls } = makeFetch(() => ({ ok: true, status: 200 }));
    const getInstallId = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce(null) // first attempt: not ready
      .mockResolvedValue(INSTALL_ID); // later: ready
    const t = createUsageTelemetry(deps({ fetch: fetchImpl, getInstallId }));
    await t.trackAgentSpawned("worker"); // dropped (null)
    expect(calls.length).toBe(0);
    await t.trackAgentSpawned("worker"); // resolves + posts
    expect(calls.length).toBe(1);
    expect(getInstallId).toHaveBeenCalledTimes(2);
  });

  it("swallows a synchronous throw from a dep (randomUUID) — never rejects", async () => {
    const { fetchImpl } = makeFetch(() => ({ ok: true, status: 200 }));
    const t = createUsageTelemetry(
      deps({
        fetch: fetchImpl,
        randomUUID: () => {
          throw new Error("crypto unavailable (insecure context)");
        },
      }),
    );
    await expect(t.trackAppOpen()).resolves.toBeUndefined();
    await expect(t.trackSessionEnd()).resolves.toBeUndefined();
  });
});

// Exercise the REAL production singleton's install_id resolver — the one piece of Tauri glue that
// the injected-deps tests above bypass. `vi.resetModules()` + a fresh dynamic import per test give
// each case its OWN singleton with an empty install_id cache, so these are order-independent (no
// reliance on which runs first, and safe to add a third).
describe("production singleton — Tauri guard (real getInstallId)", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("no-ops outside the Tauri webview: no fetchTrial IPC and no network call", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    vi.stubGlobal("window", undefined); // typeof window === 'undefined' → guard returns null
    const { fetchTrial } = await import("./trialApi");
    const { usageTelemetry } = await import("./usageTelemetry");
    await usageTelemetry.trackAgentSpawned("worker");
    expect(fetchTrial).not.toHaveBeenCalled();
    expect(f).not.toHaveBeenCalled();
  });

  it("inside the webview: resolves install_id via fetchTrial and posts it", async () => {
    const f = vi.fn(
      async (_input?: RequestInfo | URL, _init?: RequestInit) =>
        ({ ok: true, status: 200 }) as Response,
    );
    vi.stubGlobal("fetch", f);
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    const id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const { fetchTrial } = await import("./trialApi");
    vi.mocked(fetchTrial).mockResolvedValue({
      installId: id,
      started: false,
      promptsUsed: 0,
      remaining: null,
      cap: null,
      blocked: false,
      serverConfirmed: false,
    });
    const { usageTelemetry } = await import("./usageTelemetry");
    await usageTelemetry.trackAgentSpawned("worker");
    expect(fetchTrial).toHaveBeenCalled();
    expect(f).toHaveBeenCalledTimes(1);
    const body = JSON.parse((f.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.install_id).toBe(id);
    expect(body.events[0].event).toBe("agent_spawned");
  });
});
