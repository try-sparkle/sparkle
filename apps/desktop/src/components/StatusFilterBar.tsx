import { memo } from "react";
import { IoFilter } from "react-icons/io5";
import { C, FONT, FONT_WEIGHT } from "../theme/colors";
import { STATUS_BANDS, type StatusBand } from "../engine/buildSections";
import { bandCountLabel, bandColor } from "../engine/statusBandLabels";
import { BandBadge } from "./BandBadge";

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
  return (
    <div
      role="group"
      aria-label="Filter agents by status"
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
              fontFamily: FONT.ui,
              fontSize: 11,
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
      {filtered && (
        // Right-aligned rather than butted against the last chip so it holds still as the counts
        // gain and lose digits — a link that slides sideways under the cursor is a link people miss.
        <button
          onClick={onReset}
          data-testid="status-filter-reset"
          title="Show every status again"
          style={{
            marginLeft: "auto",
            background: "none",
            border: "none",
            padding: "0 2px",
            fontFamily: FONT.ui,
            fontSize: 11,
            color: C.accent,
            cursor: "pointer",
            textDecoration: "underline",
            whiteSpace: "nowrap",
          }}
        >
          Reset
        </button>
      )}
    </div>
  );
});
