import { C } from "../theme/colors";
import { FONT_MONO, RADIUS, TYPE } from "../theme/scale";
import { TERM_HAIRLINE } from "./terminalChrome";
import { honestStageMeta, stageChipIsSilent } from "../engine/buildSections";
import type { BuildSectionId } from "../engine/buildSections";
import type { WorkflowStageId } from "../engine/workflowStage";
import { stageChipShows } from "./rowWidthThresholds";

/**
 * `.stg` — the row's stage chip. The mock:
 *
 *   .row .stg{font:var(--t-micro) var(--k-mono);color:var(--k-muted);
 *             border:1px solid var(--k-hair-solid);border-radius:var(--r-sm);padding:1px 5px}
 *   .row.on .stg{border-color:rgba(125,150,180,.4);color:var(--k-term-muted)}
 *
 * BORDERED, NOT FILLED, and near-square (`--r-sm` = 3px). That is the design's thesis applied to
 * the smallest object in the column — *structure is drawn, not filled* — and it is why this is not
 * one more coloured pill: a filled chip on every row would be a second wall of colour beside the
 * status dots, which is the treatment the column has already been walked back from twice.
 *
 * The text is `stageMeta(stage).short` — "Unsaved", "Saved", "Pushed", "In PR" — the same strings
 * the mock shows, which is not a coincidence: the mock was drawn from this ladder.
 *
 * It answers a different question from the group header above it. The header says which RUNG the
 * section is; the chip says where this row sits, which matters because a row can be read out of
 * order (scrolled past its header, or pulled up in a filtered view) and because the two disagree
 * for a head whose stage rolls up from its workers.
 */
export function StageChip({
  stage,
  active,
  section,
  columnWidth,
}: {
  stage: WorkflowStageId;
  active: boolean;
  /** The rung this row was FILED under. Only consulted to catch the one case where the stage's own
   *  copy contradicts it — see `honestStageMeta`. */
  section?: BuildSectionId;
  /** The measured build column width, or 0 before the first measurement. See `stageChipShows`. */
  columnWidth?: number;
}) {
  // "If it's empty, we shouldn't say empty" — the rule lives in the engine beside the override it
  // comes from, because this same question is asked by more than one renderer (buildSections.ts).
  if (stageChipIsSilent(stage, section)) return null;
  // …and the chip is the first thing to go when the column gets tight.
  if (!stageChipShows(columnWidth ?? 0)) return null;
  const meta = honestStageMeta(stage, section);
  return (
    <span
      data-testid="row-stage-chip"
      title={meta.detail}
      style={{
        flex: "0 0 auto",
        fontFamily: FONT_MONO,
        fontSize: TYPE.micro,
        lineHeight: 1,
        // `--k-muted`. NOT the stage's own colour: the column's rule is that status never colours a
        // row's text, and a per-stage hue here would put ten of them down one column.
        color: C.muted,
        // TWO PLANES, TWO EDGE TOKENS — and BOTH are themed, which the first cut was not.
        //
        // Idle row: `--k-hair-solid`, which is `pillFill` here (theme/colors maps it straight from
        // BLUEPRINT[mode].hairSolid), so this is the spec value exactly.
        //
        // ACTIVE row: the row is painted the TERMINAL's colour, so the chip is no longer sitting on
        // the build column at all and the column's edge token is the wrong one for it. The mock
        // swaps to `rgba(125,150,180,.4)` there; that shipped here as a literal for one commit and
        // it was wrong twice — it is theme-blind (one alpha, applied in both themes, from a
        // dark-mode mock) and `chromeContrast` / `blueprintSpec` cannot sweep a literal. It takes
        // `TERM_HAIRLINE` now (components/terminalChrome.ts) — `BLUEPRINT[mode].termHair`, the
        // spec's own edge FOR THE TERMINAL PLANE, which is precisely what this chip is now sitting
        // on. `chromeContrast.test.ts` floors that token against the terminal plane specifically,
        // so unlike the literal it is actually swept.
        //
        // Measured on `forest`, so the next person does not have to re-derive it: `termHairline` is
        // 1.222:1 light / 1.480:1 dark, against the idle chip's 1.332 / 1.583 on the column. So the
        // chip holds roughly its weight across the two planes, which is what the mock's swap is
        // for — but note it does not get STRONGER in light, and no token in the set would: in light
        // `forest` (#d9e3f3) sits inside the hairline band, so every candidate lands between 1.12
        // and 1.22. Making this edge read on the light terminal plane needs a token that does not
        // exist; reported in PRD/sparkle/blueprint-agent-sidebar.md. The chip's MEANING never rode
        // on the border — its ink is `muted`, 4.756:1 on `forest` in light and 7.764 in dark.
        border: `1px solid ${active ? TERM_HAIRLINE : C.pillFill}`,
        borderRadius: RADIUS.sm,
        padding: "1px 5px",
        whiteSpace: "nowrap",
      }}
    >
      {meta.short}
    </span>
  );
}
