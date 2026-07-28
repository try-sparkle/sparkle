// The open island: sparkle glyph, Needs-you / Running chiclets, Capture, collapse handle (spec §2).
//
// Presentational only — every interaction is a prop. That keeps the drag/visibility/IPC wiring in
// HelperApp and lets this file be tested with plain render+click, no Tauri.
//
// CURSORS FOLLOW ONE RULE, because the island is the rare surface that both drags and clicks:
// what you DRAG gets `grab`, what you CLICK gets `pointer`. The island BODY is the drag handle
// (onDragStart), so it keeps `grab`; the sparkle mark sits on that same drag surface and says
// `grab` EXPLICITLY rather than inheriting, because it is the handle users actually reach for and
// the rule should be visible where the thing is defined. Every control — both chiclets, Capture,
// the collapse handle — is a click and says `pointer`. Capture's busy state is the one exception
// (`default`),
// which is honest: while a capture is in flight the button is disabled and clicking does nothing.
// helperIsland cursor coverage is pinned by test, because a missing `pointer` is invisible in
// review and reads to the user as "this panel isn't interactive".
import { C } from "@sparkle/ui";
import { CaptureIcon } from "./CaptureIcon";
import { SparkleMark } from "./SparkleMark";
import { ERROR_W, type Edge } from "./helperGeometry";
import type { Vitals } from "../services/helper";
import { bandColor, bandCountLabel } from "../engine/statusBandLabels";
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
  fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  fontSize: 13,
  fontWeight: 600,
  color: C.cream,
  padding: "3px 8px",
  borderRadius: 6,
};

// Hover well, shared by every control on the island. C.forest is DARKER than the island's
// C.deepForest, so a hovered control reads as pressed into the strip rather than pasted onto it —
// and it is a token, not a one-off rgba, so it tracks the palette.
const HOVER_BG = C.forest;
const hoverIn = (e: React.MouseEvent<HTMLElement>) => {
  e.currentTarget.style.background = HOVER_BG;
};
const hoverOut = (e: React.MouseEvent<HTMLElement>) => {
  e.currentTarget.style.background = "transparent";
};

function Dot({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      style={{ width: 7, height: 7, borderRadius: "50%", background: color, flex: "0 0 auto" }}
    />
  );
}

/**
 * A band chiclet: a colored dot and a bare count, nothing else.
 *
 * The prose ("3 Need you") was dropped because two labelled counts plus a wordmark plus Capture
 * crowded the island — and now that the island sizes to its content, every extra word is extra
 * window sitting over the user's screen. The dot already carries the band, so the words were
 * saying it twice. But a bare "3" is meaningless to a screen reader, and `Dot` is
 * aria-hidden, so the visible text is ALL the semantics there used to be. The meaning is moved,
 * not deleted: `bandCountLabel` — the same helper the sidebar and ScopeVitals use, so singular
 * agreement ("1 Needs you" vs "3 Need you") stays consistent — now feeds the aria-label and the
 * title. The label is what assistive tech announces; the title is how a sighted user finds out
 * what a naked colored dot means.
 */
function BandChiclet({
  band,
  count,
  testId,
  onSelect,
}: {
  band: StatusBand;
  count: number;
  testId: string;
  onSelect: () => void;
}) {
  // "3 Need you — click to show only these". One string for both, so they cannot drift.
  const label = `${bandCountLabel(band, count)} — click to show only these`;
  return (
    <button
      data-testid={testId}
      aria-label={label}
      title={label}
      style={chiclet}
      onMouseEnter={hoverIn}
      onMouseLeave={hoverOut}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onSelect}
    >
      <Dot color={bandColor(band)} />
      {count}
    </button>
  );
}

export function HelperIsland({
  vitals,
  captureBusy,
  captureError,
  edge = "right",
  onCapture,
  onCollapse,
  onChiclet,
  onDragStart,
}: {
  vitals: Vitals;
  captureBusy: boolean;
  /** One-line failure notice under the island; null when clean. */
  captureError: string | null;
  /** Which screen edge the island collapses toward — points the collapse chevrons at it. */
  edge?: Edge;
  onCapture: () => void;
  onCollapse: () => void;
  onChiclet: (tier: Tier) => void;
  onDragStart: (e: React.PointerEvent) => void;
}) {
  return (
    <div
      style={{
        // NO fixed width or height. The island HUGS what it renders: `max-content` sizes it to the
        // mark, the two chiclets and the two buttons and nothing more, and the height falls out of
        // the padding. It used to be a hard 268×44 with a `flex: 1` spacer holding Capture out to
        // the right edge, which left ~88px of bare C.deepForest across the middle — the "big block
        // of blue space" in the report. HelperApp measures this box and resizes the OS WINDOW to
        // it, which is the other half of the fix: on a transparent always-on-top panel, empty space
        // left in the window is exactly as visible as empty space left in the pill.
        //
        // `max-content` rather than `fit-content`: fit-content is capped by the available width, so
        // a frame where the window is momentarily narrower than the strip would shrink the content,
        // which would shrink the measurement, which would shrink the window — a resize loop.
        width: "max-content",
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        flexWrap: "nowrap",
        whiteSpace: "nowrap",
        gap: 4,
        padding: "6px 8px 6px 10px",
        background: C.deepForest,
        // Matches HELPER_CORNER_RADIUS in mac_panel.rs — if these drift you get a visible seam
        // where the square webview corner meets the rounded window edge.
        borderRadius: 6,
        boxSizing: "border-box",
        // The capture-failure notice hangs off the bottom of THIS box, so it must be the
        // positioning context — otherwise it anchors to the wrapper and needs a hardcoded offset
        // that goes stale the moment the island's height stops being a constant.
        position: "relative",
        // The strip itself is the drag surface; each control stops propagation on pointerdown so
        // reaching for Capture never starts a drag.
        cursor: "grab",
        // A drag across the strip must not paint a text selection over the counts.
        userSelect: "none",
      }}
      onPointerDown={onDragStart}
    >
      {/*
        The SQUARE mark, not the "sparkle.ai" wordmark. The wordmark is 850×188, so at 16px tall
        it ate ~72px to repeat branding the user already knows. The mark is the same brand asset at
        a square footprint (~18px), and the space it gives back is what makes room for the collapse
        handle to be legible.

        It is also the island's DRAG HANDLE — the one the user reaches for first. It deliberately
        does NOT stop propagation on pointerdown (every control around it does), so pressing it
        starts the same drag the strip does; see SparkleMark for why a plain <img> could not.
      */}
      <SparkleMark size={18} cursor="grab" />

      <BandChiclet
        band="needs_you"
        count={vitals.needsYou}
        testId="helper-needs-you"
        onSelect={() => onChiclet("needs_you")}
      />

      <BandChiclet
        band="running"
        count={vitals.running}
        testId="helper-running"
        onSelect={() => onChiclet("running")}
      />

      {/* No flex spacer here. It was `<div style={{ flex: 1 }} />`, and against a fixed 268px
          island it WAS the block of empty navy — a spacer's whole job is to manufacture dead space.
          The controls now sit directly after the counts; the 6px margin below is a deliberate
          grouping gap between "what is happening" and "what you can do about it", not filler. */}
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
          marginLeft: 6,
          opacity: captureBusy ? 0.55 : 1,
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onCapture}
      >
        <CaptureIcon />
      </button>

      {/*
        The collapse handle. It was a single chevron at C.muted and the founder could not find it —
        so this is a discoverability fix, not a new control. Two changes, both cheap in pixels
        because fix-the-wordmark bought the room, and no text label (a label is exactly the space
        being reclaimed):

        1. It rests at C.cream, the same weight as the chiclet counts, instead of the C.muted used
           for metadata the user is not meant to act on. It reads as a control at rest now.
        2. It gains the shared hover well, so pointing at it confirms it is interactive.

        DOUBLE chevrons, pointed at `edge`. A single ">" is the "next / expand" idiom and said the
        opposite of what this button does. A double ">>" is the established "collapse this panel
        to the side" idiom, and aiming it at the edge the island actually docks to makes the
        direction a true statement about where the thing goes rather than decoration.
      */}
      <button
        aria-label="Minimize helper"
        title="Minimize to a pull tab"
        style={{
          all: "unset",
          cursor: "pointer",
          color: C.cream,
          display: "flex",
          alignItems: "center",
          background: "transparent",
          borderRadius: 6,
          padding: "6px 4px",
        }}
        onMouseEnter={hoverIn}
        onMouseLeave={hoverOut}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onCollapse}
      >
        {/* Feather chevrons-right/left, inlined — no emoji, no icon-font dependency in this webview. */}
        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
             data-testid="helper-collapse-chevrons">
          {edge === "left" ? (
            <>
              <polyline points="11 17 6 12 11 7" />
              <polyline points="18 17 13 12 18 7" />
            </>
          ) : (
            <>
              <polyline points="13 17 18 12 13 7" />
              <polyline points="6 17 11 12 6 7" />
            </>
          )}
        </svg>
      </button>

      {captureError && (
        <div
          role="alert"
          style={{
            position: "absolute",
            // Hangs off the bottom of the island, whatever height the island turned out to be —
            // a constant offset here would go stale now that the island sizes to its content.
            top: "100%",
            marginTop: 4,
            left: 0,
            // Its OWN width, not the island's: this is a line of prose and the hugged island is
            // only as wide as two counts and two buttons. windowSize widens the window to ERROR_W
            // whenever this is up, so the two agree by construction.
            width: ERROR_W,
            boxSizing: "border-box",
            color: C.cream,
            background: C.sienna,
            fontSize: 12,
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
