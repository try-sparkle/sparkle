// Vimium-style keyboard hints: the label scheme.
//
// A clean ⌘ tap toggles a layer of gold "chiclets" over the app's primary controls; pressing a
// chiclet's label key activates that control. Agent rows are numbered (1–9, then overflow letters);
// project tabs are lettered from the front of that same overflow pool; every other control gets a
// fixed mnemonic letter. This module is the single source of truth for that mapping and is
// intentionally DOM-free so it can be unit-tested in isolation.

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

// The data-hint value used by each PROJECT TAB in the concierge tab bar. Tabs are lettered, not
// numbered, because the builder's agent rows own 1–9 (the founder's call: "number builder rows
// numerically and the project tabs alphabetically") and both layers are on screen at once.
//
// Their letters come from AGENT_OVERFLOW_POOL — the SAME stream the 10th-and-later agent rows draw
// from — with tabs allocated FIRST and agent overflow continuing after (see assignLabels). That is
// the RECENT_HINT / RECENT_SWITCH_HINT trick: one counter, so a tab letter and an agent-overflow
// letter can never be the same character. A second, parallel pool would be free to drift into the
// first the moment either list grew.
export const PROJECT_TAB_HINT = "project-tab";

// The data-hint value of the PAPERCLIP in the concierge compose box. Like RECENT_TRIGGER_HINT this is
// a chaining trigger, not a leaf action: the paperclip's own click only EXPANDS a group holding the
// two things it can actually do, so selecting it keeps hint mode alive and re-collects (HintOverlay).
export const ATTACH_TRIGGER_HINT = "attach";

// The two actions behind the paperclip, with their own mnemonics — deliberately NOT in CHROME_HINTS.
//
// "s" is ALREADY CHROME_HINTS.screenshot, the agent-pane composer's screenshot button, and both
// surfaces can be on screen at once. Keeping these out of the chrome map is what lets that letter be
// reused without breaking the "every chrome mnemonic is distinct" invariant: they are only ever
// labelled inside the scoped attach chain, where they are the ONLY badges on screen (the same trick
// the Recent dropdown uses for its a–z rows). collectChiclets drops them in every other mode — which
// matters, because the group also expands on plain HOVER, so they can be in the DOM unbidden.
export const ATTACH_ACTION_HINTS: Record<string, string> = {
  "attach-screenshot": "s",
  "attach-upload": "u",
};

/** That hint id's attach-action mnemonic, or null if it isn't one. The overlay uses this to bucket
 *  the chain's members; assignLabels uses it to label them. */
export function attachActionLabel(hintId: string): string | null {
  return Object.hasOwn(ATTACH_ACTION_HINTS, hintId) ? ATTACH_ACTION_HINTS[hintId]! : null;
}

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
  credits: "d", // the balance pill in the builder header — d for "Dollars" (opens the Credits pane).
  // The concierge compose box. "/" is the Slack/Discord "start typing here" convention AND, being
  // punctuation, it costs AGENT_OVERFLOW_POOL nothing — every LETTER promoted to a chrome mnemonic is
  // one fewer project tab / overflow agent that can be reached at all.
  prompt: "/",
  presence: "h", // the Here | Away slider. One key that TOGGLES, not two that set.
  attach: "k", // the paperclip — "klip", since a/c/d/p/s are all taken.
};

// The prefix character for TWO-character labels. It is never a label on its own, anywhere: press it
// and the overlay enters a prefix layer where only the pair labels are live, showing their second
// character (see HintOverlay). That is the founder's rule — spend one character so the single-key
// labels keep working for as long as possible, and get 26 more slots behind it instead of a cliff.
//
// The cliff was real: before this, a target past the end of its pool got `label: null` and the
// renderer silently dropped its badge, leaving it unreachable by keyboard with nothing on screen
// saying so.
export const PAIR_PREFIX = "z";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz".split("");

// Second characters of a pair — the FULL alphabet, including the prefix itself ("zz" is a valid
// label). Inside the prefix layer nothing but pairs is selectable, so no letter here can collide.
export const PAIR_SECONDS = ALPHABET;

// Letters available to agents beyond the 9th, with the reserved chrome letters AND the pair prefix
// removed so an overflow agent can never collide with a chrome control or shadow the prefix.
// Reserved: a b c d g i m n o p r s t (+ h k from the concierge controls, "/" is not a letter), plus
// z → pool = e f j l q u v w x y (10 letters, then 26 pairs; with 1–9 that's 45 addressable agents).
const RESERVED = new Set([...Object.values(CHROME_HINTS), PAIR_PREFIX]);
export const AGENT_OVERFLOW_POOL = ALPHABET.filter((ch) => !RESERVED.has(ch));

/** The Nth slot (0-based) of a label pool: its single characters first, then PAIR_PREFIX pairs.
 *
 *  Returns null only once BOTH are exhausted (pool.length + 26 slots), which is far enough out that
 *  a dropped badge is no longer a routine occurrence. */
function poolLabel(pool: string[], index: number): string | null {
  if (index < 0) return null;
  if (index < pool.length) return pool[index]!;
  const second = PAIR_SECONDS[index - pool.length];
  return second === undefined ? null : PAIR_PREFIX + second;
}

/** True for a two-character (prefix + second) label. The overlay uses this to split the badge set
 *  into the single-key layer and the layer behind PAIR_PREFIX. */
export function isPairLabel(label: string): boolean {
  return label.length === 2 && label[0] === PAIR_PREFIX;
}

// The label for the Nth agent (0-based) in display order: "1".."9" then the overflow pool.
// Returns null once we run out of distinct labels (more than 9 + pool.length + 26 agents on screen).
//
// `overflowOffset` is how many pool letters the PROJECT TABS have already claimed, so the agent
// overflow resumes after them instead of restarting at the top of the pool and colliding. It is a
// count, not a position: the first nine agents keep 1..9 either way.
export function agentLabel(index: number, overflowOffset = 0): string | null {
  if (index < 9) return String(index + 1);
  return poolLabel(AGENT_OVERFLOW_POOL, index - 9 + overflowOffset);
}

// The label for the Nth project tab (0-based, left to right): the head of AGENT_OVERFLOW_POOL, which
// is the alphabet minus the reserved chrome mnemonics — so a tab letter can't shadow a chrome control
// either. Past the single characters it continues into the pair labels (see poolLabel).
export function projectTabLabel(index: number): string | null {
  return poolLabel(AGENT_OVERFLOW_POOL, index);
}

// Labels for Recent-dropdown rows: a–y (the alphabet minus the pair prefix, which is never a label on
// its own), one per row in list order, then za.. for the tail. The dropdown gets the whole alphabet
// rather than the overflow pool because while it is open the overlay shows ONLY these rows, so their
// letters can never collide with a chrome mnemonic.
export const RECENT_POOL = ALPHABET.filter((ch) => ch !== PAIR_PREFIX);
export function recentLabel(index: number): string | null {
  return poolLabel(RECENT_POOL, index);
}

export type HintInput = { hintId: string };
export type LabeledHint<T extends HintInput> = T & { label: string | null };

// Assign a label to each target. Agent targets are labeled positionally in the order they appear
// in `targets` (callers MUST pre-sort agents into visual order); chrome targets get their fixed
// mnemonic. A target with no resolvable label gets `label: null` (filtered out by the renderer).
export function assignLabels<T extends HintInput>(targets: T[]): LabeledHint<T>[] {
  let agentIndex = 0;
  let recentIndex = 0;
  let tabIndex = 0;
  // Project tabs and agent OVERFLOW share one walk through AGENT_OVERFLOW_POOL, tabs first. Counted
  // up front rather than relying on tabs appearing before agents in `targets`: the overlay sorts each
  // bucket by visual order and tabs sit above the sidebar, so an ordering assumption here would be a
  // silent collision waiting on the day someone reorders the buckets.
  const tabCount = targets.filter((t) => t.hintId === PROJECT_TAB_HINT).length;
  return targets.map((t) => {
    if (t.hintId === AGENT_HINT) {
      const label = agentLabel(agentIndex, tabCount);
      agentIndex += 1;
      return { ...t, label };
    }
    if (t.hintId === PROJECT_TAB_HINT) {
      const label = projectTabLabel(tabIndex);
      tabIndex += 1;
      return { ...t, label };
    }
    // Rows and their Switch buttons share ONE sequential stream so their letters can't collide.
    // The caller passes every row before any switch, so rows take a.. and switches continue after.
    if (t.hintId === RECENT_HINT || t.hintId === RECENT_SWITCH_HINT) {
      const label = recentLabel(recentIndex);
      recentIndex += 1;
      return { ...t, label };
    }
    // ATTACH_ACTION_HINTS is consulted second and kept out of CHROME_HINTS on purpose: its "s"
    // duplicates CHROME_HINTS.screenshot, which is safe only because the overlay shows these two in
    // a scope of their own. See the constant's header.
    //
    // hasOwn, not a plain index: `hintId` comes off a DOM attribute, so an element tagged
    // data-hint="constructor" would otherwise resolve through Object.prototype and yield a FUNCTION
    // where a label string belongs.
    const chrome = Object.hasOwn(CHROME_HINTS, t.hintId) ? CHROME_HINTS[t.hintId]! : null;
    return { ...t, label: chrome ?? attachActionLabel(t.hintId) };
  });
}

/** Marks the element while HintOverlay is firing its synthetic `click()` for a keyboard jump.
 *
 *  A hint jump means "take me to this thing". A handler may reasonably do LESS for that than for a
 *  deliberate click: the Build column's agent rows fold their worker subtree on click, and a jump
 *  that also folded — and persisted the fold — made repeated jumps flip-flop a subtree the user
 *  never touched. Read it with `el.hasAttribute(HINT_JUMP_ATTR)` inside the handler.
 *
 *  This is an EXPLICIT signal on purpose. The obvious alternative, sniffing `event.detail === 0`,
 *  describes the dispatch mechanism rather than the intent — assistive-tech activations
 *  (VoiceOver / Switch Control AXPress on a non-native control) also arrive with detail 0, so they
 *  would be misread as hint jumps and silently lose the behavior they asked for. */
export const HINT_JUMP_ATTR = "data-hint-jump";
