import { describe, it, expect } from "vitest";
import {
  setWindowProject,
  clearWindowProject,
  findWindowForProject,
} from "./windowRegistry";

function fakeStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
}

describe("windowRegistry", () => {
  it("records and finds the window showing a project", () => {
    const s = fakeStore();
    setWindowProject("main", "p1", s);
    setWindowProject("project-p2", "p2", s);
    expect(findWindowForProject("p1", s)).toBe("main");
    expect(findWindowForProject("p2", s)).toBe("project-p2");
    expect(findWindowForProject("nope", s)).toBeNull();
  });

  it("clearing a label removes its mapping", () => {
    const s = fakeStore();
    setWindowProject("project-p2", "p2", s);
    clearWindowProject("project-p2", s);
    expect(findWindowForProject("p2", s)).toBeNull();
  });

  it("re-pointing a label to a new project replaces the old mapping", () => {
    const s = fakeStore();
    setWindowProject("main", "p1", s);
    setWindowProject("main", "p3", s);
    expect(findWindowForProject("p1", s)).toBeNull();
    expect(findWindowForProject("p3", s)).toBe("main");
  });

  it("treats a corrupt blob as empty", () => {
    const s = fakeStore();
    s.setItem("sparkle-window-projects", "{not json");
    expect(findWindowForProject("p1", s)).toBeNull();
    setWindowProject("main", "p1", s); // must not throw
    expect(findWindowForProject("p1", s)).toBe("main");
  });
});
