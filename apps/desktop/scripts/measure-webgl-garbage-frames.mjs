// apps/desktop/scripts/measure-webgl-garbage-frames.mjs
//
// Measures the ONE thing that actually puts mojibake on screen: FRAMES PAINTED THROUGH A DEAD
// CONTEXT. Everything else in this investigation is upstream of that.
//
// WHY A SECOND SCRIPT. measure-webgl-fleet-jank.mjs counts EVICTIONS — how often a context a pane
// was still using got taken away. That is the TRIGGER, not the symptom, and it is why the earlier
// fixes reduced corruption without eliminating it: eviction is bounded by the context cap, but a
// SINGLE eviction still paints garbage for as long as the renderer keeps drawing afterwards. This
// script measures that window and the frames inside it.
//
// THE MECHANISM, in the order it happens:
//   1. The engine needs a context and the budget (measured: 16) is full, so it evicts the OLDEST.
//   2. `isContextLost()` on the victim flips true IN THAT SAME TICK — synchronously.
//   3. `webglcontextlost` is dispatched on a LATER task. This script measures how much later.
//   4. addon-webgl 0.19.0's renderRows has NO isContextLost() check (the string does not appear
//      anywhere in the bundle), so every frame between 2 and 3 runs the full glyph pass against a
//      dead context: right cells, right positions, right colors, WRONG glyphs.
//
// THE GUARDED ARM RUNS THE REAL SHIPPED CODE. That is the point of the esbuild step below: the
// guarded policy is NOT re-implemented inline, it calls `guardWebglDrawPath` from
// src/components/terminalWebgl.ts, bundled into the page. This matters because a harness that
// restates the policy reports 0 by construction — it would keep reporting 0 with the real function
// broken (wrong renderer property, disposer restoring an unguarded renderRows, guard installed too
// late). Here a regression in the shipped function moves the number.
//
// WHAT DRIVES THE RESULT. `switches` and `foreignContexts` are the independent variables — they are
// what creates context pressure. `fleetSize` sizes the pool of panes churning contexts around the
// focused one; it is real (every churn allocation is its own canvas and context) but past the point
// where the budget is already exceeded it stops changing the outcome. Do NOT read a bigger fleet
// number as the cause of a bigger garbage count.
//
// Usage:  node scripts/measure-webgl-garbage-frames.mjs [fleetSize] [switches] [foreignContexts]
//   or:   pnpm --filter @sparkle/desktop measure:webgl-garbage

import { webkit, chromium } from "playwright";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FLEET = Number(process.argv[2] || 66);
const SWITCHES = Number(process.argv[3] || 120);
// Must match MAX_WEBGL_CONTEXTS in src/components/webglContextRegistry.ts.
const CAP = 4;
// Frames the compositor would ask for between agent switches. The window is measured in frames, not
// seconds, because frames are what the user actually sees.
const FRAMES_PER_SWITCH = 6;
// Contexts held by the REST of the app — canvases outside xterm, and contexts whose canvases were
// dropped but not yet garbage-collected. This is the number that makes the cap insufficient: the
// registry bounds OUR share at CAP, but the engine's budget is process-wide, so CAP + FOREIGN past
// that budget means the engine evicts one of our live panes no matter how well we behave.
const FOREIGN = Number(process.argv[4] ?? 13);

// Bundle the REAL guard so the guarded arm measures shipped code rather than a restatement of it.
async function bundleGuard() {
  const out = await build({
    entryPoints: [path.join(HERE, "..", "src", "components", "terminalWebgl.ts")],
    bundle: true,
    format: "iife",
    globalName: "SparkleWebgl",
    write: false,
    platform: "browser",
    logLevel: "silent",
  });
  return out.outputFiles[0].text;
}

async function runPolicy(page, { policy, fleet, switches, cap, framesPerSwitch, foreign }) {
  return page.evaluate(
    async ({ policy, fleet, switches, cap, framesPerSwitch, foreign }) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const guardWebglDrawPath = window.SparkleWebgl?.guardWebglDrawPath;
      if (policy === "guarded" && typeof guardWebglDrawPath !== "function") {
        throw new Error("guardWebglDrawPath was not bundled into the page");
      }

      let garbageFrames = 0; // the inner draw ran while the context was already lost
      let cleanFrames = 0;
      let suppressedFrames = 0; // frames the guard refused to paint
      let evictions = 0;
      let guardToreDown = 0;
      const eventLatencies = []; // ms from isContextLost()==true to webglcontextlost dispatch

      // THE SHAPE THAT ACTUALLY BITES. The engine evicts the OLDEST context, and in Sparkle the
      // oldest is very often the terminal the human is LOOKING AT: the focused pane holds its
      // renderer for as long as it stays visible while short-lived contexts churn around it.
      const focused = { canvas: null, gl: null, lostEventSeen: false, lostAtMs: 0 };
      focused.canvas = document.createElement("canvas");
      focused.canvas.width = 600;
      focused.canvas.height = 320;
      document.body.appendChild(focused.canvas);
      focused.gl = focused.canvas.getContext("webgl2");
      if (!focused.gl) throw new Error("no webgl2 for the focused pane");
      focused.canvas.addEventListener("webglcontextlost", () => {
        focused.lostEventSeen = true;
        if (focused.lostAtMs) eventLatencies.push(performance.now() - focused.lostAtMs);
      });

      // The INNER draw — what xterm's renderRows does. Counting calls to THIS is how we tell
      // "painted a garbage frame" from "painted nothing".
      function innerRenderRows() {
        const lost = focused.gl.isContextLost();
        try {
          const tex = focused.gl.createTexture();
          focused.gl.bindTexture(focused.gl.TEXTURE_2D, tex);
          focused.gl.texImage2D(
            focused.gl.TEXTURE_2D,
            0,
            focused.gl.RGBA,
            1,
            1,
            0,
            focused.gl.RGBA,
            focused.gl.UNSIGNED_BYTE,
            new Uint8Array([255, 255, 255, 255]),
          );
          focused.gl.clear(focused.gl.COLOR_BUFFER_BIT);
        } catch {
          /* a draw that throws is still a frame the user did not get */
        }
        if (lost) garbageFrames++;
        else cleanFrames++;
      }

      // A stand-in for the addon, shaped exactly as the real one: the guard reaches for
      // `_renderer.renderRows`. In the guarded arm the REAL guardWebglDrawPath wraps this.
      const addonStub = { _renderer: { renderRows: innerRenderRows } };
      if (policy === "guarded") {
        guardWebglDrawPath(addonStub, focused.canvas, () => {
          guardToreDown++;
        });
      }

      function drawFrame() {
        if (focused.gl.isContextLost() && !focused.lostAtMs) {
          // First moment the loss is observable. The EVENT has not necessarily arrived — that gap is
          // the whole subject of this measurement.
          focused.lostAtMs = performance.now();
          evictions++;
        }
        const before = garbageFrames + cleanFrames;
        addonStub._renderer.renderRows(0, 23);
        // The inner draw did not run, so the guard suppressed the frame.
        if (garbageFrames + cleanFrames === before) suppressedFrames++;
      }

      // Churn: repeated context allocation around the focused pane, plus the app's own foreign
      // contexts. These push the process past the budget even though OUR share stays under cap.
      const churn = [];
      function allocateChurn(i) {
        const c = document.createElement("canvas");
        c.width = 64;
        c.height = 64;
        document.body.appendChild(c);
        const g = c.getContext("webgl2");
        if (g) churn.push({ c, g, pane: i % fleet });
        while (churn.length > cap + foreign) {
          const v = churn.shift();
          v.g.getExtension("WEBGL_lose_context")?.loseContext();
          v.c.remove();
        }
      }

      for (let s = 0; s < switches; s++) {
        allocateChurn(s);
        for (let f = 0; f < framesPerSwitch; f++) {
          drawFrame();
          await sleep(0);
        }
      }
      await sleep(250); // let any pending webglcontextlost land

      const churnAlive = churn.filter((f) => !f.g.isContextLost()).length;

      // Release EVERYTHING before the next arm. Without this the following policy starts already at
      // or over the engine's budget and its focused context faces higher eviction pressure from
      // frame zero, which would make the arms incomparable and order-dependent.
      focused.gl.getExtension("WEBGL_lose_context")?.loseContext();
      focused.canvas.remove();
      for (const v of churn) {
        v.g.getExtension("WEBGL_lose_context")?.loseContext();
        v.c.remove();
      }
      churn.length = 0;

      return {
        policy,
        garbageFrames,
        cleanFrames,
        suppressedFrames,
        guardToreDown,
        evictions,
        churnAlive,
        focusedSawLostEvent: focused.lostEventSeen,
        medianEventLatencyMs:
          eventLatencies.length === 0
            ? null
            : Number(
                eventLatencies.slice().sort((a, b) => a - b)[
                  Math.floor(eventLatencies.length / 2)
                ]?.toFixed(2),
              ),
        maxEventLatencyMs:
          eventLatencies.length === 0 ? null : Number(Math.max(...eventLatencies).toFixed(2)),
      };
    },
    { policy, fleet, switches, cap, framesPerSwitch, foreign },
  );
}

async function runEngine(name, launcher, guardSource) {
  const browser = await launcher.launch();
  const version = browser.version();
  const policies = [];
  // A FRESH PAGE PER POLICY. Reusing one page leaks the previous arm's contexts into the next, so
  // the second arm would run under higher pressure and swapping the order would change the numbers.
  for (const policy of ["unguarded", "guarded"]) {
    const page = await browser.newPage();
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ content: guardSource });
    policies.push(
      await runPolicy(page, {
        policy,
        fleet: FLEET,
        switches: SWITCHES,
        cap: CAP,
        framesPerSwitch: FRAMES_PER_SWITCH,
        foreign: FOREIGN,
      }),
    );
    await page.close();
  }
  await browser.close();
  return { engine: name, version, policies };
}

const guardSource = await bundleGuard();
const results = [];
for (const [name, launcher] of [
  ["webkit", webkit],
  ["chromium", chromium],
]) {
  try {
    results.push(await runEngine(name, launcher, guardSource));
  } catch (err) {
    results.push({ engine: name, error: String(err?.message ?? err) });
  }
}

for (const r of results) {
  if (r.error) {
    process.stderr.write(`\n${r.engine} — FAILED: ${r.error}\n`);
    continue;
  }
  process.stderr.write(
    `\n${r.engine} ${r.version} — switches=${SWITCHES} foreignContexts=${FOREIGN} cap=${CAP} fleet=${FLEET} frames/switch=${FRAMES_PER_SWITCH}\n`,
  );
  for (const p of r.policies) {
    process.stderr.write(
      `  ${p.policy.toUpperCase().padEnd(9)} garbageFrames=${String(p.garbageFrames).padStart(5)}  ` +
        `suppressed=${String(p.suppressedFrames).padStart(5)}  evictions=${String(p.evictions).padStart(4)}  ` +
        `guardToreDown=${String(p.guardToreDown).padStart(2)}  ` +
        `eventLatency med=${p.medianEventLatencyMs ?? "n/a"}ms max=${p.maxEventLatencyMs ?? "n/a"}ms\n`,
    );
  }
}

process.stdout.write(
  `${JSON.stringify(
    {
      switches: SWITCHES,
      foreignContexts: FOREIGN,
      cap: CAP,
      fleet: FLEET,
      framesPerSwitch: FRAMES_PER_SWITCH,
      results,
    },
    null,
    2,
  )}\n`,
);
