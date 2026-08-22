// updaterService tests — node env. We mock the Tauri updater + process + event plugins, the IPC
// wrapper and the logger, and drive the decision logic directly via checkForUpdates /
// applyUpdateAndRestart / installStagedUpdateOnQuit so the dev/packaged guard in startUpdater
// doesn't get in the way.
//
// WHAT THESE TESTS ARE ACTUALLY GUARDING (bead sparkle-1ueh3). The auto-apply path used to call
// `downloadAndInstall()`, which on macOS DELETES the bundle the running process was launched from —
// silently killing that process's microphone for the rest of its life, hours before anyone
// restarts. Every case below is written so that restoring the old behaviour makes it RED; the
// mutation each one pins is named in its comment. A test here that passes against
// `downloadAndInstall()` is worthless, because that is exactly the code it exists to keep out.
import { describe, it, expect, vi, beforeEach } from "vitest";

const check = vi.fn();
vi.mock("@tauri-apps/plugin-updater", () => ({
  check: (...a: unknown[]) => check(...a),
}));

const relaunch = vi.fn();
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: (...a: unknown[]) => relaunch(...a),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

const { invokeSpy, logSpy } = vi.hoisted(() => ({
  invokeSpy: vi.fn(() => Promise.resolve(undefined)),
  logSpy: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("./ipc", () => ({ invoke: (...a: unknown[]) => invokeSpy(...(a as [])) }));
vi.mock("../logger", () => ({ log: logSpy }));

import {
  checkForUpdates,
  checkForUpdatesNow,
  applyUpdateAndRestart,
  installStagedUpdateOnQuit,
  useUpdaterStore,
  isMainWindowSearch,
  DEFAULT_UPDATE_INTERVAL_MS,
  MIN_CHECK_GAP_MS,
  DISMISS_TTL_MS,
  INSTALL_BEFORE_EXIT_EVENT,
  __stagedForTest,
  __resetStagedForTest,
} from "./updaterService";
import { useSettingsStore } from "../stores/settingsStore";

/** A minimal stand-in for the plugin's `Update` resource — download and install SEPARATE, as the
 *  real one exposes them (node_modules/@tauri-apps/plugin-updater/dist-js/index.d.ts). */
function makeUpdate(over: Record<string, unknown> = {}) {
  return {
    version: "9.9.9",
    body: "Release notes",
    currentVersion: "0.3.0",
    download: vi.fn(() => Promise.resolve()),
    install: vi.fn(() => Promise.resolve()),
    downloadAndInstall: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    ...over,
  };
}

/** Which Rust commands the module asked for, in order. */
const invokedCommands = (): unknown[] => invokeSpy.mock.calls.map((c) => (c as unknown[])[0]);

/** The `invocationCallOrder` of the first `log.info` whose message is `message`, or -1. */
function infoOrder(message: string): number {
  const i = logSpy.info.mock.calls.findIndex((c) => (c as unknown[])[1] === message);
  return i < 0 ? -1 : (logSpy.info.mock.invocationCallOrder[i] as number);
}

beforeEach(() => {
  check.mockReset();
  relaunch.mockReset();
  relaunch.mockResolvedValue(undefined);
  invokeSpy.mockReset();
  invokeSpy.mockResolvedValue(undefined);
  logSpy.debug.mockReset();
  logSpy.info.mockReset();
  logSpy.warn.mockReset();
  logSpy.error.mockReset();
  useUpdaterStore.getState().reset();
  __resetStagedForTest();
  useSettingsStore.setState({ autoApplyUpdates: true });
});

describe("the download/install split (the whole point of bead sparkle-1ueh3)", () => {
  it("auto-apply ON downloads and does NOT install — nothing on disk is touched", async () => {
    // MUTATION THIS PINS: restore `await update.downloadAndInstall()`. That call is what replaces
    // /Applications/Sparkle.app under the live process and kills its microphone.
    useSettingsStore.setState({ autoApplyUpdates: true });
    const update = makeUpdate();
    check.mockResolvedValue(update);

    await checkForUpdatesNow();

    expect(update.download).toHaveBeenCalledTimes(1);
    expect(update.install).not.toHaveBeenCalled();
    expect(update.downloadAndInstall).not.toHaveBeenCalled();
    const s = useUpdaterStore.getState();
    expect(s.phase).toBe("ready");
    expect(s.version).toBe("9.9.9");
    expect(s.notes).toBe("Release notes");
  });

  it("does NOT close() the handle between download and install", async () => {
    // MUTATION THIS PINS: reinstate the `await update.close()` that used to follow the install on
    // the auto-apply branch. close() runs `downloadedBytes?.close()`, which frees the payload — so
    // every later install() throws "Update.install called before Update.download" and the deferred
    // install can NEVER succeed. Silent: the check itself still reports success.
    const update = makeUpdate();
    check.mockResolvedValue(update);

    await checkForUpdatesNow();

    expect(update.close).not.toHaveBeenCalled();
    expect(__stagedForTest().version).toBe("9.9.9");

    // …and the retained handle still installs, which is the property close() would have destroyed.
    await applyUpdateAndRestart();
    expect(update.install).toHaveBeenCalledTimes(1);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("closes the handle only AFTER a successful install", async () => {
    const update = makeUpdate();
    check.mockResolvedValue(update);
    await checkForUpdatesNow();
    await applyUpdateAndRestart();

    expect(update.close).toHaveBeenCalledTimes(1);
    expect(update.install.mock.invocationCallOrder[0]!).toBeLessThan(
      update.close.mock.invocationCallOrder[0]!,
    );
  });

  it("auto-apply OFF surfaces the prompt and downloads NOTHING", async () => {
    useSettingsStore.setState({ autoApplyUpdates: false });
    const update = makeUpdate();
    check.mockResolvedValue(update);

    await checkForUpdatesNow();

    expect(update.download).not.toHaveBeenCalled();
    expect(update.install).not.toHaveBeenCalled();
    expect(update.downloadAndInstall).not.toHaveBeenCalled();
    const s = useUpdaterStore.getState();
    expect(s.phase).toBe("available");
    expect(s.version).toBe("9.9.9");
    // The handle is retained on BOTH branches now; only `stagedVersion` distinguishes them.
    expect(__stagedForTest().update).toBe(update);
    expect(__stagedForTest().version).toBeNull();
  });

  it("a failed download stages nothing, releases the handle, and the next check retries cleanly", async () => {
    // MUTATION THIS PINS: drop the `closeQuietly(update)` on the download-failure path. Nulling the
    // JS handle does not free the plugin's `Update` resource — it lives in the webview resource
    // table until closed or process exit — so a download that fails once an hour would pin one more
    // for the life of the session, invisibly.
    const update = makeUpdate({ download: vi.fn(() => Promise.reject(new Error("connection reset"))) });
    check.mockResolvedValue(update);

    await expect(checkForUpdates()).resolves.toBe("error");
    expect(__stagedForTest().version).toBeNull();
    expect(update.close).toHaveBeenCalledTimes(1);
    expect(useUpdaterStore.getState().phase).toBe("idle");

    const second = makeUpdate();
    check.mockResolvedValue(second);
    await expect(checkForUpdates()).resolves.toBe("update-available");
    expect(second.download).toHaveBeenCalledTimes(1);
  });
});

describe("install ordering and failure handling", () => {
  it("install() runs BEFORE relaunch()", async () => {
    // ASSERTED VIA invocationCallOrder, NOT call counts. Reading the assertions in source order
    // proves nothing about the order the calls actually happened in, and getting this backwards
    // ships an app that relaunches into the OLD bundle every time.
    // MUTATION THIS PINS: swap the `await update.install()` and `await relaunch()` lines.
    const update = makeUpdate();
    check.mockResolvedValue(update);
    await checkForUpdatesNow();

    await applyUpdateAndRestart();

    expect(update.install).toHaveBeenCalledTimes(1);
    expect(relaunch).toHaveBeenCalledTimes(1);
    expect(update.install.mock.invocationCallOrder[0]!).toBeLessThan(
      relaunch.mock.invocationCallOrder[0]!,
    );
  });

  it("install rejecting leaves the update STAGED, skips relaunch, and clears busy", async () => {
    const update = makeUpdate({ install: vi.fn(() => Promise.reject(new Error("read-only volume"))) });
    check.mockResolvedValue(update);
    await checkForUpdatesNow();

    await expect(applyUpdateAndRestart()).resolves.toBeUndefined();

    expect(relaunch).not.toHaveBeenCalled();
    expect(useUpdaterStore.getState().busy).toBe(false);
    // Retained: a retry must not pay for the ~41 MiB download a second time.
    expect(__stagedForTest().update).toBe(update);
    expect(__stagedForTest().version).toBe("9.9.9");
    expect(logSpy.error).toHaveBeenCalled();
  });

  it("auto-apply OFF: a retry after a failed install does NOT re-download", async () => {
    // MUTATION THIS PINS: drop the `if (stagedVersion === null)` guard in applyUpdateAndRestart.
    // `phase` cannot answer this question — it is "available" both before and after the download —
    // which is exactly why `stagedVersion` exists as separate state.
    useSettingsStore.setState({ autoApplyUpdates: false });
    const install = vi
      .fn()
      .mockRejectedValueOnce(new Error("install failed"))
      .mockResolvedValue(undefined);
    const update = makeUpdate({ install });
    check.mockResolvedValue(update);
    await checkForUpdatesNow();

    await applyUpdateAndRestart();
    expect(update.download).toHaveBeenCalledTimes(1);
    expect(relaunch).not.toHaveBeenCalled();

    await applyUpdateAndRestart();
    expect(update.download).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledTimes(2);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("relaunch failure clears the busy flag so the user can retry", async () => {
    check.mockResolvedValue(makeUpdate());
    await checkForUpdatesNow();
    relaunch.mockRejectedValueOnce(new Error("relaunch failed"));

    await expect(applyUpdateAndRestart()).resolves.toBeUndefined();
    expect(useUpdaterStore.getState().busy).toBe(false);
  });
});

describe("the two guards that stop a second payload being downloaded", () => {
  it("a check while something is already staged does NOT download again", async () => {
    // MUTATION THIS PINS: drop the `stagedVersion !== null` guard, leaving only the `phase` one.
    // The UI store is reset here because that is precisely where the two diverge: `phase` describes
    // what the BANNER is saying, and the download guard must not be derived from UI state — a
    // reset banner with a live ~41 MiB payload in the resource table must still not re-download.
    const first = makeUpdate();
    check.mockResolvedValue(first);
    await checkForUpdatesNow();
    expect(first.download).toHaveBeenCalledTimes(1);

    useUpdaterStore.getState().reset();
    const second = makeUpdate();
    check.mockResolvedValue(second);

    await expect(checkForUpdates()).resolves.toBe("update-available");
    expect(check).toHaveBeenCalledTimes(1);
    expect(second.download).not.toHaveBeenCalled();
  });

  it("two overlapping checks during a slow download produce exactly ONE download", async () => {
    // MUTATION THIS PINS: drop `inFlight`. This test FAILS against the pre-split code, which is the
    // point — the guard read `phase` BEFORE the await while `setReady` was written AFTER it, so the
    // interval and the focus listener both sailed through a 30-second download. That was two
    // redundant installs before; after the split it is two full in-memory payloads.
    // The deferred is built BEFORE the update so `release` is assigned synchronously — resolving it
    // from inside the `download` mock would run only after check() had already settled.
    let release!: () => void;
    const downloading = new Promise<void>((r) => {
      release = r;
    });
    const update = makeUpdate({ download: vi.fn(() => downloading) });
    check.mockResolvedValue(update);

    const a = checkForUpdates();
    const b = checkForUpdates();
    release();
    const [ra, rb] = await Promise.all([a, b]);

    expect(check).toHaveBeenCalledTimes(1);
    expect(update.download).toHaveBeenCalledTimes(1);
    expect(ra).toBe("update-available");
    expect(rb).toBe("update-available");
  });

  it("the in-flight latch clears, so a later check still runs", async () => {
    check.mockResolvedValue(null);
    await checkForUpdates();
    await checkForUpdates();
    expect(check).toHaveBeenCalledTimes(2);
  });
});

describe("install on quit — must never wedge the quit", () => {
  it("installs the staged update, then resumes the exit", async () => {
    const update = makeUpdate();
    check.mockResolvedValue(update);
    await checkForUpdatesNow();
    invokeSpy.mockClear();

    await installStagedUpdateOnQuit();

    expect(update.install).toHaveBeenCalledTimes(1);
    expect(invokedCommands()).toEqual([
      "note_update_install_started",
      "resume_exit_after_update",
    ]);
    expect(__stagedForTest().update).toBeNull();
  });

  it("STILL EXITS when install() rejects", async () => {
    // THE HALF THAT MATTERS. A user who cannot quit their app is a far worse bug than the one this
    // whole change fixes, so the resume lives in a `finally`.
    // MUTATION THIS PINS: move `resume_exit_after_update` out of the `finally` into the `try`.
    const update = makeUpdate({ install: vi.fn(() => Promise.reject(new Error("install exploded"))) });
    check.mockResolvedValue(update);
    await checkForUpdatesNow();
    invokeSpy.mockClear();

    await expect(installStagedUpdateOnQuit()).resolves.toBeUndefined();

    expect(invokedCommands()).toContain("resume_exit_after_update");
    expect(logSpy.error).toHaveBeenCalled();
  });

  it("STILL EXITS when nothing is staged", async () => {
    await expect(installStagedUpdateOnQuit()).resolves.toBeUndefined();
    expect(invokedCommands()).toEqual(["resume_exit_after_update"]);
  });

  it("SKIPS the install and STILL EXITS when the watchdog ack fails", async () => {
    // MUTATION THIS PINS: send `note_update_install_started` through `invokeQuietly` again (i.e.
    // swallow the failure and install anyway). Rust's INSTALL_STARTED then stays false, its
    // watchdog takes the "the webview never started the staged install" branch and kills the
    // process at 5s — possibly between `install_inner`'s `remove_dir_all` and its final rename,
    // which leaves /Applications/Sparkle.app deleted. Skipping is the SAFE half of the trade:
    // nothing on disk was touched, so the update simply lands next launch.
    const update = makeUpdate();
    check.mockResolvedValue(update);
    await checkForUpdatesNow();
    invokeSpy.mockClear();
    invokeSpy.mockRejectedValue(new Error("ipc is gone"));

    await expect(installStagedUpdateOnQuit()).resolves.toBeUndefined();

    expect(update.install).not.toHaveBeenCalled();
    expect(__stagedForTest().version).toBe("9.9.9"); // still staged — delayed, not lost
    expect(invokedCommands()).toContain("resume_exit_after_update");
    expect(logSpy.warn).toHaveBeenCalled();
  });

  it("a quit landing on a RUNNING install waits for it — install() runs exactly ONCE", async () => {
    // THE HAZARD: `applyUpdateAndRestart` clears stagedUpdate/stagedVersion only AFTER install()
    // resolves, so ⌘Q during the "Restart now" spinner passed the old `stagedVersion === null` gate
    // and called install() a second time on the SAME handle. The plugin clears `downloadedBytes`
    // only after its own invoke resolves and the Rust command `get`s rather than `take`s the
    // resource, so both calls reach `install_inner`: two interleaved rename-aside →
    // remove_dir_all → rename-in cycles over /Applications/Sparkle.app.
    // MUTATION THIS PINS: drop the `installing` latch and gate the quit path on `stagedVersion`
    // again (or assign the latch AFTER an await, which reopens the same window).
    // ONE shared pending promise, so a second install() call is visible as a COUNT rather than as a
    // hang: with the latch removed this test must fail on the assertion below, not by timing out.
    let finishInstall!: () => void;
    const pending = new Promise<void>((res) => {
      finishInstall = res;
    });
    const update = makeUpdate({ install: vi.fn(() => pending) });
    check.mockResolvedValue(update);
    await checkForUpdatesNow();
    invokeSpy.mockClear();

    const restart = applyUpdateAndRestart(); // hangs inside install()
    await Promise.resolve();
    expect(update.install).toHaveBeenCalledTimes(1);

    const quit = installStagedUpdateOnQuit(); // ⌘Q lands on the spinner
    await Promise.resolve();
    // It must NOT have started its own install while the first one is still running.
    expect(update.install).toHaveBeenCalledTimes(1);

    finishInstall();
    await quit;
    await restart;

    expect(update.install).toHaveBeenCalledTimes(1);
    // ...and the exit is still resumed, with the watchdog armed for the install it waited on.
    expect(invokedCommands()).toContain("note_update_install_started");
    expect(invokedCommands()).toContain("resume_exit_after_update");
  });

  it("auto-apply OFF: a ⌘Q inside the download→IPC prologue still installs exactly ONCE", async () => {
    // roborev 67426. MUTATION THIS PINS: narrow the quit gate back to `installing` alone (drop
    // `applying`). `installing` is published only when `install()` is CALLED, but this path awaits
    // `download()` and then a full `note_staged_update` IPC round trip BEFORE it gets there — and
    // `stagedVersion` is already set by then, so the quit gate's own precondition passes while the
    // latch is still null. The quit starts its own install, the prologue finishes and installs
    // again: two `install_inner` runs over one bundle, whose failure mode is a DELETED app.
    // The existing overlap test cannot catch this — it drives the auto-apply-ON path, where entry
    // to install() is fully synchronous and the window does not exist.
    useSettingsStore.setState({ autoApplyUpdates: false });
    const update = makeUpdate();
    check.mockResolvedValue(update);
    await checkForUpdatesNow(); // phase "available": handle held, nothing downloaded
    expect(__stagedForTest().version).toBeNull();

    // Hold the FIRST invoke open so the prologue parks exactly where the bug lives. That first call
    // is `noteStagedForQuit(true)` — the await between "stagedVersion is set" (so the quit gate's
    // own precondition passes) and "install() is called" (so `installing` is still null).
    let releaseIpc!: () => void;
    const ipcGate = new Promise<undefined>((res) => {
      releaseIpc = () => res(undefined);
    });
    invokeSpy.mockClear();
    invokeSpy.mockReturnValueOnce(ipcGate);

    const restart = applyUpdateAndRestart();
    await Promise.resolve(); // download() resolves
    await Promise.resolve(); // stagedVersion set; parked in noteStagedForQuit
    expect(update.download).toHaveBeenCalledTimes(1);
    expect(update.install).not.toHaveBeenCalled();

    const quit = installStagedUpdateOnQuit(); // ⌘Q lands in the gap
    await Promise.resolve();
    expect(update.install).not.toHaveBeenCalled();

    releaseIpc();
    await restart;
    await quit;

    expect(update.install).toHaveBeenCalledTimes(1);
    expect(invokedCommands()).toContain("resume_exit_after_update");
  });

  it("two 'Restart to apply' clicks inside the prologue coalesce into ONE apply", async () => {
    // roborev 67441. MUTATION THIS PINS: delete `if (applying) return applying;` from
    // applyUpdateAndRestart. The quit-side tests all read the latch (`applying ?? installing`);
    // NOTHING covered the concurrent-ENTRY half, so removing that line left the suite green while
    // restoring a real double-apply — two clicks inside the download→IPC prologue each run the body
    // and each reach install() on the same handle, which is the two-install_inner-over-one-bundle
    // failure mode the whole change exists to prevent. It is also a behaviour change in its own
    // right: a second click used to re-run the body and now returns the first promise.
    useSettingsStore.setState({ autoApplyUpdates: false });
    const update = makeUpdate();
    check.mockResolvedValue(update);
    await checkForUpdatesNow();

    let releaseIpc!: () => void;
    const ipcGate = new Promise<undefined>((res) => {
      releaseIpc = () => res(undefined);
    });
    invokeSpy.mockClear();
    invokeSpy.mockReturnValueOnce(ipcGate);

    const first = applyUpdateAndRestart();
    await Promise.resolve();
    await Promise.resolve(); // parked in noteStagedForQuit
    const second = applyUpdateAndRestart(); // the impatient second click

    expect(second).toBe(first);

    releaseIpc();
    await first;
    await second;

    expect(update.download).toHaveBeenCalledTimes(1);
    expect(update.install).toHaveBeenCalledTimes(1);
  });

  it("a quit whose exit never resumes leaves the retry button USABLE", async () => {
    // roborev 67426. MUTATION THIS PINS: clear only `quitInstalling` in the quit path's `finally`
    // and leave `busy` set. `resume_exit_after_update` goes through the quiet invoke, so a failed
    // IPC is swallowed and the process SURVIVES — and the catch deliberately retains the handle so
    // the user can retry. A stuck `busy` renders that retry disabled behind a spinner, so the
    // recovery we just preserved is unreachable. Assert the SIDE EFFECT (the button is usable),
    // not the flag.
    const update = makeUpdate({ install: vi.fn(() => Promise.reject(new Error("swap failed"))) });
    check.mockResolvedValue(update);
    await checkForUpdatesNow();

    await installStagedUpdateOnQuit();

    const s = useUpdaterStore.getState();
    expect(s.busy).toBe(false);
    expect(s.quitInstalling).toBe(false);
    // The handle is still held, so the retry it preserved does not re-download.
    expect(__stagedForTest().update).toBe(update);
  });

  it("the quit-time install is VISIBLE — an invisible one is what makes the user press ⌘Q again", async () => {
    // MUTATION THIS PINS: drop `setQuitInstalling(true)` from the quit path. The window then sits
    // there saying nothing for the whole multi-second bundle swap, which is exactly what produces
    // the second quit that Rust's `hold_second_exit` had to be written to survive.
    let finishInstall!: () => void;
    const pending = new Promise<void>((res) => {
      finishInstall = res;
    });
    const update = makeUpdate({ install: vi.fn(() => pending) });
    check.mockResolvedValue(update);
    await checkForUpdatesNow();
    useUpdaterStore.getState().dismiss(); // "Later" must NOT hide a freeze
    expect(useUpdaterStore.getState().quitInstalling).toBe(false);

    const quit = installStagedUpdateOnQuit();
    await Promise.resolve();
    await Promise.resolve();

    expect(useUpdaterStore.getState().quitInstalling).toBe(true);

    finishInstall();
    await quit;
  });

  it("tells Rust when an update is staged, and when it no longer is", async () => {
    // Rust never prevents an exit unless this says yes, so a wrong answer either wedges an ordinary
    // quit or silently disables the hook.
    const update = makeUpdate();
    check.mockResolvedValue(update);
    await checkForUpdatesNow();
    expect(invokeSpy).toHaveBeenCalledWith("note_staged_update", { staged: true });

    invokeSpy.mockClear();
    await applyUpdateAndRestart();
    expect(invokeSpy).toHaveBeenCalledWith("note_staged_update", { staged: false });
  });

  it("arms the quit hook as soon as the auto-apply-OFF path has DOWNLOADED, not after it installs", async () => {
    // MUTATION THIS PINS: move the `noteStagedForQuit(true)` to after a successful install, or drop
    // it. The state that needs the quit hook most is "bytes in memory, install just failed" — if
    // Rust is only told on success, it never defers an exit in exactly that case and the ~41 MiB is
    // discarded on quit.
    useSettingsStore.setState({ autoApplyUpdates: false });
    const update = makeUpdate({ install: vi.fn(() => Promise.reject(new Error("install failed"))) });
    check.mockResolvedValue(update);
    await checkForUpdatesNow();
    invokeSpy.mockClear();

    await applyUpdateAndRestart();

    expect(update.download).toHaveBeenCalledTimes(1);
    expect(invokeSpy).toHaveBeenCalledWith("note_staged_update", { staged: true });
    expect(invokeSpy).not.toHaveBeenCalledWith("note_staged_update", { staged: false });
    expect(__stagedForTest().version).toBe("9.9.9");
  });

  it("names the same event Rust emits", () => {
    // The Rust side asserts the reverse direction (lib.rs `updater_quit` tests read this file).
    expect(INSTALL_BEFORE_EXIT_EVENT).toBe("updater://install-before-exit");
  });
});

describe("logging — the line that pays for the whole step", () => {
  it("logs the bundle swap at INFO immediately BEFORE install(), on both triggers", async () => {
    // This line timestamps the bundle swap in the SAME log file as the dictation watchdog's
    // microphone fault (frontend_log → tracing), which is what makes the correlation one grep.
    // Logged before the call, not after, so it survives an install that never returns.
    const swap = "installing staged update — replacing the bundle on disk";

    const update = makeUpdate();
    check.mockResolvedValue(update);
    await checkForUpdatesNow();
    await applyUpdateAndRestart();
    expect(infoOrder(swap)).toBeGreaterThan(-1);
    expect(infoOrder(swap)).toBeLessThan(update.install.mock.invocationCallOrder[0]!);
    expect(logSpy.info.mock.calls.find((c) => (c as unknown[])[1] === swap)?.[2]).toMatchObject({
      trigger: "restart",
    });

    logSpy.info.mockReset();
    __resetStagedForTest();
    useUpdaterStore.getState().reset();
    const quitUpdate = makeUpdate();
    check.mockResolvedValue(quitUpdate);
    await checkForUpdatesNow();
    await installStagedUpdateOnQuit();
    expect(infoOrder(swap)).toBeGreaterThan(-1);
    expect(infoOrder(swap)).toBeLessThan(quitUpdate.install.mock.invocationCallOrder[0]!);
    expect(logSpy.info.mock.calls.find((c) => (c as unknown[])[1] === swap)?.[2]).toMatchObject({
      trigger: "quit",
    });
  });

  it("distinguishes a failed CHECK from a failed DOWNLOAD", async () => {
    // One `catch {}` over both is why this incident took 43 fault events to characterize: "offline"
    // and "the download died" have different remedies and were indistinguishable.
    check.mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));
    await expect(checkForUpdates()).resolves.toBe("error");
    const checkMsg = logSpy.warn.mock.calls.map((c) => (c as unknown[])[1]);
    expect(checkMsg).toContain("update check failed");

    logSpy.warn.mockReset();
    __resetStagedForTest();
    check.mockReset();
    check.mockResolvedValue(makeUpdate({ download: vi.fn(() => Promise.reject(new Error("EPIPE"))) }));
    await expect(checkForUpdates()).resolves.toBe("error");
    const dlMsg = logSpy.warn.mock.calls.map((c) => (c as unknown[])[1]);
    expect(dlMsg).toContain("update download failed");
    expect(dlMsg).not.toContain("update check failed");
  });

  it("drops a failed resource close to DEBUG rather than swallowing it", async () => {
    const update = makeUpdate({ close: vi.fn(() => Promise.reject(new Error("bad rid"))) });
    check.mockResolvedValue(update);
    await checkForUpdatesNow();
    await applyUpdateAndRestart();

    expect(logSpy.debug.mock.calls.map((c) => (c as unknown[])[1])).toContain(
      "could not close the update resource handle",
    );
    // …and it must not have derailed the restart.
    expect(relaunch).toHaveBeenCalledTimes(1);
  });
});

describe("the dismissal decays", () => {
  it("a fresh dismissal survives the next poll; a stale one is cleared by it", async () => {
    // MUTATION THIS PINS: make `dismiss()` permanent again (a boolean nothing clears). One click on
    // "Later" then silenced the update for the whole session, because the phase guard stops
    // `setReady` from ever firing a second time — there is no other event that could bring it back.
    check.mockResolvedValue(makeUpdate());
    await checkForUpdatesNow();
    useUpdaterStore.getState().dismiss();
    expect(useUpdaterStore.getState().dismissedAt).not.toBeNull();

    await checkForUpdatesNow();
    expect(useUpdaterStore.getState().dismissedAt).not.toBeNull();

    useUpdaterStore.setState({ dismissedAt: Date.now() - DISMISS_TTL_MS - 1 });
    await checkForUpdatesNow();
    expect(useUpdaterStore.getState().dismissedAt).toBeNull();
  });

  it("decays after exactly one poll interval", () => {
    expect(DISMISS_TTL_MS).toBe(DEFAULT_UPDATE_INTERVAL_MS);
  });
});

describe("checkForUpdates (returns an outcome for the manual check)", () => {
  it("no update → 'up-to-date', stays idle", async () => {
    check.mockResolvedValue(null);
    await expect(checkForUpdates()).resolves.toBe("up-to-date");
    expect(useUpdaterStore.getState().phase).toBe("idle");
  });

  it("check throws → 'error' (never throws), stays idle", async () => {
    check.mockRejectedValue(new Error("offline / signature mismatch"));
    await expect(checkForUpdates()).resolves.toBe("error");
    expect(useUpdaterStore.getState().phase).toBe("idle");
  });

  it("update found, auto-apply ON → 'update-available', phase 'ready'", async () => {
    useSettingsStore.setState({ autoApplyUpdates: true });
    check.mockResolvedValue(makeUpdate());
    await expect(checkForUpdates()).resolves.toBe("update-available");
    expect(useUpdaterStore.getState().phase).toBe("ready");
  });

  it("update found, auto-apply OFF → 'update-available', phase 'available'", async () => {
    useSettingsStore.setState({ autoApplyUpdates: false });
    check.mockResolvedValue(makeUpdate());
    await expect(checkForUpdates()).resolves.toBe("update-available");
    expect(useUpdaterStore.getState().phase).toBe("available");
  });

  it("already 'available' → 'update-available' WITHOUT re-checking (no re-download / handle leak)", async () => {
    useUpdaterStore.getState().setAvailable("9.9.9", null);
    check.mockResolvedValue(makeUpdate());
    await expect(checkForUpdates()).resolves.toBe("update-available");
    expect(check).not.toHaveBeenCalled();
  });

  it("already 'ready' → skips re-checking (no duplicate download)", async () => {
    useUpdaterStore.getState().setReady("9.9.9", null);
    check.mockResolvedValue(makeUpdate());
    await checkForUpdatesNow();
    expect(check).not.toHaveBeenCalled();
  });
});

describe("isMainWindowSearch (only the app window polls)", () => {
  it("the app window (bare index.html, no ?view=) owns the poll", () => {
    expect(isMainWindowSearch("")).toBe(true);
    expect(isMainWindowSearch("?project=p1")).toBe(true);
  });

  it("the helper + capture webviews do NOT poll", () => {
    // These are the only auxiliary webviews, and `?view=` is the only marker they carry
    // (src-tauri/src/helper.rs, capture_window.rs). The predicate used to test for an absent
    // `?label=`, which nothing has minted since CM-U7 part 2 — so both webviews polled too
    // (roborev 46485-M). It then pinned `?view=tray`, a webview that no longer exists, which is
    // how the helper island shipped polling for updates a second time without failing a test.
    expect(isMainWindowSearch("?view=helper")).toBe(false);
    expect(isMainWindowSearch("?view=capture")).toBe(false);
  });

  it("any future `?view=` webview is excluded from the poll before anyone updates this file", () => {
    // The guard fails closed on an unrecognized view, so adding a webview in Rust cannot silently
    // mint a second update poller (windowIdentity.isAppWindowSearch).
    expect(isMainWindowSearch("?view=some-future-webview")).toBe(false);
  });

  it("a leftover ?label= from an older build no longer suppresses the poll", () => {
    expect(isMainWindowSearch("?label=win-1")).toBe(true);
    expect(isMainWindowSearch("?label=")).toBe(true);
  });
});

describe("cadence constants", () => {
  it("polls every 60 minutes; refocus checks are guarded by a 5-minute gap", () => {
    expect(DEFAULT_UPDATE_INTERVAL_MS).toBe(60 * 60 * 1000);
    expect(MIN_CHECK_GAP_MS).toBe(5 * 60 * 1000);
  });
});
