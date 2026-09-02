// The TYPESCRIPT side of the knightwatch probe merge gate: recognising the Rust refusal, shaping the
// override, and keeping the refusal READABLE where a human has to act on it.
//
// ── WHAT THIS FILE IS NOT ──────────────────────────────────────────────────────────────────────
// It is not the gate, and it does not parse probes. The gate lives in Rust's `worktree.rs::merge_pr`
// — the single sink every in-app merge path goes through — because a gate the UI owns is a gate the
// concierge can route around. The probe PARSER (which comment is a knightwatch review, which probes
// are `[blocking]`, which are answered) lives there too, and is pinned by the shared corpus at
// `scripts/tests/fixtures/knightwatch/` + `expected.json`. Nothing here re-derives any of it; a
// second parser in a second language is exactly the drift `expected.json` exists to prevent.
//
// ── WHY THE GATE EXISTS ────────────────────────────────────────────────────────────────────────
// Over the last 40 merged PRs, 39 carried a knightwatch review and 24 carried at least one
// `[blocking]` probe (40 probes in total). ALL 24 merged with zero probe-citing reply. The default
// branch IS protected — by an active ruleset requiring the CI status contexts (the legacy
// `branches/main/protection` endpoint still 404s) — but no status check can express "the `[blocking]`
// probe was answered", so that gate is never available server-side. Sparkle owns the merge action,
// so the gate lives there.
//
// ── THE ONE RULE THIS FILE IS WRITTEN AROUND ───────────────────────────────────────────────────
// A refusal the founder cannot act on is just an obstacle. The Rust message names each probe, its
// specialist, a link to the comment, and quotes the probe's first line — several LINES of it. So the
// two things this module protects are (a) that a message we do not recognise degrades to the
// ORDINARY error path (never to a merge, never to an override affordance) and (b) that the message
// reaches the reader with its lines and its links intact rather than flattened into one string.

/**
 * Does `message` look like the knightwatch probe refusal, as opposed to any other reason a merge
 * failed (a conflict, a red required check, lost auth, a missing `gh`)?
 *
 * DELIBERATELY FORGIVING, AND FAIL-CLOSED IN THE DIRECTION THAT MATTERS. The refusal is prose
 * written on the Rust side of a frozen command signature, so matching it exactly would couple this
 * file to wording nobody promised to keep. It matches on the two things the message cannot be
 * without — the reviewer's name and the word for what it is refusing over.
 *
 * A FALSE NEGATIVE COSTS THE OVERRIDE AFFORDANCE; A FALSE POSITIVE COSTS NOTHING. If this returns
 * false for a real probe refusal, the caller shows the message as an ordinary merge error and the
 * PR stays unmerged — the gate still held. If it returns true for some unrelated error, the caller
 * offers an override input whose reason Rust will simply ignore for a merge it refuses for a
 * different reason. Neither direction can merge anything the gate declined, which is why this is
 * allowed to be a heuristic at all.
 */
export function isKnightwatchRefusal(message: string): boolean {
  const m = (message || "").toLowerCase();
  if (!m.includes("knightwatch")) return false;
  // A REJECTED REASON IS NOT A PROBE REFUSAL — but the exclusion has to be ANCHORED, and the
  // unanchored form was worse than the bug it fixed. Rust's two `validate_override` errors OPEN
  // with "The knightwatch override reason …"; its two real refusals (`blocking_refusal`,
  // `unknown_refusal`) also CONTAIN that phrase, because both end by telling the reader how to
  // override. So a substring test excluded every refusal the gate actually emits: no row ever
  // entered `probeRefusals`, the per-row override affordance and the batch report were dead, and
  // the concierge path stopped classifying `knightwatch-unanswered` — the whole feature inert in
  // production while the suite stayed green, because the tests asserted against paraphrases that
  // omitted the "supply a … override reason" tail. Anchoring is what separates "this message IS a
  // rejected reason" from "this message MENTIONS how to write one".
  if (/^the knightwatch override reason\b/i.test((message || "").trim())) return false;
  return m.includes("probe") || m.includes("[blocking]");
}

/**
 * Whether `message` is Rust's cross-agent base-branch refusal (bead sparkle-hvenv2): a `merge_pr`
 * declined because the PR's base is a peer agent's in-flight branch, so merging would clobber it.
 *
 * Same heuristic discipline as {@link isKnightwatchRefusal}, and the same asymmetry: a false positive
 * costs nothing (the merge was refused either way), a false negative only lets the concierge report it
 * as `unknown-error` instead of a coded `foreign-base-branch`. The bead id is embedded in the refusal
 * text deliberately as a stable marker, paired with the phrase for what it refuses over so an
 * unrelated error that happens to name the bead cannot match.
 */
export function isBaseBranchRefusal(message: string): boolean {
  const m = (message || "").toLowerCase();
  // The bead id is embedded in the refusal deliberately as a stable marker; pairing it with the
  // "Refusing merge_pr" opener (present in BOTH the single-owner and contested-base variants — the
  // contested one says "a branch multiple agents are working", not "in-flight branch") means an
  // unrelated note that merely mentions the bead cannot match.
  return m.includes("sparkle-hvenv2") && m.includes("refusing merge_pr");
}

/**
 * The floor a written override has to clear before the UI will submit it, mirroring the Rust side's
 * own rule rather than replacing it.
 *
 * RUST IS THE AUTHORITY — it validates the reason before recording it on the PR, and it must, since
 * the concierge can call `merge_pr` without ever passing through this module. These constants exist
 * so the UI does not send something it already knows will bounce, which is the difference between
 * "the button is disabled and says why" and "two clicks, a round trip, and a rejection".
 *
 * FIFTEEN CHARACTERS AND A SPACE is not an arbitrary pair. The point of a written override is that
 * it COSTS A SENTENCE: one word ("ok", "fine", "yes") is the shape of a waiver nobody thought about,
 * and it is the shape a model reaches for first. Requiring whitespace is what makes "approved" fail
 * and "the probe is about a file this PR does not touch" pass.
 */
export const KNIGHTWATCH_MIN_REASON_CHARS = 15;

/** Why a written override is not acceptable yet, or null when it is. Null is the ONLY value that
 *  should enable a submit — a caller that treats an unrecognised issue as fine has inverted it. */
export type KnightwatchReasonIssue = "empty" | "too-short" | "not-a-sentence";

/**
 * Judge an override reason the way the UI's submit button should. Pure, so the rule is tested
 * without a component and shared by every surface that offers the override.
 *
 * Returns null when the reason will do. See {@link KNIGHTWATCH_MIN_REASON_CHARS} for the why.
 */
export function knightwatchReasonIssue(reason: string): KnightwatchReasonIssue | null {
  const t = (reason || "").trim();
  if (t === "") return "empty";
  // COUNT THE UNIT RUST COUNTS. `t.length` is UTF-16 code units; Rust's `validate_override` uses
  // `chars().count()`, i.e. Unicode scalars. Every astral character (emoji, CJK extension B) is TWO
  // code units and ONE scalar, so eight of them plus a space reads as 17 here and 9 there — the
  // reason passes this gate, is sent, and bounces off Rust — a round trip that refuses a merge for
  // a reason the UI told the user was fine. `isKnightwatchRefusal` now excludes those errors by
  // their anchored opening, so the rejection at least no longer masquerades as a probe refusal; it
  // surfaces as an ordinary merge error instead, which is honest but still a wasted attempt the
  // caller could not have predicted. Spreading the string counts scalars, so the two agree and the
  // attempt never happens.
  if ([...t].length < KNIGHTWATCH_MIN_REASON_CHARS) return "too-short";
  // A single unbroken token that is merely LONG is not a sentence: "approvedapprovedapp" clears the
  // length floor and says nothing. Whitespace is the cheapest available proxy for "someone wrote a
  // clause", and it is the one Rust applies too.
  if (!/\s/.test(t)) return "not-a-sentence";
  return null;
}

/** A written override, bound to the ONE pull request it was written about. The number is the whole
 *  type: a bare reason string is a waiver with no addressee, and a waiver with no addressee is what
 *  a batch merge spends on everything it touches. */
export interface KnightwatchOverrideFor {
  number: number;
  reason: string;
}

/**
 * The reason to send with PR `number`'s merge — the override's own words if it was written for THIS
 * pull request, and `undefined` for every other one.
 *
 * THE FUNCTION EXISTS SO THE BINDING IS TESTABLE. "Merge all ready" walks N pull requests in one
 * loop, and the damaging version of this feature is one line long: pass the reason the user typed to
 * whichever PR the loop is on. That turns a per-PR judgement into a blanket waiver of every probe in
 * the batch — and the probes are per-PR by construction, since each is a reviewer's question about
 * one diff. Written inline it is a condition nobody can assert against without a UI path that merges
 * a batch WITH an override; written here it is three unit tests.
 *
 * Deliberately total and boring: no "if there is only one PR it must be for that one" shortcut. The
 * override says who it is for, and anything it does not name gets nothing.
 */
export function knightwatchReasonFor(
  number: number,
  override?: KnightwatchOverrideFor,
): string | undefined {
  return override && override.number === number ? override.reason : undefined;
}

/** One line of a refusal message. `text` is a run of plain characters; `link` is a URL the reader
 *  should be able to OPEN — the refusal names a comment on GitHub, and a URL that is only selectable
 *  text asks the reader to retype it. */
export type RefusalSegment =
  | { kind: "text"; text: string }
  | { kind: "link"; text: string; url: string };

// Deliberately conservative: stops at whitespace and at the bracket characters that fence a URL in
// prose, then trims trailing punctuation so "…/pull/1176#issuecomment-5182769304." does not carry
// the sentence's full stop into the href.
const URL_RE = /https?:\/\/[^\s<>()[\]]+/g;
const TRAILING_PUNCT = /[.,;:!?'")\]]+$/;

/**
 * Split a refusal into LINES of segments — the shape a renderer needs to keep the message readable.
 *
 * Why this is a function and not a `split("\n")` at the call site: the two things that make this
 * message worth showing at all are its line structure (one probe per line, with its specialist) and
 * its links (straight to the comment carrying the question). Collapsing either turns the refusal
 * into a wall of text the reader skims past, which is functionally the same as not showing it.
 *
 * Empty lines are PRESERVED as an empty segment list, because the message uses blank lines to
 * separate the probe list from what to do about it.
 */
export function refusalLines(message: string): RefusalSegment[][] {
  return (message || "").split("\n").map((line) => {
    const out: RefusalSegment[] = [];
    let last = 0;
    // A fresh regex per line: URL_RE is /g and carries `lastIndex` between calls otherwise.
    const re = new RegExp(URL_RE.source, "g");
    let match: RegExpExecArray | null;
    while ((match = re.exec(line)) !== null) {
      const raw = match[0];
      const url = raw.replace(TRAILING_PUNCT, "");
      // A URL that is nothing but punctuation after trimming is not a link.
      if (!/^https?:\/\/\S/.test(url)) continue;
      if (match.index > last) out.push({ kind: "text", text: line.slice(last, match.index) });
      out.push({ kind: "link", text: url, url });
      last = match.index + url.length;
    }
    if (last < line.length) out.push({ kind: "text", text: line.slice(last) });
    return out;
  });
}
