import { useEffect, useRef, type CSSProperties } from "react";
import { C, FONT_WEIGHT } from "../theme/colors";
import { useSettingsStore } from "../stores/settingsStore";
// Persist the cap to config.toml (the source of truth). The slider updates the store LIVE while
// dragging (cheap, instant), and persists to the file once on release — a per-step file write would
// be ~one atomic disk round-trip + reload per integer dragged. See setMaxConcurrentWorkers.
import { setMaxConcurrentWorkers as persistMaxConcurrentWorkers } from "../services/configActions";
import { FONT_UI } from "../theme/scale";

// The slider's FLOOR on its practical ceiling, not the ceiling itself (roborev 54816). A hardcoded
// max was written when the derived cap on a large Mac was 48 ("far beyond any real fan-out") — the
// per-agent RAM basis has since moved twice, and the measured machine now derives 81. A static
// number goes stale exactly like `agent_heap_mb` did: because the slider writes a pin and offers no
// way back to AUTO, a single drag would silently cap an 81-capable machine at ≤ 50, a real capacity
// loss the user could only undo by hand-editing config.toml. The component derives its actual max
// from the MACHINE ceiling — see `sliderMax` below for which field and why it must not be
// `effectiveMaxConcurrentWorkers`; this floor only keeps the track meaningfully long on a machine
// whose derivation is small.
export const WORKER_LIMIT_SLIDER_FLOOR = 50;

/**
 * ⋯-menu control for max concurrent workers ON THIS MACHINE — not per build agent. The label said
 * "per build agent" until 2026-07-30, which was the one place a user could read the opposite of what
 * the gate enforced (bead `sparkle-axtkw`): `orchestrationListener.globalGateBinds` counts every
 * worker on the box against this number. A range slider
 * 1..sliderMax (at least WORKER_LIMIT_SLIDER_FLOOR, never below what this machine can run) with a
 * live numeric readout, backed by settingsStore. Raising it lets
 * an orchestrator fan out more workers at once; the persona text the orchestrator receives reads
 * this same value, so the cap it's told about always matches what's set here.
 */
export function WorkerLimitControl() {
  const value = useSettingsStore((s) => s.maxConcurrentWorkers);
  // What the MACHINE actually allows — min(RAM-derived, cores × AGENTS_PER_CORE), derived in Rust.
  // When it's the smaller number, IT is the limit in force; the slider keeps showing the user's
  // choice and the hint below tells the truth. The hint used to be RAM-only and was therefore WRONG
  // on every core-bound machine (roborev 53087); the binding dimension is now plumbed through
  // EffectiveConfig, so the copy names whatever actually bound it instead of guessing memory.
  const effective = useSettingsStore((s) => s.effectiveMaxConcurrentWorkers);
  const bound = useSettingsStore((s) => s.concurrencyBound);
  const basis = useSettingsStore((s) => s.concurrencyBasis);
  const machineCapped = effective < value;
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
  // The track's max is whichever is larger: the floor (keeps a small/unmeasurable machine's slider
  // meaningfully long) or what the machine can actually run (so a big machine's slider always
  // reaches its own ceiling). Deliberately NOT `value` — an extreme persisted value (999, set by
  // hand-editing config.toml) must keep clamping the THUMB to the track end below, not stretch the
  // whole track to it, or a normal 1..~80 drag would move the thumb an imperceptible fraction.
  //
  // `machineMaxConcurrentWorkers`, NOT `effectiveMaxConcurrentWorkers` (roborev 55027, High).
  // `effective` is ALREADY clamped by the user's own pin at hydration
  // (`effective = pinned === null ? derived : min(pinned, derived)`), and dragging this slider
  // PERSISTS a pin, so deriving the track from it makes the control ratchet DOWN and never back up:
  // on an 81-capable machine a drag to 60 re-hydrates `effective = 60`, so the track becomes 60,
  // then 55, and 81 is unreachable forever. That is the same capacity loss the hardcoded 50 caused,
  // just relocated to "wherever you last dragged". `machineMaxConcurrentWorkers` is what the
  // hardware alone can carry, independent of any pin, so the track always spans the real range.
  const machineMax = useSettingsStore((s) => s.machineMaxConcurrentWorkers);
  const sliderMax = Math.max(WORKER_LIMIT_SLIDER_FLOOR, machineMax);
  // A persisted value from before the slider existed (or set programmatically) can exceed the
  // track; clamp the THUMB position only so it still renders on-track without rewriting the setting.
  const thumb = Math.min(value, sliderMax);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <input
          type="range"
          min={1}
          max={sliderMax}
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
        How many workers may run at once on this machine, across all orchestrators. Higher = more
        parallel work, more token spend.
      </div>
      {machineCapped && (
        // Say so plainly rather than silently ignoring the setting: something IS the binding
        // constraint, and pretending otherwise is what let 24 agents exhaust memory and take the
        // system down (sparkle-01xv).
        //
        // WHICH constraint is named comes from Rust, next to the number it explains. The old copy
        // asserted memory unconditionally and offered "set a smaller agent_heap_mb" — advice that
        // does nothing on a CPU-bound machine (the common case on a big Mac: 18 cores × 2 = 36 sits
        // well below what 128 GiB holds) and cannot be followed at all when agent_heap_mb is 0, the
        // opt-out that maps to V8's ~4 GiB default. The remedy line below is now branched on the
        // dimension rather than assumed, and stays in step with config.rs's own warning text.
        <div style={{ ...hint, color: C.tealInk }}>
          This Mac runs {effective} at once, so that's the limit in effect — {basis}.
          {bound === "ram" && " Lowering agent_heap_mb in config.toml fits more."}
          {bound === "cpu" && " More memory won't change this; it's the core count."}
          {bound === "both" && " RAM and cores cap it equally, so changing either alone won't help."}
        </div>
      )}
    </div>
  );
}

const readout: CSSProperties = {
  minWidth: 28,
  textAlign: "right",
  color: C.cream,
  fontSize: 13,
  fontWeight: FONT_WEIGHT.semibold,
  fontVariantNumeric: "tabular-nums",
  fontFamily: FONT_UI,
};

const hint: CSSProperties = {
  color: C.muted,
  fontSize: 12,
  lineHeight: 1.4,
  fontFamily: FONT_UI,
};
