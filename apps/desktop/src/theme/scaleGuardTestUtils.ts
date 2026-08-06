// Test-support: failure-message builder for the off-scale ratchet in scale.test.ts.
//
// WHY THIS IS A SEPARATE, TEST-SUPPORT MODULE (the `TestUtils` suffix is load-bearing — the
// dormant-module guard classifies it as test-only, so being imported solely by a test does not
// read as dead production code): the ratchet assertions run against the real source tree, so you
// cannot force them red to check the message they emit. Factoring the message into a pure function
// lets a unit test feed it synthetic hits and assert the CONTENT — specifically that it names the
// FILES each off-scale value came from, not just the distinct values. Before this, a tripped guard
// told you WHICH off-scale values existed but not WHICH FILES held them, so every failure began
// with a manual grep to locate the offending code.
//
// It deliberately holds no `<prop>: <number>` style literals of its own (the prop name is a
// parameter), so the scanner in scale.test.ts — which walks every non-`.test.` source file —
// counts nothing here.

export interface OffScaleHit {
  /** Repo-relative path (already sliced to below the theme SRC root by the scanner). */
  file: string;
  value: number;
}

// The most files we spell out for a single value before collapsing the tail to "and N more".
// This is a DISPLAY cap, not silent data loss: the header count is always the true total, and
// every distinct value is still listed with at least its first few files.
const MAX_FILES_PER_VALUE = 6;

/**
 * Build the assertion failure message for one off-scale ratchet.
 *
 * @param prop    the style prop being guarded, e.g. "fontSize" / "borderRadius" — shown verbatim.
 * @param advice  the migration guidance clause, e.g. "use TYPE" / "use RADIUS/PILL".
 * @param hits    every off-scale occurrence, each carrying the file it was found in.
 * @param ceiling the recorded ceiling the count is compared against.
 */
export function offScaleMessage(
  prop: string,
  advice: string,
  hits: readonly OffScaleHit[],
  ceiling: number,
): string {
  const byValue = [...new Set(hits.map((h) => h.value))].sort((a, b) => a - b);
  const locations = byValue
    .map((v) => {
      const files = [...new Set(hits.filter((h) => h.value === v).map((h) => h.file))];
      const shown = files.slice(0, MAX_FILES_PER_VALUE).join(", ");
      const extra =
        files.length > MAX_FILES_PER_VALUE ? ` and ${files.length - MAX_FILES_PER_VALUE} more` : "";
      return `${v} → ${shown}${extra}`;
    })
    .join("; ");
  return (
    `${hits.length} off-scale ${prop} values (${byValue.join(", ")}) vs recorded ceiling ${ceiling}. ` +
    `Locations — ${locations}. ` +
    `You added off-scale sprawl — ${advice}. ` +
    `(If you MIGRATED some, this passes; lower the constant to ${hits.length} in this PR to keep the ceiling tight.)`
  );
}
