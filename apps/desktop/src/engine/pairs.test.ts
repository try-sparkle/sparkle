import { describe, expect, it } from "vitest";
import {
  assignToSide,
  otherSide,
  pairCountFor,
  projectsOnSide,
  pruneAssignment,
  resolveSideSelection,
  sideOf,
  type PairAssignment,
} from "./pairs";

const P = (...ids: string[]) => ids.map((id) => ({ id }));

describe("sideOf", () => {
  it("puts an unassigned project on the right", () => {
    // The upgrade path: every existing install has no map and must render exactly the single-pair
    // layout it had.
    expect(sideOf({}, "a")).toBe("right");
  });

  it("reads an explicit left assignment", () => {
    expect(sideOf({ a: "left" }, "a")).toBe("left");
  });
});

describe("projectsOnSide", () => {
  const assignment: PairAssignment = { b: "left", d: "left" };

  it("partitions every project into exactly one side", () => {
    // THE INVARIANT. Not a restatement of the implementation: the two sides must together account
    // for every project and share none, because a project in neither has dead terminals under a
    // live tab, and a project in BOTH puts two xterms on one PTY.
    const projects = P("a", "b", "c", "d");
    const left = projectsOnSide(projects, assignment, "left").map((p) => p.id);
    const right = projectsOnSide(projects, assignment, "right").map((p) => p.id);
    expect([...left, ...right].sort()).toEqual(["a", "b", "c", "d"]);
    expect(left.filter((id) => right.includes(id))).toEqual([]);
  });

  it("keeps the project store's order rather than assignment order", () => {
    // Otherwise tabs jump around whenever one moves sides and back.
    expect(projectsOnSide(P("a", "b", "c", "d"), assignment, "left").map((p) => p.id)).toEqual([
      "b",
      "d",
    ]);
  });
});

describe("pairCountFor", () => {
  it("is 1 when nothing is on the left", () => {
    expect(pairCountFor(P("a", "b"), {})).toBe(1);
  });

  it("is 2 as soon as any project is on the left", () => {
    expect(pairCountFor(P("a", "b"), { b: "left" })).toBe(2);
  });

  it("ignores an assignment naming a project that no longer exists", () => {
    // Derived from the projects actually present, so a stale entry cannot strand an empty left pair
    // on screen with no tab in it and no way to close it.
    expect(pairCountFor(P("a"), { gone: "left" })).toBe(1);
  });
});

describe("assignToSide", () => {
  it("moves a project to the left", () => {
    expect(sideOf(assignToSide({}, "a", "left"), "a")).toBe("left");
  });

  it("moves it back by DELETING the entry, not by writing 'right'", () => {
    // "Absent means right" is what makes the empty map and "no left pair" the same state. Writing
    // an explicit `right` would work but lets the map grow without bound and breaks that identity.
    const back = assignToSide({ a: "left" }, "a", "right");
    expect(back).toEqual({});
    expect(pairCountFor(P("a"), back)).toBe(1);
  });

  it("returns the SAME object when the project is already on that side", () => {
    // Identity, not just equality. zustand's shallow compare uses it, and a new object here would
    // churn the `live` partition and REMOUNT panes that never moved — killing PTYs for a no-op.
    const a: PairAssignment = { a: "left" };
    expect(assignToSide(a, "a", "left")).toBe(a);
    const b: PairAssignment = {};
    expect(assignToSide(b, "a", "right")).toBe(b);
  });

  it("does not mutate the assignment it was given", () => {
    const before: PairAssignment = { a: "left" };
    assignToSide(before, "b", "left");
    expect(before).toEqual({ a: "left" });
  });
});

describe("pruneAssignment", () => {
  it("drops entries for projects that are gone", () => {
    expect(pruneAssignment({ a: "left", gone: "left" }, P("a"))).toEqual({ a: "left" });
  });

  it("returns the SAME object when there is nothing stale", () => {
    const a: PairAssignment = { a: "left" };
    expect(pruneAssignment(a, P("a", "b"))).toBe(a);
  });
});

describe("resolveSideSelection", () => {
  it("keeps a selection that still names a project on this side", () => {
    expect(resolveSideSelection("b", P("a", "b"))).toBe("b");
  });

  it("falls back when the selected project moved to the other side", () => {
    // The failure this prevents: a sidebar rendering a project the OTHER pair is showing, whose
    // agent rows are clickable but whose panes are mounted in the other stage.
    expect(resolveSideSelection("b", P("a", "c"))).toBe("a");
  });

  it("is null when the side holds nothing", () => {
    // A real state — the left pair before anything is sent to it. The caller renders an empty pair
    // for it rather than a wrong one.
    expect(resolveSideSelection("b", [])).toBe(null);
    expect(resolveSideSelection(null, [])).toBe(null);
  });

  it("adopts the first project when nothing was selected yet", () => {
    expect(resolveSideSelection(null, P("a", "b"))).toBe("a");
  });
});

describe("otherSide", () => {
  it("is an involution", () => {
    expect(otherSide("left")).toBe("right");
    expect(otherSide(otherSide("left"))).toBe("left");
  });
});
