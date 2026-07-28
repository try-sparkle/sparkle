// ● N — one status band, stripped to a dot and a number.
//
// WHY THIS IS A COMPONENT. Several surfaces show "band → colour + count", and each had grown its own
// version of it: the sidebar's filter chips, the concierge's scope line, the project tab badges and
// the helper island's chiclets. The differences between them were not design decisions — one painted
// the literal `#ff9a9a`, one `bandColor()`, one `statusInk(bandColor())`. That drift is the same
// "mishmash of shades" the §1 pass exists to end, one component down.
//
// ITS ONE CONSUMER TODAY IS THE SIDEBAR'S FILTER CHIPS, stated plainly rather than left for the next
// reader to discover from a grep. This badge is the ● N form — a dot and a NUMBER. ScopeVitals and
// the project tab badges render the whole PHRASE ("1 Needs you · 2 Running"), so pointing them here
// would delete words from those surfaces, which is a design change and not a dedup. What they should
// take from this file when someone does unify them is the COLOUR RULE below, not the markup; the tab
// badge's `#ff9a9a` is the outstanding case (§7a owns the tab bar).
//
// TWO RULES IT ENFORCES FOR EVERY CALLER — the chips today, and anything that adopts it later:
//
//  1. THE COLOUR COMES FROM THE BAND, never from a literal. `bandColor()` derives it from the
//     band's `colorFrom` status, which is the same AGENT_STATUS entry the agent rows' own dots are
//     painted from — so a badge is always a legend for exactly the rows it counts. `statusInk()`
//     then makes it legible as TEXT (brand green and brand gray are unreadable on light mode's
//     white sidebar; red passes through).
//
//  2. THE FULL PHRASE SURVIVES, in `title` and the accessible name. Stripping "3 Need you" to "3"
//     is a VISUAL change only. `bandCountLabel()` owns the singular/plural agreement — "1 Needs
//     you" but "3 Need you" — and the comment it carries in StatusFilterBar records that splitting
//     the count from the label is what once shipped "3 Needs you" on screen. It is not split here
//     either: the number is rendered alone and the whole sentence goes to the tooltip.
//
// THE DOT'S FILL IS A STATE, NOT DECORATION. Solid = this band is showing / live; hollow ring =
// it is filtered off. That treatment is deliberately doing the work a second red hue would
// otherwise be asked to do — see the red-taxonomy note in packages/ui/tokens.ts.
import { memo } from "react";
import { FONT_WEIGHT, statusInk } from "../theme/colors";
import type { StatusBand } from "../engine/buildSections";
import { bandColor, bandCountLabel } from "../engine/statusBandLabels";

export interface BandBadgeProps {
  band: StatusBand;
  count: number;
  /** Solid dot (default) vs hollow ring. The hollow form means "this band is currently hidden" —
   *  the state has to be legible without relying on colour alone, which matters most for the
   *  red/green pair. */
  filled?: boolean;
  /** Set when an ANCESTOR already announces the same phrase — a `<button aria-label="3 Need you
   *  — showing, click to hide">` wrapping this badge would otherwise make a screen reader say the
   *  count twice. The badge then renders decoratively and contributes no accessible name. */
  silent?: boolean;
  /** Override the count's ink. The DEFAULT is the shared rule — `statusInk(bandColor(band))` — and
   *  that is the point of the component; this exists for the one state the rule has nothing to say
   *  about: a filter chip that is switched OFF drops its count to `muted` so the row reads as "not
   *  currently applied" rather than as three equally live badges. Pass a themed token, never a
   *  literal, or you are re-opening the drift this component closed. */
  ink?: string;
  dotSize?: number;
  fontSize?: number;
}

export const BandBadge = memo(function BandBadge({
  band,
  count,
  filled = true,
  silent = false,
  ink,
  dotSize = 8,
  fontSize = 11,
}: BandBadgeProps) {
  const dot = bandColor(band);
  const phrase = bandCountLabel(band, count);
  return (
    <span
      data-testid={`band-badge-${band}`}
      // `role="img"` with a label, not a bare <span>: the visual content is "●3", which reads as
      // punctuation-plus-a-digit to assistive tech. The role makes the element opaque so the label
      // replaces it rather than being read alongside it.
      {...(silent
        ? { "aria-hidden": true as const }
        : { role: "img", "aria-label": phrase, title: phrase })}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        lineHeight: 1,
        whiteSpace: "nowrap",
        fontSize,
        fontWeight: FONT_WEIGHT.semibold,
        color: ink ?? statusInk(dot),
      }}
    >
      <span
        aria-hidden
        style={{
          flex: "0 0 auto",
          width: dotSize,
          height: dotSize,
          borderRadius: "50%",
          background: filled ? dot : "transparent",
          boxShadow: filled ? "none" : `inset 0 0 0 1.5px ${dot}`,
        }}
      />
      {count}
    </span>
  );
});
