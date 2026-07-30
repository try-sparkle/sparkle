// apps/desktop/scripts/measure-webgl-garbage-frames.mjs
//
// Measures the ONE thing that actually puts mojibake on the founder's screen: FRAMES PAINTED
// THROUGH A DEAD CONTEXT. Everything else in this investigation is upstream of that.
//
// WHY A SECOND SCRIPT. measure-webgl-fleet-jank.mjs counts EVICTIONS — how often a context a pane
// was still using got taken away. That is the trigger, not the symptom, and it is why the fixes so
// far reduced corruption without eliminating it: eviction is bounded by the context cap, but a
// SINGLE eviction still paints garbage for as long as the renderer keeps drawing afterwards. This
// script measures that interval and the frames inside it.
//
// THE MECHANISM, in the order it happens:
//   1. The engine needs a context and the budget (measured: 16) is full, so it evicts the OLDEST.
//   2. `isContextLost()` on the victim flips to true IN THAT SAME TICK — synchronously.
//   3. `webglcontextlost` is dispatched on a LATER task. This script measures how much later.
//   4. addon-webgl 0.19.0's renderRows has NO isContextLost() check (the string does not appear
//      anywhere in the bundle), so every frame between 2 and 3 runs the full glyph pass against a
//      dead context: right cells, right positions, right colors, WRONG glyphs.
//
// So the two policies compared here are not "cap vs no cap" — both are capped. They are:
//   UNGUARDED — fall back when the `webglcontextlost` EVENT arrives (what shipped before this fix).
//   GUARDED   — check isContextLost() on the way into the draw and paint nothing if it is lost
//               (guardWebglDrawPath in src/components/terminalWebgl.ts).
//
// A garbage frame here is counted the way the renderer would produce one: we attempt a draw, and if
// the context was already lost at that moment, that is a frame the user would have seen corrupted.
//
// Usage:  node scripts/measure-webgl-garbage-frames.mjs [fleetSize] [switches] [foreignContexts]
//   or:   pnpm --filter @sparkle/desktop measure:webgl-garbage

import { webkit, chromium } from "playwright";

const FLEET = Number(process.argv[2] || 66);
const SWITCHES = Number(process.argv[3] || 200);
// Must match MAX_WEBGL_CONTEXTS in src/components/webglContextRegistry.ts.
const CAP = 4;
// Frames the compositor would ask for between agent switches. The window is measured in frames, not
// seconds, because that is what the user actually sees.
const FRAMES_PER_SWITCH = 6;
// Contexts held by the REST of the app — canvases outside xterm, and contexts whose canvases were
// dropped but not yet garbage-collected. This is the number that makes the cap insufficient: the
// registry bounds OUR share at CAP, but the engine's budget (measured: 16) is process-wide, so
// CAP + FOREIGN > 16 means the engine evicts one of our live panes no matter how well we behave.
// Default 13: 13 + 4 = 17, one past the measured budget.
const FOREIGN = Number(process.argv[4] ?? 13);

async function runPolicy(page, { policy, fleet, switches, cap, framesPerSwitch, foreign }) {
  return page.evaluate(
    async ({ policy, fleet, switches, cap, framesPerSwitch, foreign }) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const panes = Array.from({ length: fleet }, (_, i) => ({
        id: i,
        canvas: null,
        gl: null,
        lostEventSeen: false,
        lostAtMs: 0,
      }));

      let garbageFrames = 0; // frames drawn through a context already lost — the actual corruption
      let cleanFrames = 0;
      let suppressedFrames = 0; // frames the guard refused to paint
      let evictions = 0;
      const eventLatencies = []; // ms from isContextLost()==true to webglcontextlost dispatch


      // THE SHAPE THAT ACTUALLY BITES. The engine evicts the OLDEST context, and in Sparkle the
      // oldest is very often the terminal the human is LOOKING AT: the focused pane holds its
      // renderer for as long as it stays visible while short-lived contexts churn around it. So we
      // model exactly that — one long-lived focused pane, drawn every frame, with churn allocating
      // around it until the process budget is exceeded and the focused pane becomes the victim.
      const focused = panes[0];
      {
        const canvas = document.createElement("canvas");
        canvas.width = 600;
        canvas.height = 320;
        document.body.appendChild(canvas);
        const gl = canvas.getContext("webgl2");
        focused.canvas = canvas;
        focused.gl = gl;
        canvas.addEventListener("webglcontextlost", () => {
          focused.lostEventSeen = true;
          if (focused.lostAtMs) eventLatencies.push(performance.now() - focused.lostAtMs);
        });
      }

      // One frame for the focused pane, exactly as renderRows would: touch the atlas texture and
      // draw. On a lost context these calls silently no-op and the texture read returns nothing,
      // which is what puts glyphs from an empty atlas on screen.
      function drawFrame(pane) {
        if (!pane.gl) return;
        const lostNow = pane.gl.isContextLost();
        if (lostNow && !pane.lostAtMs) {
          // First moment we can observe the loss. The EVENT has not necessarily arrived yet — that
          // gap is the whole subject of this measurement.
          pane.lostAtMs = performance.now();
          evictions++;
        }
        if (policy === "guarded" && lostNow) {
          suppressedFrames++;
          return;
        }
        try {
          const tex = pane.gl.createTexture();
          pane.gl.bindTexture(pane.gl.TEXTURE_2D, tex);
          pane.gl.texImage2D(
            pane.gl.TEXTURE_2D,
            0,
            pane.gl.RGBA,
            1,
            1,
            0,
            pane.gl.RGBA,
            pane.gl.UNSIGNED_BYTE,
            new Uint8Array([255, 255, 255, 255]),
          );
          pane.gl.clear(pane.gl.COLOR_BUFFER_BIT);
        } catch {
          /* a draw that throws is still a frame the user did not get */
        }
        if (lostNow) garbageFrames++;
        else cleanFrames++;
      }

      // Churn contexts the registry does not own: other panes' canvases plus the app's own. These
      // are what push the process past the engine's budget even though OUR share stays under CAP.
      const churn = [];
      function allocateChurn() {
        const c = document.createElement("canvas");
        c.width = 64;
        c.height = 64;
        document.body.appendChild(c);
        const g = c.getContext("webgl2");
        if (g) churn.push({ c, g });
        // Keep our OWN share bounded at cap, the way the registry does — dropping the canvas without
        // loseContext() is the pre-fix release, so we release properly here.
        while (churn.length > cap + foreign) {
          const v = churn.shift();
          v.g.getExtension("WEBGL_lose_context")?.loseContext();
          v.c.remove();
        }
      }

      for (let s = 0; s < switches; s++) {
        allocateChurn();
        for (let f = 0; f < framesPerSwitch; f++) {
          drawFrame(focused);
          await sleep(0);
        }
      }
      // Let any still-pending webglcontextlost events land so the latency sample is not truncated.
      await sleep(250);

      const withEvent = panes.filter((p) => p.lostEventSeen).length;
      const foreignAlive = churn.filter((f) => !f.g.isContextLost()).length;
      return {
        policy,
        churnHeld: churn.length,
        churnAlive: foreignAlive,
        garbageFrames,
        cleanFrames,
        suppressedFrames,
        evictions,
        panesThatSawLostEvent: withEvent,
        eventLatencySamples: eventLatencies.length,
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

async function runEngine(name, launcher) {
  const browser = await launcher.launch();
  const page = await browser.newPage();
  await page.setContent("<!doctype html><html><body></body></html>");
  const version = browser.version();
  const policies = [];
  for (const policy of ["unguarded", "guarded"]) {
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
  }
  await browser.close();
  return { engine: name, version, policies };
}

const results = [];
for (const [name, launcher] of [
  ["webkit", webkit],
  ["chromium", chromium],
]) {
  try {
    results.push(await runEngine(name, launcher));
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
    `\n${r.engine} ${r.version} — fleet=${FLEET} switches=${SWITCHES} cap=${CAP} frames/switch=${FRAMES_PER_SWITCH} foreignContexts=${FOREIGN}\n`,
  );
  for (const p of r.policies) {
    process.stderr.write(
      `  ${p.policy.toUpperCase().padEnd(9)} garbageFrames=${String(p.garbageFrames).padStart(5)}  ` +
        `suppressed=${String(p.suppressedFrames).padStart(5)}  evictions=${String(p.evictions).padStart(4)}  ` +
        `eventLatency med=${p.medianEventLatencyMs ?? "n/a"}ms max=${p.maxEventLatencyMs ?? "n/a"}ms\n`,
    );
  }
}

process.stdout.write(
  `${JSON.stringify({ fleet: FLEET, switches: SWITCHES, cap: CAP, framesPerSwitch: FRAMES_PER_SWITCH, foreign: FOREIGN, results }, null, 2)}\n`,
);
