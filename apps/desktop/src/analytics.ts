// Desktop (Tauri webview) PostHog wiring. Initializes posthog-js with the
// shared Sparkle taxonomy (@sparkle/core), registers surface super-properties,
// and emits the install/open/update lifecycle. Captures "as much as possible"
// — autocapture + JS exceptions + masked session replay — while the xterm
// terminal panes carry `ph-no-capture` so their contents (code, command output,
// secrets) are never recorded.
//
// No-ops cleanly when VITE_PUBLIC_POSTHOG_KEY is absent (dev/CI/offline), so the
// app always runs whether or not analytics is configured.
import posthog from "posthog-js";
import {
  ANALYTICS_EVENTS,
  posthogBrowserCommonConfig,
  resolveLifecycleEvent,
  sniffPlatform,
  type AnalyticsEvent,
} from "@sparkle/core";

// Injected at build time from apps/desktop/package.json via vite `define`.
declare const __SPARKLE_APP_VERSION__: string;

const KEY = (
  import.meta.env.VITE_PUBLIC_POSTHOG_KEY as string | undefined
)?.trim();
const HOST =
  (import.meta.env.VITE_PUBLIC_POSTHOG_HOST as string | undefined)?.trim() ||
  "https://us.i.posthog.com";

const LAST_VERSION_KEY = "sparkle-analytics:last-version";

let ready = false;

function appVersion(): string {
  return typeof __SPARKLE_APP_VERSION__ === "string"
    ? __SPARKLE_APP_VERSION__
    : "0.0.0";
}

/** Stand up PostHog once, at launch. Safe to call more than once. */
export function initAnalytics(): void {
  if (ready) return;
  if (!KEY || typeof window === "undefined") return;

  const version = appVersion();
  const { os, arch } = sniffPlatform(window.navigator);

  posthog.init(KEY, {
    api_host: HOST,
    // Mask autocaptured element text/attributes too — the desktop UI renders
    // repo/agent names, file paths, prompts and diffs outside the terminal.
    ...posthogBrowserCommonConfig({ maskAutocaptureText: true }),
  });
  posthog.register({ surface: "desktop", app_version: version, os, arch });
  ready = true;

  // Install / update lifecycle, derived from the last version seen on this
  // machine. Storage failures must never block launch.
  try {
    const last = window.localStorage.getItem(LAST_VERSION_KEY);
    const lifecycle = resolveLifecycleEvent(last, version);
    if (lifecycle) posthog.capture(lifecycle);
    window.localStorage.setItem(LAST_VERSION_KEY, version);
  } catch {
    /* localStorage unavailable — skip lifecycle, keep going. */
  }

  posthog.capture(ANALYTICS_EVENTS.APP_OPENED);
}

/** Capture a typed Sparkle event. No-ops until analytics is initialized. */
export function capture(
  event: AnalyticsEvent,
  props?: Record<string, unknown>,
): void {
  if (!ready) return;
  posthog.capture(event, props);
}

/** Associate the anonymous session with a known user (call after login). */
export function identifyUser(
  distinctId: string,
  props?: Record<string, unknown>,
): void {
  if (!ready) return;
  posthog.identify(distinctId, props);
}
