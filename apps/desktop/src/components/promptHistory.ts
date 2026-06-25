// Helpers for the pinned-header prompt-history dropdown (PinnedPrompt). Kept pure and
// DOM-free so they're unit-testable under the node test env (the desktop suite has no jsdom).

/**
 * A compact "time ago" label for a prompt-history entry, e.g. "just now", "3m", "2h", "5d".
 * `nowMs` is passed in (not read from the clock) so the formatting is deterministic and testable.
 * Future timestamps (clock skew) clamp to "just now".
 */
export function formatAgo(nowMs: number, thenMs: number): string {
  const secs = Math.floor((nowMs - thenMs) / 1000);
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

/** Collapse a prompt to a single line for the dropdown row (newlines → spaces, trimmed). */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
