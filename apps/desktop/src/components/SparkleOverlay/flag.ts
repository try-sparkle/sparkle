// Feature flag for the Living Sparkle Overlay. OFF by default — the overlay must not
// mount in any build until the founder greenlights it (PRD §3). Same convention as the
// other VITE_* reads in this app (analytics.ts / perfTrace.ts): a plain env read, no-op
// when absent, so dev/CI/offline builds behave identically with the flag unset.
//
// Enable locally with `VITE_SPARKLE_OVERLAY=1 pnpm dev` (or =true).

export const SPARKLE_OVERLAY_FLAG = "VITE_SPARKLE_OVERLAY";

/** The env is injectable so tests can exercise both branches without stubbing Vite. */
export function sparkleOverlayEnabled(
  env: Record<string, unknown> = import.meta.env as unknown as Record<
    string,
    unknown
  >,
): boolean {
  const v = env[SPARKLE_OVERLAY_FLAG];
  return v === "1" || v === "true" || v === true;
}
