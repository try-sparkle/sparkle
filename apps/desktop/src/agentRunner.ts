// Local agent runner — the "usable layer" over the PTY. Spawns the user's own
// `claude` (or any command) in a local PTY, buffers output into lines, strips ANSI,
// runs the shared classifier (@sparkle/core), and surfaces classified events. This is
// what turns the raw terminal into the operations dashboard.

import { classifyLine, type ClassifiedEvent } from "@sparkle/core";
import { killPty, onPtyExit, onPtyOutput, spawnPty, writePty } from "./pty";

// Strip ANSI CSI escape sequences (color/cursor) so classification + descriptions are
// clean — Claude Code's TUI is heavily styled.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

export interface AgentCallbacks {
  /** Called for each classified (non-discarded) line. */
  onEvent: (event: ClassifiedEvent, rawLine: string) => void;
  /** Called for every raw line (e.g. to feed Expert Mode). */
  onRawLine?: (line: string) => void;
  onExit?: () => void;
}

export interface StartAgentOptions {
  id: string;
  command: string; // e.g. absolute path to "claude"
  args?: string[];
  cwd?: string;
  callbacks: AgentCallbacks;
}

/** Start a local agent. Returns a teardown fn that detaches the listeners. */
export async function startAgent(opts: StartAgentOptions): Promise<() => void> {
  let buffer = "";

  const unlistenOut = await onPtyOutput((e) => {
    if (e.id !== opts.id) return;
    buffer += e.chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const raw = stripAnsi(buffer.slice(0, nl).replace(/\r$/, ""));
      buffer = buffer.slice(nl + 1);
      if (!raw) continue;
      opts.callbacks.onRawLine?.(raw);
      const event = classifyLine(raw, { sessionId: opts.id });
      if (event) opts.callbacks.onEvent(event, raw);
    }
  });

  const unlistenExit = await onPtyExit((e) => {
    if (e.id === opts.id) opts.callbacks.onExit?.();
  });

  await spawnPty({ id: opts.id, command: opts.command, args: opts.args, cwd: opts.cwd });

  return () => {
    void unlistenOut();
    void unlistenExit();
  };
}

/** Approve a pending agent prompt (writes "y\n" to the PTY). */
export const approveAgent = (id: string): Promise<void> => writePty(id, "y\n");
/** Deny a pending agent prompt (writes "n\n"). */
export const denyAgent = (id: string): Promise<void> => writePty(id, "n\n");
/** Send arbitrary input (e.g. the build goal) to the agent. */
export const sendToAgent = (id: string, text: string): Promise<void> =>
  writePty(id, text.endsWith("\n") ? text : `${text}\n`);
export const stopAgent = (id: string): Promise<void> => killPty(id);
