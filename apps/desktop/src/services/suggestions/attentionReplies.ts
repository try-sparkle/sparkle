import { detectTerminalPrompts } from "./heuristics";

export interface SuggestedReply {
  label: string;
  value: string;
}

/**
 * The `suggested_replies` a phone attention should carry. Prefers the REAL direct-answer buttons
 * the heuristic detector reads from the terminal (actual y/n confirmation, numbered menu choices);
 * falls back to a generic Approve/Deny only when nothing concrete is detected AND it's an approval
 * (a plain question with no detectable prompt carries no canned replies).
 */
export function suggestedRepliesFor(scrollback: string, approval: boolean): SuggestedReply[] {
  const detected = detectTerminalPrompts(scrollback);
  if (detected.length > 0) return detected.map((b) => ({ label: b.label, value: b.value }));
  return approval
    ? [
        { label: "Approve", value: "y\n" },
        { label: "Deny", value: "n\n" },
      ]
    : [];
}
