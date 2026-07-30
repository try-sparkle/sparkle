import { describe, it, expect, beforeEach } from "vitest";
import {
  MAX_WEBGL_CONTEXTS,
  acquireWebglPermit,
  releaseWebglPermit,
  liveWebglPermitCount,
  resetWebglPermits,
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
