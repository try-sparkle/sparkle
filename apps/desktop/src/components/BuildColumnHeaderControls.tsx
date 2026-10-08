import { C } from "../theme/colors";
import { useUiStore } from "../stores/uiStore";

/**
 * The control that lives in the BUILD COLUMN'S HEADER BAND — not in the list, and not on a
 * boundary. Moved verbatim out of AgentSidebar.tsx; no logic change.
 *
 * `SubtreeDisclosureControl` expands or collapses every worker subtree at once.
 *
 * `PairCountControl` (a hover-only +/− that added or removed the left pair) USED TO LIVE HERE and was
 * removed on purpose: an accidental − took half the window away with nothing visible to bring it
 * back (epic sparkle-5ua3br). Which pairs exist is now Settings → Appearance → Layout.
 */
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
