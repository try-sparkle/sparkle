// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE MENU'S IDENTITY — `pickerFingerprint`
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// EXTRACTED FROM `conciergeTools/terminal` SO THE DISPATCHER CAN RUN IT TOO (bead sparkle-jk8zt).
// Nothing about the algorithm changed; only its address did. The move exists because
// `conciergeDispatch` now has to answer "is this write a fingerprinted picker press?" for ITSELF
// rather than trusting a caller's word for it — and `conciergeTools/terminal` already imports the
// dispatcher, so leaving the function there would have made the check a cycle.
//
// WHY THE DISPATCHER RE-VERIFIES INSTEAD OF TAKING A BOOLEAN. A flag would be a caller ASSERTION,
// and the whole reason the alternate-screen refusal exists is that assertions about what is on a
// terminal are what get text executed as commands. Re-running this against the CURRENT screen is
// positive evidence: the fingerprint covers the question and the option shape, so a match means the
// dispatcher itself just read the same menu the caller read. A caller cannot fabricate that without
// the menu genuinely being there.
//
// PURE-ish AND SEPARATELY TESTABLE, which is the other thing the move buys: the only ambient read is
// `getAgentScrollback`, so a test can drive the whole identity rule through one seam.

import { getAgentScrollback } from "./terminalScrollback";
import {
  pickerBlockBounds,
  pickerWindow,
  MENU_LINE,
  genericMenuRun,
  genericMenuWindow,
  YN,
} from "./suggestions/heuristics";
import type { SuggestionButton } from "./suggestions/types";

// NO LOCAL "OPTION ROW" PATTERN LIVES HERE ANY MORE.
//
// There used to be one, deliberately WIDER than the detector's `MENU_LINE` so it could not miss a
// shape the parser accepted. That reasoning was backwards: a locator that matches a line the PARSER
// SKIPS is just as broken as one that misses a line the parser takes — a stray `> 4. see the guide`
// counted as an option row here, broke the run, produced no block, and refused every press forever
// (roborev 55218). The rule that survived four rounds of this is parity, not generosity, so the
// generic branch imports `MENU_LINE` and there is exactly one definition of what an option row is.

/** Content that MOVES on its own: progress percentages, `(3120/6640)` counters, byte totals,
 *  elapsed-time readouts, braille/ASCII spinners. Any of it inside a fingerprint makes the
 *  fingerprint tick while the question sits still, so `read_picker_options` and
 *  `select_picker_option` disagree and the prompt becomes UNANSWERABLE — with a refusal whose own
 *  remedy is "re-read and try again", which loops (roborev 55170).
 *
 *  NORMALISED, NOT DROPPED. Dropping the whole line was worse than the bug it fixed: these patterns
 *  match ordinary question text — "Delete 2.3 GB of build artifacts? [y/n]" is a volatile line by
 *  this pattern — so the filter discarded the only content that distinguishes one prompt from
 *  another, and two destructive-vs-benign prompts collapsed to the same empty block (roborev 55172).
 *  Replacing just the moving SPAN with a placeholder keeps the distinguishing text and neutralises
 *  the movement. */
const VOLATILE_SPAN = /\d+(?:\.\d+)?\s*%|\(\s*\d+\s*\/\s*\d+\s*\)|\b\d+(?:\.\d+)?\s*[KMG]i?B\b|\b\d+m\s*\d+s\b|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒]/g;

/** Neutralise the moving parts of a line, keeping everything else. */
function steady(line: string): string {
  return line.replace(VOLATILE_SPAN, "#");
}

/** How far above the option block the question may sit. Claude Code's Bash-approval dialog puts the
 *  command and its description 3–4 lines up; generous without reaching into unrelated output. */
const QUESTION_CONTEXT_LINES = 10;

/** Hard ceiling on the block, whatever the anchors say. A fingerprint over hundreds of lines of live
 *  log output changes constantly, which is the same permanent-disagreement failure as a moving tail. */
const QUESTION_BLOCK_MAX_LINES = 20;

/** How many trailing non-empty lines a y/n question may occupy — the detector's own rule. */
const YN_TAIL = 2;

/** The same screen re-rendered with a different highlight colour must not read as a different
 *  question, so escapes come off before anything is hashed. Hoisted with the disable comment the
 *  way `suggestions/pendingQuestion.ts` and `engine/statusEngine.ts` do it — the rule is right in
 *  general, and this is the one place it does not apply. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;

// NO LOCAL RUN SELECTOR EITHER.
//
// Sharing the PATTERN (`MENU_LINE`) closed the deadlock but left the SELECTION RULE as a second
// definition, and the two disagreed: the detector USED TO keep the longest 1-based run (first-wins
// on ties) while this kept the run nearest the END. With a numbered plan above a live menu the
// buttons came from one block and the fingerprinted question from the other — an options/question
// mismatch the fingerprint cannot catch, because it is hashing the wrong block rather than a stale
// one (roborev 55245). `genericMenuRun` is now the single definition, indices included, and its rule
// is NEAREST THE END for both callers — agreeing on the longest run was still wrong (roborev 55258).

/**
 * The dialog's OWN text: the option block the DETECTOR parsed, plus the lines above it.
 *
 * ASK THE PARSER, DO NOT RE-DERIVE IT. Every previous version of this located the block with its own
 * rule and every one of them disagreed with `parsePickerOptions` in some way — a narrower option
 * pattern (55166), a wider window (55172), a stricter adjacency rule and a wider footer search
 * (55195). A locator that disagrees with the parser that produced its input IS the bug class: the
 * option shape describes one dialog while the question describes another, and two different prompts
 * hash the same. `pickerBlockBounds` returns the exact indices that parse used, so there is nothing
 * left to disagree about — including the wrapped and description lines the parser deliberately skips
 * between option rows, which a strict adjacency rule rejected outright and thereby made every
 * soft-wrapped picker permanently unanswerable.
 *
 * The y/n path stays separate because the detector treats it separately: a confirmation has no
 * option rows at all, and `YN` (the detector's own regex) is what tells the two apart.
 */
function questionBlock(scrollback: string, yesNo: boolean): string {
  const clean = scrollback.replace(ANSI, "");
  if (!yesNo) {
    const lines = pickerWindow(clean);
    const bounds = pickerBlockBounds(clean);
    if (bounds) {
      // The footer sits just below the last option row, so the block is [first, footer).
      const block = lines
        .slice(Math.max(0, bounds.first - QUESTION_CONTEXT_LINES), bounds.footer)
        // The pointer MOVES as the user arrows around without the question changing, so it is
        // normalised away — otherwise merely navigating a menu would invalidate a fingerprint.
        .map((l) => steady(l.replace(/^\s*[❯›>]\s*/, "")).trim())
        .filter((l) => l !== "");
      // Cap from the START. The block runs question-first, option-rows-last, and the OPTIONS are
      // already in the fingerprint's `shape` half — the question is the only part this contributes.
      // Taking the last N therefore dropped precisely the material that distinguishes one ask from
      // another, which is the collision everything here exists to prevent (roborev 55204).
      return block.slice(0, QUESTION_BLOCK_MAX_LINES).join("\n");
    }
    // No Claude Code picker. The GENERIC menu path is the detector's other option source — same
    // window, same pattern, same run selection, because they are literally the same function.
    const generic = genericMenuWindow(clean);
    const run = genericMenuRun(generic);
    if (!run) return "";
    let first = run.first;
    for (let i = run.first - 1; i >= 0; i--) {
      if (MENU_LINE.test(generic[i]!)) first = i;
      else break;
    }
    return generic
      .slice(Math.max(0, first - QUESTION_CONTEXT_LINES), run.last + 1)
      .map((l) => steady(l.replace(/^\s*[❯›>]\s*/, "")).trim())
      .filter((l) => l !== "")
      // Question-first: see the note in the picker branch above.
      .slice(0, QUESTION_BLOCK_MAX_LINES)
      .join("\n");
  }
  // A yes/no confirmation: no option rows, and its question is in the trailing lines by the
  // detector's own rule. Without this the fingerprint would fall back to the option shape alone,
  // which for the constant Approve/Deny pair is a GLOBAL CONSTANT (roborev 55166).
  const tail = clean
    .split("\n")
    .filter((l) => l.trim() !== "")
    .slice(-YN_TAIL);
  if (!YN.test(tail.join("\n"))) return "";
  return tail
    .map((l) => steady(l).trim())
    .filter((l) => l !== "")
    .join("\n");
}

/**
 * A stable identity for the MENU ITSELF, not for its options.
 *
 * WHY NOT THE OPTIONS ALONE. The most common picker shape is a NUMBERED menu whose labels are "1",
 * "2", "3", so two different questions are label-identical. Worse, Claude Code's Bash-approval
 * dialog renders the SAME three options for every command ("Yes" / "Yes, and don't ask again" /
 * "No, and tell Claude what to do…") — the option set is constant while the thing being approved
 * changes completely.
 *
 * WHY NOT THE TAIL OF THE SCROLLBACK. That was the first implementation and it was wrong (roborev
 * 55163). Ink keeps rendering BELOW the dialog, which is the entire reason `detectClaudeCodePicker`
 * searches a window for the footer rather than reading the last line. A blind tail slice hashes UI
 * chrome, and fails BOTH ways: it misses a changed question — you could approve `rm -rf build/`
 * having read the prompt for `git status` — and it invents changes from a moving task checklist,
 * refusing a menu that never moved.
 *
 * Not a cryptographic hash — this guards against the menu MOVING, not against a forger. A caller
 * that fabricates a fingerprint already holds an authority and could just send the keystroke.
 */
export function pickerFingerprint(agentId: string, options: readonly SuggestionButton[]): string {
  // The detector emits exactly this pair, and only this pair, for a yes/no confirmation
  // (`heuristics.ts`: `[btn("Approve", "y\n"), btn("Deny", "n\n")]`). Matching on the VALUES rather
  // than the labels because the values are the keystrokes — a label is display text and could be
  // relabelled without changing what the buttons do.
  const yesNo =
    options.length === 2 && options[0]?.value === "y\n" && options[1]?.value === "n\n";
  const prompt = questionBlock(getAgentScrollback(agentId) ?? "", yesNo);
  // An EMPTY question block means the dialog could not be located, not that it has no question. A
  // fingerprint over the option shape alone is a global constant for both of the shapes that matter
  // (numbered menus, and the constant Approve/Deny pair), so producing one would be worse than
  // producing none. "" is the sentinel: `select_picker_option` refuses on it.
  if (prompt === "") return "";
  const shape = options.map((o) => `${o.label}\u0000${o.value}`).join("\u0001");
  let h = 5381;
  const material = `${shape}\u0002${prompt}`;
  for (let i = 0; i < material.length; i++) h = ((h * 33) ^ material.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
