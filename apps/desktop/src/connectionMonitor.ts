// connectionMonitor — wires the live connectivity signals into connectionStore and fires the
// re-query on recovery. Two signals: the webview's online/offline events (instant) and a 30s
// reachability heartbeat (authoritative — catches wifi-up-but-internet-dead). On a genuine
// offline→online edge it re-queries every open agent. Mounted once, near the app root. ()
import { useEffect } from "react";
import { useConnectionStore } from "./stores/connectionStore";
import { probeConnectivity } from "./connectivity";
import { requeryOpenAgents, shouldRequery } from "./services/requery";
import { log } from "./logger";

/** How often the heartbeat re-checks reachability. The user-facing spec: "every 30 seconds." */
export const PROBE_INTERVAL_MS = 30_000;

interface ProbeRunnerDeps {
  probe: () => Promise<boolean>;
  applyProbe: (ok: boolean) => void;
  isOnline: () => boolean;
  onRecover: () => void;
}

/**
 * Build the heartbeat's probe runner. It can be invoked from three triggers (mount, the `online`
 * event, the interval) that may overlap — a single probe takes up to a few seconds. Two guards
 * keep that safe:
 *   • an in-flight flag drops overlapping calls, so a slow probe isn't racing a fresh one;
 *   • `prev` (the last online verdict) is updated *before* onRecover runs, so only ONE caller can
 *     observe the offline→online edge and re-query — no double-prompting.
 * A dropped overlapping call is NOT coalesced: a trigger that arrives mid-probe is discarded, so
 * in the worst case the offline→online edge surfaces on the next 30s tick rather than instantly.
 * That's an accepted trade — the heartbeat cadence is the spec'd 30s — not an oversight.
 * Pure (deps injected) so the concurrency behavior is unit-testable without React/Tauri.
 */
export function createProbeRunner(deps: ProbeRunnerDeps): () => Promise<void> {
  let prev = deps.isOnline();
  let inFlight = false;
  return async () => {
    if (inFlight) return; // a probe is already running; skip the overlap
    inFlight = true;
    try {
      let ok: boolean;
      try {
        ok = await deps.probe();
      } catch {
        // probeConnectivity is contractually non-throwing, but harden anyway: a thrown probe is
        // inconclusive. Leave prev/store untouched (don't flip state on a fluke) and don't let the
        // rejection escape to the `void runProbe()` callers as an unhandled rejection.
        return;
      }
      deps.applyProbe(ok);
      const next = deps.isOnline();
      const recovered = shouldRequery(prev, next);
      prev = next; // commit the new baseline before the (async) re-query so no one re-sees the edge
      if (recovered) deps.onRecover();
    } finally {
      inFlight = false;
    }
  };
}

export function useConnectionMonitor(): void {
  useEffect(() => {
    const store = useConnectionStore;
    // Seed from the browser's current view so a launch already offline shows the banner at once,
    // and so the runner's initial `prev` reflects reality.
    store.getState().setBrowserOnline(typeof navigator === "undefined" ? true : navigator.onLine);

    const runProbe = createProbeRunner({
      probe: probeConnectivity,
      applyProbe: (ok) => store.getState().applyProbe(ok, Date.now()),
      isOnline: () => store.getState().isOnline,
      onRecover: () => {
        log.info("connectivity", "back online — re-querying open agents");
        void requeryOpenAgents();
      },
    });

    const onOnline = () => {
      // The interface returning ≠ the internet working; confirm with a real probe, whose edge
      // check then drives the re-query.
      store.getState().setBrowserOnline(true);
      void runProbe();
    };
    const onOffline = () => store.getState().setBrowserOnline(false);

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    void runProbe(); // initial reading
    const timer = window.setInterval(() => void runProbe(), PROBE_INTERVAL_MS);

    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.clearInterval(timer);
    };
  }, []);
}
