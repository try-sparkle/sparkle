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

/**
 * ══ THE CONCIERGE AGENTS BADGE'S WIDTH LADDER — bead `sparkle-8f4pj7` ═════════════════════════
 *
 * EVERY NUMBER BELOW IS MEASURED, none are chosen. `scripts/visual/concierge-header-probe.mjs`
 * reads the badge's real width in real Chrome at the row's real 12px face:
 *
 *     "· 2 active now · 63 in the last hour"   192px
 *     "· 2 active now · 63 last hr"            143px
 *     "· 2 active · 63 last hr"                116px
 *     "· 2 · 63 last hr"                        79px
 *
 * …against a budget of `column - 56px` (row padding 28 + dot slot 24 + gap 4) minus whatever the
 * title keeps ({@link CONCIERGE_TITLE_FLOOR_PX}). So the full phrase needs a ~300px column, and at
 * `BUILD_COLUMN_DEFAULT_WIDTH` (220) — the width the app BOOTS at — it does not fit at all: it
 * renders `· 2 active now · 63 in th…`, a label that has ellipsized away its own window. That is
 * precisely the unreadable count this bead exists to remove, so shipping one phrase at every width
 * was not an option.
 *
 * ══ WHAT MAY BE SHED, AND IN WHICH ORDER ══════════════════════════════════════════════════════
 *
 * The founder's ranking, applied top-down as the column narrows:
 *
 *   1. the TITLE's spelling      — "Concierge Agents" is a constant string he already knows
 *   2. the recent count's WORDS  — "in the last hour" → "last hr"; the UNIT survives both
 *   3. the live gauge's word     — "2 active now" → "2 active" → "2"
 *
 * THE UNIT IS NEVER SHED. `· N recently` — a count with no stated window — is the exact defect
 * being removed, so an abbreviation that dropped the hour would re-create it at the widths he is
 * most likely to be looking at. `63/hr` was rejected for a subtler version of the same fault: it
 * reads as a RATE (63 per hour) rather than a count inside a one-hour window.
 *
 * The ARIA label is not on this ladder at all — see `badgeAria`, which always speaks the full
 * sentence. A screen reader has no column to run out of.
 *
 * ══ EVERY THRESHOLD SITS 5px BELOW ITS ROUND NUMBER, DELIBERATELY ═════════════════════════════
 *
 * These are compared against the MEASURED column width, and a column configured to 220 measures
 * **219** (`clientWidth` excludes the border). A threshold written as a round `220` therefore fires
 * on the wrong side at exactly the width the app boots at — which is not a hypothetical: the title
 * floor was written as 220, released itself at the default width, and the row rendered as `Co…`
 * with no name on it. That is the bug the floor exists to prevent, reintroduced by an off-by-one.
 *
 * So each threshold is set below the round width a human would drag to, giving every common
 * setting a side of the boundary it stays on. The exact values carry HEADROOM as well: the probe
 * measured the full tier 2px short at a 300px column and the short tier 2px short at 260px, because
 * the title's `flexShrink: 100` yields less than a larger factor would and the badge gets what is
 * left. A tier boundary sitting within a couple of pixels of its own fit is a tier that ellipsizes
 * on the next font tweak, so each was raised until the probe passed with room. `concierge-header-probe` sweeps the round widths and
 * reports the phrasing at each, which is what catches this if the arithmetic ever drifts again.
 */
export const CONCIERGE_BADGE_FULL_MIN_COLUMN_PX = 330;

/** Below {@link CONCIERGE_BADGE_FULL_MIN_COLUMN_PX}: `· 2 active now · 63 last hr` (143px). */
export const CONCIERGE_BADGE_SHORT_MIN_COLUMN_PX = 270;

/** Below that: `· 2 active · 63 last hr` (116px) — the tier the DEFAULT 220px column lands on. */
export const CONCIERGE_BADGE_TERSE_MIN_COLUMN_PX = 215;

/**
 * How much room the title keeps before the badge starts yielding, in px — and the width below
 * which it keeps none.
 *
 * WITHOUT A FLOOR THE TITLE VANISHED ENTIRELY. The title is weighted to yield first (rule 1 above),
 * and unbounded that means flexbox takes ALL of it: measured at 220px, the row rendered
 * `· 2 active now · 63 in th…` with no name on it at all. A row with no name is hard to pick out of
 * a column of rows, so "yields first" is not "yields everything".
 *
 * ══ SMALL ON PURPOSE — A BIG FLOOR IS WHAT CLIPS THE NUMBERS ══════════════════════════════════
 *
 * This was 46px (`Conci…`) first, and it made things WORSE, which is the counter-intuitive part
 * worth writing down. The 1000:1 shrink weighting already leaves the title a sliver on its own:
 * flexbox distributes the overflow in proportion, so at a 220px column the title lands near 31px
 * — `Con…`, a name — WITHOUT any floor at all, and the badge still gets every pixel it asked for.
 * A 46px floor does not add a name that was missing; it takes 15px the badge needed and clips the
 * numbers, which is the outcome the founder ranked last.
 *
 * So the floor's job is only to stop the title reaching ZERO in the corner cases where the
 * proportional split would take it there. 28px is about `Co…` — enough that the row is never
 * anonymous, small enough that it never outbids a count.
 *
 * IT IS RELEASED BELOW {@link CONCIERGE_TITLE_FLOOR_MIN_COLUMN_PX}, which is not an exception to
 * the rule but the rule reaching its limit: at 199px the floor and the shortest badge together
 * exceed the whole row, so holding the floor would clip the numbers to buy a name nobody dragged
 * the column that narrow to read.
 */
export const CONCIERGE_TITLE_FLOOR_PX = 28;

/** At or above this column width the title keeps {@link CONCIERGE_TITLE_FLOOR_PX}; below it, none. */
export const CONCIERGE_TITLE_FLOOR_MIN_COLUMN_PX = 195;

/** The title's floor at a given column width. 0 means "give the numbers everything". */
export function conciergeTitleFloor(columnWidthPx: number): number {
  if (!(columnWidthPx > 0)) return CONCIERGE_TITLE_FLOOR_PX;
  return columnWidthPx >= CONCIERGE_TITLE_FLOOR_MIN_COLUMN_PX ? CONCIERGE_TITLE_FLOOR_PX : 0;
}

/** Which phrasing the Concierge Agents badge uses at this COLUMN width. */
export type ConciergeBadgeTier = "full" | "short" | "terse" | "micro";

/**
 * Pick the badge's phrasing for a column width.
 *
 * Pure and exported for the reason {@link stageChipShows} states for itself: jsdom has no layout
 * engine, so a test that rendered the row and measured would read 0 for every width and pass
 * vacuously. The component measures; this decides, and `concierge-header-probe` checks the decision
 * against real pixels.
 *
 * 0 IS "NOT MEASURED YET" AND TAKES THE FULL FORM, matching `stageChipShows`. Booting into an
 * abbreviated form and expanding a frame later is a visible flicker — and the fail-open direction
 * is the honest one, since the full phrase is the one that states its window in words.
 */
export function conciergeBadgeTier(columnWidthPx: number, hasQueue: boolean = false): ConciergeBadgeTier {
  if (!(columnWidthPx > 0)) return "full";
  // A PIXEL ALLOWANCE, NOT A RUNG SHIFT. The first version of this simply stepped the ladder down
  // one whenever a queue existed, which made `full` UNREACHABLE at any width: a 1000px column with
  // a queue dropped the spelled-out window with hundreds of pixels to spare — the exact opposite of
  // the fail-open rule this function documents above. The underlying fact is a fixed WIDTH cost
  // (measured: 66-74px spelled out, 31px abbreviated), so it is charged as width.
  const allowance = hasQueue ? CONCIERGE_QUEUE_SEGMENT_PX : 0;
  const terseAllowance = hasQueue ? CONCIERGE_QUEUE_SEGMENT_TERSE_PX : 0;
  const tier =
    columnWidthPx >= CONCIERGE_BADGE_FULL_MIN_COLUMN_PX + allowance
      ? "full"
      : columnWidthPx >= CONCIERGE_BADGE_SHORT_MIN_COLUMN_PX + allowance
        ? "short"
        : // The queue segment ABBREVIATES at the two narrow tiers, so it costs less there — which
          // is why the allowance is not one number. Evaluating top-down keeps this non-circular:
          // each rung already knows which spelling of the segment it would render.
          columnWidthPx >= CONCIERGE_BADGE_TERSE_MIN_COLUMN_PX + terseAllowance
          ? "terse"
          : "micro";
  // ══ THE THIRD SEGMENT THE BUDGETS WERE NOT MEASURED WITH ═════════════════════════════════════
  //
  // Every width above was calibrated against the TWO-segment badge (live + recent). The queue
  // segment sits BETWEEN them and is suppressed at zero, so it is invisible to a fixture that
  // seeds no queue — which is exactly how the first version of this ladder shipped a budget that
  // the row's own documented common case (`0 active now · 16 queued · 12 in the last hour`)
  // blows straight through. The badge is one nowrap span, so the ellipsis eats the TAIL: the
  // windowed count. That is the one thing this whole change exists to keep on screen.
  //
  // So a queue present raises every threshold by what the segment actually costs — see
  // {@link CONCIERGE_QUEUE_SEGMENT_PX}. A wide column keeps the full phrase; only the crowded
  // widths step down.
  return tier;
}

/**
 * What the spelled-out queue segment costs the badge, in px — ` · 123 queued`, measured in the
 * row's own 12px face. The three-digit form on purpose: a budget calibrated on `16` is wrong the
 * first time a queue reaches a hundred, and this is a ceiling, not an average.
 */
export const CONCIERGE_QUEUE_SEGMENT_PX = 74;

/** The same segment abbreviated — ` · 16 q`, measured the same way. */
export const CONCIERGE_QUEUE_SEGMENT_TERSE_PX = 31;

/**
 * The words for the queue segment at each tier.
 *
 * ON THE LADDER LIKE EVERYTHING ELSE. It used to be the one segment that never shortened, which
 * made it the segment that pushed the windowed count off the end of the badge. `queued` → `q` at
 * the two narrow tiers; the number itself is never abbreviated, because a truncated COUNT is a
 * wrong count rather than a terse one.
 */
export function conciergeQueueLabel(n: number, tier: ConciergeBadgeTier): string {
  return tier === "full" || tier === "short" ? `${n} queued` : `${n} q`;
}

/**
 * The words for the recent count at each tier.
 *
 * EVERY TIER NAMES THE WINDOW — that is the invariant, not any particular string. An abbreviation
 * may shed words but never the unit, or it becomes the `· N recently` this bead removed.
 *
 * BOTH SPELLINGS ARE PASSED IN, AND BOTH ARE REQUIRED — no defaults. They come from
 * `RECENT_RESEARCH_WINDOW_LABEL` / `RECENT_RESEARCH_WINDOW_SHORT_LABEL`, which are derived from the
 * bound `recentTasks` actually enforces. An earlier version defaulted them to literals, which put a
 * hardcoded `"last hr"` on the tier the DEFAULT column width lands on: change the window and that
 * badge would state a period nothing enforces, believed, with every test green. A required
 * parameter makes that unrepresentable rather than merely discouraged.
 */
export function conciergeRecentLabel(
  n: number,
  tier: ConciergeBadgeTier,
  /** The spelled-out window, from the store's `RECENT_RESEARCH_WINDOW_LABEL`. */
  windowLabel: string,
  /** The abbreviated window, from the store's `RECENT_RESEARCH_WINDOW_SHORT_LABEL`. */
  shortWindowLabel: string,
): string {
  return tier === "full" ? `${n} in ${windowLabel}` : `${n} ${shortWindowLabel}`;
}

/**
 * The words for the live gauge at each tier.
 *
 * "ACTIVE", NEVER "RUNNING", wherever it still has a word: the gauge counts `queued` + `running`
 * (`phaseOf`), so "running" overclaims for a dispatched-but-unstarted task — which is what the aria
 * label used to say. `micro` drops to the bare number, the last thing shed and only below 200px,
 * because the recent count's UNIT outranks it.
 */
export function conciergeLiveLabel(n: number, tier: ConciergeBadgeTier): string {
  if (tier === "micro") return `${n}`;
  return tier === "terse" ? `${n} active` : `${n} active now`;
}
