import type { SuggestionButton } from "./types";

// Only the last N non-empty lines are considered "live" — a prompt scrolled far up is stale.
const TAIL_LINES = 12;

// `YN` matches "[y/n]" / "[yes/no]" case-insensitively (the bracket alternatives), plus bare
// "y/n" / "yes/no" word forms. (An earlier YN_DEFAULT regex was removed — it was fully subsumed
// by this one and added no behavior.)
const YN = /\b(y\/n|yes\/no)\b|\[y\/n\]|\[yes\/no\]/i;
const MENU_LINE = /^\s*[\[(]?(\d{1,2})[\]).]\s+\S/; // "1) x", "2. x", "[3] x", "(4) x"

// A real choice prompt either names the action, or is a pure-punctuation prompt like "? " / ">"
// (a single-word label ending in ":" such as "Changes:"/"Results:" is a HEADER, not a prompt —
// excluding it kills the main false-positive class that would otherwise inject "1\n" into a PTY).
const CHOICE_KEYWORD = /(choice|choos|select|option|enter|pick|press|which)/i;

function tail(scrollback: string): string[] {
  const lines = scrollback.replace(/\r/g, "").split("\n").filter((l) => l.trim().length > 0);
  return lines.slice(-TAIL_LINES);
}

function btn(label: string, value: string): SuggestionButton {
  // id is unique WITHIN a set (labels are deduped: y/n → Approve/Deny; menus → a contiguous
  // 1..N run). Consumers that pool across agents key click-back by (agentId, buttonId).
  return { id: `heur:${label}`, label, value, kind: "terminal", source: "heuristic" };
}

function asksChoice(lastLine: string): boolean {
  if (CHOICE_KEYWORD.test(lastLine)) return true;
  // Pure-punctuation prompt: ends in ?/:/>/# and contains no letters.
  return /[?:>#»]\s*$/.test(lastLine) && !/[a-z]/i.test(lastLine);
}

export function detectTerminalPrompts(scrollback: string): SuggestionButton[] {
  const lines = tail(scrollback);
  if (lines.length === 0) return [];

  // Numbered menu: parse option numbers in tail order, then find the longest CONTIGUOUS run
  // 1,2,3,… anywhere in that sequence (restarting whenever a "1" appears). This rejects
  // scattered/duplicate/non-1-based numbers from ordinary logs (e.g. "7) x" / "9) y", or "1) a"
  // appearing twice) yet still finds a real menu even when a stray earlier numbered log line
  // precedes it in the tail. Require >= 2 options AND a genuine choice prompt on the last line.
  const lastLine = lines[lines.length - 1] ?? "";
  const nums: number[] = [];
  for (const l of lines) {
    const m = l.match(MENU_LINE);
    if (m?.[1]) nums.push(parseInt(m[1], 10));
  }
  let best: number[] = [];
  let cur: number[] = [];
  let expected = 1;
  for (const n of nums) {
    if (n === 1) {
      cur = [1];
      expected = 2;
    } else if (n === expected) {
      cur.push(n);
      expected += 1;
    } else {
      cur = [];
      expected = 1;
    }
    if (cur.length > best.length) best = cur.slice();
  }
  if (best.length >= 2 && asksChoice(lastLine)) {
    return best.slice(0, 3).map((n) => btn(String(n), `${n}\n`));
  }

  // Yes/No confirmation: must be asked in the last 2 lines.
  const lastTwo = lines.slice(-2).join("\n");
  if (YN.test(lastTwo)) {
    return [btn("Approve", "y\n"), btn("Deny", "n\n")];
  }

  return [];
}
