// composerOcclusion — what is the composer overlay currently HIDING, and should we get out of
// the way?
//
// Why this exists: the composer is a bottom overlay (position:absolute, bottom:0) floating over a
// terminal that is sized to the FULL stage height — see AgentPane's terminal stage and
// composerDrag.ts's model comment. The bottom rows are genuinely rendered by xterm, just painted
// underneath the composer. That's deliberate: what normally sits there is Claude's own input line,
// and covering it is how we steer typing into the composer.
//
// The bug (reported with screenshots): Claude draws its INTERACTIVE MENUS in that same live bottom
// region. A resume prompt or permission box lands under the composer and the user can't see it —
// the options are simply invisible. The pre-existing escape hatch was manual (drag down / ⌘J), and
// nothing told the user there was anything to reveal.
//
// This module is the pure decision half of the fix: pixel geometry → covered row count, and covered
// row TEXT → what kind of thing is hidden. Kept DOM-free so it unit-tests alongside composerDrag.ts
// and terminalSize.ts, the same pattern the rest of this layer already uses.
//
// Precision bias, and it differs per action:
//   • AUTO-YIELD (move the composer on the user's behalf) fires ONLY on an actionable prompt. A
//     spurious jump while someone is mid-sentence is worse than a missed one.
//   • The CHIP ("N lines hidden") is cheap and reversible, so it fires on any real hidden content.
// Both treat the idle input box and the working spinner as chrome, so neither is noise during a
// normal turn.
import { screenAwaitsInput } from "./screenClassifier";

export type OcclusionKind =
  /** Nothing is under the composer. */
  | "empty"
  /** Only things the overlay is MEANT to cover: the idle input box, hints, the spinner. */
  | "chrome"
  /** Real text the user can't see, but nothing they must answer. */
  | "content"
  /** An actionable prompt — a Claude ❯ menu or a shell y/n. The reported bug. */
  | "prompt";

export interface Occlusion {
  kind: OcclusionKind;
  /** Non-chrome lines hidden — what the chip reports. Chrome and blanks don't count. */
  hiddenLines: number;
}

/** Box-drawing glyphs Claude frames its input/permission boxes with. Stripped before judging a
 *  line's content so a bordered line is classified by what's INSIDE the border.
 *
 *  Deliberately Unicode-only — the ASCII pipe is NOT here. Claude's boxes draw with U+2502 (│),
 *  while `|` is ordinary content: shell pipelines, markdown tables, code. Stripping it globally
 *  would mangle real output before classification (e.g. a table row `| > |` collapsing to `>` and
 *  reading as the input line). */
const BOX_DRAWING = /[─│╭╮╰╯├┤┬┴┼━┃┏┓┗┛┌┐└┘]/g;

/** Claude's rotating spinner glyphs, which lead its transient "working" line. */
const SPINNER_GLYPH = /^[✻✽✢✶✳·*∗]\s/;

/** The live status line during a turn, e.g. "✽ Baked for 2m 24s" or "· Thinking… (esc to
 *  interrupt)". Transient by nature — surfacing a chip for it would flicker through every turn. */
function isTransientStatus(bare: string): boolean {
  return SPINNER_GLYPH.test(bare) || /\(esc to interrupt\)/i.test(bare);
}

/**
 * Is this line something the composer is SUPPOSED to be covering? True for blanks, pure box
 * borders, the input prompt (empty or typed-into), the shortcuts hint, and the working spinner.
 */
function isChromeLine(line: string): boolean {
  const bare = line.replace(BOX_DRAWING, "").trim();
  if (bare === "") return true;
  // The terminal input line — empty (">") or with text the user typed straight into the terminal.
  // Covered by design either way; that IS the overlay's job.
  if (bare === ">" || bare.startsWith("> ")) return true;
  // Claude's footer hint, e.g. "? for shortcuts".
  if (/^\?\s/.test(bare)) return true;
  return isTransientStatus(bare);
}

/**
 * How many terminal rows the composer currently covers.
 *
 * `bottomInset` is the padding between the terminal's text box and the bottom of the stage the
 * composer is anchored to (AgentPane pads the terminal by 6px), so the composer's first few pixels
 * cover padding rather than text.
 *
 * Returns 0 for a non-positive `cellHeight` — an unmeasured / pre-layout terminal. Guessing from a
 * collapsed box is exactly the failure mode terminalSize.ts exists to prevent, so we decline
 * rather than invent a row count.
 */
export function occludedRowCount(p: {
  composerHeight: number;
  cellHeight: number;
  rows: number;
  bottomInset?: number;
}): number {
  if (p.cellHeight <= 0) return 0;
  const covered = p.composerHeight - (p.bottomInset ?? 0);
  if (covered <= 0) return 0;
  // Round UP: a row the composer only half-covers is still unreadable.
  return Math.min(p.rows, Math.ceil(covered / p.cellHeight));
}

/**
 * The xterm buffer indices of the bottom `count` rows currently ON SCREEN, top-to-bottom.
 *
 * xterm buffer indices are absolute (scrollback + screen), and `viewportY` is the buffer index of
 * the TOP visible row — so the last visible row is `viewportY + rows - 1`, which is NOT the same as
 * the end of the buffer whenever the user has scrolled back. Reading from the buffer end instead
 * would classify history the composer isn't covering. Extracted here (rather than inlined in
 * Terminal.tsx) so this index math is unit-tested instead of trusted.
 */
export function bottomRowIndices(p: {
  viewportY: number;
  rows: number;
  count: number;
}): number[] {
  if (p.count <= 0) return [];
  const n = Math.min(p.count, p.rows);
  const lastVisible = p.viewportY + p.rows - 1;
  const out: number[] = [];
  for (let i = lastVisible - n + 1; i <= lastVisible; i++) {
    if (i >= 0) out.push(i); // a screen taller than the buffer so far can propose negatives
  }
  return out;
}

/**
 * Classify the text of the covered rows. `lines` is the bottom-N slice of the rendered screen,
 * top-to-bottom, already translated to plain strings.
 */
export function classifyOccludedRows(lines: readonly string[]): Occlusion {
  const hiddenLines = lines.filter((l) => !isChromeLine(l)).length;
  if (hiddenLines === 0) {
    // Distinguish "nothing there at all" from "only the input box" — both are inert, but the
    // difference is worth keeping for diagnostics and for future callers.
    const anyText = lines.some((l) => l.trim() !== "");
    return { kind: anyText ? "chrome" : "empty", hiddenLines: 0 };
  }
  // Reuse the engine's existing, already-tuned marker set (Claude's ❯ selection cursor + classic
  // shell prompts) rather than growing a second copy that can drift from it.
  if (screenAwaitsInput(lines.join("\n"))) return { kind: "prompt", hiddenLines };
  return { kind: "content", hiddenLines };
}

/**
 * Do two classifications describe the same screen?
 *
 * The poll re-classifies on a fixed interval and `classifyOccludedRows` always returns a FRESH
 * object, so storing its result unconditionally re-renders the pane at the poll rate forever —
 * even on a completely idle terminal where the answer never changes. Callers gate the state write
 * on this so an unchanged verdict costs nothing. Safe as a plain field compare: `Occlusion` is two
 * primitives, and every consumer reads it by value.
 */
export function sameOcclusion(a: Occlusion, b: Occlusion): boolean {
  return a.kind === b.kind && a.hiddenLines === b.hiddenLines;
}

/** Should the composer move itself out of the way? Only for something the user must answer. */
export function shouldAutoYield(o: Occlusion): boolean {
  return o.kind === "prompt";
}

/** Should the "N lines hidden" chip show on the composer handle? Any real hidden content. */
export function shouldShowHiddenChip(o: Occlusion): boolean {
  return o.kind === "prompt" || o.kind === "content";
}

/**
 * Auto-yield state. Tracked so the feature only ever gives back what it took, and so it can lose
 * an argument with the user gracefully.
 *   idle       — we haven't moved the composer; free to yield when a prompt shows up.
 *   yielded    — WE minimized it; we owe the user a restore once the prompt clears.
 *   suppressed — the user pulled the composer back up while the prompt was still on screen. They
 *                want to type, not answer. Hands off until this prompt goes away.
 */
export type YieldState = "idle" | "yielded" | "suppressed";

/**
 * The composer height to MEASURE occlusion against — which is not always the height it currently
 * has on screen.
 *
 * Once we've yielded, minimizing has (by design) revealed the prompt, so the rows still covered by
 * the slim bar no longer contain it. Measuring reality there reads as "the prompt resolved", we
 * restore, the prompt is re-covered, and we yield again — a 250ms oscillation, the precise
 * "fight the user in a loop" failure this module exists to prevent. So while `yielded` we keep
 * measuring against the OPEN height: the question that actually matters is "would the prompt still
 * be covered if I gave the composer back?", and only a "no" should restore it.
 */
export function measuredComposerHeight(p: {
  minimized: boolean;
  openHeight: number;
  barHeight: number;
  state: YieldState;
}): number {
  if (p.state === "yielded") return p.openHeight;
  return p.minimized ? p.barHeight : p.openHeight;
}

/**
 * The composer's next auto-yield move, or null for "leave everything alone".
 *
 * Two invariants this exists to protect, both of which are worse than the original bug if broken:
 *   1. Never restore a composer the USER minimized (state stays `idle`, so we never claim it).
 *   2. Never re-minimize after the user overrides us — that would fight them in a loop, ripping
 *      the box away on every tick while they try to type.
 */
export function resolveAutoYield(p: {
  occlusion: Occlusion;
  minimized: boolean;
  state: YieldState;
}): { minimized: boolean; state: YieldState } | null {
  const wantsRoom = shouldAutoYield(p.occlusion);

  if (p.state === "yielded") {
    // Prompt resolved → hand the composer back exactly as we found it.
    if (!wantsRoom) return { minimized: false, state: "idle" };
    // Prompt still up but the composer is open again → the user overrode us. Stand down.
    if (!p.minimized) return { minimized: false, state: "suppressed" };
    return null;
  }

  if (p.state === "suppressed") {
    // Re-arm only when the prompt clears, so the NEXT one yields normally.
    return wantsRoom ? null : { minimized: false, state: "idle" };
  }

  // idle: yield only for an actionable prompt, and only if we're actually in the way.
  if (wantsRoom && !p.minimized) return { minimized: true, state: "yielded" };
  return null;
}
