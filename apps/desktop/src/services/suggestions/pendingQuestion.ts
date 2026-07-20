// "Is the agent waiting on an ANSWER from the user right now?" — the concept the suggestion
// pipeline was missing.
//
// Why this module exists: the composer's CTA (engine/agentCta.ts) derived its pill from the
// workflow STAGE alone and never looked at the terminal. So an agent that had landed a previous
// cycle sat pinned at stage `merged` (a dirty tree with ahead === 0 doesn't trip new-cycle
// detection — see workflowStage.ts) and offered "Close Build Agent" while its last words on screen
// were "Want me to do that — commit, then merge main in?". The stage was right about the branch and
// completely wrong about the moment.
//
// heuristics.ts already answers this for terminal WIDGETS (Ink pickers, y/n, numbered menus). It
// can't answer it for prose, and prose is how a coding agent usually asks: no widget, no keystroke
// to send, just a sentence and a blinking cursor. That's the gap this fills.
import { detectTerminalPrompts } from "./heuristics";

// How many CHROME-FILTERED lines back to look. Claude Code paints its input box, hint bar and
// status line below the last message, so a question is never the literal last line — but those are
// stripped by isChrome, so this counts only lines the agent actually spoke.
//
// Tuned DOWN from an initial 30 (roborev, Low): a question the user already answered stays in the
// buffer, and a wide window let it re-trigger on the NEXT settled turn if the agent's new output
// was short. 15 spoken lines still comfortably covers both founder screenshots (in each the
// question is the last thing said) while making a resolved question fall out of scope quickly.
const WINDOW_LINES = 15;

// Openers that make a sentence a direct request for a decision. These carry the case where the "?"
// sits mid-line because the sentence continues past it ("…merge main in? I'd also add the PRD
// entry…") — the founder screenshot that prompted this module.
const QUESTION_OPENER =
  /\b(want me to|should i\b|shall i\b|would you like|do you want|ok(?:ay)? to (?:go|proceed|land|push|commit)|ready for me to|which (?:one|of these|approach|option)|let me know (?:if|whether|which))/i;

// Box-drawing / TUI chrome. A line made of these is frame, not speech.
const BOX_CHARS = /[─│╭╮╰╯├┤┌┐└┘━┃┏┓┗┛║╔╗╚╝▔▁]/g;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;

/** Code-ish lines carry "?" constantly (ternary, `?.`, `??`) and must never read as a question. */
function looksLikeCode(line: string): boolean {
  if (/\?\.|\?\?/.test(line)) return true; // optional chaining / nullish coalescing
  if (/[;{}]\s*$/.test(line)) return true; // statement or block terminator
  // ANCHORED to line start on purpose: a statement keyword opens its line in code, whereas the
  // same tokens are ordinary English mid-sentence. Matching them anywhere made "Ready FOR me to
  // land this?" and "open a PR FOR this?" read as code and silently killed the detection.
  if (/^\s*(const|let|var|function|return|import|export|if|for|while|class|type|interface)\b/
    .test(line)) {
    return true;
  }
  // Dense punctuation relative to words is the signature of an expression, not a sentence.
  const symbols = (line.match(/[=<>(){}[\]|&;`]/g) ?? []).length;
  return symbols >= 4;
}

/** Chrome the TUI paints every frame — never the agent speaking. */
function isChrome(line: string): boolean {
  const bare = line.replace(BOX_CHARS, "").trim();
  if (bare.length === 0) return true;
  // "? for shortcuts", "esc to interrupt", the status/hint bar.
  if (/^\?\s+for\s+\w+/i.test(bare)) return true;
  return /\b(for shortcuts|to interrupt|bypassing permissions|auto-accept edits|shift\+tab)\b/i.test(
    bare,
  );
}

/** Sentence-shaped: enough words, and mostly letters rather than symbols. */
function isProse(line: string): boolean {
  const words = line.trim().split(/\s+/).filter((w) => /[a-z]/i.test(w));
  if (words.length < 3) return false;
  const letters = (line.match(/[a-z]/gi) ?? []).length;
  return letters / line.length > 0.5;
}

function liveLines(scrollback: string): string[] {
  return scrollback
    .replace(ANSI, "")
    .replace(/\r/g, "")
    .split("\n")
    .filter((l) => l.trim().length > 0 && !isChrome(l))
    .slice(-WINDOW_LINES);
}

/**
 * Whether the agent's recent PROSE output asks the user a direct question.
 *
 * Deliberately biased toward detecting: a false positive costs one turn of the stage CTA sitting
 * behind the caret instead of in front of it (recoverable in a click), while a false negative is
 * the original bug — the pill confidently offering an action nobody asked about.
 */
export function detectProseQuestion(scrollback: string): boolean {
  const lines = liveLines(scrollback);
  if (lines.length === 0) return false;

  for (const line of lines) {
    if (looksLikeCode(line) || !isProse(line)) continue;
    if (QUESTION_OPENER.test(line)) return true;
    // A "?" anywhere in a prose line — end of line OR mid-sentence, which is the common case when
    // the agent asks and then keeps explaining.
    if (line.includes("?")) return true;
  }
  return false;
}

/**
 * Whether the agent is awaiting an answer by ANY means — a terminal widget (picker / y/n / menu) or
 * a prose question. This is the signal the CTA gates on: in both cases the computed suggestions are
 * answers to something the user was actually asked, and so outrank anything derived from the
 * branch's workflow stage.
 */
export function detectPendingQuestion(scrollback: string): boolean {
  if (detectTerminalPrompts(scrollback).length > 0) return true;
  return detectProseQuestion(scrollback);
}
