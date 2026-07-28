import { describe, it, expect } from "vitest";
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
