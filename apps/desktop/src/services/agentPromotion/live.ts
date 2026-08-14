// The REAL IO behind promote.ts's injected seam: the live `awaitFirstFrame`, and the one place that
// wires every dep to its production implementation (`makePromoteDeps`). Kept out of promote.ts on
// purpose — the state machine's tests must never touch a socket, a Tauri command or the store, and
// the cheapest way to guarantee that is for the machine's module to import none of them.
//
// `awaitFirstFrame` is the definition of "the cloud side is live" (spec Decision 4): a
// CloudTransport is attached, `watch` is emitted, and the FIRST `agent_output` frame for that id
// resolves it. Two things bound the wait:
//
//   • a deadline, so a sandbox that never comes up doesn't hold the local agent hostage forever;
//   • a status poll, so a server-side `error` fails in seconds instead of waiting out the clock —
//     without it the commonest failure (the sandbox refused to start) would cost the user the full
//     two-minute timeout before telling them anything.

import { invoke } from "@tauri-apps/api/core";
import { ORCHESTRATION_URL, cloudApi, type CloudApi } from "../cloudAgents/api";
import { deleteCloudSession, getTransport, type AgentTransport } from "../agentTransport";
import { getRelaySocket } from "../relayClient";
import { useProjectStore } from "../../stores/projectStore";
import { WIP_COMMIT_MESSAGE } from "./plan";
import type { PromoteDeps } from "./promote";
import {
  promotionCommitDirty,
  promotionPreflight,
  promotionPushBranch,
  promotionReadTranscript,
} from "./rust";

/** How often the status poll runs — and the `watch` is re-emitted — while waiting. */
const POLL_INTERVAL_MS = 3_000;
/** A status read is a courtesy check, not the thing we're waiting on — keep it short. */
const POLL_TIMEOUT_MS = 8_000;

/**
 * Statuses that mean the session is definitively OVER.
 *
 * An EXPLICIT list, deliberately, rather than "not in `LIVE_CLOUD_STATUSES`". That set's documented
 * meaning is "still alive and worth RE-ATTACHING to", not "definitely dead", so its complement
 * includes every status this desktop build has never heard of. A runner that adds one natural
 * status to its pending→active spawn window (`queued`, `provisioning`) would otherwise turn every
 * promotion into a 3-second failure that DELETES a healthy sandbox — the exact inverse of this
 * module's own rule that an unreadable status keeps waiting. An uninterpretable status is a failure
 * to read, not a report of death.
 */
export const TERMINAL_CLOUD_STATUSES: ReadonlySet<string> = new Set(["complete", "error"]);

export interface AwaitFirstFrameOpts {
  sessionId: string;
  timeoutMs: number;
  /** Injectable for tests. Defaults to a CloudTransport over the desktop's relay socket. */
  transport?: Pick<AgentTransport, "spawn" | "onOutput">;
  /** Resolves the session's server-side status, or null when it can't be read. */
  pollStatus?: (id: string) => Promise<string | null>;
  /** Whether the desktop's relay socket exists. Without one, `watch` and `onOutput` BOTH no-op
   *  silently (see `CloudTransportOpts`) and the wait can only ever time out. */
  relayConnected?: () => boolean;
  pollIntervalMs?: number;
  /** Injectable timers so tests don't wall-clock. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

/**
 * Read a session's server-side status. Returns null when the answer is unknown (offline, 404, an
 * unparseable body) — deliberately NOT an error, because "I couldn't check" must not be mistaken
 * for "the session failed" and abort a promotion whose sandbox is merely still booting.
 */
export async function pollSessionStatus(id: string): Promise<string | null> {
  const token = await invoke<string | null>("desktop_bearer_token").catch(() => null);
  // AbortController + setTimeout rather than `AbortSignal.timeout`: the macOS 11 WKWebView floor
  // lacks the latter and would throw while BUILDING this init object, so the request would never be
  // sent (same hazard and same remedy as deleteCloudSession).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);
  try {
    const res = await fetch(`${ORCHESTRATION_URL}/sessions/${encodeURIComponent(id)}`, {
      method: "GET",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { session?: { status?: unknown } };
    const status = body?.session?.status;
    return typeof status === "string" ? status : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve when the cloud session is observed STREAMING; reject on a deadline or a server-side
 * failure. This is the gate the local PTY's life hangs on, so it rejects rather than resolving on
 * anything it cannot positively confirm.
 */
export function awaitFirstFrameLive(opts: AwaitFirstFrameOpts): Promise<void> {
  const transport = opts.transport ?? getTransport({ id: opts.sessionId, runtime: "cloud" });
  const poll = opts.pollStatus ?? pollSessionStatus;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const interval = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
  const relayConnected = opts.relayConnected ?? (() => getRelaySocket() !== null);

  // Fail FAST and honestly when there is no relay socket. `CloudTransport` no-ops both `watch` and
  // `onOutput` in that state and never retries the subscription, so the wait could only ever run
  // out the clock — and the caller reads a timeout as "the sandbox never came up" and DELETEs a
  // session that is perfectly healthy. This is reachable: `startRelayHost` is deferred to `onIdle`,
  // returns early with no socket when the bearer isn't resolvable at that moment, and its effect
  // has `[]` deps — so a user who signs in AFTER launch has a null socket for the rest of the run
  // while `startSession` (which reads the bearer fresh) succeeds.
  if (!relayConnected()) {
    return Promise.reject(
      new Error("this app isn't connected to the Sparkle relay, so the cloud session can't be watched"),
    );
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let unlisten: (() => void) | null = null;
    let deadline: unknown = null;
    let pollTimer: unknown = null;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      // Remove OUR listener only. Deliberately no `detach()`: that emits `unwatch` on the shared
      // relay socket, which would tear down the terminal's own stream the moment it attaches.
      unlisten?.();
      if (deadline !== null) clearTimer(deadline);
      if (pollTimer !== null) clearTimer(pollTimer);
      if (err) reject(err);
      else resolve();
    };

    unlisten = transport.onOutput(() => finish());

    deadline = setTimer(
      () => finish(new Error(`no output from the cloud session within ${opts.timeoutMs}ms`)),
      opts.timeoutMs,
    );

    // Attaching is IDEMPOTENT (`watch` is a bare emit), so it is retried on every tick rather than
    // fired once. `POST /sessions/start` returns the id and kicks the runner off fire-and-forget,
    // and the relay's `watch` handler installs nothing — with no retry — for a session the registry
    // doesn't have yet. Emitting once, in the same tick the start resolved, races that window and
    // loses silently.
    const attach = () => {
      void transport.spawn({ command: "", args: [] }).catch((e) => {
        finish(e instanceof Error ? e : new Error(String(e)));
      });
    };

    const tick = () => {
      if (settled) return;
      attach();
      void poll(opts.sessionId)
        .then((status) => {
          if (settled) return;
          // Only a status we positively recognize as TERMINAL fails early. `null` means "couldn't
          // read", an unrecognized string means "couldn't interpret", and a known live status
          // ("pending" while the sandbox boots) is the expected case — all three keep waiting.
          if (status && TERMINAL_CLOUD_STATUSES.has(status)) {
            finish(new Error(`the cloud session reported "${status}"`));
            return;
          }
          pollTimer = setTimer(tick, interval);
        })
        .catch(() => {
          if (!settled) pollTimer = setTimer(tick, interval);
        });
    };
    pollTimer = setTimer(tick, interval);

    // Attach LAST, after the listener is registered, so the session's first bytes cannot arrive
    // before anything is listening for them.
    attach();
  });
}

/**
 * Wire every {@link PromoteDeps} member to its production implementation. The confirm dialog calls
 * `promoteAgentToCloud(input, makePromoteDeps())`; nothing else should be assembling these by hand,
 * so there is one place where the real transport, the real store and the real commands meet.
 */
export function makePromoteDeps(
  overrides: Partial<PromoteDeps> = {},
  api: Pick<CloudApi, "startSession"> = cloudApi,
): PromoteDeps {
  return {
    preflight: (a) => promotionPreflight(a),
    commitDirty: (a) => promotionCommitDirty({ worktree: a.worktree, message: a.message }),
    pushBranch: (a) => promotionPushBranch(a),
    readTranscript: (a) => promotionReadTranscript({ worktree: a.worktree }),
    startSession: (i) => api.startSession(i),
    awaitFirstFrame: (a) => awaitFirstFrameLive(a),
    deleteSession: (id) => deleteCloudSession(id),
    // The LOCAL transport, explicitly: at this instant the tab still reads `runtime: "local"`, but
    // relying on that would make the cut depend on a field the very next step changes.
    killLocalPty: (agentId) => getTransport({ id: agentId, runtime: "local" }).kill("runtime-cutover"),
    setRuntimeCloud: ({ projectId, agentId }) =>
      useProjectStore.getState().setAgentRuntime(projectId, agentId, "cloud"),
    sendHandoff: ({ sessionId, text }) => {
      // Two writes, not one: the text and the submit ride separate frames so the sandbox PTY has
      // ingested the whole prompt before the carriage return arrives. A combined `text + "\r"` is
      // how a paste-then-submit loses its submit (bead sparkle-q1mxh, the local-PTY equivalent).
      const t = getTransport({ id: sessionId, runtime: "cloud" });
      t.write(text);
      t.write("\r");
    },
    ...overrides,
  };
}

/** Re-exported so callers that build the WIP message for display don't reach past this module. */
export { WIP_COMMIT_MESSAGE };
