// The Plan / Build segmented toggle — the HEADER of column 2 in the concierge shell
// (PRD/sparkle/concierge-mode.md §3: "Header is a Plan / Build segmented toggle … not a static
// title"), extracted from AgentSidebar so BOTH homes can render the identical control:
//   - Build mode: it sits at the top of the agent column (its original home).
//   - Plan mode:  columns 2 + 3 collapse into ONE wide Plan-card column, and this is that
//     column's header — so the way back to Build is exactly where it was.
//
// Presentational + prop-driven: the callers own what a click DOES (AgentSidebar keeps its
// two-stage Build chevron, which spawns a fresh build agent on a second click).
import { C, ON_GOLD_FILL } from "../theme/colors";
import { FONT_UI, RADIUS, TYPE } from "../theme/scale";
import { FaTasks } from "react-icons/fa";
import { FiTool } from "react-icons/fi";
import type { WorkMode } from "../stores/uiStore";

// ── THE STRIP IS GOLD NOW, AND FLAT ─────────────────────────────────────────────────────────────
// It used to paint one continuous cyan→blue fade across Plan and Build, with an interpolated
// literal (#3192fa) at the seam. That made the second-largest coloured surface in the shell a hue
// `packages/ui/tokens.ts` classifies as DECORATIVE, directly beside a gold Send button and a gold
// wordmark — the "mishmash of shades and colours" this pass exists to end. Gold is the declared
// primary accent; the mode selector is the app's most prominent control, so it is the thing that
// should be carrying it.
//
// The FADE IS GONE rather than re-tinted, and the reason is a floor, not taste. A themed gold
// gradient needs two themed stops, and every candidate for the lighter end came in around 3.5:1
// against white ink in LIGHT mode — under AA for 13px labels. One themed fill has the pairing the
// palette already guarantees (`onGoldFill` on `goldFill`, asserted in theme/chromeContrast.test.ts)
// and the strip loses nothing legible: the chevron tessellation, the seam hairline and the
// grayscale-on-inactive treatment are what actually separate the two modes.
//
// The chevron's FILL, and nothing else's. It used to be exported because AgentSidebar read it for
// the "+ New Build Agent" hover tint — that is exactly the mix-up BUILD_INK below fixed, so the
// export is gone with it: a fill token reachable from outside this file is an invitation to paint
// text with it again. It pairs with ON_GOLD_FILL, which the palette guarantees (chromeContrast).
const BUILD_FILL = C.goldFill;

// The SAME accent as ink, and the distinction is a GUARANTEE rather than a shade preference
// (roborev 53986). `goldFill` is a FILL: the guard holds it to CONTROL_MIN_CONTRAST (3:1), because
// surviving its own edge is all a fill has to do. `goldInk` is swept at the AA ink floor (4.5) on
// every plane. `NewAgentRow` applies its `hoverColor` to `color` and `borderColor` — a 13px label,
// i.e. TEXT — so it takes the ink.
//
// THE NUMBERS THAT USED TO BE HERE ARE GONE ON PURPOSE. This block justified the split by measuring
// light's `goldFill` at ≈3.2:1 on `deepForest`, under AA. Blueprint moved both tokens and that is
// no longer true — the fill measures 5.201 there and the ink 6.085, so today either would read.
// The split stays anyway, and stating why is the point: 5.201 is SLACK, not a promise. Nothing
// asserts it, so the next repaint may spend it, and a label painted with the fill would go
// illegible with every guard still green. Fill for the chevron, ink for the label; one accent with
// two floors, and the label depends on the stronger one.
export const BUILD_INK = C.goldInk;

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

// Shared style for a chevron in the mode strip: one solid fill with NO border/stroke, clipped to
// its chevron shape. The strip's rounded outer corners come from the wrapper (overflow:hidden +
// borderRadius), so the chevrons themselves are square; `leftNotch` chevrons overlap the previous
// one by CHEVRON px (negative margin) so the point tessellates exactly into the notch. `active` is
// the currently selected mode: the active chevron keeps its gold; the inactive one renders
// grayscale. `justify` places the glyph+label: Plan is left-justified (its flat-left,
// wrapper-rounded edge reads like the old Think tab), Build stays centered.
function createBtnStyle(
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
    fontFamily: FONT_UI,
    fontSize: 13,
    whiteSpace: "nowrap",
    background: BUILD_FILL,
    color: ON_GOLD_FILL,
    // The active mode shows its brand color; the inactive one desaturates to grayscale.
    //
    // GRAYSCALE ONLY — the 0.9 opacity that used to ride with it is gone (roborev 54002). Opacity
    // composites the whole button, LABEL INCLUDED, over the plane behind it, so it lightened the
    // fill and dimmed the ink at the same time, dropping a 13px label under AA on the app's most
    // prominent control. Desaturation alone is what says "inactive" and it costs almost nothing:
    // under Blueprint the grayscaled fill measures 6.06:1 against `onGoldFill` in dark (active pair
    // 6.61) and 8.72:1 in light (active pair 7.57) — light's inactive state is actually the
    // stronger of the two, because a deep blue greys to a mid grey under white ink.
    // theme/chromeContrast.test.ts measures the grayscaled fill against the ink, not only the
    // active pair, so this stays true through a repaint rather than being re-derived by hand.
    filter: active ? "none" : "grayscale(1)",
    transition: "filter 120ms ease",
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
  /**
   * `"chevron"` (default) is the full-width gold chevron strip — the Plan column's header and the
   * satellite window's, where it IS the header and has the width to be one.
   *
   * `"mini"` is the blueprint cockpit's `.mini`: a bordered ~19px segment that shares a 34px `.bhd`
   * header row with the status-filter chips. The chevron strip cannot live in that row — it is
   * taller than the row and full-width by construction — and the alternative was a SECOND
   * Plan/Build control drawn inline in AgentSidebar, i.e. two implementations of one mode selector
   * left to drift apart. One component, two placements, which is what this file's own header
   * already argues for.
   */
  variant?: "chevron" | "mini";
}

/** `.mini span` from rev4.html: `font-size:var(--t-micro);padding:2px 7px;color:var(--k-muted)`,
 *  with the selected one taking the accent fill. Squared to `--r-sm` by the wrapper's overflow. */
function miniSegStyle(active: boolean): React.CSSProperties {
  return {
    appearance: "none",
    border: "none",
    borderRadius: 0,
    padding: "2px 7px",
    cursor: "pointer",
    fontFamily: FONT_UI,
    fontSize: TYPE.micro,
    lineHeight: 1,
    whiteSpace: "nowrap",
    background: active ? C.goldFill : "transparent",
    color: active ? ON_GOLD_FILL : C.muted,
  };
}

export function PlanBuildToggle({
  mode,
  beadsEnabled,
  onPickPlan,
  onPickBuild,
  style,
  variant = "chevron",
}: PlanBuildToggleProps) {
  if (variant === "mini") {
    return (
      <span
        data-testid="plan-build-mini"
        style={{
          display: "inline-flex",
          flex: "0 0 auto",
          border: `1px solid ${C.pillFill}`,
          borderRadius: RADIUS.sm,
          overflow: "hidden",
          ...style,
        }}
      >
        {/* BUILD FIRST, then Plan — the mock's own order (`<span class="on">Build</span><span>
            Plan</span>`), and it inverts the chevron strip's. That is deliberate rather than an
            oversight: this segment lives at the top of the BUILD column, where Build is the mode
            you are in and Plan is the way out, whereas the chevron strip is the Plan column's own
            header. The two are never on screen together. */}
        <button
          data-hint="build"
          onClick={onPickBuild}
          aria-pressed={mode === "build"}
          title="Build mode — your Build orchestrator agents"
          style={miniSegStyle(mode === "build")}
        >
          Build
        </button>
        {beadsEnabled && (
          <button
            data-hint="plan"
            onClick={onPickPlan}
            aria-pressed={mode === "plan"}
            title="Plan mode — this project's read-only Tasks board"
            style={miniSegStyle(mode === "plan")}
          >
            Plan
          </button>
        )}
      </span>
    );
  }
  return (
    <div
      style={{
        display: "flex",
        margin: "0 10px 8px",
        borderRadius: 6,
        overflow: "hidden",
        // Seam between chevrons = the column background (theme-aware), not white.
        background: C.deepForest,
        ...style,
      }}
    >
      {/* Plan / Build form one chevron strip in the shell's primary gold. It's a MODE SELECTOR:
          the active chevron keeps its colour, the other goes grayscale. Plan's flat-left edge is
          rounded by the wrapper; Build's point-notch tessellates onto it. */}
      {beadsEnabled && (
        <button
          data-hint="plan"
          onClick={onPickPlan}
          title="Plan mode — this project's read-only Tasks board"
          // First in the strip: flat, wrapper-rounded left; points right into Build.
          style={createBtnStyle(false, true, mode === "plan", "flex-start")}
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
        style={createBtnStyle(beadsEnabled, false, mode === "build")}
      >
        {/* A react-icon, not the ⚒ character it replaced: this repo bans emoji-as-icons, and a
            glyph that renders from the system emoji font also ignores `color`, so it was the one
            mark on the strip that could not follow the gold ink. */}
        <FiTool size={15} style={{ flexShrink: 0 }} />
        <span>Build</span>
      </button>
    </div>
  );
}
