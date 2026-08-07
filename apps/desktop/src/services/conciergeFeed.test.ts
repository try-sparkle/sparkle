import { describe, it, expect } from "vitest";
import {
  accountedOwed,
  accountedUnmerged,
  buildConciergeFeed,
  conciergeBand,
  conciergeTopics,
  emptyCounts,
  isCalmBand,
  isOwedAction,
  owedCounts,
  trayStatusMap,
} from "./conciergeFeed";
import { accountedNeedsYou } from "./conciergeProactive";
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

  it("honours the INJECTED interaction map, not a global store — a touched agent bands red", () => {
    // The feed documents itself as pure and already receives `interaction`; the status composition
    // used to read `useInteractionStore` directly instead, so the two were independently sourced.
    // A caller supplying a synthetic map (the intended injection point, mirroring the injected
    // `now`) had route 4 silently ignored, and the payload could carry `since` from the caller's map
    // beside `status: "new"` from an empty singleton — self-contradictory for one agent
    // (roborev 54771).
    const briefless = agent("hand", { createdAt: 1_000 });
    const feed = buildConciergeFeed({
      projects: [project("p1", [briefless])],
      status: { hand: "blocked" },
      interaction: { hand: 2_000 },
    });
    const row = flat(feed)[0]!;
    // Briefed by hand → its `blocked` is a REAL red, not "New — not briefed".
    expect(row.status).toBe("blocked");
    expect(row.band).toBe("needs_you");
    // …and `since` comes from the same map, so the two halves of the payload agree.
    expect(row.since).toBe(2_000);
  });

  it("still calls an untouched briefless agent `new` when the injected map is empty", () => {
    const feed = buildConciergeFeed({
      projects: [project("p1", [agent("fresh", { createdAt: 1_000 })])],
      status: { fresh: "blocked" },
      interaction: {},
    });
    expect(flat(feed)[0]!.status).toBe("new");
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
    expect(feed.counts).toEqual({ needs_you: 3, questions: 0, running: 1, done: 1 });
    expect(feed.projects.map((p) => p.counts)).toEqual([
      { needs_you: 2, questions: 0, running: 0, done: 1 },
      { needs_you: 1, questions: 0, running: 1, done: 0 },
    ]);
    // Unpinned + unmuted: the scoped view equals the full truth.
    expect(feed.scopedCounts).toEqual({ needs_you: 3, questions: 0, running: 1, done: 1 });
    expect(feed.pinnedProjectId).toBeNull();
  });

  // The per-project SCOPED share — what the concierge header splits its one number by (PRD §2a:
  // column one is the global index). The identity below is the whole reason the field exists: the
  // header can name projects without its total drifting from what the thread accounts for.
  it("per-project scopedCounts sum to the feed's scopedCounts, band by band", () => {
    const feed = buildConciergeFeed({ projects: twoProjects, status });
    expect(feed.projects.map((p) => p.scopedCounts)).toEqual([
      { needs_you: 2, questions: 0, running: 0, done: 1 },
      { needs_you: 1, questions: 0, running: 1, done: 0 },
    ]);
    for (const band of ["needs_you", "running", "done"] as const) {
      expect(feed.projects.reduce((n, p) => n + p.scopedCounts[band], 0)).toBe(
        feed.scopedCounts[band],
      );
    }
  });

  it("a pinned-away project's scoped share is ZERO while its raw counts stand", () => {
    const feed = buildConciergeFeed({ projects: twoProjects, status, pinnedProjectId: "pB" });
    const pA = feed.projects.find((p) => p.id === "pA")!;
    expect(pA.counts).toEqual({ needs_you: 2, questions: 0, running: 0, done: 1 }); // the tab badge's truth
    expect(pA.scopedCounts).toEqual(emptyCounts()); // …but the header says nothing about it
    expect(feed.projects.find((p) => p.id === "pB")!.scopedCounts).toEqual(feed.scopedCounts);
  });

  it("mute and representation come out of the per-project share too, not just the global one", () => {
    // Same three gates, applied once — the share is incremented from the global gate, never
    // recomputed beside it.
    const feed = buildConciergeFeed({
      projects: [
        project("p1", [agent("loud"), agent("hushed")]),
        project("p2", [agent("orch"), agent("w1", { kind: "worker", parentId: "orch" })]),
      ],
      status: { loud: "waiting", hushed: "waiting", orch: "waiting", w1: "waiting" },
      shouldInterrupt: (topic) => topic !== "hushed",
    });
    const byId = Object.fromEntries(feed.projects.map((p) => [p.id, p]));
    expect(byId["p1"]!.scopedCounts.needs_you).toBe(1); // hushed is muted out
    expect(byId["p2"]!.scopedCounts.needs_you).toBe(1); // the worker's red is the orchestrator's
    expect(feed.scopedCounts.needs_you).toBe(2);
  });

  it("emptyCounts is the all-zero shape every accumulator starts from", () => {
    expect(emptyCounts()).toEqual({ needs_you: 0, questions: 0, running: 0, done: 0 });
    const feed = buildConciergeFeed({ projects: [project("pEmpty", [])], status: {} });
    expect(feed.counts).toEqual(emptyCounts());
  });

  it("pin scope: scoped counts collapse to the pinned project while the full feed lists all", () => {
    const feed = buildConciergeFeed({ projects: twoProjects, status, pinnedProjectId: "pB" });
    // Only pB's two agents. The pin scopes EVERY band, not just the interrupting one.
    expect(feed.scopedCounts).toEqual({ needs_you: 1, questions: 0, running: 1, done: 0 });
    expect(feed.counts).toEqual({ needs_you: 3, questions: 0, running: 1, done: 1 }); // full truth unchanged
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
    expect(feed.scopedCounts).toEqual({ needs_you: 1, questions: 0, running: 0, done: 0 });
    // full truth keeps it
    expect(feed.counts).toEqual({ needs_you: 2, questions: 0, running: 0, done: 0 });
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
    expect(feed.scopedCounts).toEqual({ needs_you: 1, questions: 0, running: 0, done: 0 });
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
    expect(feed.scopedCounts).toEqual({ needs_you: 1, questions: 0, running: 1, done: 0 });
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

  // `rolledUpGreen` — the stamp the away-recap reads to tell a head that WORKED from one standing
  // in for its subtree. Without it the recap reports one unit of work twice, as the worker and the
  // orchestrator promoted on its behalf.
  it("stamps rolledUpGreen on an idle head whose worker is working", () => {
    const feed = build([project("p1", [agent("orch"), worker("w1", "orch")])], {
      orch: "idle",
      w1: "working",
    });
    expect(by(feed)["orch"]).toMatchObject({ status: "working", rolledUpGreen: true });
  });

  it("does not stamp a head working under its own steam", () => {
    const feed = build([project("p1", [agent("orch"), worker("w1", "orch")])], {
      orch: "working",
      w1: "working",
    });
    expect(by(feed)["orch"]).toMatchObject({ status: "working", rolledUpGreen: false });
  });

  it("does not stamp the worker itself — only heads are promoted", () => {
    const feed = build([project("p1", [agent("orch"), worker("w1", "orch")])], {
      orch: "idle",
      w1: "working",
    });
    expect(by(feed)["w1"]).toMatchObject({ rolledUpGreen: false });
  });

  // THIS CASE FLIPPED, and the flip is the point of the worker rollup rather than a regression here.
  // It used to assert that an `idle` orchestrator with a `working` worker bands `done`, so the
  // worker was NOT represented and had to be counted on its own. `publishedStatusFor` now promotes
  // such a head to `working` (engine/workerRollup.withWorkerRollupGreen), because the Build column
  // paints its disc green and a folded subtree meant the head was the only row on screen — the two
  // surfaces reporting different bands for the same fleet is the drift this file's header warns
  // about. The head speaks for its subtree now, so the worker IS represented.
  it("an idle orchestrator with a working worker bands RUNNING, and represents it", () => {
    const feed = build([project("p1", [agent("orch"), worker("w1", "orch")])], {
      orch: "idle",
      w1: "working",
    });
    const byId = by(feed);
    expect(byId["orch"]!.band).toBe("running");
    expect(byId["w1"]).toMatchObject({ band: "running", representedElsewhere: true });
  });

  // The mechanism the case above used to demonstrate is unchanged: representation is BAND EQUALITY,
  // not parenthood. Shown here with bands that genuinely differ — the orchestrator is asking you
  // something itself (own red wins over the rollup), so its `needs_you` cannot stand in for the
  // `running` worker underneath it, and the worker still has to be reported.
  it("representation is BAND equality, not parenthood", () => {
    const feed = build([project("p1", [agent("orch"), worker("w1", "orch")])], {
      orch: "waiting",
      w1: "working",
    });
    const byId = by(feed);
    expect(byId["orch"]!.band).toBe("needs_you");
    expect(byId["w1"]).toMatchObject({ band: "running", representedElsewhere: false });
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

// The third state between "has a row" and "invisible", and the one the digest turns on: a worker
// with no row of its own can still be ON SCREEN, nested under a head the sidebar draws. Collapsing
// several of THOSE into one line is safe (reveal the lead and the siblings render beside it);
// collapsing agents with no row anywhere strands all but the lead, which is roborev 53679.
describe("buildConciergeFeed — parentRowId separates 'no row of its own' from 'no row at all'", () => {
  const worker = (id: string, parentId: string | null) => agent(id, { kind: "worker", parentId });
  const by = (feed: ReturnType<typeof buildConciergeFeed>) =>
    Object.fromEntries(flat(feed).map((a) => [a.id, a]));

  it("a worker under a present top-level build agent has a nested row", () => {
    const feed = buildConciergeFeed({
      projects: [project("p1", [agent("orch"), worker("w1", "orch")])],
      status: { orch: "idle", w1: "idle" },
    });
    const byId = by(feed);
    expect(byId["w1"]!.topLevel).toBe(false);
    expect(byId["w1"]!.parentRowId).toBe("orch");
    // A head is a row in its own right, never a nested one — the two fields are exclusive.
    expect(byId["orch"]!.parentRowId).toBeNull();
  });

  it("a parentless worker has no row anywhere", () => {
    const feed = buildConciergeFeed({
      projects: [project("p1", [agent("orch"), worker("w2", null)])],
      status: { orch: "idle", w2: "idle" },
    });
    expect(by(feed)["w2"]!.parentRowId).toBeNull();
  });

  it("a worker whose orchestrator is not in the fleet has no row anywhere", () => {
    const feed = buildConciergeFeed({
      projects: [project("p1", [agent("calm"), worker("w1", "elsewhere")])],
      status: { calm: "idle", w1: "idle" },
    });
    expect(by(feed)["w1"]!.parentRowId).toBeNull();
  });

  it("judged against THIS project's agents — an orchestrator in another project draws no row here", () => {
    // The distinction `representedElsewhere` deliberately does NOT make: a red bubbles across
    // projects, so a faraway orchestrator can speak FOR this worker. It still cannot show it. The
    // sidebar builds `childrenByParent` from one project's agents, so there is no row in this
    // column to nest under, and the worker must keep its own card.
    const feed = buildConciergeFeed({
      projects: [project("p1", [worker("w1", "faraway")]), project("p2", [agent("faraway")])],
      status: { w1: "idle", faraway: "idle" },
    });
    expect(by(feed)["w1"]!.parentRowId).toBeNull();
  });

  it("a worker under a NON-top-level parent has no row — the sidebar only nests under heads", () => {
    // `mid` is a build agent parented to `orch`, so it is not top-level and the sidebar never draws
    // it; a worker hanging off it therefore renders nowhere. Nesting is one level deep by design
    // (`top.kind === "build"` with `childrenByParent.get(top.id)`), not a chain.
    const feed = buildConciergeFeed({
      projects: [
        project("p1", [agent("orch"), agent("mid", { parentId: "orch" }), worker("w1", "mid")]),
      ],
      status: { orch: "idle", mid: "idle", w1: "idle" },
    });
    const byId = by(feed);
    expect(byId["mid"]!.topLevel).toBe(false);
    expect(byId["w1"]!.parentRowId).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WHAT THE COLUMN OWES HIM — the accounting, which is NOT the interruption budget.
//
// FOUNDER'S RULING, 2026-08-05 (bead sparkle-qogah): "We should never hide a row that needs action
// from me." Asked whether "Needs merge" belongs in the concierge's WANTS YOU column — it was
// deliberately excluded, so the column could state "0 Need you" over a fleet with 27 un-landed PRs —
// he answered: "Yes, but as one honest group — one row reading '27 need merge' that expands in
// place. Nothing hidden, count is true, column stays readable."
//
// These tests pin the two halves of that, in the two directions it can fail:
//   • UNDER-REPORTING — the defect. `unmerged` must count. A count that sounds complete while
//     concealing work is worse than no count.
//   • OVER-WIDENING — the other failure. He ruled idle / "Done — your turn" INFORMATIONAL in the
//     same interview, so pulling the rest of the `done` band in would make the number meaningless
//     again, in the other direction.
// ─────────────────────────────────────────────────────────────────────────────
describe("isOwedAction — needs_you PLUS unmerged, and nothing else", () => {
  const withStatus = (status: AgentTabStatus) =>
    isOwedAction({ status, band: bandOfStatus(status) });

  it.each<[AgentTabStatus, boolean]>([
    // Blocking prompts — the founder is the only one who can move these.
    ["waiting", true],
    ["approval", true],
    ["blocked", true],
    ["errored", true],
    // The ruling: un-landed work is an action he owes, even though its BAND is `done`.
    ["unmerged", true],
    // Informational, explicitly. Capping or summarising these is allowed; they are not owed actions.
    ["idle", false],
    ["done", false],
    ["stopped", false],
    ["working", false],
  ])("%s → owed: %s", (status, owed) => {
    expect(withStatus(status)).toBe(owed);
  });

  // The band and the accounting answer DIFFERENT questions about the same agent, and the whole bug
  // was treating them as one. `unmerged` is out of the interruption budget (no nudge card, no tab
  // glow — 27 of those is the card wall) and in the accounting (the column may not say zero).
  it("is deliberately wider than the needs_you band, for unmerged and only unmerged", () => {
    expect(conciergeBand("unmerged")).toBe("done");
    expect(isOwedAction({ status: "unmerged", band: "done" })).toBe(true);
  });
});

describe("owedCounts — the number column one may never under-state", () => {
  /** A fleet of `n` committed-but-unlanded agents and nothing else — the reported shape. */
  const unmergedFleet = (n: number, projectName = "sparkle") =>
    buildConciergeFeed({
      projects: [
        project(
          "p1",
          Array.from({ length: n }, (_, i) => agent(`pr-${i}`)),
          projectName,
        ),
      ],
      status: Object.fromEntries(
        Array.from({ length: n }, (_, i) => [`pr-${i}`, "unmerged" as AgentTabStatus]),
      ),
    });

  // THE DEFECT, stated as the two numbers side by side. `scopedCounts.needs_you` is 0 and that is
  // CORRECT — it is the interruption budget, and landing state must not buy an interruption. What
  // was wrong is that it was the only number the column had, so "0 Need you" was the whole report
  // over twenty-seven PRs sitting un-landed.
  it("counts 27 un-landed agents as work he owes, over a column that reports 0 Need you", () => {
    const feed = unmergedFleet(27);
    expect(feed.scopedCounts.needs_you).toBe(0);
    expect(owedCounts(feed)).toEqual({ needsYou: 0, unmerged: 27, total: 27 });
  });

  it("is never zero while un-landed work exists", () => {
    for (const n of [1, 2, 27, 51]) {
      expect(owedCounts(unmergedFleet(n)).total).toBe(n);
    }
  });

  // Exact, not capped and not rounded: the founder's "count is true". A cap would show here as a
  // total that stops climbing.
  it("states the true total rather than a capped one", () => {
    expect(owedCounts(unmergedFleet(51)).total).toBe(51);
    expect(accountedUnmerged(unmergedFleet(51))).toHaveLength(51);
  });

  // OVER-WIDENING GUARD. Idle / done / stopped are informational — he said so in the same breath.
  it("does not pull idle, done or stopped agents into the count", () => {
    const feed = buildConciergeFeed({
      projects: [project("p1", [agent("a"), agent("b"), agent("c"), agent("d")])],
      status: { a: "idle", b: "done", c: "stopped", d: "working" },
    });
    expect(feed.scopedCounts.done).toBe(3); // they are all still in the feed, banded as before
    expect(owedCounts(feed)).toEqual({ needsYou: 0, unmerged: 0, total: 0 });
    expect(accountedUnmerged(feed)).toEqual([]);
  });

  // Both halves at once, and they are disjoint by construction (`unmerged` bands `done`, never
  // `needs_you`), so `total` is a sum and cannot double-count one agent.
  it("adds the blocking prompts and the un-landed work without double-counting", () => {
    const feed = buildConciergeFeed({
      projects: [project("p1", [agent("ask"), agent("crashed"), agent("m1"), agent("m2")])],
      status: { ask: "waiting", crashed: "errored", m1: "unmerged", m2: "unmerged" },
    });
    expect(owedCounts(feed)).toEqual({ needsYou: 2, unmerged: 2, total: 4 });
  });

  // NO DRIFT. The needs-you half is the same population `scopedCounts.needs_you` counts — one gate
  // (`isAccounted`), applied in both places, rather than two copies that have to be kept in step.
  it("its needs-you half is exactly scopedCounts.needs_you", () => {
    const feed = buildConciergeFeed({
      projects: [
        project("p1", [agent("ask"), agent("boss"), agent("w1", { kind: "worker", parentId: "boss" })]),
        project("p2", [agent("m1"), agent("calm")]),
      ],
      status: { ask: "approval", boss: "idle", w1: "waiting", m1: "unmerged", calm: "idle" },
    });
    expect(owedCounts(feed).needsYou).toBe(feed.scopedCounts.needs_you);
  });

  // THE SAME THREE GATES as every other thing the column surfaces. Muting is the user asking not to
  // be told; a pin is the user narrowing the question. Neither is the column hiding something.
  it("respects the mute gate", () => {
    const feed = buildConciergeFeed({
      projects: [project("p1", [agent("m1"), agent("m2")])],
      status: { m1: "unmerged", m2: "unmerged" },
      shouldInterrupt: (topic) => topic !== "m1",
    });
    expect(owedCounts(feed)).toEqual({ needsYou: 0, unmerged: 1, total: 1 });
  });

  it("respects the pin", () => {
    const feed = buildConciergeFeed({
      projects: [
        project("p1", [agent("m1")]),
        project("p2", [agent("m2")], "other"),
      ],
      status: { m1: "unmerged", m2: "unmerged" },
      pinnedProjectId: "p1",
    });
    expect(owedCounts(feed).unmerged).toBe(1);
    expect(accountedUnmerged(feed).map((a) => a.id)).toEqual(["m1"]);
  });
});

describe("accountedUnmerged — the digest's pool", () => {
  it("hands the agents over in feed order, so the line leads with the one ranked first", () => {
    const feed = buildConciergeFeed({
      projects: [project("p1", [agent("zzz"), agent("aaa")])],
      status: { zzz: "unmerged", aaa: "unmerged" },
    });
    expect(accountedUnmerged(feed).map((a) => a.id)).toEqual(["aaa", "zzz"]);
  });

  // NOT filtered to `topLevel`, unlike the needs-you digest's pool. That filter exists because a
  // `rows` line's count promises the click leaves exactly that many ROWS standing; this line makes
  // no such promise — it expands in place and names every member. Dropping workers here would
  // reintroduce the omission this change exists to remove, for exactly the agents with the least
  // other representation.
  it("includes an un-landed worker, which has no row of its own", () => {
    const feed = buildConciergeFeed({
      projects: [
        project("p1", [agent("boss"), agent("w1", { kind: "worker", parentId: "boss" })]),
      ],
      status: { boss: "working", w1: "unmerged" },
      openAgentIds: ["boss", "w1"],
    });
    expect(accountedUnmerged(feed).map((a) => a.id)).toEqual(["w1"]);
    expect(owedCounts(feed).unmerged).toBe(1);
  });
});

// ── THE DUPLICATED GATE, PINNED ─────────────────────────────────────────────────────────────────
//
// `conciergeProactive.accountedNeedsYou` spells out the same four accounting terms by hand: it
// predates `isAccounted` and lives one layer up. `isAccounted`'s doc asserted the two were "pinned
// equal by test" — they were NOT. `accountedOwed` had zero references outside conciergeFeed.ts, so
// the claim was a comment stating a guarantee nobody had written (roborev 59062).
//
// Two copies of a gate that decides what the column COUNTS and what it SHOWS is exactly how the
// vitals line and the thread came to disagree. Until the hand-written copy delegates, this is the
// thing that makes the claim true.
describe("the two copies of the accounting gate agree", () => {
  const feedWith = (tabs: AgentTab[], status: Record<string, AgentTabStatus>) =>
    buildConciergeFeed({ projects: [project("p1", tabs)], status });

  it("accountedNeedsYou equals accountedOwed's needs-you half, over a mixed fleet", () => {
    const tabs = [
      agent("waiting1"),
      agent("approval1"),
      agent("blocked1"),
      agent("unmerged1"),
      agent("idle1"),
      agent("working1"),
      agent("errored1"),
    ];
    const status: Record<string, AgentTabStatus> = {
      waiting1: "waiting",
      approval1: "approval",
      blocked1: "blocked",
      unmerged1: "unmerged",
      idle1: "idle",
      working1: "working",
      errored1: "errored",
    };
    const feed = feedWith(tabs, status);

    const owedNeedsYou = accountedOwed(feed)
      .filter((a) => conciergeBand(a.status) === "needs_you")
      .map((a) => a.id)
      .sort();
    const needsYou = accountedNeedsYou(feed)
      .map((a) => a.id)
      .sort();

    expect(needsYou).toEqual(owedNeedsYou);
    // Non-vacuous in both directions: the fleet really does contain needs-you rows AND owed rows
    // that are NOT needs-you, so an implementation that returned everything (or nothing) fails.
    expect(needsYou.length).toBeGreaterThan(0);
    expect(accountedOwed(feed).length).toBeGreaterThan(needsYou.length);
  });
});

// ── an all-questions fleet must not read CALM ─────────────────────────────────────────────────
//
// The fourth surface in this change set with one cause. `isOwedAction` NAMED `needs_you`, so when a
// fourth band landed it counted `questions` as calm — and an all-questions fleet made column one
// state "0 Need you" while every agent on it was blocked on the user. Identical in shape to the
// `unmerged` defect this predicate was widened for, entered through the newest band. Derived from
// ASKING_BANDS now, so the fifth band is a decision in engine/buildSections, not another omission.
describe("isOwedAction — the newest asking band counts", () => {
  it("counts a questioning agent as owed", () => {
    expect(isOwedAction({ band: "questions", status: "questions" })).toBe(true);
  });

  it("still counts the red band and un-landed work", () => {
    expect(isOwedAction({ band: "needs_you", status: "waiting" })).toBe(true);
    expect(isOwedAction({ band: "done", status: "unmerged" })).toBe(true);
  });

  // The founder's ruling holds: "Done — your turn" is INFORMATIONAL and may be capped. Widening
  // must not creep into the calm statuses, or the number is meaningless in the other direction.
  it("does not count idle, done or stopped", () => {
    for (const status of ["idle", "done", "stopped"] as const) {
      expect(isOwedAction({ band: "done", status })).toBe(false);
    }
    expect(isOwedAction({ band: "running", status: "working" })).toBe(false);
  });
});
