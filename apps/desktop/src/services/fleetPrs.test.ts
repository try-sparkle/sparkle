// The fleet scope model — the arithmetic behind the chiclet's count and the menu's grouping.
//
// Every assertion here is about a value the UI DERIVES, not about a precondition it is handed. The
// cases that matter are the ones the single-project menu could not represent at all: PR numbers
// colliding across repos, one repo unreadable while the others are fine, and the difference between
// "zero" and "we could not ask".
import { describe, expect, it } from "vitest";
import {
  buildPrGroups,
  fleetHeadline,
  staleProjectNames,
  fleetTotals,
  fleetUnreachable,
  fleetState,
  unreadableProjectNames,
  keyOfScope,
  prKeyOf,
  scopeKeyOf,
  type PrScope,
} from "./fleetPrs";
import type { PrRow } from "./openPrs";

const sparkle: PrScope = { projectId: "p1", projectName: "sparkle", rootPath: "/code/sparkle" };
const site: PrScope = { projectId: "p2", projectName: "drodio-website", rootPath: "/code/site" };

/** The single group `scopes` produces — non-null by construction, since `buildPrGroups` maps. */
const firstGroup = (...args: Parameters<typeof buildPrGroups>) => buildPrGroups(...args)[0]!;

/** A green (mergeable, passing) PR — `prMergeReadiness` calls this `ready`. */
const green = (number: number, title = `PR ${number}`): PrRow => ({
  number,
  title,
  headRefName: `branch-${number}`,
  url: `https://github.com/o/r/pull/${number}`,
  checks: "passing",
  mergeable: "mergeable",
});

/** A PR git itself would refuse — never `ready`, whatever CI says. */
const conflicting = (number: number): PrRow => ({
  ...green(number),
  mergeable: "conflicting",
});

describe("scope identity", () => {
  it("distinguishes two projects that point at the SAME checkout", () => {
    // Two tabs on one repo are two distinct LEDGER NAMESPACES, and that stays true even though the
    // two now render as one section: `scopeKeyOf` keys the in-flight-merge and arm ledgers, and
    // collapsing it would make one tab's in-flight merge grey out the other. The fold happens a
    // layer up, on repository identity, and deliberately leaves this key alone — see
    // `repoIdentityOf` and the "one repository open under two project entries" block below.
    expect(scopeKeyOf("/code/sparkle", "p1")).not.toBe(scopeKeyOf("/code/sparkle", "p2"));
  });

  it("distinguishes the same project id across two checkouts", () => {
    expect(scopeKeyOf("/code/a", "p1")).not.toBe(scopeKeyOf("/code/b", "p1"));
  });

  it("treats a null rootPath as its own scope rather than colliding with the empty string", () => {
    expect(keyOfScope({ projectId: "p1", projectName: "n", rootPath: null })).toBe(
      scopeKeyOf(null, "p1"),
    );
  });

  it("keeps IDENTICAL PR NUMBERS IN DIFFERENT REPOS apart — the collision this surface must survive", () => {
    // The whole reason the merge ledger is not keyed on the number. Both repos have a #12.
    expect(prKeyOf(keyOfScope(sparkle), 12)).not.toBe(prKeyOf(keyOfScope(site), 12));
  });
});

describe("buildPrGroups", () => {
  it("preserves the caller's order, so sections read like the tab strip", () => {
    const groups = buildPrGroups([site, sparkle], new Map(), new Set());
    expect(groups.map((g) => g.scope.projectName)).toEqual(["drodio-website", "sparkle"]);
  });

  it("reports a scope with NO probe yet as unknown, not as zero", () => {
    const g = firstGroup([sparkle], new Map(), new Set());
    expect(g.known).toBe(false);
    expect(g.prs).toEqual([]);
  });

  it("reports a scope GitHub answered emptily as known-and-zero", () => {
    const g = firstGroup([sparkle], new Map([[keyOfScope(sparkle), []]]), new Set());
    expect(g.known).toBe(true);
    expect(g.prs).toEqual([]);
  });

  it("counts only GREEN PRs as ready", () => {
    const rows = [green(1), conflicting(2), green(3)];
    const g = firstGroup([sparkle], new Map([[keyOfScope(sparkle), rows]]), new Set());
    expect(g.prs).toHaveLength(3);
    expect(g.readyCount).toBe(2);
  });

  it("routes each repo's rows to its OWN group even when the numbers are identical", () => {
    // The failure this prevents is a merge issued against the wrong repo. If grouping mixed rows
    // up, a row rendered under "sparkle" would carry drodio-website's rootPath.
    const byKey = new Map([
      [keyOfScope(sparkle), [green(12, "sparkle twelve")]],
      [keyOfScope(site), [green(12, "site twelve")]],
    ]);
    const [first, second] = buildPrGroups([sparkle, site], byKey, new Set());
    // The ROW must travel with its own repo's rootPath — that pairing is what `runMerge` is handed.
    expect(first?.prs[0]?.title).toBe("sparkle twelve");
    expect(first?.scope.rootPath).toBe("/code/sparkle");
    expect(second?.prs[0]?.title).toBe("site twelve");
    expect(second?.scope.rootPath).toBe("/code/site");
  });

  it("marks only the scope whose probe failed", () => {
    // STALE needs an older list to be out of date; with nothing behind it a failure is UNREADABLE.
    // The two used to be one flag, which is what let a fleet-wide zero be claimed over a repo that
    // had never been read at all (roborev 57714) — see the dedicated describe block below.
    const withRows = new Map([[keyOfScope(site), [green(1)]]]);
    const groups = buildPrGroups([sparkle, site], withRows, new Set([keyOfScope(site)]));
    expect(groups.map((g) => g.failed)).toEqual([false, true]);
    expect(groups.map((g) => g.stale)).toEqual([false, true]);
  });
});

describe("fleetTotals", () => {
  it("sums across projects — the count the chiclet shows is the FLEET's, not one repo's", () => {
    const byKey = new Map([
      [keyOfScope(sparkle), [green(1), green(2), conflicting(3)]],
      [keyOfScope(site), [green(4)]],
    ]);
    const t = fleetTotals(buildPrGroups([sparkle, site], byKey, new Set()));
    expect(t.total).toBe(4);
    expect(t.ready).toBe(3);
    expect(t.groupsWithPrs).toBe(2);
  });

  it("counts a scope the OTHER project's PRs would have hidden", () => {
    // The reported bug, as arithmetic: the concierge is scoped to a project with nothing open while
    // every PR lives in the other one. Fleet-wide, the count is 2 rather than 0.
    const byKey = new Map([
      [keyOfScope(site), []],
      [keyOfScope(sparkle), [green(1), green(2)]],
    ]);
    const t = fleetTotals(buildPrGroups([site, sparkle], byKey, new Set()));
    expect(t.total).toBe(2);
    expect(t.ready).toBe(2);
  });

  it("is UNKNOWN before anything comes back", () => {
    expect(fleetTotals(buildPrGroups([sparkle, site], new Map(), new Set())).known).toBe(false);
  });

  it("is KNOWN when any one scope answered, even though another has not", () => {
    // "9 open, and one repo we could not read" beats "unknown" — the unreadable one is called out
    // separately by its own stale flag.
    const byKey = new Map([[keyOfScope(sparkle), [green(1)]]]);
    const t = fleetTotals(buildPrGroups([sparkle, site], byKey, new Set()));
    expect(t.known).toBe(true);
    expect(t.total).toBe(1);
  });
});

describe("fleetHeadline", () => {
  const totals = (scopes: PrScope[], byKey: Map<string, PrRow[] | null>) =>
    fleetTotals(buildPrGroups(scopes, byKey, new Set()));

  it("says so plainly at a genuine fleet-wide zero", () => {
    // The decision recorded in bead sparkle-lcx8y: at zero the control STAYS and states the zero.
    const t = totals([sparkle, site], new Map([[keyOfScope(sparkle), []], [keyOfScope(site), []]]));
    expect(fleetHeadline(t)).toBe("No open pull requests");
  });

  it("does NOT claim zero before a probe has returned", () => {
    const t = totals([sparkle], new Map());
    expect(fleetHeadline(t)).toBe("Checking GitHub…");
  });

  it("omits the scope count when only one project is open", () => {
    const t = totals([sparkle], new Map([[keyOfScope(sparkle), [green(1), green(2)]]]));
    expect(fleetHeadline(t)).toBe("2 open pull requests");
  });

  it("NAMES the scope count once the list spans projects", () => {
    // Without this the sentence reads exactly as it did when the menu was single-project.
    const t = totals(
      [sparkle, site],
      new Map([[keyOfScope(sparkle), [green(1)]], [keyOfScope(site), [green(2)]]]),
    );
    expect(fleetHeadline(t)).toBe("2 open pull requests across 2 projects");
  });

  it("singularises one PR", () => {
    const t = totals([sparkle], new Map([[keyOfScope(sparkle), [green(1)]]]));
    expect(fleetHeadline(t)).toBe("1 open pull request");
  });
});

// ── A ZERO MAY NOT BE CLAIMED OVER A REPO WE COULD NOT READ (roborev 57714) ────────────────────
//
// `known` is ANY-of, which is right for a NON-zero total: "9 open, and one repo we could not read"
// beats "unknown". At ZERO it is a different statement. Two tabs open, one answering `[]` and one
// whose probe fails on every poll (no remote, unauthed, offline — persistent, not a blip), and a
// flat "No open pull requests" is a confident zero over a repo that may be full of them. That is
// the exact shape of the bug this whole change exists to fix, one layer down.
describe("a failed probe with nothing behind it is UNREADABLE, not zero", () => {
  const failed = (...scopes: PrScope[]) => new Set(scopes.map(keyOfScope));

  it("separates 'stale' (we have an older list) from 'unreadable' (we have none)", () => {
    const byKey = new Map([[keyOfScope(sparkle), [green(1)]]]);
    const [a, b] = buildPrGroups([sparkle, site], byKey, failed(sparkle, site));
    // Both failed; only one has something to be out of date.
    expect([a?.failed, b?.failed]).toEqual([true, true]);
    expect([a?.stale, a?.unreadable]).toEqual([true, false]);
    expect([b?.stale, b?.unreadable]).toEqual([false, true]);
  });

  it("does not mark a scope unreadable merely because it has not answered YET", () => {
    // Nothing has failed — the probe is simply still out. A notice here would fire on every open.
    const [g] = buildPrGroups([sparkle], new Map(), new Set());
    expect(g?.failed).toBe(false);
    expect(g?.unreadable).toBe(false);
  });

  it("REFUSES the flat negative when a project could not be read", () => {
    const byKey = new Map([[keyOfScope(sparkle), []]]);
    const t = fleetTotals(buildPrGroups([sparkle, site], byKey, failed(site)));
    expect(t.total).toBe(0);
    expect(t.unreadable).toBe(1);
    expect(fleetHeadline(t)).toBe("No open pull requests in the projects we could read");
  });

  it("still states a plain zero when every project genuinely answered", () => {
    const byKey = new Map([[keyOfScope(sparkle), []], [keyOfScope(site), []]]);
    const t = fleetTotals(buildPrGroups([sparkle, site], byKey, new Set()));
    expect(t.unreadable).toBe(0);
    expect(fleetHeadline(t)).toBe("No open pull requests");
  });

  it("names the unreadable projects, and does not confuse them with the stale ones", () => {
    const byKey = new Map([[keyOfScope(sparkle), [green(1)]]]);
    const groups = buildPrGroups([sparkle, site], byKey, failed(sparkle, site));
    expect(staleProjectNames(groups)).toEqual(["sparkle"]);
    expect(unreadableProjectNames(groups)).toEqual(["drodio-website"]);
  });
});

// The settled-vs-outstanding distinction, at the arithmetic layer (roborev 57728).
describe("fleetUnreachable / the headline's !known branch", () => {
  const failed = (...scopes: PrScope[]) => new Set(scopes.map(keyOfScope));

  it("counts a scope we have asked and not heard from as PENDING", () => {
    const t = fleetTotals(buildPrGroups([sparkle, site], new Map(), failed(site)));
    expect(t.pending).toBe(1); // sparkle
    expect(t.unreadable).toBe(1); // site
  });

  it("does NOT call it unreachable while one project is still outstanding", () => {
    // The exact race: the broken repo returns null first, the healthy one is seconds behind.
    const t = fleetTotals(buildPrGroups([sparkle, site], new Map(), failed(site)));
    expect(fleetUnreachable(t)).toBe(false);
    expect(fleetHeadline(t)).toBe("Checking GitHub…");
  });

  it("calls it unreachable once every project has failed", () => {
    const t = fleetTotals(buildPrGroups([sparkle, site], new Map(), failed(sparkle, site)));
    expect(fleetUnreachable(t)).toBe(true);
    expect(fleetHeadline(t)).toBe("Couldn't reach GitHub for any of these projects");
  });

  it("AGREES IN NUMBER for a single project", () => {
    const t = fleetTotals(buildPrGroups([sparkle], new Map(), failed(sparkle)));
    expect(fleetHeadline(t)).toBe("Couldn't reach GitHub");
  });

  it("says there is NOTHING TO ASK rather than checking forever", () => {
    // A project with no rootPath is never probed — `refetch` returns early — so pending and
    // unreadable both stay 0 and nothing will ever move them. This used to settle on "Checking
    // GitHub…" permanently, which is the same wrong-tense defect as announcing a failure early,
    // at the other end. An earlier version of this very test asserted the permanent "checking"
    // as correct, so nothing would have caught it (roborev 57733).
    const none: PrScope = { projectId: "p9", projectName: "unsaved", rootPath: null };
    const t = fleetTotals(buildPrGroups([none], new Map(), new Set()));
    expect(t.pending).toBe(0);
    expect(t.askable).toBe(0);
    expect(fleetUnreachable(t)).toBe(false);
    expect(fleetHeadline(t)).toBe("No project with a GitHub remote");
  });
});

// ── A ZERO MAY NOT BE CLAIMED WHILE A PROJECT IS STILL ANSWERING (roborev 57733) ──────────────
//
// This is NOT the failure race — it is the ordinary two-healthy-repos case. The `!known` branch
// learned to wait on `pending`; the `total === 0` branch did not, and the moment ONE scope answers
// `known` flips true and control falls straight into it. Two tabs, sparkle answering [] in 200ms
// while drodio-website takes three seconds and is holding six mergeable PRs: for those three
// seconds both surfaces said "No open pull requests".
describe("the zero claim waits for every project", () => {
  it("says CHECKING while a project is still answering, even though another said zero", () => {
    const byKey = new Map([[keyOfScope(sparkle), []]]);
    const t = fleetTotals(buildPrGroups([sparkle, site], byKey, new Set()));
    expect(t.known).toBe(true); // sparkle answered…
    expect(t.pending).toBe(1); // …and drodio-website has not
    expect(fleetState(t)).toBe("checking");
    expect(fleetHeadline(t)).toBe("Checking GitHub…");
  });

  it("states the zero once the outstanding project answers empty too", () => {
    const byKey = new Map([[keyOfScope(sparkle), []], [keyOfScope(site), []]]);
    const t = fleetTotals(buildPrGroups([sparkle, site], byKey, new Set()));
    expect(fleetState(t)).toBe("zero");
    expect(fleetHeadline(t)).toBe("No open pull requests");
  });

  it("SHOWS a real count immediately, without waiting for the rest", () => {
    // A count that exists is worth showing while more is on its way — it only grows. Only the ZERO
    // is a claim that needs every answer in.
    const byKey = new Map([[keyOfScope(sparkle), [green(1)]]]);
    const t = fleetTotals(buildPrGroups([sparkle, site], byKey, new Set()));
    expect(t.pending).toBe(1);
    expect(fleetState(t)).toBe("counted");
    expect(fleetHeadline(t)).toBe("1 open pull request across 2 projects");
  });
});

// ── THE MIXED FLEET: A TAB THE APP CANNOT ASK, BESIDE ONE IT CAN (roborev 57739) ──────────────
//
// `askable` separated "nothing to ask" from "not asked yet", but the sentences went on counting
// EVERY tab — so they made claims about projects that were never probed and never will be. This is
// the configuration where the two counts diverge, and nothing exercised it.
describe("sentences count what was ASKED, not what has a tab", () => {
  const unaskable: PrScope = { projectId: "p0", projectName: "unsaved", rootPath: null };

  it("does not say 'any of these projects' when only one of them was askable", () => {
    const t = fleetTotals(buildPrGroups([unaskable, sparkle], new Map(), new Set([keyOfScope(sparkle)])));
    expect(t.askable).toBe(1);
    expect(fleetState(t)).toBe("unreachable");
    // The plural would be false: the other tab was never asked.
    expect(fleetHeadline(t)).toBe("Couldn't reach GitHub");
  });

  it("does not spread a count across a project it cannot ask", () => {
    const byKey = new Map([[keyOfScope(sparkle), [green(1)]]]);
    const t = fleetTotals(buildPrGroups([unaskable, sparkle], byKey, new Set()));
    expect(t.askable).toBe(1);
    // "across 2 projects" would imply the unaskable tab contributed a zero to the total.
    expect(fleetHeadline(t)).toBe("1 open pull request");
  });

  it("still names the count once TWO projects were actually asked", () => {
    const byKey = new Map([[keyOfScope(sparkle), [green(1)]], [keyOfScope(site), [green(2)]]]);
    const t = fleetTotals(buildPrGroups([unaskable, sparkle, site], byKey, new Set()));
    expect(t.askable).toBe(2);
    expect(fleetHeadline(t)).toBe("2 open pull requests across 2 projects");
  });
});

// ── DISMISSALS: A DISMISSED PR LEAVES THE LIST *AND* STOPS COUNTING ─────────────────────────────
//
// The founder's ask was "it doesn't keep showing me that it's available to merge". Two halves, and
// they are one fact here on purpose: the grouping does the split, and every count is taken from
// what the split left behind, so the row and the chiclet cannot disagree about what is hidden.
describe("buildPrGroups — dismissals", () => {
  const hidden = (key: string, ...numbers: number[]) =>
    new Map([[key, new Set(numbers)]]) as ReadonlyMap<string, ReadonlySet<number>>;

  it("moves a dismissed PR out of prs and into dismissed", () => {
    const key = keyOfScope(sparkle);
    const g = firstGroup(
      [sparkle],
      new Map([[key, [green(1), green(2)]]]),
      new Set(),
      hidden(key, 2),
    );
    expect(g.prs.map((p) => p.number)).toEqual([1]);
    expect(g.dismissed.map((p) => p.number)).toEqual([2]);
  });

  it("drops a dismissed PR from readyCount — the number the chiclet renders", () => {
    // The SIDE EFFECT, not the precondition: two green PRs, one dismissed, count of one.
    const key = keyOfScope(sparkle);
    const args = [[sparkle], new Map([[key, [green(1), green(2)]]]), new Set<string>()] as const;
    expect(firstGroup(...args).readyCount).toBe(2);
    expect(firstGroup(...args, hidden(key, 2)).readyCount).toBe(1);
  });

  it("does not let one repo's dismissal hide another repo's PR of the same number", () => {
    // PR numbers collide across repositories — the single most dangerous fact on this surface.
    // Dismissing sparkle's #1 may never touch the website's #1.
    const groups = buildPrGroups(
      [sparkle, site],
      new Map([
        [keyOfScope(sparkle), [green(1)]],
        [keyOfScope(site), [green(1)]],
      ]),
      new Set(),
      hidden(keyOfScope(sparkle), 1),
    );
    expect(groups[0]!.prs).toEqual([]);
    expect(groups[0]!.dismissed.map((p) => p.number)).toEqual([1]);
    expect(groups[1]!.prs.map((p) => p.number)).toEqual([1]);
    expect(groups[1]!.dismissed).toEqual([]);
  });

  it("defaults to hiding NOTHING, so a failed dismissal read shows too much rather than too little", () => {
    const key = keyOfScope(sparkle);
    const byKey = new Map([[key, [green(1)]]]);
    expect(firstGroup([sparkle], byKey, new Set()).prs.map((p) => p.number)).toEqual([1]);
    expect(firstGroup([sparkle], byKey, new Set(), new Map()).prs.map((p) => p.number)).toEqual([1]);
  });
});

describe("fleetTotals + fleetHeadline — dismissals", () => {
  const hidden = (key: string, ...numbers: number[]) =>
    new Map([[key, new Set(numbers)]]) as ReadonlyMap<string, ReadonlySet<number>>;

  it("keeps dismissed PRs out of total and ready, and counts them separately", () => {
    const key = keyOfScope(sparkle);
    const t = fleetTotals(
      buildPrGroups([sparkle], new Map([[key, [green(1), green(2), green(3)]]]), new Set(), hidden(key, 2, 3)),
    );
    expect(t.total).toBe(1);
    expect(t.ready).toBe(1);
    expect(t.dismissed).toBe(2);
  });

  it("refuses a flat zero when every open PR has been dismissed", () => {
    // `total === 0` here is a choice the user made, not a fact about GitHub — and a bare "No open
    // pull requests" over two hidden rows states a zero that is really a hidden non-zero, with
    // nothing on screen pointing at where they went. That is the same false claim the unreadable
    // and pending hedges above exist to prevent.
    const key = keyOfScope(sparkle);
    const groups = buildPrGroups(
      [sparkle],
      new Map([[key, [green(1), green(2)]]]),
      new Set(),
      hidden(key, 1, 2),
    );
    const t = fleetTotals(groups);
    expect(fleetState(t)).toBe("zero");
    expect(fleetHeadline(t)).toBe("No open pull requests — 2 dismissed");
  });

  it("still says the plain sentence at a genuine zero", () => {
    const t = fleetTotals(buildPrGroups([sparkle], new Map([[keyOfScope(sparkle), []]]), new Set()));
    expect(t.dismissed).toBe(0);
    expect(fleetHeadline(t)).toBe("No open pull requests");
  });
});

// ── ONE REPOSITORY, TWO PROJECT ENTRIES ────────────────────────────────────────────────────────
//
// THE FOUNDER'S 2026-08-06 REPORT, pinned. The panel read "47 open pull requests across 6 projects"
// and listed SPARKLE-DESKTOP with 23 PRs and SPARKLE with the SAME 23 — identical numbers, titles
// and branches under both headings. `/Users/…/Projects/sparkle-desktop` is a linked git WORKTREE of
// `/Users/…/Projects/sparkle`: two folders, two project records, ONE repository, ONE origin
// (`https://github.com/drodio/sparkle.git`) and therefore one set of pull requests.
//
// The detection subtlety these tests exist to keep honest: a linked worktree's `.git` is a FILE, so
// nothing about the path or the folder's shape distinguishes it. Identity comes from the RESOLVED
// repository — `git rev-parse --git-common-dir`, which answers `<main>/.git` from either checkout —
// carried in as `repoKey`. Every assertion below is over a value the UI renders (the rows, the
// section count, the headline), never over the input that was handed in.
describe("one repository open under two project entries", () => {
  /** The two entries the founder had open: different folders, one shared `.git` common dir — which
   *  is exactly what "they resolve to the same origin remote" looks like on disk. */
  const mainCheckout: PrScope = {
    projectId: "p-main",
    projectName: "sparkle",
    rootPath: "/Users/x/Projects/sparkle",
    repoKey: "/Users/x/Projects/sparkle/.git",
  };
  const worktree: PrScope = {
    projectId: "p-wt",
    projectName: "sparkle-desktop",
    // A DIFFERENT FOLDER, and its `.git` is a file pointing into the main checkout's. Both facts
    // matter: the path differs (so a path dedupe fails) and the common dir does not (so this one
    // works).
    rootPath: "/Users/x/Projects/sparkle-desktop",
    repoKey: "/Users/x/Projects/sparkle/.git",
  };
  /** The same `gh pr list` answer, because it IS the same repo — what both probes come back with. */
  const sharedRows = [green(1433), green(1432), conflicting(1431)];

  it("lists each pull request EXACTLY ONCE across the whole panel", () => {
    const groups = buildPrGroups(
      [mainCheckout, worktree],
      new Map([
        [keyOfScope(mainCheckout), sharedRows],
        [keyOfScope(worktree), sharedRows],
      ]),
      new Set(),
    );
    // THE ASSERTION THE BUG WOULD FAIL: every number the panel renders, counted. Before the fold
    // this was [1433, 1433, 1432, 1432, 1431, 1431].
    const rendered = groups.flatMap((g) => g.prs.map((p) => p.number));
    expect(rendered).toEqual([1433, 1432, 1431]);
    expect(new Set(rendered).size).toBe(rendered.length);
  });

  it("counts the repository once in the total and once in 'across N projects'", () => {
    const t = fleetTotals(
      buildPrGroups(
        [mainCheckout, worktree, site],
        new Map([
          [keyOfScope(mainCheckout), sharedRows],
          [keyOfScope(worktree), sharedRows],
          [keyOfScope(site), [green(7)]],
        ]),
        new Set(),
      ),
    );
    // 3 + 1, not 3 + 3 + 1 — and "across 2 projects", not 3. The founder read 47/6; both numbers
    // were the same miscount seen twice.
    expect(t.total).toBe(4);
    expect(t.askable).toBe(2);
    expect(fleetHeadline(t)).toBe("4 open pull requests across 2 projects");
  });

  it("names the folded checkout in the heading instead of making it disappear", () => {
    // The founder's explicit constraint: a duplicate may not vanish in a way that hides which local
    // checkout an agent is working in. Agents live in a PROJECT ENTRY, so both entries stay visible.
    const g = firstGroup(
      [mainCheckout, worktree],
      new Map([[keyOfScope(mainCheckout), sharedRows]]),
      new Set(),
    );
    expect(g.scope.projectName).toBe("sparkle");
    expect(g.alsoOpenAs).toEqual(["sparkle-desktop"]);
    expect(g.members.map((m) => m.rootPath)).toEqual([
      "/Users/x/Projects/sparkle",
      "/Users/x/Projects/sparkle-desktop",
    ]);
  });

  it("makes the FIRST entry in tab order the primary, whichever checkout that is", () => {
    // The founder chose first-in-tab-order over "prefer the main checkout": sections already read in
    // tab order, so the primary is the one that would have come first anyway. Reversing the input
    // must therefore reverse the answer — a rule that ignored order would return "sparkle" twice.
    const g = firstGroup([worktree, mainCheckout], new Map(), new Set());
    expect(g.scope.projectName).toBe("sparkle-desktop");
    expect(g.alsoOpenAs).toEqual(["sparkle"]);
    expect(g.key).toBe(keyOfScope(worktree));
  });

  it("keeps the ownership answer only ONE entry can give", () => {
    // THE ATTRIBUTION HALF, and the reason both entries are still probed. Rust resolves a PR's
    // owning agent through a store keyed BY PROJECT ID, so an agent living in the worktree entry can
    // only be named by the worktree entry's probe. Folding must not cost that answer — and it must
    // not let the weak legacy branch-name guess (the one source that ignores the project id, so
    // every entry produces it) beat the authoritative `created` record held by the other entry.
    const fromMain = { ...green(1433), agentId: "agent-old", agentIdSource: "branch-name" };
    const fromWorktree = { ...green(1433), agentId: "agent-real", agentIdSource: "created" };
    const g = firstGroup(
      [mainCheckout, worktree],
      new Map([
        [keyOfScope(mainCheckout), [fromMain]],
        [keyOfScope(worktree), [fromWorktree]],
      ]),
      new Set(),
    );
    expect(g.prs).toHaveLength(1);
    expect(g.prs[0]!.agentId).toBe("agent-real");
    expect(g.prs[0]!.agentIdSource).toBe("created");
  });

  it("takes the ANSWERED probe reading over a present-but-unknown one", () => {
    // roborev 59902 (Medium). The merge used to ask "is a reading defined", and an UNKNOWN reading —
    // `unansweredBlocking: null`, what an unauthed, offline or timed-out `gh` produces — is defined.
    // So the primary's failed read beat the other tab's answered one and a PR the app KNEW was
    // probe-blocked rendered GREEN with a live one-click Merge, which Rust's merge_pr would then
    // refuse. Order matters here: the weaker reading is FIRST, which is the case presence-testing
    // got wrong.
    const unknownRead = {
      ...green(1433),
      probes: { unansweredBlocking: null, overridden: false, applicable: true },
    };
    const answeredRead = {
      ...green(1433),
      probes: { unansweredBlocking: 2, overridden: false, applicable: true },
    };
    const g = firstGroup(
      [mainCheckout, worktree],
      new Map([
        [keyOfScope(mainCheckout), [unknownRead]],
        [keyOfScope(worktree), [answeredRead]],
      ]),
      new Set(),
    );
    expect(g.prs[0]!.probes?.unansweredBlocking).toBe(2);
    // The whole point of the field: the row must not be offered as ready to merge.
    expect(g.blockedCount).toBe(1);
    expect(g.readyCount).toBe(0);
  });

  it("does not let an unknown reading arriving second erase an answered one", () => {
    // The mirror image, so the fix cannot be "always take the later reading".
    const answeredRead = {
      ...green(1433),
      probes: { unansweredBlocking: 2, overridden: false, applicable: true },
    };
    const unknownRead = {
      ...green(1433),
      probes: { unansweredBlocking: null, overridden: false, applicable: true },
    };
    const g = firstGroup(
      [mainCheckout, worktree],
      new Map([
        [keyOfScope(mainCheckout), [answeredRead]],
        [keyOfScope(worktree), [unknownRead]],
      ]),
      new Set(),
    );
    expect(g.prs[0]!.probes?.unansweredBlocking).toBe(2);
    expect(g.blockedCount).toBe(1);
  });

  // TWO ANSWERED READINGS THAT DISAGREE — the tie an absent<unknown<answered rank could not break
  // (roborev 59927). Both orders, because a rank that ties resolves by POSITION and would pass one
  // of them by luck. This is reachable in production, not a contrivance: probe reads fire per scope
  // and un-awaited, and the gate cache keys on `updatedAt`, which a probe answered by EDITING an
  // existing reply never bumps — so one member can hold a stale-but-answered count while the other
  // holds the fresh one.
  for (const [label, first, second] of [
    ["clean first", 0, 2],
    ["blocking first", 2, 0],
  ] as const) {
    it(`takes the BLOCKING answered reading over an answered-clean one (${label})`, () => {
      const reading = (n: number) => ({
        ...green(1433),
        probes: { unansweredBlocking: n, overridden: false, applicable: true },
      });
      const g = firstGroup(
        [mainCheckout, worktree],
        new Map([
          [keyOfScope(mainCheckout), [reading(first)]],
          [keyOfScope(worktree), [reading(second)]],
        ]),
        new Set(),
      );
      // Withholding a green we are unsure of costs a Refresh; suppressing a block the app already
      // knows about costs a one-click Merge that Rust's merge_pr refuses.
      expect(g.prs[0]!.probes?.unansweredBlocking).toBe(2);
      expect(g.blockedCount).toBe(1);
      expect(g.readyCount).toBe(0);
    });
  }

  // TWO BLOCKING READINGS THAT DISAGREE ON THE COUNT — the `3 + unanswered` half of the rank
  // (roborev 59958). Without this the count-max branch is unpinned: a rank of a flat `3` for any
  // block would pass every other case in this file while resolving this pair by POSITION, which is
  // the one thing the tie-break exists to remove. Both orders, for the same reason as above.
  for (const [label, first, second] of [
    ["smaller first", 1, 3],
    ["larger first", 3, 1],
  ] as const) {
    it(`takes the LARGER block count when both members answered blocking (${label})`, () => {
      const reading = (n: number) => ({
        ...green(1433),
        probes: { unansweredBlocking: n, overridden: false, applicable: true },
      });
      const g = firstGroup(
        [mainCheckout, worktree],
        new Map([
          [keyOfScope(mainCheckout), [reading(first)]],
          [keyOfScope(worktree), [reading(second)]],
        ]),
        new Set(),
      );
      // The row says "Blocked: 3 probes", not "1" — the reader must not be sent to answer fewer
      // questions than the PR actually carries.
      expect(g.prs[0]!.probes?.unansweredBlocking).toBe(3);
      expect(g.blockedCount).toBe(1);
    });
  }

  it("does not let an OVERRIDDEN block outrank a clean reading — an override is what unblocks it", () => {
    // The boundary of the tie-break above. `overridden` means a written reason is already recorded
    // on the PR, so that reading is not a block and must not be preferred as one.
    //
    // ASSERTED ON WHICH READING SURVIVED, not only on the readiness outcome. `prMergeReadiness`
    // already declines to block on an overridden reading, so a counts-only assertion here is
    // VACUOUS — it passes whether or not `probeStrength` honours `overridden`, which is exactly what
    // a mutation check showed. The observable this branch actually controls is which of the two
    // readings the merged row carries.
    const overridden = {
      ...green(1433),
      probes: { unansweredBlocking: 3, overridden: true, applicable: true },
    };
    const clean = {
      ...green(1433),
      probes: { unansweredBlocking: 0, overridden: false, applicable: true },
    };
    const g = firstGroup(
      [mainCheckout, worktree],
      new Map([
        [keyOfScope(mainCheckout), [clean]],
        [keyOfScope(worktree), [overridden]],
      ]),
      new Set(),
    );
    expect(g.prs[0]!.probes).toEqual(clean.probes);
    expect(g.blockedCount).toBe(0);
    expect(g.readyCount).toBe(1);
  });

  it("keeps a probe reading that landed for only one of the two entries", () => {
    // Probe reads are per scope and land after the list, so one member can carry the blocking
    // reading while the other has none. Absent must never win over present: an unknown reading
    // switches the probe gate off, which would re-hide a block the app already knows about.
    const blocked = {
      ...green(1433),
      probes: { unansweredBlocking: 2, overridden: false, applicable: true },
    };
    const g = firstGroup(
      [mainCheckout, worktree],
      new Map([
        [keyOfScope(mainCheckout), [green(1433)]],
        [keyOfScope(worktree), [blocked]],
      ]),
      new Set(),
    );
    expect(g.prs[0]!.probes?.unansweredBlocking).toBe(2);
    expect(g.blockedCount).toBe(1);
    expect(g.readyCount).toBe(0);
  });

  it("honours a dismissal made under EITHER entry", () => {
    // One repo has one #1433. Waving it away in one tab and having it come straight back under the
    // other would read as a broken dismissal — and the section it would come back in no longer
    // exists.
    const g = firstGroup(
      [mainCheckout, worktree],
      new Map([[keyOfScope(mainCheckout), sharedRows]]),
      new Set(),
      new Map([[keyOfScope(worktree), new Set([1433])]]),
    );
    expect(g.prs.map((p) => p.number)).toEqual([1432, 1431]);
    expect(g.dismissed.map((p) => p.number)).toEqual([1433]);
  });

  it("shows the list one entry could read when the other's probe failed", () => {
    // `stale` (we have rows, one read failed) and `unreadable` (no rows at all) stay different
    // facts. Calling a section unreadable while holding a good list would hide rows we have.
    const g = firstGroup(
      [mainCheckout, worktree],
      new Map([[keyOfScope(mainCheckout), sharedRows]]),
      new Set([keyOfScope(worktree)]),
    );
    expect(g.prs).toHaveLength(3);
    expect(g.known).toBe(true);
    expect(g.stale).toBe(true);
    expect(g.unreadable).toBe(false);
  });

  it("leaves genuinely separate repositories alone", () => {
    // MONOTONIC, NEVER SPLITS. Two different repos keep two sections and two totals — the fold may
    // only ever merge, so nothing that worked before this change can regress.
    const other = { ...site, repoKey: "/code/site/.git" };
    const groups = buildPrGroups(
      [mainCheckout, other],
      new Map([
        [keyOfScope(mainCheckout), [green(1)]],
        [keyOfScope(other), [green(1)]],
      ]),
      new Set(),
    );
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.alsoOpenAs.length === 0)).toBe(true);
    expect(fleetTotals(groups).total).toBe(2);
  });

  it("degrades to the per-path behaviour when no repo key has been resolved yet", () => {
    // Repo keys arrive from a git subprocess a beat after hydrate. Until one lands the rule falls
    // back to the path, which is exactly what the panel did before — so the pre-resolution window is
    // the old behaviour rather than a new wrong one.
    const groups = buildPrGroups(
      [
        { ...mainCheckout, repoKey: null },
        { ...worktree, repoKey: undefined },
      ],
      new Map(),
      new Set(),
    );
    expect(groups).toHaveLength(2);
  });

  it("never folds two rootPath-less tabs together on the strength of two empty paths", () => {
    // The floor tier. A project with no folder has no repository at all, so it can only ever be its
    // own section — otherwise every unconfigured tab would collapse into one.
    const groups = buildPrGroups(
      [
        { projectId: "a", projectName: "A", rootPath: null },
        { projectId: "b", projectName: "B", rootPath: null },
      ],
      new Map(),
      new Set(),
    );
    expect(groups).toHaveLength(2);
    expect(fleetTotals(groups).askable).toBe(0);
  });
});
