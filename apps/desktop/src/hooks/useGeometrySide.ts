import { useContext } from "react";
import { geometrySideOf, pairCountFor, type PairSide } from "../engine/pairs";
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";
import { ZoomColumnOverride } from "./useZoomColumn";

/**
 * The side a pair is DRAWN as — see `engine/pairs.geometrySideOf`. Only call sites that decide a
 * DIRECTION (which way a pull tab grows, which edge an overlay anchors to, which end of a row opens
 * into the terminal) should read this; anything that names DATA (the cable, the assignment map,
 * per-side focus, width keys) keeps the pair's real side.
 *
 * A TORN-OFF (satellite) window has no concierge beside it, so the layout says nothing about its
 * geometry: it always draws as its own side. It is recognised the same way its zoom column is —
 * the `ZoomColumnOverride` context its root provides.
 *
 * EVERY SELECTOR HERE RETURNS A PRIMITIVE, and that is a performance contract, not tidiness: this
 * runs in EVERY build row. Selecting `projects` itself would re-render all of them whenever any
 * project changed — including on each agent selection, which rewrites that project's
 * `selectedAgentId` — and `AgentSidebar.switchCost.test.tsx` pins that a selection re-renders two
 * rows, not sixty.
 */
export function useGeometrySide(side: PairSide): PairSide {
  const satellite = useContext(ZoomColumnOverride) === "satellite";
  const layout = useUiStore((s) => s.conciergeLayout);
  const assignment = useUiStore((s) => s.pairAssignment);
  // The EFFECTIVE layout's one exception (engine/pairs `effectiveConciergeLayout`): a left-assigned
  // project forces CENTER, so the right pair is not drawn mirrored beside a real left pair. Read as
  // a boolean so a project-list change that does not flip it re-renders nothing.
  const forcedCenter = useProjectStore((s) => layout !== "center" && pairCountFor(s.projects, assignment) === 2);
  if (satellite) return side;
  return geometrySideOf(side, forcedCenter ? "center" : layout);
}
