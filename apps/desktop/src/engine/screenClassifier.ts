// screenClassifier — decides, from a plain-text snapshot of the *rendered* terminal
// screen, whether the agent is blocked on a specific answer from the user.
//
// Why a separate, pure function: the engine owns the GREEN (working) signal via Claude's
// live "esc to interrupt" spinner, which is reliable on the raw stream. The hard call is
// the settle-time RED-vs-GRAY decision — and the raw byte stream is a poor surface for it
// (ANSI escapes, in-place redraws with no newlines). The fully rendered xterm screen is
// clean: it shows the actual permission box / question menu Claude drew. This function
// takes that snapshot and returns true only when the user is genuinely on the hook.
//
// Bias toward FALSE (gray). A false RED nags the user about a finished turn; a missed RED
// just shows gray on a real question, which the user notices anyway when they look. So we
// key off INTERACTIVE markers (Claude's ❯ selection cursor, classic shell prompts) rather
// than prose. Claude's own conversational "Do you want…?" text is deliberately NOT a
// trigger — its permission UI always pairs that text with the ❯ menu, which we do catch.
//
// Retrainable: Claude's TUI drifts between versions. If these markers ever stop matching,
// this is the one place to retune (or swap in a model call) without touching the engine.

// Claude Code's interactive selection cursor (U+276F) at the start of a numbered choice,
// e.g. "❯ 1. Yes". This is the strongest, most Claude-specific "answer me" signal and the
// shape behind every permission / plan-mode prompt.
const SELECTION_CURSOR = /^\s*[│|]?\s*❯\s*\d+\.\s/m;

// Classic shell / CLI prompts. These don't appear in Claude's prose, so they're safe to
// match anywhere in the snapshot. The `/i` flag case-folds, so one delimiter-agnostic
// pattern covers `(y/n)`, `[Y/n]`, `[y/N]` etc. (It also matches mismatched delimiters
// like `(y/n]` — harmless: such strings never occur in prose and are still prompt-like.)
const SHELL_PROMPTS: RegExp[] = [
  /[([]y\/n[)\]]/i,
  /press enter to continue/i,
  /\boverwrite\?/i,
  /(^|\s)password:\s*$/im,
  /enter passphrase/i,
];

/**
 * True when the rendered screen shows the agent blocked on a specific answer from the
 * user (a Claude selection menu or a shell prompt). False for a finished turn at the idle
 * input box, conversational prose, or an empty screen.
 */
export function screenAwaitsInput(snapshot: string): boolean {
  if (!snapshot.trim()) return false;
  if (SELECTION_CURSOR.test(snapshot)) return true;
  return SHELL_PROMPTS.some((re) => re.test(snapshot));
}
