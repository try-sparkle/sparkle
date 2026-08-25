// The candidate-epic SCORER — what the epic-decision refusal shows so the answer can be informed.
//
// `services/beads` is NOT mocked here: `isEpic` and `childrenOf` are the one epic resolver, and the
// whole question this module answers ("which of these rows are epics, and how populated are they")
// is theirs. Stubbing them would leave the composition asserted against a fake.
import { describe, it, expect } from "vitest";
import type { Bead } from "../beads";
import {
  candidateEpics,
  describeCandidates,
  sizeGuidanceForEpic,
  tokenize,
} from "./epicCandidates";

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

// ── SIZE GUIDANCE RIDING ALONG (bead `sparkle-o05vcs.4`) ──────────────────────────────────────
// Built from the SAME `childrenOf` resolver the counts come from, so these assert the composition
// rather than re-testing `engine/epicSizeGuidance` (whose own boundary table lives beside it).
// A `fat` epic is one child short of the band's top, so filing into it is the click that takes it
// out of band — the file-time question, which is what this module is answering.
const FAT_STORE: Bead[] = [
  bead("", { title: "Board column rendering" }),
  ...Array.from({ length: 8 }, (_, i) =>
    bead(`.${i + 1}`, { title: `Board chore ${i + 1}`, parent: "" }),
  ),
];

describe("size guidance at file time", () => {
  it("stays silent for an epic that is still inside the band once this item lands", () => {
    // STORE's `sparkle-board` has two children; filing a third lands it at the bottom of the band.
    const top = candidateEpics(STORE, { title: "Board column drag" })[0]!;
    expect(top.totalChildren).toBe(2);
    expect(top.sizeIfFiledHere.childCount).toBe(3);
    expect(top.sizeIfFiledHere.band).toBe("healthy");
    expect(top.sizeIfFiledHere.shouldSuggestSplit).toBe(false);
    expect(top.sizeIfFiledHere.message).toBe("");
  });

  it("suggests a split once this item would take the epic past the band", () => {
    const top = candidateEpics(FAT_STORE, { title: "Board column drag" })[0]!;
    expect(top.id).toBe("");
    expect(top.totalChildren).toBe(8);
    // Assessed on the PROJECTED count, not the current one — 8 is fine to look at, 9 is not.
    expect(top.sizeIfFiledHere.childCount).toBe(9);
    expect(top.sizeIfFiledHere.shouldSuggestSplit).toBe(true);
    expect(top.sizeIfFiledHere.message).toMatch(/splitting/i);
  });
});

describe("describeCandidates surfaces the guidance", () => {
  // The whole reason the guidance lives here: `board.ts` already renders this string at the exact
  // moment the model is choosing an epic, so the advice arrives with no new call site.
  it("attaches the suggestion to the epic it is about", () => {
    const line = describeCandidates(candidateEpics(FAT_STORE, { title: "Board column drag" }));
    expect(line).toContain("");
    expect(line).toContain("8 open / 8 children");
    expect(line).toMatch(/-> .*splitting/i);
  });

  it("adds nothing at all for an epic inside the band", () => {
    const line = describeCandidates(candidateEpics(STORE, { title: "Board column drag" }));
    expect(line).not.toContain("->");
    expect(line).not.toMatch(/split/i);
  });
});

describe("sizeGuidanceForEpic", () => {
  it("returns the one sentence for the epic actually chosen", () => {
    const candidates = candidateEpics(FAT_STORE, { title: "Board column drag" });
    expect(sizeGuidanceForEpic(candidates, "")).toMatch(/splitting/i);
  });

  it("is empty for an epic inside the band, and for one that is not a candidate at all", () => {
    const candidates = candidateEpics(STORE, { title: "Board column drag" });
    expect(sizeGuidanceForEpic(candidates, "sparkle-board")).toBe("");
    expect(sizeGuidanceForEpic(candidates, "sparkle-nowhere")).toBe("");
  });
});
