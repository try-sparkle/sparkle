// updaterService — drives the Tauri auto-updater from the frontend.
//
// ── WHY THIS SPLITS download() FROM install() (bead sparkle-1ueh3) ──────────────────────────────
// This module used to call `update.downloadAndInstall()` on the auto-apply path (default ON), fired
// at launch, hourly, AND on every window focus. On macOS that runs tauri-plugin-updater's
// `install_inner`, which does NOT stage anything for the next launch: it renames the RUNNING
// /Applications/Sparkle.app aside into a TempDir, `remove_dir_all`s it, renames the new bundle in,
// and touches it. The TempDir is never persisted on the macOS arm, so THE BUNDLE THE LIVE PROCESS
// WAS LAUNCHED FROM IS DELETED — typically hours before anyone restarts.
//
// macOS keys a TCC microphone grant to the bundle's code-signing identity AT ITS PATH. Deleting the
// bundle under the running process invalidates that grant, but the process keeps answering
// "Authorized" from its own cached answer while CoreAudio hands it all-zero buffers. Measured over
// six days of logs: 43 fault events, 12/12 fault clusters ended in a restart onto a HIGHER version,
// and ZERO processes ever recovered. tccd was never consulted once. See `bd show sparkle-1ueh3`.
//
// So the fix is not to stop updating — it is to collapse the window between "the bundle on disk was
// replaced" and "this process stops running" from hours to about a second:
//
//   - `download()` at check time. Nothing on disk changes; the payload sits in memory.
//   - `install()` only at the moment the process is going away anyway — the user pressing
//     "Restart now" (install → close → relaunch), or the app being asked to exit (see THE QUIT
//     HOOK below).
//
// ── THE QUIT HOOK, AND EXACTLY WHICH QUIT IT COVERS ────────────────────────────────────────────
// Without an install-on-quit the founder's habit (⌘Q constantly — it is how he currently recovers
// his microphone) would discard the in-memory payload every time and the update would never land.
// Rust prevents the exit, emits `updater://install-before-exit`, we install, and then we ask Rust to
// resume the exit — unconditionally, in a `finally`, whatever install() did. A user who cannot quit
// their app is a far worse bug than the one this fixes.
//
// WHICH EVENT ⌘Q ACTUALLY FIRES — verified by reading the locked crate sources, not from memory
// (tauri 2.11.3, tauri-runtime-wry 2.11.3, tao 0.35.3, muda 0.19.3):
//   - muda maps the macOS predefined Quit item to `sel!(terminate:)`
//     (muda/src/platform_impl/macos/mod.rs:994), i.e. AppKit `NSApp.terminate:`.
//   - tao's macOS app delegate implements only `applicationWillTerminate:`
//     (tao/src/platform_impl/macos/app_delegate.rs:131) — there is NO `applicationShouldTerminate:`
//     — so terminate: reaches us as `Event::LoopDestroyed` → `RunEvent::Exit`, which is not
//     preventable and is far too late to await an async JS install.
//   - `RunEvent::ExitRequested` is emitted from exactly two sites in tauri-runtime-wry
//     (src/lib.rs:4316 last-window-destroyed, :4356 `Message::RequestExit`), neither of which
//     terminate: reaches.
// CONSEQUENCE, stated honestly rather than assumed away: this hook covers `Message::RequestExit` —
// i.e. `AppHandle::exit` (the helper island's "Quit Sparkle" → roster.rs `quit_app`) and
// `request_restart`. macOS ⌘Q / the app-menu Quit reach it too, but ONLY because
// `src-tauri/src/app_menu.rs` now replaces the predefined Quit item with a custom one that calls
// `AppHandle::exit`; the predefined item's `sel!(terminate:)` never could.
//
// LAST-WINDOW-DESTROYED IS NOT COVERED, despite being the other emitter of `ExitRequested`. That
// one fires from `TaoWindowEvent::Destroyed` after the window has left the window map, so the
// webview is already gone: the emit reaches zero listeners, this function never runs, and Rust used
// to hold a windowless process for the whole 5s ack budget installing nothing. Rust now declines to
// defer that exit at all (`updater_quit::should_defer_exit`), so closing the last window quits at
// once and the update is DELAYED to the next launch.
//
// A SECOND QUIT WHILE THE SWAP IS RUNNING IS HELD BY RUST, NOT BY US. The deferral is one-shot, so
// a second ⌘Q used to sail past it and kill the process between `install_inner`'s `remove_dir_all`
// and its final rename — /Applications/Sparkle.app GONE. `updater_quit::hold_second_exit` now
// prevents that exit while an install is running; the two sanctioned exits (this module's
// `resume_exit_after_update`, and the watchdog) announce themselves first so they still pass. The
// UI half of that fix lives here: an unresponsive-looking window is what CAUSES the second press,
// so the quit-time install sets the store's `quitInstalling` flag and the banner says so.
//
// FAILURE HERE DEGRADES TO "UPDATE DELAYED", NEVER "UPDATE BROKEN". If the install never runs (⌘Q,
// a wedged webview, a failed install), nothing on disk was touched: the next session's check()
// finds the same release, re-downloads it, and the banner's "Restart now" still works. The only
// cost is one repeated download.
//
// ── THE MEMORY TRADE, MEASURED ─────────────────────────────────────────────────────────────────
// `plugin:updater|download` keeps the whole downloaded artifact in the webview's resource table as
// `DownloadedBytes(Vec<u8>)` (tauri-plugin-updater-2.10.1/src/commands.rs:39,137) until install(),
// close(), or process exit. There is no download-to-disk API in 2.10.1. The macOS updater artifact
// is `Sparkle.app.tar.gz` — MEASURED at 42,893,218 bytes (~41 MiB) for v0.128.0 via
// `gh release view --repo try-sparkle/sparkle`; the bytes are the COMPRESSED tarball as fetched
// (commands.rs hands the raw response body straight to the resource table), not an expanded copy.
// So a machine with an update pending carries ~41 MiB of extra RSS from the moment we download
// until the process exits. That cohort is EXACTLY the cohort whose microphone is dead today, for
// hours, with no recovery short of a restart. ~41 MiB is the cheaper half of that trade.
//
// BOUNDED LEAK, DOCUMENTED RATHER THAN CLAIMED FIXED: a webview reload would orphan the payload —
// the JS `Update` handle is lost while the Rust resource lives until `cleanup_before_exit`. Two
// facts bound it: `location.reload` / `location.replace` appear NOWHERE in apps/desktop/src
// (grepped), and `startUpdater` no-ops under `import.meta.env.DEV`, so the dev-server HMR reload
// path never downloads anything in the first place. A devtools-initiated reload could still orphan
// one payload, once, until quit. That is the honest state of it.
//
// ── THE POLL ITSELF ────────────────────────────────────────────────────────────────────────────
// On launch and every N hours (plus on refocus) we poll the signed GitHub Releases manifest via the
// updater plugin's check(). On an update we branch on the user's `autoApplyUpdates` setting:
//   - ON  (default): silently download() — nothing on disk changes — and surface a quiet,
//                    dismissible "downloaded — Restart now" affordance.
//   - OFF:           surface a "Restart to apply / Later" prompt and download NOTHING until the
//                    user acts; their action does the download+install, then relaunches.
// Network/check/download failures never throw into the UI and never block app usage — but they are
// no longer SILENT. Four bare `catch {}` here are why the incident above took 43 fault events to
// characterize; every arm now logs through `logger.ts`, which lands in the SAME file as the Rust
// `tracing` output. The "installing staged update" line at INFO is the load-bearing one: it
// timestamps the bundle swap in the same log as the dictation watchdog's fault, so the correlation
// is one grep next time.
//
// The exact plugin API (check → Update | null; Update.download / install / version / body / close;
// process.relaunch) was read from node_modules/@tauri-apps/plugin-updater and plugin-process per
// AGENTS.md before this was written.
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { useSettingsStore } from "../stores/settingsStore";
import { isAppWindowSearch } from "./windowIdentity";
import { invoke } from "./ipc";
import { log } from "../logger";

/** Log scope for everything in this module — one grep (`updater`) gets the whole timeline. */
const SCOPE = "updater";

/** Default poll cadence: every 60 minutes, plus once at launch and whenever the app regains focus. */
export const DEFAULT_UPDATE_INTERVAL_MS = 60 * 60 * 1000;

/** Don't run another check within this window of the last one — guards the focus listener (and any
 *  focus/visibility double-fire) from spamming the release feed on rapid app switching. */
export const MIN_CHECK_GAP_MS = 5 * 60 * 1000;

/** How long a "Later" / "On next launch" dismissal silences the banner.
 *
 *  DECAY EXISTS BECAUSE A PERMANENT DISMISSAL WAS A SILENT KILL SWITCH: `dismiss()` used to set a
 *  boolean that nothing ever cleared, and the phase guard below stops `setReady` from ever firing
 *  again once an update is staged — so one click on "On next launch" removed the update banner for
 *  the entire session AND there was no second event that could bring it back. One poll interval is
 *  the natural period: it is exactly "you'll be reminded next time we'd have told you". */
export const DISMISS_TTL_MS = DEFAULT_UPDATE_INTERVAL_MS;

/** Tauri event Rust emits when it has deferred an exit so we can install the staged update.
 *  MUST match `INSTALL_BEFORE_EXIT_EVENT` in src-tauri/src/lib.rs — asserted by a Rust test there,
 *  not merely by this comment. */
export const INSTALL_BEFORE_EXIT_EVENT = "updater://install-before-exit";

/** Wall-clock ms of the last check attempt (any trigger), for the MIN_CHECK_GAP_MS focus guard. */
let lastCheckAt = 0;

/**
 * UI-facing phase:
 *  - "idle":      nothing to show.
 *  - "available": an update was found but NOT downloaded (auto-apply off) — prompt to apply.
 *  - "ready":     an update was DOWNLOADED (auto-apply on) and is held in memory; nothing on disk
 *                 has changed yet. It installs when the app restarts or quits.
 */
export type UpdaterPhase = "idle" | "available" | "ready";

interface UpdaterStore {
  phase: UpdaterPhase;
  /** Version string of the found/downloaded update (e.g. "0.4.0"), or null when idle. */
  version: string | null;
  /** Release notes (the manifest `body`), if any. */
  notes: string | null;
  /** WHEN the user dismissed the banner ("Later" / "On next launch"), in ms, or null. A timestamp
   *  rather than a boolean so the dismissal can DECAY — see DISMISS_TTL_MS. */
  dismissedAt: number | null;
  /** An apply+restart is in flight (prevents double-clicks; lets the banner show a busy state). */
  busy: boolean;
  /** The app is QUITTING and the staged update is being installed on the way out.
   *
   *  THIS FLAG IS A SAFETY FEATURE, NOT A NICETY. The quit-time install used to write log lines and
   *  nothing else: the user pressed ⌘Q, the window sat there for the multi-second bundle swap, and
   *  the natural reaction — a second ⌘Q — killed the process between `install_inner`'s
   *  `remove_dir_all` and its final rename, leaving /Applications/Sparkle.app deleted. Rust now
   *  refuses that second exit; this is the half that stops the user making it in the first place.
   *  It renders THROUGH a dismissal, because "Later" was a statement about a banner, not consent to
   *  a silent multi-second freeze. */
  quitInstalling: boolean;
  setAvailable: (version: string, notes: string | null) => void;
  setReady: (version: string, notes: string | null) => void;
  setBusy: (busy: boolean) => void;
  setQuitInstalling: (quitInstalling: boolean) => void;
  dismiss: () => void;
  /** Clear a dismissal that is older than `ttlMs`. Called at the head of every check, so the banner
   *  comes back one poll interval after it was dismissed. No-op while the dismissal is fresh. */
  expireDismissal: (ttlMs?: number) => void;
  reset: () => void;
}

/** Tiny zustand store the banner subscribes to. The Update handle itself lives in module scope
 *  (below) — it isn't serializable and the UI only needs the derived phase/version/notes. */
export const useUpdaterStore = create<UpdaterStore>((set) => ({
  phase: "idle",
  version: null,
  notes: null,
  dismissedAt: null,
  busy: false,
  quitInstalling: false,
  setAvailable: (version, notes) =>
    set({ phase: "available", version, notes, dismissedAt: null }),
  setReady: (version, notes) => set({ phase: "ready", version, notes, dismissedAt: null }),
  setBusy: (busy) => set({ busy }),
  setQuitInstalling: (quitInstalling) => set({ quitInstalling }),
  dismiss: () => set({ dismissedAt: Date.now() }),
  expireDismissal: (ttlMs = DISMISS_TTL_MS) =>
    set((s) =>
      s.dismissedAt !== null && Date.now() - s.dismissedAt >= ttlMs ? { dismissedAt: null } : s,
    ),
  reset: () =>
    set({
      phase: "idle",
      version: null,
      notes: null,
      dismissedAt: null,
      busy: false,
      quitInstalling: false,
    }),
}));

// ── MODULE STATE ───────────────────────────────────────────────────────────────────────────────
// The Update handle we are holding, on BOTH branches:
//   - auto-apply OFF: found but not downloaded — `stagedVersion` is null.
//   - auto-apply ON:  downloaded, payload in memory — `stagedVersion` is its version.
// Retained across an install FAILURE on purpose, so a retry installs the bytes we already have
// instead of paying for the ~41 MiB download twice.
let stagedUpdate: Update | null = null;

/** The version whose PAYLOAD IS IN MEMORY, or null if nothing is downloaded.
 *
 *  This is a different question from `phase`, and the difference is load-bearing: phase "available"
 *  is set on the auto-apply-OFF path where NOTHING has been downloaded, so `phase` can never answer
 *  "do we already hold the bytes?". `applyUpdateAndRestart` asks exactly that to decide whether it
 *  still needs to download — get it wrong and a failed install re-downloads on every retry. */
let stagedVersion: string | null = null;

/** The check currently running, so overlapping triggers share ONE run — see `checkForUpdates`. */
let inFlight: Promise<CheckOutcome> | null = null;

/** The `Update.install()` running RIGHT NOW, or null.
 *
 *  WHY THIS EXISTS RATHER THAN INFERRING IT FROM `stagedVersion`. `applyUpdateAndRestart` clears
 *  `stagedUpdate`/`stagedVersion` only AFTER its `await update.install()` resolves, so for the whole
 *  duration of a "Restart now" the quit hook's only gate (`!update || stagedVersion === null`)
 *  passed. Press ⌘Q during that spinner and Rust defers the exit, emits the event, and
 *  `installStagedUpdateOnQuit` called `install()` a SECOND time on the same handle. Nothing
 *  downstream dedupes it: the plugin's JS clears `this.downloadedBytes` only after its own invoke
 *  resolves, and the Rust command `get`s (not `take`s) the resource, so both calls reach
 *  `install_inner` — two interleaved rename-aside → `remove_dir_all` → rename-in cycles over
 *  /Applications/Sparkle.app, whose failure mode is a deleted or half-swapped bundle.
 *
 *  ASSIGNED SYNCHRONOUSLY AT THE CALL SITE (see `trackInstall`) — an assignment placed after an
 *  await would reopen exactly the window it closes. */
let installing: Promise<void> | null = null;

/** Publish `p` as THE install in flight and clear it when it settles. Returns `p` unchanged so the
 *  caller still sees the real rejection.
 *
 *  Call as `trackInstall(update.install())`: the assignment happens in the same synchronous turn as
 *  the `install()` call, before any `await` can yield to the quit listener. */
function trackInstall(p: Promise<void>): Promise<void> {
  installing = p;
  const clear = () => {
    // Only if it is still OURS — a later install must not be cleared by an earlier one settling.
    if (installing === p) installing = null;
  };
  // Both arms, so a rejected install still releases the latch AND is never an unhandled rejection.
  void p.then(clear, clear);
  return p;
}

/** THE apply in flight, or null. Coarser than `installing` ON PURPOSE, and the reason is a defect
 *  `installing` alone could not catch (roborev 67426).
 *
 *  `installing` is only published at the moment `install()` is called. On the auto-apply-OFF path
 *  `applyUpdateAndRestart` first downloads, sets `stagedVersion`, and then awaits a full IPC
 *  round trip (`noteStagedForQuit(true)`) — all BEFORE it reaches `trackInstall`. A ⌘Q delivered in
 *  that window sees `installing === null` but `update` and `stagedVersion` both set, so it takes the
 *  "nothing is running, start one" branch; when the IPC resolves, `applyUpdateAndRestart` installs
 *  again on the same handle. Two `install_inner` runs, one bundle: the deleted-app failure mode.
 *
 *  So the invariant is stated over the WHOLE apply rather than over the install call: at most one
 *  apply is ever in flight, and a quit landing anywhere inside it waits for that one instead of
 *  starting its own. Published synchronously on entry — after an await it would reopen the window. */
let applying: Promise<void> | null = null;

/** Test seam: what the module is holding. Not for production callers. */
export function __stagedForTest(): { update: Update | null; version: string | null } {
  return { update: stagedUpdate, version: stagedVersion };
}

/** Test seam: drop module state between cases. Not for production callers. */
export function __resetStagedForTest(): void {
  stagedUpdate = null;
  stagedVersion = null;
  inFlight = null;
  installing = null;
  // `applying` too, and for a sharper reason than symmetry: it is published SYNCHRONOUSLY on entry
  // and settles only when the whole apply does, so a test that leaves one pending — an assertion
  // failing between a gated IPC and its release does exactly that — would make every LATER test's
  // `applyUpdateAndRestart()` return the stale promise and install nothing, and every
  // `installStagedUpdateOnQuit()` await a promise that can never settle. That is a hang or a cascade
  // of failures pointing at the wrong test (roborev 67444).
  applying = null;
  lastCheckAt = 0;
}

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Best-effort release of the plugin's native resource handles. DEBUG, not silence: a leaked
 *  resource is real (it pins the payload until process exit) but is not worth a warn, and pretending
 *  the failure is ignorable is what left this module with nothing to grep. */
async function closeQuietly(update: Update): Promise<void> {
  try {
    await update.close();
  } catch (e) {
    log.debug(SCOPE, "could not close the update resource handle", { error: String(e) });
  }
}

/** Best-effort IPC that must never throw into a quit path or a check. */
async function invokeQuietly(cmd: string, args?: Record<string, unknown>): Promise<void> {
  try {
    await invoke(cmd, args);
  } catch (e) {
    log.debug(SCOPE, `${cmd} failed`, { error: String(e) });
  }
}

/** Arm Rust's install watchdog: this says `Update.install()` is running RIGHT NOW, which is what
 *  promotes the watchdog from its short "is the webview even alive?" budget to the long "let the
 *  rename finish" one. Returns whether Rust actually heard us.
 *
 *  DELIBERATELY NOT `invokeQuietly`. It used to be, and the failure mode was silent and severe: a
 *  transient IPC error left Rust's `INSTALL_STARTED` false while we installed anyway, so the
 *  watchdog took its "the webview never started the staged install" branch and killed the process
 *  at 5s — possibly between `install_inner`'s `remove_dir_all` and its final rename. The two
 *  outcomes are not symmetric. NOT installing is "update delayed": nothing on disk was touched.
 *  Installing with no watchdog armed is "app deleted". So the caller skips the install on false. */
async function armInstallWatchdog(): Promise<boolean> {
  try {
    await invoke("note_update_install_started");
    return true;
  } catch (e) {
    log.warn(SCOPE, "could not tell Rust the install started; skipping it rather than running it unwatched", {
      error: String(e),
    });
    return false;
  }
}

/** Tell Rust whether an install-on-quit is worth deferring the exit for. Rust does NOT prevent an
 *  exit unless this says yes, so an ordinary quit with nothing staged pays nothing. */
async function noteStagedForQuit(staged: boolean): Promise<void> {
  await invokeQuietly("note_staged_update", { staged });
}

/** Does this window own the update poll? Only the initial ("main") window does.
 *
 * Every project window loads this same bundle in its OWN JS context, so module state (`started`,
 * `timer`, `lastCheckAt`, the store) is per-window and can't coordinate: without this guard, N open
 * windows each run their own poller. That means N× the release-feed traffic per interval, and —
 * with auto-apply on — N concurrent downloads each holding their own ~41 MiB payload.
 *
 * "Main" now means the APP window rather than "the window without a `?label=`" — nothing has
 * minted a label since CM-U7 part 2, which quietly made this predicate `true` in the helper and
 * capture webviews too (roborev 46485-M). The auxiliary webviews carry `?view=`. Kept as a pure
 * search-string predicate so it unit-tests in node (startUpdater itself is unreachable in tests
 * behind the packaged/dev guard).
 */
export function isMainWindowSearch(search: string): boolean {
  return isAppWindowSearch(search);
}

/** Outcome of a single update check — lets the user-initiated "Check for updates" show feedback. */
export type CheckOutcome = "update-available" | "up-to-date" | "error";

/**
 * Run one update check and act on the result, RETURNING the outcome so a user-initiated check can
 * show feedback ("Checking…" → up to date / available / failed). Background callers (launch,
 * interval, focus) ignore the return. Never throws: offline / manifest-fetch / signature / download
 * failures resolve to "error" (background callers just retry next interval).
 *
 * OVERLAPPING CALLS SHARE ONE RUN. The interval, the focus listener and the manual button can all
 * fire during a download, and the phase guard below cannot stop them: it reads `phase` BEFORE the
 * await while `setReady` is written AFTER it, so every trigger inside a 30-second download passed.
 * That was already a real race — two redundant installs — and the download/install split makes it
 * expensive, because two passes now mean two full ~41 MiB payloads pinned in the resource table.
 */
export function checkForUpdates(): Promise<CheckOutcome> {
  return (inFlight ??= runUpdateCheck().finally(() => {
    inFlight = null;
  }));
}

async function runUpdateCheck(): Promise<CheckOutcome> {
  // A dismissal decays after one poll interval, so this is where it comes back. Before the guard:
  // the early return below is the normal path once something is staged, and it must not be what
  // keeps a decayed dismissal alive forever.
  useUpdaterStore.getState().expireDismissal();

  // ALREADY HOLDING THE BYTES — never re-download. Deliberately asked FIRST and of module state
  // rather than of `phase`: `phase` answers a UI question ("what is the banner saying"), and the
  // two diverge (a UI reset, or an install that failed after a successful download).
  if (stagedVersion !== null) return "update-available";
  // Already found/surfaced this session — the banner is (or will be) showing it. Re-checking would
  // re-download the same build (and, on the auto-apply-off path, leak the prior Update handle).
  const phase = useUpdaterStore.getState().phase;
  if (phase === "available" || phase === "ready") return "update-available";

  let update: Update | null;
  try {
    // Stamp only a REAL check attempt (after the early-return guard), so the focus-refocus gap
    // reflects actual network checks — a no-op early return doesn't suppress a genuine focus check.
    lastCheckAt = Date.now();
    update = await check();
  } catch (e) {
    // SPLIT FROM THE DOWNLOAD ARM ON PURPOSE. "We could not reach / verify the release manifest"
    // (offline, DNS, signature) and "the download died" are different faults with different
    // remedies, and one `catch {}` over both is why neither was ever visible.
    log.warn(SCOPE, "update check failed", { error: String(e) });
    return "error";
  }
  if (!update) {
    log.debug(SCOPE, "no update available");
    return "up-to-date";
  }

  const notes = update.body ?? null;
  const autoApply = useSettingsStore.getState().autoApplyUpdates;
  if (!autoApply) {
    // Defer BOTH the download and the install until the user chooses "Restart to apply".
    stagedUpdate = update;
    stagedVersion = null;
    useUpdaterStore.getState().setAvailable(update.version, notes);
    log.info(SCOPE, "update available; auto-apply is off so nothing was downloaded", {
      version: update.version,
      currentVersion: update.currentVersion,
    });
    return "update-available";
  }

  // AUTO-APPLY ON: download ONLY. `install()` — which is what deletes the running bundle on macOS —
  // is deliberately NOT called here; it happens at restart or at quit. See the module header.
  try {
    await update.download();
  } catch (e) {
    log.warn(SCOPE, "update download failed", { version: update.version, error: String(e) });
    stagedUpdate = null;
    stagedVersion = null;
    // Dropping the JS handle does NOT free the plugin's `Update` resource — that lives in the
    // webview resource table until it is closed or the process exits. Every failed download would
    // otherwise pin one more, once an hour, for the life of the session.
    await closeQuietly(update);
    return "error";
  }
  stagedUpdate = update;
  stagedVersion = update.version;
  useUpdaterStore.getState().setReady(update.version, notes);
  // NOT `update.close()`. close() runs `downloadedBytes?.close()`, which frees the payload and makes
  // the later install() throw "Update.install called before Update.download" — i.e. it would turn
  // every deferred install into a guaranteed failure. close() moves to AFTER a successful install.
  log.info(SCOPE, "update downloaded and staged in memory; nothing on disk has changed yet", {
    version: update.version,
    currentVersion: update.currentVersion,
  });
  await noteStagedForQuit(true);
  return "update-available";
}

/** Fire-and-forget wrapper for background callers (launch/interval/focus) that don't need the
 *  outcome. Preserves the original void-returning API. */
export async function checkForUpdatesNow(): Promise<void> {
  await checkForUpdates();
}

/**
 * Install the staged update and relaunch into it. Wired to the banner's "Restart now" /
 * "Restart to apply" button. This — plus the quit hook — is the ONLY place the bundle on disk is
 * replaced, and the process is gone about a second later.
 *
 * On failure, clears the busy flag so the user can retry AND RETAINS `stagedUpdate`, so the retry
 * installs the bytes we already hold instead of paying for the download again.
 */
export function applyUpdateAndRestart(): Promise<void> {
  // SYNCHRONOUS, and that is the whole point: `runApplyAndRestart` awaits a download and an IPC
  // round trip before it ever reaches `trackInstall`, and a ⌘Q landing in that gap used to start a
  // second install over the same bundle. Publishing here — in the same turn as the call, before any
  // await can yield to the quit listener — makes "at most one apply in flight" true for the whole
  // function rather than just for its install call.
  if (applying) return applying;
  const p = runApplyAndRestart();
  applying = p;
  const clear = () => {
    // Only if it is still OURS — a later apply must not be cleared by an earlier one settling.
    if (applying === p) applying = null;
  };
  // Both arms: `runApplyAndRestart` swallows its own failures, but a latch that could leak on
  // rejection would wedge every later apply behind a promise that already settled.
  void p.then(clear, clear);
  return p;
}

async function runApplyAndRestart(): Promise<void> {
  const store = useUpdaterStore.getState();
  store.setBusy(true);
  const update = stagedUpdate;
  try {
    if (update) {
      if (stagedVersion === null) {
        // Auto-apply OFF path: found but never downloaded. Download first.
        await update.download();
        stagedVersion = update.version;
        // Tell Rust immediately, not after the install: if the install below fails we keep the
        // bytes, and a quit from that state must still be able to install them. Announcing it only
        // on success would make the quit hook blind to exactly the case it exists for.
        await noteStagedForQuit(true);
      }
      log.info(SCOPE, "installing staged update — replacing the bundle on disk", {
        version: update.version,
        trigger: "restart",
      });
      // Through the latch, so a ⌘Q landing on the spinner WAITS for this install instead of
      // starting a second one over the same bundle.
      await trackInstall(update.install());
      stagedUpdate = null;
      stagedVersion = null;
      await noteStagedForQuit(false);
      await closeQuietly(update);
    }
    await relaunch();
  } catch (e) {
    // Apply/relaunch failed — let the user try again rather than getting stuck on a spinner. The
    // handle stays put (see above), so a retry does not re-download.
    log.error(SCOPE, "installing the update and restarting failed", {
      version: update?.version ?? null,
      stillStaged: stagedVersion !== null,
      error: String(e),
    });
    store.setBusy(false);
  }
}

/**
 * Install the staged update because the app is exiting, then let the exit proceed.
 *
 * THE EXIT IS UNCONDITIONAL. Every path through this function ends in `resume_exit_after_update`,
 * including an install that rejects and including "there was nothing staged" — a user who cannot
 * quit their app is a far worse bug than the one this whole change fixes. Rust holds a second,
 * independent backstop timer for the case where this function never runs at all.
 *
 * DELIBERATELY NOT WRAPPED IN A JS TIMEOUT. A JS deadline cannot cancel the Rust install; it can
 * only stop waiting for it — and resuming the exit while `install_inner` is between its
 * `remove_dir_all` and its final rename would leave /Applications/Sparkle.app DELETED. The bound
 * therefore lives in Rust, in two phases, where it can tell "the webview never answered" (safe to
 * kill — nothing started) from "an install is running" (must be allowed to finish). See lib.rs.
 */
export async function installStagedUpdateOnQuit(): Promise<void> {
  const update = stagedUpdate;
  // Read the latch BEFORE any await: this function is invoked from an event callback that can land
  // in the middle of `applyUpdateAndRestart`, and the whole point is to see the install it started.
  // `applying` FIRST: it covers the download + IPC prologue that `installing` structurally cannot
  // (see its declaration). Falling back to `installing` keeps a quit landing on an install started
  // by some other path — a previous apply that already cleared `applying` — still waiting for it.
  const alreadyRunning = applying ?? installing;
  const store = useUpdaterStore.getState();
  try {
    if (alreadyRunning) {
      // "Restart now" is mid-install and the user quit on top of it. WAIT for that install; do not
      // start a second one. Both would hand the SAME `bytesRid` to Rust and both would reach
      // `install_inner`, interleaving two rename-aside → remove_dir_all → rename-in cycles over
      // /Applications/Sparkle.app.
      store.setQuitInstalling(true);
      log.info(SCOPE, "quit during an install already in flight — waiting for it, not starting a second", {
        version: update?.version ?? null,
      });
      if (!(await armInstallWatchdog())) {
        // The ack failed, but unlike the case below we CANNOT skip: the rename is already running.
        // Resuming the exit now is the very thing that deletes the bundle, so we wait anyway and
        // let Rust's watchdog be the bound.
        log.warn(SCOPE, "the install watchdog could not be armed for an install already running; waiting for it regardless");
      }
      await alreadyRunning;
      return;
    }
    if (!update || stagedVersion === null) {
      log.debug(SCOPE, "exit requested with nothing staged; nothing to install");
      return;
    }
    // Tell Rust an install has actually STARTED, so its watchdog switches from the short
    // "is the webview alive?" budget to the long "let the install finish" one. If it does not hear
    // us, DO NOT INSTALL: an unwatched install can be killed mid-rename, while a skipped one just
    // means the update lands next launch.
    if (!(await armInstallWatchdog())) return;
    // The bundle swap takes multiple seconds and the window stays open through it. Say so, or the
    // user presses ⌘Q again — which is the hazard Rust's `hold_second_exit` exists to catch.
    store.setQuitInstalling(true);
    store.setBusy(true);
    log.info(SCOPE, "installing staged update — replacing the bundle on disk", {
      version: update.version,
      trigger: "quit",
    });
    await trackInstall(update.install());
    stagedUpdate = null;
    stagedVersion = null;
    await closeQuietly(update);
    log.info(SCOPE, "staged update installed on quit", { version: update.version });
  } catch (e) {
    // DELAYED, NOT BROKEN: nothing on disk was touched, so the next session re-checks, re-downloads
    // and the "Restart now" button still works. The only cost is one repeated download.
    log.error(SCOPE, "installing the staged update on quit failed — the update is delayed, not lost", {
      version: update?.version ?? null,
      error: String(e),
    });
  } finally {
    await invokeQuietly("resume_exit_after_update");
    // The process is about to go, but if anything holds it the UI must not keep claiming an install
    // is running. `resume_exit_after_update` goes through `invokeQuietly`, so a failed IPC is
    // swallowed and the process SURVIVES — and in that state the catch above has deliberately kept
    // `stagedUpdate` / phase "ready" so the user can retry. Leaving `busy` set renders that retry
    // button disabled behind a spinner, so the recovery we just preserved would be unreachable
    // (roborev 67426). Clear BOTH flags, not just the one this block was first written for.
    store.setQuitInstalling(false);
    store.setBusy(false);
  }
}

// Guard against double-starts (e.g. React StrictMode double-mount) and hold the interval + focus
// listener handles for cleanup.
let started = false;
let timer: ReturnType<typeof setInterval> | null = null;
let onFocus: (() => void) | null = null;
let unlistenQuit: (() => void) | null = null;

/**
 * Begin polling for updates: once at launch, every `intervalMs` (default 60min), AND whenever the
 * app window regains focus — so a release cut while the app was backgrounded is noticed within
 * seconds of the user returning, not up to a full interval later. The focus check is guarded by
 * MIN_CHECK_GAP_MS so rapid alt-tabbing doesn't spam the feed. Also subscribes to Rust's
 * install-before-exit request. No-ops in dev / the browser preview / when not packaged — the updater
 * plugin and signed manifest only exist in a real build, so running check() there only generates
 * noise (and is why an HMR reload can never orphan a downloaded payload) — and in secondary project
 * windows, which would otherwise each poll independently (see isMainWindowSearch). Returns a cleanup
 * that stops the interval and removes the listeners.
 */
export function startUpdater(intervalMs: number = DEFAULT_UPDATE_INTERVAL_MS): () => void {
  // inTauri() short-circuits first, so window.location is safe to read here.
  if (started || !inTauri() || import.meta.env.DEV || !isMainWindowSearch(window.location.search))
    return () => {};
  started = true;
  void checkForUpdates();
  timer = setInterval(() => void checkForUpdates(), intervalMs);
  onFocus = () => {
    if (Date.now() - lastCheckAt >= MIN_CHECK_GAP_MS) void checkForUpdates();
  };
  window.addEventListener("focus", onFocus);
  void listen(INSTALL_BEFORE_EXIT_EVENT, () => void installStagedUpdateOnQuit())
    .then((un) => {
      unlistenQuit = un;
    })
    .catch((e) => log.warn(SCOPE, `could not listen for ${INSTALL_BEFORE_EXIT_EVENT}`, { error: String(e) }));
  return () => {
    if (timer) clearInterval(timer);
    timer = null;
    if (onFocus) window.removeEventListener("focus", onFocus);
    onFocus = null;
    if (unlistenQuit) unlistenQuit();
    unlistenQuit = null;
    started = false;
  };
}
