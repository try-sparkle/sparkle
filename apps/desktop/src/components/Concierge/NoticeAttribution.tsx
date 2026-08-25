// THE ATTRIBUTION HEADER AND THE GREY INK for a line addressed to the CONCIERGE, not the founder
// (bead sparkle-4kgpb3). Who is addressed is decided in ./noticeRecipient; this draws that decision.
//
// ══ ONE DEFINITION, TWO SURFACES ════════════════════════════════════════════════════════════════
// A concierge-addressed line appears in two places — as an individual row (ConciergeMessageRow) and
// as the summary of a folded run of them (ReceiptRunRow). They must look the same, so the treatment
// lives here once rather than being written out at both call sites. That is the same call
// `actionReceiptLine`/`receiptRuns` make about the SUBJECT (`who()` is shared so a fold cannot name
// an agent its rows could not), applied to the styling.
//
// ══ WHY A TEXT HEADER AND NOT A GUTTER RAIL ═════════════════════════════════════════════════════
// A coloured left rail was considered and rejected: it is redundant once the header names the
// sender, and it costs horizontal width in a column that is already narrow when the builder pane is
// open. Recorded so it is not rebuilt.
//
// ══ IT IS DE-EMPHASIS, NOT A DISABLED STATE ═════════════════════════════════════════════════════
// The founder said explicitly that he LIKES seeing these lines; the bug is only that he mistakes
// them for messages addressed to him. So this drops the ink to the app's standard SECONDARY colour
// and stops. Nothing here hides, collapses, filters or removes a line, and there is deliberately no
// `opacity` — the push arm's `opacity: 0.5` is for a STALE push, a claim that has expired, which is
// a different statement and must stay visually distinct from this one.
//
// `C.conciergeMuted` rather than a new token: it is the established secondary ink inside this column
// (the scope line, the vitals, the routing receipt, the lint mark, the fold's own chevron), it is
// defined per-theme (theme/colors), and `theme/chromeContrast.test` already sweeps it over both the
// concierge plane and the lifted one for AA. A new ink would have to earn all of that again.
import type { CSSProperties } from "react";
import { FiClock, FiCornerUpRight } from "react-icons/fi";

import { NOTICE_SENDER_LABEL, type NoticeSender } from "./noticeRecipient";
import { C } from "../../theme/colors";
import { TYPE } from "../../theme/scale";

export const NOTICE_ROW_TESTID = "concierge-notice";
export const NOTICE_ATTRIBUTION_TESTID = "concierge-notice-attribution";
export const NOTICE_AUTHORSHIP_TESTID = "concierge-notice-authorship";
// "Sparkle reminder", NOT a bare "Sparkle". `ConciergeThread.roleLabels.test` bans any LEAF node
// whose ENTIRE text is a speaker name (`/^(sparkle|you)[\s:·—-]*$/i`), which a lone "Sparkle" span
// would match — the same reason the sibling headers are "Sparkle → Concierge" and "Sparkle noticed"
// rather than "Sparkle". The trailing word both keeps it out of that rule and names the channel.
export const NOTICE_AUTHORSHIP_LABEL = "Sparkle reminder";

/**
 * THE GREY, APPLIED TO A WHOLE MESSAGE SUBTREE.
 *
 * ⚠ BOTH LINES ARE LOAD-BEARING, and the second one is the one that is easy to leave out. This is
 * the trap `SentToAgentRow.SENT_CARD_INK_VARS` documents at length, reproduced here because the
 * populations differ and the failure is silent:
 *
 *   • Redefining `--c-cream` reaches everything that RESOLVES that token below this element —
 *     which is what `components/Markdown`'s `prose` root does (`color: C.cream`), and it is what
 *     renders a receipt's sentence. So the prose goes grey.
 *   • But an element that resolves NOTHING inherits a COMPUTED colour from `ConciergeColumn`
 *     (`color: C.cream` on the section), resolved against the theme's token far above this row.
 *     Redefining the token here cannot reach back and re-resolve that. `color` on this element
 *     re-resolves it against the value pinned in this same object, and the subtree inherits it.
 *
 * Written as the token rather than `C.conciergeMuted` twice so there is exactly ONE definition of
 * this treatment's ink, and the cast is unavoidable for the same reason it is there: `CSSProperties`
 * has no index signature for custom properties.
 */
export const NOTICE_INK_VARS = {
  "--c-cream": "var(--c-concierge-muted)",
  color: "var(--c-concierge-muted)",
  // ── AND `--c-pill-ink` IS DELIBERATELY ABSENT (bead sparkle-s6gonk) ───────────────────────────
  //
  // A CLICKABLE PILL INSIDE ONE OF THESE ROWS KEEPS ITS FULL-WEIGHT LABEL. That is not an oversight
  // and it is not a third declaration someone forgot: it is the distinction between this object and
  // `SentToAgentRow.SENT_CARD_INK_VARS`, which DOES pin that token.
  //
  //   • That card changes the GROUND (black in both themes), so a pill on it must re-ink or its
  //     label goes near-black on black in light mode.
  //   • This row changes only the EMPHASIS. The sentence recedes; the controls inside it do not.
  //
  // WHAT WENT WRONG WHEN THERE WAS ONE TOKEN. Every pill painted `C.cream`, so this row's
  // de-emphasis reached the pill's LABEL — while the status dot beside it resolves `bandColor()`,
  // an unrelated token, and kept its colour. A live, actively-working agent therefore rendered as a
  // GREEN DOT next to a GREY NAME, in a chip that still had its teal wash and was still a real
  // `<button>`. The founder read the grey as a disabled state and asked whether the agent was
  // "grayed out because it's no longer relevant"; it was not, and the dot a few pixels away was
  // already saying so. Two adjacent signals contradicting each other is worse than either alone.
  //
  // THE RULE, chosen by the founder on 2026-08-20: the DOT alone carries status, and a pill's label
  // is plainly neutral everywhere it renders. `theme/colors.C.pillInk` is where that lives; leaving
  // it out here is what applies it. `NoticeAttribution.pillInk.test.tsx` asserts the absence, so a
  // future edit that "completes" this object by adding the token fails rather than silently
  // restoring the bug.
} as CSSProperties;

/**
 * The sender→recipient line above a concierge-addressed notice.
 *
 * ══ IT NAMES A ROUTE, WHICH IS WHAT KEEPS IT OUT OF THE NO-CAPTIONS RULE ════════════════════════
 * `ConciergeThread.roleLabels.test` pins a founder decision from 2026-07-27 that the thread prints
 * no authorship captions. That decision was deliberate and this is a header, so it is worth being
 * precise about why the two do not collide rather than discovering it in CI: the rule bans the
 * all-caps shipped form (`SPARKLE`, `YOU`) and any LEAF node whose ENTIRE text is a speaker's name
 * (`/^(sparkle|you)[\s:·—-]*$/i`). "Sparkle → Concierge" is mixed case and names a sender AND a
 * recipient — a statement about where a message went, not a label for who is speaking in the
 * thread's own voice.
 *
 * The precedent is already shipped one arm up in ConciergeMessageRow: a proactive push draws
 * `FiBell` + "Sparkle noticed" at exactly this size and colour, and passes that suite today. This
 * follows it deliberately rather than inventing a second convention — same position, same 12px,
 * same `conciergeMuted`, different glyph and words.
 *
 * ARIA: the glyph is decorative and the text carries the meaning, so the icon is hidden and the
 * label is left as ordinary text. It is NOT a `role="status"` — the thread already owns a single
 * live region (see ConciergeThread.roleLabels), and a second one on every receipt would make a
 * screen reader announce the app's bookkeeping over the concierge's actual reply.
 */
export function NoticeAttribution({
  sender = "sparkle",
}: {
  /** Which subsystem is speaking. One today — see {@link NoticeSender} for why the type is a union
   *  of one and what would have to be true to add a second. */
  sender?: NoticeSender;
}) {
  return (
    <div
      data-testid={NOTICE_ATTRIBUTION_TESTID}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 5,
        fontSize: TYPE.small,
        color: C.conciergeMuted,
        marginBottom: 3,
      }}
    >
      <FiCornerUpRight size={11} aria-hidden />
      <span>{NOTICE_SENDER_LABEL[sender]}</span>
    </div>
  );
}

/**
 * THE AUTHORSHIP MARK on an APP-AUTHORED line addressed to the FOUNDER — today the promise-ledger
 * nudge (bead sparkle-hxypas).
 *
 * ══ WHY THIS IS NOT `NoticeAttribution` ═════════════════════════════════════════════════════════
 * `NoticeAttribution` answers "who is this addressed to" for a line the founder is reading over the
 * concierge's shoulder — it names a ROUTE ("Sparkle → Concierge") and comes with the grey ink of
 * `NOTICE_INK_VARS`. This is the other axis: the line IS addressed to the founder and stays at full
 * weight (he must act on it), and the only thing being said is that the APP wrote it, not the
 * concierge. So it names a SENDER alone ("Sparkle") and touches no ink. `./noticeRecipient`'s
 * header comment argues exactly this split — emphasis (recipient) and authorship (sender) are two
 * dimensions, and greying a nudge to distinguish it would de-emphasise the one class of app line he
 * has to act on.
 *
 * ══ IT IS COMPATIBLE WITH THE NO-CAPTIONS RULE ══════════════════════════════════════════════════
 * `ConciergeThread.roleLabels.test` bans the all-caps shipped form (`SPARKLE`, `YOU`) and any LEAF
 * node whose ENTIRE text is a speaker's name (`/^(sparkle|you)[\s:·—-]*$/i`). {@link
 * NOTICE_AUTHORSHIP_LABEL} is "Sparkle reminder" precisely so it is NOT that name-only leaf — a
 * mixed-case authorship mark carried beside a decorative glyph in a muted header, the same
 * position, size and `conciergeMuted` colour as the shipped "Sparkle noticed" push header one arm
 * up in ConciergeMessageRow, which passes that suite today.
 *
 * A CLOCK, NOT A BELL. The bell is the proactive PUSH's glyph ("Sparkle noticed" — the brain
 * speaking unprompted). A promise nudge is the app noting that time passed and an owed thing did
 * not happen, so it carries a clock — a different glyph keeps the two app-voice lines from reading
 * as the same channel.
 */
export function NoticeAuthorship() {
  return (
    <div
      data-testid={NOTICE_AUTHORSHIP_TESTID}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 5,
        fontSize: TYPE.small,
        color: C.conciergeMuted,
        marginBottom: 3,
      }}
    >
      <FiClock size={11} aria-hidden />
      <span>{NOTICE_AUTHORSHIP_LABEL}</span>
    </div>
  );
}
