import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { FiAlertTriangle } from "react-icons/fi";
import { C, ON_BRAND_FILL } from "../theme/colors";
import { FONT_UI, TYPE } from "../theme/scale";
import { useSettingsStore } from "../stores/settingsStore";
import { safeUnlisten } from "../services/safeUnlisten";
import {
  describeSpanTarget,
  fitWindowToCurrentDisplay,
  getDisplayLayout,
  modesAgree,
  onDisplaysChanged,
  resetWindowSize,
  spanWindow,
  type DisplayLayout,
  type SpanMode,
} from "../services/displaySpan";

// The Appearance → Window group: run Sparkle as one wide window across every attached display.
//
// macOS cannot merge displays into a single logical monitor; the achievable thing is a unified
// desktop with one window straddling all of them. See src-tauri/src/display_span.rs for why the
// SHAPE of that window is the hard part (displays of different heights don't union into a
// rectangle) and what the two modes actually differ on.

const SPAN_MODES: Array<{ value: SpanMode; label: string; hint: string }> = [
  {
    value: "safe",
    label: "Safe rectangle",
    hint: "Largest area that's fully on-screen everywhere. Gives up a band; never hides UI.",
  },
  {
    value: "full",
    label: "Full bounds",
    hint: "Reaches every edge. Corners no display covers are drawn but invisible.",
  },
];

export function WindowSpanControls() {
  const spanMode = useSettingsStore((s) => s.windowSpanMode);
  const setSpanMode = useSettingsStore((s) => s.setWindowSpanMode);
  const autoRespan = useSettingsStore((s) => s.windowAutoRespan);
  const setAutoRespan = useSettingsStore((s) => s.setWindowAutoRespan);
  const setIsSpanned = useSettingsStore((s) => s.setWindowIsSpanned);

  const [layout, setLayout] = useState<DisplayLayout | null>(null);
  // Read failures and action failures are tracked apart so the user can tell "I can't see your
  // displays" from "that button didn't work" — folding them into one string made a failed action
  // look like a second copy of the read error.
  const [readError, setReadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLayout(await getDisplayLayout());
      setReadError(null);
    } catch (e) {
      // A layout we can't read is the one state where guessing would be worst: the buttons would
      // claim a geometry that isn't real. Say so instead.
      setReadError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Keep the readout honest while the pane is open — the numbers under the Span button are a
    // claim about the user's actual hardware.
    //
    // The `.catch` is load-bearing, not defensive noise: `listen` REJECTS when there is no Tauri
    // IPC (a jsdom render, a window mid-teardown), and this promise isn't awaited until the
    // cleanup runs — so without it the rejection surfaces as an app-level unhandled error. Losing
    // live refresh in that situation is the correct degradation; the pane still renders.
    const pending = onDisplaysChanged(() => void refresh()).catch(() => undefined);
    return () => void safeUnlisten(pending);
  }, [refresh]);

  /**
   * Run one window action and record whether the window is now spanned.
   *
   * `spanned` comes from WHICH action ran, not from measuring the result. Measuring is impossible
   * synchronously — macOS applies window geometry on the main dispatch queue, so a read-back
   * reports the pre-action frame (see src-tauri/src/display_span.rs). Two attempts to verify made
   * every span read as clamped, which left the flag permanently false and silently killed
   * auto-respan. The known cost of trusting the action: resize the window by hand afterwards and
   * the flag is stale until the next Fit/Reset.
   */
  const run = useCallback(
    async (action: () => Promise<unknown>, spanned: boolean) => {
      try {
        await action();
        setIsSpanned(spanned);
        setActionError(null);
        await refresh();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : String(e));
      }
    },
    [refresh, setIsSpanned],
  );

  const displayCount = layout?.displays.length ?? 0;
  // Nothing is actionable until we know what displays exist: acting on a null layout just produces
  // a second error next to the one that caused it.
  const noLayout = !layout || displayCount === 0;
  // With one display "spanning" is just maximizing, which works regardless of the Spaces setting —
  // so only warn (and only block) when there is actually more than one display to span across.
  const blockedBySpaces = !!layout && !layout.spanning_enabled && displayCount > 1;
  const agree = !!layout && modesAgree(layout);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {blockedBySpaces && (
        <div role="alert" style={warning}>
          <FiAlertTriangle size={14} style={{ flex: "none", marginTop: 2 }} aria-hidden />
          <div>
            macOS is keeping your displays in separate Spaces, so a window can&apos;t cross between
            them. Turn off <strong>System Settings → Desktop &amp; Dock → Mission Control →
            &ldquo;Displays have separate Spaces&rdquo;</strong>, then log out and back in.
          </div>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <button
          type="button"
          disabled={blockedBySpaces || noLayout}
          aria-label="Span the Sparkle window across every attached display"
          onClick={() => void run(() => spanWindow(spanMode), true)}
          style={{
            ...action,
            background: blockedBySpaces ? "transparent" : C.teal,
            color: blockedBySpaces ? C.muted : ON_BRAND_FILL,
            borderColor: blockedBySpaces ? C.muted : C.teal,
            cursor: blockedBySpaces ? "not-allowed" : "pointer",
          }}
        >
          Span all displays
        </button>
        <div style={caption}>
          {layout ? describeSpanTarget(layout, spanMode) : "Reading displays…"}
        </div>
      </div>

      <div style={{ display: "flex", gap: 6 }}>
        <button
          type="button"
          disabled={noLayout}
          aria-label="Fit the window to the display it is currently on"
          onClick={() => void run(fitWindowToCurrentDisplay, false)}
          style={{ ...action, flex: 1, cursor: noLayout ? "not-allowed" : "pointer" }}
        >
          Fit to current display
        </button>
        <button
          type="button"
          disabled={noLayout}
          aria-label="Reset the window to its default size, centered on the main display"
          onClick={() => void run(resetWindowSize, false)}
          style={{ ...action, flex: 1, cursor: noLayout ? "not-allowed" : "pointer" }}
        >
          Reset to default size
        </button>
      </div>

      <div>
        <div style={groupLabel}>Span area</div>
        <div
          role="group"
          aria-label="Span area"
          style={{ display: "flex", flexDirection: "column", gap: 6 }}
        >
          {SPAN_MODES.map(({ value, label, hint }) => {
            const selected = spanMode === value;
            return (
              <button
                key={value}
                type="button"
                aria-pressed={selected}
                aria-label={`${label}. ${hint}`}
                onClick={() => setSpanMode(value)}
                style={{
                  ...option,
                  background: selected ? C.teal : "transparent",
                  color: selected ? ON_BRAND_FILL : C.muted,
                  borderColor: selected ? C.teal : C.muted,
                }}
              >
                <span>{label}</span>
                <span style={{ ...hintText, color: selected ? ON_BRAND_FILL : C.muted }}>
                  {hint}
                </span>
              </button>
            );
          })}
        </div>
        {agree && displayCount > 0 && (
          // Without this the choice looks broken on a tidy arrangement: both buttons produce the
          // identical window and nothing appears to happen when you switch.
          <div style={caption}>
            Your displays tile into a clean rectangle, so both modes give the same window.
          </div>
        )}
      </div>

      <label style={checkboxRow}>
        <input
          type="checkbox"
          checked={autoRespan}
          onChange={(e) => setAutoRespan(e.target.checked)}
        />
        <span>Re-span when displays change</span>
      </label>

      {readError && (
        <div role="alert" style={{ ...caption, color: C.muted }}>
          Couldn&apos;t read your displays: {readError}
        </div>
      )}
      {actionError && (
        <div role="alert" style={{ ...caption, color: C.muted }}>
          Couldn&apos;t apply that: {actionError}
        </div>
      )}
    </div>
  );
}

const action: CSSProperties = {
  border: `1px solid ${C.muted}`,
  borderRadius: 6,
  padding: "7px 10px",
  background: "transparent",
  color: C.cream,
  cursor: "pointer",
  fontSize: TYPE.body,
  textAlign: "center",
  fontFamily: FONT_UI,
};

const option: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  width: "100%",
  border: `1px solid ${C.muted}`,
  borderRadius: 6,
  padding: "7px 10px",
  cursor: "pointer",
  fontSize: TYPE.body,
  textAlign: "left",
  fontFamily: FONT_UI,
};

const hintText: CSSProperties = { fontSize: TYPE.small, opacity: 0.85 };

const caption: CSSProperties = {
  fontSize: TYPE.small,
  color: C.muted,
  fontFamily: FONT_UI,
};

const groupLabel: CSSProperties = {
  fontSize: TYPE.small,
  color: C.muted,
  marginBottom: 6,
  fontFamily: FONT_UI,
};

const warning: CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "flex-start",
  border: `1px solid ${C.muted}`,
  borderRadius: 6,
  padding: "8px 10px",
  fontSize: TYPE.small,
  lineHeight: 1.45,
  color: C.cream,
  fontFamily: FONT_UI,
};

const checkboxRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: TYPE.body,
  color: C.cream,
  cursor: "pointer",
  fontFamily: FONT_UI,
};
