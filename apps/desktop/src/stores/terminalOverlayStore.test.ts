// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { useTerminalOverlayStore } from "./terminalOverlayStore";

const s = () => useTerminalOverlayStore.getState();

beforeEach(() => useTerminalOverlayStore.setState({ stages: {}, drafts: {} }));

describe("terminalOverlayStore — stages", () => {
  it("publishes and withdraws an agent's stage node", () => {
    const el = document.createElement("div");
    s().setStage("a1", el);
    expect(s().stages.a1).toBe(el);
    s().setStage("a1", null);
    expect("a1" in s().stages).toBe(false);
  });

  it("keeps agents' stages independent", () => {
    const a = document.createElement("div");
    const b = document.createElement("div");
    s().setStage("a1", a);
    s().setStage("a2", b);
    s().setStage("a1", null);
    expect(s().stages.a2).toBe(b);
  });

  // Re-registering the same node happens on every re-render that re-runs the ref; it must not mint
  // a new `stages` object, or every subscriber would re-render for nothing.
  it("no-ops when the same node is re-registered", () => {
    const el = document.createElement("div");
    s().setStage("a1", el);
    const before = s().stages;
    s().setStage("a1", el);
    expect(s().stages).toBe(before);
  });

  it("no-ops when withdrawing a stage that was never registered", () => {
    const before = s().stages;
    s().setStage("ghost", null);
    expect(s().stages).toBe(before);
  });
});

describe("terminalOverlayStore — drafts", () => {
  it("records and clears whether the user is mid-line", () => {
    s().setDraft("a1", true);
    expect(s().drafts.a1).toBe(true);
    s().setDraft("a1", false);
    expect(s().drafts.a1).toBeUndefined();
  });

  // This is written from the terminal's onData handler — once per KEYSTROKE. The unchanged-value
  // bail is the whole reason that is affordable: typing a word must cost one re-render, not one per
  // character. Without it, every subscriber wakes on every key.
  it("does not mint new state while the answer stays the same", () => {
    s().setDraft("a1", true);
    const afterFirst = s().drafts;
    s().setDraft("a1", true);
    s().setDraft("a1", true);
    expect(s().drafts).toBe(afterFirst);

    s().setDraft("a1", false);
    const afterClear = s().drafts;
    s().setDraft("a1", false);
    expect(s().drafts).toBe(afterClear);
  });

  // A pane torn down mid-compose would otherwise leave the flag true forever, and the pill would
  // stay hidden on the fresh terminal that "Start again" mounts in its place.
  it("clearDraft drops a half-typed line when the terminal goes away", () => {
    s().setDraft("a1", true);
    s().clearDraft("a1");
    expect(s().drafts.a1).toBeUndefined();
  });

  it("clearDraft leaves the stage registration alone", () => {
    const el = document.createElement("div");
    s().setStage("a1", el);
    s().setDraft("a1", true);
    s().clearDraft("a1");
    expect(s().stages.a1).toBe(el);
  });

  it("clearDraft no-ops for an agent with nothing pending", () => {
    const before = s().drafts;
    s().clearDraft("ghost");
    expect(s().drafts).toBe(before);
  });
});
