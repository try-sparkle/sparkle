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
// broken.
//
// EXACTLY TWO REGRESSION CLASSES ARE EXERCISED, and the header claims no more than that:
//   · the guard failing to install (e.g. the private `_renderer` property moving under an xterm
//     bump) — the guarded arm then paints garbage like the unguarded one;
//   · the un-wrap refusal regressing — the disposer IS called on the far side of the loss (see
//     drawFrame), so deleting `if (fired) return` in terminalWebgl.ts restores an unguarded
//     renderRows onto a dead context and the remaining frames paint garbage.
// NOT exercised: install TIMING. This harness installs the guard itself before frame zero, so it
// tests its own ordering, not Terminal.tsx's. That the product installs the guard early enough is
// covered by the component tests, not by this script.
//
// WHAT DRIVES THE RESULT. `switches` and `foreignContexts` are the independent variables — they are
// what creates context pressure. There is deliberately no fleet-size knob: an earlier version took
// one, but only the focused pane was ever drawn, so it could not move any output. Rather than leave
// a parameter that reads as meaningful and is not, it is gone.
//
// Usage:  node scripts/measure-webgl-garbage-frames.mjs [switches] [foreignContexts]
//   or:   pnpm --filter @sparkle/desktop measure:webgl-garbage

import { webkit, chromium } from "playwright";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SWITCHES = Number(process.argv[2] || 120);
// Must match MAX_WEBGL_CONTEXTS in src/components/webglContextRegistry.ts.
const CAP = 4;
// Frames the compositor would ask for between agent switches. The window is measured in frames, not
// seconds, because frames are what the user actually sees.
const FRAMES_PER_SWITCH = 6;
// Contexts held by the REST of the app — canvases outside xterm, and contexts whose canvases were
// dropped but not yet garbage-collected. This is the number that makes the cap insufficient: the
// registry bounds OUR share at CAP, but the engine's budget is process-wide, so CAP + FOREIGN past
// that budget means the engine evicts one of our live panes no matter how well we behave.
const FOREIGN = Number(process.argv[3] ?? 13);

// Bundle the REAL guard so the guarded arm measures shipped code rather than a restatement of it.
async function bundleGuard() {
  const out = await build({
    entryPoints: [
      path.join(HERE, "..", "src", "components", "terminalWebgl.ts"),
    ],
    bundle: true,
    format: "iife",
    globalName: "SparkleWebgl",
    write: false,
    platform: "browser",
    logLevel: "silent",
  });
  return out.outputFiles[0].text;
}

async function runPolicy(
  page,
  { policy, switches, cap, framesPerSwitch, foreign },
) {
  return page.evaluate(
    async ({ policy, switches, cap, framesPerSwitch, foreign }) => {
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
      const focused = {
        canvas: null,
        gl: null,
        lostEventSeen: false,
        lostAtMs: 0,
      };
      focused.canvas = document.createElement("canvas");
      focused.canvas.width = 600;
      focused.canvas.height = 320;
      document.body.appendChild(focused.canvas);
      focused.gl = focused.canvas.getContext("webgl2");
      if (!focused.gl) throw new Error("no webgl2 for the focused pane");
      focused.canvas.addEventListener("webglcontextlost", () => {
        focused.lostEventSeen = true;
        if (focused.lostAtMs)
          eventLatencies.push(performance.now() - focused.lostAtMs);
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
      let disposeGuard = null;
      if (policy === "guarded") {
        disposeGuard = guardWebglDrawPath(addonStub, focused.canvas, () => {
          guardToreDown++;
        });
      }

      let frameIndex = 0;
      let lossAtFrame = -1;
      let framesAfterDispose = 0;
      // Whether the disposer actually fired. framesAfterDispose === 0 alone cannot distinguish "ran
      // with nothing left after it" from "never ran at all", and the second is strictly worse — the
      // guard was never un-wrapped, so its teardown is unmeasured too.
      let disposerCalled = false;

      function drawFrame() {
        frameIndex++;
        if (focused.gl.isContextLost() && lossAtFrame < 0) {
          // First moment the loss is observable. The EVENT has not necessarily arrived — that gap is
          // the whole subject of this measurement. Record the FRAME as well as the time: the two
          // arms are only comparable if they lost their context at a similar point in the workload,
          // and without this there is no way to tell a well-matched pair from a mismatched one.
          focused.lostAtMs = performance.now();
          lossAtFrame = frameIndex;
          evictions++;
        }
        const before = garbageFrames + cleanFrames;
        addonStub._renderer.renderRows(0, 23);
        // The inner draw did not run, so the guard suppressed the frame.
        if (garbageFrames + cleanFrames === before) suppressedFrames++;

        // EXERCISE THE DISPOSER, on the far side of the loss. guardWebglDrawPath's un-wrap
        // deliberately REFUSES to restore the original renderRows once a loss has been seen, because
        // restoring an unguarded glyph pass onto a dead context re-opens the very window the guard
        // exists to close. That refusal is load-bearing and was previously unmeasured here: the
        // disposer was created and thrown away, so deleting the `if (fired) return` in
        // terminalWebgl.ts left this harness reporting guarded=0 unchanged. Calling it here means a
        // broken refusal un-wraps the guard and every subsequent frame paints garbage — the number
        // moves.
        if (disposeGuard && lossAtFrame > 0 && frameIndex === lossAtFrame + 1) {
          disposeGuard();
          disposeGuard = null;
          disposerCalled = true;
        }
        if (lossAtFrame > 0 && frameIndex > lossAtFrame + 1)
          framesAfterDispose++;
      }

      // Churn: repeated context allocation around the focused pane, plus the app's own foreign
      // contexts. These push the process past the budget even though OUR share stays under cap.
      const churn = [];
      function allocateChurn() {
        const c = document.createElement("canvas");
        c.width = 64;
        c.height = 64;
        document.body.appendChild(c);
        const g = c.getContext("webgl2");
        if (g) churn.push({ c, g });
        while (churn.length > cap + foreign) {
          const v = churn.shift();
          v.g.getExtension("WEBGL_lose_context")?.loseContext();
          v.c.remove();
        }
      }

      for (let s = 0; s < switches; s++) {
        allocateChurn();
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
        // -1 means the context was never lost. An arm that never evicted measured NOTHING: a
        // guarded arm reporting garbageFrames=0 because no pressure ever arrived looks identical to
        // a guard working perfectly. The reporter below refuses to read the second from the first.
        lossAtFrame,
        totalFrames: frameIndex,
        framesAfterDispose,
        disposerCalled,
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
                eventLatencies
                  .slice()
                  .sort((a, b) => a - b)
                  [Math.floor(eventLatencies.length / 2)]?.toFixed(2),
              ),
        maxEventLatencyMs:
          eventLatencies.length === 0
            ? null
            : Number(Math.max(...eventLatencies).toFixed(2)),
      };
    },
    { policy, switches, cap, framesPerSwitch, foreign },
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
// Both engines in one process allocates a lot of GPU contexts at once and can get the run OOM-killed
// on a loaded machine (observed: exit 137 mid-run, which looks like a measurement result and is not
// one). SPARKLE_ENGINES=chromium runs a single engine so each can be measured on its own.
const ENGINES = [
  ["webkit", webkit],
  ["chromium", chromium],
];
const ONLY = (process.env.SPARKLE_ENGINES ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

// A typo'd filter (`chrome`, `webkit2`, a stray quote) would otherwise select nothing: no engine
// runs, no banner prints, the process exits 0, and stdout still emits a well-formed JSON envelope
// with an empty results array. That reads as a successful measurement to anyone consuming the JSON
// or skimming an exit-0 run — the same "looks like a result and is not" failure this knob exists to
// prevent. Fail loudly instead.
const KNOWN = ENGINES.map(([n]) => n);
const unknown = ONLY.filter((n) => !KNOWN.includes(n));
if (unknown.length > 0) {
  process.stderr.write(
    `SPARKLE_ENGINES: unrecognized engine ${unknown.map((u) => `"${u}"`).join(", ")}. ` +
      `Known engines: ${KNOWN.join(", ")}.\n`,
  );
  process.exit(2);
}

for (const [name, launcher] of ENGINES.filter(
  ([n]) => ONLY.length === 0 || ONLY.includes(n),
)) {
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
    `\n${r.engine} ${r.version} — switches=${SWITCHES} foreignContexts=${FOREIGN} cap=${CAP} frames/switch=${FRAMES_PER_SWITCH}\n`,
  );
  for (const p of r.policies) {
    process.stderr.write(
      `  ${p.policy.toUpperCase().padEnd(9)} garbageFrames=${String(p.garbageFrames).padStart(5)}  ` +
        `suppressed=${String(p.suppressedFrames).padStart(5)}  evictions=${String(p.evictions).padStart(4)}  ` +
        `lossAtFrame=${String(p.lossAtFrame).padStart(4)}/${p.totalFrames}  ` +
        `afterDispose=${(p.policy === "guarded" ? String(p.framesAfterDispose) : "n/a").padStart(4)}  ` +
        `guardToreDown=${String(p.guardToreDown).padStart(2)}  ` +
        `eventLatency med=${p.medianEventLatencyMs ?? "n/a"}ms max=${p.maxEventLatencyMs ?? "n/a"}ms\n`,
    );
  }

  // AN ARM THAT NEVER EVICTED MEASURED NOTHING. A guarded arm reporting garbageFrames=0 because no
  // pressure ever arrived is indistinguishable, at the top line, from a guard working perfectly —
  // and headless WebKit does exactly that. Say so rather than letting the table imply a result.
  const unguarded = r.policies.find((p) => p.policy === "unguarded");
  const guarded = r.policies.find((p) => p.policy === "guarded");
  if (!unguarded?.evictions || !guarded?.evictions) {
    const which = [
      !unguarded?.evictions ? "unguarded" : null,
      !guarded?.evictions ? "guarded" : null,
    ]
      .filter(Boolean)
      .join(" and ");
    process.stderr.write(
      `  !! NO EVICTION in the ${which} arm — this engine never applied enough context pressure.\n` +
        `     These rows are NOT evidence about the guard: zero pressure and a perfect guard both\n` +
        `     read as garbageFrames=0. Raise foreignContexts/switches, or treat this engine as\n` +
        `     unmeasured (see pnpm measure:webgl for its context budget).\n`,
    );
  } else {
    // Both arms evicted, but the comparison is only fair if they lost at a similar point: the
    // pre-loss workload is what determines how many frames each had left to paint.
    const skew = Math.abs(unguarded.lossAtFrame - guarded.lossAtFrame);
    const denom = Math.max(unguarded.lossAtFrame, guarded.lossAtFrame, 1);
    if (skew / denom > 0.1) {
      process.stderr.write(
        `  !  loss frames differ by ${skew} (${((skew / denom) * 100).toFixed(0)}%) — the arms did not\n` +
          `     evict at the same point, so compare each arm's counts against ITS OWN lossAtFrame\n` +
          `     rather than reading garbageFrames and suppressed as a matched pair.\n`,
      );
    }
  }

  // THE UN-WRAP REFUSAL WENT UNEXERCISED. Deliberately its OWN `if`, not another arm of the chain
  // above: this and the skew warning are unrelated diagnostics, and they are positively CORRELATED —
  // a guarded arm with no frames after the disposer evicted at the very end of the workload, which
  // is exactly the shape that produces a large loss-frame skew. Chaining them suppressed the skew
  // warning precisely in the runs where the arms were most badly mismatched, so a reader would take
  // garbageFrames and suppressed as a matched pair when they are not. Both must be able to print.
  //
  // The disposer runs one frame after the loss, so only frames strictly after that can reveal a
  // broken `if (fired) return`. lossAtFrame is engine- and load-dependent (it moved from 718 to 91
  // when the shared page was fixed), so this is a real tail, not a hypothetical.
  if (guarded?.evictions && guarded.framesAfterDispose === 0) {
    // Two DIFFERENT states reach here and the worse one must not be described as the milder one:
    // either the disposer ran and no frames followed, or the loss landed so late that the
    // `frameIndex === lossAtFrame + 1` branch never fired and the guard was never un-wrapped at all
    // — in which case teardown behaviour is unmeasured too, not just the post-dispose window.
    const detail = guarded.disposerCalled
      ? `the disposer ran at frame ${guarded.lossAtFrame + 1} with no frames left after it`
      : `the disposer NEVER RAN (the loss landed past the last frame that could trigger it), so the\n     guard was never un-wrapped and its teardown is unmeasured as well`;
    process.stderr.write(
      `  !! UN-WRAP REFUSAL NOT EXERCISED — the loss landed at frame ${guarded.lossAtFrame} of\n` +
        `     ${guarded.totalFrames}: ${detail}. guarded=0 here does NOT rule out a regressed\n` +
        `     \`if (fired) return\`. Raise switches, or raise foreignContexts, so the eviction happens\n` +
        `     earlier in the run.\n`,
    );
  }
}

process.stdout.write(
  `${JSON.stringify(
    {
      switches: SWITCHES,
      foreignContexts: FOREIGN,
      cap: CAP,
      framesPerSwitch: FRAMES_PER_SWITCH,
      results,
    },
    null,
    2,
  )}\n`,
);
