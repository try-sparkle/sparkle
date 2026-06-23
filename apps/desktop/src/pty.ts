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

/** Write to a PTY's stdin — e.g. approve ("y\n") / deny ("n\n") or user keystrokes. */
export function writePty(id: string, data: string): Promise<void> {
  return invoke("pty_write", { id, data });
}

export function resizePty(id: string, cols: number, rows: number): Promise<void> {
  return invoke("pty_resize", { id, cols, rows });
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
