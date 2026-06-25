// Shared PostHog analytics taxonomy for every Sparkle surface.
//
// This module is SDK-AGNOSTIC on purpose: it imports no PostHog package, only
// exports plain constants/types/config-fragments. Each app (desktop & web use
// `posthog-js`; mobile will use `posthog-react-native`; orchestration will use
// `posthog-node`) initializes its OWN SDK and reuses these values, so event
// names and capture defaults never drift between surfaces.
//
// One PostHog project ("Sparkle") receives everything; the `surface` super
// property distinguishes where an event came from, enabling cross-surface
// funnels (web download → desktop install → active use).

/** Which Sparkle app emitted an event. Registered as a super property. */
export type Surface = "desktop" | "web" | "mobile" | "orchestration";

/**
 * Custom event names — the single source of truth. UI clicks/inputs are also
 * captured automatically by autocapture; these are the explicit, high-value
 * events we want stable names for across surfaces and over time.
 */
export const ANALYTICS_EVENTS = {
  // ── Lifecycle (desktop / mobile app installs & sessions) ──────────────────
  /** First-ever launch on this machine — fired once. The "install" signal. */
  APP_INSTALLED: "app_installed",
  /** Every app launch. */
  APP_OPENED: "app_opened",
  /** Launch where the running version differs from the last-seen version. */
  APP_UPDATED: "app_updated",

  // ── Web funnel (sparkle.ai landing page) ──────────────────────────────────
  /** Real download started (the Download CTA's active <a>). */
  DOWNLOAD_CLICKED: "download_clicked",
  /** Click on the "coming soon" Download CTA before the build ships — demand. */
  DOWNLOAD_INTEREST: "download_interest",

  // ── Desktop product (layered on top of autocapture) ───────────────────────
  AGENT_SPAWNED: "agent_spawned",
  BUILD_STARTED: "build_started",
  BUILD_MERGED: "build_merged",
  APPROVAL_ACTIONED: "approval_actioned",
} as const;

export type AnalyticsEvent =
  (typeof ANALYTICS_EVENTS)[keyof typeof ANALYTICS_EVENTS];

/** CSS class that tells PostHog session-replay to NOT record an element. */
export const PH_NO_CAPTURE_CLASS = "ph-no-capture";

/**
 * Session-recording masking applied to surfaces that may display sensitive
 * content (the desktop app's xterm terminals show source code, command output,
 * and secrets). `maskTextSelector: "*"` masks ALL on-screen text; `maskAllInputs`
 * masks every input value. Terminal containers additionally carry
 * `PH_NO_CAPTURE_CLASS` so they're dropped from recordings entirely.
 */
export const SESSION_RECORDING_MASKING = {
  maskAllInputs: true,
  maskTextSelector: "*",
} as const;

/** Shape of the common `posthog-js` init options shared by browser surfaces. */
export interface PostHogBrowserCommonConfig {
  autocapture: boolean;
  capture_pageleave: boolean;
  capture_exceptions: boolean;
  session_recording: typeof SESSION_RECORDING_MASKING;
  /** Surfaces register super props themselves; included for completeness. */
  persistence: "localStorage+cookie";
  /**
   * Top-level (NOT autocapture-nested) masking. Autocapture is INDEPENDENT of
   * session replay: by default it records interacted elements' text (`$el_text`)
   * and attribute values as event properties. Set on surfaces that render
   * sensitive data outside masked/excluded regions (the desktop app — repo &
   * agent names, file paths, prompts, diffs). Omitted otherwise.
   */
  mask_all_text?: boolean;
  mask_all_element_attributes?: boolean;
}

/**
 * Common `posthog-js` configuration for browser surfaces (desktop + web).
 * Spread into `posthog.init(key, { ...posthogBrowserCommonConfig(), ... })`.
 * Captures "as much as possible" — autocapture, page-leave, JS exceptions, and
 * masked session replay — without ever recording masked terminal contents.
 *
 * @param opts.maskAutocaptureText — mask the text/attributes of autocaptured
 *   elements (not just replay). Use on surfaces that render sensitive data
 *   outside excluded regions (desktop). Leave off where on-screen text is
 *   non-sensitive and worth capturing (e.g. the public web landing page).
 */
export function posthogBrowserCommonConfig(opts?: {
  maskAutocaptureText?: boolean;
}): PostHogBrowserCommonConfig {
  return {
    autocapture: true,
    capture_pageleave: true,
    capture_exceptions: true,
    session_recording: SESSION_RECORDING_MASKING,
    persistence: "localStorage+cookie",
    ...(opts?.maskAutocaptureText
      ? { mask_all_text: true, mask_all_element_attributes: true }
      : {}),
  };
}

/** Super properties attached to every event from a surface. */
export interface SparkleSuperProps {
  surface: Surface;
  app_version: string;
  os?: string;
  arch?: string;
}

/**
 * Best-effort OS/arch sniff from a browser `navigator` (no native plugin).
 *
 * Caveat — `arch` is unreliable in practice: Apple-Silicon WKWebView/Chromium
 * report a frozen `"Macintosh; Intel Mac OS X 10_15_7"` UA for compatibility, so
 * `arch` resolves to `"unknown"` on the very platform Sparkle ships to first.
 * `os` is reliable. Treat `arch` as a hint only; for accurate desktop arch wire
 * a native call (`@tauri-apps/plugin-os` `arch()`) later if it's needed.
 */
export function sniffPlatform(nav?: {
  userAgent?: string;
  platform?: string;
}): { os: string; arch: string } {
  const ua = (nav?.userAgent ?? "").toLowerCase();
  const platform = (nav?.platform ?? "").toLowerCase();
  const os = /mac/.test(ua + platform)
    ? "macos"
    : /win/.test(ua + platform)
      ? "windows"
      : /linux/.test(ua + platform)
        ? "linux"
        : "unknown";
  const arch = /arm|aarch64/.test(ua) ? "arm64" : /x86_64|x64|win64|amd64/.test(ua) ? "x64" : "unknown";
  return { os, arch };
}

/**
 * Decide whether `app_installed` / `app_updated` should fire, given the last
 * version we recorded for this machine (null = never launched here before).
 * Pure so it's unit-testable without a real PostHog client or storage.
 *
 * Any version change emits `app_updated` — including a downgrade/rollback
 * (e.g. 0.2.0 → 0.1.0). That's intentional: we want to count every version
 * transition, and the actual versions ride along on the event for analysis. We
 * deliberately do NOT semver-order this (no forward-only gate).
 */
export function resolveLifecycleEvent(
  lastSeenVersion: string | null,
  currentVersion: string,
): typeof ANALYTICS_EVENTS.APP_INSTALLED | typeof ANALYTICS_EVENTS.APP_UPDATED | null {
  if (lastSeenVersion === null) return ANALYTICS_EVENTS.APP_INSTALLED;
  if (lastSeenVersion !== currentVersion) return ANALYTICS_EVENTS.APP_UPDATED;
  return null;
}
