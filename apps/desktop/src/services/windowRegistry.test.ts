// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import {
  setWindowProject,
  clearWindowProject,
  findWindowForProject,
  getWindowProject,
  onWindowRegistryChange,
  resetWindowRegistry,
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

  it("getWindowProject reads back the project a label currently shows", () => {
    const s = fakeStore();
    setWindowProject("main", "p1", s);
    expect(getWindowProject("main", s)).toBe("p1");
    // Unregistered label (closed window) → null, so callers can tell "shows nothing" from "shows X".
    expect(getWindowProject("project-p2", s)).toBeNull();
  });

  it("getWindowProject follows a Replace (label re-pointed to a new project)", () => {
    const s = fakeStore();
    setWindowProject("main", "p1", s);
    setWindowProject("main", "p2", s);
    expect(getWindowProject("main", s)).toBe("p2");
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

  // The roster publisher relies on same-window writes broadcasting a local event (the `storage`
  // event only fires in OTHER windows) so it re-pushes the open set immediately.
  it("notifies same-window subscribers on every mutation, incl. reset", () => {
    const cb = vi.fn();
    const off = onWindowRegistryChange(cb);
    setWindowProject("main", "p1"); // default store = jsdom localStorage
    clearWindowProject("main");
    resetWindowRegistry();
    expect(cb).toHaveBeenCalledTimes(3);
    off();
    setWindowProject("main", "p2");
    expect(cb).toHaveBeenCalledTimes(3); // no calls after unsubscribe
  });
});
