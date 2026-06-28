import type { CSSProperties } from "react";
import { C, FONT_WEIGHT } from "../theme/colors";
import { useSettingsStore } from "../stores/settingsStore";

// The slider's practical ceiling. The setting itself is unbounded (setMaxConcurrentWorkers only
// floors at 1), so this is just how high the UI control reaches — far beyond any real fan-out, so
// it reads as "effectively unlimited" while still giving the slider a finite track to drag along.
export const WORKER_LIMIT_SLIDER_MAX = 50;

/**
 * ⋯-menu control for the orchestrator's max concurrent workers (per build agent). A range slider
 * 1..WORKER_LIMIT_SLIDER_MAX with a live numeric readout, backed by settingsStore. Raising it lets
 * an orchestrator fan out more workers at once; the persona text the orchestrator receives reads
 * this same value, so the cap it's told about always matches what's set here.
 */
export function WorkerLimitControl() {
  const value = useSettingsStore((s) => s.maxConcurrentWorkers);
  const setValue = useSettingsStore((s) => s.setMaxConcurrentWorkers);
  // A persisted value from before the slider existed (or set programmatically) can exceed the
  // track; clamp the THUMB position only so it still renders on-track without rewriting the setting.
  const thumb = Math.min(value, WORKER_LIMIT_SLIDER_MAX);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <input
          type="range"
          min={1}
          max={WORKER_LIMIT_SLIDER_MAX}
          step={1}
          value={thumb}
          aria-label="Max concurrent workers"
          onChange={(e) => setValue(Number(e.target.value))}
          style={{ flex: 1, accentColor: C.teal, cursor: "pointer" }}
        />
        <span style={readout} aria-hidden>
          {value}
        </span>
      </div>
      <div style={hint}>
        How many workers an orchestrator may run at once (per build agent). Higher = more parallel
        work, more token spend.
      </div>
    </div>
  );
}

const readout: CSSProperties = {
  minWidth: 28,
  textAlign: "right",
  color: C.cream,
  fontSize: 14,
  fontWeight: FONT_WEIGHT.semibold,
  fontVariantNumeric: "tabular-nums",
  fontFamily: '"IBM Plex Sans", sans-serif',
};

const hint: CSSProperties = {
  color: C.muted,
  fontSize: 12,
  lineHeight: 1.4,
  fontFamily: '"IBM Plex Sans", sans-serif',
};
