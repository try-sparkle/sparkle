#!/usr/bin/env node
// tab-click-probe — price ONE click on a project tab, in a real browser, in React commits.
//
//   pnpm --filter @sparkle/desktop visual:tab-click
//   pnpm --filter @sparkle/desktop visual:tab-click -- --json
//   pnpm --filter @sparkle/desktop visual:tab-click -- --widths=760,520
//
// ── WHY THIS EXISTS (bead sparkle-73imb) ────────────────────────────────────────────────────────
// The founder: *"when I click on a project tab, it just blinks a lot of times and oftentimes does
// not become the active tab."* Two claims, and both are measurable rather than matters of taste:
// blinking is COMMITS, and a dropped click is a SELECTION THAT DID NOT STICK.
//
// The jsdom suite (`src/components/ProjectTabs.clickCost.test.tsx`) measures both against the whole
// `Workspace`, which is the only place the cross-component overwrite path is visible. But it
// systematically UNDERCOUNTS the strip's own commits, in the three places most likely to matter:
//
//   * every rect is zero, so the hover expansion's measured width never changes;
//   * `scrollWidth` is zero, so the strip's layout-effect metrics never change and the extra render
//     they would cause never happens;
//   * `scrollIntoView` does not exist, so the scroll a selection triggers — which can move a tab
//     out from under the pointer and restart the hover cycle — cannot happen at all.
//
// So this probe is not a nicer version of that test; it answers the half that one cannot. Exit 0 =
// measured and within bounds, 1 = a real regression, 2 = the probe could not run (no Chrome, no
// dev server).
//
// ── WHAT IT REPORTS ─────────────────────────────────────────────────────────────────────────────
//   HOVER      commits caused by parking the pointer on a tab and leaving it still. A pointer that
//              does not move must stop producing commits; the strip's own source documents a
//              measured enter/leave oscillation ("five enter/leave pairs in a second") that this
//              is the detector for.
//   CLICK      commits caused by pressing and releasing on a tab, split into those inside the first
//              frame and the TAIL that keeps arriving afterwards. The tail is the blink.
//   LANDED     whether the clicked tab is the selected one when everything settles.
//   REAL INPUT press and release are CDP `Input.dispatchMouseEvent`, so this is the path a hand on
//              the trackpad takes — not a synthetic React event that skips hit-testing entirely.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./cdp.mjs";
import { startDevServer } from "./serve.mjs";

/** `--key=value` / bare `--flag`. Pure, so the CLI contract is unit-testable. */
export function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

export const DEFAULT_WIDTHS = [760, 520];

/** Parse `--widths`, or `null` when the argument is unusable. */
export function parseWidths(raw) {
  if (raw === undefined) return DEFAULT_WIDTHS;
  if (typeof raw !== "string") return null;
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n) || n <= 0)) return null;
  return nums;
}

/**
 * How many commits are ACCEPTABLE for one click.
 *
 * This started as 2, reasoned out a priori. Then it was measured, and the honest number is 4 — so
 * this is the measurement, with each commit named, rather than a target the code was tuned to hit.
 * Attributed in Chrome by dispatching the press and the release 250ms apart and counting between
 * them (bead sparkle-73imb):
 *
 *   1. the selection itself — a different tab becomes active;
 *   2. the strip re-deriving from that new active tab;
 *   3. a `nested-update`: the layout effect re-measuring chrome, because the active tab's chrome
 *      and its min-width floor are not the inactive one's;
 *   4. at narrow widths only, ~120ms later, the hover settle re-freezing the still-hovered tab at
 *      the width the new floor gave it. Correct, and the reason the tail is not required to be 0.
 *
 * A PRESS on its own is 0 commits, which is the part worth protecting: it used to be 1, because
 * pressing focuses the tab and the focus path re-settled an expansion the pointer had already
 * opened.
 *
 * What this bound is really for is an UNBOUNDED count — the oscillation of bead sparkle-73imb,
 * where a collapsed tab handed the pointer back and forth with the strip and commits never stopped.
 * Before the fix this probe measured a still pointer producing late commits and the click failing
 * to land at all.
 */
export const CLICK_COMMIT_BUDGET = 4;
/**
 * Commits still arriving more than 50ms after the click's FIRST COMMIT — the visible flicker, as
 * opposed to the work of the frame the click is in. One is allowed: the re-freeze named above.
 *
 * "After the first commit", not "after the click", and the distinction is load-bearing: this is
 * commit-to-commit SPACING and says nothing about how long the click took to respond at all. A
 * strip whose whole response arrived 500ms late but tightly clustered would read 0 here. That gap
 * is why `CLICK_RESPONSE_BUDGET_MS` exists (roborev 62826).
 */
export const CLICK_TAIL_BUDGET = 1;
/**
 * How long the click may take to produce its FIRST commit, measured in the page — the harness
 * stamps the input from a capture-phase listener, so the CDP round-trips are outside the number.
 * 100ms is the usual threshold for an interaction that should feel instant; MEASURED from the
 * press, this strip responds in 2.7ms at both widths, so the budget sits far above the observation
 * and bounds a genuine regression rather than tracking noise.
 */
export const CLICK_RESPONSE_BUDGET_MS = 100;
/**
 * The strip's own hover-settle delay, mirrored from `ProjectTabs.tsx`. An expansion cannot
 * legitimately arrive sooner, so it is a real FLOOR — and it is enforced as one below rather than
 * merely described, because a first commit arriving before it means the measurement's origin is
 * wrong, not that the strip is fast.
 *
 * The mirror is PINNED, not trusted: `harness.test.mjs` reads the component's own exported constant
 * and fails if the two drift, because a silent drift here would leave the probe failing a healthy
 * strip while its message still told the caller that 120ms of the budget was the settle delay
 * (roborev 62839).
 */
export const TAB_EXPAND_DELAY_MS = 120;
/** Slack under the settle floor, for timer and clock rounding — small enough that a wrong origin
 *  (which is off by a whole CDP round-trip or more) cannot hide inside it. */
export const SETTLE_SLACK_MS = 10;
/**
 * How long the hover may take to EXPAND THE TAB, from the FIRST `pointermove` since the reset — the
 * move whose enter transition arms the settle timer. The settle delay above is most of it by design, and is enforced as a floor; 300ms leaves
 * room for a slow frame on top of it without admitting a hover that visibly lags. Symmetric with the click's budget, and added for the same reason: with the tail measured
 * from the first commit, nothing otherwise bounds how long the gesture took to respond at all
 * (roborev 62833).
 */
export const HOVER_RESPONSE_BUDGET_MS = 300;
/** A still pointer must eventually stop committing entirely. */
export const HOVER_TAIL_BUDGET = 0;

/**
 * Move the real pointer.
 *
 * `button: "none"` is REQUIRED — CDP's `mouseMoved` needs an explicit button state and silently
 * produces nothing useful without it. The move is sent TWICE, a pixel apart, because the browser
 * derives `mouseover`/`mouseout` from a CHANGE of hit-tested element, so the first move of a
 * session can land without a transition to report.
 */
async function movePointer(page, x, y) {
  for (const dx of [0, 1]) {
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: x + dx,
      y,
      button: "none",
      buttons: 0,
    });
  }
}

/**
 * Where to aim to SELECT a tab: the centre of its label.
 *
 * Not the centre of the tab — that is where the ⚠ staleness badge and the × sit, and those are
 * buttons with their own jobs. A probe aiming at the tab's midpoint measures "clicking the badge
 * does not select the tab", which is correct behaviour, and would report a dropped click forever.
 */
async function tabCentre(page, id) {
  return page.evaluate(
    `(() => { const el = document.querySelector('[data-testid="tab-label-${id}"]')
        ?? document.querySelector('[data-testid="tab-${id}"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
  );
}

/** Park the pointer well clear of the strip so any expanded tab collapses. */
async function unhover(page) {
  await movePointer(page, 5, 700);
}

/** Press and release at a point — a real click, hit-tested by the browser. */
async function clickAt(page, x, y) {
  for (const type of ["mousePressed", "mouseReleased"]) {
    await page.send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: "left",
      buttons: type === "mousePressed" ? 1 : 0,
      clickCount: 1,
    });
  }
}


/**
 * THE VERDICT LOGIC, PURE AND EXPORTED — so it can be tested without Chrome.
 *
 * This branch spent six review rounds on this probe, and FOUR of the findings were defects in
 * exactly this grading: a release-origin latency that went negative and was waved through, a
 * last-move origin contaminated by a CDP round-trip, a negative folded into "over budget" so it
 * printed a nonsense string, and a floor graded against the wrong event. Every one was found by a
 * human reading the code; not one could have been caught by a test, because the grading lived
 * inline in `measureWidth`, which is unexported and needs a browser and a dev server to reach.
 *
 * That is this repo's own "assert the side effect" rule turned on the instrument: the probe is what
 * guards the strip, and nothing guarded the probe. Pulling the branches out here makes the next
 * regression cost a red test instead of a review round (roborev 62855).
 */
/**
 * EVERY input a grader reads, checked for being a number at all — before any of it is compared to a
 * budget or printed into a diagnostic. Including the ones read only for REPORTING: a mis-wired
 * stamp degrades the null-latency message to `__lastPressT=undefined`, which reads as "the harness
 * never stamped the press" and sends the reader into the harness when the fault is right here
 * (roborev 62896).
 *
 * The graders take an object, and an object parameter removes the check the language used to do:
 * as locals in `measureWidth` a typo was a `ReferenceError` at the first run; as keys, a renamed or
 * omitted one arrives as `undefined`. And `undefined > BUDGET` is `false` for EVERY budget here, so
 * a mis-wire does not fail — it grades a strip that blinked twenty times as a clean pass, and
 * prints `click cost undefined commits` in the one branch that would have caught it.
 *
 * Applied to ALL of them rather than to the two latencies, which is where this started: guarding
 * two of seven fields left the other five failing in exactly the direction the guard exists to
 * close (roborev 62873).
 *
 * `String(v)`, never `JSON.stringify(v)` — the latter renders `NaN` as the string `"null"`, which
 * is indistinguishable from a genuine `null` and names the wrong cause. They point at different
 * code: a `null` means the probe DECLINED to compute because a stamp was missing; a `NaN` means the
 * subtraction RAN, on something that was not a number.
 */
function wiringFailures(kind, { counts, latencies, stamps = {} }) {
  // A COUNT is never legitimately absent — `measureWidth` computes it from an array it always has.
  // A LATENCY legitimately can be: `null` is what the probe emits when it DECLINED to compute
  // because a stamp was missing, so `null` is a measurement outcome here, not a wiring fault.
  // THREE GROUPS, THREE RULES — and the third exists because adding reporting-only inputs outside
  // this guard is how the "two of seven" hole came back as "three of ten". A STAMP is like a
  // latency: legitimately `null` when the browser never recorded it, never legitimately absent.
  const bad = [
    ...Object.entries(counts).filter(([, v]) => !Number.isFinite(v)),
    ...Object.entries(latencies).filter(([, v]) => v !== null && !Number.isFinite(v)),
    ...Object.entries(stamps).filter(([, v]) => v !== null && !Number.isFinite(v)),
  ];
  if (!bad.length) return [];
  return [
    `the ${kind} grader was handed ${bad.length} non-numeric input(s) — ` +
      bad.map(([k, v]) => `${k}=${String(v)}`).join(", ") +
      ` — so its verdict would be a guess, and a missing measurement is not a pass`,
  ];
}

export function gradeClick({ commits, immediate, tail, responseMs, pressT, selected, target }) {
  const wiring = wiringFailures("click", {
    counts: { commits, immediate, tail },
    latencies: { responseMs },
    stamps: { pressT },
  });
  // ONLY a mis-wire returns early. Every comparison below would be meaningless against an
  // `undefined`, so a partial verdict there is how a mis-wire reads as a pass — but `null` is
  // different in kind, and folding the two together was a real regression: `responseMs` is `null`
  // exactly when the click produced NO COMMITS, which is one of the two states this probe exists
  // to report, and returning here suppressed the `did not land` verdict that names it. The reader
  // was told the grader's wiring was broken when the STRIP was broken (roborev 62885).
  if (wiring.length) return wiring;
  const failures = [];
  if (commits > CLICK_COMMIT_BUDGET) {
    failures.push(
      `click cost ${commits} commits (budget ${CLICK_COMMIT_BUDGET}): ` +
        `${immediate} immediate + ${tail} in the tail`,
    );
  }
  if (tail > CLICK_TAIL_BUDGET) {
    failures.push(
      `${tail} commits arrived MORE than 50ms after the click's FIRST commit ` +
        `(budget ${CLICK_TAIL_BUDGET}) — a tail is what "blinks a lot of times" looks like, as ` +
        `opposed to the work of one frame. This is commit-to-commit spacing; how long the click ` +
        `took to respond at all is the separate response-latency check`,
    );
  }
  if (responseMs === null) {
    // Pushed, NOT returned — the landing check below reads strings and stays meaningful without a
    // latency, and it is the one that names what the user actually experienced.
    // NAMES WHICH END WAS MISSING. `responseMs` is null for two different reasons — no commits at
    // all, or no press stamp — and they point at different code, so a message that prints only
    // "responseMs=null" makes the run's own output unable to answer the question it raises.
    failures.push(
      `could not measure the click's response latency (commits=${commits}, ` +
        `__lastPressT=${String(pressT)}) — a missing measurement is not a pass`,
    );
  } else if (responseMs < 0) {
    // ITS OWN CASE. Should be unreachable now the origin is the press, which precedes every event
    // of the gesture — but a negative is neither null nor over budget, so without this branch it
    // would be reported as a PASS, which is how the release-origin version of this check managed
    // to wave through the very regression it was added to watch.
    failures.push(
      `the first commit preceded the PRESS by ${(-responseMs).toFixed(1)}ms — that is not a ` +
        `latency, so the click's response time was not measured`,
    );
  } else if (responseMs > CLICK_RESPONSE_BUDGET_MS) {
    failures.push(
      `the click took ${responseMs.toFixed(1)}ms to produce its first commit ` +
        `(budget ${CLICK_RESPONSE_BUDGET_MS}ms)`,
    );
  }
  if (selected !== target) {
    failures.push(`the click did not land: selected is ${JSON.stringify(selected)}, wanted ${target}`);
  }
  return failures;
}

/** The hover half of the verdict. Same reasoning as `gradeClick`; see its doc. */
export function gradeHover({
  commits,
  hoverTail,
  hoverResponseMs,
  firstMoveT,
  expandedT,
  expandedId,
  target,
}) {
  const wiring = wiringFailures("hover", {
    counts: { commits, hoverTail },
    latencies: { hoverResponseMs },
    stamps: { firstMoveT, expandedT },
  });
  if (wiring.length) return wiring;
  const failures = [];
  if (hoverTail > HOVER_TAIL_BUDGET) {
    failures.push(
      `a STILL pointer produced ${hoverTail} commits more than 300ms after its first ` +
        `(budget ${HOVER_TAIL_BUDGET})`,
    );
  }
  if (expandedId !== target) {
    failures.push(
      `the hover never expanded ${target} (expanded=${JSON.stringify(expandedId)}) — so the ` +
        `${HOVER_TAIL_BUDGET}-late-commit budget above was satisfied by doing nothing`,
    );
  }
  if (hoverResponseMs === null) {
    // Same as the click half, and this is the case that matters most here: `hoverResponseMs` is
    // `null` precisely when nothing ever expanded — the state the `expandedId` guard above exists
    // to name. Returning on it would have hidden that verdict behind a wiring complaint.
    // Both ends named, for the same reason — and here the two causes are further apart than on the
    // click side: a missing `__firstMoveT` is a pointer that never moved, a missing `__expandedT`
    // is a strip that never expanded.
    failures.push(
      `could not measure the hover's expansion latency (commits=${commits}, ` +
        `__firstMoveT=${String(firstMoveT)}, __expandedT=${String(expandedT)}) — ` +
        `a missing measurement is not a pass`,
    );
  } else if (hoverResponseMs < TAB_EXPAND_DELAY_MS - SETTLE_SLACK_MS) {
    // ITS OWN CASE, never folded into "over budget" — a value under the strip's own settle delay
    // is not a fast hover, it is a broken origin, and reporting it as an over-budget hover prints
    // a nonsense string (a negative latency against a 300ms budget) and sends the reader after the
    // wrong thing.
    failures.push(
      `the hover EXPANDED ${hoverResponseMs.toFixed(1)}ms after the first move, ` +
        `which is under the strip's own ${TAB_EXPAND_DELAY_MS}ms settle delay — an expansion ` +
        `cannot legitimately arrive that early, so the ORIGIN of this measurement is wrong`,
    );
  } else if (hoverResponseMs > HOVER_RESPONSE_BUDGET_MS) {
    failures.push(
      `the hover took ${hoverResponseMs.toFixed(1)}ms to expand the tab ` +
        `(budget ${HOVER_RESPONSE_BUDGET_MS}ms, of which ${TAB_EXPAND_DELAY_MS}ms is the strip's ` +
        `own settle delay)`,
    );
  }
  return failures;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Measure one width.
 *
 * The settle waits are generous on purpose (well past the strip's own 120ms hover-settle delay):
 * the number that matters is how many commits arrive in TOTAL for one gesture, and a short wait
 * would flatter the code by cutting off the tail this exists to find.
 */
async function measureWidth(page, serverUrl, width) {
  await page.navigate(`${serverUrl}/scripts/visual/tab-click-harness.html?w=${width}`);
  try {
    await page.waitForFunction("window.__tabHarnessReady === true", { timeout: 30000 });
  } catch (e) {
    // A readiness timeout almost always means the harness THREW while mounting, and the bare
    // "waitForFunction timed out" reads like a slow machine instead. Name the real cause.
    const errs = page.consoleErrors.length
      ? `\npage errors:\n  ${page.consoleErrors.join("\n  ")}`
      : "\n(no page errors were reported — check the dev server compiled the harness)";
    throw new Error(`${e.message}${errs}`);
  }
  await unhover(page);
  await sleep(400);

  // ── HOVER: park the pointer and leave it still. ───────────────────────────────────────────────
  const target = "p3";
  const box = await tabCentre(page, target);
  if (!box) throw new Error(`no tab element for ${target} — the harness did not render it`);
  await page.evaluate("window.__resetCommits()");
  await movePointer(page, box.x, box.y);
  await sleep(600);
  const hoverAll = await page.evaluate("JSON.stringify(window.__commits)").then(JSON.parse);
  // Commits arriving MORE than 300ms after the hover's FIRST COMMIT — not after the pointer
  // stopped, which is what this said while computing the other thing. The origin is the first
  // commit for the same transport reason as the click below, so this number is commit-to-commit
  // SPACING: the strip talking to itself rather than responding to the gesture. How long the hover
  // took to respond at all is a different number, measured just below.
  const hoverStart = hoverAll.length ? hoverAll[0].t : 0;
  const hoverTail = hoverAll.filter((c) => c.t - hoverStart > 300).length;
  // FROM THE FIRST MOVE, not the last. `movePointer` sends two a pixel apart, but the strip arms
  // its settle timer on the enter transition the FIRST one causes and refuses to re-arm while a
  // settle is in flight — so measuring from the second subtracts the CDP round-trip between them,
  // which is the transport this design keeps out of every other number, and biases this one toward
  // passing (roborev 62839).
  const firstMoveT = await page.evaluate("window.__firstMoveT");
  // THE EXPANSION, not the first commit of any kind. The floor below says "an expansion cannot
  // legitimately arrive this early", and grading the first arbitrary commit would make that
  // sentence unsupported by what was measured: an unrelated early commit — a chrome re-measure,
  // badge churn, a hover affordance a future change renders before the settle fires — would be
  // reported to the reader as a wrong ORIGIN, which is the one thing it would not be. The harness
  // stamps this from the Profiler's commit-phase callback, when `data-expanded` first appears
  // (roborev 62846).
  const expandedT = await page.evaluate("window.__expandedT");
  const hoverResponseMs =
    typeof expandedT === "number" && typeof firstMoveT === "number" ? expandedT - firstMoveT : null;
  // DID THE HOVER DO ANYTHING? Without this the whole hover half is unfalsifiable: a tail budget of
  // zero is satisfied perfectly by a pointer that never expanded anything at all, so a strip whose
  // hover was entirely broken would report the cleanest possible number.
  const expandedId = await page.evaluate(
    `(document.querySelector('[data-expanded="true"]')?.getAttribute("data-testid") ?? "")
       .replace(/^tab-/, "")`,
  );

  // ── CLICK: press and release on the tab the pointer is already over. ──────────────────────────
  // Already hovering, exactly as a user is: you cannot click a tab without first being on it, so
  // measuring a click from a cold pointer would measure a gesture nobody performs.
  await page.evaluate("window.__resetCommits()");
  await clickAt(page, box.x, box.y);
  await sleep(700);
  const clickAll = await page.evaluate("JSON.stringify(window.__commits)").then(JSON.parse);
  const selected = await page.evaluate("window.__selected");

  // THE ORIGIN IS THE FIRST COMMIT, not a timestamp taken before the click was dispatched — the
  // same choice the hover half above makes, and for a sharper reason here. `clickAt` costs two
  // further CDP round-trips, and against a live dev server those are worth tens of milliseconds; a
  // `performance.now()` sampled before them precedes the actual press by an unbounded amount, so a
  // slow round-trip would push a first-frame commit past the 50ms line and report it as tail. With
  // a tail budget of 1 already spent by the legitimate re-freeze, that turns a healthy strip into a
  // FAIL and tells the caller it is a regression. Measuring commit-to-commit spacing removes the
  // transport from the measurement entirely (roborev 62821).
  // FROM THE PRESS, not the release. A click is one gesture with two events, and anything that
  // commits on the press lands BEFORE the release — so a release-origin latency would go negative
  // exactly when a press-time commit came back, and a negative number is neither null nor over
  // budget, so the check would have waved through the one regression it was added to watch. This
  // strip has had that regression: focus re-settling an expansion the pointer had already opened.
  const pressT = await page.evaluate("window.__lastPressT");
  const clickStart = clickAll.length ? clickAll[0].t : 0;
  const responseMs =
    clickAll.length && typeof pressT === "number" ? clickStart - pressT : null;
  const immediate = clickAll.filter((c) => c.t - clickStart <= 50).length;
  const tail = clickAll.length - immediate;

  const failures = [
    ...gradeClick({
      commits: clickAll.length,
      immediate,
      tail,
      responseMs,
      pressT,
      selected,
      target,
    }),
    ...gradeHover({
      commits: hoverAll.length,
      hoverTail,
      hoverResponseMs,
      firstMoveT,
      expandedT,
      expandedId,
      target,
    }),
  ];

  return {
    width,
    ok: failures.length === 0,
    failures,
    hoverCommits: hoverAll.length,
    hoverTail,
    hoverResponseMs,
    hoverExpanded: expandedId,
    // The raw stamps travel with the record so `--json` can disambiguate a missing measurement
    // without a re-run: which END was absent is the whole question.
    stamps: { pressT, firstMoveT, expandedT },
    clickCommits: clickAll.length,
    clickImmediate: immediate,
    clickTail: tail,
    clickResponseMs: responseMs,
    selected,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const widths = parseWidths(args.widths);
  if (widths === null) {
    console.error(`--widths must be a comma-separated list of positive numbers (got: ${String(args.widths)})`);
    process.exit(2);
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
    browser = await launch({ width: 1200, height: 900 });
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
        results.push(await measureWidth(page, server.url, width));
      } finally {
        await page.close();
      }
    }
  } catch (e) {
    console.error(`probe failed: ${e.message}`);
    await browser.close();
    server.stop();
    process.exit(2);
  }
  await browser.close();
  server.stop();

  if (args.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const r of results) {
      console.log(
        `w=${r.width}  click=${r.clickCommits} commits (${r.clickImmediate} immediate + ${r.clickTail} tail)  ` +
          `hover=${r.hoverCommits} (${r.hoverTail} late)  respond=${
          r.clickResponseMs === null ? "?" : `${r.clickResponseMs.toFixed(1)}ms`
        }  selected=${r.selected}  ${r.ok ? "OK" : "FAIL"}`,
      );
      for (const f of r.failures) console.log(`    ✗ ${f}`);
    }
  }
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

/**
 * Was this file EXECUTED, or merely imported by the unit tests?
 *
 * Compared as REALPATHS, not as URL strings, which is the strongest of the three forms in this
 * repo and the one `scripts/concierge-probe.mjs` documents. Every weaker form fails the same
 * silent way — main() never runs, exit 0, no output, no error, an instrument that "passes" by
 * doing nothing:
 *
 *   • `import.meta.url === "file://" + argv[1]`  — dies on the space in "Application Support",
 *     which is percent-encoded on one side and not the other. This probe shipped with it.
 *   • `import.meta.url === pathToFileURL(argv[1]).href` — fixes the space, but a SYMLINK to this
 *     script (a launcher in ~/bin, a Homebrew shim) still differs from its realpath, as does
 *     anything under macOS's /tmp → /private/tmp alias. It also THROWS when argv[1] is absent.
 *
 * `realpathSync` resolves symlinks and the /tmp alias on both sides; the `path.resolve` fallback
 * covers a path that is not on disk (roborev 62826).
 */
function isDirectEntrypoint() {
  const entry = process.argv[1];
  if (!entry) return false; // imported by harness.test.mjs, not executed.
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(fileURLToPath(import.meta.url)) === real(entry);
}

if (isDirectEntrypoint()) {
  await main();
}
