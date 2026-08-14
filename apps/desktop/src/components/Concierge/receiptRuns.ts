// A RUN of identical concierge receipts, folded to ONE line — and the rule for which ones may NEVER
// fold (bead sparkle-6xvn7).
//
// ══ WHY ═════════════════════════════════════════════════════════════════════════════════════════
// The concierge restarted the fleet after an account switch: sixteen `send_to_agent_terminal` calls
// in one turn, sixteen receipts, sixteen full-width rows each reading "Sent to @<name>'s terminal."
// with its own copy glyph. The founder screenshotted the column and sent it with no words, because
// the picture is the complaint: ONE fact — the fleet was restarted — cost him the entire column and
// a scroll past every row of it.
//
// This is the same problem `ActivityChip` already solved one component over ("a whole stretch of the
// agent's tool machinery, collapsed to ONE expandable line … you can see that work happened and what
// kind, without reading it"), and it is solved the same way: COMPRESSED, NOT DELETED. The individual
// receipts still exist, still say exactly what they said, and are one click away.
//
// ══ THE RULE THAT OUTRANKS THE COMPRESSION ══════════════════════════════════════════════════════
// FOLDING MUST NEVER HIDE SOMETHING THAT NEEDS THE READER. A receipt exists so a claim can be
// CHECKED rather than believed (services/conciergeReceipts), and a refusal is the half he actually
// has to act on — "I couldn't" is the answer to "why didn't it do the thing I asked". So:
//
//   • successes fold;
//   • no refusal ever counts toward a success total;
//   • a refusal aimed at the CONCIERGE — a review gate, running checks, no free agent slot — is one
//     it read and routed around, so there is nothing owed and nothing to act on. Its paragraph is
//     WITHHELD and replaced by a short gist (`Concierge/refusalAudience`), and it folds on
//     `kind + gist` (roborev 63295);
//   • a refusal the FOUNDER must read is NEVER withheld — and, since roborev 63727, still FOLDS,
//     keyed on `kind + the verbatim reason` and repeating that reason word for word. WITHHOLDING
//     AND FOLDING ARE DIFFERENT OPERATIONS, and this module conflated them for two rounds: the rule
//     "his refusals never fold" was written to protect the words, but folding does not touch the
//     words — it removes DUPLICATES of them. One relay to five agents parked on the same approval
//     prompt is five copies of one sentence, and there is no reading of "he must see it" under
//     which he must see it five times. His own ruling, after four reports: "maybe you collapse them
//     all or something";
//   • …and a folded refusal still never claims the action happened, and never drops its reason;
//   • a partial fan-out (`failed > 0`) never folds either — `inboxBroadcast` reports a partial
//     failure as an OK reply carrying counts, so keying on `ok` alone would swallow the failures
//     into a number that claims flat delivery;
//   • and neither does a success carrying DETAIL (`hasDetail`) — a spawn that came up but could not
//     be BRIEFED reports `ok: true` and says so in a second sentence, so folding it to "Spawned 5
//     agents." deletes the only place the reader learns an agent is sitting there doing nothing.
//
// Those last two are the reason `ok` alone is not the rule: an actionable receipt is not always a
// refusal, and two of the three guards live on the success side.
//
// A row reading "Sent to 16 agents" while three of them silently refused is STRICTLY WORSE than the
// wall of sixteen: the wall is merely tiring, and that row is false. This afternoon six sends were
// rejected for a bad argument and the founder saw six alarming cards for an already-fixed problem —
// exactly the population that must stay individually visible.
//
// ══ AND THE COUNT ITSELF MUST BE HONEST ═════════════════════════════════════════════════════════
// `members.length` IS the count — the folded line is built FROM the members it stands for, never
// from a number carried alongside them, so the two cannot drift (the convention `buildDigest`'s
// `memberIds.length === count` establishes for the unmerged group). And because two sends can go to
// ONE agent, the sentence counts DISTINCT SUBJECTS for the agent noun and says so separately when
// the number of sends exceeds it: "Sent to 12 agents' terminals" is a different claim from "Sent 16
// messages to 12 agents' terminals", and only one of them is true at a time.
import {
  ANONYMOUS_SUBJECT,
  line,
  plain,
  ref,
  type Line,
} from "./conciergeLine";
import type {
  ConciergeMessage,
  ConciergeReceiptMark,
  ConciergeSparkleMessage,
} from "./types";

/** A run must be at least this long to fold. TWO, not three: at two the collapsed row shows both
 *  pills inline, so nothing is hidden and one row replaces two rows and two copy glyphs. A run of
 *  ONE never folds — a group of one is chrome around a line that was already fine, and it is the
 *  same call `buildDigest` makes ("keeps a lone un-landed agent as its own row, never a group of
 *  one"). */
export const MIN_RUN = 2;

/**
 * The FOLD KEY for one receipt, or `null` when this receipt must stand alone.
 *
 * This is the whole policy, in one pure function, so the "never hide a refusal" rule is a thing a
 * test can hold rather than a thing a renderer remembers. Two receipts fold together if and only if
 * both return the same non-null key.
 *
 * IT FAILS OPEN: an unrecognised mark SURFACES its row individually rather than going quiet inside a
 * group. That matters because a mark can come off localStorage — the thread is persisted, so a
 * restored or hand-edited message can carry a malformed one. Every test here refuses on anything
 * unexpected: `ok !== true` rather than `ok === false`, a `typeof` guard on `failed`, a `default` arm
 * for an unknown kind. The worst a bad mark can do is cost one un-folded row; the opposite default
 * would let it fold a refusal.
 *
 * ══ AGAINST THE NEVER-HIDE-ACTIONABLE AUDIT'S FIVE QUESTIONS ════════════════════════════════════
 * The audit is the founder's 2026-08-05 ruling, "we should never hide a row that needs action from
 * me", worked into a checklist for any capped or collapsed list. ITS DOC IS NOT IN THIS TREE — it
 * lives on the unmerged branch that produced it (`3386a960e`, as `docs/never-hide-actionable-rows.md`),
 * so the questions are restated here rather than cited, and this comment stands on its own if that
 * branch lands elsewhere or not at all.
 *
 *   1. Can this list contain an actionable row? YES — a refusal is the action he owes.
 *   2. Can the cap hide one? NO — and the ANSWER IS NO FOR A DIFFERENT REASON SINCE roborev 63727,
 *      which is worth stating precisely because the old reason was simpler and is now wrong. It used
 *      to be "an actionable receipt cannot ENTER a fold". It can. What it cannot do is LOSE ANYTHING
 *      by entering one: a founder refusal folds on its VERBATIM reason and the folded sentence
 *      repeats that reason word for word, names every subject the rows named, and expands in place.
 *      The audit asks whether the reader can still reach what he must act on, not whether the rows
 *      were left un-merged — and five copies of one sentence answer that question no better than
 *      one copy does.
 *
 *      FOUR guards still keep a row OUT of a fold entirely, each load-bearing because its population
 *      would lose something, and deleting any ONE breaks this property while the other three still
 *      look like they hold it:
 *        • `fanout` — an already-plural receipt. Folding fan-outs needs a count of counts, and "Not
 *          sent, 2 times" over two broadcasts UNDERSTATES how many agents missed the message. It is
 *          tested ABOVE the refusal arm, which is what keeps it true for refusals too (roborev
 *          63747 — under the arm it was unreachable-by-luck rather than correct).
 *        • `failed > 0` — a fan-out that reported ok while losing recipients; folding rolls a
 *          reported failure into a success count.
 *        • `hasDetail` — a success whose line says more than its standard wording (a spawn that
 *          could not be briefed); the count has no way to say the second sentence.
 *        • a refusal with NO reason at all — nothing proves two of those say the same thing.
 *   3. Does the residue name what was withheld? Nothing actionable is withheld, and every distinct
 *      SUBJECT is named exactly once — as a clickable pill when its receipt resolved to an openable
 *      agent, otherwise as the words the individual row used ("that agent"). PER SUBJECT, NOT PER
 *      MEMBER: a member repeating a subject already named adds no chip, because the residue and the
 *      count are one derivation (`subjectKey`) and sixteen chips under a sentence saying one agent is
 *      the wall this fold exists to remove. An unidentifiable member is never merged (`subjectKey`
 *      returns null), so that population still renders and counts individually. The property that
 *      matters is that the fold never removes navigation the unfolded row had — not that it emits a
 *      slot per member, which would DELETE the dedupe if read as normative.
 *   4. Is the affordance real? Yes — the chevron expands in place, and it is pinned by a test.
 *   5. Is the disclosure mandatory? Yes — a run always renders its toggle; there is no path on which
 *      members exist with no way to reach them.
 */
export function foldKeyOf(
  mark: ConciergeReceiptMark | undefined,
): string | null {
  if (!mark) return null;
  // ══ THE REFUSAL ARM, FIRST — mirroring actionReceiptLine, which checks `ok` before every success
  // wording for the same reason. Everything below this line describes something that HAPPENED.
  //
  // A REFUSAL FOLDS ONLY WHEN IT CARRIES A GIST (roborev 63295, Medium). The rule used to be a flat
  // "a refusal never folds — it is the action he owes", and that premise is exactly what an
  // INTERNAL gate falsifies: the concierge read it and took another route, so there is nothing owed
  // and nothing to act on. Those refusals also repeat by construction — a merge re-attempted while
  // checks settle, a five-agent fan-out refusing per spawn at capacity — so leaving them unfoldable
  // trades the founder's wall of paragraphs for a wall of identical rows, which is the same
  // complaint wearing different clothes.
  //
  // KEYED ON `kind + gist`, never on kind alone: "waiting on checks" and "no free agent slot right
  // now" are different reasons and must not collapse into one count. And a founder-actionable
  // refusal has NO gist (see `refusalAudience`), so it still never folds — its verbatim words are
  // the thing he has to read, and a count cannot say them.
  //
  // ══ AND A FOUNDER-ACTIONABLE REFUSAL FOLDS TOO — WITH ITS WORDS KEPT (roborev 63727) ═══════════
  //
  // THE RULE CHANGED, ON THE FOUNDER'S OWN RULING: "maybe you collapse them all or something", after
  // four reports of the same wall. It used to be that a refusal with no gist NEVER folds, because
  // "its verbatim words are the thing he has to read, and a count cannot say them". The second half
  // of that is true and is why this arm exists at all; the first half confused two operations.
  //
  // WITHHOLDING replaces the tool's words with a short phrase — that is `gist`, and it stays limited
  // to refusals `refusalAudience` positively recognises as the concierge's. FOLDING replaces N
  // copies of one row with one row that says the same thing once, plus a count, plus every subject,
  // plus a chevron. The founder loses nothing to the second and everything to the first, so only the
  // first needs the allowlist. A run of five agents all parked on the same approval prompt is FIVE
  // COPIES OF ONE SENTENCE; there is no reading of "he must see it" under which he must see it five
  // times.
  //
  // KEYED ON THE VERBATIM REASON, so only genuinely identical refusals merge — two different screens
  // give two different sentences and stay two rows. That is stricter than the gist key above, which
  // deliberately merges different paragraphs onto one recognised phrase.
  //
  // A REFUSAL WITH NO REASON AT ALL STILL STANDS ALONE. Absence is not evidence: `receiptMark` sets
  // neither field, we cannot prove two such rows say the same thing, and the fail-open default of
  // this whole function is to surface the row.
  // AN ALREADY-PLURAL RECEIPT DOES NOT FOLD, AND THIS TEST SITS **ABOVE** THE REFUSAL ARM (roborev
  // 63747, Medium). A broadcast line already reads "Left a message for N agents" — or, refused,
  // "Not sent to those agents" — so folding several of them would need a COUNT OF COUNTS, and no
  // arm below has an honest way to say that.
  //
  // It used to sit under the refusal arm, which was harmless only while refusals needed a gist (no
  // `INTERNAL_GATES` entry matches a broadcast's refusal). The verbatim door made it reachable: two
  // consecutive `inbox_broadcast` refusals sharing one reason would have folded to "Not sent, 2
  // times" over what was really two fan-outs of N recipients each — a number that is wrong in the
  // one direction this module is forbidden to be wrong in, understating how many agents missed the
  // message. Ordering is the whole fix, so it is stated rather than left to the reader to notice.
  if (mark.fanout === true) return null;
  if (mark.ok !== true) {
    if (mark.gist) return `refusal:${mark.kind}:${mark.gist}`;
    return mark.reason ? `verbatim:${mark.kind}:${mark.reason}` : null;
  }
  // A PARTIAL FAN-OUT IS NOT A SUCCESS. `ok` is true on a broadcast some inboxes rejected; the
  // failures live in `failed`. Folding it would roll a reported failure into a success count — the
  // one outcome this module is forbidden to produce.
  if (typeof mark.failed === "number" && mark.failed > 0) return null;
  // A SUCCESS THAT SAYS MORE THAN "IT HAPPENED" DOES NOT FOLD EITHER, and this is the guard the
  // `ok` test does not cover. A spawn whose agent came up but could NOT be briefed reports
  // `ok: true` and carries the shortfall as a second sentence ("its terminal didn't start … its
  // opening brief hasn't gone in yet") — an agent sitting there doing nothing, which is the whole
  // of the founder's "every agent I spawn starts dead until I go type into it". Replacing that
  // sentence with "Spawned 5 agents." deletes it, which is the same failure as folding a refusal
  // wearing a success's clothes. See ConciergeReceiptMark.hasDetail.
  if (mark.hasDetail === true) return null;

  switch (mark.kind) {
    // BRACED, because the arm declares a binding. `no-case-declarations` is active for this package
    // and `pnpm -r lint` treats it as an error — a gate `pnpm verify` deliberately does not run.
    case "sent": {
      // A PICKER PRESS IS NOT A MESSAGE, and it does not share a bucket with one — the individual
      // lines are already careful to say which happened ("Answered X's prompt." vs "Sent to X's
      // terminal."), and a fold that merged them would undo that distinction wholesale.
      if (mark.viaPicker === true) return "sent:picker";
      // The channel IS the bucket, because the channels are visible at different times: a terminal
      // write lands now, an inbox message waits for the agent's next turn, a held one waits for a
      // PTY that may never come up. "Sent to 16 agents" over a mixture would be true of none of
      // them.
      //
      // ══ AND SO IS WHOSE WORDS WENT (bead `sparkle-p9s5q`) ═══════════════════════════════════
      // Same rule one level in: a relay of the founder's words and a brief the concierge composed
      // say DIFFERENT SENTENCES ("Sent to X's terminal" vs "Concierge wrote to X"), so one count
      // over a mixture is true of neither — and the sentence it would land on is the stronger claim,
      // that his private words reached the fleet. Exactly the false claim this change removes, back
      // through the fold.
      //
      // TERMINAL ONLY, because that is the only channel whose wording carries the distinction. The
      // inbox and held sentences ("Left X a message", "Holding a message for X") already read as the
      // concierge's own act, so splitting their buckets would double the arms below to say the same
      // thing twice.
      const channel = mark.channel ?? "terminal";
      if (channel === "terminal" && mark.relayedFounderWords !== true) {
        return "sent:terminal:concierge";
      }
      return `sent:${channel}`;
    }
    case "spawned":
      return "spawned";
    case "closed":
      return "closed";
    case "goal":
      return "goal";
    // `filed`, `merged` AND `retired` NEVER FOLD **AS SUCCESSES**, and it is not an oversight to
    // revisit. Each of their lines carries a DISTINCT identifier the reader came for — a bead pill,
    // a PR number — so an honest folded sentence would have to enumerate exactly what folding was
    // meant to save. And a merge is high-consequence: "Merged 3 PRs" hides which three, which is the
    // same class of omission as hiding a refusal.
    //
    // `retired` is the strongest case of the three, and it is listed EXPLICITLY rather than left to
    // the `default` arm so that it reads as a decision. Its distinguishing detail is not an id but
    // the REASON, and unlike every other kind here the founder was not present for the act: nobody
    // watched it happen and nobody will remember asking for it, so the line is the only account of
    // why an agent is gone. "Retired 6 agents." is precisely the sentence that would make an
    // unattended verb unauditable — it hides the six judgements the reason field exists to expose.
    //
    // SCOPED TO SUCCESSES, and that scoping is load-bearing rather than pedantic (roborev 63364).
    // This function is only reached for `ok === true` — the refusal arm returns above it — so a
    // REFUSED merge does fold, on `kind + gist`, and after roborev 63295 it is the commonest fold
    // there is. Read as a flat "never", this comment is a live trap in a file whose block comments
    // are explicitly the spec the next agent pins tests against. The `retired` reasoning above is
    // unaffected: a retirement that was REFUSED never happened, so there is no judgement to hide.
    //
    // THE IDENTIFIER CAVEAT SURVIVES THE CARVE-OUT, and is the known cost: `ConciergeReceiptMark`
    // carries no `prNumber`/`beadId`, so three refusals against three different PRs collapse into
    // one "Didn't merge, 3 times" whose expansion shows three identical sentences. That is tolerable
    // only because the individual refusal line carries no PR number either — the fold loses nothing
    // the rows had. Carrying the identifier into the mark is the fix if that ever stops being true.
    case "filed":
    case "merged":
    case "retired":
      return null;
    default:
      return null;
  }
}

/** A receipt-marked sparkle message — the members of a run are always these. */
export type ReceiptMessage = ConciergeSparkleMessage & {
  actionReceipt: ConciergeReceiptMark;
};

/** One folded run: the messages it stands for, and nothing else. There is no `count` field on
 *  purpose — see this file's header. The count is `members.length`, always. */
export interface ReceiptRun {
  readonly type: "receipt-run";
  /** The first member's id. Stable across re-renders for the same run, and unique in the thread
   *  because message ids are. */
  readonly id: string;
  readonly key: string;
  readonly members: readonly ReceiptMessage[];
}

/** A thread row: either one ordinary message, or a folded run of receipts. */
export type ThreadRow =
  | { readonly type: "message"; readonly message: ConciergeMessage }
  | ReceiptRun;

/** This message is a foldable receipt, and what it folds under — `null` for everything else,
 *  including every non-receipt message and every receipt that must stand alone. */
function keyOf(m: ConciergeMessage): string | null {
  if (m.kind !== "sparkle") return null;
  return foldKeyOf(m.actionReceipt);
}

/**
 * Fold every maximal run of CONSECUTIVE same-key receipts into one row.
 *
 * CONSECUTIVE, not gathered. A message between two receipts breaks the run, and that is deliberate:
 * the thread is a record of what happened in what order, and hoisting receipts out of their place to
 * join a distant twin would rewrite that order. It also means a refusal sitting in the middle of a
 * burst splits it into two folded runs with the refusal standing between them — which is precisely
 * the shape the reader needs, since the refusal is the part he has to look at.
 */
export function foldReceiptRuns(
  messages: readonly ConciergeMessage[],
): ThreadRow[] {
  const rows: ThreadRow[] = [];
  let i = 0;
  while (i < messages.length) {
    const head = messages[i];
    if (head === undefined) break;
    const key = keyOf(head);
    if (key === null) {
      rows.push({ type: "message", message: head });
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < messages.length) {
      const next = messages[j];
      if (next === undefined || keyOf(next) !== key) break;
      j += 1;
    }
    const run = messages.slice(i, j) as ReceiptMessage[];
    const first = run[0];
    if (run.length >= MIN_RUN && first !== undefined) {
      rows.push({ type: "receipt-run", id: first.id, key, members: run });
    } else {
      // A run below the threshold is emitted as the plain rows it always was — NOT dropped, and not
      // wrapped in a group of one.
      for (const m of run) rows.push({ type: "message", message: m });
    }
    i = j;
  }
  return rows;
}

/**
 * The words a member with no showable name renders as — RE-EXPORTED from `conciergeLine`, which
 * owns them (roborev 63525).
 *
 * Exported so the residue guards assert the SYMBOL, not the string (roborev 63515): every one was
 * `not.toContain("that agent")`, and a copy edit — this repo treats copy as code — would have made
 * the count-shaped arms render the new wording while all ten assertions stayed green, since they
 * were asserting the absence of a word the code no longer emitted.
 *
 * DEFINED ELSEWHERE, though, because owning it here only moved the drift one module over: the words
 * an INDIVIDUAL row uses come from `actionReceiptLine.who()`, and a fold that says something else is
 * the very invariant this module exists to hold.
 */
export { ANONYMOUS_SUBJECT } from "./conciergeLine";

/**
 * The NAME this member will actually be shown as, or `null` when it renders as
 * {@link ANONYMOUS_SUBJECT}.
 *
 * THE SINGLE DERIVATION of "does this render as a real name?" — and it exists because re-deriving
 * that rule is how this defect recurred four rounds running (63364 → 63476 → 63482 → 63506), each
 * time as a predicate that no longer matched what the slot drew. {@link subjectSlot} and
 * {@link namedMembers} both read THIS, so they cannot answer differently.
 */
function renderedName(mark: ConciergeReceiptMark): string | null {
  const name = mark.subjectName?.trim() ?? "";
  return name === "" ? null : name;
}

/** The subject slot for one member: a pill when the receipt resolved to an openable agent at post
 *  time, the words the line itself used otherwise. Deliberately reads the SAME two fields the
 *  individual line rendered from, so a folded row can never name an agent the row it replaced did
 *  not — and never invents a reference. */
function subjectSlot(mark: ConciergeReceiptMark) {
  const name = renderedName(mark);
  if (name === null) return plain(ANONYMOUS_SUBJECT);
  if (mark.subjectId) return ref({ id: mark.subjectId, name });
  return plain(name);
}

/**
 * WHO a receipt is about, as an identity that can be compared — or `null` for a member whose subject
 * cannot be identified at all.
 *
 * ONE definition, because the COUNT and the PILLS must not be able to disagree (roborev 59145). The
 * sentence said "1 agent" from `distinctSubjects` while the pill residue iterated MEMBERS, so a run
 * of sixteen sends to one pinned agent read "Sent 16 messages to 1 agent's terminal." and then drew
 * sixteen identical `@Alpha` chips — a reader counting chips gets a number the sentence contradicts,
 * and the identical-chip wall is the exact thing this fold exists to remove. Two derivations of "who"
 * is how that happened; there is now one.
 *
 * `null` is NOT an identity: an unidentifiable member cannot be proven to be a repeat of anything, so
 * each one counts and renders separately rather than merging into a single anonymous chip.
 */
function subjectKey(mark: ConciergeReceiptMark): string | null {
  const id = mark.subjectId?.trim();
  if (id !== undefined && id !== "") return `id:${id}`;
  const name = mark.subjectName?.trim();
  if (name !== undefined && name !== "") return `name:${name}`;
  return null;
}

/**
 * The members that would render as a REAL NAME rather than as the words "that agent".
 *
 * KEYED ON WHAT WILL ACTUALLY RENDER, NOT ON `subjectKey` (roborev 63506), AND DERIVED FROM THE ONE
 * FUNCTION THAT DECIDES IT rather than restating its rule (roborev 63515). `subjectKey` is non-null
 * as soon as `subjectId` is a non-empty string, while a chip only reads as a real name when
 * {@link renderedName} returns one. So a member with an id and an empty name passed the old
 * predicate and rendered precisely the invented chip this filter exists to drop — and because
 * `subjectList` dedupes by `subjectKey`, two such members with different ids produced
 * `that agent, that agent` all over again.
 *
 * That shape is reachable from production, not hypothetical: `receiptMark` writes
 * `subjectId: found.id` alongside `subjectName: found.name`, so any resolved agent whose feed name
 * is empty yields `{subjectId: "…", subjectName: ""}`.
 *
 * The name test covers both renderable cases — pill (id + name) and plain name (name, no id) — and
 * excludes only the fallback. A named function rather than an inline `.filter(…)` so the caller's
 * decision lands on a line a mutation check can judge (`sparkle-2gd7b`).
 */
function namedMembers(
  members: readonly ReceiptMessage[],
): readonly ReceiptMessage[] {
  const out: ReceiptMessage[] = [];
  for (const m of members) {
    // THROUGH `renderedName`, never a second copy of its rule — see that function.
    if (m.actionReceipt && renderedName(m.actionReceipt) !== null) out.push(m);
  }
  return out;
}

/** How many DISTINCT agents a run touched. Two sends to one agent are two sends and one agent, and
 *  the sentence has to be able to tell the reader which number is which. */
function distinctSubjects(members: readonly ReceiptMessage[]): number {
  const seen = new Set<string>();
  let anonymous = 0;
  for (const m of members) {
    const k = subjectKey(m.actionReceipt);
    if (k === null) anonymous += 1;
    else seen.add(k);
  }
  return seen.size + anonymous;
}

/** `a, b, c` as one Line of pills — the navigation the fold must not cost. The founder uses these
 *  pills to reach an agent, so they stay real `[@Name](sparkle-agent:<id>)` references rendered by
 *  `<Markdown>` into `<AgentPill>`, exactly as the unfolded rows did.
 *
 *  ONE CHIP PER AGENT, keyed by {@link subjectKey} — the same rule the count uses, so the number of
 *  pills IS the number the sentence states. First occurrence wins, which keeps the pills in the order
 *  the run happened. */
function subjectList(members: readonly ReceiptMessage[]): Line {
  const seen = new Set<string>();
  let md = "";
  let spoken = "";
  for (const m of members) {
    const k = subjectKey(m.actionReceipt);
    // `null` (unidentifiable) is never deduped — see subjectKey.
    if (k !== null) {
      if (seen.has(k)) continue;
      seen.add(k);
    }
    const sep = md === "" ? "" : ", ";
    const l = line`${subjectSlot(m.actionReceipt)}`;
    md += sep + l.md;
    spoken += sep + l.spoken;
  }
  return { md, spoken };
}

/**
 * The pill list, attached to the sentence — and the ONE place the two renderings deliberately
 * differ, for the reason `conciergeLine` exists.
 *
 * `md` puts the pills in their own PARAGRAPH, so sixteen chips wrap under the sentence instead of
 * running on past the end of it; the column is ~380px wide and a sentence with sixteen names
 * appended is the wall again in one row.
 *
 * `spoken` keeps them in the SAME sentence, because a live region has no paragraphs — it gets one
 * flat utterance, and a blank line in it is silence a listener cannot interpret.
 */
function withSubjects(
  sentence: Line,
  members: readonly ReceiptMessage[],
): Line {
  const pills = subjectList(members);
  return {
    md: `${sentence.md}\n\n${pills.md}`,
    spoken: `${sentence.spoken} — ${pills.spoken}`,
  };
}

/**
 * The SENTENCE a folded run reads as — the count, and who it stands for.
 *
 * Re-derived from the members every time, never from the key alone. That is the same guard
 * `digestText` applies by switching on the agent's STATUS rather than trusting the variant it was
 * called with: a mis-bucketed run must not be able to acquire a confident wrong label.
 */
export function receiptRunLine(run: ReceiptRun): Line {
  const total = run.members.length;
  const agents = distinctSubjects(run.members);
  const n = plain(String(total));
  // `agents` CAN BE 1 IN EVERY REPEATS BRANCH, which is why these are helpers and not `String(a)`
  // spliced in front of a hard-coded "agents". A run is at least {@link MIN_RUN} long, but two
  // consecutive sends to the same pinned agent — or two goals set on one — is an ordinary shape, and
  // it makes `repeats` true with ONE distinct subject. Splicing produced "Sent 2 messages to 1
  // agents' terminals.", in the module whose entire claim is that the folded sentence is true.
  const many = agents !== 1;
  /** `1 agent` / `3 agents`. */
  const who = plain(`${agents} agent${many ? "s" : ""}`);
  /** `1 agent's` / `3 agents'` — the possessive, where the apostrophe MOVES rather than doubling. */
  const whose = plain(`${agents} agent${many ? "s'" : "'s"}`);
  /** A noun each of them owns one of, agreeing with them: `terminal` / `terminals`. */
  const theirs = (word: string) => plain(many ? `${word}s` : word);
  const repeats = total > agents;

  // ══ A FOLDED RUN OF INTERNAL-GATE REFUSALS (roborev 63295) ══════════════════════════════════
  //
  // Handled before the switch because its key carries DATA — the gist — rather than being one of a
  // closed set. The sentence keeps the individual row's verb, so the fold reads as the same fact
  // said once: "Didn't merge — waiting on checks" becomes "Didn't merge, 6 times — waiting on
  // checks". It never claims the action happened, and it never drops the reason.
  //
  // The gist comes off a MEMBER, not off the key, so nothing has to parse a delimiter back out of a
  // string that contains free text. Every member of a run shares the key by construction, so any
  // member's gist is the run's.
  //
  // ══ …AND A FOLDED RUN OF FOUNDER REFUSALS TAKES THE SAME SENTENCES (roborev 63727) ════════════
  //
  // ONE ARM FOR BOTH, deliberately, because the only difference between them is which WORDS go in
  // the tail — a withheld reason's gist, or a kept reason verbatim. The verbs, the count, the
  // residue rules and the never-claims-it-happened property are identical, and giving the founder
  // half its own copy of this switch is how the two would drift into saying different things about
  // the same refusal. `foldKeyOf` has already decided which population this is; here it is one
  // lookup that finds whichever field is set.
  if (run.key.startsWith("refusal:") || run.key.startsWith("verbatim:")) {
    // WHICHEVER FIELD THE MARK CARRIES — exactly one of the two is set (see ConciergeReceiptMark),
    // so this cannot silently prefer a stale gist over a live reason or vice versa. Read off a
    // MEMBER rather than parsed back out of the key, so nothing has to split a string containing
    // free text.
    const gist =
      run.members.find((m) => m.actionReceipt?.gist)?.actionReceipt?.gist ??
      run.members.find((m) => m.actionReceipt?.reason)?.actionReceipt?.reason ??
      "";
    const kind = run.members[0]?.actionReceipt?.kind;
    /**
     * DOES ANY MEMBER NAME SOMEONE? (roborev 63364, Medium — shipped, fixed forward.)
     *
     * `withSubjects` unconditionally appends `subjectList(members)`, and `subjectSlot` falls back to
     * the words `"that agent"` for a member with no identifiable subject — deliberately, because an
     * anonymous member must still be COUNTED. But the `merged` and `filed` SENTENCES name nobody,
     * and their receipts usually carry no agent either (`merge_pr` gets a `prNumber`, not an
     * `agentId`) — while `land_agent_branch` also classifies to `merged` and DOES carry one, which
     * is why the rule below keys on the sentence's shape rather than on what resolved. So a run of
     * three gated merge refusals rendered:
     *
     *     Didn't merge, 3 times — waiting on checks — that agent, that agent, that agent
     *
     * naming three agents the rows it replaced never named — breaking this module's own invariant
     * ("a folded row can never name an agent the row it replaced did not") and rebuilding the
     * identical-chip wall roborev 59145 removed, inside the fold that exists to end walls.
     *
     * The tests could not see it because they asserted a PREFIX and a `toContain`, both of which
     * hold with the residue attached. They now assert the whole string.
     */
    /**
     * WHETHER THE SENTENCE HAS A SUBJECT SLOT AT ALL — set per arm below.
     *
     * DECIDED BY THE SENTENCE, NOT BY WHO HAPPENED TO RESOLVE (roborev 63476, Medium). The first
     * repair asked "did anyone resolve?" and suppressed the chips only when NOBODY did. That is
     * all-or-nothing, and one member is enough to break it: `land_agent_branch` also classifies to
     * `kind: "merged"` and DOES carry an `agentId`, so a run mixing one of those with two `merge_pr`
     * refusals on the same gist folds together — a single named member flips the guard and the
     * residue comes back for the other two:
     *
     *     Didn't merge, 3 times — waiting on checks — @Alpha, that agent, that agent
     *
     * The same invariant break, one member short of the case the tests covered.
     *
     * WHAT EACH SHAPE DOES — stated once here and applied at the return below; do not restate it a
     * third time. The WHO-SHAPED arms (`spawned`, `closed`, `goal`) say "N agents" from
     * `distinctSubjects`, so their chips and their count come from the same members and the list
     * goes out WHOLE — filtering there would contradict the count, which is the failure roborev
     * 59145 fixed. The COUNT-SHAPED arms (`merged`, `filed`, `sent`, default) say "N times" from
     * `total`, so their residue is FILTERED to the members that actually named someone: real pills
     * survive (a `sent` fan-out's rows did name their agents) and only invented chips are dropped.
     *
     * This paragraph said "suppressed unconditionally" for one commit, which was wrong for `sent`
     * and is corrected here rather than left to disagree with the code — the stale-spec trap this
     * module keeps setting for itself (roborev 63476, then 63506).
     */
    let subjectShaped = false;
    const tail = gist ? plain(` — ${gist}`) : plain("");
    const times = plain(`${total} times`);
    let sentence: Line;
    switch (kind) {
      case "merged":
        sentence = line`Didn't merge, ${times}${tail}`;
        break;
      case "spawned":
        // WHO-SHAPED: the sentence counts agents, so its chips must come from the same members.
        sentence = line`Couldn't spawn ${who}${tail}`;
        subjectShaped = true;
        break;
      case "sent":
        sentence = line`Not sent, ${times}${tail}`;
        break;
      case "closed":
        sentence = line`Couldn't close ${who}${tail}`;
        subjectShaped = true;
        break;
      case "goal":
        sentence = line`Couldn't set a goal on ${who}${tail}`;
        subjectShaped = true;
        break;
      // RETIRED — ADDED WITH THE VERBATIM DOOR, WHICH IS WHAT MADE IT REACHABLE (roborev 63747,
      // Medium). No `INTERNAL_GATES` entry matches a retirement refusal, so while a refusal needed a
      // gist to fold this arm could never run and its absence cost nothing. A gist-less refusal now
      // folds, and `retire_agent` is a per-agent op the concierge issues in BATCHES on its own
      // initiative — so two refused retirements sharing a reason went straight to the `default` arm
      // and rendered "2 actions didn't go through", dropping the verb both rows carried.
      //
      // That is the worst kind to drop it on. `foldKeyOf`'s success side singles `retired` out
      // precisely because the founder was not present for the act: nobody watched it happen and
      // nobody will remember asking for it, so the line is the only account of what was attempted.
      // A refused retirement did not happen — there is no judgement being hidden — but "2 actions"
      // still deletes WHICH action, in the one kind whose row is its only witness.
      //
      // WHO-SHAPED like `closed`, its nearest neighbour: the sentence counts agents, so its residue
      // goes out whole.
      case "retired":
        sentence = line`Couldn't retire ${who}${tail}`;
        subjectShaped = true;
        break;
      case "filed":
        sentence = line`Couldn't file, ${times}${tail}`;
        break;
      default:
        // Same rule as the switch's own default: state the bare truth rather than guess a verb.
        sentence = line`${n} actions didn't go through${tail}`;
        break;
    }
    // WHO-SHAPED: chips and count come from the same members, so the list goes out whole.
    if (subjectShaped) return withSubjects(sentence, run.members);
    // COUNT-SHAPED: FILTER, DO NOT SUPPRESS (roborev 63482, Medium — a regression this fixes).
    //
    // Blanket suppression was wrong for `sent`. Unlike `merged`/`filed`, a `sent` refusal mark DOES
    // carry a real subject — `subjectOf` reads `agentId`/`agentName` off the args for every
    // non-`spawned` kind — and a per-recipient fan-out refusing on one shared gist folds under
    // `refusal:sent:<gist>`, which is exactly the shape this fold was built for. Suppressing there
    // rendered `Not sent, 3 times — no free agent slot right now` and threw away three genuine
    // `@Alpha, @Beta, @Gamma` pills the unfolded rows had shown: it loses WHICH agents never got the
    // message, and costs the navigation `subjectList` exists to preserve. The invariant is "never
    // name an agent the row it replaced did NOT" — and those rows did name them.
    //
    // Filtering is safe on these arms precisely because their sentence counts `total` ("3 times"),
    // never `distinctSubjects`. The roborev 59145 objection — a filtered list contradicting its own
    // count — applies only to the who-shaped arms above, where the count IS subject-derived.
    const named = namedMembers(run.members);
    return named.length > 0 ? withSubjects(sentence, named) : sentence;
  }

  switch (run.key) {
    case "sent:terminal":
      return withSubjects(
        repeats
          ? line`Sent ${n} messages to ${whose} ${theirs("terminal")}.`
          : line`Sent to ${whose} ${theirs("terminal")}.`,
        run.members,
      );
    // THE CONCIERGE'S OWN BRIEFS, folded — and still ATTRIBUTED (bead `sparkle-p9s5q`). The founder
    // was offered "show nothing at all" for these and rejected it: "He needs to keep seeing what I
    // send to his fleet. 'Nothing at all' would fix the misattribution by removing his visibility,
    // which is a worse trade." So the fold keeps the count and the pills exactly as the relay arm
    // above does; only the author changes, and it is now stated instead of left to be inferred.
    //
    // NO POSSESSIVE `terminal` NOUN HERE, unlike the arm above. That phrasing exists to say WHERE a
    // message landed, which is the interesting fact when it was the founder's message; for the
    // concierge's own traffic the interesting fact is WHO wrote it, and stacking both makes a
    // sentence nobody scans.
    case "sent:terminal:concierge":
      return withSubjects(
        repeats
          ? line`Concierge wrote ${n} messages to ${who}.`
          : line`Concierge wrote to ${who}.`,
        run.members,
      );
    case "sent:inbox":
      // RULE 2 of actionReceiptLine survives the fold: an inbox message is invisible until the
      // agent's next turn, and the folded line states that delay for the same reason the single one
      // does — it is the whole difference between this channel and the terminal.
      return withSubjects(
        repeats
          ? line`Left ${n} messages for ${who} — each delivers at that agent's next turn.`
          : line`Left a message for ${who} — it delivers at each one's next turn.`,
        run.members,
      );
    case "sent:held":
      // HELD IS NOT DELIVERED, and the fold must not upgrade it. These are queued against a PTY that
      // is not up yet and can still expire.
      return withSubjects(
        repeats
          ? line`Holding ${n} messages for ${who} — each goes in when that terminal is ready.`
          : line`Holding a message for ${who} — each goes in when its terminal is ready.`,
        run.members,
      );
    case "sent:picker":
      return withSubjects(
        repeats
          ? line`Answered ${n} prompts across ${who}.`
          : line`Answered ${whose} prompts.`,
        run.members,
      );
    case "spawned":
      return withSubjects(
        repeats ? line`Spawned ${who}, in ${n} calls.` : line`Spawned ${who}.`,
        run.members,
      );
    case "closed":
      return withSubjects(
        repeats ? line`Closed ${who}, in ${n} calls.` : line`Closed ${who}.`,
        run.members,
      );
    case "goal":
      return withSubjects(
        repeats ? line`Set ${n} goals on ${who}.` : line`Set goals on ${who}.`,
        run.members,
      );
    default:
      // A key with no sentence must not fold at all — `foldKeyOf` is the only producer of keys and
      // every key it returns has an arm above. Reaching here means the two drifted, and the safe
      // failure is the bare truth rather than a guess at what happened.
      return withSubjects(line`${n} actions.`, run.members);
  }
}
