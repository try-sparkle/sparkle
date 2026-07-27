// The open island: sparkle glyph, Needs-you / Running chiclets, Capture, collapse handle (spec §2).
//
// Presentational only — every interaction is a prop. That keeps the drag/visibility/IPC wiring in
// HelperApp and lets this file be tested with plain render+click, no Tauri.
import { C } from "@sparkle/ui";
import { CaptureIcon } from "./CaptureIcon";
import { ISLAND_H } from "./helperGeometry";
import type { Vitals } from "../services/helper";
import { bandCountLabel } from "../engine/statusBandLabels";
import type { StatusBand } from "../engine/buildSections";

// The island offers the two bands worth interrupting for. `done` is deliberately not a chiclet:
// on a resting fleet it is nearly every agent, so it would sit at a large constant number and
// drown the two that move. Clicking one ISOLATES that band in the Build column.
export type Tier = StatusBand;

const chiclet = {
  all: "unset" as const,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  gap: 5,
  fontFamily: '"IBM Plex Sans", sans-serif',
  fontSize: 13,
  fontWeight: 600,
  color: C.cream,
  padding: "3px 8px",
  borderRadius: 6,
};

function Dot({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      style={{ width: 7, height: 7, borderRadius: "50%", background: color, flex: "0 0 auto" }}
    />
  );
}

export function HelperIsland({
  vitals,
  captureBusy,
  captureError,
  onCapture,
  onCollapse,
  onChiclet,
  onDragStart,
}: {
  vitals: Vitals;
  captureBusy: boolean;
  /** One-line failure notice under the island; null when clean. */
  captureError: string | null;
  onCapture: () => void;
  onCollapse: () => void;
  onChiclet: (tier: Tier) => void;
  onDragStart: (e: React.PointerEvent) => void;
}) {
  return (
    <div
      style={{
        height: ISLAND_H,
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: "0 6px 0 10px",
        background: C.deepForest,
        // Matches HELPER_CORNER_RADIUS in mac_panel.rs — if these drift you get a visible seam
        // where the square webview corner meets the rounded window edge.
        borderRadius: 12,
        boxSizing: "border-box",
        // The strip itself is the drag surface; each control stops propagation on pointerdown so
        // reaching for Capture never starts a drag.
        cursor: "grab",
      }}
      onPointerDown={onDragStart}
    >
      <img src="/sparkle-logo.svg" alt="Sparkle" style={{ height: 16, flex: "0 0 auto" }} />

      <button
        data-testid="helper-needs-you"
        title="Agents that need you — click to show only these"
        style={chiclet}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => onChiclet("needs_you")}
      >
        <Dot color={C.sienna} />
        {bandCountLabel("needs_you", vitals.needsYou)}
      </button>

      <button
        data-testid="helper-running"
        title="Agents building right now — click to show only these"
        style={chiclet}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => onChiclet("running")}
      >
        <Dot color={C.success} />
        {bandCountLabel("running", vitals.running)}
      </button>

      <div style={{ flex: 1 }} />

      <button
        aria-label="Capture"
        title="Capture a screen region"
        disabled={captureBusy}
        style={{
          all: "unset",
          cursor: captureBusy ? "default" : "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: C.cream,
          background: C.teal,
          borderRadius: 6,
          padding: "6px 9px",
          opacity: captureBusy ? 0.55 : 1,
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onCapture}
      >
        <CaptureIcon />
      </button>

      <button
        aria-label="Minimize helper"
        title="Minimize to a pull tab"
        style={{
          all: "unset",
          cursor: "pointer",
          color: C.muted,
          display: "flex",
          alignItems: "center",
          padding: "6px 4px",
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onCollapse}
      >
        {/* Feather chevron-right, inlined — no emoji, no icon-font dependency in this webview. */}
        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>

      {captureError && (
        <div
          role="alert"
          style={{
            position: "absolute",
            top: ISLAND_H + 4,
            left: 0,
            right: 0,
            color: C.cream,
            background: C.sienna,
            fontSize: 11,
            padding: "4px 8px",
            borderRadius: 6,
          }}
        >
          {captureError}
        </div>
      )}
    </div>
  );
}
