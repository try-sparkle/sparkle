import { beforeEach, describe, expect, it } from "vitest";
import {
  paneGeneration,
  paneState,
  resetPaneReadiness,
  setPaneFailed,
  setPaneReady,
  unregisterPane,
  notePaneRelaunch,
  paneRelaunchCount,
} from "./paneReadiness";

beforeEach(() => resetPaneReadiness());

describe("paneReadiness", () => {
  it("an agent with no pane is 'unmounted'", () => {
    expect(paneState("a1")).toBe("unmounted");
  });

  it("a mounted pane whose PTY hasn't come up is 'starting'", () => {
    setPaneReady("a1", false);
    expect(paneState("a1")).toBe("starting");
  });

  it("a pane that reported ready is 'ready'", () => {
    setPaneReady("a1", false);
    setPaneReady("a1", true);
    expect(paneState("a1")).toBe("ready");
  });

  it("stays 'ready' after the process exits — an exited pane must FAIL sends, not hold them", () => {
    // AgentPane deliberately does not flip ptyReady back on exit: "starting" means "something is
    // coming", and nothing is coming for a process that ended.
    setPaneReady("a1", true);
    expect(paneState("a1")).toBe("ready");
  });

  it("unmounting drops the entry", () => {
    setPaneReady("a1", true);
    unregisterPane("a1");
    expect(paneState("a1")).toBe("unmounted");
  });

  it("keeps panes independent", () => {
    setPaneReady("a1", true);
    setPaneReady("a2", false);
    expect(paneState("a1")).toBe("ready");
    expect(paneState("a2")).toBe("starting");
  });

  it("a given-up pane reads 'failed' — dispatch must refuse, never queue (roborev 46924/47018)", () => {
    setPaneReady("a1", false);
    setPaneFailed("a1");
    expect(paneState("a1")).toBe("failed");
  });

  it("failed is NOT sticky here — the pane owns the rule; a Retry republishes through starting", () => {
    setPaneFailed("a1");
    setPaneReady("a1", false); // Retry re-entered the prepare flow
    expect(paneState("a1")).toBe("starting");
  });

  it("a failed pane that unmounts reads unmounted", () => {
    setPaneFailed("a1");
    unregisterPane("a1");
    expect(paneState("a1")).toBe("unmounted");
  });
});

// ── PUBLICATION COUNTER ─────────────────────────────────────────────────────────────────────────
//
// Exists so a caller can tell "it is ready" from "it became ready SINCE I asked it to restart".
// A restarted agent is usually one that was already ready, so without this the previous launch's
// verdict reads as the new launch's success (roborev 64084).
describe("paneGeneration", () => {
  beforeEach(() => resetPaneReadiness());

  it("starts at zero for a pane nobody has published", () => {
    expect(paneGeneration("x")).toBe(0);
  });

  it("moves on every publication, including one that does not change the state", () => {
    setPaneReady("x", true);
    const afterReady = paneGeneration("x");
    expect(afterReady).toBeGreaterThan(0);
    // Same value republished: the STATE is unchanged but a publication still happened, and that is
    // what a waiter is looking for.
    setPaneReady("x", true);
    expect(paneGeneration("x")).toBeGreaterThan(afterReady);
  });

  it("moves on a failure and on an unmount too", () => {
    setPaneReady("x", true);
    const a = paneGeneration("x");
    setPaneFailed("x");
    const b = paneGeneration("x");
    expect(b).toBeGreaterThan(a);
    unregisterPane("x");
    expect(paneGeneration("x")).toBeGreaterThan(b);
  });

  it("does not rewind on remount, so an in-flight waiter cannot be handed a generation it has seen", () => {
    setPaneReady("x", true);
    unregisterPane("x");
    const afterUnmount = paneGeneration("x");
    setPaneReady("x", false); // remounted
    expect(paneGeneration("x")).toBeGreaterThan(afterUnmount);
  });

  it("counts publications per agent", () => {
    setPaneReady("x", true);
    expect(paneGeneration("y")).toBe(0);
  });
});

// ── RELAUNCH SIGNAL ─────────────────────────────────────────────────────────────────────────────
//
// Separate from the publication counter on purpose. "Did a re-spawn start?" cannot be inferred
// from publications: a local agent re-prepared while already mid-launch publishes nothing though a
// real re-spawn is in flight, and a shell/cloud re-prepare publishes nothing because nothing is
// happening (roborev 64104). Only the pane can say, so it says.
describe("notePaneRelaunch", () => {
  beforeEach(() => resetPaneReadiness());

  it("starts at zero and counts each announced re-spawn", () => {
    expect(paneRelaunchCount("x")).toBe(0);
    notePaneRelaunch("x");
    expect(paneRelaunchCount("x")).toBe(1);
    notePaneRelaunch("x");
    expect(paneRelaunchCount("x")).toBe(2);
  });

  it("is INDEPENDENT of publications — a state change is not a relaunch", () => {
    setPaneReady("x", true);
    setPaneFailed("x");
    unregisterPane("x");
    expect(paneRelaunchCount("x")).toBe(0);
  });

  it("does not move the publication counter — a relaunch is not a state change either", () => {
    const gen = paneGeneration("x");
    notePaneRelaunch("x");
    expect(paneGeneration("x")).toBe(gen);
  });

  it("counts relaunches per agent", () => {
    notePaneRelaunch("x");
    expect(paneRelaunchCount("y")).toBe(0);
  });
});
