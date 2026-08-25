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
//
// SECOND WAY IN, ADDED FOR THE AGENT PREVIEW (bead sparkle-bg6868): vite MODE `preview`. The
// `[preview]` block in `.sparkle/config.toml` serves this package with `--mode preview` for every
// agent's preview card, and there is no way for that block to set an env var — its schema is
// `command`/`args`/`path` only, and `.env.preview` is unusable because the repo `.gitignore`s
// `.env.*`. Keying on the mode needs no plumbing at all and is STRICTER than the flag, not looser:
// `--mode preview` has exactly one caller in this repo, so a developer's own `pnpm dev` (mode
// `development`) and `pnpm tauri dev` are unaffected. The `env.DEV` gate below still governs both
// ways in, so neither can activate in a shipped bundle.

export const DEV_BYPASS_AUTH_FLAG = "VITE_SPARKLE_DEV_BYPASS_AUTH";

/**
 * The vite `--mode` the agent preview server runs under, pinned in `.sparkle/config.toml`'s
 * `[preview].args`. Exported so `vite.config.ts`'s preview-shim plugin keys on the SAME string —
 * the bypass and the IPC shim must switch on together, or the preview lands on the app's error
 * boundary instead of the app (measured; see `PRD/sparkle/preview-usable.md`).
 */
export const PREVIEW_MODE = "preview";

/** The env is injectable so tests can exercise both branches without stubbing Vite. */
export function devBypassAuthEnabled(
  env: Record<string, unknown> = import.meta.env as unknown as Record<string, unknown>,
): boolean {
  // NEVER in a release bundle: DEV is false in a "vite build" artifact regardless of the flag OR
  // the mode. This single line is what keeps BOTH ways in structurally dev/test-only.
  if (env.DEV !== true) return false;
  // The agent preview server. See the note above on why this is a mode and not an env var.
  if (env.MODE === PREVIEW_MODE) return true;
  const v = env[DEV_BYPASS_AUTH_FLAG];
  return v === "1" || v === "true" || v === true;
}
