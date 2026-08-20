// WHO AN APP-AUTHORED LINE IS ADDRESSED TO — the founder, or the concierge he is reading over the
// shoulder of (bead sparkle-4kgpb3).
//
// ══ THE REPORT ══════════════════════════════════════════════════════════════════════════════════
// The founder reads lines like these as the CONCIERGE talking to him:
//
//   Not sent to @Sparkle Concierge Agents Header — that text carries the founder's own words,
//   and he did not name this agent…
//   Couldn't file that — board.create_item was called with bad arguments…
//   Not sent, 2 times
//
// They are not. They are the app's own tool layer reporting the outcome of a call THE CONCIERGE
// made, rendered in the same full-weight ink as the concierge's own prose with no attribution. He
// is reading a reply addressed to somebody else and being given no way to tell.
//
// The proof is in the words themselves. `conciergeTools/relayGate.ts` writes, verbatim: "His
// message went to you, not to the fleet — … Either write your OWN brief in your own words". The
// "you" is the concierge and the "his" is the founder, so the sentence is second-person to a reader
// who is not the one looking at it. That is the bug, and it is grammatical before it is visual.
//
// ══ WHY RECIPIENT AND NOT SENDER ════════════════════════════════════════════════════════════════
// The obvious axis is "did the app write this or did the brain", and it is the WRONG one — it would
// grey out lines that are genuinely addressed to the founder and that he must read. All of these
// are app-authored, and every one of them is speaking TO HIM:
//
//   • "That message had more asks than I file at once, so 2 of them didn't make the list — say them
//     again and I'll pick them up."                                  (ConciergeHost, ask-capture)
//   • "Not sent — Alpha has a full-screen app open, so the keys would have run as commands. Your
//     message is back in the box."                                   (Concierge/refusalCopy)
//   • "You said you'd land the retry PR — and that hasn't happened."  (conciergePromiseLedger)
//   • "One queued message was dropped"                                (the `failure` bubble kind)
//
// Each is about HIS message, HIS words, HIS promise, and several end in an instruction only he can
// carry out. Greying those is strictly worse than the bug being fixed: it de-emphasises the one
// class of app line he actually has to act on. So the split is by RECIPIENT.
//
// ══ THE DISCRIMINATOR ALREADY EXISTS, WHICH IS WHY THIS MODULE IS SMALL ═════════════════════════
// `ConciergeSparkleMessage.actionReceipt` is set on exactly the concierge-addressed population and
// on nothing else. Its own doc in ./types says so: "Absent on every other app-authored line and on
// every brain reply, which is what keeps those out of a fold."
//
// That is not a coincidence to lean on nervously — it is structural. A mark is stamped only by
// `ConciergeHost`'s `postSparkle(line, collapsed, receiptMark(...))` third argument, and that
// argument is supplied only on the receipt bus, whose entire population is "a tool call THE
// CONCIERGE made, and what the app answered". Every other `postSparkle` call site — all ~25 of them
// — passes two arguments or fewer. So a receipt IS a concierge-addressed line, by construction.
//
// Reusing it rather than adding a parallel `recipient` field is deliberate: two fields that must
// always agree are two fields that will eventually disagree, and the second one would be set by
// hand at 25 call sites.
//
// ══ IT IS A THIRD AXIS, NOT A RENAME OF `refusalAudience` ═══════════════════════════════════════
// `./refusalAudience` already answers a question with the same words in it, and the two are NOT the
// same question. Keeping them apart is the whole design:
//
//   refusalAudience : founder | internal   → decides the WORDS  (verbatim paragraph, or short gist)
//   noticeRecipient : founder | concierge  → decides the INK    (full-weight, or grey + attribution)
//
// The relay refusal above is the case that proves they must be separate. It is addressed to the
// CONCIERGE (recipient), and yet `refusalAudience` correctly classifies it `founder` — it matches no
// INTERNAL_GATES entry, so it keeps its full paragraph rather than being reduced to a gist. Folding
// the two axes together would force a choice between two wrong answers: grey it AND withhold its
// paragraph (losing the explanation of why his words were not forwarded), or keep the paragraph AND
// leave it looking like concierge prose (the original bug).
//
// So: `{ audience: "founder", recipient: "concierge" }` is a real and expected combination, and
// nothing here may be used to decide how much of a reason to print.

import type { ConciergeMessage, ConciergeSparkleMessage } from "./types";

/** Who a line in the thread is actually talking to. */
export type NoticeRecipient =
  /** Addressed to the founder. Full-weight ink, no attribution header — the default, and the
   *  fail-safe answer for anything unrecognised. */
  | "founder"
  /** Addressed to the concierge; the founder is reading over its shoulder. Grey, and carries an
   *  explicit sender→recipient header so it cannot be mistaken for prose aimed at him. */
  | "concierge";

/**
 * WHO IS SPEAKING on a concierge-addressed line.
 *
 * Established from the code rather than assumed, because the brief asked for the attribution to be
 * factually right and there were three candidate subsystems. Only one of them can put a line in
 * this feed:
 *
 *   • THE TOOL LAYER (`services/conciergeTools/*` via `registry.ts`) — the app refusing or
 *     answering a call the concierge made. Reaches the thread as a receipt. THIS IS THE ONLY ONE.
 *   • THE WATCHER (`services/fleetWatch.ts`, `hookWatcher.ts`, `advisor/watcher.ts`) — reads
 *     artifacts and writes events/state. Emits no thread prose at all.
 *   • THE PUSHER (`services/pusherRunner.ts` and the `packages/core/pusher*` modules) — speaks
 *     through `conciergeNotifier.notifyConcierge`, which hands TEXT TO THE MODEL as a prompt. What
 *     the founder then reads is concierge prose, not an app-authored notice.
 *
 * So there is one true sender today and one label. The type is a union of one on purpose: adding a
 * second subsystem should be a deliberate edit here with a code path behind it, not a string
 * invented at a call site. Flattening genuinely different senders onto one name is the failure this
 * was written to avoid — so if the Watcher or Pusher ever does reach the feed, it gets its own arm.
 */
export type NoticeSender = "sparkle";

/** The attribution header shown on a concierge-addressed line: sender, then recipient.
 *
 *  ══ IT IS COMPATIBLE WITH THE NO-CAPTIONS RULE, AND THAT NEEDED CHECKING ═══════════════════════
 *  `ConciergeThread.roleLabels.test` pins a founder decision from 2026-07-27 that the thread prints
 *  no authorship captions. That rule is narrower than its name: it bans the all-caps shipped form
 *  (`/\bSPARKLE\b/`, `/\bYOU\b/`) and any LEAF node whose entire text is just a speaker's name
 *  (`/^(sparkle|you)[\s:·—-]*$/i`). This string is neither — it is mixed case, and its full text
 *  names a sender AND a recipient, which is a routing statement rather than a caption.
 *
 *  The existing "Sparkle noticed" header on a proactive push (ConciergeMessageRow) is the standing
 *  proof that the pattern is allowed: same position, same 12px muted treatment, already shipped,
 *  already passing that suite. This follows it rather than inventing a second convention. */
export const NOTICE_SENDER_LABEL: Record<NoticeSender, string> = {
  sparkle: "Sparkle → Concierge",
};

/**
 * WHO THIS MESSAGE IS TALKING TO.
 *
 * FAILS TOWARD `"founder"`, always. The two mistakes are not equal and the asymmetry is the whole
 * safety argument, exactly as it is in `./refusalAudience`:
 *
 *   • Calling a concierge-addressed line "founder" costs the founder ONE un-attributed row — the
 *     status quo this change improves on, and no worse than it.
 *   • Calling a founder-addressed line "concierge" greys down and re-attributes something written
 *     TO HIM, telling him a message he must act on was meant for somebody else. That is a lie about
 *     authorship, and he cannot know to go looking for what it hid.
 *
 * So only a positively-marked receipt is "concierge". Anything else — a brain reply, a nudge, a
 * recap, a digest, a failure bubble, an unrecognised or hand-edited persisted message — is
 * "founder". A `sparkle` message whose `actionReceipt` came back malformed off localStorage still
 * lands on `founder`, because `undefined` and a bad mark are the same absence of evidence here.
 */
export function noticeRecipient(m: ConciergeMessage): NoticeRecipient {
  // The `kind` test is not redundant with the field test. `actionReceipt` exists only on the
  // `sparkle` arm of the union, so narrowing first is what makes this total over every other kind
  // rather than relying on a field lookup returning undefined on shapes that never declared it.
  if (m.kind !== "sparkle") return "founder";
  return isUsableMark(m.actionReceipt) ? "concierge" : "founder";
}

/**
 * IS THIS MARK GOOD ENOUGH TO RE-ATTRIBUTE A LINE ON? (roborev 65813, Medium)
 *
 * A BARE TRUTHINESS TEST IS NOT, and the gap was real rather than theoretical: `m.actionReceipt ? …`
 * sends `{}` — a truncated, hand-edited or wrong-typed mark off localStorage — down the "concierge"
 * branch, which is precisely the direction this module's own safety argument forbids. The doc above
 * promised the fail-safe; the code did not implement it, and the test that claimed to cover
 * "unusable" only ever passed `undefined` and `null`, the two values where truthiness happens to
 * agree with the promise.
 *
 * WHAT IS CHECKED IS WHAT THE RENDERER'S DECISION RESTS ON, no more: a mark has to be an object
 * carrying the two fields every producer sets (`receiptMark` in ./actionReceiptLine stamps both
 * unconditionally, copied straight off the receipt).
 *
 * ══ IT IS EXPORTED, AND `receiptRuns` CALLS IT — THAT IS NOT A CONVENIENCE ══════════════════════
 * This predicate and the FOLD rule must agree about the same mark, and they did not (roborev 65819).
 * `foldKeyOf`'s refusal arm tests `mark.ok !== true`, which `undefined` satisfies, so a truncated
 * `{ kind, gist }` was foldable while this said it was unusable — and a folded run is drawn
 * concierge-addressed unconditionally. Two consecutive such messages went grey; one alone did not.
 * `receiptRuns.receiptBucketOf` now gates on this, so "foldable" implies "attributable" by
 * construction rather than by a comment claiming it does.
 *
 * DELIBERATELY NOT A FULL VALIDATION. Checking every optional field would reject marks that are
 * merely sparse — most are — and rejecting a good mark costs an un-attributed row on a line that
 * really is the concierge's, which is the harmless direction but still a regression. Two required
 * fields is the smallest test that separates "a receipt" from "an object".
 */
export function isUsableMark(mark: ConciergeSparkleMessage["actionReceipt"]): boolean {
  if (!mark || typeof mark !== "object") return false;
  return typeof mark.kind === "string" && typeof mark.ok === "boolean";
}

/** True when this line should carry the grey, attributed treatment. The one predicate the renderer
 *  asks, so a component never re-derives the rule and the two cannot drift. */
export function isConciergeAddressed(m: ConciergeMessage): boolean {
  return noticeRecipient(m) === "concierge";
}
