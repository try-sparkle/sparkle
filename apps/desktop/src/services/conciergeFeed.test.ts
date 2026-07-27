import { describe, it, expect } from "vitest";
import {
  buildConciergeFeed,
  conciergePriority,
  conciergeTopics,
  trayStatusMap,
} from "./conciergeFeed";
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

describe("conciergePriority — reuses the existing attention tiers", () => {
  it.each<[AgentTabStatus, 0 | 1 | 2]>([
    ["waiting", 0],
    ["approval", 0],
    ["errored", 0],
    ["blocked", 1],
    // `unmerged` is P2: this band is the concierge's INTERRUPTION budget (priority < 2 renders a
    // nudge card, counts into "N need attention", lights a tab glow), and landing state must not buy
    // an interruption — 27 of 51 agents were in that band on the reported fleet. It is kept out of
    // the DIMMING predicate separately; see isCalmBand.
    ["unmerged", 2],
    ["working", 2],
    ["idle", 2],
    ["done", 2],
    ["stopped", 2],
  ])("%s → P%i", (status, want) => {
    expect(conciergePriority(status)).toBe(want);
  });

  it("no status at all is calm", () => {
    expect(conciergePriority(undefined)).toBe(2);
  });
});

describe("buildConciergeFeed — priority banding + status tokens", () => {
  it("bands a waiting agent P0 with the red token, a blocked one P1, an idle one P2", () => {
    const feed = buildConciergeFeed({
      projects: [project("p1", [agent("ask"), agent("stuck"), agent("calm")])],
      status: { ask: "waiting", stuck: "blocked", calm: "idle" },
    });
    const byId = Object.fromEntries(flat(feed).map((a) => [a.id, a]));
    expect(byId["ask"]).toMatchObject({
      priority: 0, status: "waiting", statusColor: RED, statusLabel: "Needs you",
    });
    expect(byId["stuck"]).toMatchObject({ priority: 1, status: "blocked", statusColor: RED });
    expect(byId["calm"]).toMatchObject({ priority: 2, status: "idle", statusColor: GRAY });
  });

  it("defaults an agent with no status anywhere to stopped/P2/gray (buildRoster's default)", () => {
    const feed = buildConciergeFeed({ projects: [project("p1", [agent("a1")])], status: {} });
    expect(flat(feed)[0]).toMatchObject({
      status: "stopped", priority: 2, statusColor: GRAY, statusLabel: "Stopped",
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
      priority: 2,
      statusColor: AGENT_STATUS.idle.color,
    });
    expect(flat(feed)[0]?.statusColor).not.toBe(RED);
  });

  it("bubbles a red worker onto its idle orchestrator, so both band P0", () => {
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
    expect(byId["w1"]).toMatchObject({ status: "waiting", priority: 0 });
    expect(byId["boss"]).toMatchObject({ status: "waiting", priority: 0 });
  });
});

describe("buildConciergeFeed — sort order", () => {
  it("sorts P0 → P1 → P2, live questions before errored within P0, then most-recent touch first", () => {
    const feed = buildConciergeFeed({
      projects: [
        project("p1", [
          agent("calm"),
          agent("merge-me"),
          agent("crashed"),
          agent("ask-old"),
          agent("ask-new"),
        ]),
      ],
      status: {
        calm: "idle",
        "merge-me": "unmerged",
        crashed: "errored",
        "ask-old": "waiting",
        "ask-new": "waiting",
      },
      interaction: { "ask-old": 1_000, "ask-new": 2_000 },
    });
    expect(flat(feed).map((a) => a.id)).toEqual([
      "ask-new", // P0, waiting, touched most recently
      "ask-old", // P0, waiting, touched earlier
      "crashed", // P0, errored ranks after live questions
      // Both P2 now (unmerged buys no interruption); within a band the tiebreak is name order.
      "calm",
      "merge-me",
    ]);
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

  it("aggregates p0/p1 across all projects and per project", () => {
    const feed = buildConciergeFeed({ projects: twoProjects, status });
    expect(feed.counts).toEqual({ p0: 2, p1: 1 });
    expect(feed.projects.map((p) => p.counts)).toEqual([
      { p0: 1, p1: 1 },
      { p0: 1, p1: 0 },
    ]);
    // Unpinned + unmuted: the scoped view equals the full truth.
    expect(feed.scopedCounts).toEqual({ p0: 2, p1: 1 });
    expect(feed.pinnedProjectId).toBeNull();
  });

  it("pin scope: scoped counts collapse to the pinned project while the full feed lists all", () => {
    const feed = buildConciergeFeed({ projects: twoProjects, status, pinnedProjectId: "pB" });
    expect(feed.scopedCounts).toEqual({ p0: 1, p1: 0 }); // only pB's approval
    expect(feed.counts).toEqual({ p0: 2, p1: 1 }); // full truth unchanged
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
    expect(byId["hushed"]).toMatchObject({ muted: true, priority: 0 }); // still listed, dimmed
    expect(byId["loud"]).toMatchObject({ muted: false });
    expect(feed.scopedCounts).toEqual({ p0: 1, p1: 0 }); // hushed doesn't surface
    expect(feed.counts).toEqual({ p0: 2, p1: 0 }); // full truth keeps it
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
    expect(feed.scopedCounts).toEqual({ p0: 1, p1: 0 });
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
    expect(byId["far"]).toMatchObject({ status: "waiting", priority: 0 }); // from the tray
    expect(byId["bogus"]).toMatchObject({ status: "working", statusColor: GREEN }); // local wins
  });
});
