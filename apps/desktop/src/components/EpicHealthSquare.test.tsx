// @vitest-environment jsdom
//
// THE COLOUR-PARITY GUARD. This file exists for one assertion: for every mark an epic square can
// take, the square is painted the SAME colour the build column paints an agent row for that same
// mark. The founder, 2026-08-22: *"For the gray I do want it to work exactly like the Build Agent.
// That's the hard rule. The colors work the same between the two and don't let any instruction ever
// override that."*
//
// ══ WHY THE EXPECTED VALUE IS NEVER TYPED OUT ══════════════════════════════════════════════════
// A test that hard-codes `#34c759` asserts a COPY, which is the exact bug it is supposed to prevent:
// a hex re-typed in a third place agrees with the second place until somebody changes the first. So
// both sides of every colour assertion below are READ FROM PRODUCTION — the square from a real
// render, the build row from `rowClock.dotFillFor`, which is the function `AgentRow` itself calls to
// fill a disc. If the two tables ever diverge, this file goes red with no edit required.
//
// ══ THE jsdom TRAP THIS FILE IS WRITTEN AROUND (docs/jsdom-test-caveats.md) ════════════════════
// jsdom never loads the stylesheet, so a class-derived `getComputedStyle` read comes back EMPTY —
// on a colour test that is perfect camouflage, because "" === "" passes. Two defences:
//
//   • Only INLINE style is read (`el.style.background`), never a computed class colour.
//   • Every expected value goes through {@link asCss}, a real jsdom element, so the comparison is
//     apples-to-apples (jsdom rewrites `#34c759` to `rgb(52, 199, 89)` and leaves `var(--x)` alone)
//     — and {@link asCss} is itself asserted NON-EMPTY, so a value jsdom silently drops fails here
//     instead of quietly making the assertion vacuous.
import { describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach } from "vitest";
import { EpicHealthSquare } from "./EpicHealthSquare";
import { ROLLUP_DOT_COLOR, dotFillFor } from "./rowClock";
import { epicHealth, type EpicHealth } from "../engine/epicHealth";
import type { RollupDot } from "../engine/workerRollup";

afterEach(cleanup);

/** Every dot the build row can paint. `Record<RollupDot, true>` rather than an array, so a sixth
 *  member of the union fails to COMPILE here instead of quietly going unpainted and untested. */
const ALL_DOTS_PRESENT: Record<RollupDot, true> = {
  green: true,
  red: true,
  blue: true,
  orange: true,
  gray: true,
};
const ALL_DOTS = Object.keys(ALL_DOTS_PRESENT) as readonly RollupDot[];

/** Push a colour through jsdom's own CSS parser so it is comparable with what React wrote onto the
 *  rendered element. Asserted non-empty by every caller: a value jsdom drops would otherwise make
 *  the comparison `"" === ""`, which is the silent-pass this whole file is guarding against. */
function asCss(value: string): string {
  const probe = document.createElement("span");
  probe.style.background = value;
  return probe.style.background;
}

/** The same apples-to-apples trick {@link asCss} plays, for `border-radius`: React writes a unitless
 *  `0` and jsdom stores it verbatim, so a hand-typed `"0px"` would not match a correct square. */
function asRadius(value: string | number): string {
  const probe = document.createElement("span");
  probe.style.borderRadius = String(value);
  return probe.style.borderRadius;
}

function square(health: EpicHealth): HTMLElement {
  const { container } = render(<EpicHealthSquare health={health} />);
  const el = container.querySelector<HTMLElement>('[data-testid="epic-health"]');
  if (!el) throw new Error(`no square rendered for ${health}`);
  return el;
}

/** What the BUILD COLUMN fills a rolled-up disc with for this dot — `rowClock.dotFillFor`, the
 *  function `AgentRow` calls, not a re-derivation.
 *
 *  `section: undefined` is the ordinary case (this window has not polled the row's git state) and is
 *  the one the epics column can be compared against at all: `dotFillFor` repaints a GRAY row amber
 *  when its git section is pre-terminal, and the epics column does not poll git state, so it cannot
 *  see that repaint. That narrowness is stated in `engine/epicHealth`'s header; everything else is
 *  exact. */
function buildRowFill(dot: RollupDot): string {
  const fill = dotFillFor("idle", undefined, dot, true);
  if (fill === undefined) throw new Error(`build row has no rolled-up fill for ${dot}`);
  return fill;
}

describe("EpicHealthSquare — colour parity with the build agent dot", () => {
  it("paints each mark the SAME colour the build row paints that dot", () => {
    // THE FOUNDER'S HARD RULE, asserted per value. Both sides come from production: the left from a
    // real render of the component, the right from the build column's own fill function.
    for (const dot of ALL_DOTS) {
      const expected = asCss(buildRowFill(dot));
      // NOT VACUOUS: if jsdom had dropped the value, this would be "" and every comparison below
      // would pass against a square painted nothing at all.
      expect(expected, `jsdom dropped the build-row fill for ${dot}`).not.toBe("");
      expect(square(dot).style.background, dot).toBe(expected);
    }
  });

  it("reads its colours from ROLLUP_DOT_COLOR itself — the same record, not an equal one", () => {
    // The layer beneath the assertion above: `dotFillFor` returns `ROLLUP_DOT_COLOR[dot]` for a
    // rolled-up row, so pinning the square to the record directly says WHERE the colour came from,
    // and reds if the component grows a local map that happens to agree today.
    for (const dot of ALL_DOTS) {
      expect(buildRowFill(dot), dot).toBe(ROLLUP_DOT_COLOR[dot]);
      expect(square(dot).style.background, dot).toBe(asCss(ROLLUP_DOT_COLOR[dot]));
    }
  });

  it("paints five DISTINCT colours — no two marks collapse into one", () => {
    // The parity loop above would still pass if `ROLLUP_DOT_COLOR` and the square both folded two
    // marks together. Five values in, five colours out is what says the square can actually tell
    // you which of the five it is.
    const painted = ALL_DOTS.map((d) => square(d).style.background);
    expect(new Set(painted).size).toBe(ALL_DOTS.length);
  });
});

describe("EpicHealthSquare — gray is a real gray square, not a hollow amber one", () => {
  it("renders an epic with ZERO agents bound as the build row's inactive gray", () => {
    // The one case with no build-row analogue — a build row always has an agent — and it is still
    // answered in the build row's vocabulary rather than a private one. `epicHealth([])` is the
    // production rule, not a hand-written "gray".
    const health = epicHealth([]);
    expect(health).toBe("gray");
    const expected = asCss(buildRowFill("gray"));
    expect(expected).not.toBe("");
    expect(square(health).style.background).toBe(expected);
  });

  it("fills gray SOLID — the hollow outline the founder overruled is gone", () => {
    // It used to be `background: transparent` with a 1.5px amber border. Asserting the absence of
    // the border alone would pass for a square painted nothing, so the fill is asserted too — and
    // it is asserted to be the GRAY fill, which is what makes this a statement about the rule
    // rather than about a style property.
    const el = square("gray");
    expect(el.style.background).toBe(asCss(buildRowFill("gray")));
    expect(el.style.background).not.toBe(asCss("transparent"));
    expect(el.style.border).toBe("");
  });

  it("gives every mark a solid fill and no border — no mark is hollow any more", () => {
    for (const dot of ALL_DOTS) {
      const el = square(dot);
      expect(el.style.border, dot).toBe("");
      expect(el.style.background, dot).not.toBe("");
      expect(el.style.background, dot).not.toBe(asCss("transparent"));
    }
  });
});

describe("EpicHealthSquare — shape is the ONLY thing that differs from a build dot", () => {
  it("keeps hard corners for every mark, so it can never be mistaken for a disc", () => {
    // The founder asked for "square instead of circle" so that shape tells him which column he is
    // reading. Colour parity is the rule; geometry is the exception the rule leaves standing.
    for (const dot of ALL_DOTS) {
      // React writes the numeric `0` through unitless, so jsdom stores "0" rather than "0px" —
      // compared through `asRadius` so a `999`/`50%` creeping in reds here instead of matching a
      // hand-typed string that happens to differ in units.
      expect(square(dot).style.borderRadius, dot).toBe(asRadius(0));
      expect(square(dot).style.borderRadius, dot).not.toBe(asRadius("50%"));
    }
  });

  it("labels every mark, and announces it — the square is the row's only progress statement", () => {
    for (const dot of ALL_DOTS) {
      const el = square(dot);
      expect(el.getAttribute("data-health"), dot).toBe(dot);
      expect(el.getAttribute("role"), dot).toBe("img");
      expect(el.getAttribute("aria-label"), dot).toBeTruthy();
      expect(el.getAttribute("title"), dot).toBe(el.getAttribute("aria-label"));
    }
    // Distinct words per mark, so the hover text cannot say "nobody is working" about a green epic.
    const labels = ALL_DOTS.map((d) => square(d).getAttribute("aria-label"));
    expect(new Set(labels).size).toBe(ALL_DOTS.length);
  });

  it("takes no click handler — EpicRow is one button and a child would swallow its click", () => {
    // `Workspace.epicsColumn.test.tsx` clicks every descendant of the row asserting the row's own
    // handler still fires; this is the local half of that contract.
    const el = square("green");
    expect(el.onclick).toBeNull();
    expect(el.tagName).toBe("SPAN");
  });
});
