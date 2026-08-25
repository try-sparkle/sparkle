// CANDIDATE EPICS — what the epic-decision refusal SHOWS, so the answer can be informed.
// Bead `sparkle-xelans.3`.
//
// A refusal that says "epicDecision is required" teaches nothing: the model has no cheap way to know
// which epics exist, so its next move is either a blind `none` or a `list_items` round-trip it will
// skip. The founder's shape puts the answer in the refusal — score the existing epics against the
// task being filed, and name the top few with their child counts.
//
// WHAT AN EPIC IS IS NOT RE-DERIVED HERE. `isEpic` / `childrenOf` in services/beads.ts are THE
// resolver (scripts/lib/epic-membership-guard.sh fails CI on a second definition), so this module
// only ranks what that resolver hands it.
//
// THE SCORER IS DELIBERATELY DUMB — token overlap, no model call. The bead is explicit that a
// per-task LLM review is NOT wanted: this runs on the create path, in front of a human waiting for
// a bead to be filed, and a wrong ranking costs a scroll while a paid call costs seconds every time.
import { childrenOf, isEpic, type Bead } from "../beads";

/** Words that overlap between ANY two work items and therefore carry no signal. Kept short on
 *  purpose: an aggressive list starts deleting the domain words ("agent", "bead", "board") that are
 *  exactly what distinguishes one epic from another here. */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "into", "onto", "when", "then", "than",
  "add", "adds", "added", "fix", "fixes", "fixed", "use", "uses", "using", "make", "makes",
  "not", "but", "are", "was", "were", "its", "our", "all", "any", "one", "two", "new", "old",
  "can", "cannot", "should", "must", "will", "would", "does", "did", "has", "have", "had",
  "task", "tasks", "issue", "issues", "bead", "beads", "epic", "epics", "work", "item", "items",
]);

/** Lowercase, split on anything that is not a letter or digit, drop stopwords and 1-2 char noise.
 *  Exported because the tokenization IS the scorer's behaviour and a test that cannot see it can
 *  only assert rankings that happen to fall out. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function tokenSet(parts: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const part of parts) for (const t of tokenize(part)) out.add(t);
  return out;
}

/** One ranked epic, with everything the refusal needs to be actionable in one line. */
export interface EpicCandidate {
  id: string;
  title: string;
  /** 0..1. Weighted Dice over token sets — see {@link candidateEpics}. */
  score: number;
  /** Direct children, and how many of those are still open. */
  totalChildren: number;
  openChildren: number;
  /** The shared terms that produced the score, so the model can see WHY this was offered. */
  overlap: string[];
}

/** What is being filed. `labels` is accepted even though `create_item` has no labels argument yet —
 *  the scorer is the shared piece, and a caller that does have them must not have to re-implement. */
export interface ProposedItem {
  title: string;
  body?: string;
  labels?: readonly string[];
}

/** How many candidates a refusal shows. Five: enough to be a real choice, few enough that the model
 *  reads them instead of pattern-matching the first. */
export const CANDIDATE_LIMIT = 5;

/**
 * Rank the project's OPEN epics against the item being filed.
 *
 * Score = weighted Dice: a term shared with the TITLE counts double a term shared only with the
 * body, over the combined token count. Title overlap is what actually indicates membership — a body
 * mentions half the codebase — but body-only overlap is real signal and dropping it entirely made a
 * task whose title is terse ("Wire it up") score zero against every epic.
 *
 * Deterministic: ties break on more children first (a real, populated epic beats an empty one), then
 * on id, so the same store always produces the same list.
 */
export function candidateEpics(
  beads: readonly Bead[],
  proposed: ProposedItem,
  limit: number = CANDIDATE_LIMIT,
): EpicCandidate[] {
  const titleTokens = tokenSet([proposed.title, ...(proposed.labels ?? [])]);
  const bodyTokens = tokenSet([proposed.body ?? ""]);
  for (const t of titleTokens) bodyTokens.delete(t);
  if (titleTokens.size === 0 && bodyTokens.size === 0) return [];

  const scored: EpicCandidate[] = [];
  for (const bead of beads) {
    // A closed epic is not somewhere to file new work. Checked before `isEpic` because it is the
    // cheaper test and the store is mostly closed rows.
    if (bead.status === "closed") continue;
    if (!isEpic(beads, bead)) continue;

    const epicTokens = tokenSet([bead.title, ...bead.labels]);
    if (epicTokens.size === 0) continue;

    const strong: string[] = [];
    const weak: string[] = [];
    for (const t of epicTokens) {
      if (titleTokens.has(t)) strong.push(t);
      else if (bodyTokens.has(t)) weak.push(t);
    }
    if (strong.length === 0 && weak.length === 0) continue;

    const denominator = titleTokens.size + bodyTokens.size + epicTokens.size;
    const score = (2 * (2 * strong.length + weak.length)) / denominator;

    const kids = childrenOf(beads, bead.id);
    scored.push({
      id: bead.id,
      title: bead.title,
      score: Math.min(1, Math.round(score * 1000) / 1000),
      totalChildren: kids.length,
      openChildren: kids.filter((k) => k.status !== "closed").length,
      overlap: [...strong, ...weak].sort(),
    });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score || b.totalChildren - a.totalChildren || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return scored.slice(0, Math.max(0, limit));
}

/** The candidate list as one line per epic, for a refusal message a model reads as prose. */
export function describeCandidates(candidates: readonly EpicCandidate[]): string {
  if (candidates.length === 0) return "";
  return candidates
    .map(
      (c) =>
        `  • ${c.id} — "${c.title}" (${c.openChildren} open / ${c.totalChildren} children; ` +
        `shared terms: ${c.overlap.join(", ")})`,
    )
    .join("\n");
}
