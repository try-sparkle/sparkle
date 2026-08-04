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
    // Two tabs on one repo are two rows the user opened, so they are two groups — and two distinct
    // ledger namespaces. Collapsing them would make one tab's in-flight merge grey out the other.
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
