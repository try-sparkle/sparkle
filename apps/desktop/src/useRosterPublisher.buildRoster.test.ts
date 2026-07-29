import { describe, it, expect } from "vitest";
import { AGENT_STATUS, type AgentTabStatus } from "@sparkle/ui";
import { buildRoster, openProjects } from "./useRosterPublisher";
import { hasLoneSurrogate } from "./services/safeText";
import type { Project } from "./types";

const project: Project = {
  id: "p1", name: "Proj", rootPath: "/p", defaultBranch: "main",
  createdAt: "", agents: [
    { id: "a1", name: "Build", kind: "build", parentId: null,
      promptHistory: [], runtime: "local" } as any,
  ],
  selectedAgentId: null,
};

describe("buildRoster", () => {
  it("joins live status into the roster payload", () => {
    const r = buildRoster([project], { a1: "working" }, {}, {});
    expect(r.projects[0]!.agents[0]!).toMatchObject({
      id: "a1", kind: "build", status: "working", status_color: "#34c759",
    });
  });

  it("defaults unknown status to stopped/grey", () => {
    const r = buildRoster([project], {}, {}, {});
    expect(r.projects[0]!.agents[0]!.status).toBe("stopped");
    expect(r.projects[0]!.agents[0]!.status_color).toBe("#8aa0c4");
  });
});

// The phone and the helper island read this payload and paint a dot from `status_color`. Their whole
// job is a glanceable "what needs me", so relaying a briefless agent's stall-timer `blocked` (RED)
// puts a false alarm on the one surface with no room to explain itself. See
// engine/newAgentAttention.ts; `now` is passed rather than faked.
describe("a spawned-but-never-briefed agent relays as `new`, not red `blocked`", () => {
  const SPAWN = 1_000_000;
  const GREY = "#8aa0c4";
  const RED = "#e0533f";

  /** `over` lets a case add a brief or drop the spawn stamp. */
  const projectWith = (over: Record<string, unknown> = {}): Project => ({
    id: "p1", name: "Proj", rootPath: "/p", defaultBranch: "main",
    createdAt: "", selectedAgentId: null,
    agents: [
      { id: "a1", name: "Build", kind: "build", parentId: null, runtime: "local",
        lastPrompt: "", promptHistory: [], createdAt: SPAWN, ...over } as any,
    ],
  });

  const agent = (p: Project, status: Record<string, any>, now: number) =>
    buildRoster([p], status, {}, {}, now).projects[0]!.agents[0]!;

  it("relays `new` in grey for a briefless agent the stall timer marked blocked", () => {
    const a = agent(projectWith(), { a1: "blocked" }, SPAWN + 60_000);
    expect(a.status).toBe("new");
    expect(a.status_color).toBe(GREY);
  });

  // roborev 55028 (High): the calm correction has to land BEFORE the rollup, not only on the row's
  // own `status`. `rollup_dot` was computed from the RAW map, so this same agent published
  // `status: "new"` (grey) alongside `rollup_dot: "red"` — `rollupDot` returns red the instant
  // `ownBand === "needs_you"`. Consumers that band on `rollup_dot` (roster.rs -> phone, tray
  // island) therefore kept painting the exact false "needs you" the `new` status exists to remove,
  // on the surfaces that change specifically targeted.
  it("also calms the ROLLUP dot, not just the row's own status", () => {
    const a = agent(projectWith(), { a1: "blocked" }, SPAWN + 60_000);
    expect(a.status).toBe("new");
    expect(a.rollup_dot).not.toBe("red");
  });

  it("does not let a briefless WORKER's uncalmed red bubble into its parent's dot", () => {
    // The same raw map fed `workersByParent`, so the bug also reached heads: a briefless worker
    // turned its orchestrator's dot red even though the worker itself relayed grey `new`.
    const p: Project = {
      id: "p1", name: "Proj", rootPath: "/p", defaultBranch: "main",
      createdAt: "", selectedAgentId: null,
      agents: [
        // `lastPrompt` is what marks an agent BRIEFED (see the `projectWith({ lastPrompt })` case
        // below); `promptHistory` holds composer entries, not bare strings.
        { id: "head", name: "Head", kind: "build", parentId: null, runtime: "local",
          lastPrompt: "build it", promptHistory: [], createdAt: SPAWN } as any,
        { id: "w1", name: "W", kind: "worker", parentId: "head", runtime: "local",
          lastPrompt: "", promptHistory: [], createdAt: SPAWN } as any,
      ],
    };
    const rows = buildRoster([p], { head: "idle", w1: "blocked" }, {}, {}, SPAWN + 60_000)
      .projects[0]!.agents;
    const head = rows.find((r) => r.id === "head")!;
    const worker = rows.find((r) => r.id === "w1")!;
    expect(worker.status).toBe("new");
    expect(head.rollup_dot).not.toBe("red");
  });

  it("STILL relays red when that agent actually asks something", () => {
    const a = agent(projectWith(), { a1: "waiting" }, SPAWN + 60_000);
    expect(a.status).toBe("waiting");
    expect(a.status_color).toBe(RED);
  });

  it("STILL relays red `blocked` for a BRIEFED agent", () => {
    const a = agent(projectWith({ lastPrompt: "build it" }), { a1: "blocked" }, SPAWN + 60_000);
    expect(a.status).toBe("blocked");
    expect(a.status_color).toBe(RED);
  });

  it("leaves a legacy row with no spawn stamp exactly as it was", () => {
    const a = agent(projectWith({ createdAt: undefined }), { a1: "blocked" }, SPAWN + 60_000);
    expect(a.status).toBe("blocked");
    expect(a.status_color).toBe(RED);
  });
});

// Regression guard for the `publish_window_roster failed unexpected end of hex escape` flood.
// recentPrompts caps each prompt at 80 chars. A naive UTF-16 `slice(0, 80)` cuts a non-BMP
// character's surrogate pair in half, leaving a lone leading surrogate that serde_json refuses to
// parse on the Rust side — so the invoke rejected on EVERY republish (348 times in one day).
describe("roster payload is always well-formed UTF-16 (hex-escape regression)", () => {
  /** An agent whose last prompt puts a 🎉 exactly astride the 80-char truncation boundary. */
  function agentWithPrompt(text: string) {
    return {
      id: "a1", name: "Build", kind: "build", parentId: null, runtime: "local",
      promptHistory: [{ id: "p1", text, at: 1, source: "composer" }],
    } as any;
  }

  function rosterFor(text: string) {
    const p: Project = {
      id: "p1", name: "Proj", rootPath: "/p", defaultBranch: "main",
      createdAt: "", agents: [agentWithPrompt(text)], selectedAgentId: null,
    };
    return buildRoster([p], { a1: "working" }, {}, {});
  }

  it("does not emit a lone surrogate when an emoji straddles the 80-char cap", () => {
    // Code units 79 and 80 are the 🎉 pair — precisely where slice(0, 80) used to cut.
    const prompt = "x".repeat(79) + "\u{1F389}" + " and more text after the emoji";
    const r = rosterFor(prompt);
    const carried = r.projects[0]!.agents[0]!.recent_prompts![0]!.text;

    expect(hasLoneSurrogate(carried)).toBe(false);
    // The exact wire text that used to reach serde_json: no half-escape of a surrogate.
    expect(JSON.stringify(carried)).not.toMatch(/\\ud[89ab][0-9a-f]{2}/i);
    // The whole payload survives a JSON round-trip, which is what the IPC actually does.
    expect(() => JSON.parse(JSON.stringify(r))).not.toThrow();
  });

  it("repairs a prompt that arrives already malformed", () => {
    // Not our truncation's fault — a lone surrogate pasted/scraped into the prompt itself.
    const r = rosterFor("broken \uD83C tail");
    expect(hasLoneSurrogate(r.projects[0]!.agents[0]!.recent_prompts![0]!.text)).toBe(false);
  });

  it("still carries a short emoji prompt intact", () => {
    const r = rosterFor("ship it \u{1F389}");
    expect(r.projects[0]!.agents[0]!.recent_prompts![0]!.text).toBe("ship it \u{1F389}");
  });

  /** A project carrying one agent, ready to be corrupted field-by-field. */
  function projectFixture(): Project {
    return {
      id: "p1", name: "Proj", rootPath: "/p", defaultBranch: "main",
      createdAt: "", agents: [agentWithPrompt("hi")], selectedAgentId: null,
    };
  }

  // The invoke is all-or-nothing: serde_json parses the WHOLE args blob, so a lone surrogate in ANY
  // string field rejects the entire roster — not just the field that carried it. Guarding only the
  // two fields we happened to truncate (agent name, prompt text) left the same flood reachable via
  // every other string on the payload, so each one is asserted here.
  it.each([
    ["project name", (p: Project) => { p.name = "Proj \uD83C"; }],
    ["agent name", (p: Project) => { (p.agents[0] as { name: string }).name = "Build \uDC00"; }],
    ["project id", (p: Project) => { p.id = "p1\uD83D"; }],
    ["agent id", (p: Project) => { (p.agents[0] as { id: string }).id = "a1\uD83D"; }],
    ["prompt id", (p: Project) => {
      (p.agents[0] as { promptHistory: unknown[] }).promptHistory = [
        { id: "pid\uD83E", text: "hi", at: 1, source: "composer" },
      ];
    }],
  ])("repairs a lone surrogate in the %s", (_label, corrupt) => {
    const p = projectFixture();
    corrupt(p);
    const r = buildRoster([p], { [p.agents[0]!.id]: "working" }, {}, {});
    const wire = JSON.stringify(r);
    expect(hasLoneSurrogate(wire)).toBe(false);
    expect(wire).not.toMatch(/\\ud[89ab][0-9a-f]{2}/i);
  });

  // workflow_stage is joined in from a separate store keyed by agent id, so it never passed through
  // the truncation path the original fix guarded.
  it("repairs a lone surrogate in workflow_stage", () => {
    const r = buildRoster([projectFixture()], { a1: "working" }, { a1: "review \uD83D" }, {});
    expect(hasLoneSurrogate(r.projects[0]!.agents[0]!.workflow_stage!)).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/\\ud[89ab][0-9a-f]{2}/i);
  });

  // The sweep must repair, not mangle: well-formed emoji and non-string fields survive untouched.
  it("leaves a well-formed payload intact", () => {
    const p = projectFixture();
    p.name = "Proj \u{1F680}";
    const r = buildRoster([p], { a1: "working" }, { a1: "review" }, {});
    const agent = r.projects[0]!.agents[0]!;
    expect(r.projects[0]!.name).toBe("Proj \u{1F680}");
    expect(agent.workflow_stage).toBe("review");
    expect(agent.parent_id).toBeNull();
    expect(agent.last_activity_at).toBe(1);
    expect(agent.status_color).toBe("#34c759");
  });
});

// THE HEAD ROW'S DOT REPORTS ITS SUBTREE. `status` is the agent's OWN PTY state, and for an
// orchestrator that is almost never the interesting fact: a head sits `idle` between delegations
// while nine workers grind, and it sits `idle` while a worker is blocked on a question. Publishing
// only the own-status made every consumer of this payload — the phone, the tray island, the
// concierge's cross-window feed — render a busy or blocked orchestrator as a calm grey row, with
// no way to tell it from a dead one. `rollup_dot` carries the engine/workerRollup answer alongside
// the own-status so both facts are on the wire and neither is redefined.
describe("buildRoster — rollup_dot summarizes the workers folded under a head", () => {
  /** A project with one head and the given worker statuses. */
  function headWithWorkers(workerStatuses: Record<string, AgentTabStatus>): Project {
    return {
      id: "p1", name: "Proj", rootPath: "/p", defaultBranch: "main", createdAt: "",
      agents: [
        { id: "head", name: "Orchestrator", kind: "build", parentId: null,
          promptHistory: [], runtime: "local" },
        ...Object.keys(workerStatuses).map((id) => ({
          id, name: id, kind: "worker", parentId: "head", promptHistory: [], runtime: "local",
        })),
      ] as unknown as Project["agents"],
      selectedAgentId: null,
    };
  }
  const dotOf = (r: ReturnType<typeof buildRoster>, id: string) =>
    r.projects[0]!.agents.find((a) => a.id === id)!.rollup_dot;

  it("does not publish a calm dot for an idle head whose worker is BLOCKED", () => {
    // The motivating shape: nothing is red about the head itself, so `status` says "idle" and the
    // row renders grey — while the only row that disagrees is folded out of sight.
    const r = buildRoster(
      [headWithWorkers({ w1: "blocked" })],
      { head: "idle", w1: "blocked" },
      {}, {},
    );
    expect(dotOf(r, "head")).toBe("red");
    // The own-status is untouched — this is an ADDED fact, not a redefinition.
    expect(r.projects[0]!.agents[0]!.status).toBe("idle");
    expect(r.projects[0]!.agents[0]!.status_color).toBe(AGENT_STATUS.idle.color);
  });

  it("does not publish grey for an idle head with WORKING children", () => {
    const workers = Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [`w${i}`, "working" as AgentTabStatus]),
    );
    const r = buildRoster(
      [headWithWorkers(workers)],
      { head: "idle", ...workers },
      {}, {},
    );
    expect(dotOf(r, "head")).toBe("green");
    expect(r.projects[0]!.agents[0]!.status).toBe("idle");
  });

  it("publishes orange when the subtree disagrees — some running, some needing you", () => {
    const r = buildRoster(
      [headWithWorkers({ w1: "working", w2: "waiting" })],
      { head: "idle", w1: "working", w2: "waiting" },
      {}, {},
    );
    expect(dotOf(r, "head")).toBe("orange");
  });

  it("keeps the head's OWN red when it is the one asking — healthy workers never paint over it", () => {
    const r = buildRoster(
      [headWithWorkers({ w1: "working" })],
      { head: "approval", w1: "working" },
      {}, {},
    );
    expect(dotOf(r, "head")).toBe("red");
  });

  it("leaves a WORKER row reporting only itself — it has no subtree to summarize", () => {
    const r = buildRoster(
      [headWithWorkers({ w1: "working", w2: "waiting" })],
      { head: "idle", w1: "working", w2: "waiting" },
      {}, {},
    );
    expect(dotOf(r, "w1")).toBe("green");
    expect(dotOf(r, "w2")).toBe("red");
  });

  it("leaves a CHILDLESS row reporting only itself", () => {
    // `project` is the single-agent fixture at the top of this file.
    expect(dotOf(buildRoster([project], { a1: "working" }, {}, {}), "a1")).toBe("green");
    expect(dotOf(buildRoster([project], { a1: "idle" }, {}, {}), "a1")).toBe("gray");
    expect(dotOf(buildRoster([project], {}, {}, {}), "a1")).toBe("gray"); // defaulted "stopped"
  });

  it("rolls up per parent, not across the whole payload", () => {
    // Two heads in two projects: one busy subtree must not tint the other's dot.
    const busy = headWithWorkers({ w1: "working" });
    const calm: Project = {
      id: "p2", name: "Calm", rootPath: "/c", defaultBranch: "main", createdAt: "",
      agents: [
        { id: "head2", name: "Head2", kind: "build", parentId: null,
          promptHistory: [], runtime: "local" },
        { id: "w9", name: "w9", kind: "worker", parentId: "head2",
          promptHistory: [], runtime: "local" },
      ] as unknown as Project["agents"],
      selectedAgentId: null,
    };
    const r = buildRoster([busy, calm], { head: "idle", w1: "working", head2: "idle", w9: "done" }, {}, {});
    expect(r.projects[0]!.agents[0]!.rollup_dot).toBe("green");
    expect(r.projects[1]!.agents[0]!.rollup_dot).toBe("gray");
  });

  it("survives the sanitize sweep as a plain string (it crosses the same JSON boundary)", () => {
    const r = buildRoster([headWithWorkers({ w1: "blocked" })], { head: "idle", w1: "blocked" }, {}, {});
    expect(JSON.parse(JSON.stringify(r)).projects[0].agents[0].rollup_dot).toBe("red");
  });
});

// The OPEN-PROJECT predicate. The single-window shell made "open" ambiguous — every project has a
// tab — and the first cut simply published `projects`, i.e. the whole persisted store: every folder
// ever added, each agent carrying up to four real prompt snippets, pushed to the phone relay on
// every status tick (roborev 46258-M1). These pin the restored meaning.
describe("openProjects — what \"open\" means in the single-window shell", () => {
  const withAgents = (id: string, agentIds: string[]): Project => ({
    id, name: id, rootPath: `/${id}`, defaultBranch: "main", createdAt: "",
    agents: agentIds.map((aid) => ({
      id: aid, name: aid, kind: "build", parentId: null, promptHistory: [], runtime: "local",
    })) as unknown as Project["agents"],
    selectedAgentId: null,
  });
  const live = withAgents("live", ["a1"]);
  const dormant = withAgents("dormant", ["a2"]);
  const emptyButVisited = withAgents("visited", []);
  const none = () => false;

  it("keeps a project with a live agent", () => {
    expect(openProjects([live, dormant], ["a1"], none).map((p) => p.id)).toEqual(["live"]);
  });

  it("keeps a project the user has SELECTED this session, even with nothing running", () => {
    const visited = (id: string) => id === "visited";
    expect(openProjects([emptyButVisited, dormant], [], visited).map((p) => p.id)).toEqual([
      "visited",
    ]);
  });

  it("drops a project that was never opened and has nothing running — prompts stay home", () => {
    // The regression this exists for: `dormant` is in the store (it is in Recent) and its agent
    // carries prompt text. Nothing about it may leave the machine.
    expect(openProjects([dormant], [], none)).toEqual([]);
  });

  it("is empty when the store is full but the session is fresh", () => {
    expect(openProjects([live, dormant], [], none)).toEqual([]);
  });
});
