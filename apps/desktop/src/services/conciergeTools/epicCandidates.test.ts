// The candidate-epic SCORER — what the epic-decision refusal shows so the answer can be informed.
//
// `services/beads` is NOT mocked here: `isEpic` and `childrenOf` are the one epic resolver, and the
// whole question this module answers ("which of these rows are epics, and how populated are they")
// is theirs. Stubbing them would leave the composition asserted against a fake.
import { describe, it, expect } from "vitest";
import type { Bead } from "../beads";
import { candidateEpics, describeCandidates, tokenize } from "./epicCandidates";

function bead(id: string, over: Partial<Bead> = {}): Bead {
  return {
    id,
    title: `title ${id}`,
    description: "",
    status: "open",
    labels: [],
    parent: null,
    commentCount: 0,
    ...over,
  };
}

const STORE: Bead[] = [
  // An epic BY STRUCTURE — two children, no `epic` type anywhere on it.
  bead("sparkle-board", { title: "Board column rendering" }),
  bead("sparkle-board.1", { title: "Column header spacing", parent: "sparkle-board" }),
  bead("sparkle-board.2", { title: "Column drag", parent: "sparkle-board", status: "closed" }),
  // An epic BY TYPE with no children yet — a plan nobody has decomposed.
  bead("sparkle-relay", { title: "Relay reconnect backoff", type: "epic" }),
  // A closed epic. Real, but not somewhere to file new work.
  bead("", { title: "Board column archive", type: "epic", status: "closed" }),
  // A plain task whose title matches beautifully and which is NOT an epic.
  bead("sparkle-loose", { title: "Board column tooltip" }),
];

describe("tokenize", () => {
  it("drops case, punctuation, short words and cross-cutting noise", () => {
    expect(tokenize("Fix the Board's column-drag TASK!")).toEqual(["board", "column", "drag"]);
  });
});

describe("candidateEpics", () => {
  it("offers only epics — never a plain task, however well its title matches", () => {
    const ids = candidateEpics(STORE, { title: "Board column drag target" }).map((c) => c.id);
    expect(ids).toContain("sparkle-board");
    expect(ids).not.toContain("sparkle-loose");
  });

  it("never offers a closed epic", () => {
    const ids = candidateEpics(STORE, { title: "Board column archive" }).map((c) => c.id);
    expect(ids).not.toContain("");
  });

  it("ranks by shared terms, best first", () => {
    const ranked = candidateEpics(STORE, { title: "Board column drag target" });
    expect(ranked[0]!.id).toBe("sparkle-board");
    expect(ranked[0]!.overlap).toEqual(["board", "column"]);
  });

  it("counts the epic's children, open and total, so the choice is answerable in place", () => {
    const top = candidateEpics(STORE, { title: "Board column drag target" })[0]!;
    expect([top.openChildren, top.totalChildren]).toEqual([1, 2]);
  });

  // A terse title is the common case for a concierge-filed task, and dropping body overlap made
  // every one of them score zero against every epic.
  it("scores body overlap too, below title overlap", () => {
    const ranked = candidateEpics(STORE, {
      title: "Wire it up",
      body: "The relay reconnect path needs jittered backoff.",
    });
    expect(ranked[0]!.id).toBe("sparkle-relay");
    expect(ranked[0]!.overlap).toEqual(expect.arrayContaining(["relay", "reconnect"]));
  });

  // A body almost always RESTATES its title, and a term counted once in the title and again in the
  // body inflates the denominator — which silently penalises exactly the well-written items whose
  // body says what the title says. Same terms in, same score out.
  it("does not count a term twice when the body repeats the title", () => {
    const bare = candidateEpics(STORE, { title: "Board column drag" })[0]!;
    const echoed = candidateEpics(STORE, {
      title: "Board column drag",
      body: "Board column drag.",
    })[0]!;
    expect(echoed.score).toBe(bare.score);
  });

  it("returns nothing when nothing overlaps", () => {
    expect(candidateEpics(STORE, { title: "Rotate the signing certificate" })).toEqual([]);
  });

  it("honours the limit", () => {
    expect(candidateEpics(STORE, { title: "Board column relay reconnect" }, 1)).toHaveLength(1);
  });

  it("folds labels into the item's own terms", () => {
    const ranked = candidateEpics(STORE, { title: "Jitter", labels: ["relay", "reconnect"] });
    expect(ranked[0]!.id).toBe("sparkle-relay");
  });
});

describe("describeCandidates", () => {
  it("renders one actionable line per epic", () => {
    const line = describeCandidates(candidateEpics(STORE, { title: "Board column drag" }));
    expect(line).toContain("sparkle-board");
    expect(line).toContain('"Board column rendering"');
    expect(line).toContain("1 open / 2 children");
    expect(line).toContain("shared terms: board, column");
  });

  it("is empty when there is nothing to show, so a caller can branch on it", () => {
    expect(describeCandidates([])).toBe("");
  });
});
