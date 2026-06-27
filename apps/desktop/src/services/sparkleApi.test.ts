// Regression guard for the silent sign-in/paywall failure (bead ). The browser hand-off
// goes through openUrl(), which REJECTS when the URL is outside the opener scope, when there's no
// default browser, or on an OS denial. Callers wire the buttons as `() => void openSignIn()`, so a
// reject left unhandled produced an "Unhandled rejection: Not allowed to open url" burst AND a dead
// button. openSignIn/openPaywall must therefore swallow the failure and report it via a boolean.
import { describe, it, expect, vi, beforeEach } from "vitest";

const openUrlMock = vi.fn();
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (...a: unknown[]) => openUrlMock(...a) }));
// Keep the Rust bridge out of the unit test — sparkleApi imports invoke at module load.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { openSignIn, openPaywall, SIGN_IN_URL, PAYWALL_URL } from "./sparkleApi";

describe("browser hand-off (openSignIn / openPaywall)", () => {
  beforeEach(() => {
    openUrlMock.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("opens the sign-in / paywall URLs and resolves true on success", async () => {
    openUrlMock.mockResolvedValue(undefined);
    await expect(openSignIn()).resolves.toBe(true);
    expect(openUrlMock).toHaveBeenCalledWith(SIGN_IN_URL);
    await expect(openPaywall()).resolves.toBe(true);
    expect(openUrlMock).toHaveBeenCalledWith(PAYWALL_URL);
  });

  it("never rejects — resolves false when openUrl is blocked/denied", async () => {
    openUrlMock.mockRejectedValue(new Error("Not allowed to open url"));
    // The whole point: these must NOT throw (no unhandled rejection from the button handler).
    await expect(openSignIn()).resolves.toBe(false);
    await expect(openPaywall()).resolves.toBe(false);
  });
});
