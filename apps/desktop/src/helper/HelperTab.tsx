// The minimized helper: the sparkle mark alone, docked at a screen edge. Click restores the island.
//
// It used to be a 16×64 sliver holding three grey grip dots, which the founder read as "super
// compressed... a flat pancake". Two things were wrong with it and only one was CSS: nothing
// recognisable fits in 16px, and the OS WINDOW was that shape too, so no amount of DOM work inside
// it could have looked like anything else. Minimized is now a square chip (TAB_W === TAB_H, pinned
// by test) containing the same brand mark the island shows — collapsing reads as the island folding
// down INTO its icon rather than turning into an unlabelled grey sliver.
import { C } from "@sparkle/ui";
import { SparkleMark } from "./SparkleMark";
import { TAB_W, TAB_H, type Edge } from "./helperGeometry";

/** The mark inside the chip. Leaves ~7px of breathing room on each side of a 36px tab — enough for
 *  the chip to read as a button rather than as a bare glyph, without shrinking the artwork to the
 *  point where its three sparkles blur together. */
const MARK = 22;

export function HelperTab({
  edge,
  onExpand,
  onDragStart,
}: {
  edge: Edge;
  onExpand: () => void;
  onDragStart: (e: React.PointerEvent) => void;
}) {
  // Round only the corners facing INTO the screen, so the tab reads as attached to the edge
  // rather than floating just short of it. 12px, matching HELPER_CORNER_RADIUS in mac_panel.rs:
  // the window's own layer is rounded at that radius, so a smaller CSS radius just leaves a seam
  // between the painted chip and the clipped window.
  const borderRadius = edge === "left" ? "0 12px 12px 0" : "12px 0 0 12px";
  return (
    <button
      aria-label="Show Sparkle helper"
      title="Show Sparkle helper"
      style={{
        all: "unset",
        // Click is the primary action (restore); dragging is the secondary one. Same rule the
        // island follows — what you CLICK says pointer.
        cursor: "pointer",
        width: TAB_W,
        height: TAB_H,
        boxSizing: "border-box",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: C.deepForest,
        borderRadius,
      }}
      onPointerDown={onDragStart}
      onClick={onExpand}
    >
      {/* alt="" — the button above already carries the accessible name, and a mark that also
          announced "Sparkle" would just say it twice. */}
      <SparkleMark size={MARK} cursor="pointer" alt="" />
    </button>
  );
}
