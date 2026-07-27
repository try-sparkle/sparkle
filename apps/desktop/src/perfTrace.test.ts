import { afterEach, describe, expect, it } from "vitest";
import { openTraceKinds, perfCancel, perfEnd, perfStart } from "./perfTrace";

// openTraceKinds attributes a jank stall to whatever interaction was mid-flight when the main thread
// froze. On macOS WKWebView the Long Tasks API is absent, so this is the rAF monitor's only cheap
// attribution. The privacy contract is the point of these tests: it must emit the static `kind`
// labels ONLY — never the trace KEYS (agent ids, filesystem paths), which are user-specific and get
// written to the shared log file.
describe("openTraceKinds", () => {
  // Each test opens named keys; drop them so state can't leak across cases (traces is module-level).
  afterEach(() => {
    for (const k of ["a", "b", "c", "/Users/someone/secret-project", "agent-xyz"]) perfCancel(k);
  });

  it("returns undefined when nothing is in flight", () => {
    expect(openTraceKinds()).toBeUndefined();
  });

  it("lists a single open kind without a count", () => {
    perfStart("a", "spawn");
    expect(openTraceKinds()).toBe("spawn");
  });

  it("collapses multiple traces of the same kind into a ×count", () => {
    perfStart("a", "spawn");
    perfStart("b", "spawn");
    expect(openTraceKinds()).toBe("spawn×2");
  });

  it("joins distinct kinds, counting each", () => {
    perfStart("a", "spawn");
    perfStart("b", "spawn");
    perfStart("c", "switch");
    expect(openTraceKinds()).toBe("spawn×2, switch");
  });

  it("drops a trace once it ends, so the summary reflects only what is still open", () => {
    perfStart("a", "spawn");
    perfStart("b", "switch");
    perfEnd("a");
    expect(openTraceKinds()).toBe("switch");
  });

  it("never leaks the trace key (agent id / path) — only the kind", () => {
    perfStart("/Users/someone/secret-project", "close");
    perfStart("agent-xyz", "spawn");
    const summary = openTraceKinds() ?? "";
    expect(summary).not.toContain("secret-project");
    expect(summary).not.toContain("agent-xyz");
    expect(summary).not.toContain("/Users/");
    expect(summary.split(", ").sort()).toEqual(["close", "spawn"]);
  });
});
