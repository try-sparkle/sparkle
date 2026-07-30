// @-mentions in the concierge composer: the pure half. No React, no stores, no Tauri — so every
// rule below is testable as data, the same way paletteJump and conciergeAiLock are.
//
// THE ASK (founder, 2026-07-28): "I want the ability to at-mention builder agents to send things
// over to those builder agents… When I start with the '@' it pulls up a picker list, and as I type
// '@Bl' it narrows the list down, and if I press enter it shows me the agent as a pill."
//
// ══ WHY A MENTION IS DERIVED FROM THE TEXT, NOT STORED BESIDE IT ═══════════════════════════════
// The obvious implementations are both wrong here, and it is worth saying why before someone
// "fixes" this into one of them.
//
//   1. A SENTINEL TOKEN in the text (`@[Blueprint UI/UX](agent-7)`, or a private-use codepoint
//      wrapper). This leaks. The concierge builds THREE renderings of every message — the PTY
//      payload, the thread/history display, and the plain text the router classifies and the
//      auto-namer reads (see ConciergeHost's `send`) — and a sentinel would have to be stripped
//      from each one independently. That is exactly the shape of the attachment temp-path leak
//      (roborev 46911/46925), which reached three of those surfaces before anyone noticed. A
//      representation that cannot leak beats three strip calls that must each be remembered.
//
//   2. A PARALLEL LIST KEYED BY OFFSET (`{agentId, start, end}[]`). Offsets drift the moment the
//      user edits anything to the left of a mention, and a drifted offset does not fail loudly — it
//      silently re-points a mention at a different span, so the pill in the thread names one agent
//      while the aim delivers to another. In a feature whose whole job is to put words into a live
//      PTY, "silently aimed somewhere else" is the one failure mode that cannot be walked back.
//
// So a mention is DERIVED: the text contains exactly what the user sees (`@Blueprint UI/UX move it
// 5px`), and a mention exists **iff** that literal `@<name>` is present in the text and `<name>` is
// a currently-known agent. Three things fall out of that for free:
//
//   • The aim can never disagree with what is on screen. Delete one character of the name and the
//     mention is gone — which is the fail-CLOSED direction (no aim → the auto-router decides, and
//     the router's own rule is to take the reversible side).
//   • A restored draft (a cancelled countdown, a failed delivery — ConciergeHost.restoreDraft) comes
//     back fully aimed, with no extra channel to carry the aim back through. The dictation insert
//     path takes a bare string and nothing else, so any stored-beside-the-text scheme would lose
//     the aim on every restore.
//   • Typing `@Blueprint UI/UX` by hand works identically to picking it from the list. That is a
//     feature, not a loophole: the founder dictates, and a hand-typed mention is the fallback when
//     the picker is not in the loop.
//
// Fail-open worry, answered: yes, this means text that merely CONTAINS `@Blueprint UI/UX` aims at
// that agent. Nothing is delivered on the strength of it, though — a mention-aimed send still arms
// an intent and counts down in the banner with a Cancel, exactly like a router-decided one (see
// ConciergeHost's `deliver`). Explicitness buys the user a skipped classify, never a skipped gate.
import type { StatusBand } from "../../engine/buildSections";

/** One agent the picker can offer. A projection of `ConciergeAgent` (services/conciergeFeed), not
 *  that record itself: this module is pure, and the picker needs four fields out of thirty. */
export interface MentionAgent {
  id: string;
  name: string;
  projectId: string;
  projectName: string;
  /** Drives the default ordering — an agent that needs you is the likeliest thing you want to
   *  address. */
  band: StatusBand;
  /** Epoch ms of the user's last touch (ConciergeAgent.since), the within-tier recency tiebreak. */
  since?: number;
  /** False when the agent cannot receive a prompt at all (a cloud agent, a dead PTY). Still LISTED
   *  — see {@link orderMentionAgents} for why hiding it is worse than showing it. */
  canAcceptInput: boolean;
  /** What a mention of this agent READS AS, when the bare name would not identify it.
   *
   *  Set by {@link withMentionLabels} and absent otherwise, in which case the label IS the name.
   *  Everything that touches the text — matching, inserting, scoring, the pill — goes through
   *  {@link labelOf}, so an agent is addressed by exactly the string the user can see. */
  label?: string;
}

/** The text that addresses this agent. See {@link MentionAgent.label}. */
function labelOf(a: MentionAgent): string {
  return a.label ?? a.name;
}

/**
 * Give same-named agents labels that tell them apart, so the text can address one of them.
 *
 * ══ THE SILENT WRONG-AGENT BUG THIS FIXES (roborev 54557) ═══════════════════════════════════════
 * Two projects can each hold an agent called "Docs". The picker showed both rows, labelled with
 * their projects, and the user picked one — and then `insertMention` wrote the bare `@Docs`, which
 * `findMentionSpans` re-resolved by roster order. **Picking the second row aimed at the first.** The
 * pill drew `@Docs` either way, so the surface that exists to make the aim reviewable was precisely
 * where the ambiguity became invisible.
 *
 * Recording the chosen id beside the text would fix the aim and reintroduce the drift this module
 * is built to avoid (see the header). The honest fix is the other direction: if the name does not
 * identify the agent, then the name is not the address — so make the ADDRESS longer until it is.
 * `@Docs (web)` and `@Docs (mobile)` are two different literals, derive-from-text resolves each to
 * exactly one agent, and the user reads the distinction in the composer, in the bubble and in the
 * countdown banner.
 *
 * A bare `@Docs` typed by hand now matches NOTHING, which is correct: it does not name an agent.
 * The message falls through to the auto-router — the recoverable direction — rather than picking a
 * "Docs" for the user.
 *
 * Only collisions get a suffix; the overwhelmingly common case is untouched.
 */
export function withMentionLabels(agents: readonly MentionAgent[]): MentionAgent[] {
  const counts = new Map<string, number>();
  for (const a of agents) {
    const key = a.name.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return agents.map((a) =>
    (counts.get(a.name.toLowerCase()) ?? 0) > 1
      ? { ...a, label: `${a.name} (${a.projectName})` }
      : a,
  );
}

/** A resolved mention, as carried on a sent message so the thread can draw the pill. Deliberately
 *  a SNAPSHOT of the name: an agent closed an hour after the message was sent should still render
 *  as the pill the user actually addressed, not vanish out of their own history. */
export interface ConciergeMention {
  agentId: string;
  name: string;
}

/** The sigil. A constant rather than a literal `"@"` scattered through four files — the picker's
 *  trigger, the liveness scan, the insert and the delete all have to agree on it. */
export const MENTION_SIGIL = "@";

/** How long a query may run before the picker gives up and closes.
 *
 *  A bound is needed because agent names contain SPACES ("Blueprint UI/UX", "Kraken Auth"), so the
 *  query cannot simply end at the first space the way a Slack/GitHub handle does — `@Kraken ` has
 *  to keep matching while the user types `Auth`. Without a cap, one `@` typed in the middle of a
 *  paragraph would leave the picker's query growing to the end of the message. Comfortably longer
 *  than any real agent name; short enough that a stray `@` stops mattering within a few words. */
export const MAX_MENTION_QUERY = 48;

/** Characters that continue a NAME, for the boundary test on both sides of a candidate match — so
 *  an agent called "Blue" is not found inside `@Blueprint`, which would aim a message at the wrong
 *  agent while the user reads the right name on screen.
 *
 *  IT INCLUDES `/`, `-`, `.` AND `_`, and the narrower alphanumeric-only class this started as was
 *  a real wrong-agent bug (roborev 54551). The reasoning given for excluding them — that they would
 *  "break `@Blueprint UI/UX` against a sibling named `@Blueprint UI`" — was simply false: longest
 *  name first plus the `taken` overlap check below already resolves that pair, with or without this
 *  class. What the narrow version actually enabled was the OPPOSITE failure, and the worse one. With
 *  only "Blueprint UI" in the fleet, typing the full `@Blueprint UI/UX` matched at the shorter name
 *  because the `/` that followed did not count as a continuation — so the message was aimed at an
 *  agent the user had not named, and `mentionFreeText` relayed a dangling "/UX" to its terminal.
 *
 *  Wider is the fail-CLOSED direction: a name typed with extra name-ish characters after it now
 *  matches nothing, and no aim is better than the wrong aim. This class governs the BOUNDARY only —
 *  `matchScore` still splits names on the same punctuation to offer "ux" as a searchable word. */
const NAME_CHAR = /[A-Za-z0-9/\-._]/;
/** The half of {@link NAME_CHAR} that is also ordinary sentence punctuation. */
const NAME_PUNCT = /[/\-._]/;
const ALNUM = /[A-Za-z0-9]/;

/** Is `text[i]` a character that could extend a name? Out-of-range reads as "no", which is what
 *  makes a mention at either end of the string match. */
function isNameChar(text: string, i: number): boolean {
  const ch = text[i];
  return ch !== undefined && NAME_CHAR.test(ch);
}

/**
 * Does the character just outside a candidate match BLOCK it — i.e. is the match really part of a
 * longer name? `step` is the direction to keep reading (+1 past the end, -1 before the start).
 *
 * ══ WHY THIS IS NOT SIMPLY `isNameChar` (roborev 54555) ═════════════════════════════════════════
 * It was, and widening {@link NAME_CHAR} to catch `@Blueprint UI/UX` made ordinary sentence
 * punctuation terminate nothing. `"please look at @Kraken Auth."` stopped resolving, because the
 * full stop read as a name continuation — no pill, no aim, and `mentionFreeText` left the raw `@`
 * in the text for the terminal, the one thing it exists to prevent. **The founder dictates, and
 * dictation puts a full stop at the end of the utterance**, so that is the common case, not a
 * corner one.
 *
 * The distinction is what FOLLOWS the punctuation. `@Auth-v2` and `@Auth.old` are longer names and
 * must still be refused; `@Kraken Auth.` is a sentence ending and must resolve. So name-ish
 * punctuation only blocks when something name-ish follows it, read outward — which is also why this
 * recurses rather than peeking one character: `@Auth--v2` is as much a longer name as `@Auth-v2`.
 */
function blocksBoundary(text: string, i: number, step: 1 | -1): boolean {
  const ch = text[i];
  if (ch === undefined) return false; // the edge of the string is always a clean boundary
  if (ALNUM.test(ch)) return true; // a letter or digit always continues a name
  if (!NAME_PUNCT.test(ch)) return false; // a space, comma, quote… — a clean boundary
  return blocksBoundary(text, i + step, step);
}

/** Where a mention's literal sits in the text. Half-open `[start, end)`, like every other range in
 *  this codebase's string handling. */
export interface MentionSpan {
  agentId: string;
  name: string;
  start: number;
  end: number;
}

/**
 * Every `@<agent name>` occurrence in `text`, in the order they appear.
 *
 * Longest name first, so a fleet holding both "Blueprint UI" and "Blueprint UI/UX" resolves
 * `@Blueprint UI/UX` to the agent the user can read, not to its shorter sibling with a stray "/UX"
 * left dangling after the pill. Overlaps are then dropped — one span of text is one mention.
 *
 * ══ DUPLICATE NAMES ═════════════════════════════════════════════════════════════════════════════
 * There are none by the time this runs, and that is now a property rather than a hope.
 * {@link withMentionLabels} gives two agents called "Docs" the addresses `@Docs (web)` and
 * `@Docs (mobile)`, so every candidate this matches against is uniquely addressable and the roster's
 * ORDER cannot decide which terminal a message lands in.
 *
 * Two weaker answers were tried first and are recorded because both look reasonable:
 *   • "Break the tie by the caller's relevance order" (roborev 54551). Deterministic, but the tie is
 *     still broken by something the user cannot see — and picking the SECOND "Docs" row in the
 *     picker aimed at the FIRST agent, with the bubble drawing the same `@Docs` pill either way
 *     (roborev 54557). A rule that decides a terminal must not be invisible.
 *   • "Fail closed — drop the span when two agents share a name." Safe, but it means the user picks
 *     "Docs", watches the pill appear, and silently gets no aim at all.
 * Making the address long enough to be unique satisfies both: the aim is correct AND the user reads
 * why it is correct.
 */
export function findMentionSpans(text: string, agents: readonly MentionAgent[]): MentionSpan[] {
  // Sort a COPY: `agents` is the caller's list and is also what the picker renders in its own
  // order. Mutating it here would silently reorder the visible list from a parse.
  const byLength = [...agents].sort((a, b) => labelOf(b).length - labelOf(a).length);
  const spans: MentionSpan[] = [];
  const taken: boolean[] = new Array(text.length).fill(false);
  for (const agent of byLength) {
    const label = labelOf(agent);
    if (!label) continue; // an unnamed agent has no literal to match — skip, never match "@"
    const needle = MENTION_SIGIL + label;
    let from = 0;
    for (;;) {
      const at = text.indexOf(needle, from);
      if (at < 0) break;
      from = at + 1;
      const end = at + needle.length;
      // The sigil must START a token — `a@Blue` and `foo@bar.com` are not mentions. And the match
      // must not be a PREFIX of a longer word: `@Blue` inside `@Blueprint` is the wrong agent.
      // `blocksBoundary`, not `isNameChar`, so a sentence-final full stop still ends the mention.
      if (blocksBoundary(text, at - 1, -1) || text[at - 1] === MENTION_SIGIL) continue;
      if (blocksBoundary(text, end, 1)) continue;
      // Already claimed by a longer name that overlaps this range.
      let overlaps = false;
      for (let i = at; i < end; i += 1) if (taken[i]) overlaps = true;
      if (overlaps) continue;
      for (let i = at; i < end; i += 1) taken[i] = true;
      // `label`, not `name`: the span's text IS what was matched, and a mention record carrying the
      // bare name would no longer locate itself in the message (rosterFromMentions feeds it back
      // into this same matcher).
      spans.push({ agentId: agent.id, name: label, start: at, end });
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

/** The mentions in `text`, de-duplicated by agent and in first-appearance order — what a send
 *  carries. Two `@Kraken Auth`s in one message are one aim, not two. */
export function mentionsIn(text: string, agents: readonly MentionAgent[]): ConciergeMention[] {
  const seen = new Set<string>();
  const out: ConciergeMention[] = [];
  for (const s of findMentionSpans(text, agents)) {
    if (seen.has(s.agentId)) continue;
    seen.add(s.agentId);
    out.push({ agentId: s.agentId, name: s.name });
  }
  return out;
}

/** What the AGENT receives: the same message with the ADDRESS removed and every other mention
 *  reduced to a plain name.
 *
 *  THE `@` MUST NOT REACH THE PTY, and this is not a tidiness preference. The agent on the other end
 *  of that terminal is a Claude Code CLI, where a leading `@` on a token opens its own file-reference
 *  autocomplete — so relaying `@Blueprint UI/UX move it 5px` verbatim would pop a picker inside the
 *  agent's composer and leave the instruction half-typed behind it. The mention is an ADDRESS; the
 *  envelope does not go in the envelope.
 *
 *  The thread bubble keeps the full text (and draws the pill), so nothing is hidden from the user —
 *  this rendering exists for the wire only, exactly like `attachedPayload`'s.
 *
 *  THE GAP IS CLOSED AT THE SEAM, NOT BY A GLOBAL COLLAPSE, and the difference is a corrupted
 *  prompt (roborev 54551). This used to finish with `out.replace(/[ \t]{2,}/g, " ")`, which flattens
 *  every run of whitespace in the message — so a prompt carrying a pasted diff, a code block or a
 *  nested list reached the agent's terminal re-indented:
 *
 *      "@Kraken Auth run this:\n    npm test"  →  "run this:\n npm test"
 *
 *  which is exactly the re-flow the newline rule two lines below was written to prevent, undone one
 *  line later for indentation. The suite missed it because the only no-collapse test took the
 *  `spans.length === 0` early return. So each removal swallows ONE adjacent space of its own instead
 *  — the space `insertMention` put there — and every other run of whitespace in the message is the
 *  user's and survives untouched. */
export function mentionFreeText(text: string, agents: readonly MentionAgent[]): string {
  const spans = findMentionSpans(text, agents);
  if (spans.length === 0) return text;
  const gap = (i: number) => text[i] === " " || text[i] === "\t";
  let out = "";
  let at = 0;
  for (const [i, s] of spans.entries()) {
    // ══ ONLY THE ADDRESS IS REMOVED. THE REST JUST LOSE THEIR SIGIL (roborev 54569) ═════════════
    // This deleted EVERY mention span, which is fine for the one name that IS the envelope and
    // destroys the sentence for any other:
    //
    //   "@Kraken Auth please coordinate with @Blueprint UI/UX before you land this"
    //      → "please coordinate with before you land this"
    //
    // — an instruction with its referenced party silently removed, written irreversibly into a
    // terminal. The reason this function exists is to keep the `@` off the wire (it opens the
    // Claude Code CLI's file-reference autocomplete), and that is fully served by dropping the
    // sigil. The NAME is content: the user wrote it because the instruction depends on it.
    //
    // The first span is the address because the host routes `mentions[0]`, and both lists are in
    // first-appearance order — so span zero is exactly the name that became the destination.
    if (i > 0) {
      out += text.slice(at, s.start);
      out += text.slice(s.start + MENTION_SIGIL.length, s.end);
      at = s.end;
      continue;
    }
    // Prefer eating the space AFTER the mention (`@Kraken Auth ship it` → `ship it`); fall back to
    // the one BEFORE it when the mention ends the line or the message (`tell @Kraken Auth` →
    // `tell`). Never both, or "a @X b" would lose the word break entirely.
    let start = s.start;
    let end = s.end;
    if (gap(end)) end += 1;
    else if (gap(start - 1)) start -= 1;
    out += text.slice(at, start);
    at = end;
  }
  out += text.slice(at);
  // Only the ends: a message that was nothing but an address collapses to "", and a leading address
  // must not leave the agent's prompt starting with a space. Interior whitespace — including the
  // newlines and indentation of a pasted block — is the user's.
  return out.trim();
}

// ══ THE PICKER'S QUERY ═══════════════════════════════════════════════════════════════════════════

/** An open mention query: the `@` that started it and what has been typed after it. */
export interface MentionQuery {
  /** Index of the `@` in the text — the picker's identity, so an Escape can be remembered against
   *  THIS `@` and not suppress the next one. */
  anchor: number;
  /** Everything between the sigil and the caret. May contain spaces (agent names do). */
  query: string;
}

/**
 * Is the caret inside a mention being typed, and if so what has been typed?
 *
 * Walks LEFT from the caret to the nearest `@` that starts a token. Stops at a newline — a mention
 * does not span lines, and without that stop an `@` three paragraphs up would keep the picker armed
 * for the rest of the message.
 */
export function mentionQuery(text: string, caret: number): MentionQuery | null {
  const at = Math.max(0, Math.min(caret, text.length));
  for (let i = at - 1; i >= 0; i -= 1) {
    const ch = text[i];
    if (ch === "\n") return null;
    if (ch !== MENTION_SIGIL) continue;
    // Must start a token, on the same terms `findMentionSpans` uses — `foo@bar` is an email, not a
    // mention, and typing one must not pop a picker over the composer.
    if (isNameChar(text, i - 1) || text[i - 1] === MENTION_SIGIL) return null;
    const query = text.slice(i + 1, at);
    if (query.length > MAX_MENTION_QUERY) return null;
    return { anchor: i, query };
  }
  return null;
}

// ══ MATCHING AND ORDERING ════════════════════════════════════════════════════════════════════════

/** Match strength, best first. Exported so the tests can name a tier rather than assert on a magic
 *  number, and so the sort below reads as tiers rather than arithmetic. */
export const MATCH_NONE = 0;
const MATCH_SUBSEQUENCE = 1;
const MATCH_WORD_PREFIX = 2;
const MATCH_PREFIX = 3;

/**
 * How well `name` answers `query`. Case-insensitive, three tiers:
 *
 *   • PREFIX — `Bl` → "Blueprint UI/UX". What the founder described ("as I type '@Bl' it narrows").
 *   • WORD PREFIX — `UI` → "Blueprint UI/UX", `auth` → "Kraken Auth". Agent names are two or three
 *     words and the memorable one is rarely the first, so first-word-only matching would make half
 *     the fleet unreachable by the word its owner actually calls it.
 *   • SUBSEQUENCE — `bpui` → "Blueprint UI". The cheap fuzzy tier, last so it can never outrank a
 *     real prefix hit.
 *
 * An EMPTY query matches everything at the top tier: typing a bare `@` must show the whole list,
 * which is the affordance that makes the feature discoverable at all.
 */
export function matchScore(name: string, query: string): number {
  const q = query.trim().toLowerCase();
  if (q === "") return MATCH_PREFIX;
  const n = name.toLowerCase();
  if (n.startsWith(q)) return MATCH_PREFIX;
  // Split on anything that isn't a name character, so "Blueprint UI/UX" offers "blueprint","ui","ux"
  // — the slash is a word break in an agent name, not part of a word.
  if (n.split(/[^a-z0-9]+/).some((w) => w !== "" && w.startsWith(q))) return MATCH_WORD_PREFIX;
  // Subsequence: every character of the query appears in order. Spaces in the query are ignored so
  // "bp ui" still reaches "Blueprint UI".
  let i = 0;
  for (const ch of n) {
    if (ch === q[i]) i += 1;
    if (i === q.length) return MATCH_SUBSEQUENCE;
  }
  const squashed = q.replace(/\s+/g, "");
  if (squashed !== q && squashed !== "") {
    let j = 0;
    for (const ch of n) {
      if (ch === squashed[j]) j += 1;
      if (j === squashed.length) return MATCH_SUBSEQUENCE;
    }
  }
  return MATCH_NONE;
}

/** Band ordering for the default list — an agent that needs you is the likeliest one you opened the
 *  picker to address. `needs_you` first, then whatever is running, then everything settled. */
const BAND_RANK: Record<StatusBand, number> = { needs_you: 0, running: 1, done: 2 };

/**
 * The picker's list: filtered by `query`, best match first, most relevant first within a tier.
 *
 * `preferredId` is the agent the compose box would already reach without a mention (the selected
 * build agent). It sorts to the top because "the one I am looking at" is the single most common
 * thing anybody addresses, and putting it first makes `@` + Enter a one-gesture aim at it.
 *
 * AGENTS THAT CANNOT TAKE INPUT ARE LISTED, not hidden, and sort last. Hiding them would mean the
 * founder types `@Kra`, sees nothing, and cannot tell "no such agent" from "that one is a cloud
 * agent" — and the second is a fact worth telling them. The picker renders the row disabled with a
 * reason; the send path refuses it honestly rather than silently (see ConciergeHost's `deliver`).
 */
export function orderMentionAgents(
  agents: readonly MentionAgent[],
  query: string,
  preferredId?: string | null,
): MentionAgent[] {
  return agents
    .map((a) => ({ a, score: matchScore(labelOf(a), query) }))
    .filter((s) => s.score !== MATCH_NONE)
    .sort((x, y) => {
      if (x.score !== y.score) return y.score - x.score;
      // Deliverability before everything else within a tier: an offer that cannot be honoured must
      // never sit above one that can.
      if (x.a.canAcceptInput !== y.a.canAcceptInput) return x.a.canAcceptInput ? -1 : 1;
      const xPref = x.a.id === preferredId ? 0 : 1;
      const yPref = y.a.id === preferredId ? 0 : 1;
      if (xPref !== yPref) return xPref - yPref;
      const band = BAND_RANK[x.a.band] - BAND_RANK[y.a.band];
      if (band !== 0) return band;
      // Recency of the USER's last touch, newest first. Untouched agents (`since` absent) sort
      // after every touched one rather than to the top, which a bare `?? 0` would also do — this is
      // spelled out because reading it as "0 means oldest" is the kind of accident that puts a
      // never-opened agent above the one you were just in.
      const xs = x.a.since ?? -1;
      const ys = y.a.since ?? -1;
      if (xs !== ys) return ys - xs;
      return labelOf(x.a).localeCompare(labelOf(y.a));
    })
    .map((s) => s.a);
}

/**
 * Has this query already FINISHED naming an agent, so there is nothing left to pick?
 *
 * The picker has to close itself the moment a mention is complete, and "the query stopped matching"
 * cannot do it: {@link insertMention} leaves the caret after `@Kraken Auth `, and that query still
 * matches "Kraken Auth" at the top prefix tier — `matchScore` trims, so the trailing space does not
 * terminate anything. Left to that alone the list re-opens over the pill it just inserted, one
 * keystroke after the user chose from it.
 *
 * The tell is the TRAILING SPACE, not the exact match on its own. A bare exact match must keep the
 * list open, because a name can be a prefix of a sibling's: someone typing `@Blueprint UI` by hand
 * with both "Blueprint UI" and "Blueprint UI/UX" in the fleet is not necessarily done, and closing
 * there would put the `/UX` half out of reach. A space says they are.
 */
export function isCompletedMention(query: string, agents: readonly MentionAgent[]): boolean {
  if (!/\s$/.test(query)) return false;
  const done = query.trim().toLowerCase();
  if (done === "") return false;
  return agents.some((a) => labelOf(a).toLowerCase() === done);
}

// ══ THE CONCIERGE IS ADDRESSABLE TOO ═════════════════════════════════════════════════════════════

/**
 * The agent id a mention of the concierge itself carries.
 *
 * NOT a real agent id, and it deliberately cannot collide with one: `agentCanAcceptInput`,
 * `agentStillExists` and the feed all key on uuids, so this string resolves to nothing in any of
 * them. That is the SAFE direction and the reason the value is spelled this way rather than, say,
 * `"sparkle"` — `ConciergeHost.deliver` builds a `mentionAim` only when the first mention resolves
 * to a live feed agent, so a `@Sparkle` mention leaves the aim null and the message falls through to
 * the ordinary router exactly as an unaddressed one does. Nothing is misdelivered while the host's
 * own `@Sparkle` routing is still being written; the pill is simply legible ahead of it.
 */
export const SPARKLE_MENTION_ID = "sparkle-concierge";

/** What the concierge is ADDRESSED as. The founder's word, and the one already all over this app's
 *  voice copy (the wake phrase is "Hey Sparkle"), so there is nothing else it could be. */
export const SPARKLE_MENTION_NAME = "Sparkle";

/**
 * The concierge as a mention target.
 *
 * `band: "done"` and no `since`, which is not a status claim — it is where this row should SORT.
 * Nothing about the concierge "needs you" or is "running", and `orderMentionAgents` puts `done` after
 * both, so a build agent that actually wants attention still outranks it and `preferredAgentId`
 * still wins the top slot. The concierge is always reachable, so it never needs to compete.
 *
 * `canAcceptInput: true` because it genuinely can — it is the one destination in this column that is
 * never a dead PTY — and because a `false` here would render the picker row disabled with "Can't
 * take a message", which is the opposite of true.
 *
 * A module CONSTANT, not a factory: `mentionRoster` is memoized on its inputs upstream, and a fresh
 * object per call would defeat that for the picker's rows.
 */
export const SPARKLE_MENTION_AGENT: MentionAgent = {
  id: SPARKLE_MENTION_ID,
  name: SPARKLE_MENTION_NAME,
  projectId: "",
  // Read only by `withMentionLabels`, and only in the collision case: a build agent that a human
  // also named "Sparkle" makes both addresses ambiguous, and the two then read as
  // `@Sparkle (the concierge)` and `@Sparkle (whatever project)`. Rare, and correct when it happens.
  projectName: "the concierge",
  band: "done",
  canAcceptInput: true,
};

/** Does this mention address the concierge rather than a build agent? The one place the id is
 *  compared, so no consumer has to re-spell the sentinel. */
export function isSparkleMention(mention: { agentId: string }): boolean {
  return mention.agentId === SPARKLE_MENTION_ID;
}

/**
 * THE ONE ROSTER every other function here should be handed: relevance-ordered and uniquely
 * addressable.
 *
 * This exists so the contract is kept by CODE rather than by prose. An earlier round documented the
 * ordering as the caller's job and named `ConciergeHost` as the enforcer — while
 * `orderMentionAgentsForResolve` had no production caller at all and `ComposeBox` resolved against
 * whatever list it was handed (roborev 54555). A rule that decides which terminal a message lands
 * in cannot live in a comment naming someone else. `ComposeBox` calls this once, memoized, and uses
 * the result for the picker, for resolving a send, and for Backspace alike — so there is no roster
 * in play anywhere that has skipped either step.
 *
 * The empty query is load-bearing and reads as a mistake inlined: it means "filter nothing, order
 * everything", which is exactly what a resolve pass wants and exactly what a reader deletes.
 *
 * ══ THE CONCIERGE IS IN HERE, AND IT BELONGS IN *THIS* FUNCTION ══════════════════════════════════
 * `SPARKLE_MENTION_AGENT` is appended to whatever the caller hands over, so `@Sparkle` is offered by
 * the picker, drawn as a pill, and resolved by a send on exactly the same terms as any build agent.
 *
 * The alternative — leave this function agent-only and add the concierge in a second, composer-local
 * roster — was rejected for the reason this function exists at all (roborev 54555). Its whole job is
 * that there is no roster in play anywhere that has skipped a step, and two near-identical roster
 * builders is precisely how one consumer ends up resolving against a list the others don't have. A
 * mention that the picker offers but a send cannot resolve is the silent wrong-aim class of bug.
 *
 * Consequence worth stating: typing a bare `@` in a workspace with NO build agents now opens the
 * picker with one row instead of not opening at all. That is right — under a mount, plain text goes
 * to the patched terminal and `@Sparkle` is how you reach the concierge, so the concierge must be
 * the one thing that is always addressable.
 */
export function mentionRoster(
  agents: readonly MentionAgent[],
  preferredId?: string | null,
): MentionAgent[] {
  return withMentionLabels(
    orderMentionAgents([...agents, SPARKLE_MENTION_AGENT], "", preferredId),
  );
}

// ══ EDITING ══════════════════════════════════════════════════════════════════════════════════════

/** The result of a text edit that also has to move the caret. */
export interface MentionEdit {
  text: string;
  caret: number;
}

/**
 * Replace the in-progress query at `anchor` with the chosen agent's literal, plus one trailing
 * space.
 *
 * The trailing space is load-bearing twice over: it puts the caret where the user's next word goes
 * (nobody wants to press space themselves after picking from a list), and it terminates the mention
 * so the very next character typed cannot extend the name into something that no longer matches any
 * agent — which, under this module's derive-from-text rule, would silently drop the aim.
 */
export function insertMention(
  text: string,
  anchor: number,
  caret: number,
  agent: MentionAgent,
): MentionEdit {
  const literal = `${MENTION_SIGIL}${labelOf(agent)} `;
  const next = text.slice(0, anchor) + literal + text.slice(caret);
  return { text: next, caret: anchor + literal.length };
}

/** A dictated segment that turned out to be ADDRESSED to the concierge. */
export interface DictatedAddress {
  /** The words after the address — what the message actually says, with the vocative comma the
   *  speaker paused for removed. Empty when the whole segment was just the name. */
  rest: string;
}

/**
 * Is this dictated segment addressing the concierge — i.e. should the word "sparkle" become an
 * `@Sparkle` pill instead of landing as prose?
 *
 * ══ THE FOUNDER'S ASK, AND THE TRAP INSIDE IT ═══════════════════════════════════════════════════
 * "While dictating, saying the word 'sparkle' should insert an @Sparkle pill, so speech and typing
 * produce the same artifact." You cannot say "@" out loud, so without this there is no spoken way to
 * reach the concierge once the column is patched to a terminal — every dictated word would go to the
 * agent's PTY.
 *
 * But "sparkle" is also this app's own name, so it turns up in ordinary dictated prose ("the sparkle
 * desktop app keeps crashing"). Pilling EVERY utterance of it would mangle that prose, so the rule
 * has to be narrow. It is exactly one thing:
 *
 *   **The segment must BEGIN the message, and "sparkle" must be its first word.**
 *
 * That is the ADDRESSING POSITION the rest of this module already recognises. `mentionFreeText` and
 * `ConciergeHost.send` both treat `mentions[0]` — the FIRST span — as the envelope, and every other
 * span as content. So the head of the message is where an address goes, and a "sparkle" anywhere else
 * is a word in a sentence. Concretely:
 *
 *   • "Sparkle, what's the status?" into an empty box  → `@Sparkle what's the status?`   ✅ pill
 *   • "the sparkle desktop app is slow"                → unchanged, plain prose           ✅ no pill
 *   • "…and tell sparkle about it" appended to a draft → unchanged, plain prose           ✅ no pill
 *
 * ══ WHY THE WAKE AND STOP PHRASES CANNOT COLLIDE WITH THIS ═════════════════════════════════════
 * This is the part worth checking before touching the rule, because it looks like a collision and is
 * not. The shipped wake phrase is "Hey Sparkle" and the stop phrase is "Sparkle, stop"
 * (voice/voiceDefaults), and BOTH are consumed by `voice/wakeMachine.advance` — which strips the
 * matched phrase and hands on only the remainder — BEFORE anything reaches a composer's insert
 * target. So by the time a segment arrives here, "Hey Sparkle, move it 5px" is already "move it 5px",
 * and "Sparkle, stop" is already "" (and dictation has gone passive). Neither can be seen by this
 * function, so neither can be turned into a pill.
 *
 * The one residual gap is a user who REBINDS their wake word to a bare "Sparkle": `advance` would
 * then strip it as the wake phrase and no pill would be inserted. That is a degradation to today's
 * behaviour, not a corruption of it, and it is the wake word doing its job.
 *
 * ══ THE REMAINING FALSE POSITIVE, AND WHY IT IS THE SAFE ONE ═══════════════════════════════════
 * An utterance that BEGINS with "Sparkle" used as a noun — "Sparkle desktop needs a fix" as the first
 * thing said into an empty box — does get a pill. Two things make that the right trade:
 *
 *   1. It is VISIBLE and cheap to undo. The pill is drawn in the composer (./MentionMirror) before
 *      anything is sent, and one Backspace at its edge deletes the whole token (`backspaceMention`).
 *   2. It fails toward the RECOVERABLE destination. A pill routes the message to the concierge, which
 *      writes nothing to a terminal; a MISSED pill routes it into a live PTY, which cannot be walked
 *      back. Requiring the vocative comma would have cut the false positives — but Deepgram's
 *      punctuation is not reliable, so "Sparkle what's the status" would have missed, and that error
 *      lands on the irreversible side.
 *
 * Pure and total: returns null for every segment this does not apply to, which is most of them.
 */
export function dictatedSparkleAddress(current: string, segment: string): DictatedAddress | null {
  // The box must be EMPTY for this segment to be the head of the message. Whitespace counts as
  // empty — a stray space is not something the user is addressing anybody with.
  if (current.trim() !== "") return null;
  const said = segment.trimStart();
  // The name, then a boundary that is not more name. The lookahead is what keeps "Sparkle's" and
  // "Sparklers" out: an apostrophe or a letter means the speaker said a different word, and pilling
  // the first seven characters of it would leave a dangling "'s" after the address.
  const head = /^sparkle(?=$|[\s,.:;!?])/i.exec(said);
  if (!head) return null;
  // Drop the vocative punctuation the speaker paused for: "Sparkle, move it" addresses the concierge
  // and says "move it", not ", move it". `insertMention` supplies the single separating space.
  return { rest: said.slice(head[0].length).replace(/^[\s,.:;!?]+/, "") };
}

/**
 * Backspace at a mention's trailing edge deletes the WHOLE mention.
 *
 * Returns null when the caret is not there, meaning "let the textarea do its normal thing".
 *
 * Without this the first Backspace after a pill eats one character of the name, which under the
 * derive-from-text rule instantly stops it being a mention — so the pill disappears from the thread
 * preview and the aim is silently dropped, while the composer still shows something that LOOKS like
 * `@Blueprint UI/U`. Deleting the whole token is both what every other mention UI does and the only
 * behaviour that keeps "what you see is what it aims at" true through an edit.
 *
 * The trailing space {@link insertMention} adds counts as part of the token: with the caret after
 * `@Kraken Auth `, one Backspace should not leave a lone space where a pill was.
 */
export function backspaceMention(
  text: string,
  caret: number,
  agents: readonly MentionAgent[],
): MentionEdit | null {
  // Allow the caret to sit one space past the mention's end — that is where it lands after a pick.
  const spanEnd = text[caret - 1] === " " ? caret - 1 : caret;
  const span = findMentionSpans(text, agents).find((s) => s.end === spanEnd);
  if (!span) return null;
  return { text: text.slice(0, span.start) + text.slice(caret), caret: span.start };
}

/**
 * A one-message roster, synthesised from the mentions that message ALREADY resolved to.
 *
 * The point is to reuse the one matcher rather than growing a second, laxer way to find a mention
 * in a string. Both places that work from a finished message — the bubble drawing its pills, and
 * the host stripping the address off the PTY payload — need to locate the same spans the composer
 * found, boundary checks and longest-name-first included. Feeding {@link findMentionSpans} a roster
 * of exactly the resolved agents does that with no second implementation to keep in step.
 *
 * The filler fields are never read on this path: `findMentionSpans` uses `id` and `name` only.
 */
export function rosterFromMentions(mentions: readonly ConciergeMention[]): MentionAgent[] {
  return mentions.map((m) => ({
    id: m.agentId,
    name: m.name,
    projectId: "",
    projectName: "",
    band: "running" as StatusBand,
    canAcceptInput: false,
  }));
}

/**
 * Split `text` into plain runs and mention pills, for rendering.
 *
 * Driven by the mentions RECORDED ON THE MESSAGE, not by a live roster lookup: a sent message is
 * history, and an agent closed afterwards must still render as the pill the user addressed rather
 * than decaying into raw `@text` in a thread they are scrolling back through.
 */
export function splitMentionText(
  text: string,
  mentions: readonly ConciergeMention[],
): ({ kind: "text"; text: string } | { kind: "mention"; text: string; agentId: string })[] {
  if (mentions.length === 0) return text ? [{ kind: "text", text }] : [];
  const spans = findMentionSpans(text, rosterFromMentions(mentions));
  const out: ReturnType<typeof splitMentionText> = [];
  let at = 0;
  for (const s of spans) {
    if (s.start > at) out.push({ kind: "text", text: text.slice(at, s.start) });
    out.push({ kind: "mention", text: text.slice(s.start, s.end), agentId: s.agentId });
    at = s.end;
  }
  if (at < text.length) out.push({ kind: "text", text: text.slice(at) });
  return out;
}
