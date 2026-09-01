#!/usr/bin/env node
// tab-crowded-probe — read the REAL GEOMETRY of the project tab strip when it is too crowded to
// show every name, and say whether the floor and the hover expansion actually work.
//
//   pnpm --filter @sparkle/desktop visual:tab-crowded
//   pnpm --filter @sparkle/desktop visual:tab-crowded -- --json
//   pnpm --filter @sparkle/desktop visual:tab-crowded -- --widths=760,520,380
//
// (or `node scripts/visual/tab-crowded-probe.mjs` from apps/desktop).
//
// ── WHY THIS EXISTS (bead sparkle-z24dl) ────────────────────────────────────────────────────────
// The founder could not read his own project tabs: with several projects open the strip squeezed
// each tab until the NAME was gone while every badge survived — one tab read "fo...", one read
// "t..", and the SELECTED tab showed no name whatsoever, just a red ⚠155 and a close ×.
//
// Both halves of the fix are pure layout, and **jsdom has no layout engine**: every rect is zero,
// `clientWidth`/`scrollWidth` are zero, and `min-width`, flex shrinking and `text-overflow` never
// evaluate (docs/jsdom-test-caveats.md). So the unit suite can pin the STYLE SHAPE — it does, in
// `src/components/ProjectTabs.hoverExpand.test.tsx` — but it physically cannot tell:
//
//   * a label floored at six characters from one squeezed to zero, nor
//   * an expansion that leaves its neighbours alone from one that shoves them along the bar.
//
// That second one is the requirement the founder was most explicit about ("a strip that reshuffles
// under the cursor is worse than truncation"), and it is exactly the kind of claim a green jsdom
// suite will happily make about broken code. This is the half that can actually fail on geometry.
//
// It is a probe (like `seam-probe.mjs` and `recap-narrow-probe.mjs`) rather than a `.test.mjs`,
// deliberately: it needs Chrome on the machine and a vite dev server, neither of which the unit
// suite should depend on. Run it when you touch `ProjectTabs.tsx`. Exit 0 = every check passed;
// exit 1 = a real layout regression; exit 2 = the probe could not run (no Chrome, no server).
//
// ── WHAT IT ASSERTS ─────────────────────────────────────────────────────────────────────────────
//   FLOOR            no tab's label is narrower than the floor its own name allows — that is
//                    `min(floor, what the name needs)`, so a SHORT name is never reported as
//                    violating a floor it could not reach, and a long one may not vanish.
//   ACTIVE FLOOR     the selected tab's label clears the HIGHER floor. It is the tab that lost its
//                    name first, because it carries the widest chrome.
//   REVEAL           hovering a truncated tab makes its label wide enough to hold the whole name
//                    (clientWidth >= scrollWidth — which is only true when nothing is clipped).
//   NO REFLOW        while that tab is expanded, EVERY OTHER TAB's left edge and width are
//                    unchanged to the sub-pixel. This is the founder's hard requirement.
//   SELECTED TOO     reveal + no-reflow again, driven on the SELECTED tab.
//   REAL POINTER     the hover is a CDP `Input.dispatchMouseEvent`, not a synthetic React event, so
//                    what is exercised is the same path a hand on the trackpad takes.
//
// A NOTE ON WIDTHS. 760 is roomy (six tabs nearly fit), 520 is the crowded case from the report,
// 380 is past the floor — where the tabs stop shrinking and the strip has to scroll instead. All
// three must satisfy every rule above; the floor is not allowed to lapse just because the strip ran
// out of room, since that lapse IS the bug.

import { pathToFileURL } from "node:url";
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

export const DEFAULT_WIDTHS = [760, 520, 380];

/**
 * Parse `--widths`, or `null` when the argument is unusable.
 *
 * VALIDATED, NOT COERCED, for the reason `recap-narrow-probe.mjs` learned the hard way: a bare
 * `--widths` arrives as `true`, and `String(true).split(",").map(Number)` yields `[NaN]`. The probe
 * would then navigate to `?w=NaN`, the harness would set `width: "NaNpx"` and fall back to the
 * viewport, and every comparison would be graded against a layout that is not crowded at all — a
 * silent PASS from an instrument, which is the worst thing an instrument can do.
 */
export function parseWidths(raw) {
  if (raw === undefined) return DEFAULT_WIDTHS;
  if (typeof raw !== "string") return null;
  const parts = raw.split(",").map((s) => Number(s.trim()));
  if (!parts.length || parts.some((n) => !Number.isFinite(n) || n <= 0)) return null;
  return parts;
}

/**
 * The floors, MIRRORED FROM THE COMPONENT — and mirrored under protest.
 *
 * `ProjectTabs.tsx` is TypeScript inside `src`, and this file is plain JS run by node with no
 * transform, so it cannot import the constants. `assertFloorsMatchSource` below reads them back out
 * of the source and fails the probe if they have drifted, which is the only thing that keeps a
 * copied number honest: a floor lowered in the component and not here would otherwise leave the
 * probe grading against a rule that no longer exists and reporting green.
 */
export const FLOOR = 46;
export const FLOOR_ACTIVE = 104;

/** Pull a `export const NAME = <number>;` out of the component source. */
export function readFloor(src, name) {
  const m = new RegExp(`export const ${name} = (\\d+);`).exec(src);
  return m ? Number(m[1]) : null;
}

/** True when this file's copies still agree with the component. */
export function floorsMatch(src) {
  return (
    readFloor(src, "TAB_LABEL_MIN_WIDTH") === FLOOR &&
    readFloor(src, "TAB_LABEL_MIN_WIDTH_ACTIVE") === FLOOR_ACTIVE
  );
}

/** Measure every tab: its box in the strip, and its label's rendered vs natural width. */
const MEASURE = `(() => {
  // THE SLOT, by class — not by \'[role="tab"]\'. Since bead sparkle-2mwl2m.1 the tab ROLE sits on
  // the label inside the slot (a tab flattens its children, which was silencing the close button),
  // so a role query would return the label and every rect below would measure the wrong box.
  const tabs = [...document.querySelectorAll(".concierge-tab")].map((t) => {
    const id = (t.getAttribute("data-testid") || "").replace(/^tab-/, "");
    const label = t.querySelector('[data-testid="tab-label-' + id + '"]');
    const r = t.getBoundingClientRect();
    const lr = label.getBoundingClientRect();
    return {
      id,
      active: label.getAttribute("aria-selected") === "true",
      expanded: t.getAttribute("data-expanded") === "true",
      // The SLOT's box — what must not move when a sibling expands. BOTH AXES: this recorded
      // left/width only, and the tab-click bug (bead sparkle-73imb) lived precisely in the axis it
      // was not looking at — the expanding tab's own height collapsing to zero, which moved every
      // bottom-aligned sibling's top edge and dropped the click that landed on it.
      left: r.left, width: r.width,
      top: r.top, height: r.height,
      // The LABEL's rendered width vs the width its text actually needs. clientWidth < scrollWidth
      // is the definition of "this name is being clipped".
      labelWidth: lr.width,
      labelNatural: label.scrollWidth,
      text: label.textContent,
    };
  });
  return { tabs };
})()`;

/** Was any name clipped at all? If nothing is clipped the strip is not crowded and the run proves
 *  nothing about crowding — so the probe treats that as a failed SETUP, not as a pass. */
export function anyClipped(tabs) {
  return tabs.some((t) => t.labelNatural > t.labelWidth + 0.5);
}

/**
 * Every floor violation among `tabs`.
 *
 * The floor a tab is held to is `min(configured floor, what its own name needs)` — the same cap the
 * component applies (`labelMinWidth`). Without that cap a project called "qa" would be reported as
 * violating a 46px floor it can never reach, and the probe would red on correct code.
 */
export function floorViolations(tabs) {
  const out = [];
  for (const t of tabs) {
    if (t.expanded) continue; // an expanded tab is unclamped by definition
    const owed = Math.min(t.active ? FLOOR_ACTIVE : FLOOR, t.labelNatural);
    // Half a pixel of slack: widths are fractional and the comparison is about a collapsed label,
    // not about sub-pixel rounding.
    if (t.labelWidth + 0.5 < owed) {
      out.push({ id: t.id, active: t.active, got: t.labelWidth, owed, text: t.text });
    }
  }
  return out;
}

/** Tabs whose box moved between two measurements — `except` is the tab that was expanded. */
export function moved(before, after, except) {
  const b = new Map(before.map((t) => [t.id, t]));
  const out = [];
  for (const t of after) {
    if (t.id === except) continue;
    const was = b.get(t.id);
    if (!was) {
      out.push({ id: t.id, reason: "disappeared" });
      continue;
    }
    // BOTH AXES. A sibling's top edge moving is just as much a reflow as its left edge moving, and
    // with `align-items: flex-end` it is what a change in the LINE's height looks like from here.
    if (
      Math.abs(was.left - t.left) > 0.5 ||
      Math.abs(was.width - t.width) > 0.5 ||
      Math.abs(was.top - t.top) > 0.5 ||
      Math.abs(was.height - t.height) > 0.5
    ) {
      out.push({
        id: t.id,
        from: { left: was.left, width: was.width, top: was.top, height: was.height },
        to: { left: t.left, width: t.width, top: t.top, height: t.height },
      });
    }
  }
  return out;
}

/**
 * Did the EXPANDED tab keep its own box height? — the one thing `moved()` cannot answer, because the
 * expanded tab is exactly the tab it skips.
 *
 * This is the detector for bead sparkle-73imb. The expansion takes the tab's body out of flow, and
 * the slot left behind has no in-flow content at all; if nothing restores its height it collapses to
 * zero, the pointer is no longer over the tab, and the strip oscillates between expanded and
 * collapsed while a click pressed into that gap hit-tests to the strip behind it. Returns `null`
 * when the height held, or `{ was, now }` when it did not.
 */
export function shrank(before, after, id) {
  const was = before.find((t) => t.id === id);
  const now = after.find((t) => t.id === id);
  if (!was || !now) return null;
  // Half a pixel of slack, the same as `moved()`: this is about a collapse, not about sub-pixel
  // rounding. GROWING is not a failure — an expansion is allowed to be taller if its content is.
  if (now.height + 0.5 < was.height) return { was: was.height, now: now.height };
  return null;
}

/** Did the expanded tab actually reveal its whole name? */
export function revealed(tab) {
  return !!tab && tab.expanded && tab.labelWidth + 0.5 >= tab.labelNatural;
}

/** Grade one width's measurements into a verdict. Pure, so the rules are unit-testable. */
export function verdictFor(width, m) {
  const failures = [];
  if (m.tabs.length !== 6) failures.push(`expected 6 tabs, saw ${m.tabs.length}`);
  if (!anyClipped(m.before.tabs)) {
    failures.push(
      `no name is clipped at ${width}px — the strip is not crowded, so this width proves nothing`,
    );
  }
  for (const v of floorViolations(m.before.tabs)) {
    failures.push(
      `label "${v.text}" (${v.active ? "ACTIVE" : "inactive"}) is ${v.got.toFixed(1)}px, under its ${v.owed.toFixed(1)}px floor`,
    );
  }
  for (const probe of m.hovers) {
    const hovered = probe.after.tabs.find((t) => t.id === probe.id);
    if (!revealed(hovered)) {
      failures.push(
        `hovering ${probe.id} (${probe.which}) did not reveal its name: label ${hovered?.labelWidth?.toFixed(1)}px vs ${hovered?.labelNatural}px needed, expanded=${hovered?.expanded}`,
      );
    }
    const collapsed = shrank(probe.before.tabs, probe.after.tabs, probe.id);
    if (collapsed) {
      failures.push(
        `expanding ${probe.id} COLLAPSED its own box: ${collapsed.was.toFixed(1)}px tall -> ` +
          `${collapsed.now.toFixed(1)}px. A tab with no height is not under the pointer, so the ` +
          `hover oscillates and a click pressed onto it hit-tests to the strip behind (sparkle-73imb)`,
      );
    }
    const shifted = moved(probe.before.tabs, probe.after.tabs, probe.id);
    for (const s of shifted) {
      failures.push(
        `expanding ${probe.id} MOVED ${s.id}: ${JSON.stringify(s.from ?? s.reason)} -> ${JSON.stringify(s.to ?? "")}`,
      );
    }
  }
  return { width, ok: failures.length === 0, failures, tabs: m.before.tabs };
}

/**
 * Move the real pointer.
 *
 * `button: "none"` is REQUIRED, not decoration — CDP's `mouseMoved` needs an explicit button state
 * and silently produces nothing useful without it, which presents as a hover that simply never
 * happens. And the move is sent TWICE, a pixel apart: the browser derives `mouseover`/`mouseout`
 * from a CHANGE of hit-tested element, so the very first move of a session (from the pointer's
 * undefined origin) can land without a transition to report.
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

/** Move the real pointer to the centre of a tab. */
async function hoverTab(page, id) {
  const box = await page.evaluate(
    `(() => { const r = document.querySelector('[data-testid="tab-${id}"]').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
  );
  await movePointer(page, box.x, box.y);
}

/** Park the pointer well clear of the strip so the previous tab collapses. */
async function unhover(page) {
  await movePointer(page, 5, 700);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const widths = parseWidths(args.widths);
  if (widths === null) {
    console.error(
      `--widths must be a comma-separated list of positive numbers (got: ${String(args.widths)})`,
    );
    process.exit(2);
  }

  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { DESKTOP_DIR } = await import("./serve.mjs");
  const src = readFileSync(join(DESKTOP_DIR, "src", "components", "ProjectTabs.tsx"), "utf8");
  if (!floorsMatch(src)) {
    console.error(
      "the floors in this probe no longer match ProjectTabs.tsx — update FLOOR/FLOOR_ACTIVE",
    );
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
        await page.navigate(`${server.url}/scripts/visual/tab-crowded-harness.html?w=${width}`);
        // A readiness timeout almost always means the harness THREW while mounting, and the bare
        // "waitForFunction timed out" that used to surface here says nothing about that — it reads
        // like a slow machine. The page's own errors are what actually names the cause, so they are
        // attached to the failure rather than left in a console nobody is watching.
        try {
          await page.waitForFunction("window.__tabHarnessReady === true", { timeout: 30000 });
        } catch (e) {
          const errs = page.consoleErrors.length
            ? `\npage errors:\n  ${page.consoleErrors.join("\n  ")}`
            : "\n(no page errors were reported — check the dev server compiled the harness)";
          throw new Error(`${e.message}${errs}`);
        }
        await unhover(page);

        const before = await page.evaluate(MEASURE);
        // A clipped INACTIVE tab and the ACTIVE one — the two cases in the report. The inactive one
        // is chosen from the measurements rather than hard-coded, so the probe keeps testing "a tab
        // that is actually truncated" even if the harness's names or widths change.
        const inactive = before.tabs.find((t) => !t.active && t.labelNatural > t.labelWidth + 0.5);
        const active = before.tabs.find((t) => t.active);
        const targets = [
          inactive ? { id: inactive.id, which: "inactive" } : null,
          active ? { id: active.id, which: "SELECTED" } : null,
        ].filter(Boolean);

        const hovers = [];
        for (const t of targets) {
          await unhover(page);
          const pre = await page.evaluate(MEASURE);
          await hoverTab(page, t.id);
          // Wait for the component's own hover delay to elapse and React to commit, rather than
          // sleeping a guessed amount.
          await page
            .waitForFunction(
              `!!document.querySelector('[data-testid="tab-${t.id}"][data-expanded="true"]')`,
              { timeout: 5000 },
            )
            .catch(() => {});
          const post = await page.evaluate(MEASURE);
          hovers.push({ ...t, before: pre, after: post });
        }

        if (page.consoleErrors.length) {
          console.error(`page errors at ${width}px:\n  ${page.consoleErrors.join("\n  ")}`);
        }
        results.push(verdictFor(width, { tabs: before.tabs, before, hovers }));
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
    server.stop();
  }

  if (args.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const r of results) {
      console.log(`\n${r.ok ? "PASS" : "FAIL"}  strip ${r.width}px`);
      for (const t of r.tabs) {
        const clip = t.labelNatural > t.labelWidth + 0.5 ? "clipped" : "whole";
        console.log(
          `   ${t.active ? "*" : " "} ${t.text.padEnd(18)} label ${t.labelWidth.toFixed(0).padStart(4)}px / needs ${String(t.labelNatural).padStart(4)}px  ${clip}`,
        );
      }
      for (const f of r.failures) console.log(`   ✗ ${f}`);
    }
  }
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(2);
  });
}
