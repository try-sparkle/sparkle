// THE ONE LIST OF `get_state` SCOPE NAMES, for the same reason `PEER_MESSAGE_MAX_CHARS` lives here.
//
// Three surfaces name these strings and they are not in the same package:
//   1. `apps/mcp-control` DEFINES what the tool accepts (a `z.enum`) — a scope missing here is a zod
//      validation failure before the call ever reaches the bridge.
//   2. `apps/mcp-control` DESCRIBES them to the fleet, in tool descriptions.
//   3. `apps/desktop` IMPLEMENTS them, and names them in refusal strings that tell an agent which
//      call to make next.
//
// THE DRIFT IS SILENT AND IT HAS ALREADY HAPPENED TWICE (roborev 66018, 66025, 66032). The desktop
// grew a `"fleet"` scope; the MCP enum still listed four values. Both halves compiled, every suite
// was green, and the only symptom was an agent being told to run a call the schema rejects. That
// matters more than an ordinary stale pointer here, because `resolveSpecialAddressee` matches the
// two app-owned agents by literal id and NOT by display name — so the fleet directory is the only
// documented way to learn what to put in `send_peer_message`'s `to`.
//
// A REFUSAL STRING IS AN INSTRUCTION THE MODEL FOLLOWS, so naming an uncallable scope in one costs a
// real channel rather than merely reading badly. Import from here; do not re-type the list.

/** Every scope `get_state` accepts. The `z.enum` and the `StateScope` type are both built from it,
 *  so a new scope cannot reach a description without also reaching the schema. */
export const STATE_SCOPES = ["self", "active", "all", "project", "fleet"] as const;

export type StateScope = (typeof STATE_SCOPES)[number];

/** Is `scope` one a caller can actually pass? Used by the guards that scan user-facing copy for
 *  `scope: '<x>'` literals, so an uncallable name cannot be shipped in a description or a remedy. */
export function isStateScope(scope: string): scope is StateScope {
  return (STATE_SCOPES as readonly string[]).includes(scope);
}

/** Every uncallable scope named inside a `get_state({ scope: '<x>' })` literal in `text`.
 *
 *  ANCHORED TO `get_state`, and that anchor is load-bearing rather than tidiness. `scope:` is not a
 *  name this list owns — `search_history` has its own `scope` parameter whose legal values are
 *  `HISTORY_SCOPES`, and `sparkle_workspace`'s description contains `scope: "all"` for THAT
 *  parameter. A bare `scope:` scan judges it against the wrong enum, and passes today only because
 *  `WIDE_HISTORY_SCOPE` happens to equal `"all"`. Rename that constant to anything descriptive and
 *  an unanchored guard reds, blaming a `get_state` scope for a change that has nothing to do with
 *  it — while still giving no real signal about history scopes (roborev 66300).
 *
 *  Returns the offenders rather than a boolean so a failing guard can NAME them — a guard that only
 *  says "something is wrong" costs the next reader the search this function already did. */
export function uncallableStateScopesIn(text: string): string[] {
  return stateScopesNamedIn(text).filter((s) => !isStateScope(s));
}

/** Every scope NAMED in a `get_state({ scope: '<x>' })` literal, callable or not.
 *
 *  Exists so a guard can prove it actually READ something. `uncallableStateScopesIn` returning `[]`
 *  is ambiguous — it means "all callable" OR "matched nothing at all" — and the second is what
 *  happens when the copy is reworded past the anchor. A fail-closed assertion written against a
 *  looser pattern than the scanner uses cannot detect that: it stays green on a string the scanner
 *  no longer reads, so the guard goes inert exactly when the copy it guards is edited, which is its
 *  only hazard (roborev 66304).
 *
 *  CAPTURES `[^'"]+`, NOT `[a-z]+`. A scope named `all_projects`, `project-fleet` or `activeOnly`
 *  did not match the old class AT ALL, so the filter above returned `[]` and every guard reported an
 *  uncallable scope as callable. The only hazard here is a NEWLY NAMED scope — and a new name is
 *  precisely where an underscore or a capital letter gets introduced. */
export function stateScopesNamedIn(text: string): string[] {
  return [...text.matchAll(/get_state\(\{\s*scope:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
}

/** THE ONE STATEMENT OF THE `omitted` CONTRACT. Interpolated into `get_state`'s tool description, and
 *  referred to BY NAME from every comment that would otherwise paraphrase it.
 *
 *  WHY A CONSTANT (roborev 66361/66378/66384/66385). This contract reached NINE restatements across
 *  the tool description, its own tail sentence, `types.ts`, SKILL.md and two comments in
 *  `controlListener.ts`. Three of them asserted the absolute — "`omitted` is always the exact count"
 *  — which is FALSE for `'project'`, which hard-codes `omitted: 0` by design (a boundary that
 *  publishes its own size is not a boundary). One round of fixes even qualified the head of a
 *  description and left its tail asserting the opposite, so a single string contradicted itself.
 *
 *  `'fleet'` used to hard-code `0` for the same-looking reason, and that was the bug in
 *  `sparkle-u1p68f`: fleet is the app-GLOBAL address book, not a project boundary, so there is no
 *  size to protect — and reporting `omitted: 0` beside `concurrency.live: 45` told the orchestrator
 *  whose only roster this is that the fleet was empty while it was running.
 *
 *  THE FIRST FIX COUNTED THEM; THIS ONE LISTS THEM, and the contract moved with it. Reporting "45
 *  live agents I am not naming" stopped the reply contradicting itself, but it did not restore what
 *  the bead was actually blocked on: `omittedIds` carries ids, capped, with no names, so the
 *  concierge still could not resolve a name to an id — it could not render an agent pill, address
 *  `send_peer_message`, or unstick an agent that had hit its auto-continue ceiling. So `'fleet'` now
 *  RETURNS a row per LIVE-OR-ADDRESSABLE agent beside the app-global rows — anything with a live
 *  status, an open pane in ANY window, or that is the caller or the caller's own worker. What that
 *  owes a caller sizing a spawn is CONTAINMENT, NOT EQUALITY: every agent `concurrency.live` counts
 *  is a row here, so the directory can never list FEWER than that headcount; it may list more, which
 *  is correct rather than a discrepancy, because `concurrency.live` is a RAM-BUDGET reading that
 *  deliberately excludes cloud agents, shell agents and panes mounted in other windows. Reading the
 *  two as equal is what made this scope report those as dormant. `omitted` therefore counts what is genuinely left over — the
 *  DORMANT rows — and unlike the previous wording it CAN legitimately be 0, when every row this app
 *  knows of is live. That is why the sentence below no longer says "never 0 while agents are
 *  running": under the new behaviour that would be false, and a stale absolute in this contract is
 *  the exact failure this constant exists to prevent.
 *
 *  The fail-closed case is the one that costs something: an unresolvable caller under `'project'`
 *  gets `agents: []`, `totalAgents: 0`, `omitted: 0` — a REFUSAL, which the absolute wording invites
 *  a model to read as an affirmative "there are no agents".
 *
 *  Every prose fix to this so far has been followed by another copy turning up. So: state it once,
 *  interpolate it, and let the guard assert that no OTHER sentence claims exactness without the
 *  qualifier. */
export const OMITTED_CONTRACT =
  "omitted is the exact count of rows filtered out for 'self'/'active'/'all'/'fleet' — under 'fleet' " +
  "that is the DORMANT rows, because it lists every live agent, so 0 there means every agent this " +
  "app knows of is live rather than that nothing was checked; 'project' alone always reports " +
  "omitted: 0 BY DESIGN, so 0 there never means nothing was hidden, and an unresolvable caller " +
  "under 'project' gets an empty roster with omitted: 0 as a fail-closed REFUSAL rather than an " +
  "affirmative 'there are no agents'";

/** Phrasings that assert something about how COMPLETE `omitted` is.
 *
 *  HONEST ABOUT WHAT THIS IS (roborev 66407): an ENUMERATION, not a property test. A previous
 *  version of this comment claimed "property-based", which was false and is the kind of overclaim
 *  this branch keeps being caught by — the list simply got longer. Stems rather than whole words,
 *  because `\bexact\b` does not match `exactly` (the trailing letter defeats the boundary), and
 *  `never distorts` — the ACTUAL wording that sat in `controlListener.ts` before this work — was
 *  absent from the first list entirely.
 *
 *  WIDENING THIS LIST TRADES FALSE NEGATIVES FOR FALSE POSITIVES, and that is not hypothetical:
 *  adding the `exact\w*` stem immediately flagged a `controlListener` comment reading "the caller
 *  asked for exactly one agent" — prose about `omittedIds` SIZING that makes no claim about the
 *  count's completeness at all. It was reworded, but the lesson is the one this whole contract keeps
 *  teaching: an enumeration cannot be made correct by making it longer, only differently wrong.
 *
 *  A determined paraphrase can still evade this. That is why it is the BACKSTOP and not the
 *  protection: the protection is that `OMITTED_CONTRACT` exists once and every surface interpolates
 *  it or points at it by name, so there is no second statement to drift. This catches the careless
 *  case — someone restating the contract from memory — which is how all nine copies actually arose. */
const OMITTED_COUNT_CLAIM =
  /\b(exact\w*|never (capped|truncated|distort\w*|changed?)|not (capped|truncated|distort\w*)|unaffected|always report\w*|always the count|every dropped|remains the count|(true|real|total|full|complete|whole) count)\b/i;

/** Does this clause say WHICH scopes its claim is true of? Quote-style agnostic on purpose: the same
 *  contract is written with `'single'` quotes in tool descriptions and `"double"` inside backticks in
 *  SKILL.md, and a guard that only understood one of them would silently stop covering the other. */
function namesTheScopes(clause: string): boolean {
  return (
    /\bself\b/i.test(clause) &&
    /\bactive\b/i.test(clause) &&
    /\ball\b/i.test(clause) &&
    /\bproject\b/i.test(clause) &&
    /\bfleet\b/i.test(clause)
  );
}

/** Join wrapped comment lines back into prose before splitting into clauses.
 *
 *  WHY (roborev 66407): splitting on `\n` made the source-file guards depend on LINE WRAPPING rather
 *  than on prose. Every multi-line comment is fragmented per line, so a claim whose subject and
 *  claim-word land on different lines is invisible — `// The cap never changes \`omitted\`: it stays
 *  the` / `// exact count either way.` splits into one clause with `omitted` and no claim word and
 *  another with the claim word and no `omitted`, and passes. Strip comment leaders and rejoin, so a
 *  claim is judged as WRITTEN rather than as wrapped. */
function unwrapComments(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*(\/\/+|\*+)\s?/, ""))
    .join(" ");
}

/** Collapse runs of whitespace so the `OMITTED_CONTRACT` strip is whitespace-INSENSITIVE.
 *
 *  WHY (roborev 66417): `unwrapComments` removes one space after a comment leader, but this repo
 *  writes JSDoc continuations as a star + TWO spaces — so rejoining a wrapped JSDoc block yields a
 *  double space at every wrap point. The strip below is an exact string match, so a surface that
 *  followed the documented pattern and quoted the contract verbatim inside a JSDoc block would NOT
 *  be stripped — and the un-stripped contract contains a `;`, so the clause split would fragment it
 *  and report the ONE statement this helper exists to permit as an unqualified claim. `//` comments
 *  survive only because they happen to use a single space, which is why nothing red today. */
function collapseSpace(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** Every clause in `text` that makes a count claim about `omitted` WITHOUT saying which scopes it
 *  holds for. Empty means the text is consistent.
 *
 *  THE ONE RULE, APPLIED TO EVERY SURFACE. This contract reached nine restatements because each fix
 *  pinned the surface it had just edited and left the others to prose. The description, the SKILL.md
 *  row, `types.ts` and `controlListener.ts` now all run through this, so a paraphrase is caught
 *  wherever it lands rather than only where someone remembered to look.
 *
 *  `OMITTED_CONTRACT` itself is stripped first — it IS the qualified statement, and would otherwise
 *  be flagged for the count claim it correctly makes. Note the strip removes the contract's PROSE,
 *  not the identifier: **citing `OMITTED_CONTRACT` buys a clause no immunity whatsoever.** A pure
 *  pointer passes only because it makes no count claim, so `OMITTED_COUNT_CLAIM` never matches it —
 *  and a clause that names the constant AND asserts an absolute is flagged, which is pinned by test.
 *  An earlier version of this header promised an exemption that the code never implemented; that is
 *  the same "comment describes the opposite of the shipped behaviour" defect this helper exists to
 *  catch in the contract text, so it is called out rather than quietly deleted (roborev 66433). */
export function unqualifiedOmittedClaimsIn(text: string): string[] {
  return collapseSpace(unwrapComments(text))
    .split(collapseSpace(OMITTED_CONTRACT))
    .join(" ")
    .split(/(?<=[.;])/)
    .map((clause) => clause.trim())
    .filter(
      (clause) =>
        /\bomitted\b/i.test(clause) &&
        OMITTED_COUNT_CLAIM.test(clause) &&
        // NO POINTER EXEMPTION, deliberately (roborev 66417). A previous version carried one that
        // was DEAD CODE: a clause only reaches it after OMITTED_COUNT_CLAIM has already matched, and
        // no alternative in that pattern can occur inside the literal token `OMITTED_CONTRACT` — so
        // deleting that substring could never destroy the match, the condition was invariably true,
        // and the branch changed nothing. Worse, the commit that added it claimed a mutation proved
        // it, when that mutation is flagged with or without the branch. A clause that merely POINTS
        // at the constant makes no count claim, so the filter above already lets it through; an
        // exemption here would only ever have let a real claim buy immunity by citing the statement
        // it contradicts.
        !namesTheScopes(clause),
    );
}
