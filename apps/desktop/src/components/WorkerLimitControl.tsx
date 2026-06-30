import { useEffect, useRef, type CSSProperties } from "react";
import { C, FONT_WEIGHT } from "../theme/colors";
import { useSettingsStore } from "../stores/settingsStore";
// Persist the cap to config.toml (the source of truth). The slider updates the store LIVE while
// dragging (cheap, instant), and persists to the file once on release — a per-step file write would
// be ~one atomic disk round-trip + reload per integer dragged. See setMaxConcurrentWorkers.
import { setMaxConcurrentWorkers as persistMaxConcurrentWorkers } from "../services/configActions";

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
  const setLive = useSettingsStore((s) => s.setMaxConcurrentWorkers);
  // Persist the latest store value to config.toml. The control fires commit on several settle
  // events (pointer-up, key-up, blur), and a held arrow key auto-repeats — so debounce them into a
  // SINGLE trailing write of the final value. A `dirty` flag (set only on a USER change, cleared
  // after the write) makes redundant settle events no-ops AND avoids suppressing a legitimate write
  // after an external file edit re-hydrated the value (it tracks "the user changed this", not a
  // value comparison that could go stale vs the watcher). `flush` runs the pending write now —
  // called on unmount too, so closing the settings panel mid-debounce never drops the write.
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flush = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
    if (!dirty.current) return;
    dirty.current = false;
    void persistMaxConcurrentWorkers(useSettingsStore.getState().maxConcurrentWorkers);
  };
  const onLive = (n: number) => {
    setLive(n);
    dirty.current = true;
  };
  const commit = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 200);
  };
  useEffect(() => () => flush(), []);
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
          onChange={(e) => onLive(Number(e.target.value))}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
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
