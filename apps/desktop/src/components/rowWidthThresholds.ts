/**
 * The two COLUMN-WIDTH thresholds the build row prices its optional chrome against, and the pure
 * predicates that read them. Extracted verbatim out of AgentSidebar.tsx — no logic change.
 *
 * They live in their own module because they are the one thing in the row's width story with more
 * than one consumer: the row itself, `FittedAgentName` (whose docs below restate 260 in prose
 * rather than importing it), and `AgentSidebar.rowNotices.test.tsx`. Re-exported from
 * AgentSidebar.tsx so the existing test import path keeps resolving.
 */

/**
 * The column width at or above which the row still spends space on its stage chip. Bead
 * sparkle-tyter.
 *
 * The founder: *"If the column is narrow, I don't think we should show the in PR or saved or
 * shipped pill. It's fine if the column is wider and there's space but that's a nice-to-have not
 * need-to-have."* That is a ranking, and it is the right one — "Shipped" is a status readout, while
 * the agent's NAME is what the row is for. Below this width the chip is the first thing to go.
 *
 * The FEEDBACK pill is deliberately NOT covered by this: it is an action ("open this agent's
 * feedback in Plan"), not a status readout, and the founder asked for it to take this very slot.
 *
 * ══ IT WENT 260 → 190 → 260, AND THE ROUND TRIP IS THE POINT ══════════════════════════════════
 * It shipped at 260 against a default column of 220 and was cut to 190 (roborev 58758) on the
 * reasoning that a threshold above the default width is not "hidden when narrow" but the chip
 * DELETED for every user until they drag the column wider.
 *
 * That reasoning optimised for the CHIP. It is now reversed, on the founder's own evidence, because
 * it was measured: at 220 — the width the app opens at, the width his screenshot was taken at —
 * `row-narrow-probe` reads the chip alive and the NAME down to **9 characters**, rendering rows as
 * "Concierge…" / "Settings d…" / "G." and, at that squeeze, painting the name's own box 269px²
 * ON TOP of the chip. The founder, seeing it: *"I can't even read the names of the build agents
 * because of all of the messages."*
 *
 * So the ranking that decides this constant is his: **the name wins.** A row exists to say which
 * agent it belongs to; "Saved" is a status readout, and — the part that makes this cheap — it is a
 * status readout the row's own SECTION HEADING already carries. Every row under "LOCAL: COMMITTED"
 * says Saved; every row under "REMOTE: MERGED TO MAIN" says Merged. The chip is the second printing
 * of a fact three pixels above it, and it was outbidding the one fact nothing else on the row says.
 *
 * Nothing is lost that was not already on screen: the section heading carries the stage, and the
 * expanded card renders the full `WorkflowLine` with its detail sentence.
 *
 * `AgentSidebar.rowNotices.test.tsx` pins the RELATIONSHIP rather than the literal — it now asserts
 * the chip is silent at `BUILD_COLUMN_DEFAULT_WIDTH`, which is the reversal stated as a test, so
 * moving either constant back re-fails it.
 *
 * 260 ≈ the width at which the row's fixed chrome (dot · timer · glyph slots) plus a name long
 * enough to tell two agents apart (`NAME_MIN_LEGIBLE_CHARS` in row-narrow-probe) leaves room for a
 * pill worth reading.
 */
export const STAGE_CHIP_MIN_COLUMN_PX = 260;

/**
 * Does the row draw a stage chip at this COLUMN width?
 *
 * Pure and exported for the same reason `Concierge/ComposeBox.attachShowsLabels` is: jsdom has no
 * layout engine, so a test that rendered the row and measured would read 0 for every width and pass
 * vacuously. The component measures; this decides.
 *
 * 0 means "not measured yet" and takes the WIDE form, matching `attachShowsLabels`: booting into the
 * hidden state and revealing the chip a frame later is a visible flicker on every row at once.
 */
export function stageChipShows(columnWidthPx: number): boolean {
  return !(columnWidthPx > 0) || columnWidthPx >= STAGE_CHIP_MIN_COLUMN_PX;
}

/**
 * The column width at or above which the row draws its notice marks SEPARATELY. Bead sparkle-tyter.
 *
 * The founder's rule, verbatim: *"THE NAME WINS. It gets its space first; badges take what is left
 * and truncate or collapse themselves, never the name. If everything cannot fit, collapse badges
 * into a single overflow affordance — do NOT clip the name to one letter."*
 *
 * Hiding the stage chip alone did not buy that. `row-narrow-probe` measured the remaining row at
 * 220px: 24px glyph slot + 24px close slot + a 119px name-and-chips box, of which the goal chip,
 * the warning mark and their gaps took ~34px — leaving the name **9 characters**. The chips are
 * individually tiny and collectively decisive, which is exactly the case a per-chip width
 * convention cannot fix and a collapse can.
 *
 * ══ WHY A COLLAPSE AND NOT A CLIP ═════════════════════════════════════════════════════════════
 * The two boxes around these chips now clip (see the row), so an un-collapsed mark at a narrow
 * width would simply be CUT OFF — silently. That is the one failure this row may never have:
 * `sparkle/agent-5e4caa2c` owns the invariant that no surface may hide a row that needs the
 * founder, and a warning mark scrolled out of a hidden-overflow box is precisely that. Collapsing
 * keeps the signal ON the row at a fixed, always-affordable width, and the collapsed mark carries
 * the WORST ink it stands for — so a row with something escalated still reads red at any width.
 *
 * ══ WHY IT MATCHES `STAGE_CHIP_MIN_COLUMN_PX` ═════════════════════════════════════════════════
 * Same number, and deliberately the same one rather than a second knob: both answer "is this
 * column wide enough to spend pixels on something other than the name". Two thresholds would drift,
 * and there is no width at which the right answer differs between them.
 */
export const NOTICE_CLUSTER_MIN_COLUMN_PX = STAGE_CHIP_MIN_COLUMN_PX;

/**
 * Does the row collapse its notice cluster into one overflow mark at this COLUMN width?
 *
 * Pure and exported for the same reason `stageChipShows` is: jsdom has no layout engine, so a test
 * that rendered the row and measured would read 0 for every width and pass vacuously. The component
 * measures; this decides.
 *
 * 0 means "not measured yet" and takes the WIDE form, matching `stageChipShows` — booting into the
 * collapsed state and expanding a frame later is a visible flicker on every row at once.
 *
 * ONE mark never collapses. An overflow affordance standing for a single mark is strictly worse
 * than the mark: same width, less meaning, one more click to read it.
 */
export function noticeClusterCollapses(columnWidthPx: number, markCount: number): boolean {
  if (!(columnWidthPx > 0)) return false;
  return markCount > 1 && columnWidthPx < NOTICE_CLUSTER_MIN_COLUMN_PX;
}
