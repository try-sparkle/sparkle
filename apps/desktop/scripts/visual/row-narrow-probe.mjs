#!/usr/bin/env node
// row-narrow-probe — read the REAL GEOMETRY of the BUILD COLUMN's agent rows at a narrow column
// width and say whether the name is readable and whether anything overlaps.
//
//   pnpm --filter @sparkle/desktop visual:row-narrow
//   pnpm --filter @sparkle/desktop visual:row-narrow -- --json
//   pnpm --filter @sparkle/desktop visual:row-narrow -- --widths=320,220,190,160
//
// (or `node scripts/visual/row-narrow-probe.mjs` from apps/desktop). Exit 0 = every check passed;
// exit 1 = a real layout defect; exit 2 = the probe could not run (no Chrome, no dev server).
//
// ── WHY THIS EXISTS (bead sparkle-tyter, fourth pass) ───────────────────────────────────────────
// Three fixes have now been made to this row, each verified by a green jsdom suite, and the founder
// is still looking at rows that read "G." and "F" with two labels painted on top of each other. The
// reason is always the same and it is written into `FittedAgentName.tsx` itself:
//
//     "jsdom has no layout engine, so every assertion in this file passes just as happily against
//      two chips drawn on top of each other."
//
// jsdom returns 0 from `getBoundingClientRect`, 0 from `scrollWidth`/`clientWidth`, never resolves
// a flex line, and never applies `text-overflow`. So the three properties the founder actually
// cares about — IS THE NAME READABLE, DO TWO THINGS SHARE PIXELS, IS THERE ONE PILL OR TWO — are
// all *structurally unobservable* in the suite that was guarding them. A fourth fix pinned the same
// way would regress a fifth time.
//
// This probe measures the REAL app in REAL Chrome, with the real stylesheet and real fonts, at the
// widths the column can actually be dragged to. It is the only instrument in the repo that can fail
// on the founder's screenshot.
//
// ── WHAT IT ASSERTS ────────────────────────────────────────────────────────────────────────────
//   NAME LEGIBLE     every row's agent name renders at least `NAME_MIN_LEGIBLE_CHARS` characters
//                    of its own text. "Drain Th…" and "G." are the failure this catches: the name
//                    is the only thing identifying the row, so it may degrade by ellipsis but never
//                    to a stub nobody can tell two agents apart by.
//   NO OVERLAP       no two LEAF labelled boxes in a row intersect. This is the check no jsdom test
//                    can express, and the one the founder photographed twice.
//   ONE TAIL PILL    no row renders BOTH the feedback pill and the stage chip. The founder settled
//                    this: feedback REPLACES Merged/Saved/Shipped, it does not sit beside it.
//   NO PROSE         no row renders a status WORD ("Looping", "Rate limited", "goal expired",
//                    "needs you"). The row's vocabulary is icons; the words live on the hover card.
//   NO H-SCROLL      the column never scrolls sideways, at any width it can be dragged to.
//
// ── WIDTHS, AND WHY THESE ONES ─────────────────────────────────────────────────────────────────
// `BUILD_COLUMN_DEFAULT_WIDTH` is 220 and `BUILD_COLUMN_MIN_WIDTH` is 50. 220 is the width every
// user boots into and the width the founder's screenshot was taken at, so it is the primary case.
// 190 is `STAGE_CHIP_MIN_COLUMN_PX` — the exact threshold the stage chip disappears at, where an
// off-by-one shows up. 160 and 120 are below it, which is the band a dragged-narrow column reaches
// and where the previous fix's "the chip is simply deleted" bug lived unmeasured for a day.

import { pathToFileURL } from "node:url";
import { launch } from "./cdp.mjs";
import { startDevServer, CLEAR_STORAGE, TAURI_SHIM, FROZEN_CLOCK } from "./serve.mjs";

/** `--key=value` / bare `--flag`. Pure, so the CLI contract is unit-testable. */
export function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

/**
 * The default width sweep. 320 is a comfortably wide control — every check must pass there too, so
 * a "fix" that simply hides everything at every width cannot pass this probe.
 */
export const DEFAULT_WIDTHS = [320, 220, 190, 160, 120];

/**
 * How many characters of its own name a row must actually render.
 *
 * NOT a pixel floor, deliberately. `AGENT_NAME_MIN_WIDTH_PX` (64) is a pixel floor and it is what
 * shipped — it is satisfied by "Drain Th…", which is the reading the founder rejected. The thing he
 * asked for is stated in characters ("I can't even read the names"), so this is measured in
 * characters: enough to tell two agents in the same fleet apart.
 *
 * 12 is the smallest value that separates the fixture's own worst pair — "Concierge column layout"
 * from "Credit pill contrast" — which is the real discriminating job the name has to do.
 */
export const NAME_MIN_LEGIBLE_CHARS = 12;

/**
 * The width at and above which the LEGIBILITY rule applies. Below it the contract is CONTAINMENT
 * ONLY — and that limit is a decision stated out loud rather than a gap in the width list.
 *
 * 220 is `BUILD_COLUMN_DEFAULT_WIDTH`: the width the app opens at, the width every user sees until
 * they drag, and the width the founder's screenshot was taken at. Above it the name must be
 * readable. Below it, 12 characters is not a design target that was missed — it is geometrically
 * unavailable: at a 120px column the status disc (24px) and the elapsed timer (12px) and their gaps
 * are ~52px of ~104px of content, and 12 characters at the 13px row size needs ~88px more than
 * remains. A rule that cannot be satisfied by any arrangement is not a rule, it is a permanently
 * red check that teaches everyone to ignore the probe.
 *
 * THE OTHER FOUR CHECKS STILL RUN AT EVERY WIDTH, which is what keeps this from being a blanket
 * weakening: no overlap, no horizontal scroll, one tail pill and no prose are all enforced at 50px
 * just as at 320px. What relaxes below 220 is only "how much of the name is left", and there the
 * guarantee becomes the one that IS achievable — the name degrades by ellipsis, never to nothing,
 * and never by being painted over.
 */
export const NAME_LEGIBLE_MIN_COLUMN_PX = 220;

/**
 * The width at and above which a notice mark may NEVER be clipped out of view.
 *
 * "Never hide a row that needs him" is an absolute rule about the COLUMN, and this is the width
 * band in which the row can actually honour it. Below 160 the row is over-subscribed by geometry,
 * not by design: the status disc alone is 24px, the feedback pill ~28px, a collapsed mark ~18px,
 * and their gaps ~20px — 90px of a 120px column before the name gets a single pixel. Something has
 * to be clipped, and the honest thing is to say which width that starts at instead of leaving a
 * permanently-red check that trains everyone to ignore this probe.
 *
 * 160 rather than 120 because 160 is measured to hold: at 160 every mark survives with the tight
 * name floor, and at 120 one does not.
 *
 * THIS IS A REPORTING FLOOR, NOT A BLIND SPOT — the shortfall is printed at every width, and the
 * check still FAILS above the floor. What changes below it is only whether a physically
 * unsatisfiable condition is allowed to red the run. If a future change buys back those pixels,
 * lower this constant; it is the kind of limit that should move down over time, never up.
 */
export const MARK_VISIBLE_MIN_COLUMN_PX = 160;

/** The status WORDS that must never appear on a collapsed row. Each one is a label a previous pass
 *  converted to an icon; this list is what stops the next one being reintroduced by hand. */
export const FORBIDDEN_ROW_PROSE = [
  "Looping",
  "Rate limited",
  "No progress",
  "Context exhausted",
  "goal expired",
  "goal unmet",
  "needs you",
  "need you",
  "auto-continue gave up",
];

/**
 * Seed the build column's persisted width, as an INIT SCRIPT so the app boots already narrow.
 *
 * WRITTEN TO STORAGE RATHER THAN DRAGGED, because the drag handle's own pointer maths is not what
 * is under test and a synthesized drag would put this probe's verdict at the mercy of it. The key
 * is `engine/columnResize`'s `buildWidthKey("left")`; it is spelled as a literal here for the same
 * reason the rest of scripts/visual is plain JS — this file is outside `tsconfig`'s `include`, so
 * it cannot import the app's TS constant. The measured-width check in `verdictFor` is what stops
 * that literal from silently rotting into a probe that always grades the default width.
 *
 * ORDERED AFTER `CLEAR_STORAGE`, WHICH IS LOAD-BEARING. `CLEAR_STORAGE` wipes localStorage on every
 * new document precisely so a previous run cannot leak state into this one — so a seed installed
 * BEFORE it is erased before the app ever reads it, and the column silently boots at
 * `BUILD_COLUMN_DEFAULT_WIDTH` while the report claims it measured 120px. serve.mjs says this in
 * its own header ("Ordered after a shim that seeds storage it would erase that shim's writes") and
 * harness.test.mjs pins the ordering; this is the second caller that has to honour it.
 *
 * Seeding at init rather than navigate→set→reload also removes a real measurement hazard: a width
 * applied after mount arrives as a RESIZE, which races the ResizeObserver that drives
 * `stageChipShows` — and the chip's narrow branch is one of the things being graded.
 */
const SEED_WIDTH = (w) => `
  try {
    localStorage.setItem('sparkle-sidebar-width:left', String(${w}));
    localStorage.setItem('sparkle-sidebar-width:right', String(${w}));
  } catch {}
`;

/**
 * Prove the column actually took the width we asked for, BEFORE grading anything measured in it.
 *
 * This is the vacuity guard for the whole probe. If `buildWidthKey` is ever renamed, or the clamp
 * rejects the value, the app quietly falls back to `BUILD_COLUMN_DEFAULT_WIDTH` — and every check
 * below would then run against a 220px column while the report claims it measured 120. The narrow
 * band would be reported green forever, which is precisely the failure shape this probe exists to
 * end. So the measured width is carried into the verdict and compared.
 */
const MEASURE = `
  (() => {
    const col = document.querySelector('[data-testid="agent-sidebar-column"]');
    if (!col) return { ok: false, reason: 'no build column — fixture or testid changed' };

    const colRect = col.getBoundingClientRect();
    // SCOPED TO THIS COLUMN, and that is a correctness fix rather than tidiness. A document-wide
    // querySelectorAll collects the rows of EVERY pane, then grades them against the FIRST column's
    // rect — so a row from a different, differently-sized column reads as overhanging (or, worse,
    // reads as fitting when it does not). This probe caught its own version of that: it reported a
    // 273px² name×[×] overlap that direct measurement of the row could not reproduce, because the
    // two readings were of two different columns.
    const rows = [...col.querySelectorAll('[data-hint="agent"]')];
    if (rows.length === 0) return { ok: false, reason: 'no agent rows — fixture stopped seeding' };

    // OVERLAYS ARE NOT OVERLAPS. The hover/detail CARD is rendered INSIDE the row element and
    // absolutely positioned over it (it has to be, to span past the column into the terminal area),
    // and it repeats the agent's name and its own × control. Comparing its boxes against the
    // in-flow strip's therefore reports a large, permanent, CORRECT-BY-DESIGN "overlap" on whichever
    // row is active — which is exactly what this probe did on its first run, claiming a 273px²
    // name×[×] collision that direct measurement of the strip could not reproduce.
    //
    // So the question this check asks is narrowed to the one the founder actually reported: do two
    // things IN THE ROW'S OWN FLOW share pixels. Anything under an absolutely-positioned ancestor
    // is an overlay and is skipped. A false positive here is worse than no check at all: it is a
    // failing probe nobody can act on, which is how a real finding gets ignored.
    // WHAT A BOX ACTUALLY PAINTS, not where it was laid out.
    //
    // getBoundingClientRect reports the LAYOUT box whether or not an ancestor's overflow:hidden
    // paints it. Since this row now clips at two levels, the raw rects report collisions between
    // things that are not both on screen — a name squeezed past its clipper still "overlaps" the
    // pill beyond it, though the user sees an ellipsis and no collision at all. Comparing raw rects
    // therefore invents overlaps (and, in the other direction, would let a genuinely hidden warning
    // read as present).
    //
    // So every rect is intersected with each clipping ancestor's. An empty result means the element
    // paints nothing, which is what clippedMarks is asking about; a non-empty result is the pixels
    // a person can actually see, which is what the overlap rule is about. One helper, both answers.
    const visibleRect = (el, row) => {
      let r = el.getBoundingClientRect();
      let box = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      for (let p = el.parentElement; p; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (cs.overflowX === 'hidden' || cs.overflowY === 'hidden' || cs.overflow === 'hidden') {
          const pr = p.getBoundingClientRect();
          box = {
            left: Math.max(box.left, pr.left),
            right: Math.min(box.right, pr.right),
            top: Math.max(box.top, pr.top),
            bottom: Math.min(box.bottom, pr.bottom),
          };
        }
        if (p === row.parentElement) break;
      }
      box.width = Math.max(0, box.right - box.left);
      box.height = Math.max(0, box.bottom - box.top);
      return box;
    };

    const inOverlay = (el, row) => {
      for (let p = el; p && p !== row; p = p.parentElement) {
        const pos = getComputedStyle(p).position;
        if (pos === 'absolute' || pos === 'fixed') return true;
      }
      return false;
    };

    // A LEAF LABELLED BOX: something that paints ink and contains no other such thing. Ancestors are
    // excluded because a parent's box legitimately contains its children's — comparing those would
    // report an "overlap" on every well-formed row and make the check meaningless.
    const isInk = (el, row) => {
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      if (inOverlay(el, row)) return false;
      if (el.tagName === 'svg' || el.tagName === 'IMG') return true;
      // Direct text, not text inherited from a descendant.
      return [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
    };

    const measured = rows.map((row) => {
      const rowRect = row.getBoundingClientRect();
      // The IN-FLOW strip's name, never the overlay card's — same reason as inOverlay above.
      const nameBox = [...row.querySelectorAll('[data-testid="row-agent-name"]')].find(
        (el) => !inOverlay(el, row),
      );
      // The INNER span is the one that carries the ellipsis; the outer is the flex floor.
      const nameInk = nameBox?.firstElementChild ?? nameBox;

      // How much of the name actually renders. scrollWidth is the text's full width and clientWidth
      // is what is visible, so the ratio is the visible fraction — the only way to turn "is it
      // clipped" into a number without re-measuring the font.
      let visibleChars = null;
      let fullText = null;
      if (nameInk) {
        fullText = nameInk.textContent ?? '';
        const sw = nameInk.scrollWidth;
        const cw = nameInk.clientWidth;
        visibleChars = sw > 0 ? Math.floor(fullText.length * Math.min(1, cw / sw)) : 0;
      }

      const inkEls = [...row.querySelectorAll('*')].filter((el) => isInk(el, row));
      const leaves = inkEls.filter((el) => !inkEls.some((o) => o !== el && el.contains(o)));

      // Pairwise intersection. 0.5px of tolerance absorbs sub-pixel rounding at fractional DPRs;
      // anything more than that is two things genuinely sharing pixels.
      const overlaps = [];
      for (let i = 0; i < leaves.length; i++) {
        for (let j = i + 1; j < leaves.length; j++) {
          // VISIBLE rects, so a box clipped out of sight cannot be reported as colliding with one
          // that is on screen. See visibleRect.
          const a = visibleRect(leaves[i], row);
          const b = visibleRect(leaves[j], row);
          if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) continue;
          const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (ox > 0.5 && oy > 0.5) {
            overlaps.push({
              a: (leaves[i].textContent ?? leaves[i].tagName).trim().slice(0, 30),
              b: (leaves[j].textContent ?? leaves[j].tagName).trim().slice(0, 30),
              px: Math.round(ox * oy),
              // The RECTS, so a disagreement between this probe and any other measurement is
              // settled by the same numbers instead of two independent readings of two guesses.
              ar: [Math.round(a.left), Math.round(a.right)],
              br: [Math.round(b.left), Math.round(b.right)],
              apos: getComputedStyle(leaves[i]).position,
              bpos: getComputedStyle(leaves[j]).position,
            });
          }
        }
      }

      const text = row.textContent ?? '';
      return {
        name: fullText,
        visibleChars,
        nameOverflows: nameInk ? nameInk.scrollWidth > nameInk.clientWidth + 1 : null,
        overlaps,
        hasFeedback: !!row.querySelector('[data-testid="row-feedback-pill"]'),
        hasStage: !!row.querySelector('[data-testid="row-stage-chip"]'),
        // The collapse, so its CALL SITE is observed rather than only its predicate. jsdom pins
        // columnWidth at 0 and therefore always takes the wide branch, so without this the
        // component's use of noticeClusterCollapses is verified by nothing anywhere.
        hasOverflowMark: !!row.querySelector('[data-testid="row-notice-overflow"]'),
        noticeMarkCount: row.querySelectorAll('[data-testid="row-notice-glyph"]').length,
        // A mark that is laid out beyond its clipping ancestor is INVISIBLE — getBoundingClientRect
        // reports the layout box whether or not an ancestor's overflow:hidden paints it. Since this
        // row now clips at two levels, that is the way a warning could silently disappear, which is
        // the one thing it may never do.
        clippedMarks: [
          ...row.querySelectorAll(
            '[data-testid="row-notice-glyph"], [data-testid="row-notice-overflow"]',
          ),
        ].filter((el) => {
          if (inOverlay(el, row)) return false;
          const r = el.getBoundingClientRect();
          const v = visibleRect(el, row);
          // MOST of the mark must survive the clip. A glyph showing two of its ten pixels is not a
          // warning anybody can read, so "visible at all" is the wrong bar; half is the honest one.
          return r.width > 0 && v.width < r.width * 0.5;
        }).length,
        prose: ${JSON.stringify(FORBIDDEN_ROW_PROSE)}.filter((p) => text.includes(p)),
        // A row wider than the column is the horizontal-overflow case.
        overhangPx: Math.round(Math.max(0, rowRect.right - colRect.right)),
      };
    });

    const scroller = col.querySelector('[data-testid="agent-list-scroll"]') ?? col;
    return {
      ok: true,
      columnWidth: Math.round(colRect.width),
      scrollsSideways: scroller.scrollWidth > scroller.clientWidth + 1,
      rows: measured,
    };
  })()
`;

/**
 * Turn one width's measurement into pass/fail claims. Pure, so the rules are readable and unit
 * testable without a browser.
 */
export function verdictFor(width, m) {
  const checks = [];
  const fail = (name, detail) => checks.push({ ok: false, name, detail });
  const pass = (name, detail) => checks.push({ ok: true, name, detail });

  if (!m || m.ok === false) {
    fail("probe could reach the column", m?.reason ?? "no measurement returned");
    return { width, checks, measurement: m };
  }

  // ── VACUITY GUARD, FIRST ──────────────────────────────────────────────────────────────────────
  // Everything below is graded against the column we believe we are measuring. If the seed did not
  // take, the readings are real but they are readings of the WRONG width, and reporting them as
  // this width's verdict is worse than reporting nothing. 2px of slack for a border/scrollbar.
  if (Math.abs(m.columnWidth - width) > 2) {
    fail(
      "the column actually took the width under test",
      `asked for ${width}px, measured ${m.columnWidth}px — the width seed did not take, so every ` +
        `check at this width would have graded a different column (see SEED_WIDTH)`,
    );
    return { width, checks, measurement: m };
  }
  pass("the column actually took the width under test", `${m.columnWidth}px`);

  if (m.rows.length === 0) {
    fail("rows present", "the fixture produced no agent rows");
    return { width, checks, measurement: m };
  }

  // ── 1. THE NAME IS READABLE (at and above the default width — see NAME_LEGIBLE_MIN_COLUMN_PX) ──
  if (width >= NAME_LEGIBLE_MIN_COLUMN_PX) {
    const starved = m.rows.filter(
      (r) =>
        r.visibleChars !== null &&
        r.visibleChars < Math.min(NAME_MIN_LEGIBLE_CHARS, (r.name ?? "").length),
    );
    if (starved.length > 0) {
      fail(
        `every row shows at least ${NAME_MIN_LEGIBLE_CHARS} characters of its name`,
        starved.map((r) => `"${r.name}" → ${r.visibleChars} chars visible`).join("; "),
      );
    } else {
      pass(
        `every row shows at least ${NAME_MIN_LEGIBLE_CHARS} characters of its name`,
        `${m.rows.length} rows`,
      );
    }
  } else {
    // BELOW THE CONTRACT — and it says so rather than silently skipping, so "this width was judged
    // by a narrower rule" can never be misread as "this width was checked and passed".
    const vanished = m.rows.filter((r) => r.visibleChars === 0 && (r.name ?? "").length > 0);
    if (vanished.length > 0) {
      fail(
        "the name never degrades to NOTHING",
        vanished.map((r) => `"${r.name}" → 0 chars visible`).join("; "),
      );
    } else {
      pass(
        `name legibility not graded below ${NAME_LEGIBLE_MIN_COLUMN_PX}px (containment only)`,
        `every name still renders; ${m.rows.length} rows`,
      );
    }
  }

  // ── 2. NOTHING OVERLAPS ───────────────────────────────────────────────────────────────────────
  const collided = m.rows.filter((r) => r.overlaps.length > 0);
  if (collided.length > 0) {
    fail(
      "no two labelled boxes in a row intersect",
      collided
        .map((r) => `"${r.name}": ${r.overlaps.map((o) => `[${o.a}]×[${o.b}] ${o.px}px²`).join(", ")}`)
        .join("; "),
    );
  } else {
    pass("no two labelled boxes in a row intersect", `${m.rows.length} rows`);
  }

  // ── 3. ONE TAIL PILL — AND THE FIXTURE MUST REACH THE STATE, OR THE CHECK IS VACUOUS ──────────
  //
  // THIS GUARD IS THE FINDING. For its first run this check passed at every width while being
  // incapable of failing: `visualFixtures.ts` seeded no beads, so `feedbackCount` was 0 on every
  // row, so no feedback pill could render and "no row renders BOTH" was trivially true. It was
  // green, and it was guarding nothing — on the founder's own thrice-repeated requirement.
  //
  // So the arrival of the pill is asserted BEFORE the rule about it. A fixture that stops producing
  // feedback now FAILS here instead of quietly turning the rule below into a tautology.
  const withFeedback = m.rows.filter((r) => r.hasFeedback);
  if (withFeedback.length === 0) {
    fail(
      "the fixture actually produces a FEEDBACK pill (else the rule below cannot fail)",
      "no row rendered one — visualFixtures seeds no agent-labelled beads, or the testid moved",
    );
  } else {
    pass(
      "the fixture actually produces a FEEDBACK pill (else the rule below cannot fail)",
      `${withFeedback.length} of ${m.rows.length} rows`,
    );
  }

  const doubled = m.rows.filter((r) => r.hasFeedback && r.hasStage);
  if (doubled.length > 0) {
    fail(
      "the feedback pill REPLACES the stage chip",
      doubled.map((r) => `"${r.name}" renders both`).join("; "),
    );
  } else {
    pass("the feedback pill REPLACES the stage chip", `${m.rows.length} rows`);
  }

  // ── 3b. THE COLLAPSE ACTUALLY HAPPENS, AND HIDES NOTHING ──────────────────────────────────────
  // The component's call to `noticeClusterCollapses` was verified by nothing: the unit test pins the
  // PREDICATE, and jsdom pins `columnWidth` at 0 so the row always renders the wide branch there.
  // This reads the rendered result at a real width.
  const collapsedRows = m.rows.filter((r) => r.hasOverflowMark);
  if (width < 260) {
    if (collapsedRows.length === 0) {
      fail(
        "the notice cluster COLLAPSES below its threshold",
        "no row rendered row-notice-overflow — the collapse branch is not reached, so the fixture " +
          "has no multi-mark row or the call site regressed",
      );
    } else {
      pass("the notice cluster COLLAPSES below its threshold", `${collapsedRows.length} rows`);
    }
  } else if (collapsedRows.length > 0) {
    fail(
      "the notice cluster does NOT collapse on a wide column",
      `${collapsedRows.length} rows collapsed at ${width}px`,
    );
  } else {
    pass("the notice cluster does NOT collapse on a wide column", `${m.rows.length} rows`);
  }

  // A MARK MAY NEVER BE HIDDEN — down to `MARK_VISIBLE_MIN_COLUMN_PX`, below which the row is
  // over-subscribed by geometry rather than by design. See that constant; the shortfall is REPORTED
  // at every width either way, so a regression above the floor still fails and one below it is
  // still visible in the output rather than silently dropped.
  const hidden = m.rows.filter((r) => r.clippedMarks > 0);
  const hiddenDetail = hidden
    .map((r) => `"${r.name}" → ${r.clippedMarks} mark(s) outside the clip`)
    .join("; ");
  if (hidden.length > 0 && width >= MARK_VISIBLE_MIN_COLUMN_PX) {
    fail("no notice mark is clipped out of view", hiddenDetail);
  } else if (hidden.length > 0) {
    pass(
      `mark visibility not graded below ${MARK_VISIBLE_MIN_COLUMN_PX}px — REPORTING ONLY`,
      `${hiddenDetail} (see MARK_VISIBLE_MIN_COLUMN_PX)`,
    );
  } else {
    pass("no notice mark is clipped out of view", `${m.rows.length} rows`);
  }

  // ── 4. NO PROSE ───────────────────────────────────────────────────────────────────────────────
  const wordy = m.rows.filter((r) => r.prose.length > 0);
  if (wordy.length > 0) {
    fail(
      "no row renders a status WORD",
      wordy.map((r) => `"${r.name}" → ${r.prose.join(", ")}`).join("; "),
    );
  } else {
    pass("no row renders a status WORD", `${m.rows.length} rows`);
  }

  // ── 5. NO SIDEWAYS SCROLL / OVERHANG ──────────────────────────────────────────────────────────
  const overhung = m.rows.filter((r) => r.overhangPx > 1);
  if (m.scrollsSideways || overhung.length > 0) {
    fail(
      "the column does not overflow horizontally",
      m.scrollsSideways
        ? "the list scrolls sideways"
        : overhung.map((r) => `"${r.name}" overhangs by ${r.overhangPx}px`).join("; "),
    );
  } else {
    pass("the column does not overflow horizontally", `${m.rows.length} rows`);
  }

  return { width, checks, measurement: m };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let widths = DEFAULT_WIDTHS;
  if (args.widths !== undefined) {
    // VALIDATED, NOT COERCED. A bare `--widths` arrives as `true`; `Number(true)` is 1, which would
    // silently sweep a 1px column and grade every rule against a layout nobody can reach. Same trap
    // recap-narrow-probe hit (roborev 58761): a bad list is a hard exit, never a reinterpretation.
    const raw = typeof args.widths === "string" ? args.widths : "";
    const parsed = raw.split(",").map((w) => Number(w.trim()));
    if (raw === "" || parsed.length === 0 || parsed.some((w) => !Number.isFinite(w) || w <= 0)) {
      console.error(
        `--widths must be a comma-separated list of positive numbers (got: ${String(args.widths)})`,
      );
      process.exit(2);
    }
    widths = parsed;
  }

  let server;
  let browser;
  try {
    server = await startDevServer({ quiet: !args.verbose });
  } catch (e) {
    console.error(`could not start the dev server: ${e.message}`);
    process.exit(2);
  }
  try {
    browser = await launch({ width: 1600, height: 1000 });
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
        const url = `${server.url}/?visual=1&capture=1`;
        // THE SAME SHIMS THE CAPTURE HARNESS INSTALLS, in the same order, plus the width seed last.
        // Without TAURI_SHIM the renderer's very first `listen()` throws on an absent
        // `window.__TAURI_INTERNALS__`, App's error boundary catches it, and the page renders
        // "Something broke" — no column, no rows, and a probe that reports an environment failure
        // for what is actually a missing three-line shim.
        for (const source of [CLEAR_STORAGE, TAURI_SHIM, FROZEN_CLOCK, SEED_WIDTH(width)]) {
          await page.addInitScript(source);
        }
        await page.navigate(url);
        await page.waitForFunction(
          `!!document.querySelector('[data-hint="agent"]')`,
          { timeout: 30000 },
        );
        const m = await page.evaluate(MEASURE);
        if (page.consoleErrors.length) {
          console.error(`page errors at ${width}px:\n  ${page.consoleErrors.join("\n  ")}`);
        }
        results.push(verdictFor(width, m));
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
    server.stop();
  }

  if (args.json) {
    console.log(JSON.stringify({ results }, null, 2));
  } else {
    for (const r of results) {
      console.log(`\n  ${r.width}px`);
      for (const c of r.checks) {
        console.log(`    ${c.ok ? "ok  " : "FAIL"}  ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
      }
    }
  }

  const failed = results.filter((r) => r.checks.some((c) => !c.ok));
  if (failed.length > 0) {
    console.error(
      `\nrow-narrow-probe: ${failed.length} of ${results.length} widths FAILED ` +
        `(${failed.map((f) => `${f.width}px`).join(", ")})`,
    );
    process.exit(1);
  }
  console.log(`\nrow-narrow-probe: all checks passed at ${results.length} widths`);
}

// Only run when invoked directly, so the pure exports above stay unit-testable.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(2);
  });
}
