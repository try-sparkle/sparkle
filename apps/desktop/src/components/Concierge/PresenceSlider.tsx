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
//
// THE PIN IS VISIBLE HERE OR IT IS INVISIBLE EVERYWHERE. Since the 2026-07-27 founder override
// (design §1 decision 2) a pinned Here beats blur, screen lock and an overnight idle — it ends only
// when the user ends it. A mode that sticky with no on-screen trace would leave a user unable to
// explain why the app never went Away, so the pin is a labelled toggle button in the control, not a
// hidden flag. Two ways to set it, for two different users: the button (one click, keyboard- and
// screen-reader-reachable) and a double-click anywhere on the slider (the gesture the founder asked
// for).
import { useRef, type MouseEvent } from "react";
import { FiMapPin } from "react-icons/fi";
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
      ? "Here — pinned. Stays Here through app-switches, screen lock and overnight, until you unpin. Sparkle checks with you before acting."
      : "Here. Sparkle checks with you before acting.";
  }
  // Away reads the same whether or not `pinnedHere` is set, because it CANNOT be: choosing Away
  // clears the pin, and no automatic signal can reach Away past one. The old second spelling
  // ("Here is still pinned and comes back when you return") described the blur-revokes-the-pin
  // transition the override removed — a promise about a state change that no longer happens.
  return "Away. Sparkle may act on its own; risky actions wait for you.";
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
  const setPinnedHere = usePresenceStore((s) => s.setPinnedHere);
  const togglePinnedHere = usePresenceStore((s) => s.togglePinnedHere);

  // THE STATE THE GESTURE IS RESOLVED AGAINST, captured before its own clicks land.
  //
  // A double-click on the Here segment fires Here's `onClick` TWICE before `dblclick` arrives, and
  // clicking Here pins (setHere). So a handler that simply flipped the CURRENT value would read the
  // pin its own first click had just set, and unpin — making a double-click on Here always end
  // unpinned instead of toggling. `detail <= 1` is the first click of a sequence, which is the last
  // moment the pre-gesture answer is still readable.
  const pinBeforeGesture = useRef(pinnedHere);
  const rememberPin = (e: MouseEvent) => {
    if (e.detail <= 1) pinBeforeGesture.current = usePresenceStore.getState().pinnedHere;
  };

  return (
    <div
      role="group"
      aria-label="Presence"
      data-testid="presence-slider"
      data-mode={mode}
      data-pinned={pinnedHere}
      title={presenceTitle(mode, pinnedHere)}
      // Capture phase: this must run before the segment buttons' own handlers change the pin.
      onMouseDownCapture={rememberPin}
      onDoubleClick={() => setPinnedHere(!pinBeforeGesture.current)}
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
      {/* The pin indicator AND its control, in one element — a separate read-only dot plus a
          hidden gesture would leave the pin settable by a means that never says what it did. Named
          "Pin Here" in both states with `aria-pressed` carrying on/off, because a toggle whose
          accessible NAME changes ("Pin"/"Unpin") reads as a different control appearing. */}
      <button
        type="button"
        aria-pressed={pinnedHere}
        aria-label="Pin Here — stays Here until you unpin"
        data-testid="presence-pin"
        title={
          pinnedHere
            ? "Here is pinned. Nothing automatic will move it — click to unpin."
            : "Pin Here, so app-switching and idle can't move it."
        }
        onClick={togglePinnedHere}
        // Its own two clicks already toggled twice (back to where they started); letting the
        // gesture ALSO reach the group would make a fast double-tap on the pin mean something
        // different from two deliberate single taps on it.
        //
        // "Back where they started" is a claim about the STORE, and it only holds because
        // `setPinnedHere` unwinds an ON→OFF pair (presenceStore.awayBeforePin, roborev 54146-M1).
        // It used to be false in the one case that mattered: pinning cleared an explicit Away that
        // unpinning did not put back, so this gesture silently revoked it.
        onDoubleClick={(e) => e.stopPropagation()}
        style={{
          display: "inline-flex",
          alignItems: "center",
          // Lit when pinned, muted when not — the state is legible without the tooltip.
          color: pinnedHere ? C.accentInk : C.conciergeMuted,
          opacity: pinnedHere ? 1 : 0.55,
          background: "transparent",
          border: "none",
          borderRadius: 999,
          padding: "3px 4px 3px 5px",
          cursor: "pointer",
        }}
      >
        <FiMapPin size={11} aria-hidden />
      </button>
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
            // AWAY OPTS OUT OF THE DOUBLE-CLICK GESTURE. Everywhere else on the control a
            // double-click toggles the pin; on this segment it would pin HERE moments after the
            // user twice said the opposite. Two clicks on Away mean Away.
            onDoubleClick={seg === "away" ? (e) => e.stopPropagation() : undefined}
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
