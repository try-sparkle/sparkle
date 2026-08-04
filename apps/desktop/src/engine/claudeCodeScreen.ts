// IS THIS ALTERNATE-SCREEN TERMINAL A BUSY CLAUDE CODE, OR AN ACTUAL FULL-SCREEN APP?
//
// Pure, so the answer is testable without a PTY or an xterm — the convention every load-bearing
// guard in this codebase follows (cf. `screenClassifier`, `dictationTerminalRoute`).
//
// ══ THE QUESTION THIS EXISTS TO SPLIT (bead sparkle-v7k3y) ═══════════════════════════════════════
// `dictationTerminalRoute`'s alternate-screen guard refuses a write whenever xterm's alternate
// buffer is active, and its header claims the buffer type "answers this exactly, with no content
// heuristic to fool." That claim is the defect. The buffer type answers **is the alternate screen in
// use**, which is NOT the same question as **will my text be read as commands**.
//
// Claude Code holds the alternate buffer for its ordinary busy state — the same buffer `vim` and
// `less` use — and Claude Code is what every agent in this app runs. So the guard fired on the single
// most common state in the app. The founder, mounted to an agent showing
//
//     Running 1 shell command · 1m 24s
//     $ cd ".../pr1104" && bash scripts/tests/run.sh … (1m 23s)
//     (ctrl+b to run in background)
//
// was told that agent "has a full-screen app open" and had his message bounced. It is not in an
// editor. It is at its own prompt, busy, and typing into that pane would have QUEUED the message —
// which is exactly what he wanted ("give me an update after you do").
//
// ══ WHY A CONTENT HEURISTIC IS ACCEPTABLE HERE, WHEN THE HEADER WARNED AGAINST ONE ═══════════════
// The warning was about using content to find DANGER. This uses content to find SAFETY, and the two
// have opposite failure profiles under the same evidence:
//
//   • A false NEGATIVE (a real Claude Code we fail to recognise) costs one refusal — the exact
//     behaviour shipping today, so this can only ever be an improvement over it.
//   • A false POSITIVE (a `vim` session we mistake for Claude Code) puts a sentence on that screen.
//
// ══ WHAT A FALSE POSITIVE ACTUALLY COSTS — IT IS PASTED *AND SUBMITTED* (roborev 57704) ═════════
// An earlier draft of this header priced the false positive as "types a sentence into `vim` normal
// mode". That is the DICTATION contract ("type, do not submit", `dictationTerminalRoute`), and it
// undersold the risk: `terminalWriteRefusal` is shared with the concierge composer and the `@Name`
// mention path, and `services/conciergeDispatch` pastes AND submits via `submitPrompt`. So on the
// composer path a false positive is a pasted-and-ENTERED line in `vim` normal mode — `d` deletes,
// `2` counts, `p` pastes, and Enter runs whatever that composed. The threshold below is calibrated
// against that, the worst caller, not against the gentlest one.
//
// ══ THE THRESHOLD: THE COMPOSER BOX IS MANDATORY, PLUS ONE MORE FAMILY ══════════════════════════
// A flat "any two of four families" was the first cut and it was not safe enough. Two of the four
// can co-fire on a DOCUMENT — a pager showing a pasted Claude Code transcript has the line-start
// `⏺`/`⎿` glyphs AND a quoted status bar, which is precisely the fool this module claims to exclude.
//
// So family D — the structural composer box — is REQUIRED, and one of A/B/C must corroborate it.
// D is the only family that is evidence of a LIVE INTERACTIVE TUI rather than of text ABOUT one:
// it is a prompt glyph sandwiched between two full-width rules, in that order, which prose does not
// produce by accident. Quoting Claude Code's output into a file reproduces its glyphs and its status
// bar easily; reproducing a well-formed composer box at the bottom of the screen is another matter.
//
// The patterns are deliberately narrow for the same reason (roborev 57704): no bare "to run in
// background" (ordinary English in shell docs), no `_` in a rule line (20 underscores is a common
// ASCII separator), and no bare `>` as a prompt-with-text glyph (that is every markdown blockquote).

/** ══ FAMILY A — THE BUSY STATUS BAR ═════════════════════════════════════════════════════════════
 *  What Claude Code draws WHILE WORKING, which is the state this whole module is about.
 *
 *  `esc to interrupt` is shared with `engine/statusEngine`'s WORKING_PATTERNS, deliberately: both
 *  answer "is this Claude Code, mid-turn", and two spellings of that would drift. `ctrl+b to run in
 *  background` is the affordance from the founder's own screenshot — it is drawn only while a shell
 *  command is running, and no pager or editor has any reason to render it. */
const BUSY_STATUS: RegExp[] = [
  /\besc to interrupt\b/i,
  // The `ctrl+b` form ONLY. A bare "to run in background" was here and was removed (roborev 57704):
  // it is ordinary English, and it appears in shell documentation and man pages — exactly the text a
  // pager would be showing when this guard is asked.
  /\bctrl\+b to run in background\b/i,
];

/** ══ FAMILY B — THE TOOL-CALL GLYPHS ════════════════════════════════════════════════════════════
 *  `⏺` opens a tool call and `⎿` opens its result — see APPROVAL_2_1_220 and IDLE_AFTER_TURN_2_1_220
 *  in `capturedScreens.fixture.ts`, where both appear verbatim.
 *
 *  ANCHORED TO LINE START, so a `⏺` inside prose (a bullet in a README someone is paging through)
 *  does not count. These are structural: Claude draws them in the left gutter. */
const TOOL_GLYPH: RegExp[] = [/^\s*⏺\s/m, /^\s*⎿\s/m];

/** ══ FAMILY C — THE PERSISTENT CHROME BARS ══════════════════════════════════════════════════════
 *  The always-on footer lines. Every entry here is pinned by `NON_PICKER_HINT_LINES_2_1_220` in the
 *  captured fixtures as REAL Claude Code chrome — that list exists to keep the picker matcher from
 *  matching them, which makes it an unusually well-evidenced catalogue of "things only Claude Code
 *  draws". Reused rather than re-derived for that reason. */
const CHROME_BAR: RegExp[] = [
  /\?\s+for shortcuts\b/i,
  /\bbypass permissions on\b/i,
  /\bmanual mode on\b/i,
  /\btranscript saving is off\b/i,
  /\bclaude is using your computer\b/i,
];

/** ══ FAMILY D — THE COMPOSER BOX ════════════════════════════════════════════════════════════════
 *  Claude Code's input line is a `❯ ` (or `>` ) prompt sandwiched between two full-width box rules —
 *  see IDLE_AFTER_TURN_2_1_220, where the three lines are consecutive.
 *
 *  STRUCTURAL, not lexical: it matches the ARRANGEMENT rather than any wording, so it survives the
 *  copy drift the rest of this file's families are exposed to. A rule line is a run of box-drawing
 *  characters and nothing else, which prose cannot accidentally produce. */
/** A full-width horizontal rule: box-drawing characters and NOTHING else. Prose cannot produce one
 *  accidentally, which is what makes the sandwich below structural rather than lexical. */
//  `_` IS NOT IN THIS CLASS (roborev 57704): a run of 20+ underscores is a common ASCII separator in
//  plain text files, so accepting it would let an ordinary document form the sandwich below.
const RULE_LINE = /^\s*[─━═]{20,}\s*$/;
/** The bare-rule form (2.1.220, `IDLE_AFTER_TURN_2_1_220`): the prompt sits on its own line. */
//  The with-text arm requires `❯`/`›` and NOT a bare `>` (roborev 57704) — `> some text` is every
//  markdown blockquote ever written, and this arm is the one that runs against arbitrary prose. The
//  bare arm still accepts a lone `>`, which is a whole line containing one character and which still
//  has to sit between two box rules to count for anything. Same reasoning `screenClassifier`'s
//  SELECTION_CURSOR already applies to its own glyph set.
const PROMPT_LINE = /^\s*[❯›>]\s*$|^\s*[❯›]\s+\S/;

/** ── THE ROUNDED-BOX FORM ────────────────────────────────────────────────────────────────────────
 *  Other Claude Code builds draw the composer as a bordered box rather than two bare rules:
 *
 *      ╭──────────────────────────────╮
 *      │ >                            │
 *      ╰──────────────────────────────╯
 *
 *  Both forms are the same affordance, so both belong to family D. The middle line must be a border,
 *  a PROMPT GLYPH, and then nothing but padding to the closing border — which is what keeps this off
 *  every other bordered TUI. `lazygit`'s panels are the same box characters, but their contents are
 *  filenames and branch names, never a lone `>`; requiring the prompt to be the only occupant is the
 *  whole discriminator. */
const BOX_TOP = /^\s*[╭┌][─━═]{10,}[╮┐]\s*$/;
const BOX_BOTTOM = /^\s*[╰└][─━═]{10,}[╯┘]\s*$/;
const BOX_PROMPT = /^\s*[│|]\s*[❯›>]\s*[│|]?\s*$|^\s*[│|]\s*[❯›>]\s+\S.*[│|]\s*$/;

function hasComposerBox(lines: readonly string[]): boolean {
  for (let i = 0; i + 2 < lines.length; i += 1) {
    const top = lines[i] ?? "";
    const mid = lines[i + 1] ?? "";
    const bottom = lines[i + 2] ?? "";
    if (RULE_LINE.test(top) && PROMPT_LINE.test(mid) && RULE_LINE.test(bottom)) return true;
    if (BOX_TOP.test(top) && BOX_PROMPT.test(mid) && BOX_BOTTOM.test(bottom)) return true;
  }
  return false;
}

function matchesAny(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((re) => re.test(text));
}

/**
 * How many INDEPENDENT families of Claude Code evidence this screen shows.
 *
 * Exported for the tests, which assert the count rather than only the boolean — a change that
 * silently collapsed two families into one would still satisfy `>= 2` from a single marker, and that
 * is exactly the weakening this module must not accept quietly.
 */
export function claudeCodeMarkerFamilies(snapshot: string): number {
  const lines = snapshot.split("\n");
  let n = 0;
  if (matchesAny(BUSY_STATUS, snapshot)) n += 1;
  if (matchesAny(TOOL_GLYPH, snapshot)) n += 1;
  if (matchesAny(CHROME_BAR, snapshot)) n += 1;
  if (hasComposerBox(lines)) n += 1;
  return n;
}

/** Is the LIVE-TUI family present? Split out because it is not one vote among four — it is the
 *  precondition. See the header: it is the only family that distinguishes a running Claude Code from
 *  a document quoting one. */
export function hasClaudeCodeComposerBox(snapshot: string): boolean {
  return hasComposerBox(snapshot.split("\n"));
}

/**
 * Is this screen CONFIDENTLY Claude Code's own TUI?
 *
 * Two independent families, for the asymmetry argued in the header: a miss costs one refusal, a
 * false positive types into `vim`. Callers must treat `false` as "assume a real full-screen app",
 * never as "assume safe".
 *
 * THIS DOES NOT MEAN THE SCREEN IS SAFE TO WRITE TO. It means the alternate buffer is not evidence
 * of danger here. Claude Code can perfectly well be showing a permission dialog or a picker, and
 * that is a different guard's question — `screenBlocksWrite` still has to run, and in
 * `terminalWriteRefusal` it does. Do not let a true from this function stand in for that check.
 */
export function isClaudeCodeScreen(snapshot: string): boolean {
  // The composer box is REQUIRED, not merely one of the two. A pasted transcript in a pager carries
  // Claude's glyphs and its status bar — two families — without being Claude Code at all.
  if (!hasClaudeCodeComposerBox(snapshot)) return false;
  return claudeCodeMarkerFamilies(snapshot) >= 2;
}
