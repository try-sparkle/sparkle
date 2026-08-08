// The TypeScript twin of accounts.rs `limit_episodes`.
//
// A rate-limited agent does not record ONE limit line — it records a burst of them, one per retry,
// as it keeps hitting the same wall. Counting those raw lines would multiply a single limit event
// into dozens, which matters because the count is what decides whether an account has enough
// evidence for a learned ceiling (>= CEILING_MIN_SAMPLES). Collapsing a burst into one episode is
// what makes "26 episodes" a statement about 26 walls rather than 3,512 retries.
//
// This lived inline in `scripts/account-rotation-evidence.ts`, where the repo's own rule bit it: a
// hand-rolled mirror of Rust behaviour with no test on this side, whose wrongness would change the
// script's CONCLUSION rather than its formatting. The Rust side pins its half with
// `limit_episodes_collapses_a_burst_into_one_sample`; this is the half that had nothing.

/** The consumption window a limit is measured over — accounts.rs `WINDOW_5H`, in milliseconds. */
export const WINDOW_5H_MS = 5 * 60 * 60 * 1000;

/** Collapse raw rate-limit timestamps (epoch ms) into distinct EPISODES, oldest first.
 *
 *  Two events belong to the same episode when they fall within `WINDOW_5H_MS` of the episode's
 *  start. The comparison is STRICTLY GREATER, matching Rust: events exactly one window apart are the
 *  SAME episode, not two. That boundary is the kind of detail that silently drifts between two
 *  implementations of one rule, which is why it has its own test.
 *
 *  Input need not be sorted — it is sorted here, because the caller collects across many transcript
 *  files in directory order. */
export function collapseEpisodes(times: readonly number[]): number[] {
  const sorted = [...times].sort((a, b) => a - b);
  const episodes: number[] = [];
  for (const t of sorted) {
    const last = episodes[episodes.length - 1];
    if (last === undefined || t - last > WINDOW_5H_MS) episodes.push(t);
  }
  return episodes;
}

/** Is this transcript line a REAL rate-limit record?
 *
 *  Keys on the structured `error` field being exactly `"rate_limit"`, which prose can never forge.
 *  This matters more than it looks: the Phase-1 implementation matched a regex against raw terminal
 *  output, so a coding agent WRITING ABOUT rate limits benched a healthy account for hours. A line
 *  merely containing the words is not an event.
 *
 *  Returns the event's epoch ms, or null when the line is not a limit record (or is unparseable —
 *  a transcript truncated by a crash must be skipped, never fatal). */
export function limitEventTime(line: string): number | null {
  // Cheap reject first: parsing every line of a 16,000-file transcript tree is the expensive path.
  if (!line.includes('"rate_limit"')) return null;
  let v: { error?: unknown; timestamp?: unknown };
  try {
    v = JSON.parse(line) as { error?: unknown; timestamp?: unknown };
  } catch {
    return null;
  }
  if (v.error !== "rate_limit" || typeof v.timestamp !== "string") return null;
  const ts = Date.parse(v.timestamp);
  return Number.isFinite(ts) ? ts : null;
}
