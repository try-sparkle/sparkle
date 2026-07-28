// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  setWindowProject,
  clearWindowProject,
  findWindowForProject,
  pruneWindowRegistry,
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

  // getWindowProject / onWindowRegistryChange / the liveness helpers (isWindowOpen,
  // openWindowLabels, allKeys, removeKey) went with the cross-window status channel they served
  // — see the note at the top of windowRegistry.ts (roborev 46897). What remains is the
  // project↔window mapping captureSends routes on, covered above.
});

// `AppBoot` used to WIPE this map on every mount of <App/>. That was harmless while main was the
// only writer; it stopped being harmless when satellites started writing it, because a satellite
// only writes its row on its own mount and a main-window reload doesn't trigger one. The erased row
// made findWindowForProject answer null, so capture-sends and orchestration events for a torn-out
// project fell through to main — which adopted them and navigated onto the re-dock placeholder while
// the satellite was the window actually showing that project.
describe("pruneWindowRegistry", () => {
  it("keeps a live satellite's row and drops a dead one", () => {
    const s = fakeStore();
    setWindowProject("project-1", "p1", s);
    setWindowProject("project-2", "p2", s);
    expect(pruneWindowRegistry(["main", "project-1"], s)).toBe(true);
    expect(findWindowForProject("p1", s)).toBe("project-1");
    expect(findWindowForProject("p2", s)).toBeNull();
  });

  it("reports no change when every row is live, so callers can skip the write", () => {
    const s = fakeStore();
    setWindowProject("project-1", "p1", s);
    expect(pruneWindowRegistry(["main", "project-1"], s)).toBe(false);
  });

  it("clears everything when no window is live — the true cold start", () => {
    const s = fakeStore();
    setWindowProject("project-1", "p1", s);
    expect(pruneWindowRegistry([], s)).toBe(true);
    expect(findWindowForProject("p1", s)).toBeNull();
  });
});
