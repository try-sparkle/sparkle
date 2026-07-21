import { describe, it, expect, beforeEach } from "vitest";
import { buildRoster, windowProjects } from "./useRosterPublisher";
import { setWindowProject, resetWindowRegistry } from "./services/windowRegistry";
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
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(r.projects[0]!.agents[0]!).toMatchObject({
      id: "a1", kind: "build", status: "working", status_color: "#34c759",
    });
  });

  it("defaults unknown status to stopped/grey", () => {
    const r = buildRoster([project], {}, {}, {});
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(r.projects[0]!.agents[0]!.status).toBe("stopped");
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
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
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
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
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(hasLoneSurrogate(r.projects[0]!.agents[0]!.recent_prompts![0]!.text)).toBe(false);
  });

  it("still carries a short emoji prompt intact", () => {
    const r = rosterFor("ship it \u{1F389}");
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
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
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const r = buildRoster([p], { [p.agents[0]!.id]: "working" }, {}, {});
    const wire = JSON.stringify(r);
    expect(hasLoneSurrogate(wire)).toBe(false);
    expect(wire).not.toMatch(/\\ud[89ab][0-9a-f]{2}/i);
  });

  // workflow_stage is joined in from a separate store keyed by agent id, so it never passed through
  // the truncation path the original fix guarded.
  it("repairs a lone surrogate in workflow_stage", () => {
    const r = buildRoster([projectFixture()], { a1: "working" }, { a1: "review \uD83D" }, {});
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(hasLoneSurrogate(r.projects[0]!.agents[0]!.workflow_stage!)).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/\\ud[89ab][0-9a-f]{2}/i);
  });

  // The sweep must repair, not mangle: well-formed emoji and non-string fields survive untouched.
  it("leaves a well-formed payload intact", () => {
    const p = projectFixture();
    p.name = "Proj \u{1F680}";
    const r = buildRoster([p], { a1: "working" }, { a1: "review" }, {});
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const agent = r.projects[0]!.agents[0]!;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(r.projects[0]!.name).toBe("Proj \u{1F680}");
    expect(agent.workflow_stage).toBe("review");
    expect(agent.parent_id).toBeNull();
    expect(agent.last_activity_at).toBe(1);
    expect(agent.status_color).toBe("#34c759");
  });
});

// Regression guard for the window-scoping fix (roborev 19166):
// publishWindowRoster must only receive THIS window's projects — not projects open in other
// windows — otherwise cross-window agents are mis-reported as "stopped" (DEFAULT_STATUS) and
// the last-writer-wins merge in tray.rs corrupts the red/grey/green counts.
describe("window-scoping: only publish this window's projects to the tray", () => {
  const projectA: Project = {
    id: "pA", name: "ProjA", rootPath: "/a", defaultBranch: "main",
    createdAt: "", agents: [
      { id: "aA", name: "Agent A", kind: "build", parentId: null,
        promptHistory: [], runtime: "local" } as any,
    ],
    selectedAgentId: null,
  };
  const projectB: Project = {
    id: "pB", name: "ProjB", rootPath: "/b", defaultBranch: "main",
    createdAt: "", agents: [
      { id: "aB", name: "Agent B", kind: "build", parentId: null,
        promptHistory: [], runtime: "local" } as any,
    ],
    selectedAgentId: null,
  };

  beforeEach(() => {
    resetWindowRegistry();
    setWindowProject("win-A", "pA");
    setWindowProject("win-B", "pB");
  });

  it("windowProjects returns only the given window's projects", () => {
    // windowProjects is the real exported predicate used by the hook — calling it here
    // means a regression in the production filter (e.g. revert to != null) will fail this test.
    const allOpen = [projectA, projectB];
    const mine = windowProjects(allOpen, "win-A");
    expect(mine.map((p) => p.id)).toEqual(["pA"]);

    // buildRoster on the scoped list: only win-A's agent appears, with correct status.
    const r = buildRoster(mine, { aA: "working", aB: "waiting" }, {}, {});
    expect(r.projects).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(r.projects[0]!.agents[0]!).toMatchObject({ id: "aA", status: "working" });
  });

  it("without scoping, the other window's agent would get DEFAULT_STATUS (the bug)", () => {
    // Demonstrates what the bug looked like: win-B builds a roster from all open projects
    // but only has status for its own agents — win-A's agent falls through to stopped/grey.
    const allOpen = [projectA, projectB];
    const r = buildRoster(allOpen, { aB: "waiting" }, {}, {}); // win-B's statuses only
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(r.projects.find((p) => p.id === "pA")!.agents[0]!.status).toBe("stopped"); // corrupted!
    // After scoping via windowProjects: win-B's slice excludes pA entirely.
    const fixed = buildRoster(windowProjects(allOpen, "win-B"), { aB: "waiting" }, {}, {});
    expect(fixed.projects.map((p) => p.id)).toEqual(["pB"]);
  });
});
