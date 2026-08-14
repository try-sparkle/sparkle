// The consumption side of the Rust `agent_memory_watchdog` command (memwatch.rs).
//
// WHY THIS EXISTS. `config.rs` predicts a concurrency ceiling and `services/memoryAdmission.ts`
// narrows NEW spawns on live pressure — but neither watches an agent that has already been
// admitted and then runs its RSS away. That is the actual 2026-07-20 jetsam failure mode
// (`sparkle-0bye`): the ramp "was visible for five minutes before the machine became
// unrecoverable. Nothing watched it." The Rust watchdog computes the per-AGENT footprint (the
// whole descendant process tree, not one pid) and judges it; it compiled, was unit-tested, and
// was registered as a Tauri command — but nothing CALLED it, so `agent_rss_auto_kill` did
// nothing whatever its value. This module is the caller.
//
// WARN BEFORE KILL. The Rust side makes the decision, conservatively and OFF by default:
//   • `level`        — ok / warn (>= agent_rss_warn_mb, default 4096) / critical (>= kill_mb).
//   • `kill_offered` — past the kill threshold (default 8192 MiB); the UI may offer a manual kill.
//   • `auto_kill`    — TRUE only when the user opted in (`agent_rss_auto_kill = true`, default
//                      false) AND the agent is past the kill threshold.
// So the SHIPPED behavior is: surface warn/critical agents (store + a one-time console.warn),
// and never terminate anything. Auto-kill is a deliberate opt-in a human turns on.
//
// THE KILL PRIMITIVE is `killPty(agentId)` — the agent id IS the PTY session id (memwatch.rs:
// "The agent ids are the PTY session ids"). It stops the runaway's process tree but leaves the
// agent row and its worktree intact, so the user can restart it. That is the least-destructive
// stop available (the same one `agentTransport.kill()` uses); we deliberately do NOT go through
// `removeAgent`, which hard-deletes the row and tears down the worktree.
import { invoke } from "@tauri-apps/api/core";
import { killPty } from "../pty";
import type { MemorySample } from "./memoryAdmission";
import { setAgentWatchdogReport } from "../stores/agentWatchdogStore";

/** Severity for one agent, as `WatchdogLevel` serializes (serde `rename_all = "lowercase"`). */
export type WatchdogLevel = "ok" | "warn" | "critical";

/** One agent's verdict, as the Rust `WatchdogVerdict` serializes (field names as-is, snake_case). */
export interface WatchdogVerdict {
  agent_id: string;
  root_pid: number;
  rss_bytes: number;
  proc_count: number;
  level: WatchdogLevel;
  /** Past the kill threshold — a manual "Kill agent" action may be offered regardless of opt-in. */
  kill_offered: boolean;
  /** True ONLY when the user opted into auto-kill AND the agent is past the kill threshold. */
  auto_kill: boolean;
  message: string;
}

/** The whole report, as the Rust `WatchdogReport` serializes. */
export interface WatchdogReport {
  verdicts: WatchdogVerdict[];
  /** A Rust `Option<MemorySample>` — crosses the wire as `null`, never absent. */
  sample: MemorySample | null;
  coalition_bytes: number;
  /** True when the process table could not be read: empty `verdicts` means "unknown", not "clear". */
  unavailable: boolean;
}

/**
 * The kill seam. Defaults to the real `killPty`; tests override it to assert the side effect
 * without a live PTY. Pass nothing to restore the real one.
 */
// A runaway reaped on memory pressure is the least human-initiated stop there is, so it names
// itself in the ledger like every other automated caller.
const watchdogKill = (agentId: string) => killPty(agentId, "memory-watchdog");
let killer: (agentId: string) => Promise<void> = watchdogKill;
export function setAgentWatchdogKiller(fn?: (agentId: string) => Promise<void>): void {
  killer = fn ?? watchdogKill;
}

/**
 * Agents we have already issued an auto-kill for. A kill is not instantaneous — the process is
 * still resident on the very next tick — so without this we would re-issue `killPty` every 5s
 * until it dies. Kill ONCE; if it failed we log and do not hammer a possibly-wedged process.
 * Pruned when the agent leaves a real (non-`unavailable`) report.
 */
const actioned = new Set<string>();

/**
 * Last surfaced level per agent, so `console.warn` fires only on a RISING transition
 * (ok→warn, warn→critical) rather than on every poll of a sustained condition. A warning that
 * reprints every 5s is one the reader learns to ignore.
 */
const lastLevel = new Map<string, WatchdogLevel>();

/**
 * Monotonic request sequencing, mirroring `memoryAdmission`: `agent_memory_watchdog` runs off
 * the main thread and forks `ps`, which is slowest exactly when the machine is under the memory
 * pressure this watches for. A slow reply must not overwrite a newer one already applied.
 */
let latestRequest = 0;
let lastApplied = 0;

/** Test seam — clear all bookkeeping so one test's state can't leak into the next. */
export function resetAgentWatchdog(): void {
  actioned.clear();
  lastLevel.clear();
  lastApplied = latestRequest;
}

function rank(l: WatchdogLevel): number {
  return l === "critical" ? 2 : l === "warn" ? 1 : 0;
}

/**
 * Poll the watchdog once, surface its verdicts, and carry out any opted-in auto-kills.
 *
 * Fire-and-forget from the App.tsx tick: never throws. A REJECTED invoke is the EXPECTED case on
 * any build predating the command (it rejects with "command not found" every tick), and a
 * teardown race can reject too — either way the poll is not awaited, so a throw would surface as
 * an unhandled rejection every few seconds.
 */
export async function refreshAgentWatchdog(): Promise<void> {
  const seq = ++latestRequest;
  let report: WatchdogReport;
  try {
    report = await invoke<WatchdogReport>("agent_memory_watchdog");
  } catch {
    return;
  }
  // A newer tick already landed: this reply is stale by construction, drop it.
  if (seq <= lastApplied) return;
  lastApplied = seq;
  if (!report || !Array.isArray(report.verdicts)) return;

  // Surface: hand the whole report to the store so the UI can render warn/critical agents.
  setAgentWatchdogReport(report);

  const present = new Set<string>();
  for (const v of report.verdicts) {
    present.add(v.agent_id);

    // Warn once, on a rising transition into warn/critical.
    const prev = lastLevel.get(v.agent_id) ?? "ok";
    if (v.level !== "ok" && rank(v.level) > rank(prev)) {
      console.warn(`[agent-watchdog] agent ${v.agent_id}: ${v.message}`);
    }
    lastLevel.set(v.agent_id, v.level);

    // Act: the Rust side already gated `auto_kill` on the opt-in flag AND the kill threshold;
    // we simply carry the decision out, exactly once per agent.
    if (v.auto_kill && !actioned.has(v.agent_id)) {
      actioned.add(v.agent_id);
      console.warn(`[agent-watchdog] auto-killing runaway agent ${v.agent_id}: ${v.message}`);
      const failed = (e: unknown) => console.warn(`[agent-watchdog] killPty failed for ${v.agent_id}`, e);
      void killer(v.agent_id).catch(failed);
    }
  }

  // Prune bookkeeping for agents that have left — but ONLY on a real reading. An `unavailable`
  // report (ps failed) carries empty `verdicts`; pruning on it would drop the actioned set and
  // let the next good tick re-kill an agent still mid-teardown.
  if (!report.unavailable) {
    for (const id of [...actioned]) if (!present.has(id)) actioned.delete(id);
    for (const id of [...lastLevel.keys()]) if (!present.has(id)) lastLevel.delete(id);
  }
}
