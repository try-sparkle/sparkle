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
  setReport: (report: WatchdogReport) => void;
}

export const useAgentWatchdogStore = create<AgentWatchdogState>((set) => ({
  report: null,
  setReport: (report) => set({ report }),
}));

/** Imperative setter, so the (non-React) polling service can push without a hook. */
export function setAgentWatchdogReport(report: WatchdogReport): void {
  useAgentWatchdogStore.getState().setReport(report);
}
