// apps/desktop/src/components/selectionActions.ts
// Behavior for the terminal selection popup. Kept separate from the popup component so each
// action is unit-testable in isolation (the component just wires buttons to these).
import { writePty } from "../pty";
import { openUrl } from "@tauri-apps/plugin-opener";
import { appendNote, createTask } from "../services/projectFs";
import { useHandoffStore } from "../stores/handoffStore";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";

const ESC = "\x1b";
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

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

/** Open (or reuse) the project's singleton brainstorm agent and queue an initial prompt. */
export function openBrainstorm(projectId: string, text: string, autoSend: boolean): void {
  const ps = useProjectStore.getState();
  const project = ps.projects.find((p) => p.id === projectId);
  if (!project) return;
  const existing = project.agents.find((a) => a.kind === "brainstorm");
  const id = existing ? existing.id : ps.addAgent(projectId, { kind: "brainstorm" });
  useUiStore.getState().setActiveSpecial(null);
  ps.selectAgent(projectId, id);
  useRuntimeStore.getState().open(id);
  useHandoffStore.getState().setPending({ projectId, text, autoSend });
}

export function brainstormWith(projectId: string, text: string): void {
  openBrainstorm(projectId, text, false);
}

export function explain(projectId: string, text: string): void {
  openBrainstorm(projectId, `Explain this:\n\n${text}`, true);
}

export function askWith(projectId: string, question: string, text: string): void {
  openBrainstorm(projectId, `${question}\n\n${text}`, true);
}

// Neutralize bracketed-paste markers embedded in untrusted selection text so it can't
// terminate paste mode early and inject keystrokes into the agent's PTY (roborev 2197).
// A single split/join pass is insufficient: removing a marker can reconstitute a new one
// from its neighbors (e.g. "\x1b[20\x1b[201~1~" → "\x1b[201~" after one pass). Loop until
// stable so that no marker survives regardless of how deeply it is interleaved (roborev 2210).
function stripPasteMarkers(s: string): string {
  let t = s;
  while (t.includes(PASTE_START) || t.includes(PASTE_END)) {
    t = t.split(PASTE_START).join("").split(PASTE_END).join("");
  }
  return t;
}

/** Paste an error into the terminal's own agent, framed as a fix request, and submit it. */
export async function fixInAgent(agentId: string, text: string): Promise<void> {
  await writePty(agentId, `${PASTE_START}I hit this error, please fix it:\n\n${stripPasteMarkers(text)}${PASTE_END}`);
  // Brief gap before Enter so the program registers the paste as one block (mirrors Composer).
  await new Promise((r) => setTimeout(r, 60));
  await writePty(agentId, "\r");
}

/** Paste raw text into the terminal's own agent without submitting — the user edits, then sends. */
export async function sendToAgent(agentId: string, text: string): Promise<void> {
  await writePty(agentId, `${PASTE_START}${stripPasteMarkers(text)}${PASTE_END}`);
}

/** Open a new shell tab that runs the selection as a command in the project root. */
export function runAsCommand(projectId: string, text: string): void {
  const ps = useProjectStore.getState();
  const id = ps.addAgent(projectId, {
    kind: "shell",
    name: truncateTitle(text, 40),
    shellCommand: text,
  });
  useUiStore.getState().setActiveSpecial(null);
  ps.selectAgent(projectId, id);
  useRuntimeStore.getState().open(id);
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
