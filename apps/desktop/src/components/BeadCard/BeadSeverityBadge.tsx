// The bead's SEVERITY as a small read-only badge — the weighted relevance score (human comments = 3,
// machine = 1, decayed) that the scoring pipeline materializes as a `sev-<N>` label.
//
// ══ A SEPARATE AXIS FROM PRIORITY, DRAWN SO IT READS AS ONE ════════════════════════════════════
// `BeadPriorityChip` shows priority (P0-P4) — the manual, dominant ordering. Severity ranks WITHIN a
// priority band and is written by automation; the founder asked for both to be visible, and the
// design is explicit that they must never be conflated. So this badge is deliberately distinct from
// the priority chip on every channel a glance uses:
//   * HUE — priority wears danger/muted ink; severity wears `violetInk`, a colour no priority uses.
//   * PREFIX — `S3`, not `P3`, so the two never read as the same scale at different values.
// It shares only the `tag()` treatment (the app's outline-chip language) so it still belongs on the
// card.
//
// ══ ABSENT LABEL → NO BADGE ════════════════════════════════════════════════════════════════════
// A null score renders NOTHING. Unlike priority (where "unset" is the fact most worth clicking, so
// `P?` is shown), a bead with no severity is the overwhelming common case today — the score is
// materialized lazily and most beads have no scoring comments — so a `S?` on every card would be
// noise, not signal. The badge appears only once the pipeline has something to say.
import { C } from "../../theme/colors";
import { tag } from "../labelTreatment";

export function BeadSeverityBadge({
  severity,
  testId = "bead-severity-badge",
}: {
  /** The bead's severity score (`severityOf(bead)`). `null` renders no badge at all. */
  severity: number | null;
  testId?: string;
}) {
  if (severity === null) return null;
  return (
    <span
      data-testid={testId}
      data-severity={String(severity)}
      title={`Relevance score (severity) ${severity} — ranks within priority; separate from it`}
      // No click: it is a readout of an automation-written score, not something a person edits here.
      style={{
        ...tag(C.violetInk),
        display: "inline-flex",
        alignItems: "center",
        flex: "0 0 auto",
        background: "transparent",
      }}
    >
      {`S${severity}`}
    </span>
  );
}
