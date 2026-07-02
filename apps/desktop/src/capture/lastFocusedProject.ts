// Last-focused-project tracking (spec §3, cross-worker contract). Every project-bearing
// window writes this key on OS focus; the capture window reads it when shown to default its
// project switcher to wherever the user was last working. localStorage is same-origin across
// all Tauri webviews, so no event plumbing is needed.

export const LAST_FOCUSED_PROJECT_KEY = "sparkle-last-focused-project";

interface LastFocusedRecord {
  projectId: string;
  /** Epoch ms of the focus event — kept for debuggability/future tie-breaks. */
  at: number;
}

export function writeLastFocusedProject(projectId: string): void {
  try {
    const rec: LastFocusedRecord = { projectId, at: Date.now() };
    localStorage.setItem(LAST_FOCUSED_PROJECT_KEY, JSON.stringify(rec));
  } catch {
    // Quota/security errors just mean the capture modal falls back to the first project.
  }
}

/** NOTE: the record is write-only and never expires, so the returned id can point at a
 *  since-deleted project. Readers MUST validate it against the live project list and fall
 *  back themselves (CaptureApp does) — never trust it raw. */
export function readLastFocusedProject(): string | null {
  try {
    const raw = localStorage.getItem(LAST_FOCUSED_PROJECT_KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw) as Partial<LastFocusedRecord> | null;
    return rec && typeof rec.projectId === "string" && rec.projectId ? rec.projectId : null;
  } catch {
    return null; // bad JSON (or storage unavailable) reads as "no last-focused project"
  }
}
