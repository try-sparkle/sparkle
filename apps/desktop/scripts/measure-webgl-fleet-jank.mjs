// apps/desktop/scripts/measure-webgl-fleet-jank.mjs
//
// BEFORE/AFTER measurement for the garbage-glyph bug, at fleet scale (default 66 terminals — the
// live agent count when the bug was reported).
//
// WHAT THIS IS. A headless-WebKit harness that reproduces the renderer's CONTEXT POLICY — not the
// Sparkle UI. It models the two things that actually determine whether a terminal renders garbage:
// how many WebGL contexts are alive at once, and whether a released renderer hands its context back.
// It runs the OLD policy and the NEW policy through the identical agent-switching workload and
// reports, for each: how many times a context that a pane was still USING got evicted underneath it
// (each one is a corrupted-glyph episode), how long the main thread stalled, and how many contexts
// leaked.
//
// WHAT THIS IS NOT. It is not the desktop app at 60 agents. It cannot be — measuring that means
// restarting the human's live fleet. The app-level before numbers come from the session log instead
// (see PRD/sparkle/webgl-context-exhaustion.md). What this harness proves is that the mechanism
// blamed for those numbers is real, and that the fix removes it.
//
//   OLD policy (what shipped): one context per pane, and release == remove the canvas from the DOM.
//     That is xterm's actual dispose() — @xterm/addon-webgl 0.19.0 never calls
//     WEBGL_lose_context.loseContext(), so the context survives until GC.
//   NEW policy (this branch): attach only for visible panes, hard-cap concurrent contexts, and
//     release explicitly via loseContext() on every teardown path.
//
// Usage:  node scripts/measure-webgl-fleet-jank.mjs [fleetSize] [switches]
//   or:   pnpm --filter @sparkle/desktop measure:webgl-fleet

import { webkit, chromium } from "playwright";

const FLEET = Number(process.argv[2] || 66);
const SWITCHES = Number(process.argv[3] || 120);
// Must match MAX_WEBGL_CONTEXTS in src/components/webglContextRegistry.ts.
const CAP = 4;

async function runPolicy(page, { policy, fleet, switches, cap }) {
  return page.evaluate(
    async ({ policy, fleet, switches, cap }) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

      // One "terminal": a canvas that may or may not currently hold a GL context.
      const panes = Array.from({ length: fleet }, (_, i) => ({
        id: i,
        canvas: null,
        gl: null,
      }));

      let corruptionEpisodes = 0; // a pane still using its context found it evicted
      let contextsCreated = 0;
      let contextsReleased = 0;
      let maxStallMs = 0;
      let totalStallMs = 0;
      const liveOrder = []; // panes holding a context, oldest first

      function attach(pane) {
        if (pane.gl) return;
        if (policy === "new" && liveOrder.length >= cap) return; // refused → DOM renderer
        const canvas = document.createElement("canvas");
        canvas.width = 800;
        canvas.height = 400;
        document.body.appendChild(canvas);
        const gl = canvas.getContext("webgl2", {
          antialias: false,
          depth: false,
          preserveDrawingBuffer: false,
        });
        if (!gl) return;
        contextsCreated++;
        pane.canvas = canvas;
        pane.gl = gl;
        liveOrder.push(pane);
        // Do real GPU work so the context is not free to keep around, the way a glyph atlas is not.
        gl.clearColor(0.05, 0.05, 0.07, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }

      function detach(pane) {
        if (!pane.gl) return;
        const idx = liveOrder.indexOf(pane);
        if (idx >= 0) liveOrder.splice(idx, 1);
        if (policy === "old") {
          // xterm's real dispose(): drop the canvas from the DOM, and NOTHING else. The context
          // stays alive, counting against the engine's budget, until GC decides otherwise.
          pane.canvas.remove();
        } else {
          pane.canvas.remove();
          // The fix: hand the context back deterministically.
          pane.gl.getExtension("WEBGL_lose_context")?.loseContext();
          contextsReleased++;
        }
        pane.canvas = null;
        pane.gl = null;
      }

      // Mount the fleet. OLD attached a renderer for every pane; NEW attaches only for the visible
      // one. This difference IS the fix, so the workload must express it rather than equalize it.
      if (policy === "old") for (const p of panes) attach(p);

      let visible = panes[0];
      attach(visible);

      for (let s = 0; s < switches; s++) {
        const next = panes[(s + 1) % fleet];
        const t0 = performance.now();

        if (policy === "new" && next !== visible) detach(visible);
        attach(next);
        visible = next;

        // Draw a frame on whatever context the visible pane has, like a terminal repaint.
        if (visible.gl && !visible.gl.isContextLost()) {
          visible.gl.clearColor(0.05, 0.05, 0.07, 1);
          visible.gl.clear(visible.gl.COLOR_BUFFER_BIT);
        }

        const stall = performance.now() - t0;
        totalStallMs += stall;
        maxStallMs = Math.max(maxStallMs, stall);

        // THE MEASUREMENT THAT MATTERS. Any pane that believes it owns a context, but whose context
        // the engine has taken away, is rendering from a dead texture atlas right now — correct
        // layout, correct colors, wrong glyphs.
        for (const p of panes) {
          if (p.gl && p.gl.isContextLost()) {
            corruptionEpisodes++;
            // Count each episode once; drop the dead handle so it isn't re-counted every switch.
            p.gl = null;
            p.canvas?.remove();
            p.canvas = null;
            const idx = liveOrder.indexOf(p);
            if (idx >= 0) liveOrder.splice(idx, 1);
          }
        }

        if (s % 20 === 0) await sleep(0); // yield so the engine can process its own eviction work
      }

      const leaked = policy === "old" ? contextsCreated - contextsReleased : 0;
      return {
        policy,
        contextsCreated,
        contextsReleased,
        contextsNeverReleased: leaked,
        concurrentContextsHeldAtEnd: liveOrder.length,
        corruptionEpisodes,
        maxStallMs: Math.round(maxStallMs),
        totalStallMs: Math.round(totalStallMs),
      };
    },
    { policy, fleet, switches, cap },
  );
}

async function measureEngine(name, browserType) {
  let browser;
  try {
    browser = await browserType.launch();
  } catch (e) {
    return { engine: name, error: String(e.message).split("\n")[0] };
  }
  try {
    const out = { engine: name, version: browser.version(), policies: [] };
    for (const policy of ["old", "new"]) {
      // A fresh page per policy: contexts from the previous run must not skew the next.
      const page = await browser.newPage();
      await page.setContent("<!doctype html><body></body>");
      out.policies.push(
        await runPolicy(page, { policy, fleet: FLEET, switches: SWITCHES, cap: CAP }),
      );
      await page.close();
    }
    return out;
  } finally {
    await browser.close();
  }
}

const results = [];
for (const [name, type] of [
  ["webkit", webkit],
  ["chromium", chromium],
]) {
  const r = await measureEngine(name, type);
  results.push(r);
  if (r.error) {
    process.stderr.write(`${name}: UNAVAILABLE — ${r.error}\n`);
    continue;
  }
  process.stderr.write(`\n${name} ${r.version} — fleet=${FLEET} switches=${SWITCHES} cap=${CAP}\n`);
  for (const p of r.policies) {
    process.stderr.write(
      `  ${p.policy.toUpperCase().padEnd(4)} corruptionEpisodes=${String(p.corruptionEpisodes).padStart(4)}  ` +
        `contextsCreated=${String(p.contextsCreated).padStart(4)}  ` +
        `neverReleased=${String(p.contextsNeverReleased).padStart(4)}  ` +
        `heldAtEnd=${String(p.concurrentContextsHeldAtEnd).padStart(3)}  ` +
        `stall max=${p.maxStallMs}ms total=${p.totalStallMs}ms\n`,
    );
  }
}

process.stdout.write(`${JSON.stringify({ fleet: FLEET, switches: SWITCHES, cap: CAP, results }, null, 2)}\n`);
