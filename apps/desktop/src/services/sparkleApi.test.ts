// Regression guard for the silent sign-in/paywall failure (bead ). The browser hand-off
// goes through openUrl(), which REJECTS when the URL is outside the opener scope, when there's no
// default browser, or on an OS denial. Callers wire the buttons as `() => void openSignIn()`, so a
// reject left unhandled produced an "Unhandled rejection: Not allowed to open url" burst AND a dead
// button. openSignIn/openPaywall must therefore swallow the failure and report it via a boolean.
import { describe, it, expect, vi, beforeEach } from "vitest";

const openUrlMock = vi.fn();
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (...a: unknown[]) => openUrlMock(...a) }));
// openSignIn now calls invoke("desktop_begin_signin") to mint the state + PKCE challenge in Rust
// (sparkle-kqg0), so the mock returns those; every other command resolves to null.
const invokeMock = vi.fn(async (...a: unknown[]) =>
  a[0] === "desktop_begin_signin" ? { state: "st8-abc", codeChallenge: "chal-xyz" } : null,
);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { openSignIn, openPaywall, lastSignInUrl, SIGN_IN_URL, PAYWALL_URL } from "./sparkleApi";

describe("browser hand-off (openSignIn / openPaywall)", () => {
  beforeEach(() => {
    openUrlMock.mockReset();
    invokeMock.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("opens the sign-in URL carrying the bound state + PKCE challenge", async () => {
    openUrlMock.mockResolvedValue(undefined);
    await expect(openSignIn()).resolves.toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("desktop_begin_signin");
    const opened = openUrlMock.mock.calls[0]?.[0] as string;
    expect(opened.startsWith(SIGN_IN_URL)).toBe(true);
    const params = new URL(opened).searchParams;
    expect(params.get("state")).toBe("st8-abc");
    expect(params.get("code_challenge")).toBe("chal-xyz");
    expect(params.get("code_challenge_method")).toBe("S256");
    // The exact URL opened is remembered for the copy/paste fallback.
    expect(lastSignInUrl()).toBe(opened);
  });

  it("opens the paywall URL unchanged and resolves true on success", async () => {
    openUrlMock.mockResolvedValue(undefined);
    await expect(openPaywall()).resolves.toBe(true);
    expect(openUrlMock).toHaveBeenCalledWith(PAYWALL_URL);
  });

  it("never rejects — resolves false when openUrl is blocked/denied", async () => {
    openUrlMock.mockRejectedValue(new Error("Not allowed to open url"));
    // The whole point: these must NOT throw (no unhandled rejection from the button handler).
    await expect(openSignIn()).resolves.toBe(false);
    await expect(openPaywall()).resolves.toBe(false);
  });

  it("falls back to the bare sign-in URL if minting the state/PKCE fails", async () => {
    invokeMock.mockRejectedValueOnce(new Error("rust down"));
    openUrlMock.mockResolvedValue(undefined);
    await expect(openSignIn()).resolves.toBe(true);
    expect(openUrlMock).toHaveBeenCalledWith(SIGN_IN_URL);
    expect(lastSignInUrl()).toBe(SIGN_IN_URL);
  });
});
