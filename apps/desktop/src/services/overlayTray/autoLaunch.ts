// Opt-in auto-launch on login — bead sparkle-uz87.9.
//
// "Opt-in" is the whole specification, so the part worth writing carefully is the DEFAULT and what
// happens when the answer is unknown. Two rules, both of which exist because the failure is
// invisible to the person it happens to:
//
//   1. ABSENT MEANS OFF. A missing preference is a user who has never been asked, and enrolling
//      them in launch-on-login would be a change to their machine they did not request and will
//      not notice until it happens.
//   2. A FAILED READ IS NOT A NO. Reporting "off" for a preference we could not read invites the
//      caller to helpfully "fix" it by writing one, silently overwriting a real choice. So the
//      read is tri-state and the caller has to handle "unknown" on purpose.
export type AutoLaunchPreference = "on" | "off" | "unknown";

export interface AutoLaunchStore {
  read(): Promise<string | null | undefined>;
  write(value: string): Promise<void>;
  enable(): Promise<void>;
  disable(): Promise<void>;
}

/** Parse a stored value. Anything unrecognised is `unknown`, never a silent `off`. */
export function parseAutoLaunchPreference(raw: string | null | undefined): AutoLaunchPreference {
  if (raw === "on" || raw === "true" || raw === "1") return "on";
  if (raw === "off" || raw === "false" || raw === "0") return "off";
  // Includes null/undefined (never asked) and any corrupted value.
  return "unknown";
}

/** The effective setting. `unknown` resolves to NOT launching — opt-in means opt-in. */
export function autoLaunchEnabled(pref: AutoLaunchPreference): boolean {
  return pref === "on";
}

export interface AutoLaunchResult {
  preference: AutoLaunchPreference;
  /** True when the OS-level registration was actually changed by this call. */
  changed: boolean;
}

/**
 * Apply a user's choice: persist it AND register/unregister with the OS.
 *
 * Both halves matter and they can disagree — a preference written without the OS call is a setting
 * that lies, and an OS call without the preference is a change that does not survive a restart. So
 * the OS call happens FIRST and the preference is written only if it succeeded; a user who toggles
 * this and sees it stick has a guarantee it will actually happen.
 */
export async function setAutoLaunch(
  store: AutoLaunchStore,
  wanted: boolean,
): Promise<AutoLaunchResult> {
  const current = parseAutoLaunchPreference(await store.read());
  if (autoLaunchEnabled(current) === wanted && current !== "unknown") {
    return { preference: current, changed: false };
  }
  if (wanted) await store.enable();
  else await store.disable();
  const next: AutoLaunchPreference = wanted ? "on" : "off";
  await store.write(next);
  return { preference: next, changed: true };
}
