// The scrubber probe's VERDICT RULES, tested without a browser.
//
//   node --test apps/desktop/scripts/visual/thread-scrubber-probe.test.mjs
//
// The probe itself was proved non-vacuous by mutation — un-mounting the rail turns its three
// widths red with "the rail did not render at all". What that cannot prove is that each INDIVIDUAL
// rule fires on the defect it names, because reproducing five different layout faults in a real
// browser is far more expensive than calling a pure function. So `verdictFor` is split out and
// graded here, which is the same split `concierge-header-probe` uses.
// FROM VITEST, NOT `node:test` (roborev 66422). `apps/desktop/vite.config.ts` sets no
// `test.include`, so vitest's default glob covers `scripts/**/*.test.mjs` — a file registering only
// `node:test` cases contributes ZERO vitest tests and the desktop run fails it with "No test suite
// found in file". Confirmed: the full run reported `scripts/visual/thread-scrubber-probe.test.mjs
// (0 test)`. The sibling `harness.test.mjs` imports from vitest for exactly this reason.
import { describe, it, expect } from "vitest";
import { verdictFor, channelDelta, parseRgb, MIN_DOT_TRACK_DELTA } from "./thread-scrubber-probe.mjs";


/** Thin adapters so the assertions below read the same as before the runner swap. */
const expect_equal = (a, b, m) => expect(a, m).toBe(b);
const expect_deepEqual = (a, b, m) => expect(a, m).toEqual(b);
const expect_match = (a, re, m) => expect(a, m).toMatch(re);
const expect_ok = (a, m) => expect(a, m).toBeTruthy();

/** A measurement of a HEALTHY rail — the baseline every case below perturbs by exactly one fact. */
function healthy(over = {}) {
  return {
    found: true,
    hasTrack: true,
    hasHandle: true,
    dotCount: 3,
    railBox: { x: 500, y: 100, w: 16, h: 800, right: 516, bottom: 900 },
    trackBox: { x: 500, y: 130, w: 16, h: 770, right: 516, bottom: 900 },
    colBox: { x: 0, y: 0, w: 520, right: 520 },
    colScrollW: 520,
    colClientW: 520,
    scope: {
      box: { x: 500, y: 100, w: 16, h: 14, right: 516, bottom: 114 },
      scrollW: 16, clientW: 16, value: "1d", aria: "Scrubber time scope", options: 13,
    },
    dotCentres: [
      { cx: 508, cy: 300, w: 5, colour: "rgb(120, 170, 255)" },
      { cx: 508, cy: 500, w: 5, colour: "rgb(120, 170, 255)" },
      { cx: 508, cy: 700, w: 8, colour: "rgb(120, 170, 255)" },
    ],
    trackColour: "rgb(40, 55, 80)",
    ...over,
  };
}

const fails = (m) => verdictFor(m, 520).fails.join(" | ");

it("a healthy rail passes", () => {
  const v = verdictFor(healthy(), 520);
  expect_equal(v.ok, true, v.fails.join("; "));
});

it("an absent rail is the founder's own regression guard", () => {
  const v = verdictFor({ found: false }, 520);
  expect_equal(v.ok, false);
  expect_match(v.fails[0], /did not render at all/);
});

it("zero dots fails — a dot per prompt IS the feature", () => {
  expect_match(fails(healthy({ dotCount: 0, dotCentres: [] })), /NO dots/);
});

it("a dot painted outside the track fails even though the DOM reports it", () => {
  const m = healthy();
  m.dotCentres[1].cx = 620; // past trackBox.right + 8
  expect_match(fails(m), /painted outside the track/);
});

it("a scope control clipped by its own metrics fails", () => {
  const m = healthy();
  m.scope.scrollW = 34;
  expect_match(fails(m), /clipped by 18px of its own width/);
});

it("a scope control painted past the column edge fails INDEPENDENTLY of its own metrics", () => {
  const m = healthy();
  // Intact by scrollWidth/clientWidth, and still outside the pane — the two failures are separate,
  // which is why both are checked.
  m.scope.box.right = 540;
  const f = fails(m);
  expect_match(f, /20px past the column's right edge/);
  expect(f, "a control outside the column must not ALSO be reported as self-clipped").not.toMatch(/clipped by/);
});

it("a column that scrolls sideways fails", () => {
  expect_match(fails(healthy({ colScrollW: 560 })), /scrolls sideways by 40px/);
});

it("a dot the same colour as the track fails, however many dots exist", () => {
  const m = healthy();
  m.dotCentres[0].colour = m.trackColour;
  const f = fails(m);
  expect_match(f, /differs from the track by only 0/);
  expect_match(f, new RegExp(`floor ${MIN_DOT_TRACK_DELTA}`));
});

it("an unreadable colour is a NOTE, never a silent pass", () => {
  const m = healthy();
  m.dotCentres[0].colour = "oklch(0.7 0.1 250)";
  const v = verdictFor(m, 520);
  expect_equal(v.ok, true, "an unreadable colour is not itself a defect");
  expect_ok(
    v.notes.some((n) => /contrast was not graded/.test(n)),
    "…but it must SAY the check did not run",
  );
});

it("a missing track or handle fails", () => {
  expect_match(fails(healthy({ hasTrack: false, trackBox: null })), /no track/);
  expect_match(fails(healthy({ hasHandle: false })), /no draggable handle/);
});

it("channelDelta and parseRgb", () => {
  expect_deepEqual(parseRgb("rgb(1, 2, 3)"), [1, 2, 3]);
  expect_deepEqual(parseRgb("rgba(1,2,3,0.5)"), [1, 2, 3]);
  expect_equal(parseRgb("nonsense"), null);
  expect_equal(channelDelta("rgb(10,10,10)", "rgb(10,10,40)"), 30);
  expect_equal(channelDelta("rgb(10,10,10)", "nonsense"), null);
});

// ── THE TWO RULES ADDED AFTER THE FIRST SWEEP TURNED OUT TO BE FAKE (roborev 66465) ─────────────
// Both were shipped unasserted, which is the same fault they exist to catch: delete the width-seed
// check and the suite stayed green, so the probe's own headline guarantee — "a probe that cannot
// tell it swept nothing is worse than one that does not sweep" — was itself unguarded.

it("fails when the column it MEASURED is not the width it asked for", () => {
  // The exact shape of the original defect: the seed went to the wrong storage key, so every row
  // rendered the default width while reporting the width it requested.
  const m = healthy({ colBox: { x: 0, y: 0, w: 360, right: 360 } });
  expect_match(verdictFor(m, 260).fails.join(" | "), /asked for a 260px column and measured 360px/);
});

it("…and passes when the column matches, so it is not a blanket refusal", () => {
  expect_equal(verdictFor(healthy(), 520).ok, true);
});

it("exempts the column's PRE-EXISTING sideways overflow, and says it did", () => {
  // 260px inherits 35px of overflow with no rail mounted; that must not be blamed on the rail.
  const m = healthy({
    colBox: { x: 0, y: 0, w: 260, right: 260 },
    railBox: { x: 240, y: 100, w: 16, h: 800, right: 256, bottom: 900 },
    trackBox: { x: 240, y: 130, w: 16, h: 770, right: 256, bottom: 900 },
    scope: { box: { x: 240, y: 100, w: 16, h: 14, right: 256, bottom: 114 },
      scrollW: 16, clientW: 16, value: "1d", aria: "Scrubber time scope", options: 13 },
    dotCentres: [{ cx: 248, cy: 300, w: 5, colour: "rgb(120, 170, 255)" }],
    dotCount: 1,
    colScrollW: 295,
    colClientW: 260,
  });
  const v = verdictFor(m, 260);
  expect_equal(v.ok, true, v.fails.join("; "));
  expect_ok(v.notes.some((n) => /all of it pre-existing/.test(n)), "must SAY the overflow was inherited");
});

it("still fails on overflow BEYOND the inherited baseline", () => {
  const m = healthy({
    colBox: { x: 0, y: 0, w: 260, right: 260 },
    railBox: { x: 240, y: 100, w: 16, h: 800, right: 256, bottom: 900 },
    trackBox: { x: 240, y: 130, w: 16, h: 770, right: 256, bottom: 900 },
    scope: { box: { x: 240, y: 100, w: 16, h: 14, right: 256, bottom: 114 },
      scrollW: 16, clientW: 16, value: "1d", aria: "Scrubber time scope", options: 13 },
    dotCentres: [{ cx: 248, cy: 300, w: 5, colour: "rgb(120, 170, 255)" }],
    dotCount: 1,
    colScrollW: 320,
    colClientW: 260,
  });
  expect_match(verdictFor(m, 260).fails.join(" | "), /25px more than the 35px it does without the rail/);
});

it("reports the column even when the rail is ABSENT, so an overflow can be attributed", () => {
  // The early return used to carry nothing, which made "is this overflow the rail's fault?"
  // unanswerable — and that question is the first one anyone asks.
  const v = verdictFor({ found: false, colBox: { x: 0, y: 0, w: 260, right: 260 }, colScrollW: 295, colClientW: 260 }, 260);
  expect_equal(v.ok, false);
  expect_ok(v.notes.some((n) => /rail absent/.test(n)), "must report the column's own overflow");
});
