// Desktop (Tauri webview) PostHog wiring. Initializes posthog-js with the
// shared Sparkle taxonomy (@sparkle/core), registers surface super-properties,
// and emits the install/open/update lifecycle. Captures "as much as possible"
// — autocapture + JS exceptions + masked session replay — while the xterm
// terminal panes carry `ph-no-capture` so their contents (code, command output,
// secrets) are never recorded.
//
// No-ops cleanly when VITE_PUBLIC_POSTHOG_KEY is absent (dev/CI/offline), so the
// app always runs whether or not analytics is configured.
// posthog-js (and the session-replay recorder it lazily pulls in) is NOT imported at module load.
// It's a heavy dependency that has no business competing with first paint, so we dynamic-import it
// and call posthog.init() from an idle callback after the UI has rendered (see initAnalytics). The
// type is imported type-only (erased at build) so signatures stay typed with zero runtime cost.
import type { PostHog } from "posthog-js";
import {
  ANALYTICS_EVENTS,
  posthogBrowserCommonConfig,
  resolveLifecycleEvent,
  sniffPlatform,
  type AnalyticsEvent,
} from "@sparkle/core";
// The [tools].analytics consent flag (mirrored into settingsStore, hydrated from config.toml).
// Off means analytics is used NOWHERE: no init, no session replay, no captures. The store is a
// pure zustand store (no Tauri runtime), so it's safe to read here.
import { useSettingsStore } from "./stores/settingsStore";

/** Whether the user consents to analytics right now ([tools].analytics). Defaults on (store default). */
function analyticsEnabled(): boolean {
  try {
    return useSettingsStore.getState().analyticsEnabled;
  } catch {
    // Store unavailable (shouldn't happen in the webview) — fall back to the on-by-default state.
    return true;
  }
}

// The live client, assigned once the dynamic import + init completes. Null until then, so every
// capture/identify call no-ops safely during the pre-init window (and forever if no key/replay).
let posthog: PostHog | null = null;

/**
 * Run `cb` once the main thread is idle, after first paint. Uses requestIdleCallback where the
 * runtime has it; falls back to a short setTimeout for WKWebView/Safari, which historically lack
 * requestIdleCallback. Either way the work lands after the initial render, not during it.
 */
function onIdle(cb: () => void): void {
  const w = window as Window &
    typeof globalThis & { requestIdleCallback?: (cb: () => void) => number };
  if (typeof w.requestIdleCallback === "function") {
    w.requestIdleCallback(cb);
    return;
  }
  // WKWebView/Safari fallback: a bare setTimeout(cb, 1) can fire BEFORE first paint, defeating the
  // whole point of deferring past render on the platform this most needs to help. rAF + a 0ms
  // timeout lands the callback after a frame has actually been committed.
  requestAnimationFrame(() => setTimeout(cb, 0));
}

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
let scheduled = false;
// initAnalytics wires the consent subscription exactly once — a second call must not register a
// second (never-unsubscribed) store subscriber. Also tracks the last consent value so the
// subscription (which fires on EVERY settings-store change) only acts when analyticsEnabled flips.
let wired = false;
let lastConsent: boolean | null = null;

function appVersion(): string {
  return typeof __SPARKLE_APP_VERSION__ === "string"
    ? __SPARKLE_APP_VERSION__
    : "0.0.0";
}

/**
 * Wire up analytics at launch — but OFF the critical path, and only with the user's consent. The
 * actual dynamic import + posthog.init() runs from an idle callback after first paint, so the heavy
 * analytics bundle and its session-replay recorder never delay the initial render. No-ops with no
 * key / outside a browser.
 *
 * Consent-aware: this reads [tools].analytics now AND subscribes to it, so a config hydrate (the
 * flag may load in as OFF after this runs) or a live toggle in the Tools pane takes effect with no
 * restart — turning it off opts the live client out of ALL capturing (incl. session replay);
 * turning it back on opts in (initializing lazily the first time). Safe to call more than once.
 */
export function initAnalytics(): void {
  if (!KEY || typeof window === "undefined") return;
  if (wired) return; // idempotent: never register a second subscription
  wired = true;
  applyConsent(analyticsEnabled());
  // React to later changes (config hydrate or the Tools pane toggle). subscribe() fires on every
  // store change, so applyConsent guards on the consent value actually flipping (lastConsent).
  useSettingsStore.subscribe((s) => applyConsent(s.analyticsEnabled));
}

/** Reconcile the live client (or the pending schedule) with the current consent flag. No-ops when
 *  the consent value hasn't changed since the last call (the subscription fires on unrelated edits). */
function applyConsent(enabled: boolean): void {
  if (enabled === lastConsent) return;
  lastConsent = enabled;
  if (enabled) {
    if (ready) posthog?.opt_in_capturing();
    else scheduleInit();
  } else if (ready) {
    // Already running — stop ALL capture (autocapture, session replay, events) at the source.
    posthog?.opt_out_capturing();
  }
}

/** Schedule the deferred import + init from an idle callback (guarded so it runs at most once). */
function scheduleInit(): void {
  if (scheduled || ready) return;
  scheduled = true;
  onIdle(() => {
    void loadAndInit();
  });
}

/** Dynamic-import posthog-js and initialize it. Runs post-paint from scheduleInit's idle callback. */
async function loadAndInit(): Promise<void> {
  if (ready || !KEY) return;
  // Consent may have flipped OFF between scheduling and this idle callback firing — don't init.
  // Reset `scheduled` so a later opt-in can re-schedule.
  if (!analyticsEnabled()) {
    scheduled = false;
    return;
  }

  let mod: typeof import("posthog-js");
  try {
    mod = await import("posthog-js");
  } catch (e) {
    // Couldn't load the analytics bundle (offline/CI) — capture calls keep no-oping. Never fatal.
    console.warn("analytics: failed to load posthog-js", e);
    return;
  }
  const client = mod.default;

  const version = appVersion();
  const { os, arch } = sniffPlatform(window.navigator);

  client.init(KEY, {
    api_host: HOST,
    // Mask autocaptured element text/attributes too — the desktop UI renders
    // repo/agent names, file paths, prompts and diffs outside the terminal.
    ...posthogBrowserCommonConfig({ maskAutocaptureText: true }),
  });
  client.register({ surface: "desktop", app_version: version, os, arch });
  posthog = client;
  ready = true;

  // Install / update lifecycle, derived from the last version seen on this
  // machine. Storage failures must never block launch.
  try {
    const last = window.localStorage.getItem(LAST_VERSION_KEY);
    const lifecycle = resolveLifecycleEvent(last, version);
    if (lifecycle) client.capture(lifecycle);
    window.localStorage.setItem(LAST_VERSION_KEY, version);
  } catch {
    /* localStorage unavailable — skip lifecycle, keep going. */
  }

  client.capture(ANALYTICS_EVENTS.APP_OPENED);
}

/** Capture a typed Sparkle event. No-ops until analytics is initialized, or when consent is off. */
export function capture(
  event: AnalyticsEvent,
  props?: Record<string, unknown>,
): void {
  if (!ready || !posthog || !analyticsEnabled()) return;
  posthog.capture(event, props);
}

/** Associate the anonymous session with a known user (call after login). No-ops when consent is off. */
export function identifyUser(
  distinctId: string,
  props?: Record<string, unknown>,
): void {
  if (!ready || !posthog || !analyticsEnabled()) return;
  posthog.identify(distinctId, props);
}
