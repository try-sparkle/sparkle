// The "out of credits" mic notice, shared by BOTH mic surfaces so the two can never drift:
//   - the composer placeholder slot (ComposerOutOfCreditsNotice — one inline line), and
//   - the top-left sidebar caption (SidebarOutOfCreditsNotice — two stacked lines).
//
// Voice spends credits, so an attempt to ARM the mic while the balance is empty is refused (see
// MicButton's useMicToggle/useMicActions): instead of enabling the mic we flash this notice and
// auto-deactivate after 5s (dictationStore.showOutOfCreditsNotice). "Refill" is a real link that
// opens the ⋯ settings → Credits pane, the SAME seam BalanceBadge uses.
import { C, FONT_WEIGHT } from "../theme/colors";
import { useUiStore } from "../stores/uiStore";

/** The clickable, brand-blue, bold "Refill" word. A <button> styled as an inline link so it works
 *  inside the composer's `pointerEvents: none` placeholder overlay (it re-enables pointer events on
 *  itself). Clicking deep-opens the ⋯ settings dialog on the Credits pane. */
export function RefillLink({ label = "Refill" }: { label?: string }) {
  return (
    <button
      type="button"
      onClick={() => useUiStore.getState().openSettings("credits")}
      style={{
        // The composer placeholder overlay sets pointerEvents:none on its container; re-enable it
        // here so the link stays clickable. Harmless in the sidebar (already interactive).
        pointerEvents: "auto",
        background: "transparent",
        border: "none",
        padding: 0,
        margin: 0,
        cursor: "pointer",
        font: "inherit",
        fontWeight: FONT_WEIGHT.bold,
        color: C.teal, // brand blue, matching the "Hey Sparkle" wake span
      }}
    >
      {label}
    </button>
  );
}

/** Composer variant: a single inline line that stands in for the mic placeholder. Font is inherited
 *  from the placeholder overlay (so it matches the existing wake-word copy). */
export function ComposerOutOfCreditsNotice() {
  return (
    <span>
      You are out of credits. <RefillLink /> to activate voice.
    </span>
  );
}

/** Sidebar (top-left bar) variant: two stacked lines matching the existing caption styling —
 *  line 1 the bold, centered headline; line 2 the refill call-to-action with the clickable link. */
export function SidebarOutOfCreditsNotice() {
  return (
    <div style={{ marginTop: 4, color: C.muted, fontSize: 11, textAlign: "center" }}>
      <span style={{ display: "block", fontWeight: FONT_WEIGHT.semibold }}>
        You are out of credits.
      </span>
      <span style={{ display: "block" }}>
        <RefillLink /> to activate voice.
      </span>
    </div>
  );
}
