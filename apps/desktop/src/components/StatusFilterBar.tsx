import { memo } from "react";
import { C, FONT, FONT_WEIGHT, statusInk } from "../theme/colors";
import { STATUS_BANDS, type StatusBand } from "../engine/buildSections";
import { bandCountLabel, bandColor } from "../engine/statusBandLabels";

/**
 * The three status chips above the Build column's stage ladder: ● Needs you | ● Running | ● Done.
 * All three start on; clicking one toggles its rows out of the column (and any stage section left
 * with no visible rows disappears with them).
 *
 * The chip's dot is painted from the SAME `AGENT_STATUS` color the rows' own dots use, via the
 * band's `colorFrom` status — so a chip is a legend for exactly the rows it hides. That coupling is
 * the reason the palette isn't spelled here.
 *
 * An OFF chip stays fully readable (it dims and hollows its dot rather than greying out to
 * near-invisibility): a filter you can't see the state of is worse than no filter, and the count
 * keeps showing how many rows are behind it so nothing is silently lost.
 */
export const StatusFilterBar = memo(function StatusFilterBar({
  counts,
  visible,
  onToggle,
}: {
  counts: Record<StatusBand, number>;
  visible: Record<StatusBand, boolean>;
  onToggle: (b: StatusBand) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Filter agents by status"
      data-testid="status-filter-bar"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: "6px 2px 2px",
      }}
    >
      {STATUS_BANDS.map((band) => {
        const on = visible[band.id];
        const dot = bandColor(band.id);
        const n = counts[band.id];
        return (
          <button
            key={band.id}
            onClick={() => onToggle(band.id)}
            // The chip is a toggle, so announce it as one — screen readers get the on/off state and
            // the full "3 Need you" phrase rather than a bare colored dot.
            aria-pressed={on}
            aria-label={`${bandCountLabel(band.id, n)} — ${on ? "showing, click to hide" : "hidden, click to show"}`}
            title={on ? `Hide ${band.label.toLowerCase()}` : `Show ${band.label.toLowerCase()}`}
            data-testid={`status-chip-${band.id}`}
            data-on={on ? "true" : "false"}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              flex: "1 1 0",
              minWidth: 0,
              justifyContent: "center",
              padding: "4px 6px",
              borderRadius: 999,
              borderWidth: 1,
              borderStyle: "solid",
              // An ON chip carries its band's color at low alpha; an OFF chip keeps its shape but
              // drops to the neutral outline, so the row of chips never changes size on toggle.
              // That outline is `hairline`, not a depth plane: an OFF chip whose border is the
              // plane below the sidebar has no shape left to keep under the near-black palette.
              borderColor: on ? dot : C.hairline,
              background: on ? `${dot}1f` : "transparent",
              color: on ? statusInk(dot) : C.muted,
              fontFamily: FONT.ui,
              fontSize: 11,
              fontWeight: FONT_WEIGHT.semibold,
              cursor: "pointer",
              opacity: on ? 1 : 0.65,
              transition: "opacity .15s, background .15s, border-color .15s",
            }}
          >
            <span
              aria-hidden
              style={{
                flex: "0 0 auto",
                width: 8,
                height: 8,
                borderRadius: "50%",
                // Filled when showing, hollow when hidden — the state is legible without relying on
                // color alone, which matters for the red/green pair specifically.
                background: on ? dot : "transparent",
                boxShadow: on ? "none" : `inset 0 0 0 1.5px ${dot}`,
              }}
            />
            {/* The whole phrase comes from bandCountLabel so the verb agrees with the count —
                "1 Needs you" but "3 Need you". Rendering the count and label as separate spans is
                what produced "3 Needs you"; don't split them again for styling. */}
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {bandCountLabel(band.id, n)}
            </span>
          </button>
        );
      })}
    </div>
  );
});
