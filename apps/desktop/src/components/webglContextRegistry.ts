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
// THE LATCH IS STICKY — once armed it never disarms (outside the test-only reset). It is a real
// boolean set at the moment the threshold is met, NOT a value re-derived from counters: counters can
// be cleared (see noteWebglCanvasFound), and a latch that a later call can silently un-arm would
// restore the unbounded per-activation allocation it exists to stop. Deriving it worked only because
// the caller happens to consult it before probing; that is a property of one call site, not an
// invariant.
//
// BUT NOT ON THE FIRST FAILURE. The latch is process-wide and one-way, so a false positive costs the
// entire session's terminal rendering — every pane drops to the DOM renderer — while a missed latch
// costs one stranded context. That asymmetry means the trigger has to distinguish "the xterm build
// puts its canvas somewhere we don't look" from a one-off: a pane that happened to probe while
// detached or before layout. Nothing in the probe itself can tell those apart, so we use evidence.
//
// THE EVIDENCE UNIT IS A PANE, NOT AN ATTACH. Terminal calls attachWebgl twice for a pane that
// mounts active (once from the mount effect, once from the visibility effect), so counting attaches
// would let ONE unlucky pane spend two evidence points on its first mount and arm the latch on its
// next hide/show — precisely the single-pane false positive the threshold exists to rule out.
// Terminal guarantees at most one note per mounted pane (its own per-instance guard), so these
// counters count panes.
//
// Three clauses, two of them clearable by counter-evidence and one that is not:
//
//   · TWO DISTINCT agents failed, with no success in between → systemic. A build-shape mismatch
//     fails for every pane, so the second pane confirms it immediately, and no single pane's bad
//     luck can trip it.
//   · THREE consecutive failures → latch regardless of distinctness. Bounds the leak when only one
//     agent is open, where the distinctness clause can never fire.
//   · EIGHT failures OUTSTANDING → the leak ceiling. This is the clause that makes the bound real.
//     The failure mode the first two clauses are tuned for is the INTERMITTENT one, and intermittent
//     failures interleave with successes by construction — so a 60-80 pane fleet with a modest
//     transient failure rate would clear the consecutive evidence after every good pane and never
//     latch, while quietly stranding one unreleasable context per failure. Eight is half the measured
//     16-context budget, so we give up on WebGL well before stranded contexts can start evicting the
//     visible terminal.
//
// WHY THE LEAK COUNT DECAYS, AND WHY THAT IS NOT A LOOPHOLE. The count has to approximate contexts
// stranded *concurrently*, not failures observed *ever*. A stranded context is not immortal: the
// header above notes a disposed addon's context survives only until the canvas and renderer object
// graph are garbage collected — lazy and non-deterministic, but it does happen over the hours these
// sessions run. A strictly monotonic tally would conflate "8 contexts leaked right now" with "8
// unrelated blips spread across a 12-hour day, all long since collected", and would therefore fire
// eventually in ANY long-running session with a non-zero blip rate — permanently dropping every pane
// to the DOM renderer while real GPU pressure never exceeded 1. That is precisely the false positive
// the "BUT NOT ON THE FIRST FAILURE" asymmetry exists to prevent, reached by a slower route.
//
// So the count decays with ELAPSED TIME — one presumed-reclaimed context per DECAY_INTERVAL_MS.
//
// THE DECAY UNIT IS WALL-CLOCK, AND IT HAS TO BE. The obvious cheaper design — decay after N clean
// attaches — measures the wrong thing, because the two sides count different units. A FAILURE is
// noted at most once per mounted pane (Terminal's probeFailedRef makes attachWebgl bail forever for
// that instance; that is the "evidence unit is a PANE" guarantee above). A SUCCESS has no such
// guard: a working pane re-attaches on every hide/show, so successes accrue at the rate the human
// switches agents. Decay would then be keyed to agent-switching rate while the leak is keyed to
// distinct panes — and a human driving a 60-80 agent fleet briskly would draw the estimate down as
// fast as it accrued, so the ceiling never fires and stranded contexts sail past 8 to the engine's
// 16, evicting the visible terminal. That is the original bug, re-entered through the decay.
//
// Elapsed time is also simply what the story the decay stands in for depends on: contexts are
// reclaimed when the GC runs, which correlates with time passing, not with how much the human
// clicked. Sampling on any note (success OR failure) means an idle session decays too — a fleet
// nobody is touching is the case where reclamation is most likely, and an attach-counting design
// would freeze the estimate there forever.
//
// Five minutes per context is deliberately conservative against the ~hours GC actually takes: this
// number only has to be short enough that genuinely unrelated one-offs spread across a long session
// do not accumulate, and long enough that a real systemic failure — which produces its failures back
// to back, in seconds — still reaches the ceiling. Decay never disarms an ALREADY-ARMED latch; that
// decision is final.
//
// Worst case is therefore 8 concurrently-stranded contexts of a measured 16, whatever the failure
// pattern — rather than one per agent switch, unbounded.
const LEAK_CEILING = 8;
const DECAY_INTERVAL_MS = 5 * 60_000;

// Cleared by a successful probe: evidence for the "this build hides its canvas" hypothesis.
const failedAgents = new Set<string>();
let consecutiveFailures = 0;
// NOT cleared by success: an estimate of contexts stranded and not yet reclaimed. Only elapsed time
// draws it down. `lastDecayAt` is meaningless while the count is 0 and is (re)stamped when it leaves 0.
let outstandingLeaks = 0;
let lastDecayAt = 0;
let latched = false;

// Retire however many whole intervals have elapsed. Sampled on every note rather than on a timer, so
// the registry owns no scheduling and a session that goes quiet simply decays on its next event.
function applyLeakDecay(nowMs: number): void {
  if (outstandingLeaks === 0) return;
  const steps = Math.floor((nowMs - lastDecayAt) / DECAY_INTERVAL_MS);
  if (steps <= 0) return;
  outstandingLeaks = Math.max(0, outstandingLeaks - steps);
  lastDecayAt = nowMs;
}

export function noteWebglCanvasUnfindable(label: string): void {
  const now = Date.now();
  applyLeakDecay(now);
  failedAgents.add(label);
  consecutiveFailures++;
  // Start the clock when the count leaves zero, so the first leak gets a full interval rather than
  // inheriting an interval that elapsed while nothing was outstanding.
  if (outstandingLeaks === 0) lastDecayAt = now;
  outstandingLeaks++;
  if (failedAgents.size >= 2 || consecutiveFailures >= 3 || outstandingLeaks >= LEAK_CEILING) {
    latched = true;
  }
}

// Counter-evidence. A successful probe is DIRECT proof that this xterm build puts its canvas where
// we look — it refutes the systemic hypothesis, so accumulated one-off failures must not add up to a
// permanent session-wide disable. It clears that hypothesis's evidence outright. It does NOT itself
// draw down the leak estimate — a working probe does not un-strand anything — it merely gives us an
// occasion to charge whatever time has elapsed. An already-armed latch survives both: final.
export function noteWebglCanvasFound(): void {
  applyLeakDecay(Date.now());
  failedAgents.clear();
  consecutiveFailures = 0;
}

export function isWebglCanvasUnfindable(): boolean {
  return latched;
}

// Test-only: the registry is module-global state, so suites must start from zero.
export function resetWebglPermits(): void {
  live.clear();
  failedAgents.clear();
  consecutiveFailures = 0;
  outstandingLeaks = 0;
  lastDecayAt = 0;
  latched = false;
}
