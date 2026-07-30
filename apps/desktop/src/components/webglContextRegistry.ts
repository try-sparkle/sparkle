// A process-wide cap on concurrent xterm WebGL renderer contexts.
//
// THE BUG THIS EXISTS FOR: terminal text rendered as garbage glyphs — mojibake in the RIGHT
// positions with the right colors — intermittently, recovering and re-corrupting. That signature
// (layout correct, glyphs wrong) is a renderer drawing from a dead or empty texture atlas, i.e. a
// WebGL context that was taken away underneath it.
//
// THE MEASURED LIMIT (do not replace this with folklore — re-run the script if you doubt it):
//   apps/desktop/scripts/measure-webgl-context-limit.mjs
//   WebKit 26.5   → 16 concurrent webgl2 contexts; creating the 17th evicts context #0.
//   Chromium 149  → 16, identical.
// Two facts from that run matter more than the number:
//   1. The engine evicts the OLDEST context, not the least recently drawn. So the victim of
//      exhaustion is whichever context has been alive longest — and in Sparkle that is very often
//      the terminal the human is actually LOOKING AT, because the visible pane holds its renderer
//      for as long as it stays visible while short-lived contexts churn around it.
//   2. Eviction is SILENT in the same tick: `isContextLost()` flips to true but no
//      `webglcontextlost` event had been dispatched yet. Nothing can be assumed to get a
//      notification in time to prevent one bad frame — which is why the cap has to keep us from
//      ever reaching the limit, rather than relying on reacting to loss.
//
// WHY A REGISTRY WHEN ATTACHMENT IS ALREADY GATED ON VISIBILITY. Terminal.tsx attaches a renderer
// only to a visible pane, which structurally bounds contexts by visible panes rather than by agent
// count (the human runs 60-80 agents deliberately; the renderer must scale to the fleet, not the
// fleet to the renderer). But "visible" is computed by layout code — stages, pairs, portalled
// panes — that several agents change concurrently. A refactor that makes N panes each believe they
// are visible reintroduces exhaustion with no test to catch it. This registry is the invariant that
// does not depend on layout being right: it is a hard ceiling, enforced at the one place a context
// is allocated.
//
// WHY 4. At most two panes are genuinely visible at once (the left and right stage of a pair), so 4
// is 2x the real need and 4x under the measured 16. The remaining headroom is deliberate: contexts
// whose canvases have been dropped but not yet garbage-collected still count against the engine's
// budget (xterm's WebglAddon.dispose() removes the canvas but never calls
// WEBGL_lose_context.loseContext() — see releaseGlContext in terminalWebgl.ts), and the app
// allocates canvases outside xterm. A cap AT the limit still evicts.
export const MAX_WEBGL_CONTEXTS = 4;

// An opaque grant. Identity-keyed rather than id-keyed on purpose: one agent can be mounted in two
// stages at once, and collapsing those into a single slot would undercount live contexts.
export type WebglPermit = { readonly label: string };

const live = new Set<WebglPermit>();

// Claim one of the MAX_WEBGL_CONTEXTS slots. Returns null when the cap is reached — the caller MUST
// treat that as "render without WebGL" (xterm falls back to its DOM renderer, which has no GPU
// context and no texture atlas, so it cannot produce the corrupted-glyph failure at all). Refusing
// to attach is always better than attaching a context that evicts someone else's.
export function acquireWebglPermit(label: string): WebglPermit | null {
  if (live.size >= MAX_WEBGL_CONTEXTS) return null;
  const permit: WebglPermit = { label };
  live.add(permit);
  return permit;
}

// Give the slot back. Idempotent and null-tolerant, because teardown paths run more than once
// (StrictMode double-invoke, an unmount racing a hide).
export function releaseWebglPermit(permit: WebglPermit | null | undefined): void {
  if (permit) live.delete(permit);
}

export function liveWebglPermitCount(): number {
  return live.size;
}

// Test-only: the registry is module-global state, so suites must start from zero.
export function resetWebglPermits(): void {
  live.clear();
}
