import { useEffect, useRef, useState } from "react";
// Themed tokens (muted/forest/cream flip on data-theme); brand teal/accent pass through as
// constants. Import from ../theme/colors — like Composer — so the waveform stays legible in
// light mode (the @sparkle/ui C.muted is a dark-mode-only literal).
import { C } from "../theme/colors";
import type { Phase } from "../voice/wakeMachine";
import { useDictationStore } from "../stores/dictationStore";

const BAR_COUNT = 24;

/** The hint caption under the waveform. Null when muted (mic released). */
export function captionFor(phase: Phase, enabled: boolean): string | null {
  if (!enabled) return null;
  return phase === "passive"
    ? "Just say Sparkle to talk to me"
    : "Just say Send It to stop";
}

/**
 * Always-listening waveform pinned under the Sparkle logo (column-one width).
 * Gray bars while PASSIVE ("I hear you, not typing"); an animated blue→cyan
 * gradient sweep while ACTIVE. Click toggles phase; the mic icon mutes.
 */
export function LogoWaveform() {
  const level = useDictationStore((s) => s.level);
  const phase = useDictationStore((s) => s.phase);
  const enabled = useDictationStore((s) => s.enabled);
  const error = useDictationStore((s) => s.error);
  const modelProgress = useDictationStore((s) => s.modelProgress);
  const togglePhase = useDictationStore((s) => s.togglePhase);
  const setEnabled = useDictationStore((s) => s.setEnabled);

  // Rolling history of recent levels → bar heights (newest on the right).
  const [bars, setBars] = useState<number[]>(() => Array(BAR_COUNT).fill(0));
  const raf = useRef(0);
  // Hold level in a ref so the rAF closure always reads the latest value without
  // restarting the loop on every store update.
  const levelRef = useRef(level);
  useEffect(() => { levelRef.current = level; }, [level]);

  useEffect(() => {
    // Only run the animation loop while the mic is enabled; stop when muted to
    // avoid continuous CPU/battery drain when the user isn't using voice.
    // Reset bars to flat when muting so the waveform doesn't freeze mid-wave
    // (a frozen snapshot could read as "still listening").
    if (!enabled) {
      setBars(Array(BAR_COUNT).fill(0));
      return;
    }
    const tick = () => {
      setBars((prev) => {
        const next = prev.slice(1);
        next.push(Math.min(1, levelRef.current));
        return next;
      });
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [enabled]);

  const caption = captionFor(phase, enabled);
  const active = phase === "active";

  return (
    <div style={{ padding: "0 14px 8px", userSelect: "none" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {/* Waveform — whole area toggles phase. */}
        <button
          type="button"
          onClick={togglePhase}
          aria-label={active ? "Stop listening" : "Activate Sparkle voice"}
          disabled={!enabled}
          style={{
            flex: 1,
            display: "flex",
            alignItems: "flex-end",
            gap: 2,
            height: 28,
            padding: 0,
            background: "transparent",
            border: "none",
            cursor: enabled ? "pointer" : "default",
            opacity: enabled ? 1 : 0.4,
          }}
        >
          {bars.map((h, i) => (
            <span
              key={i}
              style={{
                flex: 1,
                height: `${Math.max(8, h * 100)}%`,
                borderRadius: 1,
                // Gray when passive; brand blue→cyan fade across the row when active.
                background: active
                  ? `linear-gradient(90deg, ${C.teal}, ${C.accent})`
                  : C.muted,
                backgroundSize: active ? `${BAR_COUNT * 100}% 100%` : undefined,
                backgroundPosition: active ? `${(i / (BAR_COUNT - 1)) * 100}% 0` : undefined,
                transition: "height 80ms linear",
              }}
            />
          ))}
        </button>

        {/* Mute toggle (mic icon). */}
        <button
          type="button"
          onClick={() => setEnabled(!enabled)}
          aria-label={enabled ? "Mute microphone" : "Unmute microphone"}
          title={enabled ? "Mute" : "Unmute"}
          style={{
            width: 20,
            height: 20,
            display: "grid",
            placeItems: "center",
            background: "transparent",
            border: "none",
            cursor: "pointer",
            color: enabled ? C.accent : C.muted,
            fontSize: 13,
            lineHeight: 1,
          }}
        >
          {enabled ? "🎙" : "🔇"}
        </button>
      </div>

      {error ? (
        <div style={{ marginTop: 4, color: C.muted, fontSize: 10 }}>
          Mic unavailable — check System Settings → Privacy → Microphone.
        </div>
      ) : enabled && modelProgress !== null ? (
        <div style={{ marginTop: 4, color: C.muted, fontSize: 11 }}>
          {(() => {
            const pct = modelProgress.total
              ? Math.round((modelProgress.done / modelProgress.total) * 100)
              : null;
            return pct !== null
              ? `Downloading voice model… ${pct}%`
              : "Downloading voice model…";
          })()}
        </div>
      ) : caption ? (
        <div style={{ marginTop: 4, color: C.muted, fontSize: 11 }}>
          Just say{" "}
          <span
            style={{
              fontWeight: 600,
              background: `linear-gradient(90deg, ${C.teal}, ${C.accent})`,
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
            }}
          >
            {phase === "passive" ? "Sparkle" : "Send It"}
          </span>{" "}
          {phase === "passive" ? "to talk to me" : "to stop"}
        </div>
      ) : null}
    </div>
  );
}
