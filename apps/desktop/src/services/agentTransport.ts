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
import { safeUnlisten } from "./safeUnlisten";
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
/** "No PTY was ever bound." The epoch pty.rs reserves and never mints (`next_pty_epoch` starts at 1),
 *  so it is safe to settle a spawn's waiters with it: they wake, compare, and match nothing. That
 *  matters because leaving them unsettled is not neutral — it is an exit path that hangs forever. */
const NO_EPOCH = 0;

export class LocalTransport implements AgentTransport {
  /** The agent id this transport is bound to — the id every pty.ts verb and both global event
   *  channels are keyed by. */
  private readonly id: string;
  /** Listener-registration promises `spawn` awaits, so listen-before-spawn ordering is preserved. */
  private readonly ready: Array<Promise<void>> = [];
  /** Serializes pause/resume so Rust sees them in issue order — a `false` can't overtake an earlier
   *  `true` and park the reader forever (the roborev nit on , kept here where it belongs). */
  private pauseChain: Promise<unknown> = Promise.resolve();

  /**
   * THE EPOCH OF THE PTY THIS TRANSPORT OWNS — `null` until its own `spawn` resolves.
   *
   * A transport instance is created per Terminal binding (`getTransport` returns a fresh one per
   * call), so this is what makes "my PTY exited" answerable at all. `pty:exit` is a global channel
   * carrying only the AGENT id, and that id is identical across a restart, so the id filter alone
   * cannot separate two consecutive lives of one agent.
   *
   * WHAT THAT COST, CONCRETELY. Tearing a binding down kills its PTY (`detach()` IS kill for a local
   * transport) but the exit event arrives whenever the child actually finishes dying — routinely
   * after the replacement binding has already subscribed. The replacement then read its
   * predecessor's death as its own and painted "Agent exited — Start again" over an agent that had
   * just been successfully revived, where it stayed until the resumed `claude` emitted a byte: a
   * `--resume` transcript redraw takes seconds, and a resumed agent waiting on input may emit
   * nothing for minutes. A revived agent displaying its own death notice, with no retraction path.
   * `Terminal.tsx` carried this as a known-open defect and named this fix by name.
   */
  private epoch: number | null = null;
  /** Resolves with the epoch once `spawn` succeeds, so an exit that races ahead of the spawn's own
   *  resolution is JUDGED rather than dropped — a PTY that dies instantly is a real death and must
   *  still surface. Never resolves when the binding is torn down before spawning, which is correct:
   *  a transport with no PTY has no death to report. */
  private epochKnown!: Promise<number>;
  private markSpawned!: (epoch: number) => void;

  /** Has ANY spawn attempt begun on this instance? Distinct from `epoch !== null`, which only says a
   *  spawn SUCCEEDED — a failed attempt has still consumed its `epochKnown`, so the next one must
   *  re-arm or it would publish into an already-settled promise and never reach its waiters. */
  private spawnStarted = false;

  /**
   * OBSERVER MODE — this transport watches an agent whose PTY someone ELSE spawns, and this is the
   * FLOOR that separates the life it is waiting for from the life being replaced.
   *
   * The epoch filter above answers "is this MY PTY's death", and can only answer it for a transport
   * that spawned. A pure observer never calls `spawn`, so its epoch stays `null` forever and every
   * exit sits deferred on a promise nothing resolves — its exit path not merely unattributable but
   * permanently INERT. `awaitLocalFirstFrame` (agentDemotion/live.ts) is that consumer, and failing
   * fast on the PTY's death is its whole reason to watch: inert, it runs out a 60s deadline and
   * blames the timeout while a billing sandbox stays open.
   *
   * But plain id-only semantics are wrong in the other direction, and dangerously so. The waiter
   * subscribes BEFORE the spawn it is waiting on, and that spawn is a restart — its first act is to
   * tear the existing PTY down. The predecessor's exit "arrives whenever the child actually finishes
   * dying", routinely after we subscribed, so an unfiltered observer rejects on the death of the PTY
   * its own spawn just killed, kills the healthy replacement, and reports demotion as failed. That is
   * the original misreading relocated into the waiter.
   *
   * The floor closes both: sample the epoch that is live BEFORE triggering the spawn, then accept
   * only exits ABOVE it. Epochs strictly increase, so "above the floor" is exactly "a life that
   * began after I started watching" — the one we are waiting for. Sampling happens in the
   * constructor, which is the earliest moment available and, for the demotion gate, before the
   * spawn step runs.
   */
  private readonly exitFloor: Promise<number> | null;

  constructor(id: string, opts: { observeExitsAfter?: () => Promise<number> } = {}) {
    this.id = id;
    // Fail OPEN, to the pre-floor id-only behavior. The query is an in-memory map read that can
    // realistically only fail during teardown, and the two failure directions are not symmetric: a
    // floor of `Infinity` would resurrect the inert exit path this mode exists to remove, whereas a
    // floor of 0 degrades to the semantics this consumer had before the epoch existed at all.
    this.exitFloor = opts.observeExitsAfter ? opts.observeExitsAfter().catch(() => 0) : null;
    this.armEpoch();
  }

  /** Fresh, unresolved `epochKnown` for the NEXT life, and the resolver that settles it. Called once
   *  at construction and again at the head of every spawn after the first, so a spawn can never
   *  publish into the promise a PREVIOUS life's waiters are holding. */
  private armEpoch(): void {
    this.epochKnown = new Promise<number>((resolve) => {
      this.markSpawned = resolve;
    });
  }

  onOutput(cb: (e: TransportOutput) => void): () => void {
    let un: (() => void) | null = null;
    let cancelled = false;
    const p = onPtyOutput(this.id, (e) => cb({ chunk: e.chunk, bytes: e.bytes })).then((u) => {
      // Unlistened before the subscribe resolved — tear the just-registered listener straight down.
      // Through safeUnlisten: Tauri's unlisten is async, so a raw `u()` here returns a REJECTED
      // promise (not a throw) when the listeners map is already torn down, and it floats free as an
      // app-level unhandled rejection (sparkle-6csa). safeUnlisten awaits+swallows that race.
      if (cancelled) void safeUnlisten(u);
      else un = u;
    });
    this.ready.push(p.catch(() => {}));
    return () => {
      cancelled = true;
      void safeUnlisten(un);
      un = null;
    };
  }

  onExit(cb: (e: TransportExit) => void): () => void {
    let un: (() => void) | null = null;
    let cancelled = false;
    // pty:exit is a GLOBAL channel (fires for every agent), so filter to this transport's id here —
    // Terminal used to do this check itself; the transport now owns it.
    //
    // AND FILTER ON THE EPOCH, NOT JUST THE ID. The id is the agent id and survives a restart, so an
    // id-only filter forwards the PREDECESSOR's death to the successor's terminal — see the `epoch`
    // field above for what that paints on a revived agent. An exit whose epoch is not ours is not
    // our death and is dropped silently: some other binding owns it, or owned it.
    const p = onPtyExit((e) => {
      if (e.id !== this.id) return;
      // An OBSERVER owns no PTY of its own, so it is judged against the FLOOR it sampled before the
      // spawn it is waiting on — see `exitFloor`. Judging it by `epoch` instead would make its exit
      // path permanently inert; judging it by the id alone would let it accept the death of the PTY
      // that spawn is replacing.
      if (this.exitFloor) {
        void this.exitFloor.then((floor) => {
          if (!cancelled && e.epoch > floor) cb({});
        });
        return;
      }
      if (this.epoch !== null) {
        if (e.epoch === this.epoch) cb({});
        return;
      }
      // Our spawn has not resolved yet, so we cannot judge this exit — but it may still be OURS (a
      // PTY that dies immediately can beat its own spawn's round-trip back to us). Defer the
      // comparison instead of guessing; `cancelled` is re-checked because the unlisten may land
      // while we wait, and a torn-down subscriber must not be called back.
      void this.epochKnown.then((epoch) => {
        if (!cancelled && e.epoch === epoch) cb({});
      });
    }).then((u) => {
      // Same teardown-race guard as onOutput (sparkle-6csa): route the inner unlisten through
      // safeUnlisten so a late-resolving listen's raw unlisten can't leak an unhandled rejection.
      if (cancelled) void safeUnlisten(u);
      else un = u;
    });
    this.ready.push(p.catch(() => {}));
    return () => {
      cancelled = true;
      void safeUnlisten(un);
      un = null;
    };
  }

  async spawn(cmd: TransportSpawn): Promise<void> {
    // Ensure any pending output/exit listeners are registered before the PTY starts, so its first
    // bytes can't race ahead of the subscription (the pre-seam `await onPtyOutput` then `spawnPty`).
    // A RE-SPAWN starts a new life, so forget the old one SYNCHRONOUSLY — before the first `await`,
    // not after it. The window in which a stale epoch can be matched opens the instant the caller
    // calls `spawn`, so a reset placed after any await leaves the predecessor's late exit matching
    // the epoch of the life we are replacing and reported as this one's death — the whole defect,
    // reintroduced one instance down. (Pinned by "a re-spawn on the SAME transport…"; moving this
    // below the await turns that test red.)
    //
    // Only after the FIRST attempt: on the first spawn `epochKnown` may already carry deferred
    // waiters (an exit that beat the spawn back to us), and re-arming would strand them on a promise
    // nothing ever resolves. Keyed on "an attempt has STARTED", not on "a spawn succeeded" — a
    // failed attempt has still consumed its resolver, so the next one needs a fresh promise.
    if (this.spawnStarted) this.armEpoch();
    this.spawnStarted = true;
    // The life we owned going in. A spawn that FAILS must put it back (see the catch): the PTY we
    // were replacing is only replaced if the replacement actually happened, and until then its exit
    // is still ours to report.
    const previous = this.epoch;
    this.epoch = null;
    // The resolver for THIS attempt's promise, captured before any await — so an attempt that is
    // superseded mid-flight settles the waiters IT collected rather than a later attempt's.
    const settle = this.markSpawned;
    try {
      // Drain (splice) rather than re-read so a later re-spawn doesn't re-await already-settled ones.
      await Promise.all(this.ready.splice(0));
      const epoch = await spawnPty({
        id: this.id,
        command: cmd.command,
        args: cmd.args,
        cwd: cmd.cwd,
        cols: cmd.cols,
        rows: cmd.rows,
      });
      // BIND TO THE PTY WE JUST GOT — or to the HIGHEST epoch seen, if two spawns overlapped.
      //
      // Highest wins, rather than last-caller wins, and the difference is not cosmetic: which of two
      // in-flight `spawnPty` calls reaches Rust first is not knowable from here (each awaits a
      // different number of microtasks before it even invokes), so JS call order cannot say which
      // PTY is live. Rust's counter can: it mints in the order it actually creates PTYs, and
      // `sessions.insert` replaces, so the HIGHEST epoch minted for this id IS the session that
      // survived. A loser still settles its own waiters — against the winner, so they judge exits by
      // the life that is actually live.
      if (epoch > (this.epoch ?? NO_EPOCH)) this.epoch = epoch;
      // Settled after the assignment so a subscriber woken by `epochKnown` reads the same value the
      // synchronous path reads.
      settle(this.epoch ?? NO_EPOCH);
    } catch (err) {
      // A SPAWN THAT FAILED IS A NO-OP, NOT A TEARDOWN. Two things go wrong if this is skipped.
      //
      // Left unsettled, `epochKnown` never resolves and every later exit for this agent hangs on it
      // forever — the permanently inert exit path, reintroduced for a spawner that reported exits
      // fine before. And left cleared, `epoch` says we own nothing while the PREVIOUS PTY is very
      // possibly still alive: `spawnPty` can reject before Rust ever replaces the session, so its
      // exit is still ours to report. So restore what we had and settle the waiters with it —
      // unless an overlapping spawn bound a newer life in the meantime, which wins on epoch order.
      if ((previous ?? NO_EPOCH) > (this.epoch ?? NO_EPOCH)) this.epoch = previous;
      settle(this.epoch ?? NO_EPOCH);
      throw err;
    }
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
