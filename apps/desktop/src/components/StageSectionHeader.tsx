import { memo } from "react";
import { C, FONT_WEIGHT } from "../theme/colors";
import type { BuildSectionMeta } from "../engine/buildSections";

/**
 * The label above one rung of the Build column's stage ladder — "Local: Committed", "Remote: Pull
 * Request Open", etc. Rendered only for sections that HAVE rows (see groupAgentsByStage), so this
 * never paints an empty header.
 *
 * Deliberately quiet: small, uppercase, muted, and no background fill. It's a divider that answers
 * "how far has this work got", not a control — the rows underneath are what the eye should land on.
 * The count sits at the right so the header doubles as a tally without the label having to inflect.
 *
 * `React.memo`'d: its props are a stable metadata object plus a number, so a status flip on a row
 * inside the section doesn't re-render the header.
 */
export const StageSectionHeader = memo(function StageSectionHeader({
  meta,
  count,
}: {
  meta: BuildSectionMeta;
  count: number;
}) {
  return (
    <div
      title={meta.detail}
      data-testid={`stage-header-${meta.id}`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        // Tight above, looser below: the header belongs to the rows that follow it, and asymmetric
        // padding is what makes that grouping read without needing a rule or a box.
        padding: "12px 10px 4px",
        fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
        fontSize: 10,
        fontWeight: FONT_WEIGHT.semibold,
        letterSpacing: 0.6,
        textTransform: "uppercase",
        color: C.muted,
        // The header must never be a drop target or a text selection — it sits between draggable
        // rows, and a stray selection while dragging looks like a broken control.
        userSelect: "none",
        pointerEvents: "auto",
      }}
    >
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {meta.label}
      </span>
      <span style={{ flex: "0 0 auto", opacity: 0.75, fontVariantNumeric: "tabular-nums" }}>{count}</span>
    </div>
  );
});
