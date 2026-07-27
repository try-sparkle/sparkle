// Scope line ("Following all projects" / "Pinned to X") + vitals line (status-band counts or
// "all calm") under the wordmark. The text derivations are exported pure so tests pin the
// exact strings the founder reads.
import { bandColor, bandCountLabel } from "../../engine/statusBandLabels";
import type { StatusBand } from "../../engine/buildSections";
import { C, FONT_WEIGHT } from "../../theme/colors";

export function scopeText(pinnedProjectName?: string): string {
  return pinnedProjectName ? `Pinned to ${pinnedProjectName}` : "Following all projects";
}

/** The bands the vitals line reports, in the order it reports them.
 *
 *  `done` is deliberately absent. The line answers "is anything unsettled?", and a resting fleet is
 *  overwhelmingly `done` — on the fleet that drove this work, 27 of 51 agents. Including it would
 *  mean the line reads "40 Done" forever and the "all calm" state, which is the whole affordance,
 *  could never appear. The counts are still carried in the view-model for surfaces that want them. */
const VITAL_BANDS: readonly StatusBand[] = ["needs_you", "running"];

/** ["1 Needs you", "2 Running"] — only the non-zero vital bands, Needs-you first — or null for the
 *  "all calm" state. Labels come from the shared bandCountLabel so the singular/plural agreement
 *  ("1 Needs you" vs "3 Need you") can't drift from the tab badges. */
export function vitalsParts(counts: Record<StatusBand, number>): string[] | null {
  const parts = vitalEntries(counts).map((e) => e.text);
  return parts.length > 0 ? parts : null;
}

/** The same list the render walks — text PLUS the band, so each part is painted from its own band's
 *  color instead of the render sniffing a suffix off the string (how the old "endsWith('P0')" test
 *  would have silently mis-colored any relabeled tier). */
function vitalEntries(counts: Record<StatusBand, number>): { band: StatusBand; text: string }[] {
  return VITAL_BANDS.filter((b) => counts[b] > 0).map((b) => ({
    band: b,
    text: bandCountLabel(b, counts[b]),
  }));
}

export function ScopeVitals({
  pinnedProjectName,
  counts,
}: {
  pinnedProjectName?: string;
  counts: Record<StatusBand, number>;
}) {
  const entries = vitalEntries(counts);
  return (
    <div style={{ textAlign: "center" }}>
      <div
        style={{
          fontSize: 10.5,
          marginTop: 8,
          // Pinned scope reads gold — the same accent the pinned tab tilts to.
          color: pinnedProjectName ? C.amber : C.muted,
        }}
      >
        {scopeText(pinnedProjectName)}
      </div>
      <div style={{ fontSize: 11, color: C.conciergeMuted, marginTop: 2 }}>
        {entries.length > 0 ? (
          entries.map((entry, i) => (
            <span key={entry.band}>
              {i > 0 ? " · " : null}
              <span style={{ fontWeight: FONT_WEIGHT.bold, color: bandColor(entry.band) }}>
                {entry.text}
              </span>
            </span>
          ))
        ) : (
          "all calm"
        )}
      </div>
    </div>
  );
}
