// Native folder picker for choosing/creating a project folder. The macOS open-directory
// dialog includes a "New Folder" button, so this covers both "choose existing" and
// "make a new folder".
import { open } from "@tauri-apps/plugin-dialog";

/** True when running inside the Tauri desktop app (vs. a plain browser dev preview). */
function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Prompt the user to choose or create a project folder. Returns its path, or null.
 * The macOS open-directory dialog has a "New Folder" button, so this covers both
 * "open an existing folder" and "create a new one".
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
  const result = await open({ directory: true, multiple: false, title });
  return typeof result === "string" ? result : null;
}

/** Last path segment — used as a friendly default project name. */
export function basename(p: string): string {
  const parts = p.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || p;
}
