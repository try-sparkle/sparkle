// Native folder picker for choosing/creating a project folder. The macOS open-directory
// dialog includes a "New Folder" button, so this covers both "choose existing" and
// "make a new folder".
//
// This goes through OUR OWN `pick_folder` command (src-tauri/src/folder_picker.rs), NOT
// `@tauri-apps/plugin-dialog`'s `open()`. The plugin path killed the app in production: AppKit
// returned nil from `+[NSOpenPanel openPanel]`, objc2-app-kit's generated binding unwrapped it and
// panicked, and the plugin then panicked a second time on the resulting RecvError. Our command
// nil-checks instead, so a picker that won't open is a rejected promise we can report — not a dead
// process. See folder_picker.rs's module docs for the full crash.
//
// `attachmentsApi.ts` still uses the plugin for FILE save/open; only the directory case moved.
import { invoke } from "@tauri-apps/api/core";

/** True when running inside the Tauri desktop app (vs. a plain browser dev preview). */
function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Prompt the user to choose or create a project folder. Returns its path, or null.
 * The macOS open-directory dialog has a "New Folder" button, so this covers both
 * "open an existing folder" and "create a new one".
 *
 * Returns null for BOTH "the user cancelled" and "the picker could not be opened" — every caller
 * already treats null as "stay where you are", so a failed picker leaves the user exactly where a
 * cancel would, rather than crashing the app the way the old plugin path did. The failure is
 * logged (and surfaced by the command's error message) so it is diagnosable rather than silent.
 *
 * Dev convenience: in a plain browser preview there's no native dialog, so fall back to a
 * typed path prompt. This lets the localhost browser demo open a project (and exercise the
 * sidebar tree + Think/Chief chat); Build/Worker terminals still require the real app. */
export async function pickProjectFolder(
  title = "Choose or create a folder for this project",
): Promise<string | null> {
  if (!inTauri() && import.meta.env.DEV) {
    const typed = window.prompt(
      `${title}\n\n(Browser preview: type an absolute folder path. Terminals need the desktop app, but Think chat works here.)`,
      "",
    );
    return typed && typed.trim() ? typed.trim() : null;
  }
  try {
    const result = await invoke<string | null>("pick_folder", { title });
    return typeof result === "string" && result ? result : null;
  } catch (e) {
    // The command's contract is that it never panics; it rejects with a user-facing message when
    // macOS refuses to vend a panel. Treat that as a cancel so the app stays alive.
    console.error("Folder picker failed to open:", e);
    return null;
  }
}

/** Last path segment — used as a friendly default project name. */
export function basename(p: string): string {
  const parts = p.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || p;
}
