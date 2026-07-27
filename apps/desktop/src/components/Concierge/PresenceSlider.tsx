// The Here | Away slider, in the compose row beside Send. Two jobs, and the second matters more
// than the first: it lets the user SET presence, and — every second of every session — it TELLS them
// what presence currently is. Away is the state in which the concierge may act on its own, so a user
// who cannot see that they drifted into it has no way to know why something happened without them.
// Which is why this is a persistent control in the compose row rather than a menu item.
//
// It is a segmented two-position control, not an <input type="range">: presence has exactly two
// values, and a range input announces a number. Two buttons in a `role="group"`, each carrying
// `aria-pressed`, is the shape a screen reader already knows how to read out — and it keeps both
// destinations one tab-stop away rather than making the user arrow along a track.
//
// THIS COMPONENT READS THE STORE DIRECTLY, which is the one place the Concierge directory's
// "purely presentational" rule (see ./types.ts) is bent, and it is bent the same way ComposeBox
// already bends it for `useUiStore`. The alternative — threading `mode` + two callbacks through
// ConciergeViewModel, ConciergeController, ConciergeColumnProps and ComposeBox's props — would add
// four hops of plumbing to surface a value that has exactly one producer and no per-instance
// variation. The mode is also read from non-React code on the dispatch path, so the store is
// already the contract; a prop mirror of it could only drift.
import { C, FONT_WEIGHT, PRESENCE_SEGMENT_TINT_PCT } from "../../theme/colors";
import { usePresenceStore, type PresenceMode } from "../../stores/presenceStore";

const line = `color-mix(in srgb, ${C.muted} 25%, transparent)`;

/** Why the app thinks you are where it thinks you are — the slider's tooltip. Split out and pure
 *  so the wording is pinned by a test rather than by whoever last edited the JSX.
 *
 *  It names the CAUSE, not just the state. "Away" alone is unactionable: a user who has been
 *  reading terminal output for six minutes and finds themselves Away needs to know it was the idle
 *  timer, not a click they don't remember making — otherwise the control reads as flaky. */
export function presenceTitle(mode: PresenceMode, pinnedHere: boolean): string {
  if (mode === "here") {
    return pinnedHere
      ? "Here — pinned. Sparkle checks with you before acting."
      : "Here. Sparkle checks with you before acting.";
  }
  return pinnedHere
    ? "Away — Sparkle's window isn't frontmost. Here is still pinned and comes back when you return."
    : "Away. Sparkle may act on its own; risky actions wait for you.";
}

const SEGMENTS: { mode: PresenceMode; label: string }[] = [
  { mode: "here", label: "Here" },
  { mode: "away", label: "Away" },
];

export function PresenceSlider() {
  const mode = usePresenceStore((s) => s.mode);
  const pinnedHere = usePresenceStore((s) => s.pinnedHere);
  const setHere = usePresenceStore((s) => s.setHere);
  const setAway = usePresenceStore((s) => s.setAway);

  return (
    <div
      role="group"
      aria-label="Presence"
      data-testid="presence-slider"
      data-mode={mode}
      title={presenceTitle(mode, pinnedHere)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        border: `1px solid ${line}`,
        borderRadius: 999,
        padding: 2,
        // Sized to its two words rather than stretching, and pushed to the right end of the attach
        // row so it sits directly above Send — the button whose behaviour it governs.
        flex: "none",
        marginLeft: "auto",
      }}
    >
      {SEGMENTS.map(({ mode: seg, label }) => {
        const active = mode === seg;
        // Away is the state with consequences, so it is the one that gets brand color when active;
        // Here is the safe resting state and stays quiet. An always-lit control would be noise.
        //
        // INK AND FILL ARE DIFFERENT TOKENS, and for Away they are different colors. Brand amber
        // (#e0982f) is a warm mid-tone: fine as a FILL under dark ink, but as 11px TEXT on the
        // plate this control sits on — its own 16% amber tint over the composer's scrim — it is
        // ~1.3:1 in light and ~3.6:1 in dark, failing AA in both (roborev 53631-M4 / 53655-H).
        // `amberInk` is the themed text token (lightened amber in dark, dark ochre in light) while
        // the tint behind it stays the constant brand color, which is what a fill wants.
        const ink = seg === "away" ? C.amberInk : C.accentInk;
        const fill = seg === "away" ? C.amber : C.accentInk;
        return (
          <button
            key={seg}
            type="button"
            // `aria-pressed` rather than a radio group: these are two toggle buttons over one piece
            // of state, and a radiogroup would promise arrow-key traversal we don't implement.
            aria-pressed={active}
            aria-label={
              seg === "here"
                ? "Here — Sparkle checks with you before acting"
                : "Away — Sparkle may act on its own"
            }
            onClick={seg === "here" ? setHere : setAway}
            style={{
              fontSize: 11,
              fontWeight: active ? FONT_WEIGHT.bold : FONT_WEIGHT.regular,
              fontFamily: "inherit",
              color: active ? ink : C.conciergeMuted,
              background: active
                ? `color-mix(in srgb, ${fill} ${PRESENCE_SEGMENT_TINT_PCT}%, transparent)`
                : "transparent",
              border: "none",
              borderRadius: 999,
              padding: "4px 9px",
              cursor: "pointer",
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
