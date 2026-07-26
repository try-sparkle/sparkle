// The Plan / Build segmented toggle — the HEADER of column 2 in the concierge shell
// (PRD/sparkle/concierge-mode.md §3: "Header is a Plan / Build segmented toggle … not a static
// title"), extracted from AgentSidebar so BOTH homes can render the identical control:
//   - Build mode: it sits at the top of the agent column (its original home).
//   - Plan mode:  columns 2 + 3 collapse into ONE wide Plan-card column, and this is that
//     column's header — so the way back to Build is exactly where it was.
//
// Presentational + prop-driven: the callers own what a click DOES (AgentSidebar keeps its
// two-stage Build chevron, which spawns a fresh build agent on a second click).
import { C, ON_BRAND_FILL, ON_BRAND_FILL_DARK } from "../theme/colors";
import { FaTasks } from "react-icons/fa";
import type { WorkMode } from "../stores/uiStore";

// The two mode buttons (Plan / Build) form one continuous Sparkle blue→cyan fade. These are the
// fade boundaries: the cyan "S" accent on the far left of Plan, the primary brand blue on the far
// right of Build, and an interpolated stop at the Plan→Build seam so each button paints exactly its
// slice of the SAME overall gradient.
const FADE_0 = C.accent; // #34e0f0 — logo cyan, far-left edge of Plan
const FADE_2 = "#3192fa"; // Plan→Build seam
export const FADE_3 = C.teal; // #2f6bff — primary brand blue, far-right edge of Build

// Depth (px) of the chevron point/notch carved into a button's vertical edge.
const CHEVRON = 11;

// Width (px) of the hairline left between adjacent chevrons. We underlap the tessellation by this
// much (overlap = CHEVRON - SEAM) so a thin diagonal sliver of the wrapper's background shows
// through at the Plan→Build seam.
const SEAM = 1;

// Build the clip-path for a button in the chevron strip. The OUTER edges of the strip (Plan's
// left, Build's right) stay flat ("vertical button surfaces"); the interior seam is arrow-shaped:
// a button that isn't last grows a rightward point, a button that isn't first gets a matching
// inward notch on its left so the previous button's point nests into it.
function chevronClip(leftNotch: boolean, rightPoint: boolean): string {
  const d = `${CHEVRON}px`;
  const pts: string[] = ["0 0"];
  if (rightPoint) {
    pts.push(`calc(100% - ${d}) 0`, "100% 50%", `calc(100% - ${d}) 100%`);
  } else {
    pts.push("100% 0", "100% 100%");
  }
  pts.push("0 100%");
  if (leftNotch) pts.push(`${d} 50%`);
  return `polygon(${pts.join(", ")})`;
}

// Shared style for a chevron in the mode strip: a solid gradient slice with NO border/stroke,
// clipped to its chevron shape. `fillText` is the per-chevron ink chosen for contrast on that fill.
// The strip's rounded outer corners come from the wrapper (overflow:hidden + borderRadius), so the
// chevrons themselves are square; `leftNotch` chevrons overlap the previous one by CHEVRON px
// (negative margin) so the point tessellates exactly into the notch. `active` is the currently
// selected mode: the active chevron keeps its brand color; the inactive one renders grayscale.
// `justify` places the glyph+label: Plan is left-justified (its flat-left, wrapper-rounded edge
// reads like the old Think tab), Build stays centered.
function createBtnStyle(
  from: string,
  to: string,
  fillText: string,
  leftNotch: boolean,
  rightPoint: boolean,
  active: boolean,
  justify: "center" | "flex-start" = "center",
): React.CSSProperties {
  return {
    flex: 1,
    // A touch more horizontal room than the old three-up strip so each mode reads a bit wider; the
    // extra left pad on the left-justified Plan keeps its label off the rounded corner.
    padding: justify === "flex-start" ? "10px 12px 10px 14px" : "10px 12px",
    border: "none",
    borderRadius: 0,
    marginLeft: leftNotch ? -(CHEVRON - SEAM) : 0,
    clipPath: chevronClip(leftNotch, rightPoint),
    cursor: "pointer",
    fontFamily: '"IBM Plex Sans", sans-serif',
    fontSize: 13,
    whiteSpace: "nowrap",
    background: `linear-gradient(90deg, ${from}, ${to})`,
    color: fillText,
    // The active mode shows its brand color; the inactive one desaturates to grayscale.
    filter: active ? "none" : "grayscale(1)",
    opacity: active ? 1 : 0.9,
    transition: "filter 120ms ease, opacity 120ms ease",
    // Flex-align the (enlarged, line-height-0) glyph against the label so the
    // icon sits on the label's vertical center rather than its text baseline.
    display: "flex",
    alignItems: "center",
    justifyContent: justify,
    gap: 7,
  };
}

export interface PlanBuildToggleProps {
  mode: WorkMode;
  /** Plan is Beads-gated ([tools].beads): off → it disappears and Build spans the whole strip. */
  beadsEnabled: boolean;
  onPickPlan: () => void;
  onPickBuild: () => void;
  /** Extra margin for the placement (the sidebar insets it; the plan column doesn't). */
  style?: React.CSSProperties;
}

export function PlanBuildToggle({
  mode,
  beadsEnabled,
  onPickPlan,
  onPickBuild,
  style,
}: PlanBuildToggleProps) {
  return (
    <div
      style={{
        display: "flex",
        margin: "0 10px 8px",
        borderRadius: 8,
        overflow: "hidden",
        // Seam between chevrons = the column background (theme-aware), not white.
        background: C.deepForest,
        ...style,
      }}
    >
      {/* Plan / Build form one chevron strip painting a single blue→cyan fade. It's a MODE
          SELECTOR: the active chevron keeps its color, the other goes grayscale. Plan leads with
          the logo cyan, left-justified, and its flat-left edge is rounded by the wrapper. Build
          points-notch tessellates onto it. */}
      {beadsEnabled && (
        <button
          data-hint="plan"
          onClick={onPickPlan}
          title="Plan mode — this project's read-only Tasks board"
          // First in the strip: flat, wrapper-rounded left; points right into Build. Cyan leads,
          // dark ink, left-justified content.
          style={createBtnStyle(FADE_0, FADE_2, ON_BRAND_FILL_DARK, false, true, mode === "plan", "flex-start")}
        >
          <FaTasks size={14} style={{ flexShrink: 0 }} />
          <span>Plan</span>
        </button>
      )}
      <button
        data-hint="build"
        onClick={onPickBuild}
        title="Build mode — your Build orchestrator agents"
        // Last in the strip: notched left when Plan precedes it, flat right.
        style={createBtnStyle(FADE_2, FADE_3, ON_BRAND_FILL, beadsEnabled, false, mode === "build")}
      >
        <span style={{ fontSize: 26, lineHeight: 0, transform: "translateY(-3.5px)" }}>⚒</span>
        <span>Build</span>
      </button>
    </div>
  );
}
