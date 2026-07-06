// Frontend bridge to the local PTY host (src-tauri/src/pty.rs). Runs the user's own
// `claude` binary (or any command) locally under their own login — Sparkle is the
// terminal-emulator UI on top, it never handles the auth token.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface PtyOutput {
  id: string;
  chunk: string;
}
export interface PtyExit {
  id: string;
}

export interface SpawnPtyOptions {
  id: string;
  command: string;
  args?: string[];
  cwd?: string;
  cols?: number;
  rows?: number;
}

/** Spawn a command in a local PTY. Output arrives via onPtyOutput. */
export function spawnPty(opts: SpawnPtyOptions): Promise<void> {
  return invoke("pty_spawn", {
    id: opts.id,
    command: opts.command,
    args: opts.args ?? [],
    cwd: opts.cwd ?? null,
    cols: opts.cols ?? 120,
    rows: opts.rows ?? 30,
  });
}

// A PTY can exit (and have its session reaped on the Rust side) a beat before a stray
// keystroke or a ResizeObserver-driven resize reaches it — pty_write / pty_resize then
// return Err("no such pty"). Callers fire these and forget, so an un-caught rejection would
// surface as an app-level "unhandled rejection" ERROR (logger.ts) and flood the log. That's
// an expected teardown race, not a real failure, so swallow exactly this error and let any
// other error propagate.
function isExitedPtyError(e: unknown): boolean {
  return String((e as { message?: string })?.message ?? e).includes("no such pty");
}

function ignoreExitedPty(e: unknown): void {
  if (!isExitedPtyError(e)) throw e;
}

/** Write to a PTY's stdin — e.g. approve ("y\n") / deny ("n\n") or user keystrokes. */
export function writePty(id: string, data: string): Promise<void> {
  return invoke<void>("pty_write", { id, data }).catch(ignoreExitedPty);
}

// Bracketed-paste wrappers: ESC[200~ … ESC[201~. ESC is char code 27 — constructed here so
// the source contains no literal ESC byte. Pasting (vs. raw typing) lets the CLI treat a
// multi-line prompt as one atomic block.
const ESC = String.fromCharCode(27);
export const PASTE_START = `${ESC}[200~`;
export const PASTE_END = `${ESC}[201~`;

/** Submit a full prompt to an agent's PTY: deliver it as one bracketed paste, then (after a
 *  beat, so the CLI has finished ingesting the paste) a carriage return to send it. Shared by
 *  the composer and the connectivity re-query. */
export async function submitPrompt(id: string, text: string): Promise<void> {
  await writePty(id, `${PASTE_START}${text}${PASTE_END}`);
  await new Promise((r) => setTimeout(r, 60));
  await writePty(id, "\r");
}

export function resizePty(id: string, cols: number, rows: number): Promise<void> {
  return invoke<void>("pty_resize", { id, cols, rows }).catch(ignoreExitedPty);
}

/** Pause or resume the PTY's reader for flow control (). Fire-and-forget: the frontend
 *  calls this when its xterm write backlog crosses the high/low-water marks (see terminalFlow.ts);
 *  the benign "no such pty" teardown race is swallowed like the other PTY ops. */
export function setPtyPaused(id: string, paused: boolean): Promise<void> {
  return invoke<void>("pty_set_paused", { id, paused }).catch(ignoreExitedPty);
}

export function killPty(id: string): Promise<void> {
  return invoke("pty_kill", { id });
}

/** Subscribe to PTY output. Returns an unlisten fn. */
export function onPtyOutput(cb: (e: PtyOutput) => void): Promise<UnlistenFn> {
  return listen<PtyOutput>("pty:output", (ev) => cb(ev.payload));
}

/** Subscribe to PTY exit. Returns an unlisten fn. */
export function onPtyExit(cb: (e: PtyExit) => void): Promise<UnlistenFn> {
  return listen<PtyExit>("pty:exit", (ev) => cb(ev.payload));
}

export type { WorktreeInfo } from "./services/worktree";
import type { WorktreeInfo } from "./services/worktree";

export function createWorkerWorktree(args: {
  root: string; projectId: string; workerId: string; parentBranch: string;
}): Promise<WorktreeInfo> {
  return invoke("create_worker_worktree", {
    root: args.root, projectId: args.projectId,
    workerId: args.workerId, parentBranch: args.parentBranch,
  });
}

export function readWorkerResult(worktree: string): Promise<string | null> {
  return invoke("read_worker_result", { worktree });
}

/**
 * Swallow the benign "no such pty" race for fire-and-forget writes/resizes/kills.
 * A late resize after an agent exits, or input racing PTY teardown, rejects with
 * "no such pty" — the PTY is simply gone, nothing to do. Anything else is
 * unexpected and gets logged rather than silently dropped. The matched literal is
 * the NO_SUCH_PTY constant in src-tauri/src/pty.rs; keep the two in sync. Use as:
 *   void resizePty(id, c, r).catch(ignorePtyGone);
 */
export function ignorePtyGone(err: unknown): void {
  const msg = typeof err === "string" ? err : (err as { message?: string })?.message ?? String(err);
  if (msg.includes("no such pty")) return;
  console.error("pty operation failed:", err);
}
