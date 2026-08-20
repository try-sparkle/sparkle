// Production wiring for the fleet CI-budget governor. Kept OUT of ciBudgetGovernor.ts so that module
// stays dependency-free (unit-testable by driving the real object, cheap for shipAgent to import).
// This half reads `[fleet]` from config, feeds the live release-in-progress signal off the
// pipeline-health store, and re-drains the queue on every health reading so a finished release
// un-pauses the fleet immediately.
import { usePipelineHealthStore, type PipelineHealth } from "../stores/pipelineHealthStore";
import { getConfig, onConfigChanged, type EffectiveConfig } from "./config";
import { ciBudgetGovernor, UNKNOWN_LOAD, type CiLoad } from "./ciBudgetGovernor";
import { log } from "../logger";

/** Derive the governor's {@link CiLoad} from a pipeline-health reading. Fail-safe: a missing reading
 *  or an absent/`null` field maps to `null` (UNKNOWN), which the governor treats as "do not hold on
 *  the release signal" — the numeric budget still bounds the fleet. A Rust `Option` crosses the wire
 *  as `null` (never an absent key on the current backend), and an older backend omits the field
 *  (`undefined`); `?? null` folds both to UNKNOWN. */
export function ciLoadFromHealth(health: PipelineHealth | null): CiLoad {
  if (!health) return UNKNOWN_LOAD;
  return { releaseInProgress: health.releaseInProgress ?? null };
}

/** Apply the `[fleet]` knobs to the singleton. An absent section (a Rust backend predating `[fleet]`)
 *  leaves the governor as it is — DISABLED in a fresh process (the singleton ships at budget 0), i.e.
 *  the fail-safe is "no throttle", never a silent throttle the user can't see. The current backend
 *  always sends `[fleet]` (it is in `SparkleConfig`'s Default), so this early-return is the
 *  old-backend path only. */
export function applyFleetConfig(eff: EffectiveConfig): void {
  const fleet = eff.config.fleet;
  if (!fleet) return;
  ciBudgetGovernor.configure({
    budget: Math.max(0, Math.floor(fleet.ci_budget)),
    leaseMs: Math.max(0, Math.floor(fleet.ci_lease_secs)) * 1000,
  });
}

/**
 * Wire the singleton governor to live config + the pipeline-health signal, and return a teardown.
 * Mounted once, on the main window, alongside the pipeline-health watch (App.tsx).
 */
export function startCiBudgetGovernor(): () => void {
  // Point the governor at the live health store immediately; the first poll fills it in.
  ciBudgetGovernor.configure({
    loadProbe: () => ciLoadFromHealth(usePipelineHealthStore.getState().health),
  });

  // Initial config read (global layer — the budget is machine-wide), then live updates.
  getConfig(null)
    .then(applyFleetConfig)
    .catch((e) => log.warn("ciBudgetGovernor", "initial config read failed", e));
  const configUnlistenPromise = onConfigChanged(applyFleetConfig);

  // Every health reading (release finished, pool freed) may admit queued ships → re-pump.
  const unsubHealth = usePipelineHealthStore.subscribe(() => ciBudgetGovernor.pump());

  return () => {
    unsubHealth();
    configUnlistenPromise.then((un) => un()).catch(() => {});
    // Return the governor to its inert pass-through state. Without this, teardown would leave it at
    // `budget > 0` with a `loadProbe` reading a now-FROZEN health store (the health watch is torn
    // down too): if the last snapshot had `releaseInProgress: true`, every later ship would queue
    // with nothing left to pump it. `configure` also drains any waiters via its `pump()`.
    ciBudgetGovernor.configure({ budget: 0, loadProbe: () => UNKNOWN_LOAD });
  };
}
