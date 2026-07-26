import { beforeEach, describe, expect, it, vi } from "vitest";
import { markAgentPrompt, registerPromptMarker, resetPromptMarkers } from "./terminalMarkers";

beforeEach(() => resetPromptMarkers());

describe("terminalMarkers", () => {
  it("routes a mark to the registered agent", () => {
    const mark = vi.fn();
    registerPromptMarker("a1", mark);
    expect(markAgentPrompt("a1", "p-1")).toBe(true);
    expect(mark).toHaveBeenCalledWith("p-1");
  });

  it("reports false (and no throw) when nothing is registered for the agent", () => {
    expect(markAgentPrompt("nobody", "p-1")).toBe(false);
  });

  it("unregister removes only THIS provider — a double-mount can't delete the live one", () => {
    const first = vi.fn();
    const second = vi.fn();
    const unregisterFirst = registerPromptMarker("a1", first);
    registerPromptMarker("a1", second); // remount replaces the provider
    unregisterFirst(); // the old mount's cleanup lands late
    expect(markAgentPrompt("a1", "p-1")).toBe(true);
    expect(second).toHaveBeenCalledWith("p-1");
    expect(first).not.toHaveBeenCalled();
  });

  it("keeps agents independent", () => {
    const a = vi.fn();
    const b = vi.fn();
    registerPromptMarker("a1", a);
    registerPromptMarker("a2", b);
    markAgentPrompt("a2", "p-9");
    expect(b).toHaveBeenCalledWith("p-9");
    expect(a).not.toHaveBeenCalled();
  });
});
