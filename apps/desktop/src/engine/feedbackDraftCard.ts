// IS CLAUDE CODE SHOWING ITS "BUG REPORT DRAFTED" CARD — AND WHAT DOES IT OFFER?
//
// Pure, so the answer is testable without a PTY (the convention `claudeCodeScreen` and
// `screenClassifier` follow).
//
// ══ THE DEFECT THIS CLOSES (bead sparkle-eou3y0.5) ═════════════════════════════════════════════
// An agent that answers a status-check nudge by calling SendFeedback leaves a card on screen:
//
//     Bug report drafted: <title>
//     1 to review · 2 to send · 0 to dismiss
//
// Its footer is a key-hint bar, so the shared picker-footer matcher sees "a dialog is up" — but the
// card has no `1.`/`2.` option ROWS, so the option walk found nothing and `read_picker_options`
// answered `blind: "footer-without-options"`. The row read Needs-you, `send_to_agent_terminal`
// refused `blocked-prompt`, and nothing could clear it short of the founder pressing 0 in each pane.
//
// The card's options are in its FOOTER, one keystroke each. This reads them from there, so the
// picker reader can offer them like any other menu (same fingerprint, same press path).
//
// ══ WHY THIS IS NARROW ════════════════════════════════════════════════════════════════════════
// Reading options is what lets something be PRESSED, and `2 send` publishes a bug report. So a card
// is only recognised when all three hold:
//   1. a footer row made of nothing but `<digit> [to] <verb>` segments, two or more, distinct
//      digits, one of them a DISMISS — the escape every such card offers;
//   2. the card's own title (`Bug report drafted` / `feedback draft`) within a few rows above it;
//   3. it is LIVE: below the footer sits nothing but Claude Code's own furniture (blank rows, rules,
//      the composer prompt, status bars) plus a small allowance — so a card QUOTED in output that
//      has since scrolled on is never read as one that is still waiting.
import { AMBIENT_CHROME_LINE } from "../services/sessionLimitScreen";
import { screenAwaitsInput } from "./screenClassifier";

export interface FeedbackDraftOption {
  /** The single keystroke the card takes for this option. */
  key: string;
  label: string;
}

export interface FeedbackDraftCard {
  /** Index of the title row in the lines passed in. */
  titleIdx: number;
  /** Index of the footer row in the lines passed in. */
  footerIdx: number;
  /** In the order the footer lists them. */
  options: FeedbackDraftOption[];
}

/** The card's own title. Either spelling Claude Code uses for a drafted report. */
const TITLE = /\bbug report drafted\b|\bfeedback draft(?:ed)?\b/i;

/** How many rows above the footer the title may sit — a title and a wrapped line or two. */
const TITLE_SPAN = 4;

/** One footer segment: a single digit, an optional `to` or `:`, then a short lowercase verb phrase. */
const SEGMENT = /^(\d)\s*(?::\s*|\bto\s+)?([a-z][a-z ]{0,23}[a-z]|[a-z])$/i;

/** The separators the card is drawn with: `·` in the hint-bar spelling, `/` in the bead's. */
const SEPARATOR = /\s+[·•∙/]\s+/;

/** A row that is only a full-width rule, with optional box corners. */
const RULE_ROW = /^[ \t]*[│|┃╭╮╰╯┌┐└┘]?[ \t]*[─━═▔▁]{8,}[ \t]*[│|┃╭╮╰╯┌┐└┘]?[ \t]*$/;

/** The composer prompt, empty or holding a draft. */
const PROMPT_ROW = /^[ \t\u00a0]*[│|]?[ \t\u00a0]*[❯›][ \t\u00a0]/;

/** Rows below the footer that are none of Claude Code's own furniture. The composer can hold a
 *  wrapped draft and Claude can draw a hint row or two that `AMBIENT_CHROME_LINE` does not know
 *  (`← agents · 1 feedback draft` itself is one), so this is not zero — but it is far below a
 *  screen of new output, which is what a stale card has under it. */
const MAX_UNRECOGNISED_BELOW = 3;

/** The footer's options, or null when `line` is not a card footer. */
function footerOptions(line: string): FeedbackDraftOption[] | null {
  const body = line.trim().replace(/^[│|┃]\s*/, "").replace(/\s*[│|┃]$/, "");
  if (body === "") return null;
  const parts = body.split(SEPARATOR);
  if (parts.length < 2) return null;
  const options: FeedbackDraftOption[] = [];
  for (const part of parts) {
    const m = SEGMENT.exec(part.trim());
    if (!m?.[1] || !m[2]) return null;
    options.push({ key: m[1], label: m[2].trim().toLowerCase() });
  }
  if (new Set(options.map((o) => o.key)).size !== options.length) return null;
  if (!options.some((o) => /^dismiss\b/.test(o.label))) return null;
  return options;
}

function isFurniture(line: string): boolean {
  return (
    line.trim() === "" || RULE_ROW.test(line) || PROMPT_ROW.test(line) || AMBIENT_CHROME_LINE.test(line)
  );
}

/**
 * The LIVE feedback-draft card in `lines`, or null. The LAST qualifying footer wins — an earlier,
 * already-answered card higher up is stale, the picker parser's own rule.
 */
export function findFeedbackDraftCard(lines: readonly string[]): FeedbackDraftCard | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const options = footerOptions(lines[i] ?? "");
    if (!options) continue;
    let titleIdx = -1;
    for (let j = i - 1; j >= Math.max(0, i - TITLE_SPAN); j--) {
      if (TITLE.test(lines[j] ?? "")) {
        titleIdx = j;
        break;
      }
    }
    if (titleIdx < 0) return null;
    let unrecognised = 0;
    for (let j = i + 1; j < lines.length; j++) {
      if (!isFurniture(lines[j] ?? "")) unrecognised++;
    }
    if (unrecognised > MAX_UNRECOGNISED_BELOW) return null;
    return { titleIdx, footerIdx: i, options };
  }
  return null;
}

// ══ A DRAFTED BUG REPORT IS NOT A QUESTION FOR A HUMAN (bead sparkle-eou3y0.5) ═════════════════
// The card's footer is shaped like a picker's, so `screenAwaitsInput` matches it and the status
// engine painted the row `waiting`. That is the red "Needs you" band, and `retire_agent` reads it
// as an exchange in progress (`agent-busy`). The card is the agent's OWN feedback about Sparkle,
// offered for optional review. Nobody is blocked on it, and the turn that drew it has ended. So a
// finished agent whose only open thing was that card could be neither ignored nor retired.
//
// The answer is narrow. It does not say "a card is on screen, so nothing is asked". It removes the
// card's own footer row and asks `screenAwaitsInput` again. A real prompt drawn beside the card
// (a permission dialog, a shell `(y/n)`) still answers yes, so it still paints red.
//
// The STATUS question only. A write guard must still treat the card as a live dialog: its options
// are single keystrokes, and free text typed into it could press `2 send`. So this is used by the
// status engine and the retire predicate's activity read. `screenAwaitsInput` itself is unchanged.

/** True when a live feedback-draft card is the only thing on `snapshot` asking for input. */
export function feedbackDraftCardIsOnlyAsk(snapshot: string): boolean {
  if (!snapshot.trim()) return false;
  const lines = snapshot.replace(/\r/g, "\n").split("\n");
  const card = findFeedbackDraftCard(lines);
  if (!card) return false;
  const withoutCard = lines.map((l, i) => (i === card.footerIdx ? "" : l)).join("\n");
  return !screenAwaitsInput(withoutCard);
}

/** `screenAwaitsInput` for the STATUS band: true when something on screen waits on a person.
 *  A drafted-feedback card on its own does not count. See the block above. */
export function screenAwaitsHuman(snapshot: string): boolean {
  return screenAwaitsInput(snapshot) && !feedbackDraftCardIsOnlyAsk(snapshot);
}
