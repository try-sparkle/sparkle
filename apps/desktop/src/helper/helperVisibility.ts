// The island's visibility rule, isolated so it is a truth table rather than a tangle of
// show()/hide() calls scattered through an effect (spec §5.1).
//
// Rust reports only the raw "is any Sparkle window frontmost" boolean; the POLICY lives here.
//
// `enabled` is the user's persisted dismissal. §6 removed it because the only way to clear it was a
// "Show Helper" button in the main window — one click into a state the island could not leave. The
// route back is now the native menu bar (View → Hide/Show Helper), which is always on screen and
// cannot itself be dismissed, so the flag is a preference rather than a one-way door. See
// helperPrefs.ts.

export interface HelperVisibilityInput {
  /** The user's persisted preference. False after Hide Helper (island menu or the View menu). */
  enabled: boolean;
  /** True when any Sparkle window (excluding the helper and capture panels) is frontmost. */
  sparkleFrontmost: boolean;
}

/** The island is for glancing at Sparkle from OUTSIDE Sparkle: it earns its screen space only
 *  when the user is somewhere else. When Sparkle is front, the app's own UI shows the same
 *  numbers, so the island would be pure duplication. */
export function shouldShowHelper({ enabled, sparkleFrontmost }: HelperVisibilityInput): boolean {
  return enabled && !sparkleFrontmost;
}
