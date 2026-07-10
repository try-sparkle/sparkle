// Vimium-style keyboard hints: the label scheme.
//
// A clean ⌘ tap toggles a layer of gold "chiclets" over the app's primary controls; pressing a
// chiclet's label key activates that control. Agent rows are numbered (1–9, then overflow letters);
// every other control gets a fixed mnemonic letter. This module is the single source of truth for
// that mapping and is intentionally DOM-free so it can be unit-tested in isolation.

// The data-hint attribute value used by agent rows. Agents are numbered by their on-screen order
// (top to bottom), NOT by a fixed key, so they share one id and the labels are assigned positionally.
export const AGENT_HINT = "agent";

// Fixed mnemonic key for each chrome control, keyed by its data-hint attribute value.
// (The "." for the ⋯ overflow menu is a deliberate pun: three dots → the period key.)
export const CHROME_HINTS: Record<string, string> = {
  think: "t",
  plan: "p",
  build: "b",
  mic: "m",
  recent: "r",
  open: "o",
  new: "n",
  newbuild: "g", // "+ New Build Agent" sidebar button — g for "aGent" (n/b are taken).
  screenshot: "s",
  menu: ".",
  improve: "i",
  changelog: "c",
  account: "a",
  credits: "d", // the balance pill beside the wordmark — d for "Dollars" (opens the Credits pane).
};

// Letters available to agents beyond the 9th, with the reserved chrome letters removed so an
// overflow agent can never collide with a chrome control. Reserved: a b c d g i m n o p r s t →
// pool = e f h j k l q u v w x y z (13 letters; with 1–9 that's 22 addressable agents).
const RESERVED = new Set(Object.values(CHROME_HINTS));
export const AGENT_OVERFLOW_POOL = "abcdefghijklmnopqrstuvwxyz"
  .split("")
  .filter((ch) => !RESERVED.has(ch));

// The label for the Nth agent (0-based) in display order: "1".."9" then the overflow pool.
// Returns null once we run out of distinct labels (more than 9 + pool.length agents on screen).
export function agentLabel(index: number): string | null {
  if (index < 9) return String(index + 1);
  return AGENT_OVERFLOW_POOL[index - 9] ?? null;
}

export type HintInput = { hintId: string };
export type LabeledHint<T extends HintInput> = T & { label: string | null };

// Assign a label to each target. Agent targets are labeled positionally in the order they appear
// in `targets` (callers MUST pre-sort agents into visual order); chrome targets get their fixed
// mnemonic. A target with no resolvable label gets `label: null` (filtered out by the renderer).
export function assignLabels<T extends HintInput>(targets: T[]): LabeledHint<T>[] {
  let agentIndex = 0;
  return targets.map((t) => {
    if (t.hintId === AGENT_HINT) {
      const label = agentLabel(agentIndex);
      agentIndex += 1;
      return { ...t, label };
    }
    return { ...t, label: CHROME_HINTS[t.hintId] ?? null };
  });
}
