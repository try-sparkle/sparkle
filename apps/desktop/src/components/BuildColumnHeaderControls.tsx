import { FiPlus, FiMinus } from "react-icons/fi";
import { C } from "../theme/colors";
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";
import { openProjectTab } from "../services/openProjectTab";
import { otherSide, pairCountFor, projectsOnSide } from "../engine/pairs";
import type { PairSide } from "../engine/rowGeometry";

/**
 * The two controls that live in the BUILD COLUMN'S HEADER BAND — not in the list, and not on a
 * boundary. Moved verbatim out of AgentSidebar.tsx; no logic change.
 *
 * `PairCountControl` adds or removes a whole pair; `SubtreeDisclosureControl` expands or collapses
 * every worker subtree at once. They are grouped because they answer the same question — "what does
 * the column's own chrome do", as opposed to what a row does — and because that makes the header a
 * separate edit surface from the rows beneath it.
 */
/**
 * ADD OR REMOVE A WHOLE PAIR — `.plus` in MAPPING.md, and the fix for a ONE-WAY DOOR.
 *
 * This replaces a `«` chevron that MOVED this project to the other side of the concierge. The pair
 * count is derived from the assignment map rather than stored (engine/pairs.pairCountFor), so
 * sending the last left-side project back collapsed the second pair — which worked, and which the
 * user could not undo, because nothing about a chevron says anything can come back. Their words:
 * "now I don't know how to open it back up." An action that removes half the cockpit needs a
 * visible inverse, not a technically-reachable one.
 *
 * PLUS AND MINUS ARE SELF-EVIDENTLY INVERSE, which a direction glyph is not. The pair count is a
 * two-state thing, so the control is two-state and reversible:
 *
 *   one pair open  → PLUS,  opens the mirrored pair on the other side
 *   both open      → MINUS, closes this one and returns its projects to the other side
 *
 * WHY IT LIVES HERE, next to the filter chips, and not on the boundary. There are three distinct
 * controls in play now and confusing them is the real hazard: the 6-dot grip RESIZES a boundary,
 * the arrow OVERLAYS across a boundary, and this ADDS OR REMOVES A PAIR. The first two act ON a
 * boundary and belong on it; this one acts on the COLUMN'S EXISTENCE and belongs in the column's
 * own header. Boundary controls on the boundary, column controls in the column.
 *
 * ON HOVER, per the ask — it is a rare, structural action and does not earn permanent space in the
 * header row, which is the column's scarcest. Focus reveals it too: hover-only is a mouse rule, and
 * a keyboard user tabbing onto a control that paints nothing has no idea what they are on.
 */
export function PairCountControl({
  projectId,
  pairSide,
  shown,
}: {
  projectId: string;
  pairSide: PairSide;
  /** Revealed by the HEADER's hover/focus, never by this button's own — a hidden box cannot be
   *  hovered or tabbed to, so a self-revealing control is a dead control. See the header. */
  shown: boolean;
}) {
  const projects = useProjectStore((s) => s.projects);
  const pairAssignment = useUiStore((s) => s.pairAssignment);
  const assignProjectToPair = useUiStore((s) => s.assignProjectToPair);
  const pairs = pairCountFor(projects, pairAssignment);
  const willOpen = pairs === 1;

  // CLOSING RETURNS EVERY PROJECT ON THE LEFT, not just the one whose column was clicked. Moving
  // only this project would leave the pair open holding the others — a "close" that does not close,
  // which is how the original control read as unpredictable.
  //
  // AND IT LANDS A SELECTION. Reassigning alone leaves `selectedProjectId` pointing wherever it was,
  // so the project the user was looking at when they clicked MINUS silently is not the one the
  // surviving pair shows — their context disappears with the column. That is the same hole the
  // deleted chevron's own comment recorded (roborev 55149); the open branch always called
  // `openProjectTab` and the close branch was the asymmetric one.
  const toggle = () => {
    if (willOpen) {
      assignProjectToPair(projectId, otherSide(pairSide));
      openProjectTab(projectId);
      return;
    }
    const moved = projectsOnSide(projects, pairAssignment, "left");
    for (const p of moved) assignProjectToPair(p.id, "right");
    // Follow the project the user was on when it is one of the ones that just moved; otherwise the
    // first returned project, so the surviving pair always names something real.
    const follow = moved.some((p) => p.id === projectId) ? projectId : moved[0]?.id;
    if (follow) openProjectTab(follow);
  };

  // THE COPY NAMES THE LEFT PAIR EXPLICITLY, because this control renders in BOTH columns and
  // "the second pair" / "this side" are wrong in at least one of them. From the right column MINUS
  // destroys the OTHER column; from the left column the projects go to the other side and this side
  // ceases to exist, so "return its projects to this side" was false there. A user who reads either
  // string has to predict the right outcome — remedy copy is code (roborev 55349).
  const label = willOpen
    ? "Open the left pair"
    : "Close the left pair — its projects return to the right";

  return (
    <button
      type="button"
      data-testid="pair-count-control"
      data-shown={String(shown)}
      onClick={toggle}
      aria-label={label}
      title={label}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flex: "0 0 auto",
        width: 16,
        height: 16,
        padding: 0,
        marginLeft: 4,
        background: "none",
        border: "none",
        cursor: "pointer",
        color: C.muted,
        // `opacity` + `pointerEvents`, NOT `visibility`. A `visibility: hidden` control is removed
        // from sequential focus navigation, so a keyboard user could never reach it; this one stays
        // focusable, and a Tab onto it bubbles focus to the header, which reveals it.
        opacity: shown ? 1 : 0,
        pointerEvents: shown ? "auto" : "none",
        transition: "opacity 120ms ease",
      }}
    >
      {willOpen ? <FiPlus size={14} aria-hidden /> : <FiMinus size={14} aria-hidden />}
    </button>
  );
}

/**
 * EXPAND ALL / COLLAPSE ALL — a filled triangle pointing DOWN and one pointing UP, in the column
 * header where the `«` chevron used to sit.
 *
 * WHY TRIANGLES. They are the same shape the per-row disclosure uses, so the pair reads as "do that,
 * to everything" without a text label. That similarity is also the one risk: at this size a bare
 * triangle pair can be misread as ONE row's disclosure control rather than a column-wide one. Three
 * things separate it, none of them a label:
 *
 *   1. It sits inside the header BAND, above the list's own hairline — structurally not in the rows.
 *   2. The pair is boxed as a single grouped unit (one border, one background, a hairline between
 *      the two halves), which no row-level chevron ever is.
 *   3. Both directions are visible at once. A row's disclosure shows ONE triangle whose direction is
 *      that row's state; two opposed triangles side by side cannot be a single row's state.
 *
 * Inline SVG polygons rather than an icon-set glyph: Feather (`react-icons/fi`) is a stroked set
 * with no FILLED triangle, and the fill is what makes these read as the row affordance rather than
 * as a chevron. (Emoji are banned outright as icons in this codebase.)
 *
 * Both halves stay live regardless of the column's state — a "collapse all" on an already-collapsed
 * column is a no-op the store absorbs identity-stably, and disabling it would make the control
 * flicker in and out of reach as workers come and go.
 */
export function SubtreeDisclosureControl({
  headIds,
  allExpanded,
  allCollapsed,
}: {
  headIds: readonly string[];
  allExpanded: boolean;
  allCollapsed: boolean;
}) {
  const setOrchestratorsCollapsed = useUiStore((s) => s.setOrchestratorsCollapsed);
  const half = (dir: "expand" | "collapse") => {
    const isExpand = dir === "expand";
    return (
      <button
        type="button"
        data-testid={isExpand ? "expand-all-subtrees" : "collapse-all-subtrees"}
        aria-label={
          isExpand
            ? `Expand all worker subtrees (${headIds.length})`
            : `Collapse all worker subtrees (${headIds.length})`
        }
        title={isExpand ? "Expand all workers" : "Collapse all workers"}
        onClick={() => setOrchestratorsCollapsed(headIds, !isExpand)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 20,
          height: 18,
          padding: 0,
          background: "transparent",
          border: "none",
          // The hairline BETWEEN the two halves, so they read as one segmented control rather than
          // two loose buttons that happen to be adjacent.
          borderLeft: isExpand ? "none" : `1px solid ${C.hairline}`,
          cursor: "pointer",
          // The direction the column is already fully in is dimmed — still pressable, but it tells
          // the user at a glance which way there is anything left to do. A MIXED column dims
          // NEITHER half: both would change something, so `!allExpanded` is the wrong test for
          // "already fully collapsed" and painted a live control dead.
          color: (isExpand ? allExpanded : allCollapsed) ? C.hairline : C.muted,
        }}
      >
        <svg width={9} height={9} viewBox="0 0 10 10" aria-hidden focusable="false">
          {/* Filled, and pointing DOWN for expand / UP for collapse — the same direction sense as a
              row's own disclosure triangle. */}
          <polygon points={isExpand ? "1,3 9,3 5,8" : "5,2 9,7 1,7"} fill="currentColor" />
        </svg>
      </button>
    );
  };
  return (
    <div
      data-testid="subtree-disclosure-control"
      role="group"
      aria-label="Worker subtrees"
      style={{
        display: "inline-flex",
        alignItems: "center",
        flex: "0 0 auto",
        border: `1px solid ${C.hairline}`,
        borderRadius: 4,
        overflow: "hidden",
      }}
    >
      {half("expand")}
      {half("collapse")}
    </div>
  );
}
