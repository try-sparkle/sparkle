// WHICH repos the concierge's PR chip lists: all the open ones, and the SELECTION IS NOT AN INPUT.
//
// This file used to test a precedence rule (`prChipProject`) that picked exactly ONE project — the
// global selection, else the left pair's slot, else the first open project. Every case below that
// still exists is here to prove that rule is gone rather than merely reordered, because the rule's
// failure mode is what the founder hit (bead sparkle-lcx8y): his concierge was scoped to a project
// with no pull requests while all ten of his lived in another, so the one control that would have
// surfaced them listed the wrong repo — and when the precedence resolved to nothing at all, the
// control unmounted entirely.
//
// Tested as the pure function it is — no host mount, no stores.
import { describe, expect, it } from "vitest";
// Imported from its own module rather than through ConciergeHost's re-export, so this suite does not
// pull the whole host in to test one pure mapping.
import { prChipScopes } from "./Concierge/ConciergePrChip";

const P = (id: string, name = id, rootPath: string | null = `/code/${id}`) => ({
  id,
  name,
  rootPath,
});
const [mobile, sparkle, docs] = [P("mobile"), P("sparkle"), P("docs")];
const open = [mobile, sparkle, docs];

describe("prChipScopes", () => {
  it("lists EVERY open project, not one of them", () => {
    // The whole bead in one assertion. Three open tabs used to produce one scope.
    expect(prChipScopes(open).map((s) => s.projectId)).toEqual(["mobile", "sparkle", "docs"]);
  });

  it("preserves tab order, so the menu's sections read like the tab strip", () => {
    expect(prChipScopes([docs, mobile]).map((s) => s.projectId)).toEqual(["docs", "mobile"]);
  });

  it("carries each project's NAME, because the name is the section header the founder asked for", () => {
    const scopes = prChipScopes([P("p1", "sparkle"), P("p2", "drodio-website")]);
    expect(scopes.map((s) => s.projectName)).toEqual(["sparkle", "drodio-website"]);
  });

  it("binds each scope to its OWN rootPath — the repo every merge in that group is addressed to", () => {
    // A row that inherited an ambient rootPath would merge the right NUMBER in the WRONG REPO, and
    // PR numbers collide across repos. The pairing has to survive this mapping intact.
    const scopes = prChipScopes([P("a", "a", "/code/a"), P("b", "b", "/code/b")]);
    expect(scopes).toEqual([
      { projectId: "a", projectName: "a", rootPath: "/code/a", repoKey: null },
      { projectId: "b", projectName: "b", rootPath: "/code/b", repoKey: null },
    ]);
  });

  it("keeps a project with no rootPath as a scope, normalising the absence to null", () => {
    // The tab exists, so it is listed; the menu declines to probe or merge a null path itself.
    expect(prChipScopes([P("p1", "p1", null)])).toEqual([
      { projectId: "p1", projectName: "p1", rootPath: null, repoKey: null },
    ]);
    expect(prChipScopes([{ id: "p2", name: "p2" }])).toEqual([
      { projectId: "p2", projectName: "p2", rootPath: null, repoKey: null },
    ]);
  });

  it("carries the repo key, so two tabs on ONE repository can be folded into one section", () => {
    // The founder had `sparkle` and `sparkle-desktop` open — a checkout and a linked WORKTREE of it,
    // so two tabs over one repository and one set of pull requests. The panel counted them twice
    // (47 across 6 projects; the same 23 PRs under both headings) because this mapping dropped the
    // one field that can tell: `git rev-parse --git-common-dir`, which answers the SAME `.git` from
    // either folder. It cannot be re-derived downstream — a linked worktree's `.git` is a FILE, so
    // no path test and no `is .git a directory` check sees it.
    const scopes = prChipScopes([
      { id: "p1", name: "sparkle", rootPath: "/code/sparkle", repoKey: "/code/sparkle/.git" },
      {
        id: "p2",
        name: "sparkle-desktop",
        rootPath: "/code/sparkle-desktop",
        repoKey: "/code/sparkle/.git",
      },
    ]);
    expect(scopes.map((s) => s.repoKey)).toEqual(["/code/sparkle/.git", "/code/sparkle/.git"]);
  });

  it("normalises an unresolved repo key to null rather than dropping the field", () => {
    // Resolution is a git subprocess that answers a beat after hydrate. `null` is "not yet / not a
    // repo", which the fold reads as "fall back to the path" — the pre-change behaviour, not a
    // wrong one.
    expect(prChipScopes([P("p1")])[0]!.repoKey).toBeNull();
  });

  // The one case that yields nothing: a shell with no project tab at all — the app's "open a project
  // with +" state, where there is no repo in the app to have a pull request in. That is the ONLY
  // remaining route to an absent chip, and it cannot be reached by a selection, a count of zero, or
  // a failed probe. Before this change, all three could.
  it("is empty only when nothing is open", () => {
    expect(prChipScopes([])).toEqual([]);
  });
});
