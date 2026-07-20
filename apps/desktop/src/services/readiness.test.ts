import { describe, expect, it } from "vitest";
import { prereqsAllInstalled, readinessComplete } from "./readiness";
import type { PrereqsReport } from "../preflight";

/** Build a report with per-prereq installed flags (paths don't affect the predicate). */
function report(over: Partial<Record<"git" | "node" | "claude", boolean>> = {}): PrereqsReport {
  const f = (installed: boolean) => ({ installed, path: installed ? "/x" : null });
  return {
    git: f(over.git ?? true),
    node: f(over.node ?? true),
    claude: f(over.claude ?? true),
  };
}

describe("readiness predicate", () => {
  it("prereqsAllInstalled is true only when git, node AND claude are all present", () => {
    expect(prereqsAllInstalled(report())).toBe(true);
    expect(prereqsAllInstalled(report({ git: false }))).toBe(false);
    expect(prereqsAllInstalled(report({ node: false }))).toBe(false);
    expect(prereqsAllInstalled(report({ claude: false }))).toBe(false);
  });

  it("readinessComplete: all prereqs present AND signed in → ready (gate stays INVISIBLE)", () => {
    expect(readinessComplete(report(), true)).toBe(true);
  });

  it("readinessComplete: everything installed but NOT signed in → not ready (show checklist)", () => {
    // claude present but `claude login` not done — the login step still needs to run.
    expect(readinessComplete(report(), false)).toBe(false);
  });

  it("readinessComplete: a missing dependency → not ready even if 'signedIn' is passed true", () => {
    // A brand-new Mac typically lacks all three; any one missing must surface the checklist.
    expect(readinessComplete(report({ claude: false }), true)).toBe(false);
    expect(readinessComplete(report({ node: false }), true)).toBe(false);
    expect(readinessComplete(report({ git: false }), true)).toBe(false);
  });
});
