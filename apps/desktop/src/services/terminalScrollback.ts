// Per-agent terminal-history providers, so the relay host can send a watching phone an agent's
// scrollback (not just new bytes). Kept as a tiny standalone registry so the relay layer doesn't
// import the heavyweight xterm/React Terminal component, and so the serialization is unit-testable.
//
// The PTY stream isn't persisted anywhere else — this in-memory buffer (xterm's scrollback, while
// the agent's terminal is mounted) is the only history that exists.

// The minimal slice of @xterm/xterm's IBuffer we read.
export interface ScrollbackBuffer {
  readonly length: number;
  getLine(index: number): { translateToString(trimRight?: boolean): string } | undefined;
}

// Cap the snapshot to the phone emulator's row budget (terminal.ts MAX_ROWS) — shipping more just
// scrolls off the top on arrival.
export const SNAPSHOT_MAX_LINES = 300;

/**
 * Serialize a terminal buffer's tail to text the phone's VT emulator renders correctly. Lines are
 * joined with CRLF (`\r\n`), NOT bare `\n`: the emulator models `\n` as line-feed-only (row++) and
 * resets the column only on `\r`, so a bare `\n` would staircase each line further right. Real PTY
 * output uses CRLF; the snapshot must too.
 */
export function serializeScrollback(buffer: ScrollbackBuffer): string {
  const start = Math.max(0, buffer.length - SNAPSHOT_MAX_LINES);
  const lines: string[] = [];
  for (let i = start; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    lines.push(line ? line.translateToString(true) : "");
  }
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end--; // trim trailing blanks
  return lines.slice(0, end).join("\r\n");
}

const providers = new Map<string, () => string>();

/** Register an agent's scrollback provider while its terminal is mounted. Returns an unregister
 *  fn that only removes THIS provider (so a transient double-mount can't delete the live one). */
export function registerScrollback(agentId: string, provider: () => string): () => void {
  providers.set(agentId, provider);
  return () => {
    if (providers.get(agentId) === provider) providers.delete(agentId);
  };
}

/** The agent's current terminal history, or null if its terminal isn't mounted. */
export function getAgentScrollback(agentId: string): string | null {
  const provider = providers.get(agentId);
  return provider ? provider() : null;
}
