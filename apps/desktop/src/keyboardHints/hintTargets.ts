// Vimium-style keyboard hints: the label scheme.
//
// A clean ⌘ tap toggles a layer of gold "chiclets" over the app's primary controls; pressing a
// chiclet's label key activates that control. Agent rows are numbered (1–9, then overflow letters);
// every other control gets a fixed mnemonic letter. This module is the single source of truth for
// that mapping and is intentionally DOM-free so it can be unit-tested in isolation.

// The data-hint attribute value used by agent rows. Agents are numbered by their on-screen order
// (top to bottom), NOT by a fixed key, so they share one id and the labels are assigned positionally.
export const AGENT_HINT = "agent";

// The data-hint value used by rows in the Recent-projects dropdown. Like agents, these are labeled
// positionally by on-screen order (top to bottom) rather than by a fixed key — but from the FULL
// alphabet, because while the dropdown is open the overlay shows only these rows (see collectChiclets
// in HintOverlay), so their letters can never collide with a chrome mnemonic.
export const RECENT_HINT = "recent-item";

// The data-hint value used by the "Switch" button inside a Recent row — the affordance that raises
// the window ALREADY showing that project instead of opening it here. It draws from the same
// sequential pool as the rows themselves (rows first, then switches), so with 13 rows the switches
// pick up at "n". Sharing one stream is what keeps a row letter and a switch letter from colliding.
export const RECENT_SWITCH_HINT = "recent-switch";

// The data-hint value of the chrome TRIGGER that opens the Recent-projects dropdown (the "r" badge
// in the top bar). Distinct from RECENT_HINT (the dropdown ROWS): selecting this one chains into the
// dropdown while keeping hint mode active, so the row badges appear without a second trigger tap.
// Its mnemonic lives in CHROME_HINTS.recent below; exported so HintOverlay compares against the
// constant instead of a magic "recent" string that could drift if that key is renamed.
export const RECENT_TRIGGER_HINT = "recent";

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

// Labels for Recent-dropdown rows: the full a–z, one per row in list order. Returns null past the
// 26th row (more distinct projects than letters — the tail simply gets no badge, matching agentLabel).
export const RECENT_POOL = "abcdefghijklmnopqrstuvwxyz".split("");
export function recentLabel(index: number): string | null {
  return RECENT_POOL[index] ?? null;
}

export type HintInput = { hintId: string };
export type LabeledHint<T extends HintInput> = T & { label: string | null };

// Assign a label to each target. Agent targets are labeled positionally in the order they appear
// in `targets` (callers MUST pre-sort agents into visual order); chrome targets get their fixed
// mnemonic. A target with no resolvable label gets `label: null` (filtered out by the renderer).
export function assignLabels<T extends HintInput>(targets: T[]): LabeledHint<T>[] {
  let agentIndex = 0;
  let recentIndex = 0;
  return targets.map((t) => {
    if (t.hintId === AGENT_HINT) {
      const label = agentLabel(agentIndex);
      agentIndex += 1;
      return { ...t, label };
    }
    // Rows and their Switch buttons share ONE sequential stream so their letters can't collide.
    // The caller passes every row before any switch, so rows take a.. and switches continue after.
    if (t.hintId === RECENT_HINT || t.hintId === RECENT_SWITCH_HINT) {
      const label = recentLabel(recentIndex);
      recentIndex += 1;
      return { ...t, label };
    }
    return { ...t, label: CHROME_HINTS[t.hintId] ?? null };
  });
}
