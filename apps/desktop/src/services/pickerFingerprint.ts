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
import { ANSI, steady } from "./promptTextNormalize";
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

// THE NORMALISER MOVED OUT, unchanged, to `services/promptTextNormalize` (roborev 62838, finding 3).
// `engine/blockedPromptGrace` needs the identical rule to decide whether a re-drawn question is one
// it has already held, and it cannot import THIS module (the `getAgentScrollback` /
// suggestion-heuristic imports above are not reachable from `engine/`). It briefly carried a verbatim
// copy of the two regexes instead, with a comment claiming a cross-module test kept them in step and
// no such test existing — so what a prompt's identity IS now has exactly one definition, and the two
// callers share it rather than resembling each other.

/** How far above the option block the question may sit, WHEN THE DIALOG DECLARES NO TOP BORDER.
 *
 *  ═ THIS IS THE FALLBACK NOW, NOT THE RULE (bead sparkle-saoe3) ═════════════════════════════════
 *  It used to be the only bound, and "generous without reaching into unrelated output" — the claim
 *  that stood here — was false for every dialog carrying fewer than ten lines of its own above its
 *  options. AskUserQuestion carries four. The overshoot is invisible on a short screen, which is
 *  where it was tested: the walk clamps at index 0 and stops. On a REAL screen the 50-line picker
 *  window is saturated, so the same walk lands six lines deep in the live transcript — on Claude
 *  Code's spinner glyph, its elapsed readout and its token counter, none of which hold still.
 *
 *  Hashing those made the question's identity a moving target: consecutive reads of one unchanged
 *  `sed` approval returned different fingerprints, and because `selectPickerOption` re-derives the
 *  hash from the live screen at press time, a caller echoing back the fingerprint it had just been
 *  handed was refused as `changed` anyway — twice, on a prompt nothing was touching. The menu was
 *  readable and permanently unanswerable at the same time.
 *
 *  So the bound is now the dialog's own top border (`bounds.top`) whenever it has one, and this
 *  number applies only when it does not. It is deliberately unchanged: a dialog with no border is
 *  exactly the case nothing better is known about, and narrowing the fallback there would trade a
 *  churning fingerprint for a colliding one. */
/**
 * The moving selection pointer at the head of an option row, INCLUDING an optional box border
 * before it (roborev 74270, High).
 *
 * Claude Code draws every dialog BOXED (`screenClassifier.ts`), so a real option row reads
 * `│ ❯ 1. Local files` — and a strip anchored at `^\s*[❯›>]` never matches it. The pointer then
 * stayed in the hashed material, so merely ARROWING changed two lines of the block and the
 * fingerprint moved. That matters because `verifiedPickerPress` re-derives the fingerprint from the
 * CURRENT screen and compares it to the one taken before the walk: on a boxed dialog the two
 * disagreed, the press took the `blocked-prompt` arm, and the result was arrows landed, highlight
 * moved, nothing ticked, press refused — the exact defect this bead exists to remove, now merely
 * narrated rather than prevented. It is a race on the redraw reaching the store, so it presents as
 * intermittent rather than absent, and the suite could not see it: the widget fixture renders
 * UNBOXED rows, where the old strip does succeed.
 *
 * The `[│|┃]?` tolerance matches what `SELECTION_CURSOR` and `RENDERED_OPTION_ROW` already carry,
 * so all three now agree about what a pointer row looks like.
 *
 * THE POINTER IS OPTIONAL, AND THAT IS THE LOAD-BEARING HALF. Stripping the border only from rows
 * that HAVE a pointer just relocates the asymmetry: the pointed row normalises to `1. Local files`
 * while its siblings keep `│   2. The web`, so moving the pointer still rewrites two lines of the
 * block. Unboxed material never showed this because `.trim()` already erased the difference — the
 * leading `│` is exactly what survives a trim. So the border is normalised off EVERY row, pointer
 * or not, which is what actually makes the hash invariant under navigation.
 */
const POINTER_PREFIX = /^\s*[│|┃]?\s*(?:[❯›>]\s*)?/;

const QUESTION_CONTEXT_LINES = 10;

/** Hard ceiling on the block, whatever the anchors say. A fingerprint over hundreds of lines of live
 *  log output changes constantly, which is the same permanent-disagreement failure as a moving tail. */
const QUESTION_BLOCK_MAX_LINES = 20;

/** How many trailing non-empty lines a y/n question may occupy — the detector's own rule. */
const YN_TAIL = 2;

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
// EXPORTED for `suggestions/conciergeEscalation`, which has to answer the SAME question this does:
// "what text is this dialog actually asking?" It used to answer it with `approvalClassifier
// .headerRegion`, and that was wrong in a way that made two stated safety properties inert on any
// real screen (roborev 63621, two High findings):
//
//   • `headerRegion` is up to 30 non-empty lines above the footer, and the WHOLE 50-line window when
//     no footer is found — so on a saturated pane it is mostly transcript. Its "the question could
//     not be read" test (`region.trim() === ""`) can then only fire on a picker sitting at the very
//     top of an otherwise empty buffer, i.e. on synthetic fixtures. A dialog whose question genuinely
//     cannot be read was being delegated with unrelated scrollback quoted as "the question".
//   • Sweeping a deny-list over those 30 lines matches Claude Code's own chrome — its elapsed
//     readout and its TOKEN COUNTER — so a router meant to send the rare case to the founder sent
//     nearly every case to him instead.
//
// Both dissolve once the two modules share ONE definition of the dialog's own text, which is what
// the escalation module's header always CLAIMED ("parity with select_picker_option's empty-
// fingerprint refusal") without having. This is that parity, made real: same bounds, same
// normalisation, same "" sentinel meaning the dialog could not be located.
export function pickerQuestionBlock(scrollback: string, yesNo: boolean): string {
  return questionBlock(scrollback, yesNo);
}

function questionBlock(scrollback: string, yesNo: boolean): string {
  const clean = scrollback.replace(ANSI, "");
  if (!yesNo) {
    const lines = pickerWindow(clean);
    const bounds = pickerBlockBounds(clean);
    if (bounds) {
      // The footer sits just below the last option row, so the block is [start, footer).
      //
      // START AT THE DIALOG'S OWN TOP BORDER, and fall back to the fixed window only when the
      // parser reports it has none. Everything above that border belongs to the transcript, not to
      // the question — see QUESTION_CONTEXT_LINES. The border line itself is excluded: it is the
      // same run of box characters on every dialog, so it distinguishes nothing.
      const start =
        bounds.top >= 0
          ? bounds.top + 1
          : Math.max(0, bounds.first - QUESTION_CONTEXT_LINES);
      const block = lines
        .slice(start, bounds.footer)
        // The pointer MOVES as the user arrows around without the question changing, so it is
        // normalised away — otherwise merely navigating a menu would invalidate a fingerprint.
        .map((l) => steady(l.replace(POINTER_PREFIX, "")).trim())
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
      .map((l) => steady(l.replace(POINTER_PREFIX, "")).trim())
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
  // STEADY THE LABEL, exactly as `questionBlock` already steadies the option ROWS it hashes (bead
  // sparkle-jniddo). The label is DISPLAY text and can carry a moving span — Claude Code renders a
  // per-option elapsed readout ("… (last build 1m 20s)"), and an AskUserQuestion option can quote a
  // byte size or a percentage. `read_picker_options` hands that raw label to the human to read, but
  // the fingerprint is the menu's IDENTITY, and a clock ticking inside one option must not make the
  // same menu hash differently between the read and the press — that mismatch is refused as
  // `changed` and DEADLOCKS the flow, the exact field failure this bead records (a menu the
  // concierge could read but never answer). The value is the KEYSTROKE ("2\n", "y\n") and is left
  // verbatim: it is what gets injected, never display chrome. `steady` neutralises only the moving
  // span, so two options differing in real text still differ — the collision protection the
  // fingerprint exists for is untouched.
  const shape = options.map((o) => `${steady(o.label)}\u0000${o.value}`).join("\u0001");
  let h = 5381;
  const material = `${shape}\u0002${prompt}`;
  for (let i = 0; i < material.length; i++) h = ((h * 33) ^ material.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
