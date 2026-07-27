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
// EVERY native OPEN picker in the app routes here — the project-open flow, the composer's
// bulk-attachment-download folder prompt, and the concierge compose box's file/image attach
// buttons. `attachmentsApi.ts` still uses the plugin for the single-file SAVE dialog (NSSavePanel,
// a different class with no observed nil failure); nothing else should call the plugin's `open()`
// again, for directories OR for files.
//
// Files were on the plugin for a while after directories moved off it, on the theory that the crash
// was directory-specific. It is not: `+[NSOpenPanel openPanel]` is one class method serving both,
// and "directory" is a flag set on the panel after it is vended, so the same panic pair turned up
// from the file path too. Both now go through the same nil-checked Rust command.
import { invoke } from "@tauri-apps/api/core";

/** True when running inside the Tauri desktop app (vs. a plain browser dev preview). */
function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Prompt the user to choose or create a folder. Returns its path, or null.
 * The macOS open-directory dialog has a "New Folder" button, so this covers both
 * "open an existing folder" and "create a new one".
 *
 * The name reflects the dominant caller (the project-open flow), not a restriction: this is the
 * app's ONE directory picker, and the composer's bulk-download prompt uses it too. Pass a `title`
 * that suits the flow.
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

/** Prompt the user to pick one or more FILES. Returns their absolute paths.
 *
 * `extensions` narrows the panel (e.g. `["png","jpg"]`); omit it for an unfiltered picker. The
 * filter is best-effort on the Rust side — a macOS that no longer honours it shows every file
 * rather than failing, which is the right way for a cosmetic narrowing to degrade.
 *
 * Returns `[]` for ALL of "the user cancelled", "the picker could not be opened", and "there is no
 * native dialog here" — every caller treats an empty list as "nothing was attached", so a refused
 * panel leaves the user exactly where a cancel would. The failure is logged, never thrown: a failed
 * attach must not take down a compose box the user is mid-thought in.
 *
 * Unlike `pickProjectFolder` there is no browser-preview fallback: a typed path prompt cannot stand
 * in for a file picker (the file has to exist and be readable by the Rust loader), and the browser
 * preview has no attachment pipeline to feed. */
export async function pickFiles(title: string, extensions?: readonly string[]): Promise<string[]> {
  if (!inTauri()) return [];
  try {
    const result = await invoke<string[] | null>("pick_files", {
      title,
      extensions: extensions?.length ? [...extensions] : null,
    });
    return Array.isArray(result) ? result.filter((p) => typeof p === "string" && p) : [];
  } catch (e) {
    console.error("File picker failed to open:", e);
    return [];
  }
}

/** Last path segment — used as a friendly default project name. */
export function basename(p: string): string {
  const parts = p.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || p;
}
