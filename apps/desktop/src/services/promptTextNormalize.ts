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
// ══ THE `(?<!\d)` ON THE FIRST ALTERNATIVE IS LOAD-BEARING — do not drop it (bead sparkle-70btv) ══
// Every other alternative here opens with `\b` or a literal, which already forbids the match
// restarting in the middle of a digit run. The percentage arm was the one exception: a bare `\d+`
// can restart at EVERY offset of a long number, and since `\d+` re-scans the rest of the run each
// time, `steady()` went quadratic — 18.2s on a 32k digit run, measured, in a `.replace` that runs
// over terminal text. That is the same defect class as the token counters in engine/statusEngine.ts
// (see the header there), which held 38.8% of the renderer main thread during a 3-10s input-lag
// hang; this one was found by sweeping for the shape rather than by a second sample.
//
// It does not narrow the match set: a digit directly preceded by a digit is already covered by the
// greedy match that starts at the run's head, and a dot resets the run (`1.2.3%` still normalises
// exactly as before). Pinned by promptTextNormalize.test.ts.
export const VOLATILE_SPAN =
  /(?<!\d)\d+(?:\.\d+)?\s*%|\(\s*\d+\s*\/\s*\d+\s*\)|\b\d+(?:\.\d+)?\s*[KMG]i?B\b|\b\d+m\s*\d+s\b|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒]/g;

/** Neutralise the moving parts of a line, keeping everything else. */
export function steady(line: string): string {
  return line.replace(VOLATILE_SPAN, "#");
}
