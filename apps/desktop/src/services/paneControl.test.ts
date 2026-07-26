import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  registerPaneRestart,
  unregisterPaneRestart,
  restartPane,
  registerPaneAccount,
  unregisterPaneAccount,
  paneAccountMap,
  busiestPaneAccount,
  clearPaneRestarts,
} from "./paneControl";

beforeEach(() => clearPaneRestarts());

describe("pane restart registry", () => {
  it("restarts a registered pane", () => {
    const fn = vi.fn();
    registerPaneRestart("x", fn);
    expect(restartPane("x")).toBe(true);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("is a no-op — not an error — for an agent with no mounted pane", () => {
    // A closed agent still gets its pin; it picks up the new account on its next spawn.
    expect(restartPane("gone")).toBe(false);
  });

  it("stops restarting after unregister (unmount)", () => {
    const fn = vi.fn();
    registerPaneRestart("x", fn);
    unregisterPaneRestart("x");
    expect(restartPane("x")).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it("contains a throwing restart rather than propagating it", () => {
    registerPaneRestart("x", () => {
      throw new Error("boom");
    });
    expect(restartPane("x")).toBe(false);
  });
});

describe("pane account registry", () => {
  it("maps live agents to their accounts", () => {
    registerPaneAccount("x", "a");
    registerPaneAccount("y", "b");
    expect(paneAccountMap()).toEqual({ x: "a", y: "b" });
    unregisterPaneAccount("x");
    expect(paneAccountMap()).toEqual({ y: "b" });
  });

  it("busiestPaneAccount picks the account most agents are on", () => {
    registerPaneAccount("x", "a");
    registerPaneAccount("y", "a");
    registerPaneAccount("z", "b");
    expect(busiestPaneAccount()).toBe("a");
  });

  it("busiestPaneAccount is null when nothing is running", () => {
    expect(busiestPaneAccount()).toBeNull();
  });

  it("busiestPaneAccount breaks ties deterministically", () => {
    registerPaneAccount("x", "b");
    registerPaneAccount("y", "a");
    expect(busiestPaneAccount()).toBe("a");
    expect(busiestPaneAccount()).toBe("a"); // stable across calls
  });

  it("a re-spawn onto a new account overwrites the old entry", () => {
    // This is how a completed switch is reflected: the pane re-registers with its new account.
    registerPaneAccount("x", "a");
    registerPaneAccount("x", "b");
    expect(paneAccountMap()).toEqual({ x: "b" });
    expect(busiestPaneAccount()).toBe("b");
  });
});
