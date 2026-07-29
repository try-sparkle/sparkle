import { memo } from "react";
import { C } from "../theme/colors";
import type { BuildSectionMeta } from "../engine/buildSections";
import { COUNT, SECTION_LABEL } from "./labelTreatment";

/**
 * `.grp` — the label above one rung of the Build column's stage ladder ("Local: Committed",
 * "Remote: Pull Request Open", …). Rendered only for sections that HAVE rows (see
 * groupAgentsByStage), so this never paints an empty header.
 *
 * ── PORTED FROM THE MOCK (PRD/sparkle/ui-directions/rev4.html, `.grp`) ────────────────────────
 *   .grp{display:flex;align-items:center;gap:7px;padding:7px 10px 4px;
 *        font:500 var(--t-micro)/1 var(--k-mono);letter-spacing:.1em;text-transform:uppercase;
 *        color:var(--k-faint)}
 *   .grp .rule{flex:1;height:1px;background:var(--k-rule)}
 *
 * THREE PARTS, IN THIS ORDER: label · rule · count. The RULE is the whole point and it is what the
 * old header did not have — it took `flex:1` on the LABEL instead, so the header was a line of text
 * with a number stranded at the far right and nothing tying them together. Giving the rule the flex
 * makes the label size to its own words, the count sit right, and the 1px line span whatever is
 * left: the ladder reads as a drawn instrument rather than as two loose spans.
 *
 * The type treatment is `SECTION_LABEL` (theme/scale's `LABEL` plus the readable ink) — mono, 10px, uppercase, 0.1em tracked. That is
 * the design's single most characteristic mark (scale.ts calls it exactly that) and this header is
 * its primary home in this column; it was `system-ui / letterSpacing 0.6` before, which is a
 * different typeface saying a similar thing.
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
        gap: 7,
        // Tight above, looser below: the header belongs to the rows that follow it, and asymmetric
        // padding is what makes that grouping read without needing a box. The mock's own
        // `7px 10px 4px`; the 10 matches ROW_PAD_X so the label starts on the rows' text column.
        padding: "7px 10px 4px",
        // SECTION_LABEL, not `...LABEL` + a hand-typed colour. Two agents reached the same
        // conclusion independently — `SECTION_LABEL` IS `{ ...LABEL, color: C.muted }` — and the
        // named constant is what stops the next section header re-deriving it a third way.
        ...SECTION_LABEL,
        lineHeight: 1,
        // ── THE ONE PLACE THIS PORT DOES NOT TAKE THE SPEC'S COLOUR, AND THE NUMBERS FOR IT ────
        // The mock paints every tracked micro label `--k-faint`. That token is `agentIdle` here,
        // and on the surface this header actually paints on — `deepForest`, the build column,
        // which IS the spec's own `bridge` — it measures 3.377:1 light (#7387a5 on #f2f6fd) and
        // 4.353:1 dark. Both under AA, and this is real 10px UI text, not a dot. `muted` is
        // 5.678 / 7.169 on the same surface.
        //
        // So the TREATMENT is ported and the INK is not: mono, uppercase, 0.1em tracked, at 10px,
        // in the readable secondary tier. The treatment is what makes the ladder read as an
        // instrument; the faintness was never the characteristic part.
        // The header must never be a drop target or a text selection — it sits between draggable
        // rows, and a stray selection while dragging looks like a broken control.
        userSelect: "none",
        pointerEvents: "auto",
      }}
    >
      <span
        style={{
          flex: "0 1 auto",
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {meta.label}
      </span>
      {/* THE RULE. `--k-rule` has no app token yet (theme/colors exposes `hair`'s neighbours but not
          `hair`/`rule` themselves), so this takes `pillFill` — which IS the spec's `--k-hair-solid`,
          the next rung up and the same colour the stage chip's border uses. Reported as a gap rather
          than hard-coded: a local hex here is exactly the drift blueprintSpec.ts exists to end. */}
      <span
        aria-hidden
        data-testid={`stage-header-rule-${meta.id}`}
        style={{ flex: 1, minWidth: 0, height: 1, background: C.pillFill }}
      />
      {/* COUNT, not a hand-typed `tabular-nums`. The tally sits INSIDE a SECTION_LABEL
          container, so CSS hands it the label's 0.1em tracking and uppercase unless it says
          otherwise — undoing that inheritance belongs to the treatment, not to each call
          site, which is exactly what this file was doing by hand. */}
      <span style={{ flex: "0 0 auto", ...COUNT }}>{count}</span>
    </div>
  );
});
