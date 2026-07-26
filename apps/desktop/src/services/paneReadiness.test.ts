import { beforeEach, describe, expect, it } from "vitest";
import { paneState, resetPaneReadiness, setPaneFailed, setPaneReady, unregisterPane } from "./paneReadiness";

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
