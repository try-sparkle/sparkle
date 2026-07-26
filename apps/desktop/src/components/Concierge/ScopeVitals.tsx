// Scope line ("Following all projects" / "Pinned to X") + vitals line (P0/P1 counts or
// "all calm") under the wordmark. The text derivations are exported pure so tests pin the
// exact strings the founder reads.
import { C, FONT_WEIGHT } from "../../theme/colors";

export function scopeText(pinnedProjectName?: string): string {
  return pinnedProjectName ? `Pinned to ${pinnedProjectName}` : "Following all projects";
}

/** "1·P0 · 2·P1" (only the non-zero tiers, P0 first) — or null for the "all calm" state. */
export function vitalsParts(p0: number, p1: number): string[] | null {
  const parts: string[] = [];
  if (p0 > 0) parts.push(`${p0}·P0`);
  if (p1 > 0) parts.push(`${p1}·P1`);
  return parts.length > 0 ? parts : null;
}

export function ScopeVitals({
  pinnedProjectName,
  p0,
  p1,
}: {
  pinnedProjectName?: string;
  p0: number;
  p1: number;
}) {
  const parts = vitalsParts(p0, p1);
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
        {parts ? (
          parts.map((part, i) => (
            <span key={part}>
              {i > 0 ? " · " : null}
              <span
                style={{
                  fontWeight: FONT_WEIGHT.bold,
                  color: part.endsWith("P0") ? C.sienna : C.amber,
                }}
              >
                {part}
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
