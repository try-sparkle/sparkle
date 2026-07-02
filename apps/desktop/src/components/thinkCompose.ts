// Pure composition of a Think turn from typed text + attached capture screenshots. Neither chat
// backend accepts image content blocks yet, so each screenshot rides as a `[Screenshot: <path>]`
// line appended after the typed text (Claude Code reads the image off disk via the path). An image
// alone is sendable — the capture modal's "image alone is sendable" rule. Extracted so both the
// manual send() and the auto-send handoff branch compose identically and the cases are unit-tested
// (roborev 25166/25167).

/** Join typed text and one `[Screenshot: <path>]` line per shot into the dispatched turn. Returns
 *  "" only when there is neither text nor a shot (callers already guard against dispatching that). */
export function composeThinkTurn(typed: string, shotPaths: string[]): string {
  const refs = shotPaths.map((p) => `[Screenshot: ${p}]`).join("\n");
  return [typed.trim(), refs].filter(Boolean).join("\n\n");
}
