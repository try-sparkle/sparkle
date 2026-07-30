import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  MAX_WEBGL_CONTEXTS,
  acquireWebglPermit,
  releaseWebglPermit,
  liveWebglPermitCount,
  resetWebglPermits,
  noteWebglCanvasUnfindable,
  noteWebglCanvasFound,
  isWebglCanvasUnfindable,
} from "./webglContextRegistry";

beforeEach(() => resetWebglPermits());

// The registry is the BACKSTOP for WebGL context exhaustion. Terminal.tsx already attaches a
// renderer only to a visible pane, but "visible" is decided by layout code that changes often
// (stages, pairs, portalled panes). If a refactor ever makes N panes believe they are visible at
// once, the registry — not the layout — is what keeps us under the engine's context budget.
describe("webglContextRegistry", () => {
  it("caps concurrent permits at MAX_WEBGL_CONTEXTS and refuses the rest", () => {
    const granted = [];
    for (let i = 0; i < MAX_WEBGL_CONTEXTS + 12; i++) {
      const p = acquireWebglPermit(`agent-${i}`);
      if (p) granted.push(p);
    }
    expect(granted.length).toBe(MAX_WEBGL_CONTEXTS);
    expect(liveWebglPermitCount()).toBe(MAX_WEBGL_CONTEXTS);
  });

  it("returns null (not a throw) when over the cap, so the caller can fall back to the DOM renderer", () => {
    for (let i = 0; i < MAX_WEBGL_CONTEXTS; i++) acquireWebglPermit(`agent-${i}`);
    expect(acquireWebglPermit("one-too-many")).toBeNull();
  });

  it("frees a slot on release, so a hide/show cycle can re-acquire forever without drift", () => {
    // THE LEAK REGRESSION. 100 attach/detach cycles must not consume 100 slots: this is the
    // cumulative-growth shape that exhausted the real engine (103 attaches in one session).
    for (let i = 0; i < 100; i++) {
      const p = acquireWebglPermit(`agent-${i}`);
      expect(p).not.toBeNull();
      releaseWebglPermit(p);
    }
    expect(liveWebglPermitCount()).toBe(0);
  });

  it("counts two permits for the SAME label separately (one agent can be mounted in two stages)", () => {
    // Keyed by permit identity, not by agentId — a Set keyed on the id would collapse the left-
    // stage and right-stage panes of one agent into a single slot and undercount live contexts.
    const a = acquireWebglPermit("agent-x");
    const b = acquireWebglPermit("agent-x");
    expect(liveWebglPermitCount()).toBe(2);
    releaseWebglPermit(a);
    expect(liveWebglPermitCount()).toBe(1);
    releaseWebglPermit(b);
    expect(liveWebglPermitCount()).toBe(0);
  });

  it("ignores a null release and a double release (idempotent teardown)", () => {
    const p = acquireWebglPermit("agent-y");
    releaseWebglPermit(p);
    releaseWebglPermit(p);
    releaseWebglPermit(null);
    expect(liveWebglPermitCount()).toBe(0);
  });

  it("keeps the cap comfortably below the measured WebKit context limit", () => {
    // The measured limit is documented in webglContextRegistry.ts. The cap must leave headroom for
    // contexts the app allocates outside xterm and for the engine's own bookkeeping — a cap AT the
    // limit still evicts.
    expect(MAX_WEBGL_CONTEXTS).toBeGreaterThanOrEqual(2);
    expect(MAX_WEBGL_CONTEXTS).toBeLessThanOrEqual(8);
  });
});

// The latch that gives up on WebGL for the whole process. Its trigger is a deliberate asymmetry:
// firing wrongly costs EVERY pane its renderer for the session; not firing costs one stranded
// context. So one failure is never enough evidence.
describe("the canvas-unfindable latch", () => {
  it("does not arm on a single failure", () => {
    noteWebglCanvasUnfindable("agent-a");
    expect(isWebglCanvasUnfindable()).toBe(false);
  });

  it("arms once TWO DISTINCT agents have failed — that is what makes it systemic", () => {
    noteWebglCanvasUnfindable("agent-a");
    expect(isWebglCanvasUnfindable()).toBe(false);
    noteWebglCanvasUnfindable("agent-b");
    expect(isWebglCanvasUnfindable()).toBe(true);
  });

  it("arms on the THIRD failure of a single agent — bounding the leak when only one is open", () => {
    // Without this clause a lone repeatedly-failing pane would strand a context per activation,
    // which is the exact leak the latch exists to stop.
    noteWebglCanvasUnfindable("solo");
    noteWebglCanvasUnfindable("solo");
    expect(isWebglCanvasUnfindable()).toBe(false);
    noteWebglCanvasUnfindable("solo");
    expect(isWebglCanvasUnfindable()).toBe(true);
  });

  it("a SUCCESSFUL probe clears the CONSECUTIVE tally — two blips far apart do not arm the systemic clause", () => {
    noteWebglCanvasUnfindable("agent-a");
    noteWebglCanvasFound();
    noteWebglCanvasUnfindable("agent-b");
    // Two distinct agents have failed overall, but a working probe sat between them, which refutes
    // the systemic hypothesis. Still disarmed.
    expect(isWebglCanvasUnfindable()).toBe(false);
  });

  it("starts disarmed, and resetWebglPermits disarms it again", () => {
    expect(isWebglCanvasUnfindable()).toBe(false);
    noteWebglCanvasUnfindable("x");
    noteWebglCanvasUnfindable("y");
    expect(isWebglCanvasUnfindable()).toBe(true);
    resetWebglPermits();
    expect(isWebglCanvasUnfindable()).toBe(false);
  });

  // The latch is documented as ONE-WAY, and that has to be a property of the registry rather than of
  // the order the caller happens to do things in. When it was derived from the counters
  // (`failedAgents.size >= 2 || failureCount >= 3`), the very next successful probe cleared them and
  // silently un-armed it — restoring the unbounded per-activation allocation the latch exists to
  // stop. It only looked one-way because Terminal consults it before it can ever report a success.
  it("STAYS armed after a later successful probe — a cleared tally must not un-arm a taken decision", () => {
    noteWebglCanvasUnfindable("agent-a");
    noteWebglCanvasUnfindable("agent-b");
    expect(isWebglCanvasUnfindable()).toBe(true);

    noteWebglCanvasFound();

    expect(isWebglCanvasUnfindable()).toBe(true);
  });

  // The clause that makes the bound REAL. The two clauses above are tuned for a systemic failure,
  // where failures arrive consecutively. But the failure this whole file exists for is the
  // INTERMITTENT one, and intermittent failures interleave with successes by construction — so
  // `noteWebglCanvasFound()` clears the consecutive evidence after every good pane and the first two
  // clauses never fire, while each failure still strands one unreleasable context. A 60-80 pane
  // fleet at even a modest transient failure rate walks straight into the engine's 16-context
  // budget that way. The outstanding-leak tally is the one a single success does not clear.
  it("arms on the OUTSTANDING leak count even when every failure is separated by a success", () => {
    // Alternate fail/success so neither the distinctness nor the consecutive clause can ever fire:
    // after each pair, failedAgents.size === 1 and consecutiveFailures === 1.
    for (let i = 0; i < 7; i++) {
      noteWebglCanvasUnfindable(`agent-${i}`);
      expect(isWebglCanvasUnfindable()).toBe(false);
      noteWebglCanvasFound();
    }

    // Eight stranded contexts is half the measured 16-context budget — we give up on WebGL before
    // the leak can start evicting the terminal the human is looking at.
    noteWebglCanvasUnfindable("agent-7");
    expect(isWebglCanvasUnfindable()).toBe(true);
  });

  // The counterweight to the clause above, and the reason it is an OUTSTANDING count rather than a
  // lifetime one. A stranded context is not immortal — it survives only until the canvas and
  // renderer object graph are GC'd, which does happen over the hours these sessions run. A strictly
  // monotonic tally would conflate "8 leaked right now" with "8 unrelated blips across a 12-hour
  // day, all long since collected", and would therefore fire eventually in ANY long session with a
  // non-zero blip rate — permanently dropping every pane to the DOM renderer while real GPU pressure
  // never exceeded 1. That is the same false positive the first-failure asymmetry rules out, reached
  // by a slower route.
  describe("decay of the outstanding-leak estimate", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-30T00:00:00Z"));
      resetWebglPermits();
    });
    afterEach(() => vi.useRealTimers());

    it("does NOT arm on a slow drip of blips spread across a long session", () => {
      // Twelve failures — well past the ceiling of 8 — but spaced far enough apart that each is
      // presumed collected before the next arrives, so they never accumulate.
      for (let i = 0; i < 12; i++) {
        noteWebglCanvasUnfindable(`agent-${i}`);
        vi.advanceTimersByTime(10 * 60_000);
        noteWebglCanvasFound();
        expect(isWebglCanvasUnfindable()).toBe(false);
      }
    });

    // Decay must not become a loophole. A real systemic failure produces its failures back to back,
    // in seconds — far inside one decay interval — so the ceiling still fires. This pins that side.
    it("still arms when failures arrive faster than they are presumed reclaimed", () => {
      for (let i = 0; i < 7; i++) {
        noteWebglCanvasUnfindable(`agent-${i}`);
        vi.advanceTimersByTime(2_000);
        noteWebglCanvasFound();
        expect(isWebglCanvasUnfindable()).toBe(false);
      }
      noteWebglCanvasUnfindable("agent-7");
      expect(isWebglCanvasUnfindable()).toBe(true);
    });

    // The decay must be keyed to TIME, not to successful attaches. A working pane re-attaches on
    // every hide/show, so successes accrue at the rate the human switches agents, while leaks accrue
    // once per distinct pane. An attach-counting decay would therefore let a human driving the fleet
    // briskly draw the estimate down as fast as it accrued — the ceiling would never fire and
    // stranded contexts would sail past 8 to the engine's 16, which is the original bug.
    it("is NOT drawn down by a flood of successful attaches at the same instant", () => {
      // A success after each failure keeps the distinctness and consecutive clauses cleared, so the
      // ceiling is the only clause under test.
      for (let i = 0; i < 7; i++) {
        noteWebglCanvasUnfindable(`agent-${i}`);
        noteWebglCanvasFound();
      }
      expect(isWebglCanvasUnfindable()).toBe(false);

      // Thousands more hide/show cycles, no time passing. Nothing has been reclaimed.
      for (let s = 0; s < 5000; s++) noteWebglCanvasFound();

      noteWebglCanvasUnfindable("agent-7");
      expect(isWebglCanvasUnfindable()).toBe(true);
    });

    // An idle session decays too — a fleet nobody is touching is the case where reclamation is most
    // likely, and keying decay to attaches would freeze the estimate there forever.
    it("decays across an idle gap, charged on the next note rather than by a timer", () => {
      for (let i = 0; i < 7; i++) {
        noteWebglCanvasUnfindable(`agent-${i}`);
        noteWebglCanvasFound();
      }
      expect(isWebglCanvasUnfindable()).toBe(false);

      // Nobody touches the app for an hour: 12 intervals, more than enough to clear all 7.
      vi.advanceTimersByTime(60 * 60_000);

      // Back from zero, so this is the first leak again — nowhere near the ceiling.
      noteWebglCanvasUnfindable("agent-7");
      expect(isWebglCanvasUnfindable()).toBe(false);
    });
  });
});
