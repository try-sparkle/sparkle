// apps/desktop/src/services/deliveryMonitor.ts
// Unit 3 of "Definable Done & Delivered" — the real-time delivery monitor.
//
// A lightweight background poller that, for a project's in-flight beads, re-evaluates whether each
// bead's merge commit is contained in a shipped release (the `in_release` signal). It ONLY reports
// signal state via an `onUpdate` callback — it NEVER auto-marks anything. The confirm-first /
// auto-mark policy (asking the human, applying the `bd` move, setting `learned=true`) lives in
// Unit 4/5; the monitor is purely observational so the board can advance a card the instant its
// release ships.
//
// Cadence mirrors the existing branch/workflow pollers (~60–120s). "Is commit X in a release?" is
// answered by the Rust `tag_contains_commit` command (git `tag --contains`), which returns the
// containing tags; a non-empty result whose tags look like release tags ⇒ shipped.

import { invoke } from "@tauri-apps/api/core";

/** Default poll cadence. Deliberately slow — releases are minutes-to-hours events, and each tick
 *  shells out to git once per watched bead. */
export const DELIVERY_POLL_INTERVAL_MS = 90_000;

/** A bead the monitor should watch, reduced to what the `in_release` check needs. The caller
 *  (Unit 5) supplies the merge commit SHA it already knows for each in-flight bead. */
export interface WatchedBead {
  beadId: string;
  /** The commit to test for release containment — typically the bead's squash/merge commit on the
   *  default branch. When unknown, the bead is reported `inRelease:false` (nothing to test). */
  mergeSha: string | null;
}

/** One bead's live delivery signal. `inRelease` is the observable truth this tick; `tags` lists the
 *  release tags that contain the commit (empty when not shipped or unknown). */
export interface DeliverySignal {
  beadId: string;
  inRelease: boolean;
  tags: string[];
}

/** A full monitor tick: the signal for every watched bead, plus a machine + human status for the
 *  column header chip. `detectable` is false only when we truly can't observe the signal (no git /
 *  no tags at all across the project) — the honest "⚠ can't detect — manual" state. */
export interface DeliveryMonitorUpdate {
  signals: DeliverySignal[];
  detectable: boolean;
  status: string;
}

type UpdateCb = (update: DeliveryMonitorUpdate) => void;

interface MonitorHandle {
  projectRoot: string;
  timer: ReturnType<typeof setInterval> | null;
  getBeads: () => WatchedBead[];
  onUpdate: UpdateCb;
  intervalMs: number;
  running: boolean;
}

// Single active monitor per app window (the board watches one project at a time). Kept module-local
// so start/stop are simple imperative calls the board can wire to mount/unmount.
let active: MonitorHandle | null = null;

/** Ask the Rust side which git tags contain `sha`. Best-effort: resolves `[]` on any failure so a
 *  missing tag/sha/repo degrades quietly instead of throwing out of the poll loop. */
export async function tagsContainingCommit(projectRoot: string, sha: string): Promise<string[]> {
  try {
    return await invoke<string[]>("tag_contains_commit", { projectRoot, sha });
  } catch {
    return [];
  }
}

/** A tag looks like a shipped-release marker: semver-ish (`v1.2.3` / `1.2`). Non-release tags
 *  (e.g. `nightly`, `latest`) don't count as a delivery on their own — but we still surface them,
 *  so the predicate is only used to decide `inRelease`, not to hide data. */
function looksLikeReleaseTag(tag: string): boolean {
  return /^v?\d+\.\d+/.test(tag.trim());
}

/** Evaluate one bead's `in_release` signal from the tags containing its merge commit. Pure — unit
 *  tests can drive it directly. A bead with no `mergeSha` is trivially not-in-release. */
export function evaluateSignal(beadId: string, mergeSha: string | null, tags: string[]): DeliverySignal {
  if (!mergeSha) return { beadId, inRelease: false, tags: [] };
  const releaseTags = tags.filter(looksLikeReleaseTag);
  return { beadId, inRelease: releaseTags.length > 0, tags: releaseTags };
}

/** Run one monitor tick: for each watched bead, test release containment and emit an update. Exposed
 *  (not just internal) so the board can force an immediate refresh (e.g. right after a merge) without
 *  waiting for the next interval. Never throws. */
export async function pollOnce(
  projectRoot: string,
  beads: WatchedBead[],
): Promise<DeliveryMonitorUpdate> {
  const signals: DeliverySignal[] = await Promise.all(
    beads.map(async (b) => {
      if (!b.mergeSha) return evaluateSignal(b.beadId, null, []);
      const tags = await tagsContainingCommit(projectRoot, b.mergeSha);
      return evaluateSignal(b.beadId, b.mergeSha, tags);
    }),
  );

  // Detectability: can we observe releases at all? If ANY watched bead has a merge SHA, we could in
  // principle detect containment; if the project has no tags whatsoever, releases aren't observable.
  const anyShipped = signals.some((s) => s.inRelease);
  const anyTestable = beads.some((b) => !!b.mergeSha);
  const detectable = anyTestable;
  const shippedCount = signals.filter((s) => s.inRelease).length;
  const status = !anyTestable
    ? "⚠ can't detect — manual"
    : anyShipped
      ? `watching via git releases — ${shippedCount} shipped`
      : "watching via git releases";

  return { signals, detectable, status };
}

/**
 * Start the background delivery monitor for `projectRoot`. `getBeads` is called each tick to fetch
 * the CURRENT in-flight watch set (so the board can add/remove beads without restarting the
 * monitor). `onUpdate` receives every tick's result. An immediate first tick runs before the
 * interval so the UI reflects state without a poll-interval delay. Calling start again replaces any
 * running monitor (stops the old one first).
 */
export function startDeliveryMonitor(
  projectRoot: string,
  onUpdate: UpdateCb,
  getBeads: () => WatchedBead[],
  intervalMs: number = DELIVERY_POLL_INTERVAL_MS,
): void {
  stopDeliveryMonitor();

  const handle: MonitorHandle = {
    projectRoot,
    timer: null,
    getBeads,
    onUpdate,
    intervalMs,
    running: false,
  };
  active = handle;

  const tick = async () => {
    // Re-entrancy guard: a slow git tick must not overlap the next interval.
    if (handle.running || active !== handle) return;
    handle.running = true;
    try {
      const update = await pollOnce(handle.projectRoot, handle.getBeads());
      if (active === handle) handle.onUpdate(update);
    } finally {
      handle.running = false;
    }
  };

  // Fire once immediately, then on the interval.
  void tick();
  handle.timer = setInterval(() => void tick(), intervalMs);
}

/** Stop the active delivery monitor (idempotent). Safe to call on unmount even if none is running. */
export function stopDeliveryMonitor(): void {
  if (active?.timer) clearInterval(active.timer);
  active = null;
}

/** Test/introspection helper: is a monitor currently active? */
export function isDeliveryMonitorRunning(): boolean {
  return active !== null;
}
