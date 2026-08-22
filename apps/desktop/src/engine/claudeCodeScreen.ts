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

// The footer matcher and the below-footer walk are OWNED BY `screenClassifier` and imported, never
// re-derived here. That file is this codebase's single retune point for Claude Code TUI drift, and
// a second copy of "what marks a picker" is the desync its own header forbids.
import { pickerFooterSpan, nothingUnrecognizedBelowFooter } from "./screenClassifier";
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

/** The status glyphs Claude Code opens its chrome bars with.
 *
 *  DECLARED HERE, ABOVE FAMILY C, because `PERMISSION_MODE_BAR` below needs it. It used to sit
 *  between families C and D, next to its other consumer (`CHROME_BAR_OPENS`); moving it up is a
 *  pure relocation — the value is unchanged and both consumers still read this one definition. */
const STATUS_GLYPHS = "\\u26a0\\u23f8\\u23f5\\u23f4\\u25b6\\u25c6\\u25cf\\u2713\\u2717\\u273b\\u273d\\u2722";

/** ══ THE PERMISSION-MODE BAR, MATCHED BY SHAPE RATHER THAN BY MODE NAME (2026-08-20) ════════════
 *  Claude Code draws the active permission mode as the bottom-most chrome line:
 *
 *      ⏸ manual mode on · ? for shortcuts · ← for agents
 *      ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents
 *      ⏸ plan mode on (shift+tab to cycle) · ← for agents
 *      ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents
 *
 *  ══ WHY THIS REPLACED TWO LITERALS, AND WHAT THAT COST ════════════════════════════════════════
 *  Family C named exactly two of those modes — `bypass permissions on` and `manual mode on`. Claude
 *  Code has since added plan, accept-edits and auto, and NONE of them matched. Plan's bar drops
 *  `? for shortcuts` too, so family C scored ZERO: a live agent in plan or accept-edits mode showed
 *  the composer box and nothing else, which is 1 against a threshold of 2. Every consequence is
 *  fail-CLOSED — `terminalWriteRefusal` answers `alternate-screen`, the picker cannot be read, and
 *  the row still renders "Needs you" over a pane the founder sees nothing in. That is the bug this
 *  pattern exists to end, and it rotted SILENTLY because the two surviving literals are the two
 *  modes most sessions run in.
 *
 *  ══ WHY THE GLYPH IS REQUIRED, AND WHY THAT KEEPS IT SAFE ═════════════════════════════════════
 *  The mode WORDS alone would be far too weak — "plan mode on" is ordinary English. What makes this
 *  Claude Code's own chrome is that a STATUS GLYPH sits immediately before the phrase, with nothing
 *  but the mode's own lowercase words between glyph and `on`. Prose does not open a sentence with
 *  `⏵⏵`. The words themselves are left unenumerated on purpose: a sixth permission mode gets the
 *  same glyph and the same trailing `on`, so it is recognised the day it ships rather than the day
 *  someone notices a fleet has gone dark.
 *
 *  BOUNDED QUANTIFIER, deliberately, for the reason `statusEngine`'s token pattern records at
 *  length: `[a-z ]+` before a literal is a backtracking trap on a long lowercase run, and this
 *  pattern is run over whole screens on a hot path. `{1,28}` is comfortably past the longest real
 *  mode phrase (`bypass permissions`, 18) and bounds the work at each start position.
 *
 *  IT IS NOT ANCHORED, matching every other entry in `CHROME_BAR` — `CHROME_BAR_OPENS` re-anchors
 *  the whole list by wrapping each source in `^…`, so a `^` here would produce `^…^…` and silently
 *  never match, quietly weakening the narrow-composer arm instead of strengthening it. */
const PERMISSION_MODE_BAR = new RegExp(`[${STATUS_GLYPHS}][${STATUS_GLYPHS}]?\\s+[a-z][a-z ]{1,28}\\son\\b`, "i");

/** ══ FAMILY C — THE PERSISTENT CHROME BARS ══════════════════════════════════════════════════════
 *  The always-on footer lines. Every entry here is pinned by `NON_PICKER_HINT_LINES_2_1_220` in the
 *  captured fixtures as REAL Claude Code chrome — that list exists to keep the picker matcher from
 *  matching them, which makes it an unusually well-evidenced catalogue of "things only Claude Code
 *  draws". Reused rather than re-derived for that reason. */
const CHROME_BAR: RegExp[] = [
  /\?\s+for shortcuts\b/i,
  // The two mode literals that used to live here — `bypass permissions on` and `manual mode on` —
  // are subsumed by this one structural pattern, which also covers the three modes they missed.
  PERMISSION_MODE_BAR,
  /\btranscript saving is off\b/i,
  /\bclaude is using your computer\b/i,
  // ── THE PASTE HINT, WHICH REPLACES THE BAR ABOVE RATHER THAN JOINING IT ──────────────────────
  // Captured in CLAUDE_COMPOSER_PASTED_TEXT_2_1_231. When a paste lands in the composer, Claude
  // Code swaps the persistent chrome line for this hint. Without it, a pasted-and-unsubmitted
  // message leaves the composer box as the ONLY family on the screen and `isClaudeCodeScreen`'s
  // `>= 2` fails — on precisely the state `services/conciergeDispatch` creates when its own paste
  // does not submit. It is an Ink affordance with no reason to appear in a document a pager shows.
  //
  // THE SIBLING MARKER `[Pasted text #N]` IS DELIBERATELY *NOT* HERE (roborev 63610, Medium). It
  // was, and that was a hole: Claude Code renders it INSIDE the box, on the prompt line itself, so
  // counting it here collapses family C into family D — the precise weakening
  // `claudeCodeMarkerFamilies`' own doc warns about, where `>= 2` is satisfied by a single marker.
  // A pager showing a document that QUOTES a composer capture (a rule, `❯ [Pasted text #1] …`, a
  // closing rule) would then score 2 and be written into. This hint sits BELOW the closing rule,
  // which is what makes it independent evidence rather than box content.
  /\bpaste again to expand\b/i,
];

/** `CHROME_BAR`, re-anchored to the START of a string, tolerating a leading status glyph.
 *
 *  ══ WHY THE NARROW ARM NEEDS ITS OWN ANCHORING (roborev 64487, Medium) ═════════════════════════
 *  `CHROME_BAR`'s entries are UNANCHORED substring tests, so "the rejoined tail matches one" is a
 *  weaker claim than "the tail IS Claude's status bar" — a document whose prose happens to quote
 *  the phrase clears it. The previous cut bought that back by demanding the FIRST row below the box
 *  open with `AMBIENT_CHROME_LINE`, and that gate is wrong at this width for the same reason family
 *  C is: Ink wraps the bar, and several of Claude's real bars have a first row of PLAIN TEXT.
 *  `capturedScreens.fixture.ts` holds two verbatim — `  paste again to expand` and `Claude is using
 *  your computer · press Esc to stop` — whose first wrapped rows are `paste again` and `Claude is`.
 *  Neither carries a glyph, a rule or a caret, so the arm could never fire on them, and the paste
 *  hint is precisely the state `services/conciergeDispatch` creates when its own paste does not
 *  submit — the founder's pane refused again, for the bug this arm exists to close.
 *
 *  Anchoring the JOIN instead keeps the strength and drops the false negative: the tail must OPEN
 *  with one of Claude's own phrases (after optional whitespace and an optional status glyph), which
 *  a document's tail — starting with its own text — does not. `press ? for / shortcuts to / see the
 *  rest` still fails, because its join begins with `press`. */
/** The status glyphs Claude Code opens its bar with, as ESCAPES rather than literals — the
 *  glyph-icon ratchet reads a literal class as one more affordance drawn with a character, and these
 *  are bytes we RECOGNIZE, not bytes we render (`sessionLimitScreen`'s own note).
 *
 *  `⏵`/`⏴` ARE THE VERSION-CURRENT SPELLING (roborev 64501, High). 2.1.220 drew
 *  `▶▶ bypass permissions on`; 2.1.231 draws `⏵⏴`'s `⏵⏵` — captured
 *  verbatim TWICE in `capturedScreens.fixture.ts`, from this app's own worktrees. Omitting it does
 *  not merely demote the box: the anchored join fails, `narrowBoxTerminatesGrid` answers `no`, the
 *  closing rule is rejected and family D is lost ENTIRELY, so the ordinary idle narrow pane on the
 *  current Claude version is refused — the exact bug this arm exists to remove, one glyph later.
 *
 *  `sessionLimitScreen`'s `AMBIENT_CHROME_LINE` carried the same gap. It is CLOSED — in the same
 *  change as its byte-for-byte `nudge_gate.rs` port, as that drift test requires (roborev 64564).
 *  This note said "NOT fixed here" for one commit and was left standing after the fix, which is the
 *  same stale-justification defect the reviews above charged this branch with (roborev 64577). */
// `STATUS_GLYPHS` now lives above FAMILY C, where `PERMISSION_MODE_BAR` needs it. Same value, one
// definition — this comment marks where it used to be so its `⏵`/`⏴` provenance note above still
// reads in place.

const CHROME_BAR_OPENS: readonly RegExp[] = CHROME_BAR.map(
  (re) => new RegExp(`^[\\s${STATUS_GLYPHS}]*(?:${re.source})`, re.flags),
);

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
const RULE_LINE = /^\s*([─━═]{8,})\s*$/;

/** ── THE RULE IS DRAWN TO THE GRID, SO ITS LENGTH IS A CLAIM ABOUT THE PANE (bead sparkle-tbsvf) ──
 *  THE DEFECT THIS CLOSES. This threshold was a flat 20, and 20 box characters is not a property of
 *  Claude Code — it is a property of a terminal at least 20 columns wide. This app renders agent
 *  terminals far narrower than that, by its own measurements in two separate places: a pane that
 *  "fits to a tiny size (cols≈12)" (components/Terminal.tsx) and one given "a fit of cols=23 in a
 *  box that holds ~43" (bead sparkle-l2xgf). Below 20 columns family D — this module's ONLY proof
 *  of a live TUI — could not fire at all, so an ordinary idle Claude Code in a narrow pane scored
 *  one family and `isClaudeCodeScreen` called it `vim`. The founder's message came back "has a
 *  full-screen app open" from a pane he was looking straight at, and the answer to "why does THIS
 *  pane fail while the others pass" is simply that this one is narrower than the constant.
 *
 *  The same narrow-pane class was already fixed one module over: `engine/rejoinWrapped` exists
 *  because a picker footer "in a 13-column agent column landed on six rows" and defeated every
 *  line-anchored matcher (bead sparkle-99o9a). The READER was taught about narrow panes there; this
 *  predicate's own width assumption was left behind.
 *
 *  ══ WHY A SMALLER NUMBER ALONE WOULD BE THE WRONG FIX ═════════════════════════════════════════
 *  At 20 the length was doing real work: a 12-character run of `─` in a document at a wide grid is
 *  an ordinary ASCII separator, so lowering the floor outright would let a pager showing a QUOTED
 *  composer box clear family D — precisely the impostor this module's header is written around, and
 *  the one whose cost is a line pasted AND SUBMITTED into `less`.
 *
 *  So the wide case is left EXACTLY as it was, and the narrow case earns its standing the way
 *  families E and F already do — by POSITION rather than by shape. See {@link boxQualifies}. */
const WIDE_RULE_MIN = 20;

/** How many box-drawing characters `line` is, as a rule — or 0 when it is not a rule at all.
 *  A width rather than a boolean because the qualification below reasons about how wide the box is
 *  and whether its two rules AGREE, neither of which a predicate can report. */
function ruleWidth(line: string): number {
  return RULE_LINE.exec(line)?.[1]?.length ?? 0;
}
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
//  The same width reasoning as the bare-rule arm above, and the same floor: a border's length is a
//  claim about the pane, not about Claude Code. `WIDE_BOX_RULE_MIN` keeps the shipped behaviour for
//  a pane wide enough to have satisfied the old constant; anything narrower goes through
//  `boxQualifies` and has to terminate the grid.
const BOX_TOP = /^\s*[╭┌]([─━═]{6,})[╮┐]\s*$/;
const BOX_BOTTOM = /^\s*[╰└]([─━═]{6,})[╯┘]\s*$/;
const WIDE_BOX_RULE_MIN = 10;

function boxTopWidth(line: string): number {
  return BOX_TOP.exec(line)?.[1]?.length ?? 0;
}
function boxBottomWidth(line: string): number {
  return BOX_BOTTOM.exec(line)?.[1]?.length ?? 0;
}
const BOX_PROMPT = /^\s*[│|]\s*[❯›>]\s*[│|]?\s*$|^\s*[│|]\s*[❯›>]\s+\S.*[│|]\s*$/;

/** ══ FAMILY E — A LIVE DIALOG, WHICH IS WHAT REPLACES THE COMPOSER BOX ══════════════════════════
 *  THE DEFECT THIS CLOSES (bead sparkle-v7k3y, second occurrence). Family D was made MANDATORY as
 *  the one proof of a LIVE TUI — and it is exactly the element Claude Code REMOVES while it has a
 *  question up. `services/conciergeDispatch` already stated the consequence in its own comments:
 *  "Claude Code's permission dialog REPLACES the composer box … so on a permission prompt exactly
 *  one family survives (the tool-call glyphs) and the predicate returns false."
 *
 *  So the guard was strictest precisely when the agent was blocked, which is when a human most
 *  needs to reach it. Measured on one afternoon: nine consecutive `alternate-screen` refusals to a
 *  single agent across several hours, none of it in an editor or a pager; the same refusal blocked
 *  four other agents and produced a fleet-wide escalation storm blaming vim/less/htop.
 *
 *  ── WHY THIS IS STILL EVIDENCE OF A LIVE TUI, NOT OF TEXT ABOUT ONE ───────────────────────────
 *  Family D's whole argument is that a pasted transcript in a pager reproduces Claude's glyphs and
 *  status bar easily, and a well-formed composer box at the bottom of the grid is another matter.
 *  A live dialog earns the same standing through POSITION rather than shape: a picker footer that
 *  TERMINATES the grid — nothing below it but blanks, one closing border, and Claude's own ambient
 *  chrome — is a dialog waiting on an answer, because a dialog that has been answered scrolls and
 *  acquires output beneath it.
 *
 *  That is not a new rule invented here: `nothingUnrecognizedBelowFooter` is the same below-footer
 *  walk `screenAnswerable` already uses to decide whether a picker is live, and it is what keeps a
 *  pager out. A pager showing a transcript that happens to end at a footer still draws its OWN
 *  status row (`less`'s `:` prompt, a filename, a percentage), which is not ambient Claude chrome,
 *  so the walk rejects it. `vim` and `htop` never satisfy the footer grammar at all — htop's
 *  "F1Help F2Setup" carries no `<key> to <verb>` hint. */
/** ══ FAMILY F — THE BACKGROUND-TASK LIST, WHICH ALSO REPLACES THE COMPOSER (bead sparkle-tbsvf) ═══
 *  THE DEFECT THIS CLOSES. Claude Code draws a live roster of its own background subagents as a
 *  block of `◯ <kind>  <label>  <elapsed>` rows under a `⏺ <branch>` header — see the founder's own
 *  screenshot, transcribed below as `BACKGROUND_TASK_LIST`. `⏺ <branch>` alone trips family B, but
 *  one family is not enough, and this block is drawn in place of the ordinary composer the same way
 *  a permission dialog is (family E's own header explains that substitution) — so `hasComposerBox`
 *  reads false and a screen showing only this list scored 1, failing `isClaudeCodeScreen`. The
 *  concierge's own `send_to_agent_terminal`, aimed at this exact pane, was refused four times in a
 *  row with "has a full-screen app open" while the pane was doing nothing but listing its own
 *  subagents.
 *
 *  ── WHY A ROW HERE IS EVIDENCE OF A LIVE TUI, NOT OF TEXT ABOUT ONE ──────────────────────────────
 *  `◯` is not a glyph this codebase's prose or any captured impostor (vim, less, htop, lazygit) uses
 *  anywhere, and the ELAPSED-TIME SUFFIX is what makes the row structural rather than lexical: a
 *  document can easily quote a bullet character, but "some sentence … 21m 55s" at the end of a
 *  gutter-glyph line is Claude Code's own live clock, not prose. Anchored to line start for the same
 *  reason `TOOL_GLYPH` is.
 *
 *  ── WHY THIS STANDS ALONE, LIKE FAMILY E, RATHER THAN CORROBORATING FAMILY D ────────────────────
 *  Requiring the mandatory composer box here would fail on exactly the screen this family exists
 *  for: the one where the task list is what replaced it.
 *
 *  ── AND WHY IT STILL NEEDS `nothingUnrecognizedBelowFooter`, THE SAME WALK FAMILY E USES ────────
 *  A bare row match alone would be family D's original mistake repeated: this bead's own text
 *  reproduces `◯ general-purpose  Concierge agents as clickable rows  21m 55s` verbatim, so a pager
 *  displaying this file — or any doc quoting the founder's screenshot — trips the row pattern too.
 *  Position is what tells a LIVE list apart from a QUOTED one: Claude Code's list is always the
 *  last thing drawn while it is live, so requiring the LAST matching row to terminate the grid
 *  (nothing below it but blanks and Claude's own ambient chrome — which, notably, already includes
 *  a bare rule and an empty composer caret, so this still fires when the ordinary composer sits
 *  below the list) keeps a pager's trailing prose or `:` prompt out, exactly as it does for E. */
const BACKGROUND_TASK_ROW = /^\s*◯\s+\S.*\d+m\s*\d+s\s*$/;

function hasBackgroundTaskList(lines: readonly string[]): boolean {
  return backgroundTaskRowCount(lines) !== null;
}

/** How many subagents Claude Code is listing as live, or `null` when this is not a live list.
 *
 *  ── WHY A COUNT AND NOT JUST THE BOOLEAN ────────────────────────────────────────────────────────
 *  This roster is the ONLY on-screen evidence of the founder's second state — "sometimes I've
 *  noticed that it's waiting on the sub agents to finish, and it should again be green when that's
 *  happening". From the parent's own PTY that state is indistinguishable from doing nothing: no
 *  spinner, no output, no tool calls, for minutes. The rows ARE the work.
 *
 *  `services/backgroundTaskRegistry` stores a count, so this returns one rather than making the
 *  caller re-walk the grid. It is deliberately the SAME walk `isClaudeCodeScreen` already trusted —
 *  extracted, not copied, because a second matcher for these rows is a second thing to retune when
 *  the TUI moves (this file's own retune discipline).
 *
 *  ── `null` IS "NOT A LIVE LIST", WHICH IS NOT THE SAME AS ZERO ──────────────────────────────────
 *  `nothingUnrecognizedBelowFooter` is what separates Claude's live roster from a PAGER QUOTING one
 *  — this module's header notes that the bead describing this feature reproduces a row verbatim, so
 *  a doc on screen trips the row pattern. A quoted list must not park a count that paints a finished
 *  agent green forever. Position is the discriminator, exactly as it is for the dialog family. */
function backgroundTaskRowCount(lines: readonly string[]): number | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!BACKGROUND_TASK_ROW.test(lines[i] ?? "")) continue;
    if (!nothingUnrecognizedBelowFooter(lines, i)) return null;
    // Walk UP the contiguous block. Blank rows inside the list are tolerated; the first non-blank
    // line that is not a row ends it (in practice the `⏺ <branch>` header the list hangs under).
    let n = 0;
    for (let j = i; j >= 0; j--) {
      const row = lines[j] ?? "";
      if (BACKGROUND_TASK_ROW.test(row)) n++;
      else if (row.trim() !== "") break;
    }
    return n;
  }
  return null;
}

/** {@link backgroundTaskRowCount} over a rendered snapshot. See its header for why this is a count
 *  and why `null` is not zero. */
export function liveBackgroundSubagentCount(snapshot: string): number | null {
  if (!snapshot) return null;
  return backgroundTaskRowCount(snapshot.split("\n"));
}

function hasLiveDialog(lines: readonly string[]): boolean {
  // The LAST footer on the grid, matching the option parser's own rule: an earlier, already
  // answered dialog higher up is stale, and it is the bottom-most one that has to terminate the
  // screen for this to mean anything.
  for (let i = lines.length - 1; i >= 0; i--) {
    const span = pickerFooterSpan(lines, i);
    // `i + span - 1` is the footer's LAST line, not its first: a footer Ink wrapped onto two rows
    // would otherwise have its own continuation read as unrecognised output below it, which is the
    // precise mis-read roborev 61827 recorded against this same walk.
    if (span > 0) return nothingUnrecognizedBelowFooter(lines, i + span - 1);
  }
  return false;
}

/** ── THE COMPOSER HAS A BODY, AND IT IS USUALLY WHY THE BOX IS NOT THREE ROWS ────────────────────
 *  THE DEFECT THIS CLOSES (bead sparkle-v7k3y, third occurrence). This function used to require the
 *  box to be exactly three CONSECUTIVE rows — rule, prompt, rule. That is the shape of an EMPTY
 *  composer, and an empty composer is the only one any 2.1.220 capture in `capturedScreens.fixture`
 *  contains, so the entire suite was green against a predicate that could not recognise an input box
 *  with a MESSAGE in it.
 *
 *  A composer holding text is four or more rows, in two shapes both captured at 2.1.231:
 *
 *      ──────────…──────────              ──────────…──────────
 *      ❯ a message long enough to wrap    ❯ a short message
 *        onto a second row                                        ← a reserved blank row
 *      ──────────…──────────              ──────────…──────────
 *
 *  Family D is MANDATORY in `isClaudeCodeScreen`, so this made an agent UNRECOGNISABLE the moment
 *  anything was typed into it and left unsubmitted — a state THIS APP CREATES, via
 *  `services/conciergeDispatch` and the nudger. Every later write was refused `alternate-screen`,
 *  the auto-resume escalated after three failed reaches, and the agent stranded.
 *
 *  ── WHY THE BOUND, AND WHY IT IS NOT "ANY TWO RULES" ──────────────────────────────────────────
 *  The body is bounded because an unbounded one is not a box at all: any full-width rule near the
 *  top of a document, a `❯` line after it, and any second rule anywhere below would match, which is
 *  an ordinary page in a pager. A rule INSIDE the body also terminates it — Claude Code does not
 *  draw a full-width rule inside its own input box, so the first rule after the prompt is the
 *  closing one.
 *
 *  This widens family D rather than weakening the corroboration rule above it: a screen without a
 *  live dialog still needs the box PLUS one other Claude Code family, so a document that merely
 *  happens to form this shape does not clear `isClaudeCodeScreen` on its own. */
const MAX_COMPOSER_BODY_ROWS = 24;

/** ── THE BODY IS SHAPED, NOT MERELY BOUNDED (roborev 63601, Medium) ────────────────────────────
 *  A length cap alone is not enough, and the first cut of this fix had only that. "Any rule, a
 *  prompt, then ANY rows, then any rule" is a shape ordinary documents DO produce — a boxed shell
 *  transcript is literally `────…` / `❯ some command` / a few output rows / `────…`. Family D is
 *  this module's only proof of a LIVE TUI, so widening it that far would have let a pager clear the
 *  bar it exists to hold.
 *
 *  The captured screens say what the body actually looks like, and it is narrow: EVERY body row in
 *  `CLAUDE_COMPOSER_WRAPPED_TEXT_2_1_231`, `..._PADDED_TEXT_...` and `..._PASTED_TEXT_...` is either
 *  blank (the reserved row) or a leading-whitespace CONTINUATION of the prompt line. Claude Code
 *  indents the wrap; it never puts left-aligned text inside its own input box. Requiring that is
 *  what keeps the transcript above out, because command OUTPUT is flush left.
 *
 *  The row cap stays as a second, independent bound — a runaway scan is not something to leave to
 *  the shape rule — but it is no longer the only thing standing between a pager and a write. */
const CONTINUATION_ROW = /^\s+\S/;
const BLANK_ROW = /^\s*$/;

/** Is `line` a legal row INSIDE the bare-rule composer? */
function isComposerBodyRow(line: string): boolean {
  return BLANK_ROW.test(line) || CONTINUATION_ROW.test(line);
}

/** ── THE ROUNDED ARM GETS A REAL SHAPE TOO, AND A SMALLER BOUND (roborev 63623/63626) ──────────
 *  The first cut of this used `/^\s*[│|]/`, which FILTERS NOTHING: everything drawn between `╭…╮`
 *  and `╰…╯` starts with a side border by construction, so the rounded arm inherited the 12 → 24
 *  widening on a justification ("shape, not length, bounds false positives") that did not apply to
 *  it. A bordered TUI panel, or a document quoting a rounded-box composer, would have cleared
 *  family D over twice the previous window with nothing given back.
 *
 *  So the border must be followed by PADDING or an INDENTED continuation — the same distinction the
 *  bare-rule arm draws, which is what keeps flush-left command output out.
 *
 *  ── AND ITS BOUND STAYS AT 12, DELIBERATELY ──────────────────────────────────────────────────
 *  Every rounded-box screen this repo has captured is the tight three-row EMPTY composer, so unlike
 *  the bare-rule arm there is no capture showing what a rounded body actually looks like. The
 *  indent rule below is therefore reasoned, not measured, and a bound raised on reasoning alone is
 *  exactly what this review caught. If the guess is wrong the cost is a false NEGATIVE — one
 *  refusal, which is the behaviour shipping today — whereas a false positive is text pasted AND
 *  submitted into a pager. Re-measure against a real rounded-box build before widening it. */
const MAX_BOX_BODY_ROWS = 12;

/** ── AND "INDENTED" IS RELATIVE TO THE PROMPT, NOT TO THE BORDER (roborev 63700, Medium) ───────
 *  The first shaped cut of this was `/^\s*[│|]\s{2,}\S/` — "the left border, then at least two
 *  spaces, then content". That reads like the bare-rule arm's rule and is not: a bordered row also
 *  CLOSES with `│`, and that closing border is itself a `\S`, so the pattern collapsed into a
 *  statement about the PANEL'S OWN PADDING WIDTH. It rejected an impostor only when the impostor
 *  happened to use exactly one column of padding — which was true of the fixture written beside it
 *  and of nothing else. boxen's default `padding: 1` renders three columns; Ink and `cli-table`
 *  are similar. Every one of those panels put its output two spaces clear of the border and passed.
 *
 *  The bare-rule arm is safe because flush-left is an ABSOLUTE property of a row. Inside a box
 *  there is no absolute left edge — the impostor picks it — so the reference point has to be the
 *  one landmark the box supplies about itself: the column of its own `❯`. Claude Code indents a
 *  soft-wrapped continuation PAST the prompt marker, while a transcript's output lines up flush
 *  WITH the command it followed. That distinction is invariant under padding width, which is the
 *  whole reason to measure from the prompt.
 *
 *  Still reasoned rather than measured, for the same reason the bound below stays at 12: no capture
 *  in this repo shows a real rounded body. A wrong guess here costs a false NEGATIVE — one refusal,
 *  the behaviour that shipped for months — where a false positive is text pasted AND submitted into
 *  a pager. */
function isBoxBodyRowFor(promptLine: string): (line: string) => boolean {
  // `BOX_PROMPT` matched this line, so it contains a marker; `search` cannot come back -1 here.
  const promptCol = promptLine.search(/[❯›>]/);
  return (line: string): boolean => {
    if (BLANK_ROW.test(line)) return true;
    const borderCol = line.search(/[│|]/);
    if (borderCol < 0) return false;
    const afterBorder = line.slice(borderCol + 1);
    const offset = afterBorder.search(/\S/);
    // Padding only, with the closing border right-trimmed away — the composer's reserved blank row
    // reaches us in exactly this shape, since `snapshotScreen` trims.
    if (offset < 0) return true;
    return borderCol + 1 + offset > promptCol;
  };
}

/**
 * The INDEX of the closing rule that follows `promptIdx` within the body bound — or -1 when none
 * does. Every intervening row must be a legal body row; a row that is neither the closing rule nor
 * legal body ENDS the search, because the box is not a window to hunt in, it is a contiguous
 * structure.
 *
 * AN INDEX RATHER THAN A BOOLEAN, because {@link boxQualifies} has to look at the closing rule
 * itself — how wide it is, and what is drawn beneath it. A predicate cannot report either, and
 * re-finding the line at the call site would be a second scan free to disagree with this one.
 */
function closingRuleIdx(
  lines: readonly string[],
  promptIdx: number,
  widthOf: (line: string) => number,
  isBody: (line: string) => boolean,
  maxBodyRows: number,
  /** Would a rule at this index and width actually CLOSE this box? See {@link boxQualifies}.
   *
   *  ── WHY THE QUALIFICATION HAPPENS INSIDE THE SCAN (roborev 64464, Medium) ──────────────────
   *  It used to run at the call site, on whatever row the scan stopped at, and that silently
   *  REGRESSED the wide case this fix promised to leave alone. Lowering `RULE_LINE` to `{8,}` means
   *  an INDENTED run of 8-19 box characters — inside a composer holding a pasted message that
   *  happens to contain one — now matches `widthOf(...) > 0`, so the scan returned IT as the closing
   *  rule, the width check then failed it, and the box was abandoned before reaching the genuine
   *  120-column rule below. Under the old `{20,}` that same row was not a rule at all: it matched
   *  `CONTINUATION_ROW`, the scan carried on, and the box was found. A 120-column composer therefore
   *  lost family D — the exact refusal this commit exists to remove, reintroduced on the wide path.
   *
   *  Asking here restores that: a rule that does not qualify is reconsidered AS A BODY ROW and the
   *  scan continues, which is precisely what the single `{20,}` pattern used to do implicitly. */
  qualifies: (closeIdx: number, closeWidth: number) => boolean,
): number {
  const last = Math.min(promptIdx + 1 + maxBodyRows, lines.length - 1);
  for (let j = promptIdx + 1; j <= last; j += 1) {
    const line = lines[j] ?? "";
    const w = widthOf(line);
    if (w > 0 && qualifies(j, w)) return j;
    if (!isBody(line)) return -1;
  }
  return -1;
}

/** How many rows below the box may be Claude Code's own chrome. Mirrors `MAX_CHROME_BELOW_FOOTER`'s
 *  role in the walk this narrow arm stands in for, with room for the WRAP: one status bar that fits
 *  on a single row at 120 columns occupies several at 12, and there are two of them. */
const MAX_NARROW_CHROME_ROWS = 12;

/** HOW a narrow box terminated the grid, because the two ways are not equal evidence (roborev
 *  64487, High).
 *
 *  `chrome` — Claude's own status bar, rejoined, sits below the box. That is TWO independent things
 *  (the box, and the bar), which is what lets a narrow box stand alone in `isClaudeCodeScreen`.
 *  `bare` — nothing below the box, or only rules. The box still terminates the grid, but the only
 *  evidence on the screen is the box SHAPE, so it buys family D and nothing more.
 *  `no` — something below that is neither. Not a live composer at all. */
type NarrowTermination = "no" | "bare" | "chrome";

/**
 * Does this narrow box TERMINATE the grid — nothing below it but blanks and Claude's own chrome?
 *
 * ══ WHY NOT `nothingUnrecognizedBelowFooter`, WHICH IS WHAT FAMILIES E AND F USE ════════════════
 * Because that walk is strictly line-anchored, and on a narrow grid Claude Code's chrome does not
 * arrive on one line (roborev 64464, High). At 12 columns
 *
 *     "  ⏸ manual mode on · ? for shortcuts"
 *
 * is rendered as three rows, and only the FIRST carries the `⏸` that `AMBIENT_CHROME_LINE` matches.
 * The continuation rows — "mode on · ?", "for shortcuts" — are not a rule, not a bare caret, and
 * carry no status glyph, so the walk rejects them and the narrow arm could never fire on a real
 * narrow pane. The first cut of this fix passed its own tests only because its fixture supplied a
 * 36-column chrome row that a 12-column grid cannot render.
 *
 * `engine/rejoinWrapped` cannot help here and this file must not pretend otherwise: it rejoins rows
 * the TERMINAL wrapped, and Ink does its own wrapping, "emitting a real newline of its own. There is
 * no `isWrapped` to consult in that case, so the reader cannot help and the matcher has to"
 * (`screenClassifier`, bead sparkle-99o9a). `pickerFooterSpan` already grew a two-line join for
 * exactly this; this is the same accommodation, sized for a status bar rather than a footer.
 *
 * ══ WHAT KEEPS IT FROM ACCEPTING ANYTHING: THE ROWS ARE REJOINED AND THE *JOIN* MUST BE CHROME ══
 * Two earlier cuts of this were too weak, and both failures are worth recording because they are
 * the same mistake at different strengths.
 *
 * The first admitted a row whenever the row above it was "full". Wrong: Ink wraps at WORD
 * boundaries, so a wrapped row is normally SHORTER than the grid, not flush with it.
 *
 * The second tested only the FIRST row below the box against `AMBIENT_CHROME_LINE` and admitted the
 * rest behind a width bound — and that bound is VACUOUS in exactly the case this arm exists for
 * (roborev 64475, High). `gridWidth` is the box's own rule width, and a terminal wraps every
 * physical row at the PANE width, so on a pane as narrow as the rules NOTHING below can exceed it.
 * `AMBIENT_CHROME_LINE` is cheap to satisfy from ordinary text — any line opening with `●`, `⚠`, a
 * `─{4,}` divider or a lone `>` — so a pager running IN a narrow pane cleared the whole arm:
 *
 *     ────────────      ← the file's own separator, at a 12-column grid
 *     ❯
 *     ────────────
 *     ● note text       ← passes, being the first content row
 *     more prose        ← admitted unmatched
 *     :                 ← less's status row, admitted unmatched
 *
 * The rows below the box are therefore REJOINED — Ink split one logical status bar across them and
 * dropped the space at each break — and the JOIN has to OPEN with one of `CHROME_BAR`'s phrases,
 * Claude Code's own catalogue of status lines. (A third cut kept a per-row `AMBIENT_CHROME_LINE`
 * gate on the first row as well; that rejected Claude's own `paste again to expand` and `Claude is
 * using your computer` bars, whose first wrapped row is plain text — roborev 64487, Medium. The
 * anchoring moved onto the join, where the wrap cannot hide it: see `CHROME_BAR_OPENS`.) "The wrapped remainder of Claude's status bar" is then PROVEN rather
 * than assumed, which is what the second cut got wrong: `  ⏸ manual` + `mode on · ?` +
 * `for shortcuts` rejoins to a line `CHROME_BAR` recognises, while `● note text more prose :` and
 * `notes.md 62%` match nothing in it.
 *
 * A box with NOTHING below it still terminates the grid, and so does one followed only by rules —
 * neither is a document, and demanding a status bar there would reject a real screen. Those two are
 * reported as `bare` rather than `chrome`, because NO status bar was read on them: see
 * {@link NarrowTermination} and the standalone rule in `isClaudeCodeScreen`, which the distinction
 * exists to keep honest.
 *
 * The width bound is KEPT but is no longer the argument: it still rejects the wide-pager case
 * (trailing prose longer than the rules above it) cheaply, and it costs nothing when it cannot fire.
 */
function narrowBoxTerminatesGrid(
  lines: readonly string[],
  closeIdx: number,
  gridWidth: number,
): NarrowTermination {
  const below: string[] = [];
  for (let i = closeIdx + 1; i < lines.length; i++) {
    const line = (lines[i] ?? "").trimEnd();
    if (!line.trim()) continue;
    // A row wider than the rules means the rules are not the grid, so this box is being QUOTED
    // inside something wider. Cheap, and still right — just not sufficient on its own.
    if (line.length > gridWidth) return "no";
    if (below.length >= MAX_NARROW_CHROME_ROWS) return "no";
    below.push(line.trim());
  }
  // NOTHING BELOW, OR ONLY RULES: the box still terminates the grid — neither is a document, and
  // demanding a status bar here would reject a real screen. But it is termination WITHOUT PROOF of
  // chrome, so it is reported as `bare` and does not buy the standalone privilege; see
  // `isClaudeCodeScreen`.
  if (below.length === 0) return "bare";
  if (below.every((l) => RULE_LINE.test(l) || BOX_BOTTOM.test(l))) return "bare";
  // THE JOIN IS ANCHORED, NOT MERELY MATCHED (roborev 64487, Medium). See `CHROME_BAR_OPENS`: a
  // tail that only CONTAINS one of Claude's phrases inside prose is a document, while a tail that
  // OPENS with one is the wrapped remainder of the bar itself.
  //
  // A DIVIDER BETWEEN THE BOX AND THE BAR IS SKIPPED FIRST (roborev 64501, High). A leading rule is
  // already accepted as termination on its own (the `bare` branch above), so letting one push the
  // bar out of the anchor's reach would answer `no` — losing family D entirely — on a screen that a
  // rules-only tail would have kept.
  const firstNonRule = below.findIndex((l) => !RULE_LINE.test(l) && !BOX_BOTTOM.test(l));
  return matchesAny(CHROME_BAR_OPENS, below.slice(firstNonRule).join(" ")) ? "chrome" : "no";
}

/**
 * Is this well-formed box ALSO good enough evidence of a LIVE TUI?
 *
 * ══ THE WIDE ARM IS THE SHIPPED BEHAVIOUR, UNCHANGED ════════════════════════════════════════════
 * A box whose rules clear the old constant answers exactly as it did before this fix — including
 * requiring the CLOSING rule to clear it too, which the single shared `{20,}` pattern used to
 * enforce implicitly. Narrowing the floor must not quietly widen the wide case as a side effect.
 *
 * ══ THE NARROW ARM EARNS ITS STANDING BY POSITION, NOT BY SHAPE ═════════════════════════════════
 * Below the old constant a rule is no longer self-evidently the full width of a grid, so the shape
 * alone stops being proof — a document quoting a composer box draws the identical three rows. Two
 * further things are demanded, and between them they are what a quoted box cannot supply:
 *
 *   • THE TWO RULES MUST BE THE SAME WIDTH. Claude Code draws both to one grid, so they match by
 *     construction; an ASCII separator pair in prose has no reason to. Pinned on its own by the
 *     mismatched-rule impostor in `claudeCodeScreen.narrowPane.test.ts` (roborev 64464, Medium):
 *     without that case the termination rule below was rejecting every impostor single-handed and
 *     this conjunct could have been deleted with the suite still green.
 *   • THE BOX MUST TERMINATE THE GRID — nothing below it but blanks and Claude's own ambient
 *     chrome. Same argument families E and F make, and for the same reason: a live composer is the
 *     last thing Claude Code draws, while text ABOUT one has a document underneath it. A pager keeps
 *     going below the quoted box, or draws its own status row (`less`'s `:`, a filename, a
 *     percentage), and neither is Claude chrome. See {@link narrowBoxTerminatesGrid} for why this
 *     arm cannot call `nothingUnrecognizedBelowFooter` itself.
 *
 * A false NEGATIVE here still costs one refusal, which is the behaviour that shipped for months; a
 * false positive is a line pasted AND SUBMITTED into a pager. The asymmetry that governs every
 * threshold in this file governs this one too.
 */
function boxQualifies(
  lines: readonly string[],
  topWidth: number,
  closeIdx: number,
  closeWidth: number,
  wideMin: number,
  /** How wide the GRID is if this box spans it — which is not `topWidth` for the rounded form,
   *  whose match measures the run BETWEEN the two corner characters. Passing the inner width there
   *  understates the grid by two cells and rejects a chrome row that fits the pane perfectly. */
  gridWidth: number,
): BoxProof {
  if (topWidth >= wideMin) return closeWidth >= wideMin ? "wide" : "no";
  if (closeWidth !== topWidth) return "no";
  const how = narrowBoxTerminatesGrid(lines, closeIdx, gridWidth);
  return how === "chrome" ? "narrow-chrome" : how === "bare" ? "narrow-bare" : "no";
}

/** Which arm recognised the composer box, because the two are not interchangeable evidence.
 *
 *  ══ WHY THE CALLER MUST KNOW (roborev 64482, High) ═════════════════════════════════════════════
 *  The narrow arm proves itself with Claude's REJOINED STATUS BAR, and family C is a test for
 *  Claude's status bar. Counting both would let ONE piece of evidence satisfy `>= 2` — precisely
 *  the silent collapse `claudeCodeMarkerFamilies`' own doc says this module must never accept, and
 *  a narrow box would have corroborated itself. See `isClaudeCodeScreen` for how the two arms are
 *  scored instead. */
type ComposerBoxKind = BoxProof;

/** What a candidate box PROVED, not merely whether it qualified. `narrow-chrome` and `narrow-bare`
 *  are both a recognised composer box (family D either way); only the first carries the status bar
 *  that lets it stand alone. */
type BoxProof = "no" | "wide" | "narrow-bare" | "narrow-chrome";

function composerBoxKind(lines: readonly string[]): ComposerBoxKind {
  // The STRONGEST narrow proof seen so far. A screen may draw more than one narrow box (a quoted one
  // above the live one); the live one's chrome must not be lost to a bare sibling found later.
  let narrow: "no" | "narrow-bare" | "narrow-chrome" = "no";
  const record = (proof: BoxProof): boolean => {
    if (proof === "narrow-chrome") narrow = "narrow-chrome";
    else if (proof === "narrow-bare" && narrow === "no") narrow = "narrow-bare";
    return proof !== "no";
  };
  for (let i = 0; i + 2 < lines.length; i += 1) {
    const top = lines[i] ?? "";
    const mid = lines[i + 1] ?? "";
    const topRule = ruleWidth(top);
    if (topRule > 0 && PROMPT_LINE.test(mid)) {
      const qualifies = (close: number, width: number): boolean =>
        record(boxQualifies(lines, topRule, close, width, WIDE_RULE_MIN, topRule));
      if (
        closingRuleIdx(lines, i + 1, ruleWidth, isComposerBodyRow, MAX_COMPOSER_BODY_ROWS, qualifies) >= 0
      ) {
        if (topRule >= WIDE_RULE_MIN) return "wide";
      }
    }
    const topBox = boxTopWidth(top);
    if (topBox > 0 && BOX_PROMPT.test(mid)) {
      const isBody = isBoxBodyRowFor(mid);
      const qualifies = (close: number, width: number): boolean =>
        record(boxQualifies(lines, topBox, close, width, WIDE_BOX_RULE_MIN, topBox + 2));
      if (closingRuleIdx(lines, i + 1, boxBottomWidth, isBody, MAX_BOX_BODY_ROWS, qualifies) >= 0) {
        if (topBox >= WIDE_BOX_RULE_MIN) return "wide";
      }
    }
  }
  return narrow;
}

function hasComposerBox(lines: readonly string[]): boolean {
  return composerBoxKind(lines) !== "no";
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
  // ── FAMILY C STAYS LINE-ANCHORED, AND THAT IS DELIBERATE (roborev 64482, High) ─────────────────
  // It briefly also read the REJOINED tail, to stop it going blind on a narrow pane where Ink
  // breaks "manual mode on · ? for shortcuts" across rows. That reads as an improvement and is a
  // COLLAPSE: the narrow composer arm proves itself with that very same rejoined status bar, so one
  // piece of evidence would have been counted twice and `>= 2` satisfied by a single marker — the
  // exact weakening this function's own doc says must never pass quietly, and a narrow box would
  // have corroborated itself.
  //
  // The narrow pane keeps its answer without the double count: see `isClaudeCodeScreen`, where a
  // narrow box stands ALONE the way families E and F do, because its own proof already contains
  // both the box and the status bar.
  if (matchesAny(CHROME_BAR, snapshot)) n += 1;
  if (hasComposerBox(lines)) n += 1;
  // Family E counts as its own family, not merely as a substitute precondition. Without that, a
  // dialog that terminates the grid with no ambient chrome below it — the bare approval screen —
  // clears the live-TUI bar and then fails `>= 2` on the tool-call glyphs alone, which is the same
  // refusal arriving one line later.
  if (hasLiveDialog(lines)) n += 1;
  // Family F, same reasoning: a screen showing only the background-task list scores 1 on the
  // `⏺ <branch>` header (family B) alone without this, which is the exact gap sparkle-tbsvf found.
  if (hasBackgroundTaskList(lines)) n += 1;
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
 * THE RULE: the live-TUI composer box is MANDATORY, plus at least one corroborating family. Not
 * "any two of four" — see the header for why a pasted transcript in a pager clears that lower bar.
 *
 * THE PRICE OF A FALSE POSITIVE IS A PASTED *AND SUBMITTED* LINE, not a typed one: this predicate
 * gates `services/conciergeDispatch`, which finishes with `submitPrompt`. The header carries the
 * full argument; this note exists so a caller reading only the call site does not inherit the
 * gentler dictation-flavoured framing an earlier draft had here. Callers must treat `false` as
 * "assume a real full-screen app", never as "assume safe".
 *
 * THIS DOES NOT MEAN THE SCREEN IS SAFE TO WRITE TO. It means the alternate buffer is not evidence
 * of danger here. Claude Code can perfectly well be showing a permission dialog or a picker, and
 * that is a different guard's question — `screenBlocksWrite` still has to run, and in
 * `terminalWriteRefusal` it does. Do not let a true from this function stand in for that check.
 */
export function isClaudeCodeScreen(snapshot: string): boolean {
  const lines = snapshot.split("\n");

  // ── A LIVE DIALOG STANDS ALONE; IT DOES NOT NEED A SECOND FAMILY ─────────────────────────────
  // Counting Family E as one vote among five (the first cut at this fix) does not clear the bar it
  // was meant to clear, and the captured screens say so outright: `APPROVAL_OPTION_2_2_1_220` and
  // `MODEL_PICKER_2_1_220` are a dialog and NOTHING ELSE — no tool glyph, no busy line, no chrome
  // bar, and by construction no composer box, because the dialog is what replaced it. They score
  // exactly 1, fail `>= 2`, and are refused as `alternate-screen`. That is the original defect
  // surviving its own fix, one line further down, on the two screens where a human is most likely
  // to be waiting: an approval with "No" highlighted, and the /model picker.
  //
  // The corroboration rule exists to keep out a document that QUOTES Claude Code, and `hasLiveDialog`
  // already answers that objection by POSITION rather than by a second lexical marker: the footer has
  // to TERMINATE the grid. A pager renders its own status row beneath the text, a transcript keeps
  // going, and both are rejected there — see `hasLiveDialog` and the impostor cases in
  // `claudeCodeScreen.liveDialog.test.ts`. Demanding another Claude marker on top of that does not
  // add safety; it only fails the screens whose dialog is the entire viewport.
  if (hasLiveDialog(lines)) return true;

  // ── THE BACKGROUND-TASK LIST STANDS ALONE TOO, FOR THE SAME REASON (bead sparkle-tbsvf) ────────
  // It replaces the composer exactly as a live dialog does, so requiring family D below would fail
  // on precisely the screen this family exists for.
  if (hasBackgroundTaskList(lines)) return true;

  // ── A NARROW COMPOSER BOX STANDS ALONE, LIKE E AND F (roborev 64482, High) ────────────────────
  // NOT a relaxation — it is what stops one piece of evidence being counted twice. The narrow arm
  // only recognises a box when Claude's own STATUS BAR, rejoined, sits beneath it
  // (`narrowBoxTerminatesGrid`), so a narrow box already carries the box AND the chrome. Scoring it
  // as family D and then letting family C read that same status bar again would satisfy `>= 2` from
  // a single marker — the collapse `claudeCodeMarkerFamilies` forbids — while a narrow pane is by
  // construction too small to show a second, independent family anyway.
  //
  // The bar it clears is HIGHER than family E's, which stands alone on position alone: this demands
  // a full-width pair of equal rules sandwiching a prompt, nothing below wider than the grid, and a
  // rejoined tail that — past any divider drawn between the box and the bar — OPENS with one of
  // `CHROME_BAR`'s phrases. (Two earlier wordings of this clause named guarantees the code did not
  // give: a per-row first-line gate that had been deleted, and then a strict "opens with" that the
  // divider skip had already relaxed — roborev 64487 and 64564, both Medium. The clause has to move
  // with `narrowBoxTerminatesGrid`, since it is the safety argument the call site reads.)
  // …and ONLY the chrome-proven form does (roborev 64487, High). `narrowBoxTerminatesGrid` also
  // accepts a box with nothing below it, or with only rules below it, because neither is a document
  // — but on those the two independent things above collapse back to ONE, the box shape, and a
  // viewport carrying no Claude marker whatsoever would stand alone on its shape:
  //
  //     # notes on the composer     ← a document, and the only text on screen
  //     ────────────
  //     ❯
  //     ────────────
  //     ────────────                ← rules-only tail: terminates the grid, proves no chrome
  //
  // A `bare` box therefore falls through to the `>= 2` rule below, scoring family D like any other.
  //
  // READ THAT AS RULES-*ONLY* (roborev 64564, Medium). A rule FOLLOWED by chrome is still `chrome`:
  // the anchor skips leading dividers, so the tail above demotes the box only because there is
  // nothing after the rule. A divider under the box is not by itself a demotion, and the two
  // statements have to be read together or this example teaches the opposite of what the code does.
  const box = composerBoxKind(lines);
  if (box === "narrow-chrome") return true;

  // ── OTHERWISE THE COMPOSER BOX IS MANDATORY, PLUS ONE CORROBORATING FAMILY ───────────────────
  // Unchanged, and still the rule for every screen without a live dialog: a pasted transcript in a
  // pager carries Claude's glyphs and its status bar — two families — without being Claude Code.
  if (box === "no") return false;
  return claudeCodeMarkerFamilies(snapshot) >= 2;
}

/** Is there evidence of a LIVE Claude Code TUI — either form? The precondition `isClaudeCodeScreen`
 *  applies, split out so callers and tests can ask for it directly. */
export function hasClaudeCodeLiveTui(snapshot: string): boolean {
  const lines = snapshot.split("\n");
  return hasComposerBox(lines) || hasLiveDialog(lines) || hasBackgroundTaskList(lines);
}
