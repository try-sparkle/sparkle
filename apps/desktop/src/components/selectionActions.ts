// apps/desktop/src/components/selectionActions.ts
// Behavior for the terminal selection popup. Kept separate from the popup component so each
// action is unit-testable in isolation (the component just wires buttons to these).
import { pasteIntoPty, PtyGoneError, submitPrompt } from "../pty";
import { openUrl } from "@tauri-apps/plugin-opener";
import { appendNote, createTask } from "../services/projectFs";
import { useProjectStore } from "../stores/projectStore";
import { landInAgent } from "../services/landInAgent";

/** Google search URL for the selection. */
export function searchUrl(text: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}

/** First line of the selection, clamped on a character boundary — for tab names and bead titles. */
export function truncateTitle(text: string, max = 80): string {
  const firstLine = (text.split("\n")[0] ?? "").trim();
  const chars = [...firstLine]; // code-point aware: never split an astral char / surrogate pair
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : firstLine;
}

// Both writes below go through pty.ts's per-agent chain rather than raw `writePty` (roborev 54387).
// These are the same two shapes the composer and the terminal drop already put on it — a
// paste-then-Enter and a paste-with-no-Enter — and the popup is no more entitled to skip it: an
// unchained selection paste can land inside a background requery's paste→CR gap (and `fixInAgent`'s
// own gap can swallow someone else's paste), merging two prompts into one turn and losing the
// "fix this" request entirely. Both primitives also own the framing AND the marker-stripping
// (roborev 2197/2210) — `deliverSubmit` strips too, as of roborev 54397, so the selection text is
// guarded on both paths without this file repeating the rule.
//
// They are STRICT: a dead PTY rejects. That is what the popup wants — `act()` in SelectionPopup
// toasts a thrown message, so a click that went nowhere says so instead of quietly closing.

/** Turn a PtyGoneError into something worth putting in a toast. */
async function intoAgent(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (e) {
    if (e instanceof PtyGoneError) throw new Error("That agent's terminal isn't running any more.");
    throw e;
  }
}

/** Paste an error into the terminal's own agent, framed as a fix request, and submit it. */
export function fixInAgent(agentId: string, text: string): Promise<void> {
  return intoAgent(() =>
    submitPrompt(agentId, `I hit this error, please fix it:\n\n${text}`),
  );
}

/** Paste raw text into the terminal's own agent without submitting — the user edits, then sends. */
export function sendToAgent(agentId: string, text: string): Promise<void> {
  return intoAgent(() => pasteIntoPty(agentId, text));
}

/** Open a new shell tab that runs the selection as a command in the project root. */
export function runAsCommand(projectId: string, text: string): void {
  const ps = useProjectStore.getState();
  const id = ps.addAgent(projectId, {
    kind: "shell",
    name: truncateTitle(text, 40),
    shellCommand: text,
  });
  if (!id) return; // project vanished (closed/removed) — nothing to select or open
  // Leave the special view, select, open, and scroll the new shell row on screen. The reveal is
  // new here: running a selection as a command appends a tab at the end of a column that is often
  // already taller than the viewport, so without it the output you asked for lands off screen.
  landInAgent(projectId, id);
}

export function searchWeb(text: string): Promise<void> {
  return openUrl(searchUrl(text));
}

export function saveNote(projectPath: string, text: string, timestamp: string): Promise<void> {
  return appendNote(projectPath, text, timestamp);
}

export function createTaskFromText(projectPath: string, text: string): Promise<string> {
  return createTask(projectPath, truncateTitle(text), text);
}
