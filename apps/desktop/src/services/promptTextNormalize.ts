// ONE definition of "what makes two renderings of a terminal prompt the same prompt".
//
// Two modules need this and they must not disagree: `services/pickerFingerprint` decides whether the
// menu a caller read is still the menu on screen (a disagreement there makes a prompt permanently
// UNANSWERABLE), and `engine/blockedPromptGrace` decides whether a re-drawn question is the same
// question it already held once (a disagreement there re-arms a hold that is supposed to happen at
// most once). They were briefly two verbatim copies of the regexes below, with a comment claiming a
// cross-module test kept them in step and no such test existing — so this module is the guard the
// comment was describing.
//
// Deliberately DEPENDENCY-FREE. `pickerFingerprint` pulls in `terminalScrollback` and the suggestion
// heuristics, so `engine/` cannot import it; a bare constants module is importable from anywhere and
// is the only shape that lets both sides share a definition rather than a resemblance.

/** The same screen re-rendered in a different highlight colour is the same question, so escapes come
 *  off before anything is hashed. (The `no-control-regex` rule is right in general and this is the
 *  one place it does not apply — hoisted with its disable comment the way `engine/statusEngine` and
 *  `suggestions/pendingQuestion` do it.) */
// eslint-disable-next-line no-control-regex
export const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;

/** Content that MOVES ON ITS OWN: progress percentages, `(3120/6640)` counters, byte totals,
 *  `1m 20s` elapsed readouts, braille/ASCII spinners.
 *
 *  NORMALISED, NOT DROPPED — dropping the whole line was worse than the bug it fixed, because these
 *  patterns match ordinary question text ("Delete 2.3 GB of build artifacts? [y/n]" is a volatile
 *  line by this pattern) and discarding it collapsed two different prompts onto one empty block
 *  (roborev 55170/55172). Replacing just the moving SPAN keeps what distinguishes one ask from
 *  another and neutralises the movement. */
export const VOLATILE_SPAN =
  /\d+(?:\.\d+)?\s*%|\(\s*\d+\s*\/\s*\d+\s*\)|\b\d+(?:\.\d+)?\s*[KMG]i?B\b|\b\d+m\s*\d+s\b|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒]/g;

/** Neutralise the moving parts of a line, keeping everything else. */
export function steady(line: string): string {
  return line.replace(VOLATILE_SPAN, "#");
}
