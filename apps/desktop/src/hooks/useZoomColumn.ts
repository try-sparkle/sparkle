// WHICH COLUMN AM I IN, ASKED BY THE COLUMN ITSELF — the read side of per-column zoom.
//
// `columnFocusTracker` answers "where is the user" for the KEYBOARD. This answers the mirror-image
// question for the RENDER: a pane that is about to scale its own text needs to know which of the six
// levels is its own. The two must agree, and they do because both resolve to the same `ZoomColumn`
// keys — the tracker by reading `data-zoom-column` off the DOM, this by deriving the value that same
// attribute is rendered FROM.
//
// ── WHY A PANE CANNOT SIMPLY BE TOLD ───────────────────────────────────────────────────────────
//
// It has no static side. `engine/pairs` explains the shape: every agent pane is mounted EXACTLY
// ONCE, at the shell root, and PORTALLED into whichever stage its project's side owns. That indirect
// mounting is load-bearing — re-parenting a pane by rendering it under a different JSX parent
// unmounts it, and a `Terminal` unmount kills its PTY — so a pane's column is a function of the
// live assignment map, not of where its JSX sits. Moving a project to the other pair must therefore
// change which zoom level its terminal reads, without the component being touched. Reading the map
// here does exactly that; a prop threaded from the stage could not, because the stage is not the
// pane's React parent.
//
// ── AND WHY THE SATELLITE NEEDS AN OVERRIDE ────────────────────────────────────────────────────
//
// A torn-off terminal renders the same `AgentPane` → `Terminal` tree in its OWN window, where the
// cockpit does not exist: there are no pairs, no concierge, and exactly one region on screen. Its
// project still has a side in the shared assignment map, so the derivation below would happily
// return `terminal-right` and silently tie the satellite's text size to a column in a different
// window. The context is how that window says "the cockpit answer does not apply to me" — one
// provider at its root, rather than an `isSatellite` flag threaded through every component between.

import { createContext, useContext } from "react";
import { sideOf } from "../engine/pairs";
import { zoomColumnFor, type ZoomColumn } from "../engine/columnZoom";
import { useUiStore } from "../stores/uiStore";

/**
 * An explicit column for every pane rendered beneath it, overriding the cockpit derivation.
 *
 * `null` — the default — means "derive it", which is what the main window wants everywhere. Only the
 * satellite provides a value.
 */
export const ZoomColumnOverride = createContext<ZoomColumn | null>(null);

/**
 * The zoom level key for a pane of `kind` belonging to `projectId`.
 *
 * `projectId` may be null (the setup checklist and the login modal both mount a `Terminal` with no
 * project). `sideOf` is total and answers `"right"` for anything unassigned, which is the historical
 * single-pair home and the correct answer for those surfaces — they render in the right half.
 */
export function useZoomColumn(projectId: string | null, kind: "terminal" | "build"): ZoomColumn {
  const override = useContext(ZoomColumnOverride);
  // Subscribed unconditionally: hooks may not be called behind a branch, and the selector returns
  // the same object reference when the map has not changed, so an override'd satellite pays one
  // reference comparison per assignment change and never re-renders for it.
  const assignment = useUiStore((s) => s.pairAssignment);
  if (override) return override;
  return zoomColumnFor(kind, sideOf(assignment, projectId ?? ""));
}

/**
 * The zoom column for a pane that already knows its SIDE — the build column's form of the question.
 *
 * SEPARATE FROM `useZoomColumn` because a build column does not derive its side from a project id;
 * `AgentSidebar` computes `pairSide` itself (from the assignment map, a forced side, or its slot).
 * What it must NOT do is skip the override: the satellite renders `AgentSidebar` with
 * `forcePairSide="right"`, so a direct `zoomColumnFor("build", "right")` resolves to the MAIN
 * window's right builder — a shared, persisted level — and the satellite's build column would
 * silently resize when the cockpit's did, while its own Cmd +/- (which steps `"satellite"`) moved
 * nothing. That is the exact coupling `ZoomColumnOverride` exists to prevent, and it held only for
 * `Terminal` until this existed.
 */
export function useZoomColumnForSide(kind: "terminal" | "build", side: "left" | "right"): ZoomColumn {
  const override = useContext(ZoomColumnOverride);
  return override ?? zoomColumnFor(kind, side);
}

/** The live zoom factor for one column. A thin selector, but spelled once so that no caller
 *  re-implements the `?? ZOOM_DEFAULT` fallback differently — a `undefined` reaching a font-size
 *  multiplication is the `NaN` failure `repairZoomByColumn` exists to prevent, and a second
 *  fallback written by hand is how it would come back. */
export function useColumnZoom(column: ZoomColumn): number {
  return useUiStore((s) => s.zoomByColumn[column] ?? 1);
}
