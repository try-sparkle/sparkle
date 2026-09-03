// THE APP'S ONE ELAPSED-DURATION VOCABULARY — "13s", "29.5m", "1.7h", "2.5d".
//
// It lived inside `components/AgentSidebar.tsx` and was read only by that file's row timer. It moved
// here when the concierge's RESOLVED nudge card needed to say how long a block lasted, because the
// alternative was a second formatter: the two surfaces sit within a few hundred pixels of each other
// (the Build column's row reads "29.5m", the card beside it would have read "29m 30s"), and two
// spellings of the same duration in one screenful is exactly the kind of drift a shared module
// exists to prevent.
//
// `AgentSidebar` RE-EXPORTS it rather than importing-and-hiding, so `AgentSidebar.elapsedTimer.test`
// and every other existing importer keep their import path and this move stays behaviour-preserving.
// The reason the concierge card does not simply import it from there is module weight: `AgentSidebar`
// is a ~3,300-line component whose transitive graph would be pulled into `NudgeCard`'s unit test to
// deliver one pure string function.
//
// PURE — no clock, no store, no React. The caller supplies the elapsed milliseconds.

/**
 * Format an elapsed duration (ms) for a timer readout: integer seconds while under 100s (where each
 * second is visible), then minutes / hours / days each to one decimal with a trailing ".0" stripped
 * (so 2 minutes reads "2m", 1.5 reads "1.5m").
 *
 * Floors rather than rounds in the seconds band, so 99.9s reads "99s" and never crosses into a
 * three-digit "100s" the next band is meant to own.
 */
export function formatElapsed(ms: number): string {
  const SEC = 1000;
  const MIN = 60 * SEC;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  // Fail safe on garbage input. Callers wrap this in `Math.max(0, …)` to keep clock skew from
  // printing a negative age — but `Math.max(0, NaN)` is `NaN`, not `0`, so a missing/undefined
  // timestamp (`now - undefined`) slips that guard and the last band below renders the literal
  // "NaNd" into the UI. An infinite or negative duration is equally meaningless. Since this is the
  // app's ONE elapsed vocabulary, the guard belongs here, once, not re-derived at every call site.
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  if (ms < 100 * SEC) return `${Math.floor(ms / SEC)}s`;
  const oneDp = (n: number) => {
    const s = n.toFixed(1);
    return s.endsWith(".0") ? s.slice(0, -2) : s;
  };
  if (ms < 100 * MIN) return `${oneDp(ms / MIN)}m`;
  if (ms < 24 * HOUR) return `${oneDp(ms / HOUR)}h`;
  return `${oneDp(ms / DAY)}d`;
}
