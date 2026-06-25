import { describe, it, expect } from "vitest";
import { resolveOpenTarget, normalizeProjectPath } from "./openTarget";

const basename = (p: string) => p.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || p;
const projects = [
  { id: "p1", rootPath: "/Users/me/Projects/Alpha" },
  { id: "p2", rootPath: "/Users/me/Projects/Beta" },
];

describe("resolveOpenTarget", () => {
  it("reuses an existing project for the same folder", () => {
    expect(resolveOpenTarget("/Users/me/Projects/Alpha", projects, basename)).toEqual({
      kind: "existing",
      id: "p1",
    });
  });

  it("reuses despite a trailing slash or case difference (case-insensitive volume)", () => {
    expect(resolveOpenTarget("/Users/me/Projects/Alpha/", projects, basename)).toEqual({
      kind: "existing",
      id: "p1",
    });
    expect(resolveOpenTarget("/Users/me/Projects/ALPHA", projects, basename)).toEqual({
      kind: "existing",
      id: "p1",
    });
  });

  it("returns a NEW descriptor (not a created project) for an unknown folder", () => {
    expect(resolveOpenTarget("/Users/me/Projects/Gamma/", projects, basename)).toEqual({
      kind: "new",
      name: "Gamma",
      path: "/Users/me/Projects/Gamma",
    });
  });

  it("normalizeProjectPath drops trailing separators", () => {
    expect(normalizeProjectPath("/a/b/")).toBe("/a/b");
    expect(normalizeProjectPath("/a/b")).toBe("/a/b");
  });
});
