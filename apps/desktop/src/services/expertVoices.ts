// Helpers for the "@mention Chief → spin up expert voice agents" Think-tab interaction.
// Pure functions (no I/O) so the @chief detection, mention-stripping, and corpus-summary
// logic are unit-testable in isolation; ThinkPanel wires these to generateVoices + Chief.

/** Matches an `@chief` mention as a whole token (start or after whitespace, word boundary
 *  after), case-insensitive. "@chief" and "hey @Chief help" match; "chief", "@chiefly",
 *  "@chefs" do not. */
const CHIEF_MENTION_RE = /(^|\s)@chief\b/i;

/** True when the text @mentions Chief to spin up expert voices. */
export function detectChiefMention(text: string): boolean {
  return CHIEF_MENTION_RE.test(text ?? "");
}

/** Remove the `@chief` token(s) from the text, leaving the user's actual ask. Collapses the
 *  whitespace the removed token left behind and trims. */
export function stripChiefMention(text: string): string {
  return (text ?? "")
    .replace(/(^|\s)@chief\b/gi, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** A short, one-line summary of the project's Chief library to ground the voice slate.
 *  Built from up to `max` asset filenames; returns "" when there's nothing to summarize so
 *  the caller can fall back to the project name. */
export function summarizeCorpus(
  assets: ReadonlyArray<{ filename?: string }>,
  max = 12,
): string {
  const names = (assets ?? [])
    .map((a) => (a?.filename ?? "").trim())
    .filter(Boolean)
    .slice(0, max);
  if (names.length === 0) return "";
  return `Project library includes: ${names.join(", ")}.`;
}

/** Best-effort one-liner for an existing persona skill that has only free-form instructions
 *  (Chief skills carry no separate oneLiner). Takes the first sentence/line, capped. */
export function instructionsOneLiner(instructions: string, cap = 140): string {
  const first = (instructions ?? "")
    .split(/(?<=[.!?])\s|\n/)[0]
    ?.trim() ?? "";
  return first.length > cap ? `${first.slice(0, cap - 1).trimEnd()}…` : first;
}
