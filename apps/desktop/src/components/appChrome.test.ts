// The shared app-chrome primitives. Only the genuinely pure parts live here — the hooks
// (useAppInfo / useVersionCheck) are exercised through their consumer in StatusStrip.test.tsx,
// where the session-guard behavior is observable as the user experiences it.
import { describe, expect, it, vi } from "vitest";

vi.mock("../logger", () => ({
  getAppVersion: () => Promise.resolve("1.2.3"),
  getLogDir: () => Promise.resolve("/logs"),
  revealLogs: () => Promise.resolve(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: () => Promise.resolve() }));
vi.mock("../services/updaterService", () => ({ checkForUpdates: () => Promise.resolve("up-to-date") }));

import { CHANGELOG_URL, checkLabel } from "./appChrome";

describe("checkLabel (pure)", () => {
  it("pins the manual-check strings", () => {
    expect(checkLabel("idle")).toBe("Check for updates");
    expect(checkLabel("checking")).toBe("Checking for updates…");
    expect(checkLabel("uptodate")).toBe("You're up to date");
    expect(checkLabel("error")).toBe("Check failed — retry");
  });
});

describe("CHANGELOG_URL", () => {
  it("is the public changelog page", () => {
    expect(CHANGELOG_URL).toBe("https://sparkle.ai/changelog");
  });
});
