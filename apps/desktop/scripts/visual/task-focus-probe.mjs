#!/usr/bin/env node
// task-focus-probe — press "Open · in column" in a REAL browser and read the store back.
//
//   node scripts/visual/task-focus-probe.mjs            # from apps/desktop
//   node scripts/visual/task-focus-probe.mjs --out=/tmp/shots
//
// ── WHAT IT PROVES THAT THE UNIT TESTS DO NOT ───────────────────────────────────────────────────
// `BeadPill.openEpic.test.tsx` drives the same real host and asserts the same store keys, faster.
// What it cannot prove is that a HUMAN can press the control: jsdom has no layout, so a link that
// is present but zero-sized, clipped by an overflow, or covered by a sibling satisfies every one of
// those rows. This clicks by HIT-TESTING the element's own painted box — `elementFromPoint` at its
// centre must return the link itself — so "covered by something" is a failure here and invisible
// there.
//
// ── THE READING IS ABOUT THE TWO RUNGS ──────────────────────────────────────────────────────────
// Both links look identical and both narrow the column; what separates them is which store key the
// click writes. The founder's constraint is stated in those terms — opening a task must narrow the
// column *"without closing the open epic card"*, and the epics column decides that from
// `epicFocusBySide` alone. So: open the EPIC, then open the TASK, and check the epic key SURVIVED
// while the effective focus moved to the task.
//
// Exit 0 = every step ran and every reading matched. Exit 2 = the probe could not RUN (no Chrome,
// no dev server) — it says nothing about the feature. Exit 3 = it ran and a reading was wrong,
// which is the finding. The two are deliberately distinct: a probe that never started must never
// read as a failing feature.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch } from "./cdp.mjs";
import { startDevServer } from "./serve.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
  }),
);
const OUT = typeof args.out === "string" ? args.out : "visual-out/task-focus";

/**
 * Click the `data-testid` inside the card for `beadId`, by hit-testing its painted centre.
 *
 * THE HIT TEST IS THE POINT, not decoration. `el.click()` alone dispatches on the node whatever is
 * painted on top of it, so it would pass on a link covered by an overlay — exactly the class of
 * failure a browser is being used to catch. Returns a STRING verdict rather than throwing, so the
 * probe can report which step failed and where.
 */
const CLICK = (beadId, testId) => `(() => {
  const cards = [...document.querySelectorAll('[data-testid="concierge-bead-card"]')];
  const card = cards.find((c) => (c.textContent || "").includes(${JSON.stringify(beadId)}));
  if (!card) return "no card for ${beadId}";
  const el = card.querySelector('[data-testid="${testId}"]');
  if (!el) return "no ${testId} on the ${beadId} card";
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return "${testId} has zero size — present but unpressable";
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const hit = document.elementFromPoint(x, y);
  if (!hit || (hit !== el && !el.contains(hit))) {
    return "${testId} is covered at its centre by <" + (hit ? hit.tagName.toLowerCase() : "nothing") + ">";
  }
  hit.click();
  return "ok";
})()`;

const READ = `JSON.stringify(window.__focusState())`;

async function main() {
  mkdirSync(OUT, { recursive: true });
  let server, browser;
  try {
    server = await startDevServer({ quiet: !args.verbose });
  } catch (e) {
    console.error(`task-focus-probe: could not start the dev server: ${e.message}`);
    process.exit(2);
  }
  try {
    browser = await launch({ width: 900, height: 1400 });
  } catch (e) {
    server.stop();
    console.error(`task-focus-probe: could not launch Chrome: ${e.message}`);
    process.exit(2);
  }

  const report = { steps: [] };
  const fail = (msg) => {
    report.error = msg;
    console.error(`task-focus-probe: ${msg}`);
  };

  try {
    const page = await browser.newPage();
    try {
      await page.setViewport({ width: 900, height: 1400, deviceScaleFactor: 2 });
      await page.navigate(`${server.url}/scripts/visual/task-focus-harness.html?theme=dark&w=380`);
      await page.waitForFunction("window.__taskFocusHarnessReady === true", { timeout: 30000 });

      report.before = JSON.parse(await page.evaluate(READ));

      // ── 1. OPEN THE EPIC ────────────────────────────────────────────────────────────────────
      const c1 = await page.evaluate(CLICK("sparkle-epic1", "concierge-bead-card-open-in-column"));
      report.steps.push({ step: "click epic in-column", result: c1 });
      if (c1 !== "ok") fail(`epic click: ${c1}`);
      const afterEpic = JSON.parse(await page.evaluate(READ));
      report.afterEpic = afterEpic;
      if (!report.error && afterEpic.epic !== "sparkle-epic1") {
        fail(`epic click did not focus the epic — epicFocusBySide.right is ${afterEpic.epic}`);
      }
      // The narrowing is invisible while the side shows the Plan board; the harness starts in
      // "plan" deliberately, so this also proves the paired `showBuildStage` write happened.
      if (!report.error && afterEpic.workMode !== "build") {
        fail(`the side did not switch to Build — workMode is ${afterEpic.workMode}`);
      }

      // ── 2. OPEN THE CHILD TASK ──────────────────────────────────────────────────────────────
      const c2 = await page.evaluate(CLICK("sparkle-task1", "concierge-bead-card-open-in-column"));
      report.steps.push({ step: "click task in-column", result: c2 });
      if (!report.error && c2 !== "ok") fail(`task click: ${c2}`);
      const afterTask = JSON.parse(await page.evaluate(READ));
      report.afterTask = afterTask;

      if (!report.error) {
        // THE THREE READINGS THE FOUNDER'S SENTENCE MAKES, in his order.
        if (afterTask.bead !== "sparkle-task1") {
          fail(`the task did not become the child focus — beadFocusBySide.right is ${afterTask.bead}`);
        } else if (afterTask.effective !== "sparkle-task1") {
          fail(`the column did not narrow to the task — effective focus is ${afterTask.effective}`);
        } else if (afterTask.epic !== "sparkle-epic1") {
          // *"without closing the open epic card"* — the epics column reads this key to decide
          // which card is open, so a task written here would snap it shut.
          fail(`the epic focus was DESTROYED by the task click — it is now ${afterTask.epic}`);
        }
      }

      const clip = await page.boundingBox("#column");
      const png = await page.screenshot({ clip });
      const file = join(OUT, "task-focus-dark.png");
      writeFileSync(file, png);
      report.screenshot = file;
    } finally {
      await page.close();
    }
  } finally {
    await browser.close();
    server.stop();
  }

  console.log(JSON.stringify(report, null, 2));
  // 3, not 2: the probe RAN. See the header — a probe that never started must not read as a
  // failing feature.
  if (report.error) process.exitCode = 3;
}

main().catch((e) => {
  console.error(`task-focus-probe: ${e.stack || e.message}`);
  process.exit(2);
});
