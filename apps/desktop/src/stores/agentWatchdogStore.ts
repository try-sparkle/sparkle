// agentWatchdogStore — the latest per-agent RSS watchdog reading, for the UI to surface.
//
// The Rust command `agent_memory_watchdog` (memwatch.rs) judges each live agent's whole
// process-tree RSS and returns a WatchdogReport. `services/agentMemoryWatchdog.ts` polls it
// on the shared 5s App.tsx tick and hands the result here so a component can render which
// agents are in `warn`/`critical` — the "surface" half of warn-before-kill. Acting on a
// runaway (the opt-in auto-kill) lives in the service, not here; this store is read-only
// state for display.
import { create } from "zustand";
import type { WatchdogReport } from "../services/agentMemoryWatchdog";

interface AgentWatchdogState {
  /** The most recent report, or null before the first poll. */
  report: WatchdogReport | null;
  /**
   * How many DISTINCT reports have been stored, starting at 0 for "none yet".
   *
   * `report` alone cannot answer "is this the same reading I already consumed?", and one consumer
   * (services/peakConcurrency) folds each report into a PERMANENT, never-lowered distribution — so
   * re-consuming an unchanged report does not just waste work, it silently biases a measurement
   * that nothing can later undo. The poller leaves the previous report in place whenever an invoke
   * rejects or a reply lands out of order (services/agentMemoryWatchdog), which is most likely
   * exactly when forking `ps` is slow — i.e. under the memory pressure being measured. Without this
   * counter a watchdog that starts failing would have one snapshot folded 17,280 times a day,
   * biased toward whatever the machine looked like at the unluckiest moment.
   *
   * Monotonic and never reset, so a consumer only ever has to compare it for equality.
   */
  seq: number;
  setReport: (report: WatchdogReport) => void;
}

export const useAgentWatchdogStore = create<AgentWatchdogState>((set) => ({
  report: null,
  seq: 0,
  setReport: (report) => set((s) => ({ report, seq: s.seq + 1 })),
}));

/** Imperative setter, so the (non-React) polling service can push without a hook. */
export function setAgentWatchdogReport(report: WatchdogReport): void {
  useAgentWatchdogStore.getState().setReport(report);
}
