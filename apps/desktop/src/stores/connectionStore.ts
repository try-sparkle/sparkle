// connectionStore — the app's single source of truth for "are we online?". It combines two
// independent signals (see connectionMonitor.ts, which feeds them in):
//   • browserOnline — the webview's navigator.onLine + online/offline events. Instant, but only
//     knows whether a network interface exists (says "online" on wifi with dead internet).
//   • probeOk — the result of an actual reachability probe (Rust ureq HEAD, ~30s heartbeat).
// We are online only when BOTH agree. Either one going false drops us offline, which is what
// surfaces the gold banner and (on the recovery edge) re-queries the agents. (bead )
import { create } from "zustand";

interface ConnectionState {
  browserOnline: boolean;
  probeOk: boolean;
  isOnline: boolean;
  lastChecked: number | null; // epoch ms of the most recent probe (null until first run)

  setBrowserOnline: (online: boolean) => void;
  applyProbe: (ok: boolean, at: number) => void;
}

const derive = (browserOnline: boolean, probeOk: boolean) => browserOnline && probeOk;

export const useConnectionStore = create<ConnectionState>()((set) => ({
  // Optimistic until the first signal arrives, so a healthy launch never flashes the banner.
  browserOnline: true,
  probeOk: true,
  isOnline: true,
  lastChecked: null,

  setBrowserOnline: (online) =>
    set((s) => ({ browserOnline: online, isOnline: derive(online, s.probeOk) })),

  applyProbe: (ok, at) =>
    set((s) => ({ probeOk: ok, lastChecked: at, isOnline: derive(s.browserOnline, ok) })),
}));
