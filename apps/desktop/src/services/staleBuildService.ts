// staleBuildService — detects when the RUNNING app is an older build than the one INSTALLED on disk
// and drives the "Restart to finish updating" banner (bead sparkle-jeen).
//
// WHY THIS EXISTS, separate from updaterService: the updater knows when IT staged an update this
// session. It does NOT know that the process is stale for any OTHER reason — an update applied in a
// previous session and never restarted, a hand-drag install over /Applications, a second window
// launched from a freshly-replaced bundle. The founder repeatedly hit exactly this: a bug fixed in
// the shipped binary was still present in the running process, inviting a re-fix of working code.
// So this watcher compares the running build against whatever is actually on disk RIGHT NOW, on an
// interval, and is true whenever they diverge regardless of how they got that way.
//
// The comparison is done by the pure `isStaleBuild` predicate below over a `StaleBuildProbe` gathered
// by the Rust `stale_build_probe` command. The reliable disk-readable signal is the installed
// bundle's Info.plist version; the SHA is carried for the day the build stamps it into the plist
// (see stale_build.rs / PRD/sparkle/stale-build-banner.md). Kept cheap: poll on an interval (default
// hourly) + on refocus, never hot.
//
// ── WHY THE UPDATER'S "READY" STATE MUST NEVER BE ROUTED THROUGH HERE (bead sparkle-1ueh3) ──────
// When updaterService was split so that it DOWNLOADS an update at check time and installs it only
// at restart/quit, the obvious-looking tidy-up was to fold its new deferred state into this store
// so there is one banner instead of two. Do not. Two independent reasons, both load-bearing:
//
//   1. THIS STORE GATES WORKER SPAWN. `workerSpawn.ts` THROWS on `staleBuild.stale`, so pushing
//      "an update is downloaded but not installed" in here would break agent spawn for every user
//      who declines to restart — and it would do it with a message ("version X is installed but not
//      yet running") that is now FACTUALLY FALSE, because nothing has been installed: the payload
//      is sitting in the webview's memory and /Applications is untouched.
//   2. THE PREDICATES DO NOT OVERLAP, so there is nothing to merge. `isStaleBuild` keeps its EXACT
//      predicate and still covers the cases only it can see — a hand-drag install over
//      /Applications, and an update applied in a PREVIOUS session and never restarted.
//      UpdateBanner's `phase === "ready"` covers this session's auto-update path. They answer
//      different questions about different moments.
//
// AND DO NOT ADD AN MTIME TERM TO `isStaleBuild` EITHER. `installedMtimeMs` is carried on the probe
// as a bug-report fallback and deliberately does NOT drive the predicate: an mtime comparison is
// speculative (a touch, a partial write, an installer that stamps the bundle before the final swap
// all move it), this watcher is hourly, and its output gates spawn. stale_build.rs:21-25 is right
// about that; a speculative term in a spawn gate is a much worse failure than a missed banner.
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { create } from "zustand";
import { isAppWindowSearch } from "./windowIdentity";

/** Facts gathered by the Rust `stale_build_probe` command (serde camelCase). */
export interface StaleBuildProbe {
  /** Version of the RUNNING process (compile-time). */
  runningVersion: string;
  /** Commit SHA of the RUNNING process ("unknown" for tarball builds). */
  runningSha: string;
  /** Installed bundle's CFBundleShortVersionString, or null when unreadable/not at /Applications. */
  installedVersion: string | null;
  /** Installed commit SHA — null today (not stored on disk); future-proofed. */
  installedSha: string | null;
  /** mtime of the installed .app (ms). Bug-report fallback only — NOT used by the banner predicate. */
  installedMtimeMs: number | null;
  /** This process's start time (ms). Bug-report fallback companion to installedMtimeMs. */
  runningStartedMs: number | null;
  /** The bundle path that was probed. */
  installedPath: string;
}

/** The sentinel `bridge::running_build_sha()` returns when git was unavailable at build time. A SHA
 *  equal to this carries no identity, so it must never drive a mismatch. */
export const UNKNOWN_SHA = "unknown";

/**
 * Compare two dotted-numeric version strings (e.g. "0.59.0" vs "0.60.0").
 *  → negative when a < b, 0 when equal, positive when a > b.
 * Only the leading numeric-dotted core is compared; any pre-release/build suffix ("-rc.1", "+meta")
 * is ignored, so "0.59.0" and "0.59.0-rc.1" compare EQUAL. Non-numeric or empty segments count as 0.
 * Pure — unit-tested. Kept deliberately small: the version strings here come from our own build, not
 * arbitrary user input, so full semver precedence is unnecessary.
 */
export function compareVersions(a: string, b: string): number {
  const core = (v: string): number[] =>
    v
      .trim()
      .split(/[-+]/, 1)[0]!
      .split(".")
      .map((p) => {
        const n = parseInt(p, 10);
        return Number.isFinite(n) ? n : 0;
      });
  const pa = core(a);
  const pb = core(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * PURE predicate (mutation-checked): is the process running an OLDER build than the one on disk?
 *
 * Rules, in order:
 *  1. If both versions are known and the INSTALLED version is strictly NEWER than the running one →
 *     stale (an update landed but this old process is still up). This is the reliable path.
 *  2. If the installed version is strictly OLDER → NOT stale. We're ahead of the /Applications copy
 *     (e.g. running a freshly built binary over an older install); nagging a restart would be wrong.
 *  3. If versions are equal-or-unknown, fall back to SHA: stale only when BOTH SHAs are known
 *     (present and not the "unknown" sentinel) AND differ — a re-cut of the same version. Dormant
 *     today because the installed SHA isn't on disk, but correct the day it is.
 *
 * Anything else (missing installed version and no comparable SHAs) → NOT stale: never show the
 * banner on incomplete information.
 */
export function isStaleBuild(p: StaleBuildProbe): boolean {
  const haveVersions = !!p.installedVersion && !!p.runningVersion;
  const cmp = haveVersions ? compareVersions(p.installedVersion!, p.runningVersion) : null;
  if (cmp !== null && cmp > 0) return true; // installed strictly newer
  if (cmp !== null && cmp < 0) return false; // we're ahead — never nag

  // Versions equal or unknown → decide on SHA, but only when both sides carry a real one.
  const rs = p.runningSha;
  const is = p.installedSha;
  if (rs && is && rs !== UNKNOWN_SHA && is !== UNKNOWN_SHA && rs !== is) return true;
  return false;
}

interface StaleBuildStore {
  /** A newer/different build is installed on disk than the one running. */
  stale: boolean;
  /** The installed version that triggered `stale` (drives per-version dismissal). */
  installedVersion: string | null;
  /** The user dismissed the banner for the current `installedVersion`. */
  dismissed: boolean;
  /** Mark stale for `installedVersion`. Dismissal is remembered ONLY while the installed version is
   *  unchanged: a still-newer build appearing re-shows the banner. */
  setStale: (installedVersion: string | null) => void;
  /** No longer stale (or unknowable) — clear everything, including a stale dismissal. */
  clear: () => void;
  /** Hide the banner until a different build is installed. */
  dismiss: () => void;
}

export const useStaleBuildStore = create<StaleBuildStore>((set) => ({
  stale: false,
  installedVersion: null,
  dismissed: false,
  setStale: (installedVersion) =>
    set((s) => ({
      stale: true,
      installedVersion,
      dismissed: s.dismissed && s.installedVersion === installedVersion,
    })),
  clear: () => set({ stale: false, installedVersion: null, dismissed: false }),
  dismiss: () => set({ dismissed: true }),
}));

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Wall-clock ms of the last probe, for the refocus throttle. */
let lastCheckAt = 0;

/**
 * Run one stale-build probe and update the store. Returns whether the running build is stale.
 * Never throws: an invoke failure (command missing, non-macOS) resolves to `false` and clears. */
export async function checkStaleBuild(): Promise<boolean> {
  lastCheckAt = Date.now();
  let probe: StaleBuildProbe;
  try {
    probe = await invoke<StaleBuildProbe>("stale_build_probe");
  } catch {
    return false;
  }
  const stale = isStaleBuild(probe);
  const store = useStaleBuildStore.getState();
  if (stale) {
    store.setStale(probe.installedVersion);
  } else {
    store.clear();
  }
  return stale;
}

/** Restart into the installed build. Wired to the banner's "Restart now". */
export async function restartToFinishUpdate(): Promise<void> {
  try {
    await relaunch();
  } catch {
    /* relaunch failed — leave the banner up so the user can retry (or restart manually). */
  }
}

/** One-shot probe for the bug-report template (bead sparkle-jeen): the raw running-vs-installed
 *  facts, or null when the command is unavailable (non-macOS / dev). Does not touch the store. */
export async function probeStaleBuild(): Promise<StaleBuildProbe | null> {
  try {
    return await invoke<StaleBuildProbe>("stale_build_probe");
  } catch {
    return null;
  }
}

/** Default poll cadence: hourly, plus once at launch and whenever the app regains focus. */
export const DEFAULT_STALE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
/** Don't re-probe within this window of the last probe — guards the focus listener. */
export const MIN_STALE_CHECK_GAP_MS = 5 * 60 * 1000;

let started = false;
let timer: ReturnType<typeof setInterval> | null = null;
let onFocus: (() => void) | null = null;

/**
 * Begin watching for a stale running build: once at launch, every `intervalMs` (default hourly), and
 * on app refocus (throttled by MIN_STALE_CHECK_GAP_MS). No-ops in dev / the browser preview / in
 * secondary windows — the install path and native probe only exist in a packaged main window, and
 * only one poller per machine is wanted (mirrors updaterService.startUpdater). Returns a cleanup.
 */
export function startStaleBuildWatch(
  intervalMs: number = DEFAULT_STALE_CHECK_INTERVAL_MS,
): () => void {
  if (started || !inTauri() || import.meta.env.DEV || !isAppWindowSearch(window.location.search))
    return () => {};
  started = true;
  void checkStaleBuild();
  timer = setInterval(() => void checkStaleBuild(), intervalMs);
  onFocus = () => {
    if (Date.now() - lastCheckAt >= MIN_STALE_CHECK_GAP_MS) void checkStaleBuild();
  };
  window.addEventListener("focus", onFocus);
  return () => {
    if (timer) clearInterval(timer);
    timer = null;
    if (onFocus) window.removeEventListener("focus", onFocus);
    onFocus = null;
    started = false;
  };
}
