#!/usr/bin/env node
// autosend-pause-probe — watch the auto-send countdown HALT under a typing hand, in a real browser.
//
//   node scripts/visual/autosend-pause-probe.mjs --out=/tmp/shots
//
// ── WHY THIS EXISTS (bead sparkle-wfwypy) ───────────────────────────────────────────────────────
// The founder: *"when I start by talking, and then I start typing in the compose window, it's not
// pausing the auto send."* He asked to be shown it working, not told. The jsdom suites prove the
// reducer, the predicate and the DOM wire; none of them can show the fill he actually watches
// stopping under his hands, because jsdom neither paints nor keeps a clock he can see.
//
// So this drives the real hook and the real tray on a real clock and takes two pictures: the
// countdown mid-drain, and the same countdown frozen after a keystroke. The number under each shot
// is the tray's own `remainingFraction` — the fill and the reading are the same value, so a frozen
// bar cannot be a frozen picture of a running clock.
//
// Exit 0 = the countdown paused and re-evaluated; 1 = it did not (a real regression); 2 = the probe
// could not run (no Chrome, no dev server).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { launch } from "./cdp.mjs";
import { startDevServer, CLEAR_STORAGE, TAURI_SHIM } from "./serve.mjs";

export function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

// NOT `FROZEN_CLOCK`. Every other probe in this directory pins `Date.now()` so a capture is
// reproducible — here that would stop the very thing under test, and the countdown would sit at a
// full fill forever while the probe reported a successful pause. The cost is that the exact
// fractions vary run to run, so the assertions below are about ORDER and MOVEMENT, never equality
// with a literal.
const INIT_SCRIPTS = [CLEAR_STORAGE, TAURI_SHIM];

// Mirrors voice/composeInteraction. A literal rather than an import because this file is plain
// node ESM outside the vite graph — if the constant moves, this probe's step 4 waits too little and
// reports a working re-evaluation as a countdown that never came back.
const TYPING_SETTLE_MS = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rail(page) {
  const state = JSON.parse(await page.evaluate("JSON.stringify(window.__rail)"));
  // THE PAINTED WIDTH, not just the model's number. The founder's ask is that the countdown
  // VISIBLY halts, and only the laid-out box can answer that — a frozen model behind a fill that
  // kept animating (a stray CSS transition, an easing that never settles) would still be the send
  // creeping up on him. The sweep is right-anchored with width = the remaining fraction, so this
  // is the same fact the model states, measured on the other side of the renderer.
  const sweep = await page.evaluate(`(() => {
    const el = document.querySelector('[data-testid=send-tray-sweep]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return Math.round(r.width * 100) / 100;
  })()`);
  return { ...state, sweepPx: sweep };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const outDir = path.resolve(args.out ?? "/tmp/autosend-pause");
  fs.mkdirSync(outDir, { recursive: true });

  let server;
  let browser;
  try {
    server = await startDevServer({});
    browser = await launch({ width: 640, height: 420 });
    const page = await browser.newPage();
    for (const src of INIT_SCRIPTS) await page.addInitScript(src);
    await page.navigate(`${server.url}/scripts/visual/autosend-pause-harness.html`);
    await page.waitForSelector('[data-testid="probe-readout"]', { timeout: 30000 });

    const shot = async (name) => {
      const buf = await page.screenshot({});
      fs.writeFileSync(path.join(outDir, `${name}.png`), buf);
      // …and the tray on its own, because the fill is what he is being asked to look at and it is a
      // 40px strip of a 420px page.
      const clip = await page.boundingBox("[data-testid=send-mode-tray]");
      if (clip && clip.height > 0) {
        fs.writeFileSync(path.join(outDir, `${name}-tray.png`), await page.screenshot({ clip }));
      }
      return path.join(outDir, `${name}.png`);
    };

    // 1. THE WORDS ARRIVE, then the engine says he stopped talking. The clock starts.
    await page.evaluate("window.__dictate()");
    await sleep(120);
    await page.evaluate("window.__speechEnd()");
    await sleep(60);
    const started = await rail(page);

    // 2. Let it visibly drain — the state he sees just before he reaches for the keyboard.
    await sleep(1200);
    const draining = await rail(page);
    const drainingShot = await shot("1-counting-drains");

    // 3. HE STARTS TYPING, and keeps typing. This is the founder's actual report: not one
    //    keystroke, but a hand on the keyboard for several seconds while the old countdown's
    //    deadline comes and goes underneath it. Pre-change, the message went out mid-word.
    const typed = " and hold the notes";
    const typing = [];
    for (const ch of typed) {
      await page.evaluate(`(() => {
        const ta = document.querySelector('textarea[aria-label="Message"]');
        const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
        set.call(ta, ta.value + ${JSON.stringify(ch)});
        ta.dispatchEvent(new Event("input", { bubbles: true }));
      })()`);
      // LONGER THAN THRESHOLD_EASE_MS (250ms), deliberately. Typing changes the confidence tier,
      // and the tray answers a tier change with a one-shot ease so the fill glides to its new
      // resting width rather than teleporting. Sampling faster than that ease means a sample can
      // land mid-glide and read as movement, which is a working pause reported as a broken one.
      await sleep(320);
      typing.push(await rail(page));
    }
    const typingShot = await shot("2-typing-holds");
    const heldWhileTyping = typing[typing.length - 1];

    // 4. HE STOPS. Past the settle window, the countdown must come back — from a FULL fresh
    //    threshold recomputed against what is in the box now, not from the sliver it froze at.
    await sleep(TYPING_SETTLE_MS + 150);
    const reevaluated = await rail(page);
    const reevaluatedShot = await shot("3-reevaluates-from-full");

    const results = {
      started,
      draining,
      typing: typing.map((t) => t.sweepPx),
      heldWhileTyping,
      reevaluated,
      shots: { draining: drainingShot, typing: typingShot, reevaluated: reevaluatedShot },
    };

    const problems = [];
    if (started.phase !== "counting") problems.push("the countdown never started");
    if (!(draining.sweepPx < started.sweepPx)) problems.push("the fill never drained");

    // THE PAUSE. Ignore the leading samples: typing changes the tier, and the tray answers a tier
    // change with a deliberate one-shot ease (THRESHOLD_EASE_MS) so the fill glides rather than
    // teleports. What must be flat is the TAIL — once that ease has settled, a hand still on the
    // keyboard must leave the fill exactly where it is, sample after sample.
    const tail = results.typing.slice(-5);
    if (tail.some((w) => w === null)) problems.push("the sweep never rendered");
    else if (!tail.every((w) => w === tail[0])) {
      problems.push(`the fill kept moving while typing (${tail.join(" -> ")}px)`);
    }
    // Checked across EVERY sample, not just the last: a send that went out mid-burst and left the
    // box empty would leave a plausible-looking final reading behind it.
    if (typing.some((t) => t.sent !== 0)) problems.push("a message was SENT while he was typing");

    // THE RE-EVALUATION. A literal resume would come back at the width it froze at; a fresh
    // threshold comes back fuller. This is the half the founder asked for by name.
    if (!(reevaluated.sweepPx > heldWhileTyping.sweepPx)) {
      problems.push(
        `the countdown resumed where it stopped instead of re-evaluating ` +
          `(${heldWhileTyping.sweepPx}px -> ${reevaluated.sweepPx}px)`,
      );
    }

    console.log(JSON.stringify(results, null, 2));
    if (problems.length) {
      for (const p of problems) console.error(`FAIL: ${p}`);
      return 1;
    }
    console.log(`\nPASS — the fill drained, HELD under a typing hand, then re-evaluated from full.`);
    for (const p of Object.values(results.shots)) console.log(`  shot: ${p}`);
    return 0;
  } catch (e) {
    console.error(`probe could not run: ${e.message}`);
    return 2;
  } finally {
    try {
      await browser?.close();
    } catch {
      /* already gone */
    }
    try {
      server?.stop();
    } catch {
      /* already gone */
    }
  }
}

// `pathToFileURL`, NOT a `file://${argv[1]}` template. This repo's worktrees live under a path
// containing SPACES ("Application Support"), which `import.meta.url` percent-encodes and a raw
// template does not — so the naive guard compares "…Application%20Support…" against
// "…Application Support…", never matches, and the probe EXITS 0 HAVING RUN NOTHING. An empty log
// and a green exit is the worst shape a verification tool can have.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((c) => process.exit(c));
}
