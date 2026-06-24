import { describe, it, expect } from "vitest";
// Import the pure predicate straight from the shipped guard script.
import { isInside } from "../../src-tauri/resources/worktree-guard.mjs";

describe("isInside", () => {
  const root = "/wt/proj/agent";
  it("allows the root itself and descendants", () => {
    expect(isInside(root, "/wt/proj/agent")).toBe(true);
    expect(isInside(root, "/wt/proj/agent/src/App.tsx")).toBe(true);
  });
  it("blocks siblings, parents, and ../ escapes", () => {
    expect(isInside(root, "/wt/proj/other/x")).toBe(false);
    expect(isInside(root, "/wt/proj")).toBe(false);
    expect(isInside(root, "/wt/proj/agent/../../escape.ts")).toBe(false);
    expect(isInside(root, "/Users/dev/Projects/myrepo/apps/x.ts")).toBe(false);
  });
});
