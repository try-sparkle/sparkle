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
  for (let i = lines.length - 1; i >= 0; i--) {
    if (BACKGROUND_TASK_ROW.test(lines[i] ?? "")) {
      return nothingUnrecognizedBelowFooter(lines, i);
    }
  }
  return false;
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
 * Does a closing rule follow `promptIdx` within the body bound, with every intervening row a legal
 * body row? A row that is neither the closing rule nor legal body ENDS the search — the box is not
 * a window to hunt in, it is a contiguous structure.
 */
function closesWithinBody(
  lines: readonly string[],
  promptIdx: number,
  isRule: (line: string) => boolean,
  isBody: (line: string) => boolean,
  maxBodyRows: number,
): boolean {
  const last = Math.min(promptIdx + 1 + maxBodyRows, lines.length - 1);
  for (let j = promptIdx + 1; j <= last; j += 1) {
    const line = lines[j] ?? "";
    if (isRule(line)) return true;
    if (!isBody(line)) return false;
  }
  return false;
}

function hasComposerBox(lines: readonly string[]): boolean {
  for (let i = 0; i + 2 < lines.length; i += 1) {
    const top = lines[i] ?? "";
    const mid = lines[i + 1] ?? "";
    if (RULE_LINE.test(top) && PROMPT_LINE.test(mid)) {
      const rule = (l: string) => RULE_LINE.test(l);
      if (closesWithinBody(lines, i + 1, rule, isComposerBodyRow, MAX_COMPOSER_BODY_ROWS)) {
        return true;
      }
    }
    if (BOX_TOP.test(top) && BOX_PROMPT.test(mid)) {
      const bottom = (l: string) => BOX_BOTTOM.test(l);
      const isBody = isBoxBodyRowFor(mid);
      if (closesWithinBody(lines, i + 1, bottom, isBody, MAX_BOX_BODY_ROWS)) return true;
    }
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

  // ── OTHERWISE THE COMPOSER BOX IS MANDATORY, PLUS ONE CORROBORATING FAMILY ───────────────────
  // Unchanged, and still the rule for every screen without a live dialog: a pasted transcript in a
  // pager carries Claude's glyphs and its status bar — two families — without being Claude Code.
  if (!hasComposerBox(lines)) return false;
  return claudeCodeMarkerFamilies(snapshot) >= 2;
}

/** Is there evidence of a LIVE Claude Code TUI — either form? The precondition `isClaudeCodeScreen`
 *  applies, split out so callers and tests can ask for it directly. */
export function hasClaudeCodeLiveTui(snapshot: string): boolean {
  const lines = snapshot.split("\n");
  return hasComposerBox(lines) || hasLiveDialog(lines) || hasBackgroundTaskList(lines);
}
