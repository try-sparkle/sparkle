import { describe, it, expect } from "vitest";
import {
  buildConciergeFeed,
  conciergeBand,
  conciergeTopics,
  emptyCounts,
  isCalmBand,
  trayStatusMap,
} from "./conciergeFeed";
import { bandOfStatus, type StatusBand } from "../engine/buildSections";
import { AGENT_STATUS } from "@sparkle/ui";
import type { Roster } from "./rosterTypes";
import type { AgentTab, AgentTabStatus, Project } from "../types";

// Colors from packages/ui/tokens.ts — literal hex so a token drift is caught, matching the
// buildRoster test's convention.
const RED = "#e0533f";
const GRAY = "#8aa0c4";
const GREEN = "#34c759";

function agent(id: string, over: Partial<AgentTab> = {}): AgentTab {
  return {
    id,
    name: id,
    kind: "build",
    parentId: null,
    promptHistory: [],
    runtime: "local",
    worktreePath: null,
    ...over,
  } as AgentTab;
}

function project(id: string, agents: AgentTab[], name = `Proj ${id}`): Project {
  return {
    id,
    name,
    rootPath: `/${id}`,
    defaultBranch: "main",
    createdAt: "",
    agents,
    selectedAgentId: null,
  } as Project;
}

/** One flat agents list from the feed, in rendered order. */
function flat(feed: ReturnType<typeof buildConciergeFeed>) {
  return feed.projects.flatMap((p) => p.agents);
}

describe("conciergeBand — the app's one status vocabulary", () => {
  it.each<[AgentTabStatus, StatusBand]>([
    ["waiting", "needs_you"],
    ["approval", "needs_you"],
    ["errored", "needs_you"],
    // `blocked` used to be its own amber "wants you eventually" tier. It is Needs-you now: a gold
    // card and a red card both meant "go look", so the second alarm color bought nothing.
    ["blocked", "needs_you"],
    // `unmerged` bands `done`: the band is the concierge's INTERRUPTION budget (needs_you renders a
    // nudge card, counts into "N Need you", lights a tab glow), and landing state must not buy an
    // interruption — 27 of 51 agents were in that band on the reported fleet. It is kept out of the
    // DIMMING predicate separately; see isCalmBand.
    ["unmerged", "done"],
    // The split the new vocabulary ADDS: in-flight work is not finished work.
    ["working", "running"],
    ["idle", "done"],
    ["done", "done"],
    ["stopped", "done"],
  ])("%s → %s", (status, want) => {
    expect(conciergeBand(status)).toBe(want);
  });

  it("no status at all bands `done` — same place `stopped`, the builder's default, lands", () => {
    expect(conciergeBand(undefined)).toBe("done");
  });

  it("is a pure `undefined` shim over the engine's bandOfStatus, never a second opinion", () => {
    const all: AgentTabStatus[] = [
      "working", "idle", "waiting", "approval", "blocked", "errored", "unmerged", "done", "stopped",
    ];
    for (const s of all) expect(conciergeBand(s)).toBe(bandOfStatus(s));
  });
});

// The two predicates that MUST disagree. redTaxonomySeparation.test.ts owns the cross-module story;
// what is pinned here is the exact membership of `isCalmBand`, because it is defined in this file and
// the band is the tempting thing to define it as.
describe("isCalmBand is NOT the band", () => {
  it("unmerged bands `done` but is not calm — the whole reason they are two predicates", () => {
    expect(conciergeBand("unmerged")).toBe("done");
    expect(isCalmBand("unmerged")).toBe(false);
  });

  it("keeps `working` calm even though it is now its own band", () => {
    // The running/done split is about POSITION and COUNTS. A terminal that desaturates the moment
    // its agent starts working would be a treatment nobody asked for.
    expect(conciergeBand("working")).toBe("running");
    expect(isCalmBand("working")).toBe(true);
  });

  it("is exactly {idle, done, stopped, working, no-status}", () => {
    for (const s of ["idle", "done", "stopped", "working"] as const) {
      expect(isCalmBand(s)).toBe(true);
    }
    expect(isCalmBand(undefined)).toBe(true);
    for (const s of ["waiting", "approval", "errored", "blocked", "unmerged"] as const) {
      expect(isCalmBand(s)).toBe(false);
    }
  });
});

describe("buildConciergeFeed — status banding + status tokens", () => {
  it("bands waiting AND blocked as needs_you (both red), working as running, idle as done", () => {
    const feed = buildConciergeFeed({
      projects: [project("p1", [agent("ask"), agent("stuck"), agent("busy"), agent("calm")])],
      status: { ask: "waiting", stuck: "blocked", busy: "working", calm: "idle" },
    });
    const byId = Object.fromEntries(flat(feed).map((a) => [a.id, a]));
    expect(byId["ask"]).toMatchObject({
      band: "needs_you", status: "waiting", statusColor: RED, statusLabel: "Needs you",
    });
    // Same band AND the same red as `waiting` — there is one red treatment, no amber tier.
    expect(byId["stuck"]).toMatchObject({ band: "needs_you", status: "blocked", statusColor: RED });
    expect(byId["busy"]).toMatchObject({ band: "running", status: "working", statusColor: GREEN });
    expect(byId["calm"]).toMatchObject({ band: "done", status: "idle", statusColor: GRAY });
  });

  it("defaults an agent with no status anywhere to stopped/done/gray (buildRoster's default)", () => {
    const feed = buildConciergeFeed({ projects: [project("p1", [agent("a1")])], status: {} });
    expect(flat(feed)[0]).toMatchObject({
      status: "stopped", band: "done", statusColor: GRAY, statusLabel: "Stopped",
    });
  });

  it("prefers the Claude title, then the auto-name, then the raw name (displayName chain)", () => {
    const feed = buildConciergeFeed({
      projects: [
        project("p1", [
          agent("a1", { aiTitle: "Titled" }),
          agent("a2", { autoNameVariants: { title: "Auto" } } as Partial<AgentTab>),
          agent("a3"),
        ]),
      ],
      status: {},
    });
    expect(flat(feed).map((a) => a.name).sort()).toEqual(["Auto", "Titled", "a3"]);
  });

  it("escalates a done agent with committed-but-unlanded work to unmerged — gray, no interruption", () => {
    // The STATUS escalation still happens (the row says "Needs merge"); what changed on 2026-07-26
    // is that it no longer paints RED, and it never buys a concierge nudge. `isCalmBand` is what
    // keeps the sidebar from dimming it — see redTaxonomySeparation.test.ts.
    const feed = buildConciergeFeed({
      projects: [project("p1", [agent("a1")])],
      status: { a1: "done" },
      workflowStage: { a1: "building_saved" },
    });
    expect(flat(feed)[0]).toMatchObject({
      status: "unmerged",
      band: "done",
      statusColor: AGENT_STATUS.idle.color,
    });
    expect(flat(feed)[0]?.statusColor).not.toBe(RED);
  });

  it("bubbles a red worker onto its idle orchestrator, so both band needs_you", () => {
    const feed = buildConciergeFeed({
      projects: [
        project("p1", [
          agent("boss"),
          agent("w1", { kind: "worker", parentId: "boss" }),
        ]),
      ],
      status: { boss: "idle", w1: "waiting" },
    });
    const byId = Object.fromEntries(flat(feed).map((a) => [a.id, a]));
    expect(byId["w1"]).toMatchObject({ status: "waiting", band: "needs_you" });
    expect(byId["boss"]).toMatchObject({ status: "waiting", band: "needs_you" });
  });
});

describe("buildConciergeFeed — sort order", () => {
  it("sorts Needs you → Running → Done, live questions first within a band, then recent touch", () => {
    const feed = buildConciergeFeed({
      projects: [
        project("p1", [
          agent("calm"),
          agent("merge-me"),
          agent("crashed"),
          agent("ask-old"),
          agent("ask-new"),
          agent("busy"),
        ]),
      ],
      status: {
        calm: "idle",
        "merge-me": "unmerged",
        crashed: "errored",
        "ask-old": "waiting",
        "ask-new": "waiting",
        busy: "working",
      },
      interaction: { "ask-old": 1_000, "ask-new": 2_000 },
    });
    expect(flat(feed).map((a) => a.id)).toEqual([
      "ask-new", // needs_you, waiting, touched most recently
      "ask-old", // needs_you, waiting, touched earlier
      "crashed", // needs_you, errored ranks after live questions
      // `working` is its own band now, so in-flight work sorts ABOVE finished work instead of
      // tying with it — the one ordering change the new vocabulary makes.
      "busy",
      // Both `done` (unmerged buys no interruption); within a band the tiebreak is name order.
      "calm",
      "merge-me",
    ]);
  });

  it("sorts blocked with the other reds, not into a tier of its own", () => {
    const feed = buildConciergeFeed({
      projects: [project("p1", [agent("zzz-blocked"), agent("aaa-busy"), agent("mmm-idle")])],
      status: { "zzz-blocked": "blocked", "aaa-busy": "working", "mmm-idle": "idle" },
    });
    // Name order would put the blocked agent LAST; its band puts it first.
    expect(flat(feed).map((a) => a.id)).toEqual(["zzz-blocked", "aaa-busy", "mmm-idle"]);
  });

  it("carries `since` from the interaction map and omits it when never touched", () => {
    const feed = buildConciergeFeed({
      projects: [project("p1", [agent("touched"), agent("untouched")])],
      status: {},
      interaction: { touched: 42 },
    });
    const byId = Object.fromEntries(flat(feed).map((a) => [a.id, a]));
    expect(byId["touched"]!.since).toBe(42);
    expect(byId["untouched"]!.since).toBeUndefined();
  });
});

describe("buildConciergeFeed — counts", () => {
  const twoProjects = [
    project("pA", [agent("a-wait"), agent("a-block"), agent("a-idle")]),
    project("pB", [agent("b-appr"), agent("b-work")]),
  ];
  const status: Record<string, AgentTabStatus> = {
    "a-wait": "waiting",
    "a-block": "blocked",
    "a-idle": "idle",
    "b-appr": "approval",
    "b-work": "working",
  };

  it("aggregates every band across all projects and per project", () => {
    const feed = buildConciergeFeed({ projects: twoProjects, status });
    // a-wait + a-block + b-appr are all needs_you now (blocked stopped being its own tier).
    expect(feed.counts).toEqual({ needs_you: 3, running: 1, done: 1 });
    expect(feed.projects.map((p) => p.counts)).toEqual([
      { needs_you: 2, running: 0, done: 1 },
      { needs_you: 1, running: 1, done: 0 },
    ]);
    // Unpinned + unmuted: the scoped view equals the full truth.
    expect(feed.scopedCounts).toEqual({ needs_you: 3, running: 1, done: 1 });
    expect(feed.pinnedProjectId).toBeNull();
  });

  it("emptyCounts is the all-zero shape every accumulator starts from", () => {
    expect(emptyCounts()).toEqual({ needs_you: 0, running: 0, done: 0 });
    const feed = buildConciergeFeed({ projects: [project("pEmpty", [])], status: {} });
    expect(feed.counts).toEqual(emptyCounts());
  });

  it("pin scope: scoped counts collapse to the pinned project while the full feed lists all", () => {
    const feed = buildConciergeFeed({ projects: twoProjects, status, pinnedProjectId: "pB" });
    // Only pB's two agents. The pin scopes EVERY band, not just the interrupting one.
    expect(feed.scopedCounts).toEqual({ needs_you: 1, running: 1, done: 0 });
    expect(feed.counts).toEqual({ needs_you: 3, running: 1, done: 1 }); // full truth unchanged
    expect(feed.projects.map((p) => p.id)).toEqual(["pA", "pB"]); // nothing hidden
    expect(feed.projects.map((p) => p.inScope)).toEqual([false, true]);
    const byId = Object.fromEntries(flat(feed).map((a) => [a.id, a]));
    expect(byId["a-wait"]!.inScope).toBe(false);
    expect(byId["b-appr"]!.inScope).toBe(true);
    expect(feed.pinnedProjectId).toBe("pB");
  });
});

describe("buildConciergeFeed — mute (sparklePrefsStore.shouldInterrupt)", () => {
  it("a muted agent id stays in the feed flagged muted:true but leaves the scoped counts", () => {
    const feed = buildConciergeFeed({
      projects: [project("p1", [agent("loud"), agent("hushed")])],
      status: { loud: "waiting", hushed: "waiting" },
      shouldInterrupt: (topic) => topic !== "hushed",
    });
    const byId = Object.fromEntries(flat(feed).map((a) => [a.id, a]));
    // still listed, dimmed
    expect(byId["hushed"]).toMatchObject({ muted: true, band: "needs_you" });
    expect(byId["loud"]).toMatchObject({ muted: false });
    // hushed doesn't surface
    expect(feed.scopedCounts).toEqual({ needs_you: 1, running: 0, done: 0 });
    // full truth keeps it
    expect(feed.counts).toEqual({ needs_you: 2, running: 0, done: 0 });
  });

  it("a muted event-kind slug (status:approval) mutes every agent in that state", () => {
    const feed = buildConciergeFeed({
      projects: [project("p1", [agent("appr"), agent("ask")])],
      status: { appr: "approval", ask: "waiting" },
      shouldInterrupt: (topic) => topic !== "status:approval",
    });
    const byId = Object.fromEntries(flat(feed).map((a) => [a.id, a]));
    expect(byId["appr"]!.muted).toBe(true);
    expect(byId["ask"]!.muted).toBe(false);
    expect(feed.scopedCounts).toEqual({ needs_you: 1, running: 0, done: 0 });
  });

  it("conciergeTopics keys by agent id and status slug", () => {
    expect(conciergeTopics("a1", "approval")).toEqual(["a1", "status:approval"]);
  });
});

describe("buildConciergeFeed — cross-window completeness via the tray roster", () => {
  const roster: Roster = {
    projects: [
      {
        id: "pB",
        name: "Proj pB",
        agents: [
          { id: "far", name: "far", kind: "build", status: "waiting",
            status_color: RED, status_label: "Needs you", parent_id: null },
          { id: "bogus", name: "bogus", kind: "build", status: "not-a-status",
            status_color: GRAY, status_label: "?", parent_id: null },
          // A raw string from the Rust boundary that collides with an Object.prototype key must be
          // rejected too (the `in` operator would have let it through).
          { id: "proto", name: "proto", kind: "build", status: "toString",
            status_color: GRAY, status_label: "?", parent_id: null },
        ],
      },
    ],
  };

  it("trayStatusMap keeps only statuses in the taxonomy", () => {
    expect(trayStatusMap(roster)).toEqual({ far: "waiting" });
    expect(trayStatusMap(null)).toEqual({});
  });

  it("fills a status this window doesn't have; local status always wins", () => {
    const feed = buildConciergeFeed({
      projects: [project("pB", [agent("far"), agent("bogus")])],
      // This window has its own (fresher) view of `bogus` and none of `far`.
      status: { bogus: "working" },
      roster: roster,
    });
    const byId = Object.fromEntries(flat(feed).map((a) => [a.id, a]));
    expect(byId["far"]).toMatchObject({ status: "waiting", band: "needs_you" }); // from the tray
    expect(byId["bogus"]).toMatchObject({ status: "working", statusColor: GREEN }); // local wins
  });
});

// REPRESENTATION — "who speaks for this piece of work?" — the rule that stops `scopedCounts` from
// counting a red worker AND the orchestrator that inherited its red, and stops the concierge's
// `topLevel` surfacing gate from turning an un-bubbled worker into silence. See
// `ConciergeAgent.representedElsewhere`.
describe("buildConciergeFeed — representedElsewhere", () => {
  const worker = (id: string, parentId: string | null) =>
    agent(id, { kind: "worker", parentId });
  /** Every agent live, so the unstarted-worker overlay can't invent an `approval` and change the
   *  bands out from under these cases. */
  const build = (projects: Project[], status: Record<string, AgentTabStatus>) =>
    buildConciergeFeed({
      projects,
      status,
      openAgentIds: projects.flatMap((p) => p.agents.map((a) => a.id)),
    });
  const by = (feed: ReturnType<typeof buildConciergeFeed>) =>
    Object.fromEntries(flat(feed).map((a) => [a.id, a]));

  it("a worker whose red bubbled to its orchestrator is represented, and counted once", () => {
    const feed = build([project("p1", [agent("orch"), worker("w1", "orch")])], {
      orch: "idle",
      w1: "waiting",
    });
    const byId = by(feed);
    expect(byId["orch"]).toMatchObject({ band: "needs_you", representedElsewhere: false });
    expect(byId["w1"]).toMatchObject({ band: "needs_you", representedElsewhere: true });
    // ONE piece of work, one count — the orchestrator's row is the thing that carries it.
    expect(feed.scopedCounts.needs_you).toBe(1);
    expect(feed.counts.needs_you).toBe(2); // the raw truth still lists both
  });

  it("a blocked worker whose orchestrator is still MOVING is not represented — the bubble is suppressed", () => {
    const feed = build([project("p1", [agent("orch"), worker("w1", "orch")])], {
      orch: "working",
      w1: "blocked",
    });
    const byId = by(feed);
    // Different bands: the orchestrator's row is Running, so the Needs-you filter hides it. Nothing
    // is speaking for w1.
    expect(byId["orch"]!.band).toBe("running");
    expect(byId["w1"]).toMatchObject({ band: "needs_you", representedElsewhere: false });
    expect(feed.scopedCounts).toEqual({ needs_you: 1, running: 1, done: 0 });
  });

  it("a parentless worker is never represented", () => {
    const feed = build([project("p1", [worker("w1", null)])], { w1: "waiting" });
    expect(by(feed)["w1"]).toMatchObject({ topLevel: false, representedElsewhere: false });
    expect(feed.scopedCounts.needs_you).toBe(1);
  });

  it("a worker whose orchestrator is not in the fleet is never represented", () => {
    const feed = build([project("p1", [worker("w1", "gone")])], { w1: "blocked" });
    expect(by(feed)["w1"]).toMatchObject({ representedElsewhere: false });
    expect(feed.scopedCounts.needs_you).toBe(1);
  });

  it("a top-level agent is never represented, whatever else is in the fleet", () => {
    const feed = build([project("p1", [agent("a"), agent("b")])], { a: "waiting", b: "waiting" });
    expect(Object.values(by(feed)).every((a) => a.representedElsewhere === false)).toBe(true);
    expect(feed.scopedCounts.needs_you).toBe(2);
  });

  it("representation is BAND equality, not parenthood: a working worker under an idle parent still counts", () => {
    const feed = build([project("p1", [agent("orch"), worker("w1", "orch")])], {
      orch: "idle",
      w1: "working",
    });
    const byId = by(feed);
    // The parent bands `done`; nothing else is reporting that this work is in flight.
    expect(byId["orch"]!.band).toBe("done");
    expect(byId["w1"]).toMatchObject({ band: "running", representedElsewhere: false });
    expect(feed.scopedCounts).toEqual({ needs_you: 0, running: 1, done: 1 });
  });

  it("resolves an orchestrator in ANOTHER project — the fleet is flattened before the red bubbles", () => {
    const feed = build(
      [project("p1", [worker("w1", "orch")]), project("p2", [agent("orch")])],
      { w1: "waiting", orch: "idle" },
    );
    const byId = by(feed);
    expect(byId["orch"]!.band).toBe("needs_you"); // publishedStatusFor ran over the flat fleet
    expect(byId["w1"]!.representedElsewhere).toBe(true);
    expect(feed.scopedCounts.needs_you).toBe(1);
  });

  it("a parentId cycle terminates instead of hanging the feed", () => {
    // `parentId` is persisted data; a cycle must be survivable, not fatal.
    const feed = build(
      [project("p1", [worker("w1", "w2"), worker("w2", "w1")])],
      { w1: "waiting", w2: "waiting" },
    );
    // Each is in the other's chain and shares its band, so both read as represented — the point of
    // the test is that this RETURNS at all.
    expect(flat(feed)).toHaveLength(2);
    expect(feed.counts.needs_you).toBe(2);
  });
});

// `ConciergeAgent.topLevel` — the field the digest's whole promise rests on (roborev 53562).
//
// The predicate itself is covered in engine/agentOrdering.test.ts; what is pinned HERE is that the
// feed stamps it from that predicate, closed over the RIGHT population. That choice is load-bearing
// and easy to get wrong in a way no other test would notice: closed over the flattened fleet, a
// worker whose orchestrator lives in another project would read "nested" in a project where it has
// no parent row to nest under, and the digest's count would stop matching the Build column's rows.
describe("buildConciergeFeed — topLevel is stamped from the ONE shared predicate", () => {
  const worker = (id: string, parentId: string | null) =>
    agent(id, { kind: "worker", parentId });
  const by = (feed: ReturnType<typeof buildConciergeFeed>) =>
    Object.fromEntries(flat(feed).map((a) => [a.id, a]));

  it("a parentless build agent is top-level; a worker never is", () => {
    const feed = buildConciergeFeed({
      projects: [project("p1", [agent("orch"), worker("w1", "orch"), worker("w2", null)])],
      status: { orch: "idle", w1: "idle", w2: "idle" },
    });
    const byId = by(feed);
    expect(byId["orch"]!.topLevel).toBe(true);
    expect(byId["w1"]!.topLevel).toBe(false);
    // Orphaned mid-spawn — still never a row.
    expect(byId["w2"]!.topLevel).toBe(false);
  });

  it("a build agent nested under another build agent in the SAME project is not top-level", () => {
    const feed = buildConciergeFeed({
      projects: [project("p1", [agent("parent"), agent("child", { parentId: "parent" })])],
      status: { parent: "idle", child: "idle" },
    });
    expect(by(feed)["child"]!.topLevel).toBe(false);
  });

  it("closes over the PROJECT's agents, not the flattened fleet — a same-id parent elsewhere does not nest it", () => {
    // `child` names a parent that exists only in the OTHER project. Judged against the flattened
    // fleet it would read as nested; judged against its own project — which is the population
    // AgentSidebar asks about, and therefore the rows the digest's click narrows — it is a row.
    const feed = buildConciergeFeed({
      projects: [
        project("p1", [agent("child", { parentId: "faraway" })]),
        project("p2", [agent("faraway")]),
      ],
      status: { child: "idle", faraway: "idle" },
    });
    expect(by(feed)["child"]!.topLevel).toBe(true);
  });
});
