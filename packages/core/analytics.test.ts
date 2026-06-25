import { describe, expect, it } from "vitest";
import {
  ANALYTICS_EVENTS,
  posthogBrowserCommonConfig,
  resolveLifecycleEvent,
  SESSION_RECORDING_MASKING,
  sniffPlatform,
} from "./analytics";

describe("resolveLifecycleEvent", () => {
  it("fires app_installed on the very first launch (no prior version)", () => {
    expect(resolveLifecycleEvent(null, "0.1.0")).toBe(
      ANALYTICS_EVENTS.APP_INSTALLED,
    );
  });

  it("fires app_updated when the version changed since last launch", () => {
    expect(resolveLifecycleEvent("0.1.0", "0.2.0")).toBe(
      ANALYTICS_EVENTS.APP_UPDATED,
    );
  });

  it("fires nothing on a normal relaunch at the same version", () => {
    expect(resolveLifecycleEvent("0.1.0", "0.1.0")).toBeNull();
  });

  it("treats a downgrade/rollback as app_updated (intentional, no semver gate)", () => {
    expect(resolveLifecycleEvent("0.2.0", "0.1.0")).toBe(
      ANALYTICS_EVENTS.APP_UPDATED,
    );
  });
});

describe("sniffPlatform", () => {
  it("detects macOS but reports arch=unknown for a REAL Apple-Silicon WKWebView UA", () => {
    // Apple Silicon Safari/WKWebView freezes the UA to "Intel Mac OS X" for
    // compatibility, so arch is genuinely not derivable here — documents the
    // limitation called out in review rather than hiding it behind a fake UA.
    expect(
      sniffPlatform({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
        platform: "MacIntel",
      }),
    ).toEqual({ os: "macos", arch: "unknown" });
  });

  it("derives arm64 when the UA actually advertises it", () => {
    expect(
      sniffPlatform({
        userAgent: "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36",
        platform: "Linux aarch64",
      }),
    ).toEqual({ os: "linux", arch: "arm64" });
  });

  it("falls back to unknown when nothing matches", () => {
    expect(sniffPlatform({ userAgent: "", platform: "" })).toEqual({
      os: "unknown",
      arch: "unknown",
    });
  });
});

describe("posthogBrowserCommonConfig", () => {
  it("captures broadly but masks all text and inputs in recordings", () => {
    const cfg = posthogBrowserCommonConfig();
    expect(cfg.autocapture).toBe(true);
    expect(cfg.capture_exceptions).toBe(true);
    expect(cfg.session_recording).toBe(SESSION_RECORDING_MASKING);
    expect(cfg.session_recording.maskAllInputs).toBe(true);
    expect(cfg.session_recording.maskTextSelector).toBe("*");
  });

  it("masks autocapture text/attributes when asked (sensitive surfaces)", () => {
    const cfg = posthogBrowserCommonConfig({ maskAutocaptureText: true });
    // Top-level masking — autocapture stays on, but element text/attrs are masked.
    expect(cfg.autocapture).toBe(true);
    expect(cfg.mask_all_text).toBe(true);
    expect(cfg.mask_all_element_attributes).toBe(true);
  });

  it("does NOT mask autocapture text by default (e.g. public web)", () => {
    const cfg = posthogBrowserCommonConfig();
    expect(cfg.mask_all_text).toBeUndefined();
    expect(cfg.mask_all_element_attributes).toBeUndefined();
  });
});
