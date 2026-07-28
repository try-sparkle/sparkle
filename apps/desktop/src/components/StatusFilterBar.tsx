import { memo, useEffect, useLayoutEffect, useRef } from "react";
import { IoFilter } from "react-icons/io5";
import { C, FONT_WEIGHT } from "../theme/colors";
import { STATUS_BANDS, type StatusBand } from "../engine/buildSections";
import { bandCountLabel, bandColor } from "../engine/statusBandLabels";
import { BandBadge } from "./BandBadge";

/** The group's accessible name, and the handle `focusFirstStatusChip` finds it by. */
const GROUP_LABEL = "Filter agents by status";

/** How long a departed Reset keeps its claim on focus. Long enough to span a mouse press — WebKit
 *  blurs on mousedown while the state change lands on click — and short enough that a departure
 *  into dead space cannot steal focus from an unrelated clear later. */
const RESET_FOCUS_CLAIM_MS = 1000;

/** Move focus to the first status chip.
 *
 *  MODULE-PRIVATE on purpose. The source branch exported it so `AgentSidebar`'s empty-list escape
 *  hatch could share one answer, but that call site is not part of this port and nothing outside
 *  this file imports it — an exported helper with no consumer is API that only looks load-bearing.
 *  Export it when the second caller actually arrives. */
function focusFirstStatusChip(root: ParentNode = document) {
  // Found by ROLE and ARIA, never by `data-testid`. This is runtime accessibility behaviour: keying
  // it on a test-only attribute would make it a silent no-op the day a testid-stripping transform
  // is added to the production build — and a test written against the same attribute would keep
  // passing, so nothing would report it. `button[aria-pressed]` is what the chips ARE (toggles);
  // the group lookup constrains on `role="group"` too, so an unrelated element that happens to
  // carry the same aria-label cannot match (roborev 54140).
  const selector = `[role="group"][aria-label="${GROUP_LABEL}"]`;
  const group =
    root instanceof Element && root.matches(selector) ? root : root.querySelector(selector);
  group?.querySelector<HTMLElement>("button[aria-pressed]")?.focus();
}

/**
 * The three status chips above the Build column's stage ladder: [filter] ●2 ●3 ●0 … Reset.
 * All three start on; clicking one toggles its rows out of the column (and any stage section left
 * with no visible rows disappears with them).
 *
 * The chip's dot is painted from the SAME `AGENT_STATUS` color the rows' own dots use, via the
 * band's `colorFrom` status — so a chip is a legend for exactly the rows it hides. That coupling is
 * the reason the palette isn't spelled here.
 *
 * WHY THE CHIPS CARRY NO WORDS. At sidebar width the phrase never fit — "2 Needs you" rendered as
 * "2 Need…", which is not a label, just noise wearing one. The dot already says which band (it is
 * the same dot the rows use) and the count is the only part that changes, so the chip shows dot +
 * count and the words move to `aria-label`/`title`. Screen readers and hover still get the full
 * agreeing phrase from `bandCountLabel` — do NOT hand-assemble it here, see that helper's note on
 * "1 Needs you" vs "3 Need you".
 *
 * An OFF chip stays fully readable (it dims and hollows its dot rather than greying out to
 * near-invisibility): a filter you can't see the state of is worse than no filter, and the count
 * keeps showing how many rows are behind it so nothing is silently lost.
 */
export const StatusFilterBar = memo(function StatusFilterBar({
  counts,
  visible,
  onToggle,
  onReset,
}: {
  counts: Record<StatusBand, number>;
  visible: Record<StatusBand, boolean>;
  onToggle: (b: StatusBand) => void;
  onReset: () => void;
}) {
  // Any band toggled off means the column is showing a SUBSET, and the user gets a way back. With
  // all three on there is nothing to reset, so the link would be a permanently dead control.
  const filtered = STATUS_BANDS.some((b) => !visible[b.id]);

  // ── WHY RESET STAYS MOUNTED, AND WHY FOCUS IS TRACKED RATHER THAN SAMPLED ────────────────────
  // Unmounting Reset when nothing is filtered destroys the element under the cursor, and for a
  // keyboard user blurs it on the very click that succeeds — leaving focus on <body> with nothing
  // to tab back to. So the slot is permanent and merely hidden+disabled, and focus is re-homed
  // onto the first chip when it retires.
  //
  // `document.activeElement === resetRef.current` inside the effect can never be true: the HTML
  // focus-fixup rule runs when `disabled` is set, before any effect, so activeElement is already
  // <body> by then — a no-op everywhere except jsdom, which does not implement the rule.
  //
  //   • `onFocus` opens the claim; it stays live (Infinity) while the button holds focus.
  //   • `onBlur` decides from `relatedTarget` — the authoritative "where did focus go". A real
  //     element outside the bar ends the claim; otherwise it is stamped with an expiry.
  //   • The recorded pointerdown note is consulted ONLY when `relatedTarget` is null, which is
  //     exactly the WebKit-mousedown and focus-fixup case the event cannot answer. It RECORDS
  //     rather than drops because at pointerdown the focus change has not happened yet — a surface
  //     that cancels it (AgentSidebar.startResize) keeps focus on Reset, and a `pointerup`/
  //     `pointercancel` that finds Reset still focused forgets the note.
  //   • A `focusin` outside additionally drops an already-STAMPED claim, since focus demonstrably
  //     moved — defence for engines that leave `relatedTarget` unpopulated.
  //
  // Superseded rules, so they are not retried: reading `disabled` at blur time (WebKit blurs on
  // MOUSEDOWN, before any commit, so the flag was cleared and no second blur followed), and
  // deferring the clear to `setTimeout(…, 0)` (that timer fires BETWEEN mousedown and click — a
  // mouse press is two tasks).
  const groupRef = useRef<HTMLDivElement>(null);
  const resetRef = useRef<HTMLButtonElement>(null);
  // null = no claim. Infinity = live (button holds focus). Finite = expires at that time.
  const resetFocusClaim = useRef<number | null>(null);
  const interactionLeftBar = useRef(false);
  useEffect(() => {
    const noteWhereTheInteractionWent = (e: Event) => {
      const t = e.target as Node | null;
      // Focus landing on <body> is NOT a departure — it is the state the fixup rule and WebKit's
      // mousedown both produce, i.e. the case this claim exists to serve.
      if (!t || t === document.body || t === document) return;
      const outside = !groupRef.current?.contains(t);
      interactionLeftBar.current = outside;
      // Only a STAMPED claim is dropped; an Infinity claim means Reset still holds focus (the
      // cancelled-press case). That pairing is not reachable in a real browser — focusout fires
      // first — so this is belt-and-braces; the realistic case is pinned via pointerdown.
      if (e.type === "focusin" && outside && Number.isFinite(resetFocusClaim.current)) {
        resetFocusClaim.current = null;
      }
    };
    const forgetIfFocusNeverLeft = () => {
      if (document.activeElement === resetRef.current) interactionLeftBar.current = false;
    };
    document.addEventListener("pointerdown", noteWhereTheInteractionWent, true);
    document.addEventListener("focusin", noteWhereTheInteractionWent, true);
    document.addEventListener("pointerup", forgetIfFocusNeverLeft, true);
    // A touch/pen press that becomes a scroll never dispatches pointerup.
    document.addEventListener("pointercancel", forgetIfFocusNeverLeft, true);
    return () => {
      document.removeEventListener("pointerdown", noteWhereTheInteractionWent, true);
      document.removeEventListener("focusin", noteWhereTheInteractionWent, true);
      document.removeEventListener("pointerup", forgetIfFocusNeverLeft, true);
      document.removeEventListener("pointercancel", forgetIfFocusNeverLeft, true);
    };
  }, []);
  const wasFiltered = useRef(filtered);
  // LAYOUT effect: runs inside the commit, before any macrotask, so the re-home lands in the same
  // frame rather than after a visible frame with focus stranded on <body>.
  useLayoutEffect(() => {
    const losingReset = wasFiltered.current && !filtered;
    wasFiltered.current = filtered;
    const claim = resetFocusClaim.current;
    if (losingReset && claim !== null && performance.now() <= claim) {
      // Consumed, not left set: a later transition must not inherit this one's answer.
      resetFocusClaim.current = null;
      // SAFETY READ: re-home only when focus ended up nowhere useful. On engines that focus a
      // <button> on mousedown, clicking the last hidden chip blurs Reset while enabled and focuses
      // the CHIP — without this the effect would yank focus off the control just clicked.
      const ae = document.activeElement;
      if (!ae || ae === document.body || ae === resetRef.current || !document.body.contains(ae)) {
        focusFirstStatusChip(groupRef.current ?? document);
      }
    }
  }, [filtered]);

  return (
    <div
      ref={groupRef}
      role="group"
      aria-label={GROUP_LABEL}
      data-testid="status-filter-bar"
      style={{
        display: "flex",
        alignItems: "center",
        // The chips are sized to content and Reset is `nowrap`, so NOTHING here can shrink — and
        // the sidebar drags down to MIN_WIDTH 160 (AgentSidebar), which leaves ~140px of content
        // against a row that wants ~168. Without wrapping the bar overflows a list whose
        // `overflowY: auto` makes overflow-x `auto` too, and `marginLeft: auto` collapses — which
        // pushes Reset, the one control this bar adds, off the edge exactly when a band is hidden
        // and the user needs it. Let the row drop Reset to a second line instead.
        flexWrap: "wrap",
        gap: 4,
        padding: "6px 2px 2px",
      }}
    >
      {/* Names what the row of dots IS. Without it three bare dots above the ladder read as status
          indicators (something the sidebar has plenty of) rather than as controls. */}
      <IoFilter
        aria-hidden
        size={13}
        style={{ flex: "0 0 auto", color: C.muted, marginRight: 1 }}
      />
      {STATUS_BANDS.map((band) => {
        const on = visible[band.id];
        const dot = bandColor(band.id);
        const n = counts[band.id];
        return (
          <button
            key={band.id}
            onClick={() => onToggle(band.id)}
            // The chip is a toggle, so announce it as one — screen readers get the on/off state and
            // the full "3 Need you" phrase rather than a bare colored dot. Since the chip renders no
            // text, this label is the ONLY place the band is named: keep it.
            aria-pressed={on}
            aria-label={`${bandCountLabel(band.id, n)} — ${on ? "showing, click to hide" : "hidden, click to show"}`}
            title={`${bandCountLabel(band.id, n)} — ${on ? "click to hide" : "click to show"}`}
            data-testid={`status-chip-${band.id}`}
            data-on={on ? "true" : "false"}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              // Sized to content now that the label is gone. Stretching a dot-and-digit chip across
              // a third of the sidebar is what forced the truncation this replaced.
              flex: "0 0 auto",
              justifyContent: "center",
              padding: "3px 8px",
              // Matches ShowHelperButton's 6 rather than a full 999 pill: at this size the capsule
              // read as a tag, and the sidebar's other small buttons are all soft rectangles.
              borderRadius: 6,
              borderWidth: 1,
              borderStyle: "solid",
              // An ON chip carries its band's color at low alpha; an OFF chip keeps its shape but
              // drops to the neutral outline, so the row of chips never changes size on toggle.
              // That outline is `hairline`, not a depth plane: an OFF chip whose border is the
              // plane below the sidebar has no shape left to keep under the near-black palette.
              borderColor: on ? dot : C.hairline,
              background: on ? `${dot}1f` : "transparent",
              fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
              fontSize: 12,
              fontWeight: FONT_WEIGHT.semibold,
              cursor: "pointer",
              // NO OPACITY on the OFF chip, for the same reason the Plan/Build strip lost its 0.9
              // (roborev 54038): opacity composites the CONTENT over the plane, so it was quietly
              // multiplying against the count's ink — light `muted` went 3.86:1 → 2.24:1 on the
              // sidebar, dark 5.89 → 3.18. OFF-ness is already carried three other ways that cost
              // no contrast: the muted ink, the hollow dot and the neutral `hairline` border. (The
              // residual 3.86:1 is `muted` on the light sidebar, the pre-existing gap named in
              // chromeContrast.test.ts — not this chip's to close, and not made worse here.)
              transition: "background .15s, border-color .15s",
            }}
          >
            {/* ● N, from the SHARED badge rather than a local dot+span. The chip and the badge had
                grown identical markup with subtly different colour rules, which is the drift
                BandBadge exists to end — the dot is filled when the band is showing and a hollow
                ring when it is hidden, so the state survives for anyone who can't separate the
                red/green pair. `silent`: the button already announces the phrase AND the toggle
                state, so a second accessible name here would say the count twice. */}
            <BandBadge
              band={band.id}
              count={n}
              filled={on}
              silent
              ink={on ? undefined : C.muted}
            />
          </button>
        );
      })}
      {/* Right-aligned rather than butted against the last chip so it holds still as the counts
          gain and lose digits. PERMANENTLY MOUNTED — hidden and disabled when there is nothing to
          reset — because unmounting it strands focus (see the note above). */}
      <button
        ref={resetRef}
        onClick={onReset}
        onFocus={() => {
          interactionLeftBar.current = false;
          resetFocusClaim.current = Infinity;
        }}
        onBlur={(e) => {
          if (resetFocusClaim.current === null) return;
          const to = e.relatedTarget as Node | null;
          const wentToRealElementOutside =
            !!to && to !== document.body && !groupRef.current?.contains(to);
          resetFocusClaim.current =
            wentToRealElementOutside || interactionLeftBar.current
              ? null
              : performance.now() + RESET_FOCUS_CLAIM_MS;
        }}
        disabled={!filtered}
        data-testid="status-filter-reset"
        title="Show every status again"
        style={{
          marginLeft: "auto",
          flex: "0 0 auto",
          visibility: filtered ? "visible" : "hidden",
          background: "none",
          border: "none",
          padding: "0 2px",
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          fontSize: 12,
          color: C.accent,
          cursor: "pointer",
          textDecoration: "underline",
          whiteSpace: "nowrap",
        }}
      >
        Reset
      </button>
    </div>
  );
});
