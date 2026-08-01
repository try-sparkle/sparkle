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
import { FONT_MONO, FONT_UI } from "../theme/scale";
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
 *  renders in its own font stack).
 *
 *  RE-EXPORTED FROM THE TOKEN, not re-typed. These two were literal copies of `--k-mono` / `--k-ui`,
 *  which is the drift `fontTokens.test.ts` exists to stop: the app once shipped IBM Plex Sans and
 *  Verdana against a spec that uses the system face for both, and that single substitution is most
 *  of why the running app read as a different product from the approved design. A second copy of a
 *  stack is a second place for that to happen. The names stay so the pane's call sites keep reading
 *  in terminal-plane vocabulary. */
export const TERM_MONO = FONT_MONO;

/** `--k-ui` — the system face the whole direction is set in. */
export const TERM_UI = FONT_UI;

/**
 * THE TERMINAL BODY'S OWN FACE — the stack xterm renders the session in.
 *
 * ══ WHY THIS IS A CONCRETE STACK AND NOT `TERM_MONO` ════════════════════════════════════════════
 * Every other face on this plane is a CSS var, and re-typing one is the drift `fontTokens.test.ts`
 * exists to stop. This one cannot be: xterm measures glyph cells itself and reads its `fontFamily`
 * option as a real font stack, not through the cascade — the same reason its `theme` takes concrete
 * hex rather than `var()` (see Terminal's XTerm options). So the terminal body has always been a
 * literal, and the only question is whether there is ONE of it.
 *
 * ══ WHY IT MOVED HERE ═══════════════════════════════════════════════════════════════════════════
 * There is now a second consumer. When the concierge is mounted to a build agent, its composer
 * routes what you type into that agent's terminal — and the founder asked for the composer to be SET
 * in this face while it is aimed there, so the typeface itself says where the words are going,
 * without a label to read. A second copy of the stack in the composer would be exactly the
 * substitution this file's header warns about, and it would fail silently: the composer would simply
 * stop looking like the terminal, and nothing would be red.
 *
 * ORDER IS LOAD-BEARING. The system monospaces (SF Mono, Menlo) carry the full box-drawing block as a
 * fallback; the Google-Fonts subset of Source Code Pro drops U+2500. Do not reorder to put a webfont
 * last "for consistency" — a TUI's borders come apart.
 */
export const TERM_BODY_FONT =
  '"Source Code Pro", "SF Mono", Menlo, ui-monospace, monospace';

/**
 * The terminal body's font size at zoom 1, in px.
 *
 * The composer takes THIS rather than the zoomed value, and that is deliberate rather than a
 * simplification: per-column zoom is a property of the pane the user scaled, the composer lives in a
 * different column with its own width, and a compose box that resized itself every time someone
 * zoomed a terminal would reflow the thread above it for a reason nobody asked for. Matching the
 * FACE is what makes the typeface legible as the terminal's; matching a zoom level is not.
 */
export const TERM_BODY_BASE_SIZE = 13;

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
  // DARK IS A REAL STEP, NOT A THRESHOLD PASS. The first cut used `#62799d` — literally +1 per
  // channel on the spec's `#61789c`, moving 4.4424 → 4.5053. That clears the bar by 0.1%, which no
  // user can perceive, on text the same commit had just declared illegible at 4.44; and it left
  // this guard and its companion (`termMutedSpec < 4.5`) only 0.063 apart, so any nudge to the
  // dark `term` plane would flip one of them red for reasons unrelated to the ink (roborev 54855).
  // `#6b83a8` is 5.167 — the same blue, a step the eye can actually use.
  return resolved === "light" ? "#536683" : "#6b83a8";
}

/** The spec's literal `--k-term-muted`. Not for text — see `termMuted`. */
export function termMutedSpec(resolved: ResolvedTheme): string {
  return BLUEPRINT[resolved].termMuted;
}
