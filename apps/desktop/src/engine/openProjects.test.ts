import { describe, expect, it } from "vitest";
import {
  bootSelection,
  closedProjectsOf,
  isProjectOpen,
  openProjectsOf,
  seedOpenIds,
  selectionAfterClose,
  withProjectClosed,
  withProjectOpen,
} from "./openProjects";

const P = (...ids: string[]) => ids.map((id) => ({ id }));

describe("the null (never-seeded) open set", () => {
  // This is the upgrade path. Every existing install hydrates with no persisted open set, and the
  // one unacceptable outcome is a blank tab bar for someone who never asked for one.
  it("opens every project", () => {
    expect(openProjectsOf(P("a", "b", "c"), null)).toEqual(P("a", "b", "c"));
    expect(isProjectOpen("a", null)).toBe(true);
    expect(closedProjectsOf(P("a", "b"), null)).toEqual([]);
  });

  it("seeds to the full project list, so the first write closes nothing", () => {
    expect(seedOpenIds(["a", "b", "c"], null)).toEqual(["a", "b", "c"]);
  });

  it("opening one project from null keeps every other tab", () => {
    // The bug this pins: seeding to `[opened]` would make "open a project" silently close the rest.
    expect(withProjectOpen("b", ["a", "b", "c"], null)).toEqual(["a", "b", "c"]);
  });

  it("closing one project from null keeps every other tab", () => {
    expect(withProjectClosed("b", ["a", "b", "c"], null)).toEqual(["a", "c"]);
  });
});

describe("an explicit open set", () => {
  it("renders only its members, in project order (not open-set order)", () => {
    // Tabs must not jump around when a project is closed and reopened, so the strip's order comes
    // from `projects`, never from the order ids landed in the open set.
    expect(openProjectsOf(P("a", "b", "c"), ["c", "a"])).toEqual(P("a", "c"));
  });

  it("names the rest as closed — the reopen list", () => {
    expect(closedProjectsOf(P("a", "b", "c"), ["a"])).toEqual(P("b", "c"));
  });

  it("ignores ids for projects that no longer exist", () => {
    // A deleted project leaves its id behind in the persisted set; it must not conjure a tab.
    expect(openProjectsOf(P("a"), ["a", "gone"])).toEqual(P("a"));
    expect(closedProjectsOf(P("a"), ["a", "gone"])).toEqual([]);
  });

  it("distinguishes the empty set from null — [] is a decision, null is its absence", () => {
    expect(openProjectsOf(P("a", "b"), [])).toEqual([]);
    expect(openProjectsOf(P("a", "b"), null)).toEqual(P("a", "b"));
    expect(isProjectOpen("a", [])).toBe(false);
  });

  it("open and close are both idempotent", () => {
    expect(withProjectOpen("a", ["a", "b"], ["a"])).toEqual(["a"]);
    expect(withProjectClosed("z", ["a", "b"], ["a"])).toEqual(["a"]);
  });

  it("reopening appends rather than reordering the tabs already there", () => {
    expect(withProjectOpen("c", ["a", "b", "c"], ["b", "a"])).toEqual(["b", "a", "c"]);
  });

  it("never returns the live array, so a caller can't mutate persisted state", () => {
    const open = ["a", "b"];
    expect(withProjectOpen("a", ["a", "b"], open)).not.toBe(open);
    expect(seedOpenIds(["a", "b"], open)).not.toBe(open);
  });
});

describe("selectionAfterClose", () => {
  it("closing an unselected tab leaves the selection alone", () => {
    expect(selectionAfterClose(["a", "b", "c"], "c", "a")).toBe("a");
  });

  it("closing the selected tab takes the one to its RIGHT", () => {
    expect(selectionAfterClose(["a", "b", "c"], "b", "b")).toBe("c");
  });

  it("closing the selected LAST tab falls back to the one on its left", () => {
    expect(selectionAfterClose(["a", "b", "c"], "c", "c")).toBe("b");
  });

  it("closing the selected FIRST tab takes its right neighbour", () => {
    expect(selectionAfterClose(["a", "b"], "a", "a")).toBe("b");
  });

  it("closing the only tab selects nothing — the app falls to its welcome state", () => {
    expect(selectionAfterClose(["a"], "a", "a")).toBeNull();
  });

  it("repairs a dangling selection instead of leaving the shell pointed at no tab", () => {
    // A stale persisted id, or a project closed in another webview: the closed tab isn't the
    // selected one, but the selected one isn't on screen either.
    expect(selectionAfterClose(["a", "b"], "b", "ghost")).toBe("a");
    expect(selectionAfterClose(["a", "b"], "b", null)).toBe("a");
  });

  it("returns null when the strip empties out under a dangling selection", () => {
    expect(selectionAfterClose(["a"], "a", "ghost")).toBeNull();
  });

  it("handles a closing id that isn't in the strip at all", () => {
    expect(selectionAfterClose(["a", "b"], "ghost", "ghost")).toBe("a");
  });
});

describe("bootSelection", () => {
  it("keeps a persisted selection that is still open", () => {
    expect(bootSelection(["a", "b"], ["a", "b"], "b")).toBe("b");
  });

  it("refuses to restore a CLOSED project — that would show a project with no tab", () => {
    expect(bootSelection(["a", "b"], ["b"], "a")).toBe("b");
  });

  it("falls back to the first OPEN project, not the first project", () => {
    expect(bootSelection(["a", "b", "c"], ["c"], null)).toBe("c");
  });

  it("selects nothing when every project is closed", () => {
    expect(bootSelection(["a", "b"], [], "a")).toBeNull();
  });

  it("treats a never-seeded set as everything open (upgrade path)", () => {
    expect(bootSelection(["a", "b"], null, null)).toBe("a");
    expect(bootSelection(["a", "b"], null, "b")).toBe("b");
  });
});
