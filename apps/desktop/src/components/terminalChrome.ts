// ── THE TERMINAL PLANE'S OWN CHROME ────────────────────────────────────────────────────────────
//
// The Blueprint direction gives the terminal its OWN register: a fill step the other planes don't
// take, a pair of inks that are not the shell's, and — the part that keeps getting lost — a
// DIFFERENT, DARKER RULE. This module is where the terminal pane's components read those from, so
// the distinction survives the next edit instead of being re-derived by eye at each call site.
//
// WHY IT IS A MODULE AND NOT FOUR LITERALS. Six releases shipped against the direction and none of
// them looked like it, because each pass ported the colours and re-invented the structure (see the
// header of theme/blueprintSpec.ts). The type scale and the radii are structure. They are read from
// the approved page by `terminalChrome.test.ts`, which parses `PRD/sparkle/ui-directions/rev4.html`
// and fails on any drift — the same contract `blueprintSpec.test.ts` holds the palette to.
//
// ── THE RULE THAT IS NOT THE CHROME HAIRLINE ───────────────────────────────────────────────────
// `C.hairline` is the SHELL's edge — the spec's `seam`. It is deliberately NOT floored against the
// terminal plane: `theme/chromeContrast.test.ts` skips that pair (`if (plane === TERM_PLANE)
// continue`) and floors `termHairline` there instead. So a `C.hairline` border drawn on this plane
// is the one edge in the app with no guard behind it at all — it is not "close enough", it is
// unmeasured. Every rule this pane draws, and every chip that sits on it, takes TERM_HAIRLINE.
//
// ── WHY THE INKS ARE JS AND THE SURFACES ARE var() ─────────────────────────────────────────────
// `--c-forest` and `--c-term-hairline` are mirrored into index.css from THEME_HEX, so they follow a
// `<html data-theme>` flip with no React re-render — that is the cheap path and it is used wherever
// it exists. `termInk`/`termMuted` have no CSS variable (THEME_HEX does not carry them, and
// `theme/cssMirror.test.ts` enforces index.css's key set against THEME_HEX exactly, so one cannot
// be added from here). They are therefore read from the spec data per resolved theme, which costs a
// re-render on a theme flip. That re-render must never become a REMOUNT: a Terminal unmount kills
// its PTY. `Terminal.blueprint.test.tsx` holds that line.
import { BLUEPRINT } from "../theme/blueprintSpec";
import type { ResolvedTheme } from "../theme/theme";

/** The pane's surface — the spec's `term` plane, the one register that gets a real fill step.
 *  A CSS var, so a theme flip repaints it without React. */
export const TERM_PLANE = "var(--c-forest)";

/** The rule the spec draws WHERE A BOUNDARY MEETS THE TERMINAL PLANE — the spec's `termHair`,
 *  carried by THEME_HEX as `termHairline` and mirrored to `--c-term-hairline`. Darker than the
 *  shell's `seam`, because it is read against a much darker (dark) / much lighter (light) ground.
 *  NOT `C.hairline`: see the note above. */
export const TERM_HAIRLINE = "var(--c-term-hairline)";

/** The spec's type scale, in px. `--t-micro` / `--t-small` / `--t-body` / `--t-title`. */
export const TERM_TYPE = { micro: 10, small: 12, body: 13, title: 17 } as const;

/** The spec's near-square radii, in px. `--r-sm` / `--r-in` / `--r-md`. The direction's shapes are
 *  drawn, not pillowed — nothing on this plane rounds past `modal`. */
export const TERM_RADIUS = { sm: 3, input: 4, modal: 6 } as const;

/** `--k-mono` — anything monospaced in the pane's chrome (never the terminal BODY, which xterm
 *  renders in its own font stack). */
export const TERM_MONO = 'ui-monospace, "SF Mono", Menlo, monospace';

/** `--k-ui` — the system face the whole direction is set in. */
export const TERM_UI = 'system-ui, -apple-system, "Segoe UI", sans-serif';

/** Primary ink ON the terminal plane. A separate register from the shell's `cream`. */
export function termInk(resolved: ResolvedTheme): string {
  return BLUEPRINT[resolved].termInk;
}

/** Secondary ink on the terminal plane — the pane's quiet labels, hints and status lines. */
/**
 * THE PANE'S SECONDARY INK — A MEASURED DEPARTURE FROM THE SPEC PAGE, NOT A PORTING SLIP.
 *
 * The spec's `--k-term-muted` is `#5a6f8e` light / `#61789c` dark, and on the terminal plane it
 * measures 3.96 / 4.44 — under AA in BOTH themes. That is fine for a hairline or a dim glyph, and
 * not fine for the four places this register is read as TEXT: the loading hint, the overlay
 * message, AgentPane's error message, and `Centered`. Routing those to the spec value was a net
 * contrast REGRESSION at every one of them — the overlay message went from 7.77 to 3.96 in light —
 * because they previously used the shell's inks (roborev 54704).
 *
 * So the pane's own register is kept, and the value is lifted to the nearest point in the SAME hue
 * that clears AA: a luminance move, not a different colour. `termMutedSpec` below preserves the
 * spec's value for anything that is not ink, and `terminalChrome.test.ts` asserts both — the
 * departure as a failing measurement, so it reads as a decision and goes red if a future palette
 * move makes the spec's own value legible again.
 */
export function termMuted(resolved: ResolvedTheme): string {
  return resolved === "light" ? "#536683" : "#62799d";
}

/** The spec's literal `--k-term-muted`. Not for text — see `termMuted`. */
export function termMutedSpec(resolved: ResolvedTheme): string {
  return BLUEPRINT[resolved].termMuted;
}
