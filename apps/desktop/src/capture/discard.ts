// Discard rule for the capture modal (spec §3). Pure so vitest covers it directly: Esc or a
// scrim-click closes the takeover immediately when nothing has been narrated, but a real
// transcript earns an inline "Discard capture?" confirm — a stray click must never silently
// throw away dictated text. Whitespace-only input counts as empty.

export function shouldConfirmDiscard(text: string): boolean {
  return text.trim().length > 0;
}
