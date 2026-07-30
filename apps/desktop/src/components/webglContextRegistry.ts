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

// ---------------------------------------------------------------------------
// The one-way "WebGL is not usable here" latch.
//
// Terminal refuses to KEEP a renderer whose canvas it cannot find, because such a renderer can be
// neither watched for context loss nor released. But refusing per-attach is not enough on its own:
// the addon has to be CONSTRUCTED before its canvas can exist, and constructing it allocates a
// webgl2 context we then cannot release (releaseGlContext needs the canvas). attachWebgl re-runs on
// every activation, so a PERSISTENT probe failure — an xterm bump that moves where the canvas is
// created, which is the whole reason the probe can fail — would construct and strand one
// unreleasable context per agent switch, unbounded. The permit cap cannot throttle that, because
// the permit is handed straight back.
//
// So repeated failures latch for the process: every later attach bails before allocating anything.
//
// BUT NOT ON THE FIRST FAILURE. The latch is process-wide and one-way, so a false positive costs the
// entire session's terminal rendering — every pane drops to the DOM renderer — while a missed latch
// costs one stranded context. That asymmetry means the trigger has to distinguish "the xterm build
// puts its canvas somewhere we don't look" from a one-off: a pane that happened to probe while
// detached or before layout. Nothing in the probe itself can tell those apart, so we use evidence:
//
//   · TWO DISTINCT agents failed → systemic. A build-shape mismatch fails for every pane, so the
//     second pane confirms it immediately, and no single pane's bad luck can ever trip it.
//   · THREE failures total → latch regardless of distinctness. This bounds the leak when only one
//     agent is open: without it, a single pane failing forever would strand a context per
//     activation, which is the very leak this exists to stop.
//
// Worst case is 3 stranded contexts (of a measured budget of 16) before WebGL is given up, instead
// of one per agent switch, unbounded.
// THE EVIDENCE UNIT IS A PANE, NOT AN ATTACH. Terminal calls attachWebgl twice for a pane that
// mounts active (once from the mount effect, once from the visibility effect), so counting attaches
// would let ONE unlucky pane spend two evidence points on its first mount and arm the latch on its
// next hide/show — precisely the single-pane false positive the threshold exists to rule out.
// Terminal guarantees at most one note per mounted pane (its own per-instance guard), so these
// counters count panes.
const failedAgents = new Set<string>();
let failureCount = 0;

export function noteWebglCanvasUnfindable(label: string): void {
  failedAgents.add(label);
  failureCount++;
}

// Counter-evidence. A successful probe is DIRECT proof that this xterm build puts its canvas where
// we look — it refutes the systemic hypothesis the latch is testing. Under that hypothesis failures
// are consecutive, so a success in between means the earlier failures were one-offs and must not
// accumulate toward a permanent, session-wide disable. Without this, two unrelated blips hours and
// thousands of successful attaches apart would arm the latch just as readily as two consecutive
// ones, with no way back (resetWebglPermits is test-only).
export function noteWebglCanvasFound(): void {
  failedAgents.clear();
  failureCount = 0;
}

export function isWebglCanvasUnfindable(): boolean {
  return failedAgents.size >= 2 || failureCount >= 3;
}

// Test-only: the registry is module-global state, so suites must start from zero.
export function resetWebglPermits(): void {
  live.clear();
  failedAgents.clear();
  failureCount = 0;
}
