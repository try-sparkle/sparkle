import { describe, it, expect } from "vitest";
import {
  projectWindowUrl,
  parseProjectIdFromSearch,
  parseWindowLabelFromSearch,
  parseAgentIdFromSearch,
  parseSuppressSelfFocus,
  computeInitialProjectId,
} from "./projectWindows.url";

describe("projectWindows.url", () => {
  it("builds an index url carrying the project id and opaque label, round-tripping both", () => {
    const url = projectWindowUrl("abc-123", "win-xyz");
    const search = url.slice(url.indexOf("?"));
    expect(parseProjectIdFromSearch(search)).toBe("abc-123");
    expect(parseWindowLabelFromSearch(search)).toBe("win-xyz");
    // No agent param unless one is passed (so existing non-deep-link opens stay clean).
    expect(parseAgentIdFromSearch(search)).toBeNull();
  });

  it("carries an optional deep-link agent id, round-tripping it", () => {
    const url = projectWindowUrl("abc-123", "win-xyz", "agent-7");
    const search = url.slice(url.indexOf("?"));
    expect(parseProjectIdFromSearch(search)).toBe("abc-123");
    expect(parseAgentIdFromSearch(search)).toBe("agent-7");
  });

  it("marks a restored non-active window with ?focus=0 so it won't self-focus", () => {
    const suppressed = projectWindowUrl("abc-123", "win-xyz", undefined, true);
    expect(parseSuppressSelfFocus(suppressed.slice(suppressed.indexOf("?")))).toBe(true);
    // Default (and the focus-target restored window) carry no focus param → self-focus as usual.
    const normal = projectWindowUrl("abc-123", "win-xyz");
    expect(parseSuppressSelfFocus(normal.slice(normal.indexOf("?")))).toBe(false);
  });

  it("parseSuppressSelfFocus is true only for focus=0", () => {
    expect(parseSuppressSelfFocus("?focus=0")).toBe(true);
    expect(parseSuppressSelfFocus("?focus=1")).toBe(false);
    expect(parseSuppressSelfFocus("?project=p")).toBe(false);
  });

  it("parses the agent id, null when absent or empty", () => {
    expect(parseAgentIdFromSearch("?project=p&agent=a1")).toBe("a1");
    expect(parseAgentIdFromSearch("?project=p")).toBeNull();
    expect(parseAgentIdFromSearch("?agent=")).toBeNull();
  });

  it("parses the project id from a search string", () => {
    expect(parseProjectIdFromSearch("?project=abc-123")).toBe("abc-123");
    expect(parseProjectIdFromSearch("?foo=1&project=xy")).toBe("xy");
  });

  it("parses the window label, null when absent (the main window)", () => {
    expect(parseWindowLabelFromSearch("?project=p&label=win-9")).toBe("win-9");
    expect(parseWindowLabelFromSearch("?project=p")).toBeNull();
    expect(parseWindowLabelFromSearch("")).toBeNull();
  });

  it("returns null when no project param is present or empty", () => {
    expect(parseProjectIdFromSearch("")).toBeNull();
    expect(parseProjectIdFromSearch("?foo=1")).toBeNull();
    expect(parseProjectIdFromSearch("?project=")).toBeNull();
  });

  it("computeInitialProjectId: param wins over the restore hint", () => {
    expect(
      computeInitialProjectId("?project=p1", { selectedProjectId: "p2", firstProjectId: "p3" }),
    ).toBe("p1");
  });

  it("computeInitialProjectId: no param falls back to selected, then first, then null", () => {
    expect(computeInitialProjectId("", { selectedProjectId: "p2", firstProjectId: "p3" })).toBe("p2");
    expect(computeInitialProjectId("", { selectedProjectId: null, firstProjectId: "p3" })).toBe("p3");
    expect(computeInitialProjectId("", { selectedProjectId: null, firstProjectId: null })).toBeNull();
  });
});
