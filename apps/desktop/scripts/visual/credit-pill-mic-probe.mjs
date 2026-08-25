#!/usr/bin/env node
// credit-pill-mic-probe — read the REAL GEOMETRY of the concierge voice strip in REAL Chrome and say
// whether the balance/credit pill ever paints over the mic ring.
//
//   pnpm --filter @sparkle/desktop visual:credit-pill-mic
//   pnpm --filter @sparkle/desktop visual:credit-pill-mic -- --json
//   pnpm --filter @sparkle/desktop visual:credit-pill-mic -- --widths=360,280,220,190 --shots=/tmp/out
//
// (or `node scripts/visual/credit-pill-mic-probe.mjs` from apps/desktop.) Exit 0 = every check
// passed; 1 = a real layout defect; 2 = the probe could not run (no Chrome, no dev server).
//
// ── WHY THIS EXISTS (bead sparkle-kk9dg.5) ──────────────────────────────────────────────────────
// At a painted concierge width of ~190px the credit pill sat ON TOP of the mic ring. It is a
// DIFFERENT defect from the waveform-crowding one bead sparkle-kk9dg.3 fixed at 280px, and the two
// pull in opposite directions, which is why this file measures both and not just one:
//
//   • `.3` was about the BARS meeting the pill's ink with no separation. Its fix widened the pill's
//     blurred backdrop by a 10px gutter so the softened region reaches past the glyphs — i.e. it
//     deliberately made the pill's BOX WIDER and pushed it FURTHER over the waveform.
//   • `.5` is about the RING. The pill is `position: absolute; right: 16 − gutter`, so it takes zero
//     width from the waveform (the founder's explicit "do not shrink the waveform to make room"),
//     and the ring floats centred in the strip. As the column narrows the centre walks left slower
//     than the pill's left edge does, and below a certain width they meet.
//
// Both are geometry, and **jsdom can see neither**: it has no layout engine, `getBoundingClientRect`
// returns zeros and the stylesheet never loads (docs/jsdom-test-caveats.md). The state-shape half —
// which placement the column COMPUTES at a given width — is pinned in
// `src/components/Concierge/ConciergeColumn.creditPillNarrow.test.tsx`; THIS is the half that can
// actually fail on the pixels.
//
// ── WHAT IT ASSERTS ────────────────────────────────────────────────────────────────────────────
//   NO OVERLAP        the pill's border box and the mic ring's border box do not intersect. This is
//                     the bead, stated as a rectangle intersection.
//   CLEARANCE         when they DO share rows, the horizontal gap is at least `MIN_CLEARANCE_PX`.
//                     Touching edges are not "not overlapping" to a reader.
//   PILL SURVIVES     the credits control is present and clickable at EVERY width. It is the shell's
//                     only "Open credits" entry point, so a fix that hides it below a threshold
//                     would trade one defect for a worse one — this check is what forbids it.
//   WAVEFORM UNSHRUNK the wave stage still spans `strip − 2·STRIP_PAD` at every width. The founder's
//                     constraint on `.3` was "do not shrink the waveform to make room", and the
//                     cheapest wrong fix here is to lay the pill out beside the bars.
//   PILL OVERLAID WIDE at a comfortable width the pill is STILL over the wave stage. Without this
//                     the whole sweep is satisfiable by reflowing at every width, which would be a
//                     regression of the design `.3` shipped.
//   NO H-SCROLL       the strip never scrolls sideways.
//
// ── MEASURED READINGS ──────────────────────────────────────────────────────────────────────────
// Real runs of this file, dev-bypass balance `$200.00`, so the pill's border box measures 87px (see
// `PILL_BOX_PX_NOTE`). `gap` is pill.left − ring.right; negative means the boxes intersect.
//
//   BEFORE — origin/main @ 2182d6e45, `--widths=360,280,220,190`, exit 1
//     360px  pill [266–353]  ring [160–200]  gap  +67  ok
//     280px  pill [186–273]  ring [120–160]  gap  +27  ok
//     220px  pill [126–213]  ring  [90–130]  gap   −3  FAIL — boxes intersect
//     190px  pill  [96–183]  ring  [75–115]  gap  −18  FAIL — boxes intersect
//
//   The 190px row IS the bead, in numbers: the pill's left edge is 18px inside the ring's right
//   edge, and the two share every row (pill y 55–82, ring y 48–88). 280px is clean, which is why
//   bead `.3` never saw this — and why 280 stays in the default sweep as the regression guard.
//
// ── WIDTHS ─────────────────────────────────────────────────────────────────────────────────────
// 360 is `CONCIERGE_DEFAULT_WIDTH`, the width every user opens into. 280 is the width bead `.3` was
// reported and fixed at, and it is in this list specifically so a fix for `.5` cannot regress it.
// 220 is where the collision STARTS on the unchanged build — it measured −3px, i.e. a 3px overlap
// nobody had reported, which is the evidence that ~190 is a symptom of a band rather than a point.
// 190 is the founder's own reading in the bead. 140 and 50 run down to `CONCIERGE_MIN_WIDTH`,
// because a column that can be dragged there is a column somebody will drag there.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

export const DEFAULT_WIDTHS = [360, 280, 220, 190, 140, 50];

/**
 * Turn the raw `--widths` value into a width list, or `null` when it is not one.
 *
 * VALIDATED, NOT COERCED — a bare `--widths` arrives as `true` and `Number(true)` is 1, which would
 * silently sweep a 1px column and grade every rule against a layout nobody can reach. Same shape as
 * the sibling probes', after roborev 58761 found the un-validated form sweeping `NaN`.
 */
export function parseWidths(raw) {
  if (raw === undefined) return DEFAULT_WIDTHS;
  if (typeof raw !== "string") return null;
  const widths = raw.split(",").map((w) => Number(w.trim()));
  if (widths.length === 0) return null;
  if (widths.some((w) => !Number.isFinite(w) || w <= 0)) return null;
  return widths;
}

/**
 * The clearance the pill must keep from the ring, in px. Mirrors `MIC_RING_CLEARANCE_PX` in
 * `src/components/Concierge/ConciergeColumn.tsx`.
 *
 * Duplicated as a literal because a probe cannot import the app's TypeScript. The column's own unit
 * suite pins the constant; this only has to agree with it about where the behaviour changes.
 */
export const MIN_CLEARANCE_PX = 8;

/**
 * The voice strip's horizontal padding, in px — `padding: 6px 16px 0` at its render site.
 *
 * Used by the WAVEFORM UNSHRUNK check: the wave stage is the strip's content box exactly (the slot's
 * negative margins and `LogoWaveform`'s own 14px padding cancel), so `stage === strip − 32` is the
 * measurable statement of "the pill takes no width from the bars".
 */
export const STRIP_PAD_PX = 16;

/**
 * The pill's border box measures 87px under the dev-bypass fixture, whose balance is `$200.00`
 * (`stores/authStore.ts`, `balanceCents: 20000`) — a 12px tabular-nums `$200.00` in a `3px 9px`
 * badge, inside the overlay's own `3px 10px` gutter.
 *
 * IT IS NOT A CONSTANT OF THE UI, and that is the reason the fix cannot be a bare width threshold:
 * the founder's own screenshot read `$9972.67`, which is wider still, so the width at which the pill
 * reaches the ring MOVES WITH THE BALANCE. Recorded here only so the readings above can be read back
 * later; nothing asserts it.
 */
export const PILL_BOX_PX_NOTE = 87;

/**
 * Read the strip's real geometry. Runs IN THE PAGE, so it must be self-contained.
 *
 * Handles, and why each: the strip and the overlay carry `data-testid`s owned by this column, and
 * the ring carries `data-hint="mic"` — the mic ANCHOR the coach marks and the column's own one-mic
 * guard already key on, so it is the stable one. The wave stage is the overlay's SIBLING slot's only
 * child, reached structurally rather than by a new testid.
 */
export const MEASURE = `(() => {
  const strip = document.querySelector('[data-testid="concierge-voice-strip"]');
  if (!strip) return { found: false, why: 'no [data-testid=concierge-voice-strip]' };
  const pill = strip.querySelector('[data-testid="concierge-credit-overlay"]');
  const ring = strip.querySelector('[data-hint="mic"]');
  const slot = strip.querySelector('[data-testid="concierge-waveform-slot"]');
  if (!pill) return { found: true, pill: false, why: 'no [data-testid=concierge-credit-overlay]' };
  if (!ring) return { found: true, pill: true, ring: false, why: 'no [data-hint=mic]' };
  const r = (el) => {
    const b = el.getBoundingClientRect();
    return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height };
  };
  const sb = r(strip);
  const pb = r(pill);
  const rb = r(ring);
  // The wave STAGE is the positioned box the bars fill — LogoWaveform's inner
  // \`position: relative; height: WAVE_HEIGHT\` div. Reached as the first element child of the
  // component root inside the slot, so no new testid is needed on a file this bead does not own.
  const root = slot ? slot.querySelector('[data-testid="logo-waveform"]') : null;
  const stage = root ? root.firstElementChild : null;
  // The credits BUTTON, not the overlay box — "is the entry point still there" is a question about
  // the control, and a fix that left an empty backdrop behind would answer it wrongly.
  const credits = pill.querySelector('[data-hint="credits"]');
  return {
    found: true,
    pill: true,
    ring: true,
    placement: strip.getAttribute('data-credit-placement'),
    strip: sb,
    pillBox: pb,
    ringBox: rb,
    stage: stage ? r(stage) : null,
    pillText: (pill.textContent || '').trim(),
    creditsPresent: !!credits,
    creditsLabel: credits ? credits.getAttribute('aria-label') : null,
    // Is anything actually on top of the credits control where a click would land? A control that
    // is present but covered is not clickable, and only the hit test can tell them apart.
    creditsHit: (() => {
      if (!credits) return null;
      const b = credits.getBoundingClientRect();
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return hit ? (credits.contains(hit) || hit.contains(credits)) : false;
    })(),
    stripScrollW: strip.scrollWidth,
    stripClientW: strip.clientWidth,
  };
})()`;

/** Do two DOMRect-shaped boxes intersect? Pure, so the rule is unit-testable without a browser. */
export function intersects(a, b) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** Do two boxes share any rows at all? Clearance is only meaningful when they do. */
export function sharesRows(a, b) {
  return a.top < b.bottom && b.top < a.bottom;
}

/** Grade one width's measurement. Pure, so the rules are readable in a diff. */
export function verdictFor(width, m) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail || "" });

  if (!m.found || !m.pill || !m.ring) {
    add("strip, pill and ring all rendered", false, m.why || "missing element");
    return { width, checks, measured: m };
  }
  add("strip, pill and ring all rendered", true, `pill reads ${JSON.stringify(m.pillText)}`);

  // ── THE BEAD, AS A RECTANGLE INTERSECTION ──────────────────────────────────────────────────
  const overlap = intersects(m.pillBox, m.ringBox);
  add(
    "credit pill does not paint over the mic ring",
    !overlap,
    `pill [${Math.round(m.pillBox.left)}–${Math.round(m.pillBox.right)}] × ` +
      `[${Math.round(m.pillBox.top)}–${Math.round(m.pillBox.bottom)}], ` +
      `ring [${Math.round(m.ringBox.left)}–${Math.round(m.ringBox.right)}] × ` +
      `[${Math.round(m.ringBox.top)}–${Math.round(m.ringBox.bottom)}]`,
  );

  // ── CLEARANCE, but ONLY where it means something ────────────────────────────────────────────
  // Once the pill has moved to its own row the two boxes share no rows, and a horizontal gap
  // between boxes on different lines is not a fact about crowding. Reported either way so a reader
  // can see which regime the width is in rather than seeing a check quietly vanish.
  if (sharesRows(m.pillBox, m.ringBox)) {
    const gap = m.pillBox.left - m.ringBox.right;
    add(
      `pill keeps ${MIN_CLEARANCE_PX}px clear of the ring`,
      gap >= MIN_CLEARANCE_PX - 1,
      `gap ${Math.round(gap)}px`,
    );
  } else {
    checks.push({
      name: `pill keeps ${MIN_CLEARANCE_PX}px clear of the ring (N/A — different rows)`,
      ok: true,
      detail:
        `pill rows [${Math.round(m.pillBox.top)}–${Math.round(m.pillBox.bottom)}] vs ` +
        `ring rows [${Math.round(m.ringBox.top)}–${Math.round(m.ringBox.bottom)}]`,
    });
  }

  // ── THE ENTRY POINT SURVIVES ────────────────────────────────────────────────────────────────
  // This is what forbids the cheap fix. `BalanceBadge` is the shell's only "Open credits" control
  // and the only place a top-up done elsewhere shows up; hiding it below a width would remove a
  // capability to fix a collision.
  add("the credits control is still on screen", m.creditsPresent, m.creditsLabel || "");
  add(
    "the credits control is still clickable (nothing covers it)",
    m.creditsHit === true,
    `elementFromPoint at its centre ${m.creditsHit ? "lands on it" : "lands elsewhere"}`,
  );

  // ── THE FOUNDER'S CONSTRAINT, MEASURED ──────────────────────────────────────────────────────
  // "Do not shrink the waveform to make room." The stage must still span the strip's content box at
  // every width — a pill laid out BESIDE the bars would show up here as a stage narrower than
  // `strip − 32`.
  if (m.stage) {
    const expected = m.strip.width - 2 * STRIP_PAD_PX;
    add(
      "the waveform still spans the whole strip (never shrunk for the pill)",
      Math.abs(m.stage.width - expected) <= 1,
      `stage ${Math.round(m.stage.width)}px vs strip ${Math.round(m.strip.width)}px − 2×${STRIP_PAD_PX} = ${Math.round(expected)}px`,
    );
  } else {
    add("the waveform still spans the whole strip (never shrunk for the pill)", false, "no wave stage found");
  }

  add(
    "the strip does not scroll sideways",
    m.stripScrollW - m.stripClientW <= 1,
    `overflow ${m.stripScrollW - m.stripClientW}px`,
  );
  return { width, checks, measured: m };
}

/**
 * The narrowest width at which the pill must STILL be overlaid on the wave stage.
 *
 * The anti-vacuity check. Every rule above is satisfied by a build that puts the pill on its own row
 * at every width — which would delete the overlay design bead `.3` shipped and make the strip taller
 * for everyone. So at and above this width the pill is required to be over the bars.
 *
 * 280 is bead `.3`'s own reported width, so this is literally "did I regress the sibling fix".
 */
export const OVERLAY_REQUIRED_MIN_PX = 280;

/** Grade the sweep as a whole — the checks a single width cannot express. */
export function sweepChecks(results) {
  const checks = [];
  for (const r of results) {
    if (!r.measured.found || !r.measured.pill || !r.measured.ring) continue;
    if (r.width < OVERLAY_REQUIRED_MIN_PX) continue;
    const overlaid = sharesRows(r.measured.pillBox, r.measured.stage ?? r.measured.ringBox);
    checks.push({
      name: `${r.width}px: the pill is STILL overlaid on the wave stage`,
      ok: overlaid,
      detail: overlaid
        ? `placement=${r.measured.placement}`
        : `placement=${r.measured.placement} — reflowing here would undo bead sparkle-kk9dg.3's design`,
    });
  }
  return checks;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const widths = parseWidths(args.widths);
  if (widths === null) {
    console.error(`--widths must be a comma-separated list of positive numbers (got: ${String(args.widths)})`);
    process.exit(2);
  }
  const shotDir = typeof args.shots === "string" ? args.shots : null;
  if (shotDir) mkdirSync(shotDir, { recursive: true });

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
        // `?concierge=N` is the fixture's own concierge-width seed (dev/visualFixtures
        // `visualConciergeWidth`) — it writes the two `sparkle-concierge-width` keys BEFORE
        // `createRoot`, so the app boots already narrow rather than being resized mid-reflow.
        const url = `${server.url}/?visual=1&capture=1&concierge=${width}`;
        for (const source of [CLEAR_STORAGE, TAURI_SHIM, FROZEN_CLOCK]) {
          await page.addInitScript(source);
        }
        await page.navigate(url);
        await page.waitForFunction(
          `!!document.querySelector('[data-testid="concierge-credit-overlay"]')` +
            ` && !!document.querySelector('[data-hint="mic"]')`,
          { timeout: 30000 },
        );
        // THE RESIZEOBSERVER RACE, the same one `blocked-row-narrow-probe` documents. The column
        // measures its own strip to decide the pill's placement, and that observer's first callback
        // is not guaranteed to have run when the elements first appear — so without this wait the
        // narrow widths were sometimes graded against the UNMEASURED (overlay) default. Wait for the
        // strip's own painted width to reach the width under test.
        // 2px of tolerance: `getBoundingClientRect().width` is a float.
        await page.waitForFunction(
          `Math.abs(document.querySelector('[data-testid="concierge-voice-strip"]')` +
            `.getBoundingClientRect().width - ${width}) <= 2`,
          { timeout: 30000 },
        );
        const m = await page.evaluate(MEASURE);
        if (shotDir && m.found && m.pill) {
          const clip = {
            x: Math.max(0, Math.round(m.strip.left) - 4),
            y: Math.max(0, Math.round(m.strip.top) - 4),
            width: Math.round(m.strip.width) + 8,
            height: Math.round(m.strip.height) + 8,
          };
          writeFileSync(join(shotDir, `credit-pill-mic-${width}px.png`), await page.screenshot({ clip }));
        }
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

  const sweep = sweepChecks(results);
  const failed = results.filter((r) => r.checks.some((c) => !c.ok));
  const sweepFailed = sweep.filter((c) => !c.ok);

  if (args.json) {
    console.log(JSON.stringify({ results, sweep, ok: failed.length === 0 && sweepFailed.length === 0 }, null, 2));
  } else {
    for (const r of results) {
      const gap =
        r.measured.pillBox && r.measured.ringBox
          ? Math.round(r.measured.pillBox.left - r.measured.ringBox.right)
          : null;
      console.log(
        `\n── ${r.width}px ${"─".repeat(40)}  placement=${r.measured.placement ?? "?"}` +
          (gap === null ? "" : `  gap=${gap}px`),
      );
      for (const c of r.checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}\n          ${c.detail}`);
    }
    console.log(`\n── across the sweep ${"─".repeat(40)}`);
    for (const c of sweep) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}\n          ${c.detail}`);
    console.log(
      failed.length === 0 && sweepFailed.length === 0
        ? `\nCREDIT PILL / MIC PROBE PASSED (${results.length} width(s): ${widths.join(", ")})`
        : `\nCREDIT PILL / MIC PROBE FAILED at ${[...failed.map((r) => `${r.width}px`), ...sweepFailed.map((c) => c.name)].join(", ")}`,
    );
  }
  process.exit(failed.length === 0 && sweepFailed.length === 0 ? 0 : 1);
}

// `pathToFileURL`, NOT a `file://` template: this repo lives under a path containing a SPACE
// ("Application Support"), which `import.meta.url` percent-encodes and the template does not — the
// naive guard never matches, `main()` never runs, and the probe exits 0 having asserted NOTHING.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // EXIT 2, NOT 1 — everything past the two guarded setup steps (above all the 30s
  // `waitForFunction`) reaches an unhandled rejection, and Node exits 1 for that. This file defines
  // 1 as "a real layout defect"; a stale bundle or a changed handle is "could not run".
  main().catch((e) => {
    console.error(`credit-pill-mic-probe: could not run — ${e?.message ?? e}`);
    process.exit(2);
  });
}
