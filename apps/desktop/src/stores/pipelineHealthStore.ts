// pipelineHealthStore — "is the deployment pipeline healthy right now?", for the top-bar indicator.
//
// THE BUG THIS EXISTS FOR (bead sparkle-m6jov5): a pipeline component can fail with NO surface to the
// founder. The seed case was the roborev review daemon wedging — its process alive and holding the
// port, but `roborev status` reporting "not running" — so code review silently stopped for ~1h36m,
// commits queued unreviewed, and PRs merged without a completed review. It was found by accident.
//
// So this store polls one Rust command (`pipeline_health_probe`) that probes every component
// (roborev, the CI runner pool, the release runner, the PR reviewer) and returns each one's state
// plus a folded `overall`. The indicator renders `overall` as an icon; the panel lists the
// components. A silent outage becomes a visible one.
//
// A FAILED POLL NEVER CLEARS WHAT IS KNOWN. A transient IPC error keeps the last snapshot and only
// records `error` — a health icon that blinked to "all clear" on a dropped poll would recreate the
// invisibility this store exists to fix, and one that blinked to red would cry wolf. Mirrors
// inboxStore's "keep the last snapshot" discipline.
import { invoke } from "@tauri-apps/api/core";

import { log } from "../logger";
import { runPipelineEscalation } from "../services/pipelineHealthEscalation";

/**
 * Poll cadence. ONE MINUTE.
 *
 * Deliberately slow relative to inboxStore's ten seconds: a tick here shells out to `roborev status`
 * and one `gh api` runner read (a network round-trip), which is far heavier than inbox's pair of file
 * reads, and the conditions it watches for — a wedged daemon, an offline release runner — persist for
 * many minutes, so a minute of latency to surface one is immaterial. A NEW root does not wait for the
 * next tick — see {@link setPipelineRoot}.
 */
export const PIPELINE_HEALTH_POLL_INTERVAL_MS = 60_000;

/** The five component/overall states, mirroring the Rust `HealthState` (serde `snake_case`). */
export type HealthState = "healthy" | "warning" | "blocking" | "unknown" | "not_applicable";

/** One pipeline component's health, mirroring the Rust `ComponentHealth`. */
export interface ComponentHealth {
  id: string;
  name: string;
  state: HealthState;
  detail: string;
}

/** The whole reading, mirroring the Rust `PipelineHealth`. */
export interface PipelineHealth {
  overall: HealthState;
  components: ComponentHealth[];
}

/** The colour band an icon/dot uses for a state. `muted` is for `not_applicable` (nothing to
 *  monitor) — distinct from green, so a pipeline with everything turned off does not read as
 *  "all healthy". */
export type HealthTone = "green" | "amber" | "red" | "muted";

/**
 * Map a state to its icon tone. PURE and total, so the icon can never drift from the data.
 *
 *   * `blocking` → red — a deployment is prevented.
 *   * `warning` / `unknown` → amber — degraded, or we could not tell; both worth the founder's eye
 *     but neither is a proven outage, so neither is red.
 *   * `healthy` → green.
 *   * `not_applicable` → muted — this component/pipeline is deliberately off.
 */
export function toneForState(state: HealthState): HealthTone {
  switch (state) {
    case "blocking":
      return "red";
    case "warning":
    case "unknown":
      return "amber";
    case "healthy":
      return "green";
    case "not_applicable":
      return "muted";
  }
}

interface PipelineHealthStoreState {
  /** The last reading. `null` = never polled (the indicator shows a neutral "checking" form until the
   *  first answer, never a false green). */
  health: PipelineHealth | null;
  /** The last poll failure, for diagnosis. A failed poll NEVER clears `health` — see the file header. */
  error: string | null;
}

import { create } from "zustand";

export const usePipelineHealthStore = create<PipelineHealthStoreState>()(() => ({
  health: null,
  error: null,
}));

// ── The single-target poller ──────────────────────────────────────────────────────────────────────
// Unlike inboxStore's per-agent registry, pipeline health is repo-wide: one root at a time, whichever
// project the header is showing. Module scope so a re-render never touches the timer.
let activeRoot: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let pollInFlight = false;

/** TEST SEAM. Swap the Tauri call; returns a restore function. */
let probe: (root: string) => Promise<PipelineHealth> = (root) =>
  invoke<PipelineHealth>("pipeline_health_probe", { root });

export function __setPipelineProbeForTests(fn: typeof probe): () => void {
  const prev = probe;
  probe = fn;
  return () => {
    probe = prev;
  };
}

/**
 * Point the poller at a project root, and poll IMMEDIATELY when it changes.
 *
 * The header calls this with the selected project's path. A changed root triggers an eager poll for
 * the same reason inboxStore's first registration does: the answer should track what the header is
 * showing without waiting up to a full minute. Setting the same root again is a no-op (no re-poll),
 * so an unrelated store write that re-renders the chip does not restart the network read.
 */
export function setPipelineRoot(root: string | null): void {
  const next = root && root.trim() !== "" ? root : null;
  if (next === activeRoot) return;
  activeRoot = next;
  if (next !== null) void refreshPipelineHealth();
}

/**
 * Read the pipeline's health once and publish it.
 *
 * Never throws and never clears `health` on failure — see the file header. Overlapping ticks are
 * skipped rather than queued: a slow `gh api` must not build a backlog of identical reads.
 */
export async function refreshPipelineHealth(): Promise<void> {
  if (pollInFlight) return;
  const root = activeRoot;
  if (root === null) return;
  pollInFlight = true;
  try {
    const health = await probe(root);
    // Capture the PRIOR snapshot BEFORE publishing the new one — the real-time escalation is
    // edge-triggered off prev→next, and the store's whole point is that it keeps the prior reading.
    const prev = usePipelineHealthStore.getState().health;
    usePipelineHealthStore.setState({ health, error: null });
    // Escalate any worse transition (green→warning/blocking, warning→blocking) or recovery. Fire-
    // and-forget and self-contained (never rejects): a delivery failure must not fail the poll, and
    // the durable pipeline-health bead is filed by the hourly scan regardless.
    void runPipelineEscalation(prev, health, root);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // WARN, not error, and the previous snapshot survives: the honest state after a failed read is
    // "what I last saw", not "all clear" and not "everything is down".
    log.warn("pipeline-health", "could not read pipeline health", e);
    usePipelineHealthStore.setState({ error: msg });
  } finally {
    pollInFlight = false;
  }
}

/**
 * Start the poll. Idempotent; returns the stop function. Mounted once from `App`, beside
 * `startInboxWatch`. It is a timer over a root that may be null — `refreshPipelineHealth` returns
 * immediately when no root is set — so the cost before any project is open is one no-op callback a
 * minute.
 */
export function startPipelineHealthWatch(): () => void {
  if (timer !== null) return stopPipelineHealthWatch;
  timer = setInterval(() => void refreshPipelineHealth(), PIPELINE_HEALTH_POLL_INTERVAL_MS);
  void refreshPipelineHealth();
  return stopPipelineHealthWatch;
}

export function stopPipelineHealthWatch(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
}

/** TEST SEAM. Drop the root, the timer, and the snapshot so one test cannot leak into the next. */
export function __resetPipelineHealthForTests(): void {
  stopPipelineHealthWatch();
  activeRoot = null;
  pollInFlight = false;
  usePipelineHealthStore.setState({ health: null, error: null });
}
