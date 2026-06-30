// Cheap, deterministic keyword signature of the terminal tail. No AI. Used both to pick relevant
// history for the Haiku few-shot AND to tag a new event when the user acts, so "similar situations"
// can be matched without a model call.
const RULES: Array<[RegExp, string]> = [
  // Hash alternative requires >= 1 digit so plain English words (e.g. "defaced") aren't tagged.
  [/\bcommit(ted)?\b|\b(?=[0-9a-f]*[0-9])[0-9a-f]{7}\b/i, "committed"],
  [/\bnot (?:yet )?merged|unmerged|into main\b/i, "unmerged"],
  [/\bpush(ed)?\b/i, "push"],
  [/\brebase\b/i, "rebase"],
  [/\bPR\b|pull request/i, "pr"],
  [/\bDMG\b|notariz/i, "dmg"],
  [/\b(test|spec)s?\b.*\b(pass|green|ok)\b/i, "tests-green"],
  [/\b(error|fail|panic|traceback)\b/i, "error"],
  [/\bdone\b|nothing further|complete\b/i, "done"],
];

export function deriveContextTags(scrollback: string): string[] {
  const tail = scrollback.slice(-2000);
  const tags = new Set<string>();
  for (const [re, tag] of RULES) if (re.test(tail)) tags.add(tag);
  return [...tags];
}
