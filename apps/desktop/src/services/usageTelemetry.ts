// Anonymous usage telemetry — the desktop half of the DESKTOP → BACKEND funnel (task #4).
// Fire-and-forget POSTs to the orchestration ingest (routes/telemetry.ts) keyed to the anonymous
// install_id from the Rust `trial_status` command. Feeds the /admin AARRR funnel.
//
// Contract (non-negotiable, every call site relies on it):
//   • NEVER throws into a caller — every path is wrapped and swallowed.
//   • NEVER blocks the UI — callers `void` these; the work is off the critical path.
//   • Best-effort with a small retry; a dropped event is acceptable (analytics, not billing).
//
// The base URL mirrors relayClient.ts (`VITE_ORCHESTRATION_URL` → fly.dev default). The install_id
// comes from trialApi.fetchTrial() (the same 32-hex token trial.rs mints). Testability: the real
// singleton is built from `createUsageTelemetry` with injectable fetch / install-id / clock / uuid
// so the unit test can assert payloads and prove failures are swallowed.

import { fetchTrial } from "./trialApi";

// Recognized events (open/extensible — the server accepts any string, these are the ones the
// funnel reads today).
export type UsageEventName = "app_open" | "session_end" | "agent_spawned" | (string & {});

interface EventPayloadItem {
  event: UsageEventName;
  properties?: Record<string, unknown>;
  occurred_at?: string;
}

export interface UsageTelemetryDeps {
  /** HTTP transport. Injected so tests can assert payloads and simulate failures. */
  fetch: typeof fetch;
  /** Resolve the anonymous install_id (32 hex). Returns null/empty ⇒ the call is skipped. */
  getInstallId: () => Promise<string | null>;
  /** Orchestration base URL, no trailing slash. */
  baseUrl: string;
  /** Wall-clock ms. Injected for deterministic occurred_at / duration in tests. */
  now: () => number;
  /** UUID minter for session ids. Injected so tests get a stable id. */
  randomUUID: () => string;
  /** Optional analytics-off gate. When it returns false, every call no-ops. */
  isEnabled?: () => boolean;
  /** Retry attempts per POST (default 2). */
  attempts?: number;
  /** Async delay between retries (default: a real 250ms timer; tests pass a no-op). */
  delay?: (ms: number) => Promise<void>;
}

export interface UsageTelemetry {
  /** App launch: emit 'app_open' AND open a session. Idempotent-ish — a second call opens a new
   *  session, so callers should invoke it once per launch. */
  trackAppOpen: () => Promise<void>;
  /** App quit/close: emit 'session_end' and close the open session with its duration. */
  trackSessionEnd: () => Promise<void>;
  /** An agent/worker tab was created. `kind` rides along in properties. */
  trackAgentSpawned: (kind?: string) => Promise<void>;
  /** Emit an arbitrary event (escape hatch; the three above cover the funnel). */
  emit: (event: UsageEventName, properties?: Record<string, unknown>) => Promise<void>;
}

const DEFAULT_BASE_URL =
  (import.meta.env?.VITE_ORCHESTRATION_URL as string | undefined) ??
  "http://localhost:3001";

const realDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Build a telemetry client over the given deps. Exported for testing; production uses the
 * `usageTelemetry` singleton below. Holds the current session (id + start time) in a closure —
 * one webview, one live session at a time.
 */
export function createUsageTelemetry(deps: UsageTelemetryDeps): UsageTelemetry {
  const attempts = deps.attempts ?? 2;
  const delay = deps.delay ?? realDelay;
  const enabled = () => (deps.isEnabled ? deps.isEnabled() : true);

  // The open session, or null when none is active.
  let session: { id: string; startedAtMs: number } | null = null;

  /** POST JSON best-effort. Returns true on a 2xx, false otherwise. NEVER throws. Retries on
   *  network errors and 5xx; a 4xx is our own bug and is not retried. */
  async function post(path: string, body: unknown): Promise<boolean> {
    const url = `${deps.baseUrl}${path}`;
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await deps.fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          // keepalive lets the request outlive a page teardown — the 'session_end' POST is fired
          // from beforeunload, where a normal fetch is cancelled mid-flight (and the retry below
          // can't run because the document is already unloading). keepalive is harmless elsewhere.
          // NOTE: the Fetch spec caps the COMBINED body size of all in-flight keepalive requests at
          // 64 KB — fine for these tiny payloads, but future `emit` callers must not attach large
          // `properties` blobs to the unload path or the webview may silently drop the request.
          keepalive: true,
        });
        if (res.ok) return true;
        // Client error (4xx) — retrying won't help; drop it.
        if (res.status >= 400 && res.status < 500) return false;
        // else fall through to retry (5xx)
      } catch {
        // Network/transport error — fall through to retry.
      }
      if (i < attempts - 1) {
        try {
          await delay(250);
        } catch {
          /* a broken delay must not break the swallow contract */
        }
      }
    }
    return false;
  }

  // install_id is stable for the life of an install, so resolve it at most once per launch and
  // cache it — avoids a repeated Tauri IPC round-trip on every emit, and lets the beforeunload
  // 'session_end' path read it without an IPC that can't finish during teardown. We cache the
  // in-flight PROMISE (not just the resolved value) so concurrent fire-and-forget callers share a
  // single resolution rather than each firing their own IPC. Only a SUCCESSFUL resolution sticks:
  // a transient null (trial command not ready yet) clears the cache so the next call retries.
  let idPromise: Promise<string | null> | null = null;

  /** Resolve install_id, guarding against a throwing/empty resolver. */
  async function installId(): Promise<string | null> {
    if (!idPromise) {
      idPromise = (async () => {
        try {
          const id = await deps.getInstallId();
          return id && id.length > 0 ? id : null;
        } catch {
          return null;
        }
      })();
    }
    const resolved = await idPromise;
    if (resolved === null) idPromise = null; // don't cache a transient null — retry next call
    return resolved;
  }

  async function sendEvents(items: EventPayloadItem[]): Promise<void> {
    if (!enabled()) return;
    const install_id = await installId();
    if (!install_id) return;
    await post("/telemetry/events", { install_id, events: items });
  }

  async function emit(
    event: UsageEventName,
    properties?: Record<string, unknown>,
  ): Promise<void> {
    const item: EventPayloadItem = { event, occurred_at: new Date(deps.now()).toISOString() };
    if (properties) item.properties = properties;
    await sendEvents([item]);
  }

  async function trackAppOpen(): Promise<void> {
    if (!enabled()) return;
    const install_id = await installId();
    if (!install_id) return;
    const startedAtMs = deps.now();
    const id = deps.randomUUID();
    session = { id, startedAtMs };
    const startedAtIso = new Date(startedAtMs).toISOString();
    // Emit the event and open the session; both best-effort, neither blocks the other's failure.
    await Promise.all([
      post("/telemetry/events", {
        install_id,
        events: [{ event: "app_open", occurred_at: startedAtIso }],
      }),
      post("/telemetry/session", {
        install_id,
        session_id: id,
        started_at: startedAtIso,
      }),
    ]);
  }

  async function trackSessionEnd(): Promise<void> {
    if (!enabled()) return;
    const install_id = await installId();
    if (!install_id) return;
    const endedAtMs = deps.now();
    const endedAtIso = new Date(endedAtMs).toISOString();
    const current = session;
    session = null;
    const body: Record<string, unknown> = {
      install_id,
      // Reuse the open session id when present; otherwise mint one so the end still records.
      session_id: current?.id ?? deps.randomUUID(),
      ended_at: endedAtIso,
    };
    if (current) {
      body.started_at = new Date(current.startedAtMs).toISOString();
      body.duration_ms = Math.max(0, endedAtMs - current.startedAtMs);
    }
    await Promise.all([
      post("/telemetry/events", {
        install_id,
        events: [{ event: "session_end", occurred_at: endedAtIso }],
      }),
      post("/telemetry/session", body),
    ]);
  }

  async function trackAgentSpawned(kind?: string): Promise<void> {
    await emit("agent_spawned", kind ? { kind } : undefined);
  }

  // Structurally guarantee the never-throw contract: even a synchronous throw from a dep
  // (`crypto.randomUUID()` in a non-secure context, `toISOString()` on a non-finite `now()`) is
  // swallowed here rather than surfacing as an unhandled rejection at the `void`-ed call sites.
  const safe =
    <A extends unknown[]>(fn: (...args: A) => Promise<void>) =>
    async (...args: A): Promise<void> => {
      try {
        await fn(...args);
      } catch {
        /* swallow — telemetry must never throw into a caller */
      }
    };

  return {
    trackAppOpen: safe(trackAppOpen),
    trackSessionEnd: safe(trackSessionEnd),
    trackAgentSpawned: safe(trackAgentSpawned),
    emit: safe(emit),
  };
}

// Production singleton. install_id comes from the Rust trial meter; base URL from env/default.
//
// `isEnabled` is intentionally NOT wired: there is no user-facing analytics/telemetry opt-out
// setting today (the PostHog `initAnalytics()` in main.tsx is likewise always-on, no-op'ing only
// when unconfigured). This stream is anonymous (install_id only, no account) and always-on. If a
// telemetry opt-out toggle is ever added, pass `isEnabled: () => <opt-in state>` here, sourced
// from the same setting `initAnalytics` would respect — the gate is already implemented + tested.
export const usageTelemetry: UsageTelemetry = createUsageTelemetry({
  fetch: (...args) => fetch(...args),
  getInstallId: async () => {
    // Only resolve the install_id inside the real Tauri webview. Outside it (plain-browser
    // dev/preview, and every unit test — which mocks `invoke` but never sets this global) there is
    // no trial command, so we skip WITHOUT calling `invoke` — that keeps telemetry from consuming
    // the shared invoke mock and polluting invoke-sequence assertions in unrelated store tests.
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return null;
    try {
      const t = await fetchTrial();
      return t.installId || null;
    } catch {
      return null;
    }
  },
  baseUrl: DEFAULT_BASE_URL,
  now: () => Date.now(),
  randomUUID: () => crypto.randomUUID(),
});
