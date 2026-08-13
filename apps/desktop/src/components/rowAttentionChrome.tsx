import {
  FiAlertTriangle,
  FiCheckCircle,
  FiTarget,
  FiClock,
  FiAlertOctagon,
  FiInbox,
} from "react-icons/fi";
import type { IconType } from "react-icons";
import { C } from "../theme/colors";
import type { GoalBadge } from "./rowAttention";
import type { NoticeGlyph } from "./agentNotices";

/**
 * The row's attention CHROME — the icon / colour / size / accessible-wording tables the goal chip
 * and the notice glyphs are painted from, plus the retirement copy both retire surfaces share.
 * Moved verbatim out of AgentSidebar.tsx; no logic change.
 *
 * Nothing here re-decides a verdict. `./rowAttention` gathers the evidence and does the wording and
 * `./agentNotices` owns the notice taxonomy; these are only the lookups that turn one of those
 * verdicts into pixels. Consumed solely by AgentRow.
 */

// THE GOAL CHIP'S FOUR STATES, as lookups keyed by `GoalBadge.state` (bead sparkle-6kz9q).
// Split out of the row so the treatments sit side by side and the ordering claim — escalated is the
// loudest, expired next, met and unmet quiet — is READABLE rather than buried in a ternary chain.
// Keyed by the state union, so adding a goal state to rowAttention fails the typecheck here instead
// of silently rendering an unstyled chip.
export type GoalChipState = GoalBadge["state"];

/** THE GLYPH IS THE STATE — colour is the second channel, never the only one.
 *
 *  Once the mark went wordless, a constant `FiTarget` in four inks made hue the ONLY thing telling
 *  a sighted reader "finished" from "handed back" — WCAG 1.4.1, and a regression rather than a
 *  pre-existing gap, since `escalated` and `expired` used to be readable as text. It also fails
 *  precisely the founder's stated test ("which have met it, which have let one expire") for anyone
 *  who cannot separate red, amber and green.
 *
 *  A distinct glyph costs the row NOTHING — same 10px slot — so there is no reason to spend the
 *  accessibility instead. `FiTarget` stays for `unmet` (a goal still being aimed at), and the other
 *  three each say their own state: a check for done, a clock for out of time, an octagon for
 *  stopped. `FiAlertOctagon` deliberately rather than `FiAlertTriangle`, which is the STALL chip's
 *  glyph one slot over — two different facts must not share a shape on the same row. */
export const GOAL_CHIP_ICON: Record<GoalChipState, IconType> = {
  escalated: FiAlertOctagon,
  expired: FiClock,
  met: FiCheckCircle,
  // SHARES `met`'s CHECK DELIBERATELY, and it is the one place this table's "a distinct glyph per
  // state" rule is not followed. The glyph answers "does this row still want something from me",
  // and for both of these the answer is no — met and discharged are the same fact to a scanning eye,
  // differing only in WHO proved it (the agent said so / git showed it). That distinction belongs in
  // the words, where `goalBadgeFor` puts it along with the proving sha, not in a fifth shape the
  // reader has to learn.
  discharged: FiCheckCircle,
  unmet: FiTarget,
};

/**
 * The mark for each notice class. Bead sparkle-tyter.
 *
 * The founder named both of these himself — *"just show me the exclamation point icon or the the
 * little mailbox icon"*. `escalated` is not a third class; it is `warning` at its loudest, split out
 * because auto-continue GIVING UP on an agent (nothing is coming for it at all) has to be
 * distinguishable at a glance from an agent that merely owes a merge.
 *
 * `inbox` is listed for completeness of the union, but the collapsed row never draws it: the message
 * class stays with `AgentInboxBadge`, which already renders the mailbox with its count and owns the
 * popover. See the note at `noticeMarksEl`.
 */
export const NOTICE_GLYPH_ICON: Record<NoticeGlyph, IconType> = {
  alert: FiAlertTriangle,
  escalated: FiAlertOctagon,
  inbox: FiInbox,
  // The three GOAL glyphs, and the same components `GOAL_CHIP_ICON` above uses — one mapping per
  // glyph name, so a state cannot wear one shape here and another there. The collapsed row does not
  // draw a `goal`-class mark (the goal chip IS that mark, and it is clickable now), exactly as it
  // does not draw the `message` class; these entries exist because the union is total and the map
  // must cover it, and because the hover card renders from the same table.
  target: FiTarget,
  clock: FiClock,
  check: FiCheckCircle,
};

export const GOAL_CHIP_COLOR: Record<GoalChipState, string> = {
  // AMBER SINCE 2026-08-06, and it must move together with the composer's `goal:escalated` PILL
  // (Concierge/MountedAgentNotices) — `GOAL_GLYPH`'s own rule is that the chip and the pill must not
  // diverge for one state. Dropping the pill's `escalated -> DANGER` case while this stayed DANGER
  // made one fact read amber on the composer and red here, which is the cross-surface tier split
  // this whole change exists to close, relocated from the stall pill to the goal pill (roborev
  // 59986). The tier is the founder's: auto-continue giving up is our retry budget ending, not a
  // demand on him.
  escalated: C.amberInk,
  // Amber, not danger: the mandate ran out on unfinished work. Loud, but not the top of the row.
  expired: C.amberInk,
  met: C.successInk,
  // The same success ink as `met`: a discharged goal is a finished one, and the row is calm. The
  // founder's 2026-08-06 rule survives here unchanged — expiry that resolves into PROVEN completion
  // is gray/green, and only expiry that resolves into proven UNLANDED work is loud.
  discharged: C.successInk,
  unmet: C.accentInk,
};

/** Escalated is the loudest of the four, and with no words to bold it that has to be carried by the
 *  MARK. Two extra px of diameter is now the SOLE distinction: the ink half of this justification
 *  retired on 2026-08-06, when `GOAL_CHIP_COLOR.escalated` moved to amber with the rest of the tier
 *  (roborev 60018). That makes this map MORE load-bearing than it was, not less — it is the only
 *  visual signal left that escalated is exceptional. Both sides of the comparison are pinned in
 *  stallOverlay.test.tsx under "ESCALATED IS EXCEPTIONAL, AND BOTH SIDES OF THAT COMPARISON ARE
 *  PINNED", in "renders every goal state as an icon-only mark that cannot shrink away" — NOT the
 *  escalated-only width check, which would stay green if the other three states were raised to 12
 *  (roborev 57417/60030). Every other state shares one size so the eye reads the bigger one as
 *  exceptional rather than as a fifth category. */
export const GOAL_CHIP_SIZE: Record<GoalChipState, number> = {
  escalated: 12,
  expired: 10,
  met: 10,
  // 10, with the rest. Escalated is the ONLY exceptional one and the size is now the sole signal
  // that says so — raising anything else to 12 would spend that distinction.
  discharged: 10,
  unmet: 10,
};

/** The state in WORDS, for the accessible name — colour carries it visually, and colour is not a
 *  channel every reader has. `unmet` borrows the badge's own "active · 3h 20m left" so the remaining
 *  time is spoken too; the rest are fixed phrases that name the state outright. */
export const GOAL_CHIP_A11Y: Record<GoalChipState, (b: GoalBadge) => string> = {
  escalated: () => "Goal escalated",
  expired: () => "Goal expired, never met",
  met: () => "Goal met",
  // Borrows the badge's own words the way `unmet` does, so the proving sha is SPOKEN rather than
  // being a visual-only detail. A reader who cannot see the chip is exactly the one who cannot go
  // and check the sha for themselves.
  discharged: (b) => `Goal ${b.label}`,
  unmet: (b) => `Goal ${b.label.replace(" · ", ", ")}`,
};

/** The retirement recommendation's words, in ONE place for the TWO surfaces that say it.
 *
 *  The recommendation renders twice by design: `retirePill` (worded, expanded hover card) and
 *  `retireMark` (wordless glyph, collapsed row — the only scannable surface, so the words it drops
 *  have to survive in its tooltip and accessible name). Both were spelling the same two sentences
 *  out inline, which is a copy-drift hazard the repo treats as a code defect: edit one surface and
 *  the same fact is described two ways, with a green suite (roborev 59545). Hoisted so a single
 *  edit reaches both, and so a test can compare the two surfaces against the same source. */
export const RETIRE_COPY: Record<"ready" | "retro-pending", { title: string; a11y: string }> = {
  ready: {
    // "ON FILE", NOT "LOGGED" — the words have to be true for all THREE receipt states, and only
    // one of them is a retro anyone logged (roborev 59693). `retirementPill` returns `ready` for any
    // receipt at all (`retroSettled` is `receipt != null`), so this same sentence also paints a row
    // whose agent said it HAS no retro (`excused`) and a row a human retired over the gap
    // (`overridden`). Promising "its feedback is logged" there tells the founder a bead exists to
    // read when nothing was ever filed — the exact false-settled reading engine/retroReceiptTypes
    // is fail-closed to avoid. This is the one sentence that must hold for whichever state it is.
    //
    // The dialog behind the click DOES word each state precisely — but only since roborev 59891,
    // which found this same false sentence still standing there on the more prominent surface, and
    // an earlier version of this very comment vouching for it. It is `SETTLED_LEDE` in
    // RetireAgentConfirm.tsx now, keyed on `receipt.state`; a fourth state has to be worded there
    // as well as here.
    title: "Done, landed, and its retro step is on file — click to retire it",
    a11y: "Ready to retire",
  },
  "retro-pending": {
    title: "Landed, but it hasn’t reported back yet. It’s being asked; nothing is blocked on you.",
    a11y: "Retro pending",
  },
};
