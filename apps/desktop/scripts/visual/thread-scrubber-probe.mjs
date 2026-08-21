#!/usr/bin/env node
// thread-scrubber-probe — look at the REAL scrubber rail in REAL Chrome and say whether it is
// actually usable, at the widths the concierge column can be dragged to.
//
//   pnpm --filter @sparkle/desktop visual:scrubber
//   pnpm --filter @sparkle/desktop visual:scrubber -- --json --shots=/tmp/out
//
// Exit 0 = every check passed; 1 = a real layout defect; 2 = the probe could not run.
//
// ── WHY THIS EXISTS (bead sparkle-7m719) ───────────────────────────────────────────────────────
// The founder asked for this rail four times over sixteen days. The way it disappoints him a fifth
// time is not a thrown error — it is the rail drawing, and being WRONG: the scope control painted
// past the edge of the column, or dots so faint against the track that "a dot per prompt" is not
// something a human can see.
//
// Neither is observable in jsdom, and that is not a gap in the unit suite — it is structural.
// jsdom has no layout engine: every `getBoundingClientRect` returns 0, no flex line is resolved,
// and no stylesheet is applied, so `ThreadScrubber.test.tsx` passes just as happily against a rail
// whose control is clipped off the side of the column and whose dots are invisible. The DOM facts
// are pinned there; the PIXELS are pinned here.
//
// ── WHAT IT ASSERTS ────────────────────────────────────────────────────────────────────────────
//   RAIL PRESENT     the rail renders at all, with its track and its handle. This is the founder's
//                    own stated regression guard, measured in a real browser rather than a fake DOM.
//   DOTS DRAWN       at least one dot exists AND every dot's centre sits inside the track's box. A
//                    dot painted outside the rail is not a dot, however many the DOM reports.
//   SCOPE IN COLUMN  the scope control's right edge sits inside the column's content box, and the
//                    control is not clipped by its own metrics. A `<select>` can be unclipped by
//                    `scrollWidth` and still be painted past the pane edge — both are checked,
//                    because they fail independently.
//   NO H-SCROLL      adding a fixed-width gutter to the thread must not make the column scroll
//                    sideways. This is the specific way a rail breaks the surface around it.
//   DOT CONTRAST     a dot is distinguishable from the track it sits on. "A dot per prompt" is the
//                    entire feature; a dot the same colour as the rail satisfies every DOM
//                    assertion and delivers nothing.
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { launch } from "./cdp.mjs";
import { startDevServer, CLEAR_STORAGE, TAURI_SHIM, FROZEN_CLOCK } from "./serve.mjs";
import { parseArgs } from "./capture.mjs";

/** Column widths to sweep. 420 is comfortable; 260 is about as narrow as the column is dragged. */
export const DEFAULT_WIDTHS = [520, 380, 260];

/**
 * The minimum perceptual gap between a dot and the track behind it.
 *
 * Expressed as a plain sRGB channel-distance rather than a contrast ratio: these are two decorative
 * fills, not text on a background, so WCAG's formula is the wrong instrument. The number is a floor
 * chosen to catch the failure that matters — a dot rendered in the TRACK's own colour, which scores
 * 0 — not to legislate the design. A designer moving the palette should not have to fight this.
 */
export const MIN_DOT_TRACK_DELTA = 12;

/**
 * Sideways overflow the concierge column reports WITHOUT the rail, per width.
 *
 * MEASURED, NOT ASSUMED, and recorded as a named baseline for the same reason
 * `concierge-header-probe` keeps one: this probe must fail on overflow the RAIL causes without
 * failing on overflow it merely inherited. Taken by un-mounting the rail and re-running:
 *
 *     260px column -> 35px overflow   (PRE-EXISTING, filed as a retro pain point under
 *                                       fbkey-a2599cbc2651; the store was locked at filing time so
 *                                       it is parked in the drop log and re-files on the next run)
 *     380px column -> 0px
 *     520px column -> 0px
 *
 * So the rail adds nothing at any of the three; the 260px figure is the column's own, and it is
 * filed rather than absorbed. Anything ABOVE the baseline is the rail's doing and fails.
 */
export const BASELINE_COLUMN_OVERFLOW_PX = { 260: 35 };

/** The inherited overflow allowed at `width`, defaulting to none. */
export function baselineOverflow(width) {
  return BASELINE_COLUMN_OVERFLOW_PX[width] ?? 0;
}

/**
 * The width is set with the fixtures' OWN `?concierge=<px>` parameter, not by seeding localStorage.
 *
 * TWO WRONG VERSIONS BEFORE THIS ONE (roborev 66422). The first wrote
 * `sparkle-sidebar-width:left`/`:right`, which is the BUILD column's storage — so the concierge sat
 * at its default for all three iterations and the sweep reported three passes at three widths
 * having rendered the same width three times. The second wrote the concierge's real keys and STILL
 * did not take, because `applyVisualFixtures` owns this column's width under `?visual=1` and
 * last-write-wins against anything seeded before it.
 *
 * `visualConciergeWidth` (src/dev/visualFixtures.ts) is the supported mechanism and it VALIDATES:
 * a non-integer, or a width the app would not itself persist, is rejected and the column falls back
 * to its default. That rejection is silent, which is exactly why `verdictFor` compares the column
 * it MEASURED against the width it asked for rather than trusting the request.
 */
export const widthParam = (w) => `&concierge=${w}`;
/**
 * Read the rail's real geometry. Runs IN THE PAGE, so it must be self-contained.
 *
 * Elements are found by their testids and ARIA label — the handles that are stable across every
 * scope, every count and every width. Keying on the visible token ("1d") would make the probe blind
 * to exactly the clipping it exists to measure.
 */
export const MEASURE = `(() => {
  const rail = document.querySelector('[data-testid="concierge-thread-scrubber"]');
  // THE COLUMN IS REPORTED EVEN WITH NO RAIL. "the rail is missing" and "the column overflows
  // sideways" are independent facts, and an early return that carried neither made it impossible to
  // ask whether an overflow was CAUSED by the rail or merely inherited from the column — which is
  // the first question anyone asks when this probe reports one.
  const colOf = (el) => el.closest('section[aria-label="Sparkle concierge"]')
    || document.querySelector('section[aria-label="Sparkle concierge"]');
  if (!rail) {
    const c = colOf(document.body);
    if (!c) return { found: false };
    const r = c.getBoundingClientRect();
    return {
      found: false,
      colBox: { x: r.x, y: r.y, w: r.width, right: r.right },
      colScrollW: c.scrollWidth,
      colClientW: c.clientWidth,
    };
  }
  const track = rail.querySelector('[data-scrubber-track="yes"]');
  const handle = rail.querySelector('[data-testid="concierge-thread-scrubber-handle"]');
  const dots = Array.from(rail.querySelectorAll('[data-testid="concierge-thread-scrubber-dot"]'));
  const scope = rail.querySelector('select');
  // The COLUMN is the concierge section — the box whose edge the rail must stay inside, and whose
  // sideways overflow a new gutter is the likeliest thing to cause.
  const col = rail.closest('section[aria-label="Sparkle concierge"]') || rail.parentElement;
  const cb = col.getBoundingClientRect();
  const tb = track ? track.getBoundingClientRect() : null;
  const box = (el) => { const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; };
  const rgb = (el) => getComputedStyle(el).backgroundColor;
  return {
    found: true,
    hasTrack: !!track,
    hasHandle: !!handle,
    dotCount: dots.length,
    railBox: box(rail),
    trackBox: tb ? { x: tb.x, y: tb.y, w: tb.width, h: tb.height, right: tb.right, bottom: tb.bottom } : null,
    colBox: { x: cb.x, y: cb.y, w: cb.width, right: cb.right },
    colScrollW: col.scrollWidth,
    colClientW: col.clientWidth,
    scope: scope ? {
      box: box(scope),
      scrollW: scope.scrollWidth,
      clientW: scope.clientWidth,
      value: scope.value,
      aria: scope.getAttribute('aria-label'),
      options: scope.options.length,
    } : null,
    // Every dot's centre, so a dot painted outside the track can be named rather than counted.
    dotCentres: dots.map((d) => { const r = d.getBoundingClientRect();
      return { cx: r.x + r.width / 2, cy: r.y + r.height / 2, w: r.width, colour: rgb(d) }; }),
    trackColour: track ? rgb(track) : null,
  };
})()`;

/** "rgb(r, g, b)" / "rgba(...)" -> [r,g,b], or null. */
export function parseRgb(s) {
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(s || "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Largest single-channel difference between two colours. 0 = identical. */
export function channelDelta(a, b) {
  const x = parseRgb(a), y = parseRgb(b);
  if (!x || !y) return null;
  return Math.max(Math.abs(x[0] - y[0]), Math.abs(x[1] - y[1]), Math.abs(x[2] - y[2]));
}

/**
 * Grade one measurement. PURE, so the rules are unit-testable without a browser — the same split
 * `concierge-header-probe` uses, and for the same reason: a verdict function that only exists
 * inside an async browser loop is one nobody can test.
 */
export function verdictFor(m, width) {
  const fails = [];
  const notes = [];
  if (!m.found) {
    // Still SAY what the column was doing, so a run with no rail is evidence rather than a dead end.
    if (typeof m.colScrollW === "number" && typeof m.colClientW === "number") {
      notes.push(
        `column ${Math.round(m.colBox?.w ?? 0)}px, sideways overflow ${m.colScrollW - m.colClientW}px (rail absent)`,
      );
    }
    return { width, ok: false, fails: ["the rail did not render at all"], notes };
  }
  if (!m.hasTrack) fails.push("the rail rendered with no track");
  if (!m.hasHandle) fails.push("the rail rendered with no draggable handle");

  if (m.dotCount === 0) {
    fails.push("the rail drew NO dots — a dot per prompt is the whole feature");
  } else if (m.trackBox) {
    const stray = m.dotCentres.filter(
      (d) => d.cx < m.trackBox.x - 8 || d.cx > m.trackBox.right + 8,
    );
    if (stray.length) fails.push(`${stray.length} dot(s) painted outside the track`);
  }

  if (!m.scope) {
    fails.push("the scope control is missing — the rail cannot be re-scoped");
  } else {
    // TWO INDEPENDENT FAILURES. A control can be clipped by its own metrics while sitting inside
    // the column, and it can be intact by its own metrics while painted past the column's edge.
    if (m.scope.scrollW > m.scope.clientW + 1) {
      fails.push(`the scope control is clipped by ${m.scope.scrollW - m.scope.clientW}px of its own width`);
    }
    if (m.scope.box.right > m.colBox.right + 0.5) {
      fails.push(
        `the scope control is painted ${Math.round(m.scope.box.right - m.colBox.right)}px past the column's right edge`,
      );
    }
    if (m.scope.options !== 13) notes.push(`scope offers ${m.scope.options} options, expected 13`);
  }

  // Only overflow BEYOND what the column does without a rail is this feature's fault. The inherited
  // amount is a measured, named baseline (see BASELINE_COLUMN_OVERFLOW_PX) rather than a silent
  // tolerance, so it is impossible to widen it without saying so.
  const overflow = m.colScrollW - m.colClientW;
  const inherited = baselineOverflow(width);
  if (overflow > inherited + 1) {
    fails.push(
      `the column scrolls sideways by ${overflow}px, ${overflow - inherited}px more than the ${inherited}px it does without the rail`,
    );
  } else if (inherited > 0) {
    notes.push(`column overflows ${overflow}px sideways, all of it pre-existing (baseline ${inherited}px)`);
  }

  if (m.railBox.right > m.colBox.right + 0.5) {
    fails.push(`the rail itself is painted past the column's right edge`);
  }

  // DID THE WIDTH SEED ACTUALLY TAKE? Nothing else here compares the column we MEASURED to the one
  // we ASKED for, which is what let a sweep against the wrong storage key report three identical
  // renders as three widths (roborev 66422). A probe that cannot tell it swept nothing is worse
  // than one that does not sweep.
  if (Math.abs(m.colBox.w - width) > 4) {
    fails.push(
      `asked for a ${width}px column and measured ${Math.round(m.colBox.w)}px — the width seed did not take, so this row swept nothing`,
    );
  }

  // CONTRAST — only checkable when both colours resolved. An unresolved colour is a NOTE, never a
  // pass: the check simply did not run, and saying so is honest where inventing a verdict is not.
  if (m.dotCount > 0 && m.trackColour) {
    const deltas = m.dotCentres.map((d) => channelDelta(d.colour, m.trackColour));
    if (deltas.some((d) => d === null)) {
      notes.push("could not read a dot or track colour, so contrast was not graded");
    } else {
      const worst = Math.min(...deltas);
      if (worst < MIN_DOT_TRACK_DELTA) {
        fails.push(
          `the faintest dot differs from the track by only ${worst} (floor ${MIN_DOT_TRACK_DELTA}) — invisible in practice`,
        );
      }
      notes.push(`faintest dot/track channel delta ${worst}`);
    }
  }

  notes.push(`${m.dotCount} dot(s) drawn`);
  return { width, ok: fails.length === 0, fails, notes };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const widths = args.widths ? String(args.widths).split(",").map(Number) : DEFAULT_WIDTHS;
  let server, browser;
  try {
    server = await startDevServer({ quiet: !args.verbose });
  } catch (e) {
    console.error(`could not start the dev server: ${e.message}`);
    process.exit(2);
  }
  try {
    browser = await launch({ width: 1600, height: 1200 });
  } catch (e) {
    server.stop();
    console.error(`could not launch Chrome: ${e.message}`);
    process.exit(2);
  }

  const results = [];
  try {
    for (const width of widths) {
      const page = await browser.newPage();
      try {
        const url = `${server.url}/?visual=1&capture=1${widthParam(width)}`;
        for (const source of [CLEAR_STORAGE, TAURI_SHIM, FROZEN_CLOCK]) {
          await page.addInitScript(source);
        }
        await page.navigate(url);
        // WAIT ON THE COLUMN, NOT THE RAIL. Waiting on the rail would make the "did not render"
        // branch unreachable — the wait would already guarantee what that check exists to test, so
        // an absent rail would time out as an environment failure instead of being GRADED as the
        // defect it is. Same reasoning as concierge-header-probe's row-not-badge wait.
        await page.waitForFunction(
          `!!document.querySelector('section[aria-label="Sparkle concierge"]')`,
          { timeout: 30000 },
        );
        // One frame for the rail's ResizeObserver to report a height and the dots to place.
        await page.evaluate(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
        const m = await page.evaluate(MEASURE);
        results.push({ ...verdictFor(m, width), measured: m });
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
    server.stop();
  }

  if (args.json) {
    const out = JSON.stringify(results, null, 2);
    if (typeof args.json === "string") writeFileSync(args.json, out);
    else console.log(out);
  } else {
    for (const r of results) {
      console.log(`${r.ok ? "✓" : "✗"} column ${r.width}px — ${r.notes.join("; ")}`);
      for (const f of r.fails) console.log(`    ✗ ${f}`);
    }
  }
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

// Only run when invoked directly, so the pure helpers above can be imported by a test.
//
// VIA pathToFileURL, NOT a `file://` TEMPLATE. This repo is checked out under a path containing
// spaces ("Application Support"), and `import.meta.url` percent-encodes them while `process.argv[1]`
// does not — so the template form never matches, `main()` never runs, and the probe exits 0 having
// checked NOTHING. A geometry guard that silently always passes is worse than no guard, and this
// one was caught only because its first run printed no verdict lines.
if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
