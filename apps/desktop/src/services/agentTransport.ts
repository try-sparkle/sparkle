// AgentTransport seam for Sparkle Cloud Agents (Service B, W4).
//
// The terminal UI already speaks a tiny verb set — spawn / write / resize / kill / onOutput /
// onExit — historically bound directly to the LOCAL PTY host (pty.ts). This module extracts that
// verb set into an `AgentTransport` interface selected by `agent.runtime`, so a "cloud" agent
// (running Claude Code inside a Sparkle-provisioned E2B sandbox, streamed over the relay) is
// indistinguishable to Terminal.tsx from a "local" agent (a `claude` PTY on the Mac).
//
//   - LocalTransport: a thin wrapper over pty.ts. ZERO behavior change for local agents — every
//     verb delegates to the exact same Tauri call it did before, including the backpressure
//     extensions (ack / setPaused) that only the local PTY has.
//   - CloudTransport: a Socket.IO consumer of the relay the desktop already maintains
//     (services/relayClient.ts). `spawn` is a no-op ATTACH (the session already runs server-side)
//     that emits `watch` for the agent id (the server replays ring-buffer backfill, then live
//     frames); `write` sends remote input; `onOutput` subscribes to `agent_output` frames for that
//     id; `onExit` maps the `cloud_exit` event; `kill` ends the server session via the
//     orchestration REST `DELETE /sessions/:id`. Event names match
//     apps/orchestration/src/socket/events.ts + the cloud-agents plan's `cloud_status`/`cloud_exit`.
//
// Contract (pinned in docs/superpowers/plans/2026-07-22-cloud-agents.md): the 6 core verbs below.
// `ack`/`setPaused` are OPTIONAL local-only flow-control extensions beyond the pinned 6 — a cloud
// transport omits them (the server owns its sandbox PTY's backpressure), and Terminal.tsx calls
// them defensively (`transport.ack?.(…)`), so a cloud agent never touches local-PTY flow control.

import { invoke } from "@tauri-apps/api/core";
import type { AgentTab } from "../types";
import {
  spawnPty,
  writePty,
  resizePty,
  killPty,
  setPtyPaused,
  ptyAck,
  onPtyOutput,
  onPtyExit,
  ignorePtyGone,
} from "../pty";
import { getRelaySocket } from "./relayClient";

/** A chunk of terminal output delivered to a transport subscriber. `bytes` is the authoritative
 *  UTF-8 byte length used for LOCAL PTY ack accounting (echoed back via `ack`); cloud frames set it
 *  to the JS string length — informational only, since cloud transports don't ack. */
export interface TransportOutput {
  chunk: string;
  bytes: number;
}

/** Session/PTY exit. `exitCode` is undefined for local PTYs (pty.rs emits no code) and carries the
 *  server-reported code for cloud sessions (the `cloud_exit` event). */
export interface TransportExit {
  exitCode?: number;
}

/** What to run. LocalTransport spawns a PTY with this; CloudTransport IGNORES it (the session is
 *  already running server-side — spawn is a no-op attach), so command/args/cwd are local-only. */
export interface TransportSpawn {
  command: string;
  args: string[];
  cwd?: string;
  cols?: number;
  rows?: number;
}

/**
 * The transport a Terminal drives. Bound to ONE agent id (see getTransport), so no method takes an
 * id. `onOutput`/`onExit` return a synchronous unlisten (they may register an async listener under
 * the hood; the returned fn is safe to call before that resolves).
 */
export interface AgentTransport {
  /** Start the agent. Local: spawn a PTY. Cloud: attach to the already-running server session. */
  spawn(cmd: TransportSpawn): Promise<void>;
  /** Send input (a keystroke, a pasted prompt, a menu answer). Fire-and-forget. */
  write(data: string): void;
  /** Tell the agent its terminal is now cols×rows. Cloud is a client-side-only reflow (no-op wire). */
  resize(cols: number, rows: number): void;
  /** End the agent. Local: kill the PTY. Cloud: DELETE the server session (terminates it). */
  kill(): Promise<void>;
  /**
   * Release THIS CLIENT's hold without terminating the agent. Local: same as kill (a local PTY has
   * no life beyond its pane). Cloud: unwatch only — the server session keeps running, which is the
   * entire premise of cloud agents. The terminal's unmount cleanup MUST use this, never kill():
   * unmount happens on tab close, StrictMode double-mount, and "Start again", none of which mean
   * "destroy the sandbox" (roborev 46244).
   */
  detach(): Promise<void>;
  /** Subscribe to output. Returns an unlisten. */
  onOutput(cb: (e: TransportOutput) => void): () => void;
  /** Subscribe to exit. Returns an unlisten. */
  onExit(cb: (e: TransportExit) => void): () => void;
  /** LOCAL-ONLY: return IPC credit once xterm has parsed `bytes` (producer backpressure). */
  ack?(bytes: number): void;
  /** LOCAL-ONLY: pause/resume the PTY reader across the xterm parse-backlog watermarks. */
  setPaused?(paused: boolean): void;
}

// ── LocalTransport ──────────────────────────────────────────────────────────────────────────────

/**
 * The today-path: every verb is the same pty.ts call the terminal made before this seam existed, so
 * local agents see ZERO behavior change. The one structural shift is that `onOutput`/`onExit` return
 * a SYNC unlisten while pty.ts's listen is async: we kick off the async `listen(...)` immediately,
 * stash a readiness promise, and have `spawn` await it — preserving the pre-refactor guarantee that
 * the output listener is registered BEFORE the PTY spawns (so no early output is dropped).
 */
export class LocalTransport implements AgentTransport {
  /** Listener-registration promises `spawn` awaits, so listen-before-spawn ordering is preserved. */
  private readonly ready: Array<Promise<void>> = [];
  /** Serializes pause/resume so Rust sees them in issue order — a `false` can't overtake an earlier
   *  `true` and park the reader forever (the roborev nit on , kept here where it belongs). */
  private pauseChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly id: string) {}

  onOutput(cb: (e: TransportOutput) => void): () => void {
    let un: (() => void) | null = null;
    let cancelled = false;
    const p = onPtyOutput(this.id, (e) => cb({ chunk: e.chunk, bytes: e.bytes })).then((u) => {
      // Unlistened before the subscribe resolved — tear the just-registered listener straight down.
      if (cancelled) u();
      else un = u;
    });
    this.ready.push(p.catch(() => {}));
    return () => {
      cancelled = true;
      un?.();
      un = null;
    };
  }

  onExit(cb: (e: TransportExit) => void): () => void {
    let un: (() => void) | null = null;
    let cancelled = false;
    // pty:exit is a GLOBAL channel (fires for every agent), so filter to this transport's id here —
    // Terminal used to do this check itself; the transport now owns it.
    const p = onPtyExit((e) => {
      if (e.id === this.id) cb({});
    }).then((u) => {
      if (cancelled) u();
      else un = u;
    });
    this.ready.push(p.catch(() => {}));
    return () => {
      cancelled = true;
      un?.();
      un = null;
    };
  }

  async spawn(cmd: TransportSpawn): Promise<void> {
    // Ensure any pending output/exit listeners are registered before the PTY starts, so its first
    // bytes can't race ahead of the subscription (the pre-seam `await onPtyOutput` then `spawnPty`).
    // Drain (splice) rather than re-read so a later re-spawn doesn't re-await already-settled ones.
    await Promise.all(this.ready.splice(0));
    await spawnPty({
      id: this.id,
      command: cmd.command,
      args: cmd.args,
      cwd: cmd.cwd,
      cols: cmd.cols,
      rows: cmd.rows,
    });
  }

  write(data: string): void {
    // writePty already swallows the "no such pty" teardown race internally; the extra catch mirrors
    // the terminal's prior `.catch(ignorePtyGone)` for any other (logged) failure.
    void writePty(this.id, data).catch(ignorePtyGone);
  }

  resize(cols: number, rows: number): void {
    void resizePty(this.id, cols, rows).catch(ignorePtyGone);
  }

  kill(): Promise<void> {
    return killPty(this.id).catch(ignorePtyGone);
  }

  detach(): Promise<void> {
    // A local PTY has no life beyond its pane — detaching IS killing it (pre-seam behavior).
    return this.kill();
  }

  ack(bytes: number): void {
    void ptyAck(this.id, bytes).catch(ignorePtyGone);
  }

  setPaused(paused: boolean): void {
    this.pauseChain = this.pauseChain.then(() => setPtyPaused(this.id, paused)).catch(ignorePtyGone);
  }
}

// ── CloudTransport ──────────────────────────────────────────────────────────────────────────────

/** The minimal slice of a Socket.IO client CloudTransport needs — so it can be exercised against a
 *  fake socket in tests without a live relay. */
export interface RelaySocketLike {
  emit(event: string, payload: unknown): void;
  on(event: string, cb: (payload: unknown) => void): void;
  off(event: string, cb: (payload: unknown) => void): void;
}

export interface CloudTransportOpts {
  /** The live relay socket, or null when the desktop relay host isn't connected yet. Read lazily on
   *  each op. Per-call ops (write, kill, spawn's `watch` emit) DO pick up a socket that connects
   *  later; but onOutput/onExit bind their handler at subscribe time — if the socket is null then,
   *  that subscription silently no-ops and is NOT retried. Connection-readiness / re-attach is W5's
   *  scope; in practice the relay host is already up before a cloud terminal mounts. */
  getSocket: () => RelaySocketLike | null;
  /** Ends the server-side session. Defaults to `DELETE /sessions/:id`; injectable for tests. */
  killSession?: (id: string) => Promise<void>;
}

const ORCHESTRATION_URL =
  (import.meta.env?.VITE_ORCHESTRATION_URL as string | undefined) ??
  "http://localhost:3001";

/** How long a terminate DELETE may take before we give up on it. The close path awaits this call,
 *  and a captive portal / black-holed connection would otherwise hang the tab teardown until the
 *  platform's TCP timeout — so the request carries its own deadline (roborev 46881). */
const DELETE_TIMEOUT_MS = 8_000;

/**
 * Default cloud kill: end the server session over the orchestration REST API, authed with the
 * desktop bearer. Exported as the ONE terminate call — `cloudAgents/terminate.ts` wraps it for the
 * deliberate close gestures (which have no live transport to go through, since the pane is already
 * unmounted), and `CloudTransport.kill()` uses it after emitting `unwatch`.
 */
export async function deleteCloudSession(id: string): Promise<void> {
  const token = await invoke<string | null>("desktop_bearer_token").catch(() => null);
  // AbortController + setTimeout, NOT `AbortSignal.timeout` — the macOS 11 WKWebView floor
  // (tauri.conf.json `minimumSystemVersion`) lacks it, and there it would throw while BUILDING this
  // init object, so the DELETE would never be sent and the swallowed rejection would hide it. Same
  // hazard, same remedy as services/chief.ts (roborev 46918).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELETE_TIMEOUT_MS);
  try {
    const res = await fetch(`${ORCHESTRATION_URL}/sessions/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`DELETE /sessions/${id} failed: ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A cloud agent's terminal, streamed over the relay. The session runs server-side, so `spawn` never
 * touches a local PTY — it emits `watch` and the server replays backfill then live `agent_output`
 * frames. Input rides `agent_input`; exit maps `cloud_exit`; `kill` ends the session via REST.
 * Resize is client-side only in v1 (the server PTY runs at a fixed size; xterm reflows locally).
 */
export class CloudTransport implements AgentTransport {
  constructor(
    private readonly id: string,
    private readonly opts: CloudTransportOpts,
  ) {}

  async spawn(_cmd: TransportSpawn): Promise<void> {
    // No local process to start — the session already runs server-side. Attach: ask the relay to
    // stream this agent. The server serves it (ring-buffer backfill, then live agent_output frames).
    this.opts.getSocket()?.emit("watch", { agent_id: this.id });
  }

  write(data: string): void {
    this.opts.getSocket()?.emit("agent_input", { agent_id: this.id, text: data });
  }

  resize(_cols: number, _rows: number): void {
    // v1: the cloud PTY runs at a fixed server-side size and xterm reflows locally — no wire message.
  }

  async kill(): Promise<void> {
    // Stop streaming first, then end the session server-side.
    this.opts.getSocket()?.emit("unwatch", { agent_id: this.id });
    await (this.opts.killSession ?? deleteCloudSession)(this.id);
  }

  async detach(): Promise<void> {
    // Unwatch ONLY — the server session survives the pane (laptop close, tab close, remount).
    this.opts.getSocket()?.emit("unwatch", { agent_id: this.id });
  }

  onOutput(cb: (e: TransportOutput) => void): () => void {
    return this.subscribe("agent_output", (p) => {
      const o = p as { agent_id?: string; chunk?: string };
      if (!o || o.agent_id !== this.id || typeof o.chunk !== "string") return;
      cb({ chunk: o.chunk, bytes: o.chunk.length });
    });
  }

  onExit(cb: (e: TransportExit) => void): () => void {
    return this.subscribe("cloud_exit", (p) => {
      const e = p as { agent_id?: string; exit_code?: number };
      if (!e || e.agent_id !== this.id) return;
      cb({ exitCode: e.exit_code });
    });
  }

  private subscribe(event: string, fn: (p: unknown) => void): () => void {
    // Capture the instance we subscribed ON: if the relay socket is replaced/stopped before the
    // unlisten runs, `getSocket()` at teardown would return null (or a different socket) and the
    // handler would leak on the old instance (roborev 46244).
    const socket = this.opts.getSocket();
    socket?.on(event, fn);
    return () => socket?.off(event, fn);
  }
}

// ── Selection ───────────────────────────────────────────────────────────────────────────────────

/** The fields getTransport reads. A full AgentTab satisfies this structurally; Terminal (which
 *  holds only the id + runtime) can also call it directly. */
export type AgentTransportTarget = Pick<AgentTab, "id" | "runtime">;

/**
 * Select the transport for an agent by its runtime. "cloud" → CloudTransport over the desktop's
 * relay socket; anything else (the "local" default) → LocalTransport over pty.ts. A fresh instance
 * per call — a transport is bound to one agent for one terminal lifetime.
 */
export function getTransport(agent: AgentTransportTarget): AgentTransport {
  if (agent.runtime === "cloud") {
    return new CloudTransport(agent.id, { getSocket: getRelaySocket });
  }
  return new LocalTransport(agent.id);
}
