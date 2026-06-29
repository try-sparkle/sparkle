// updaterService — drives the Tauri auto-updater from the frontend.
//
// Flow (see docs/superpowers/specs/2026-06-28-desktop-auto-updater-and-release-flow-design.md,
// Unit A): on launch and every N hours we poll the signed GitHub Releases manifest via the
// updater plugin's check(). When an update is found we branch on the user's `autoApplyUpdates`
// setting:
//   - ON  (default): silently downloadAndInstall(); the update applies on the next restart
//                    regardless. We surface a quiet, dismissible "ready — Restart now / on next
//                    launch" affordance.
//   - OFF: surface a "Restart to apply / Later" prompt and DON'T install until the user acts;
//          their action does the download+install, then relaunches.
// Network/check/signature failures are swallowed and retried next interval — the updater never
// throws into the UI and never blocks app usage.
//
// The exact plugin API (check → Update | null; Update.downloadAndInstall / version / body /
// close; process.relaunch) was read from node_modules/@tauri-apps/plugin-updater and
// plugin-process per AGENTS.md before this was written.
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { create } from "zustand";
import { useSettingsStore } from "../stores/settingsStore";

/** Default poll cadence: every 6 hours, plus once at launch. */
export const DEFAULT_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * UI-facing phase:
 *  - "idle":      nothing to show.
 *  - "available": an update was found but NOT installed (auto-apply off) — prompt to apply.
 *  - "ready":     an update was downloaded + installed (auto-apply on) and will apply on the next
 *                 restart — offer an optional "Restart now".
 */
export type UpdaterPhase = "idle" | "available" | "ready";

interface UpdaterStore {
  phase: UpdaterPhase;
  /** Version string of the pending/installed update (e.g. "0.4.0"), or null when idle. */
  version: string | null;
  /** Release notes (the manifest `body`), if any. */
  notes: string | null;
  /** The user dismissed the banner ("Later" / "on next launch"). Hides it until the next find. */
  dismissed: boolean;
  /** An apply+restart is in flight (prevents double-clicks; lets the banner show a busy state). */
  busy: boolean;
  setAvailable: (version: string, notes: string | null) => void;
  setReady: (version: string, notes: string | null) => void;
  setBusy: (busy: boolean) => void;
  dismiss: () => void;
  reset: () => void;
}

/** Tiny zustand store the banner subscribes to. The Update handle itself lives in module scope
 *  (below) — it isn't serializable and the UI only needs the derived phase/version/notes. */
export const useUpdaterStore = create<UpdaterStore>((set) => ({
  phase: "idle",
  version: null,
  notes: null,
  dismissed: false,
  busy: false,
  setAvailable: (version, notes) =>
    set({ phase: "available", version, notes, dismissed: false }),
  setReady: (version, notes) => set({ phase: "ready", version, notes, dismissed: false }),
  setBusy: (busy) => set({ busy }),
  dismiss: () => set({ dismissed: true }),
  reset: () =>
    set({ phase: "idle", version: null, notes: null, dismissed: false, busy: false }),
}));

// The update found while auto-apply is OFF, retained so the user's "Restart to apply" can install
// it on demand. Null once installed (auto-apply ON path) or after it's been applied.
let pendingUpdate: Update | null = null;

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Run one update check and act on the result. Safe to call repeatedly (interval + launch).
 * Never throws: all failures (offline, manifest fetch, signature mismatch, install error) are
 * swallowed so the next interval retries cleanly.
 */
export async function checkForUpdatesNow(): Promise<void> {
  // Already installed and waiting for restart — re-checking would just re-download the same build.
  if (useUpdaterStore.getState().phase === "ready") return;
  try {
    const update = await check();
    if (!update) return; // No update available — no-op.
    const notes = update.body ?? null;
    const autoApply = useSettingsStore.getState().autoApplyUpdates;
    if (autoApply) {
      // Silent download + install. The staged update applies on the next restart regardless;
      // we just surface a quiet "ready" affordance.
      await update.downloadAndInstall();
      useUpdaterStore.getState().setReady(update.version, notes);
      pendingUpdate = null;
      // Best-effort release of the native resource handle — install is done.
      try {
        await update.close();
      } catch {
        /* ignore */
      }
    } else {
      // Defer the install until the user chooses "Restart to apply"; keep the handle so we can.
      pendingUpdate = update;
      useUpdaterStore.getState().setAvailable(update.version, notes);
    }
  } catch {
    // Silent: network/check/signature failures retry on the next interval. Never reaches the UI.
  }
}

/**
 * Apply the pending update (installing it first if auto-apply was off) and relaunch into it.
 * Wired to the banner's "Restart now" / "Restart to apply" button. On failure, clears the busy
 * flag so the user can retry; the banner stays put.
 */
export async function applyUpdateAndRestart(): Promise<void> {
  const store = useUpdaterStore.getState();
  store.setBusy(true);
  try {
    if (pendingUpdate) {
      // Auto-apply OFF path: not yet installed — install on demand now.
      await pendingUpdate.downloadAndInstall();
      try {
        await pendingUpdate.close();
      } catch {
        /* ignore */
      }
      pendingUpdate = null;
    }
    await relaunch();
  } catch {
    // Apply/relaunch failed — let the user try again rather than getting stuck on a spinner.
    store.setBusy(false);
  }
}

// Guard against double-starts (e.g. React StrictMode double-mount) and hold the interval handle.
let started = false;
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Begin polling for updates: once at launch, then every `intervalMs` (default 6h). No-ops in dev
 * / the browser preview / when not packaged — the updater plugin and signed manifest only exist
 * in a real build, so running check() there only generates noise. Returns a cleanup that stops
 * the interval.
 */
export function startUpdater(intervalMs: number = DEFAULT_UPDATE_INTERVAL_MS): () => void {
  if (started || !inTauri() || import.meta.env.DEV) return () => {};
  started = true;
  void checkForUpdatesNow();
  timer = setInterval(() => void checkForUpdatesNow(), intervalMs);
  return () => {
    if (timer) clearInterval(timer);
    timer = null;
    started = false;
  };
}
