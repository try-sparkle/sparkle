// updaterService tests — node env. We mock the Tauri updater + process plugins (mirrors the
// crossWindowSync.test approach of capturing the mocked plugin calls) and drive the decision
// logic directly via checkForUpdatesNow / applyUpdateAndRestart so the dev/packaged guard in
// startUpdater doesn't get in the way.
import { describe, it, expect, vi, beforeEach } from "vitest";

const check = vi.fn();
vi.mock("@tauri-apps/plugin-updater", () => ({
  check: (...a: unknown[]) => check(...a),
}));

const relaunch = vi.fn();
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: (...a: unknown[]) => relaunch(...a),
}));

import {
  checkForUpdatesNow,
  applyUpdateAndRestart,
  useUpdaterStore,
} from "./updaterService";
import { useSettingsStore } from "../stores/settingsStore";

/** A minimal stand-in for the plugin's `Update` resource. */
function makeUpdate(over: Record<string, unknown> = {}) {
  return {
    version: "9.9.9",
    body: "Release notes",
    currentVersion: "0.3.0",
    downloadAndInstall: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    ...over,
  };
}

beforeEach(() => {
  check.mockReset();
  relaunch.mockReset();
  relaunch.mockResolvedValue(undefined);
  useUpdaterStore.getState().reset();
  useSettingsStore.setState({ autoApplyUpdates: true });
});

describe("checkForUpdatesNow", () => {
  it("auto-apply ON → silently downloads+installs and surfaces the 'ready' state", async () => {
    useSettingsStore.setState({ autoApplyUpdates: true });
    const update = makeUpdate();
    check.mockResolvedValue(update);

    await checkForUpdatesNow();

    expect(update.downloadAndInstall).toHaveBeenCalledTimes(1);
    const s = useUpdaterStore.getState();
    expect(s.phase).toBe("ready");
    expect(s.version).toBe("9.9.9");
    expect(s.notes).toBe("Release notes");
  });

  it("auto-apply OFF → sets the 'available' prompt and does NOT install silently", async () => {
    useSettingsStore.setState({ autoApplyUpdates: false });
    const update = makeUpdate();
    check.mockResolvedValue(update);

    await checkForUpdatesNow();

    expect(update.downloadAndInstall).not.toHaveBeenCalled();
    const s = useUpdaterStore.getState();
    expect(s.phase).toBe("available");
    expect(s.version).toBe("9.9.9");
  });

  it("no update available (check resolves null) → no-op, stays idle", async () => {
    check.mockResolvedValue(null);

    await checkForUpdatesNow();

    expect(useUpdaterStore.getState().phase).toBe("idle");
  });

  it("check throws → swallowed, no crash, stays idle", async () => {
    check.mockRejectedValue(new Error("offline / signature mismatch"));

    await expect(checkForUpdatesNow()).resolves.toBeUndefined();
    expect(useUpdaterStore.getState().phase).toBe("idle");
  });

  it("already 'ready' → skips re-checking (no duplicate download)", async () => {
    useUpdaterStore.getState().setReady("9.9.9", null);
    check.mockResolvedValue(makeUpdate());

    await checkForUpdatesNow();

    expect(check).not.toHaveBeenCalled();
  });
});

describe("applyUpdateAndRestart", () => {
  it("auto-apply OFF path: installs the pending update on demand, then relaunches", async () => {
    useSettingsStore.setState({ autoApplyUpdates: false });
    const update = makeUpdate();
    check.mockResolvedValue(update);
    await checkForUpdatesNow(); // stashes the pending (not-yet-installed) update

    await applyUpdateAndRestart();

    expect(update.downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("auto-apply ON path: update already installed → just relaunches", async () => {
    useSettingsStore.setState({ autoApplyUpdates: true });
    const update = makeUpdate();
    check.mockResolvedValue(update);
    await checkForUpdatesNow(); // installs now; nothing left pending

    update.downloadAndInstall.mockClear();
    await applyUpdateAndRestart();

    expect(update.downloadAndInstall).not.toHaveBeenCalled();
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("relaunch failure clears the busy flag so the user can retry", async () => {
    useSettingsStore.setState({ autoApplyUpdates: true });
    check.mockResolvedValue(makeUpdate());
    await checkForUpdatesNow();
    relaunch.mockRejectedValueOnce(new Error("relaunch failed"));

    await expect(applyUpdateAndRestart()).resolves.toBeUndefined();
    expect(useUpdaterStore.getState().busy).toBe(false);
  });
});
