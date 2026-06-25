// apps/desktop/src/services/projectFs.ts
// Frontend bindings for the project-root file/CLI sinks behind the terminal selection popup's
// "Save note" and "New task" actions (Rust: src-tauri/src/notes.rs).
import { invoke } from "@tauri-apps/api/core";

/** Append a timestamped note to <projectPath>/NOTES.md. */
export function appendNote(projectPath: string, text: string, timestamp: string): Promise<void> {
  return invoke("append_note", { projectPath, text, timestamp });
}

/** Create a beads issue and return its id. Throws with bd's message on failure. */
export async function createTask(projectPath: string, title: string, body: string): Promise<string> {
  const raw = await invoke<string>("create_bead", { projectPath, title, body });
  let obj: { id?: string; error?: string };
  try {
    obj = JSON.parse(raw) as { id?: string; error?: string };
  } catch {
    throw new Error(`Unexpected bd output: ${raw.slice(0, 200)}`);
  }
  if (obj.error) throw new Error(obj.error);
  if (obj.id) return obj.id;
  throw new Error(`bd returned no id: ${raw.slice(0, 200)}`);
}
