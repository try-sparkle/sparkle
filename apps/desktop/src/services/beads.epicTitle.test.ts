// The epic card's three DISPLAY-SIDE helpers: the redundant-"epic" title scrub, the open-child
// count behind "Contains N tasks", and the child→parent lookup behind "Part of Epic: …".
//
// All three are pure and none of them writes to the bd store — the founder ruled a bulk title
// rewrite out explicitly (`.beads/` is a shared embedded Dolt DB with no diff and no revert), so
// the scrub is a render-time transform and this file is where that promise is pinned.
import { describe, it, expect } from "vitest";
import {
  epicDisplayTitle,
  openChildCount,
  parentEpicOf,
  type Bead,
} from "./beads";

const bead = (over: Partial<Bead> & Pick<Bead, "id">): Bead => ({
  title: over.id,
  description: "",
  status: "open",
  labels: [],
  commentCount: 0,
  ...over,
});

describe("epicDisplayTitle — strips a TRAILING epic marker only", () => {
  // The founder's own live example.
  it("strips a trailing (epic)", () => {
    expect(epicDisplayTitle("Concierge full control surface (epic)")).toBe(
      "Concierge full control surface",
    );
  });

  it("strips a trailing bare word 'epic'", () => {
    expect(epicDisplayTitle("Sparkle mobile epic")).toBe("Sparkle mobile");
  });

  it.each(["(EPIC)", "(Epic)", "(epic)"])("is case-insensitive: %s", (marker) => {
    expect(epicDisplayTitle(`Ship the thing ${marker}`)).toBe("Ship the thing");
  });

  it("tolerates whitespace inside and after the marker", () => {
    expect(epicDisplayTitle("Ship the thing ( epic )   ")).toBe("Ship the thing");
  });

  // ── THE CASE THE FOUNDER NAMED, and the reason the pattern is anchored ──────────────────────
  // A naive `replace(/epic/i, "")` turns this into "membership guard". This assertion is the whole
  // justification for the `$` anchor; it FAILS against the naive implementation, which is what
  // makes it worth having.
  it("does NOT touch 'epic' at the START of a title", () => {
    expect(epicDisplayTitle("Epic membership guard")).toBe("Epic membership guard");
  });

  it("does NOT touch 'epic' in the MIDDLE of a title", () => {
    expect(epicDisplayTitle("Refactor the epic loader")).toBe("Refactor the epic loader");
  });

  it("does NOT strip a trailing 'epics' — the bare-word arm must end the string", () => {
    expect(epicDisplayTitle("Board shows epics")).toBe("Board shows epics");
  });

  it("does NOT strip a word merely ENDING in epic", () => {
    expect(epicDisplayTitle("Diagnose the subepic")).toBe("Diagnose the subepic");
  });

  // Blanking a card's title is strictly worse than leaving it redundant.
  it.each(["epic", "(epic)", "  (epic)  "])("never blanks a title that is only the marker: %j", (t) => {
    expect(epicDisplayTitle(t).length).toBeGreaterThan(0);
  });
});

describe("openChildCount — remaining work, not total work", () => {
  const beads: Bead[] = [
    bead({ id: "e1", type: "epic" }),
    bead({ id: "e1.a", parent: "e1", status: "open" }),
    bead({ id: "e1.b", parent: "e1", status: "in_progress" }),
    bead({ id: "e1.c", parent: "e1", status: "closed" }),
    bead({ id: "other", status: "open" }),
  ];

  // The assertion that has power: it must EXCLUDE the closed child and INCLUDE the in-flight one.
  // A count that simply returned childrenOf().length would be 3 and is what this rules out.
  it("counts open + in_progress children, never closed ones", () => {
    expect(openChildCount(beads, "e1")).toBe(2);
  });

  it("is 0 for an epic whose children have all closed", () => {
    const done = beads.map((b) => (b.id.startsWith("e1.") ? { ...b, status: "closed" as const } : b));
    expect(openChildCount(done, "e1")).toBe(0);
  });

  it("is 0 for a bead with no children at all", () => {
    expect(openChildCount(beads, "other")).toBe(0);
  });
});

describe("parentEpicOf — the inverse of childrenOf", () => {
  it("resolves an explicit parent field", () => {
    const beads = [bead({ id: "e1", title: "Concierge chat surface", type: "epic" }), bead({ id: "t9", parent: "e1" })];
    expect(parentEpicOf(beads, beads[1]!)?.title).toBe("Concierge chat surface");
  });

  it("resolves a dotted id with no parent field", () => {
    const beads = [bead({ id: "e1", title: "Theme", type: "epic" }), bead({ id: "e1.4" })];
    expect(parentEpicOf(beads, beads[1]!)?.id).toBe("e1");
  });

  // A bead is a child of EVERY prefix of its id; the immediate parent is the one worth naming.
  it("prefers the NEAREST ancestor for a deeply dotted id", () => {
    const beads = [
      bead({ id: "a", type: "epic" }),
      bead({ id: "a.b", type: "epic" }),
      bead({ id: "a.b.c" }),
    ];
    expect(parentEpicOf(beads, beads[2]!)?.id).toBe("a.b");
  });

  // The founder: several real parents are typed feature/bug/task — sparkle-xnjil is a `feature`
  // with 19 children. Keying off issue_type would return null here and the label would never show.
  it("resolves a parent that HAS CHILDREN but is not typed 'epic'", () => {
    const beads = [
      bead({ id: "f1", title: "Social Coding", type: "feature" }),
      bead({ id: "f1.1", parent: "f1" }),
    ];
    expect(parentEpicOf(beads, beads[1]!)?.title).toBe("Social Coding");
  });

  // Orphan tasks are normal, not an error state.
  it("returns null for a task with no parent", () => {
    const beads = [bead({ id: "solo" })];
    expect(parentEpicOf(beads, beads[0]!)).toBeNull();
  });

  it("returns null when the named parent is not in the list", () => {
    const beads = [bead({ id: "t1", parent: "ghost" })];
    expect(parentEpicOf(beads, beads[0]!)).toBeNull();
  });

  it("never returns the bead itself", () => {
    const beads = [bead({ id: "e1", type: "epic", parent: "e1" })];
    expect(parentEpicOf(beads, beads[0]!)).toBeNull();
  });
});
