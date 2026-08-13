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
//   • a refusal the FOUNDER must read never folds, and no refusal ever counts toward a success
//     total. This bullet used to read "a refusal (`ok: false`) NEVER folds" flat, and that is no
//     longer the rule (roborev 63295): a refusal aimed at the CONCIERGE — a review gate, running
//     checks, no free agent slot — is one it read and routed around, so there is nothing owed and
//     nothing to act on, and those repeat by construction until N identical rows rebuild the very
//     wall this module exists to end. Those fold, keyed on `kind + gist`. The test is whether
//     `Concierge/refusalAudience` gave the reason a gist; a founder-actionable refusal has none;
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
 *   2. Can the cap hide one? NO, and not merely because actionable rows sort first (which the audit
 *      says is insufficient): an actionable receipt cannot ENTER a fold. THREE independent guards
 *      below enforce that, and all three are load-bearing — `ok !== true` (a refusal), `failed > 0`
 *      (a fan-out that reported ok while losing recipients), and `hasDetail` (a success whose line
 *      says more than its standard wording, e.g. a spawn that could not be briefed). Deleting any
 *      ONE of them breaks this property while the other two still look like they hold it.
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
  if (mark.ok !== true)
    return mark.gist ? `refusal:${mark.kind}:${mark.gist}` : null;
  // A PARTIAL FAN-OUT IS NOT A SUCCESS. `ok` is true on a broadcast some inboxes rejected; the
  // failures live in `failed`. Folding it would roll a reported failure into a success count — the
  // one outcome this module is forbidden to produce.
  if (typeof mark.failed === "number" && mark.failed > 0) return null;
  // AN ALREADY-PLURAL RECEIPT DOES NOT FOLD. A broadcast line already reads "Left a message for N
  // agents"; folding several of them would need a count of counts, and the folded sentence has no
  // honest way to say that. Rare enough not to be worth a wrong sentence.
  if (mark.fanout === true) return null;
  // A SUCCESS THAT SAYS MORE THAN "IT HAPPENED" DOES NOT FOLD EITHER, and this is the guard the
  // `ok` test does not cover. A spawn whose agent came up but could NOT be briefed reports
  // `ok: true` and carries the shortfall as a second sentence ("its terminal didn't start … its
  // opening brief hasn't gone in yet") — an agent sitting there doing nothing, which is the whole
  // of the founder's "every agent I spawn starts dead until I go type into it". Replacing that
  // sentence with "Spawned 5 agents." deletes it, which is the same failure as folding a refusal
  // wearing a success's clothes. See ConciergeReceiptMark.hasDetail.
  if (mark.hasDetail === true) return null;

  switch (mark.kind) {
    case "sent":
      // A PICKER PRESS IS NOT A MESSAGE, and it does not share a bucket with one — the individual
      // lines are already careful to say which happened ("Answered X's prompt." vs "Sent to X's
      // terminal."), and a fold that merged them would undo that distinction wholesale.
      if (mark.viaPicker === true) return "sent:picker";
      // The channel IS the bucket, because the channels are visible at different times: a terminal
      // write lands now, an inbox message waits for the agent's next turn, a held one waits for a
      // PTY that may never come up. "Sent to 16 agents" over a mixture would be true of none of
      // them.
      return `sent:${mark.channel ?? "terminal"}`;
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
  if (run.key.startsWith("refusal:")) {
    const gist =
      run.members.find((m) => m.actionReceipt?.gist)?.actionReceipt?.gist ?? "";
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
