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

/** What a file pick produced: the chosen paths, and — only when the panel could not be PRESENTED —
 *  a user-facing reason.
 *
 *  A CANCEL is `{ paths: [] }` with no error. A failure is `{ paths: [], error }`. The two used to
 *  be indistinguishable (see below), which is a silent failure by construction. */
export interface PickFilesResult {
  paths: string[];
  /** Set only when the picker could not be opened at all. Never set for a cancel. */
  error?: string;
}

/** Prompt the user to pick one or more FILES.
 *
 * `extensions` narrows the panel (e.g. `["png","jpg"]`); omit it for an unfiltered picker. The
 * filter is best-effort on the Rust side — a macOS that no longer honours it shows every file
 * rather than failing, which is the right way for a cosmetic narrowing to degrade.
 *
 * This used to return a bare `string[]`, collapsing "the user cancelled", "the picker could not be
 * opened" and "there is no native dialog here" into one empty list. That made a refused panel
 * indistinguishable from a cancel, so the caller had nothing to report and the user got silence —
 * the same defect as the drop path (bead sparkle-zviq), just on the other side of the box. The
 * failure is still never THROWN: a failed attach must not take down a compose box the user is
 * mid-thought in. It is returned instead, so the caller can say what happened.
 *
 * Unlike `pickProjectFolder` there is no browser-preview fallback: a typed path prompt cannot stand
 * in for a file picker (the file has to exist and be readable by the Rust loader), and the browser
 * preview has no attachment pipeline to feed. */
export async function pickFiles(
  title: string,
  extensions?: readonly string[],
): Promise<PickFilesResult> {
  if (!inTauri()) {
    // Not a cancel — clicking the button in the browser preview genuinely cannot do anything, and
    // saying so beats a button that silently no-ops.
    return { paths: [], error: "Attaching files needs the desktop app." };
  }
  try {
    const result = await invoke<string[] | null>("pick_files", {
      title,
      extensions: extensions?.length ? [...extensions] : null,
    });
    return { paths: Array.isArray(result) ? result.filter((p) => typeof p === "string" && p) : [] };
  } catch (e) {
    console.error("File picker failed to open:", e);
    // Pass the command's OWN message through. `folder_picker.rs` centralizes this copy
    // (`PresentError::message()`) and the cases are genuinely different: a panel macOS refused to
    // vend says "this usually clears on a retry"; a panel that opened but returned no usable URL
    // says "please try again"; a non-macOS build says the picker doesn't exist there. Collapsing all
    // three into "could not be opened" states a wrong reason as THE reason and throws away the
    // recovery advice — the same defect as saying nothing, which is what this change is about.
    // A Tauri `Err(String)` arrives as the bare string.
    return { paths: [], error: rejectionMessage(e) ?? "The file picker could not be opened." };
  }
}

/** The user-facing text out of a rejection, or null if there is none worth showing. */
function rejectionMessage(e: unknown): string | null {
  if (typeof e === "string" && e.trim()) return e.trim();
  if (e instanceof Error && e.message.trim()) return e.message.trim();
  return null;
}

/** Last path segment — used as a friendly default project name. */
export function basename(p: string): string {
  const parts = p.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || p;
}
