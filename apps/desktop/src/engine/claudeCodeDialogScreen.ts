// A LIVE CLAUDE CODE DIALOG IS NOT A FULL-SCREEN APP — the caller-side correction, plus the
// evidence a refusal was based on (beads sparkle-d6a5r, sparkle-1cu3j).
//
// ══ THE DEFECT ════════════════════════════════════════════════════════════════════════════════
// `send_to_agent_terminal` refused with `alternate-screen` against a pane sitting on an ORDINARY
// permission dialog. Reported six times, each occurrence a normal Claude Code pane stopped at a
// "Do you want to proceed?" — never an editor, never a pager — and the refusal left
// `restart_agent`, which destroys in-flight context, as the only remaining route to that agent.
//
// The mechanism is exact and already written down in three places in this tree. Claude Code holds
// the alternate buffer at all times on a modern fleet (measured on v2.1.237 at a bare idle prompt),
// so `viewport.alternateBuffer` excludes nothing. What decides the refusal is therefore
// `!isClaudeCodeScreen(text)` — and that predicate's family D (the composer box) is MANDATORY while
// a permission dialog is exactly what REPLACES the composer box. `claudeCodeScreen`'s family E was
// added to cover that, but it earns its standing by POSITION: the picker footer has to TERMINATE
// the grid. A dialog drawn with anything the below-footer walk does not recognise underneath it
// falls back through family E, scores 1 on the tool-call glyphs alone, fails `>= 2`, and is
// reported as `vim`.
//
// ══ WHY THE FIX IS HERE AND NOT IN `isClaudeCodeScreen` ═══════════════════════════════════════
// That predicate is SHARED between the row colour and the keystroke-authorization gate (beads
// sparkle-gihgml / sparkle-lmpbuj), and loosening family E's below-footer walk changes both at
// once. Widening it is that owner's change to make. This module is the TERMINAL-DELIVERY caller's
// own, strictly narrower question, asked only where a write is about to be refused.
//
// ══ WHY THIS CANNOT DELIVER A WRITE THAT WAS PREVIOUSLY REFUSED ═══════════════════════════════
// It is not a permission and it must never be used as one. Both call sites pair it with
// `screenBlocksWrite`, which is what makes the change provably non-weakening: every screen this
// reclassifies is a screen `screenBlocksWrite` already says must not receive free text, so the
// refusal one arm further down (`blocked-prompt` in the dispatcher, `awaiting-input` in
// `terminalWriteRefusal`) fires on exactly the same set. What changes is WHICH refusal, i.e. what
// the human is told to do about it — "quit the app" is an instruction nobody can follow when there
// is no app to quit, and AGENTS.md is explicit that a remedy string is an instruction.
//
// ══ TWO INDEPENDENT SIGNALS, BECAUSE A FALSE POSITIVE IS PRICED THE SAME WAY ══════════════════
// `claudeCodeScreen`'s header prices a false positive as a line pasted AND SUBMITTED into a pager,
// so this demands two things a pager and an editor cannot both produce:
//
//   1. A LIVE MENU IN THE VIEWPORT. `detectTerminalPrompts` over `screen.text` — the viewport, not
//      the scrollback, so this cannot be satisfied by a menu that has already scrolled away. This
//      is the same one-source rule roborev 58562/58575 imposed on the credential waiver after four
//      rounds of a scrollback-derived waiver disagreeing with a viewport-derived guard.
//   2. AT LEAST ONE CLAUDE CODE MARKER FAMILY. A permission dialog scores exactly 1 — the tool-call
//      glyphs — which is the measured value `claudeCodeScreen.test.ts` pins as
//      `claudeCodeMarkerFamilies(APPROVAL_2_1_220) === 1`.
//
// `vim` shows `~` filler and scores 0 on both. `less` and `man` draw a status row, not a
// `<key> to <verb>` picker footer, and score 0 families. `htop`'s "F1Help F2Setup" carries no
// footer hint. A pager DISPLAYING a Claude Code transcript can reach both — which is precisely why
// the `screenBlocksWrite` interlock at each call site is mandatory rather than advisory.
import { claudeCodeMarkerFamilies, hasClaudeCodeComposerBox, isClaudeCodeScreen } from "./claudeCodeScreen";
import { detectTerminalPrompts } from "../services/suggestions/heuristics";

/**
 * Is a LIVE Claude Code dialog what is holding this screen?
 *
 * NOT A PERMISSION. See the module header: a caller must pair this with `screenBlocksWrite`, which
 * is the interlock that keeps the reclassification from ever turning a refusal into a delivery.
 */
export function claudeCodeDialogOnScreen(text: string): boolean {
  if (detectTerminalPrompts(text).length === 0) return false;
  return claudeCodeMarkerFamilies(text) >= 1;
}

/**
 * WHAT THE REFUSAL WAS BASED ON — the diagnosable record bead sparkle-d6a5r asks for.
 *
 * STRUCTURAL FACTS ONLY, never the screen text. A refused screen is by construction one sitting at
 * a prompt, and this file's neighbours exist because some of those prompts are credential fields
 * that echo nothing — so a log line quoting the viewport would write a password into the app log.
 * Counts, booleans and row totals are what makes a refusal reproducible; the bytes are what makes
 * it a leak.
 */
export interface AltScreenEvidence {
  /** The emulator's own mode bit — `term.buffer.active.type !== "normal"`, never a text heuristic. */
  alternateBuffer: boolean;
  /** How many independent Claude Code marker families the screen shows. A permission dialog: 1. */
  markerFamilies: number;
  /** Family D, the mandatory one — and the one a dialog REPLACES, which is the whole defect. */
  composerBox: boolean;
  /** What `isClaudeCodeScreen` itself said. `false` here alongside `dialogOnScreen: true` is the
   *  exact signature of this bead's misclassification, and is the line to grep for. */
  recognisedAsClaudeCode: boolean;
  /** Live menu options found in the VIEWPORT (not the scrollback). */
  viewportOptions: number;
  /** Live menu options found in the SCROLLBACK by the dispatcher's own read, passed in so the log
   *  shows the two sources side by side — they disagreeing is the failure this family keeps having. */
  scrollbackOptions: number;
  /** Non-empty rows on screen. A pager or editor fills the grid; a bare dialog usually does not. */
  rows: number;
  /** The verdict this module reached: a live Claude Code dialog is holding the screen. */
  dialogOnScreen: boolean;
}

/** Gather {@link AltScreenEvidence} for one viewport. Pure; no I/O, no store reads. */
export function altScreenEvidence(
  text: string,
  alternateBuffer: boolean,
  scrollbackOptions: number,
): AltScreenEvidence {
  return {
    alternateBuffer,
    markerFamilies: claudeCodeMarkerFamilies(text),
    composerBox: hasClaudeCodeComposerBox(text),
    recognisedAsClaudeCode: isClaudeCodeScreen(text),
    viewportOptions: detectTerminalPrompts(text).length,
    scrollbackOptions,
    rows: text.split("\n").filter((l) => l.trim() !== "").length,
    dialogOnScreen: claudeCodeDialogOnScreen(text),
  };
}
