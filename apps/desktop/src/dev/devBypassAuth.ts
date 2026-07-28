// DEV-ONLY auth bypass for the screenshot / E2E harness (plan: Batch 3b).
//
// The desktop frontend cannot render in a plain browser: the OS keychain lives on the Rust side, so
// authStore.refresh() -> hasToken() throws outside a Tauri webview and hard-clears "me", and the
// AuthGate never reaches "entitled" - a headless browser only ever sees the paywall. This flag turns
// that dead-end into a repeatable screenshot loop by short-circuiting refresh() to an entitled
// state WITHOUT a keychain. See stores/authStore.ts refresh().
//
// Same VITE_* bool convention as components/SparkleOverlay/flag.ts (a plain env read, no-op when
// absent), with one extra, load-bearing guard: it is gated on import.meta.env.DEV, which is TRUE
// only for the "vite" dev-serve and the test runner and FALSE for "vite build" (the packaged Tauri
// bundle). So even if someone set the env var against a release build, the bypass can NEVER activate
// there - it is structurally dev/test-only.
//
// Enable it for a dev/test session with the VITE_SPARKLE_DEV_BYPASS_AUTH env flag set to 1 or true.

export const DEV_BYPASS_AUTH_FLAG = "VITE_SPARKLE_DEV_BYPASS_AUTH";

/** The env is injectable so tests can exercise both branches without stubbing Vite. */
export function devBypassAuthEnabled(
  env: Record<string, unknown> = import.meta.env as unknown as Record<string, unknown>,
): boolean {
  // NEVER in a release bundle: DEV is false in a "vite build" artifact regardless of the flag.
  if (env.DEV !== true) return false;
  const v = env[DEV_BYPASS_AUTH_FLAG];
  return v === "1" || v === "true" || v === true;
}
