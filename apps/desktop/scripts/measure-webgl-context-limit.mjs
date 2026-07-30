// apps/desktop/scripts/measure-webgl-context-limit.mjs
//
// Measure the REAL number of concurrent WebGL2 contexts this engine allows before it starts
// force-losing the oldest ones. We ship a cap on concurrent xterm WebGL renderers
// (webglContextRegistry.ts); this script is how that cap's number was chosen instead of copying
// the "~16" folklore from a blog post.
//
// WHY WEBKIT. Sparkle's UI runs in a WKWebView, so WebKit is the engine whose limit matters.
// Playwright's `webkit` build is real WebKit (same WebCore/ANGLE path as WKWebView), so it is the
// closest measurable proxy. Chromium is measured too, purely as a cross-check that the harness
// itself works — do NOT pick the cap from the Chromium number.
//
// METHOD. Create canvases one at a time, each with its own webgl2 context, and after every
// creation ask EVERY previously-created context whether it is still alive (`isContextLost()`).
// The engine evicts the OLDEST context when a new one pushes past its budget, so the first
// generation at which an earlier context reports lost is the observed concurrent limit.
//
// We also record `webglcontextlost` events, because an engine can evict a context without
// `isContextLost()` flipping until the next frame.
//
// Usage:  node scripts/measure-webgl-context-limit.mjs [maxContexts]
//   or:   pnpm --filter @sparkle/desktop measure:webgl
//
// Output: a JSON blob on stdout plus a human-readable summary on stderr.

import { webkit, chromium } from "playwright";

const MAX = Number(process.argv[2] || 64);

// Runs INSIDE the page. Returns the generation at which the first eviction was observed.
async function probe(page, max) {
  return page.evaluate((maxContexts) => {
    const contexts = [];
    const lostEvents = [];
    let firstEvictionAt = null;
    let firstEvictionVictim = null;

    for (let i = 0; i < maxContexts; i++) {
      const canvas = document.createElement("canvas");
      // Match xterm's own context request (addon-webgl: antialias/depth off) so we measure the
      // same kind of context the terminal actually allocates, not a cheaper one.
      canvas.width = 256;
      canvas.height = 256;
      document.body.appendChild(canvas);
      const gl = canvas.getContext("webgl2", {
        antialias: false,
        depth: false,
        preserveDrawingBuffer: false,
      });
      if (!gl) {
        // Outright refusal to hand out another context is also a limit — record and stop.
        firstEvictionAt = firstEvictionAt ?? i + 1;
        firstEvictionVictim = "creation-refused";
        break;
      }
      const index = i;
      canvas.addEventListener("webglcontextlost", () => {
        lostEvents.push(index);
      });
      // Actually USE the context. A context that has never drawn may not be counted against the
      // budget by a lazy engine, which would inflate the measured limit.
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      contexts.push({ canvas, gl, index });

      // Has anything created earlier been evicted?
      if (firstEvictionAt === null) {
        for (const c of contexts) {
          if (c.gl.isContextLost()) {
            firstEvictionAt = contexts.length;
            firstEvictionVictim = `context#${c.index}`;
            break;
          }
        }
      }
    }

    const aliveAtEnd = contexts.filter((c) => !c.gl.isContextLost()).length;
    return {
      created: contexts.length,
      aliveAtEnd,
      firstEvictionAt,
      firstEvictionVictim,
      lostEvents: lostEvents.slice(0, 40),
      lostEventCount: lostEvents.length,
    };
  }, max);
}

async function measure(name, browserType, max) {
  let browser;
  try {
    browser = await browserType.launch();
  } catch (e) {
    return { engine: name, error: String(e.message).split("\n")[0] };
  }
  try {
    const page = await browser.newPage();
    await page.setContent("<!doctype html><body></body>");
    const result = await probe(page, max);
    const version = browser.version();
    return { engine: name, version, ...result };
  } finally {
    await browser.close();
  }
}

const results = [];
for (const [name, type] of [
  ["webkit", webkit],
  ["chromium", chromium],
]) {
  const r = await measure(name, type, MAX);
  results.push(r);
  if (r.error) {
    process.stderr.write(`${name}: UNAVAILABLE — ${r.error}\n`);
    continue;
  }
  process.stderr.write(
    `${name} ${r.version}: created=${r.created} aliveAtEnd=${r.aliveAtEnd} ` +
      `firstEviction=${r.firstEvictionAt ?? "none"} (${r.firstEvictionVictim ?? "-"}) ` +
      `contextlostEvents=${r.lostEventCount}\n`,
  );
}

process.stdout.write(`${JSON.stringify({ max: MAX, results }, null, 2)}\n`);
