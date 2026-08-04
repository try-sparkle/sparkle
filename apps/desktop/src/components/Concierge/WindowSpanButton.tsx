// The concierge header's span-all-displays shortcut (bead sparkle-6b96h).
//
// The founder: "Give me a little icon next to the three dot menu, to expand the span across all
// displays… Basically it's the button that's in the settings menu. I just want a shortcut to that
// button. Between the PR button and the three dot menu."
//
// So this is a SHORTCUT, not a second implementation. Everything it does goes through
// hooks/useWindowSpan — the same helpers and the same `windowIsSpanned` write that
// Appearance → Window performs. That flag is not decoration: hooks/useDisplayRespan gates on it to
// decide whether to re-fit when a display is plugged or unplugged, so a shortcut that spanned
// without setting it would silently break auto-respan for as long as the user preferred this
// control over the pane.
//
// Three rules it inherits rather than invents:
//   • TOGGLE. Spanned → click returns the window to the display it is on (fit), and the icon says
//     which state you are in, so it reads at a glance.
//   • The user's `windowSpanMode` ("safe" / "full") from Settings. It never nominates its own.
//   • ICON ONLY. This row is deliberately silent — a scope/vitals line was deleted from beside the
//     wordmark specifically to reclaim the space (bead sparkle-ircc3), and text here would spend it
//     straight back. The name lives in `aria-label`/`title`.
import { useState } from "react";
import { FiMaximize, FiMinimize } from "react-icons/fi";
import { C } from "../../theme/colors";
import { useWindowSpan } from "../../hooks/useWindowSpan";

export function WindowSpanButton() {
  const [hover, setHover] = useState(false);
  const { displayCount, isSpanned, blockedBySpaces, noLayout, actionError, toggle } =
    useWindowSpan();

  // NOTHING TO SPAN ACROSS → NO CONTROL. On a laptop with no external monitor "span" is just
  // maximize, and a header this sparse cannot afford a button that does nothing visible.
  //
  // …UNLESS THE WINDOW IS ALREADY SPANNED, which is the case a plain `displayCount > 1` gate gets
  // wrong. Unplug a monitor while spanned and the count drops to 1 while the window is still at a
  // geometry the remaining display can't show — hiding the control there removes the one affordance
  // that undoes it. (`useDisplayRespan` re-spans on that event, but only when the user has
  // auto-respan on, so it cannot be relied on to clear the state.)
  //
  // `noLayout` covers the unreadable case too: with no layout we do not know there is a second
  // display, and rendering an enabled button that will just error is worse than rendering nothing.
  if ((noLayout || displayCount < 2) && !isSpanned) return null;

  // macOS "Displays have separate Spaces" makes a window physically unable to cross displays. The
  // action would fail, so DISABLE rather than hide — hiding would leave the user with no hint of
  // why the shortcut they were told about isn't there. The reason is on hover, and Appearance →
  // Window carries the full fix.
  //
  // GATE ON THE DIRECTION, NOT THE STATE. Separate Spaces blocks SPANNING; it does not block
  // `fit_window_to_current_display`. The state `isSpanned && blockedBySpaces` is reachable (the
  // setting takes effect after a restart, with the window already spanned), and disabling there
  // would refuse the un-span — removing the only header affordance for clearing a stranded spanned
  // geometry, while `windowIsSpanned` stays true and useDisplayRespan keeps re-spanning. That is the
  // same allowance the `return null` above makes for the single-display case.
  const disabled = blockedBySpaces && !isSpanned;
  // Derived from `isSpanned` FIRST, so the spanned case always reads as the un-span it will perform.
  const label = isSpanned
    ? "Return the window to this display"
    : blockedBySpaces
      ? "Can't span: macOS is keeping your displays in separate Spaces (Settings → Appearance → Window)"
      : "Span the window across all displays";
  // A FAILED ACTION MUST NOT BE SILENT. `run` swallows the error into `actionError` and writes no
  // flag, so without this the click produces no observable result at all — same icon, same name,
  // nothing anywhere. The header has no room for a message, so it goes in the affordance this
  // control already has. Settings → Appearance → Window prints the full text.
  const title = actionError ? `${label} — last attempt failed: ${actionError}` : label;
  const Icon = isSpanned ? FiMinimize : FiMaximize;

  return (
    <button
      type="button"
      data-testid="concierge-span-toggle"
      // The STATE, for anything that styles or asserts on it without re-deriving the icon.
      data-spanned={isSpanned ? "true" : "false"}
      // A toggle, so it reports as one. The accessible NAME states the action the next click takes
      // (the founder's ask was to tell at a glance which state he is in), and `aria-pressed` carries
      // the state itself — which is what a screen reader needs, since the icon can't speak.
      aria-pressed={isSpanned}
      aria-label={title}
      title={title}
      // The failure, for anything that wants to style or assert on it without parsing the name.
      data-error={actionError ?? undefined}
      disabled={disabled}
      onClick={() => void toggle()}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        // The same `.iconbtn` the kebab beside it uses — quiet at rest, lifts on hover — rather
        // than a shape of its own. Two neighbouring icon buttons that don't match read as a bug.
        display: "inline-flex",
        background: hover && !disabled ? "rgba(255,255,255,0.05)" : "transparent",
        border: "none",
        // Spanned is a state worth seeing without hovering, so it holds the lit ink.
        color: disabled ? C.muted : hover || isSpanned ? C.cream : C.muted,
        opacity: disabled ? 0.5 : 1,
        padding: 6,
        borderRadius: 6,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      <Icon size={16} aria-hidden />
    </button>
  );
}
