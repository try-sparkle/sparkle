// The REAL `AutoLaunchStore` — bead sparkle-uz87.9.
//
// `autoLaunch.ts` describes the policy (opt-in, tri-state, OS-first) against an interface. This
// file is the implementation that interface was written for, and without it the whole thing is a
// preference nobody's machine has ever heard of.
//
// THE TWO HALVES ARE DIFFERENT STORES, ON PURPOSE:
//
//   * `enable`/`disable` go to the OS through `overlay_auto_launch_set`, which drives
//     `tauri-plugin-autostart` (a LaunchAgent on macOS, a Run-key entry on Windows). This is the
//     half that actually makes the app launch at login.
//   * `read`/`write` keep the user's ANSWER, in local storage. It is not redundant with the OS
//     state: the OS can only say on or off, and "never asked" is the third case the whole opt-in
//     rule turns on. Deriving the preference from `is_enabled()` would report a brand-new user as
//     a deliberate "off" and hand the caller licence to overwrite a choice that was never made.
//
// A FAILED READ IS NOT A NO: a storage read that throws resolves to `undefined`, which
// `parseAutoLaunchPreference` maps to `"unknown"` — never to a silent `"off"`.
import { invoke } from "@tauri-apps/api/core";
import { setAutoLaunch, type AutoLaunchResult, type AutoLaunchStore } from "./autoLaunch";

/** Where the user's answer is kept. Namespaced like the app's other overlay-scoped keys. */
export const AUTO_LAUNCH_PREFERENCE_KEY = "sparkle.overlay.autoLaunch";

/** The Tauri command that performs the OS-level registration. Matched by name at runtime. */
export const AUTO_LAUNCH_SET_COMMAND = "overlay_auto_launch_set";
/** The Tauri command reporting what the OS actually has registered. */
export const AUTO_LAUNCH_IS_ENABLED_COMMAND = "overlay_auto_launch_is_enabled";

export function defaultAutoLaunchStore(): AutoLaunchStore {
  return {
    read: async () => {
      try {
        return localStorage.getItem(AUTO_LAUNCH_PREFERENCE_KEY);
      } catch {
        // Unreadable storage is "unknown", not "off". See the header.
        return undefined;
      }
    },
    write: async (value: string) => {
      localStorage.setItem(AUTO_LAUNCH_PREFERENCE_KEY, value);
    },
    enable: async () => {
      await invoke(AUTO_LAUNCH_SET_COMMAND, { enable: true });
    },
    disable: async () => {
      await invoke(AUTO_LAUNCH_SET_COMMAND, { enable: false });
    },
  };
}

/**
 * Apply the user's choice against the real OS and the real storage.
 *
 * This is the production entry point — the one function an eventual settings toggle calls. It
 * takes no injectable store BY DESIGN: an optional `store` parameter here would make
 * `defaultAutoLaunchStore` a defaulted seam that every test overrides, leaving the line that
 * supplies the real value covered by nothing (`sparkle-lgbwf`, seen 4x in this repo).
 */
export function setAutoLaunchPreference(wanted: boolean): Promise<AutoLaunchResult> {
  return setAutoLaunch(defaultAutoLaunchStore(), wanted);
}

/** What the OS has registered, as opposed to what we stored. */
export function osAutoLaunchRegistered(): Promise<boolean> {
  return invoke<boolean>(AUTO_LAUNCH_IS_ENABLED_COMMAND);
}
