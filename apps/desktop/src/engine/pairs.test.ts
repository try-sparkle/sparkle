import { describe, expect, it } from "vitest";
import {
  assignToSide,
  pairCountFor,
  pairCountForLayout,
  CONCIERGE_LAYOUTS,
  isConciergeLayout,
  inferConciergeLayout,
  assignmentForLayout,
  geometrySideOf,
  effectiveConciergeLayout,
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

// ── THE CONCIERGE LAYOUT (Settings → Appearance → Layout, epic sparkle-5ua3br) ─────────────────
describe("concierge layout", () => {
  it("only CENTER has two pairs", () => {
    expect(pairCountForLayout("center")).toBe(2);
    expect(pairCountForLayout("left")).toBe(1);
    expect(pairCountForLayout("right")).toBe(1);
  });

  it("recognises exactly the three layouts", () => {
    for (const l of CONCIERGE_LAYOUTS) expect(isConciergeLayout(l)).toBe(true);
    for (const v of ["", "middle", null, undefined, 2, {}]) expect(isConciergeLayout(v)).toBe(false);
    // The founder's order: right, center, left.
    expect(CONCIERGE_LAYOUTS).toEqual(["right", "center", "left"]);
  });

  // THE UPGRADE PATH: a window keeps the shape it already had on the build that adds the picker.
  it("infers CENTER for a window that had a left pair open, LEFT for every other", () => {
    expect(inferConciergeLayout({ p1: "left" })).toBe("center");
    expect(inferConciergeLayout({})).toBe("left");
    expect(inferConciergeLayout(undefined)).toBe("left");
    expect(inferConciergeLayout("garbage")).toBe("left");
    // A non-left entry is not a left pair.
    expect(inferConciergeLayout({ p1: "right" })).toBe("left");
  });

  it("clears left assignments for a one-pair layout and keeps them for CENTER", () => {
    const a = { p1: "left" } as const;
    expect(assignmentForLayout(a, "center")).toBe(a);
    expect(assignmentForLayout(a, "left")).toEqual({});
    expect(assignmentForLayout(a, "right")).toEqual({});
    // Identity on a no-op, so the shell does not re-render and remount panes.
    const empty = {};
    expect(assignmentForLayout(empty, "left")).toBe(empty);
  });

  it("draws the single pair MIRRORED in the concierge-right layout, and nowhere else", () => {
    expect(geometrySideOf("right", "right")).toBe("left");
    expect(geometrySideOf("right", "left")).toBe("right");
    expect(geometrySideOf("right", "center")).toBe("right");
    expect(geometrySideOf("left", "center")).toBe("left");
  });

  // THE MOUNT INVARIANT OUTRANKS THE PREFERENCE — a left-assigned project always has a stage.
  it("forces CENTER while any project is assigned left, and is the identity otherwise", () => {
    expect(effectiveConciergeLayout("left", P("a", "b"), { b: "left" })).toBe("center");
    expect(effectiveConciergeLayout("right", P("a", "b"), { b: "left" })).toBe("center");
    expect(effectiveConciergeLayout("left", P("a"), {})).toBe("left");
    expect(effectiveConciergeLayout("right", P("a"), {})).toBe("right");
    expect(effectiveConciergeLayout("center", P("a"), {})).toBe("center");
    // A stale entry for a project that no longer exists does not force anything.
    expect(effectiveConciergeLayout("right", P("a"), { gone: "left" })).toBe("right");
  });
});
