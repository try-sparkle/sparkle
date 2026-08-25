// THE CLASSIFY STEP — is this ask a TASK or an EPIC at all? Bead `sparkle-o05vcs.2`.
//
// THE FOUNDER'S QUESTION: "how do the orchestrators decide how many workers to spin up... let's get
// this built ASAP". The step that was missing sits between him speaking and an agent starting: the
// concierge decided by feel, per turn, with no rule and no trace, so a wrong call was MYSTERIOUS
// rather than ARGUABLE.
//
// NOT AN ML CLASSIFIER — A WRITTEN RULE THE CONCIERGE FOLLOWS AND CAN CITE. His draft, verbatim:
// "if the ask has ONE verifiable finish line, it is a task; if it needs 3+ independently-
// completable pieces or spans more than one surface, it is an epic. Record WHICH rule fired on the
// bead, so a wrong call is arguable later instead of mysterious."
//
// SO EACH RULE CARRIES A STABLE ID AND ITS OWN SENTENCE. The id is what gets written on the bead
// and grepped for later; the sentence is what a human reads three weeks on. `classifyAsk` returns
// the verdict AND the id of the rule that fired, never a bare boolean — a bare boolean is exactly
// the mysterious call this replaces.
//
// THE SCORER IS DELIBERATELY DUMB, and that is the same ruling `epicCandidates.ts` records: this
// runs on the create path, in front of a human waiting for a bead to be filed, so there is NO paid
// model call here. A wrong call costs an argument the recorded rule id makes possible; a paid call
// costs seconds on every single create.
//
// THIS FILE IS PURE. It reads two strings and returns a verdict. It does not touch the store, does
// not create anything, and does not decide which EXISTING epic a task goes under — that is the
// separate EPIC DECISION gate in `services/conciergeTools/epicDecision.ts`, which answers a
// different question and must not be folded into this one.

/** The two answers. There is no third: "unsure" would be read as "task" by every caller anyway, and
 *  a hedge nobody can act on is worse than a call somebody can argue with. */
export type AskVerdict = "task" | "epic";

/** The ask as a caller has it — `create_item`'s own `title` and `body`, nothing more. */
export interface Ask {
  title: string;
  body?: string | null;
}

/** The ask after `classifyAsk` normalizes it — what every predicate below sees. Written out rather
 *  than `Required<Ask>`, which strips the `?` but KEEPS the `| null` and would hand every predicate
 *  a nullable string to re-check. */
export interface NormalizedAsk {
  title: string;
  body: string;
}

/** One rule in the set. `statement` is the human-readable sentence the concierge CITES; it is the
 *  rule, not a description of the rule, so the persona and the recorded comment cannot drift into
 *  two different rules with one id. */
export interface AskRule {
  id: string;
  verdict: AskVerdict;
  statement: string;
  /** Returns the EVIDENCE that fired it, or `null` for no match — an ARRAY, never a boolean,
   *  because "which rule fired" without "on what" is still a call nobody can argue with.
   *
   *  `null` and `[]` are different answers and the distinction is load-bearing: `[]` is a MATCH with
   *  nothing to point at, which is exactly the default rule ("one finish line") firing on the
   *  absence of everything else. `classifyAsk` tests for `null`, not for emptiness. */
  match: (ask: NormalizedAsk) => string[] | null;
}

/** The verdict, with everything needed to record and defend it. */
export interface AskClassification {
  verdict: AskVerdict;
  /** Stable id of the rule that fired — the thing written on the bead and grepped for later. */
  ruleId: string;
  /** That rule's sentence, carried alongside the id so a reader never has to look it up. */
  statement: string;
  /** What in the ask fired it. Empty only for the default rule, which fires on the absence of
   *  everything else. */
  evidence: string[];
}

/** How many independently-completable pieces make an ask an epic. The founder's number, held as a
 *  constant so the rule statement, the predicate and the tests cannot disagree about it. */
export const PIECE_THRESHOLD = 3;

/** How many distinct surfaces make an ask an epic. "More than one" — the founder's words. */
export const SURFACE_THRESHOLD = 2;

// ---------------------------------------------------------------------------------------------
// Counting PIECES
// ---------------------------------------------------------------------------------------------

/**
 * Enumerated pieces in the BODY: markdown bullets and numbered lines.
 *
 * Exported because the counting IS the rule's behaviour — a test that cannot see it can only assert
 * verdicts that happen to fall out, which is the vacuous shape AGENTS.md names as the #1 finding.
 */
export function listPieces(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split("\n")) {
    const m = /^\s*(?:[-*+•]|\d+[.)])\s+(.+?)\s*$/.exec(line);
    if (m && m[1]!.length >= 3) out.push(m[1]!);
  }
  return out;
}

/**
 * A written-out series in the TITLE — "wire the relay, add the retry, and log the failure".
 *
 * DELIBERATELY TITLE-ONLY. Applied to a body it counts ordinary prose commas as deliverables ("the
 * gate is adversarial in one direction, none is first-class, and the reason is recorded" is one
 * thought, not three pieces) and turns every long description into an epic. A three-way series in a
 * TITLE is an enumeration, because a title is terse by construction — so the narrow reading is the
 * one that is actually about pieces.
 */
export function seriesPieces(title: string): string[] {
  // Require a real series: at least two separators AND a coordinating word, so "Fix the retry, which
  // is flaky" cannot split into two pieces.
  const separators = (title.match(/[,;]/g) ?? []).length;
  if (separators < PIECE_THRESHOLD - 1) return [];
  if (!/\b(?:and|then|plus)\b/i.test(title)) return [];
  return title
    .split(/[,;]|\s+\band\b\s+|\s+\bthen\b\s+|\s+\bplus\b\s+/i)
    .map((s) => s.replace(/^\s*(?:and|then|plus)\b\s*/i, "").trim())
    .filter((s) => s.length >= 3);
}

// ---------------------------------------------------------------------------------------------
// Counting SURFACES
// ---------------------------------------------------------------------------------------------

/** The surfaces this codebase actually has, each with the terms that name it. Kept SHORT and
 *  high-signal on purpose: a greedy lexicon makes every ask multi-surface, which would convert the
 *  founder's rule into "everything is an epic" and teach the concierge nothing. */
const SURFACES: ReadonlyArray<{ id: string; label: string; terms: readonly RegExp[] }> = [
  {
    id: "desktop-ui",
    label: "desktop UI",
    terms: [/\breact\b/, /\bcomponent\b/, /\.tsx\b/, /\bsidebar\b/, /\bcolumn\b/, /\bmodal\b/, /\bdialog\b/],
  },
  {
    id: "rust-core",
    label: "Rust core",
    terms: [/\brust\b/, /\btauri\b/, /\bcargo\b/, /src-tauri/, /\.rs\b/],
  },
  {
    id: "mcp",
    label: "MCP control surface",
    terms: [/\bmcp\b/, /sparkle-control/, /\btool registry\b/],
  },
  {
    id: "mobile",
    label: "mobile app",
    terms: [/\bmobile\b/, /\bios\b/, /\bandroid\b/, /\bexpo\b/, /\breact native\b/],
  },
  {
    id: "web",
    label: "web app",
    terms: [/\bwebsite\b/, /\bnext\.js\b/, /\blanding page\b/, /apps\/web\b/],
  },
  {
    id: "ci",
    label: "CI / release",
    terms: [/\bci\b/, /github actions/, /\bworkflow file\b/, /\brelease pipeline\b/, /\bdmg\b/],
  },
  {
    id: "store",
    label: "work store",
    terms: [/\bbeads\b/, /\bdolt\b/, /\bmigration\b/, /\bschema\b/],
  },
  {
    id: "cli",
    label: "scripts / CLI",
    terms: [/\bshell script\b/, /scripts\//, /\bcli\b/],
  },
  {
    id: "docs",
    label: "docs",
    terms: [/\bdocumentation\b/, /\breadme\b/, /\bprd\b/],
  },
];

/** Distinct surface LABELS the ask names, in the order the lexicon declares them so the same ask
 *  always produces the same evidence line. Exported for the same reason as the piece counters. */
export function surfacesNamed(text: string): string[] {
  const haystack = text.toLowerCase();
  const found: string[] = [];
  for (const surface of SURFACES) {
    if (surface.terms.some((t) => t.test(haystack))) found.push(surface.label);
  }
  return found;
}

// ---------------------------------------------------------------------------------------------
// The rule set
// ---------------------------------------------------------------------------------------------

/**
 * THE RULES, IN PRECEDENCE ORDER. The first that matches is the one recorded, so the order is part
 * of the contract: the two epic rules are tried before the task default, and the piece rule is tried
 * before the surface rule because the founder stated it first ("3+ independently-completable pieces
 * OR spans more than one surface").
 *
 * The default is LAST and matches everything, so `classifyAsk` always names a rule — there is no
 * unclassified state to leave a bead mysterious.
 */
export const ASK_RULES: readonly AskRule[] = [
  {
    id: "epic-three-plus-pieces",
    verdict: "epic",
    statement:
      `An ask that names ${PIECE_THRESHOLD} or more independently-completable pieces is an epic — ` +
      "each piece is somebody's task, and one bead holding a list of them is a card nobody can finish.",
    match: (ask) => {
      const fromBody = listPieces(ask.body);
      const fromTitle = seriesPieces(ask.title);
      const pieces = fromBody.length >= fromTitle.length ? fromBody : fromTitle;
      return pieces.length >= PIECE_THRESHOLD ? pieces : null;
    },
  },
  {
    id: "epic-multiple-surfaces",
    verdict: "epic",
    statement:
      "An ask that spans more than one surface is an epic — the pieces land in different files with " +
      "different verification, so they are separately completable whether or not anyone listed them.",
    match: (ask) => {
      const surfaces = surfacesNamed(`${ask.title}\n${ask.body}`);
      return surfaces.length >= SURFACE_THRESHOLD ? surfaces : null;
    },
  },
  {
    id: "task-one-finish-line",
    verdict: "task",
    statement:
      "An ask with ONE verifiable finish line is a task — there is a single thing that is either " +
      "done or not, so one agent can carry it end to end.",
    match: () => [],
  },
];

/** Look a rule up by the id recorded on a bead, so a human reading `ASK CLASSIFICATION: …` three
 *  weeks later can recover the sentence that produced it. `null` for an id no longer in the set —
 *  an honest "this rule was retired", not a guess. */
export function askRuleById(id: string): AskRule | null {
  return ASK_RULES.find((r) => r.id === id) ?? null;
}

/**
 * Classify an ask. Pure, deterministic, and never returns without naming a rule.
 *
 * A blank title with a blank body still classifies — as a task, by the default rule — because
 * refusing here would put a second gate on the create path, and the create path already has one.
 */
export function classifyAsk(ask: Ask): AskClassification {
  const normalized: NormalizedAsk = {
    title: (ask.title ?? "").trim(),
    body: (ask.body ?? "").trim(),
  };
  for (const rule of ASK_RULES) {
    const evidence = rule.match(normalized);
    // `!== null`, not truthiness: `[]` is a MATCH with nothing to point at, and truthiness
    // happens to agree today only because an empty array is truthy in JS. Saying it out loud keeps
    // a later `.length` refactor from silently retiring the default rule.
    if (evidence !== null) {
      return { verdict: rule.verdict, ruleId: rule.id, statement: rule.statement, evidence };
    }
  }
  // Unreachable while the default rule is last and matches everything; kept so a future edit that
  // removes it fails LOUDLY here rather than returning undefined into the create path.
  throw new Error("askClassification: no rule matched — the default rule is missing from ASK_RULES");
}

// ---------------------------------------------------------------------------------------------
// Recording it
// ---------------------------------------------------------------------------------------------

/** The marker every recorded classification starts with, so ONE grep finds them all — in the store,
 *  in a later sweep, and in a human's `bd comments` read. Same argument as `EPIC_DECISION_MARKER`:
 *  changing it orphans every classification already written, so it is a constant rather than a
 *  literal at the call site. */
export const ASK_CLASSIFICATION_MARKER = "ASK CLASSIFICATION";

/**
 * The line recorded on the bead. THIS IS THE DURABLE HALF — "record WHICH rule fired on the bead,
 * so a wrong call is arguable later instead of mysterious" is the whole requirement, and a verdict
 * without the rule id satisfies none of it.
 *
 * It goes on as a COMMENT and never into the body: the body is the original ask and is not edited
 * (AGENTS.md), and a comment is also the only shape that survives a store many agents write at once.
 */
export function formatAskClassificationComment(c: AskClassification): string {
  const because = c.evidence.length > 0 ? ` Fired on: ${c.evidence.join("; ")}.` : "";
  return `${ASK_CLASSIFICATION_MARKER}: ${c.verdict} — rule \`${c.ruleId}\`: ${c.statement}${because}`;
}
