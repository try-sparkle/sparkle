// Shared helpers for asserting on RENDERED STYLE — a row's status dot, and the prefixed inline
// properties jsdom hides.
//
// It started as the dot half: extracted so the two files that pin dot appearance —
// AgentSidebar.liveStatusDots.test.tsx (no filter may hide the color) and
// AgentSidebar.redWorker.test.tsx (the head's color agrees with the concierge feed) — compare
// colors the same way. Two hand-rolled hex→rgb converters drifting is a silly way to lose a
// regression guard.
//
// `prefixedStyle` is here for the same reason and the charter is stated rather than left implicit
// (roborev 54048): it is the CANONICAL place to read a `-webkit-` inline property in a test, and
// the note on it is the one copy of why the cast exists. If you are writing an assertion about a
// masked element — the wordmark today, whatever is masked next — read it through that helper and
// widen its union rather than inlining a fresh cast with a fresh explanation. Two divergent
// sentences about the same jsdom quirk is exactly what consolidating it was meant to end.
import { AGENT_STATUS, type AgentTabStatus } from "@sparkle/ui";

/** `#34c759` → `rgb(52, 199, 89)`. jsdom normalizes inline colors to rgb(), so comparing against
 *  the raw token fails on FORM rather than on value — and a test that fails for the wrong reason
 *  can't tell you the dot went gray. Only the 6-digit hex the AGENT_STATUS tokens use is handled. */
export function asRgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

/** The rendered background of the StatusDot for `status`, as jsdom reports it. */
export function expectedDotColor(status: AgentTabStatus): string {
  return asRgb(AGENT_STATUS[status].color);
}

/** THE COLOR A DISC IS PAINTED, whichever variant it is drawn in.
 *
 *  `StatusDot` has two: a FILL (this row is in that state) writes `background`, and a RING (a row
 *  UNDER this one is, and this head stands in for it) writes an inset `box-shadow` over a
 *  transparent background. Reading `.style.background` alone therefore answers `"transparent"` for
 *  every rolled-up head — which is how adding the ring turned three green rollup guards red while
 *  the behaviour they guard (a worker's red reaching its head) was completely intact.
 *
 *  So assertions about WHICH COLOR a row is showing go through this, and assertions about WHICH
 *  VARIANT it is drawn in read `background`/`boxShadow` directly (see
 *  AgentSidebar.rollupRing.test.tsx). Keeping those two questions apart is the point: a rollup test
 *  should not fail because the fill style changed, and a ring test should not pass because the
 *  color happens to match.
 *
 *  NORMALIZED TO `rgb()`, so every caller compares the same way — `expectedDotColor(status)` works
 *  against a ring and a fill alike. jsdom normalizes `background` but leaves a `box-shadow` color as
 *  authored, and leaving that asymmetry to callers is a trap in BOTH directions: a positive
 *  assertion fails on form rather than value, and a NEGATIVE one (`not.toBe(...)`) passes
 *  vacuously against `"transparent"` — which is worse, because it looks like a guard and is not.
 *  A themed `var(--…)` has no resolvable value in jsdom and is returned as authored. */
export function dotInk(el: HTMLElement): string {
  const bg = el.style.background;
  if (bg && bg !== "transparent") return bg;
  // "inset 0 0 0 2.64px #e0533f" → "#e0533f" (or a var(--…) / rgb(…) form).
  const shadow = el.style.boxShadow ?? "";
  const m = shadow.match(/(#[0-9a-f]{3,8}|var\([^)]*\)|rgba?\([^)]*\))\s*$/i);
  const ink = m?.[1] ?? bg;
  return ink.startsWith("#") ? asRgb(ink) : ink;
}

/** Every `-webkit-` property `SparkleWordmark` actually sets. Widen it as more masked elements
 *  arrive — a union that admits what the components write is what keeps the next test from
 *  re-inlining the cast below. */
export type PrefixedProp =
  | "WebkitMaskImage"
  | "WebkitMaskSize"
  | "WebkitMaskRepeat"
  | "WebkitMaskPosition";

/** A `-webkit-` prefixed style property, read the way it is actually stored.
 *
 *  React writes these under the `Webkit`-cased key and jsdom keeps them THERE — they do not appear
 *  in `cssText`, `getPropertyValue("-webkit-mask-image")` returns `""` for them, and the lowercase
 *  `webkitMaskImage` name TypeScript's DOM lib declares is `undefined` at runtime. Hence the cast.
 *  It lives here rather than inline in each wordmark test so the two windows read the mask the same
 *  way, and so this explanation exists once instead of drifting between two copies (roborev 54043). */
export function prefixedStyle(el: HTMLElement, prop: PrefixedProp): string | undefined {
  return (el.style as unknown as Record<string, string>)[prop];
}

/** Any inline `filter` on `el` or an ancestor within a few levels — the row treatment that used to
 *  gray every dot was applied via inline style on an ANCESTOR of the dot, so checking the dot alone
 *  would miss a revert. Returns the offending value rather than a boolean so a failure names what
 *  came back instead of just "expected false". */
export function filterOn(el: HTMLElement | null): string {
  let cur: HTMLElement | null = el;
  for (let i = 0; cur && i < 4; i++, cur = cur.parentElement) {
    const f = cur.style.filter ?? "";
    if (f !== "") return f;
  }
  return "";
}
