// Native folder picker for choosing/creating a project folder. The macOS open-directory
// dialog includes a "New Folder" button, so this covers both "choose existing" and
// "make a new folder".
import { open } from "@tauri-apps/plugin-dialog";

/** Prompt the user to choose or create a project folder. Returns its path, or null.
 * The macOS open-directory dialog has a "New Folder" button, so this covers both
 * "open an existing folder" and "create a new one". */
export async function pickProjectFolder(
  title = "Choose or create a folder for this project",
): Promise<string | null> {
  const result = await open({ directory: true, multiple: false, title });
  return typeof result === "string" ? result : null;
}

/** Last path segment — used as a friendly default project name. */
export function basename(p: string): string {
  const parts = p.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || p;
}
