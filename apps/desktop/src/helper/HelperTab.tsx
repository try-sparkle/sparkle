// The minimized pull tab: a thin sliver docked at a screen edge. Click restores the island.
import { C } from "@sparkle/ui";
import { TAB_W, TAB_H, type Edge } from "./helperGeometry";

function GripDot() {
  return <span style={{ width: 3, height: 3, borderRadius: "50%", background: C.muted }} />;
}

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
  // rather than floating just short of it.
  const borderRadius = edge === "left" ? "0 8px 8px 0" : "8px 0 0 8px";
  return (
    <button
      aria-label="Show Sparkle helper"
      title="Show Sparkle helper"
      style={{
        all: "unset",
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
      {/* A grip: three dots, echoing the island's three-element layout. */}
      <span aria-hidden="true" style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        <GripDot />
        <GripDot />
        <GripDot />
      </span>
    </button>
  );
}
