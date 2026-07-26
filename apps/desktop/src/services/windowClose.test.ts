import { describe, it, expect, vi } from "vitest";
import {
  closeScopeProjectNames,
  killAllOpenAgents,
  planWindowClose,
  projectsWithOpenAgents,
  stopOpenProjectAgents,
} from "./windowClose";
import type { Project } from "../types";

const project = {
  id: "p1",
  name: "P",
  rootPath: "/p",
  defaultBranch: null,
  createdAt: "",
  lastOpenedAt: "",
  selectedAgentId: null,
  agents: [{ id: "a1" }, { id: "a2" }],
} as unknown as Project;

// The production default derives "live" from paneReadiness (a never-mounted agent has no pane and
// no process — roborev 46319); tests inject it so the pure invariants stay clock/pane-free.
const live = () => true;

describe("stopOpenProjectAgents", () => {
  it("kills and unmounts the OPEN agents only", async () => {
    const kill = vi.fn(async () => {});
    const close = vi.fn();
    await stopOpenProjectAgents(project, new Set(["a1"]), { kill, close }, live);
    expect(kill).toHaveBeenCalledWith("a1");
    expect(close).toHaveBeenCalledWith("a1");
    // a2 is closed: no PTY to kill, and reaching it would be deleting a tab the user never opened.
    expect(kill).not.toHaveBeenCalledWith("a2");
    expect(close).not.toHaveBeenCalledWith("a2");
  });

  it("swallows a PTY kill error and still unmounts the agent", async () => {
    const kill = vi.fn(async () => {
      throw new Error("gone");
    });
    const close = vi.fn();
    await stopOpenProjectAgents(project, new Set(["a1", "a2"]), { kill, close }, live);
    expect(close).toHaveBeenCalledWith("a1");
    expect(close).toHaveBeenCalledWith("a2");
  });
});

describe("planWindowClose", () => {
  // Signature: planWindowClose(mode, isLast, isMain)
  it("keep + last → hide (headless survival), keep agents + registry", () => {
    expect(planWindowClose("keep", true, false)).toEqual({
      killAgents: false,
      hide: true,
      clearRegistry: false,
    });
  });

  it("secondary keep + not last → destroy + clear registry, agents survive", () => {
    expect(planWindowClose("keep", false, false)).toEqual({
      killAgents: false,
      hide: false,
      clearRegistry: true,
    });
  });

  it("secondary kill → destroy + clear registry + kill agents", () => {
    expect(planWindowClose("kill", false, false)).toEqual({
      killAgents: true,
      hide: false,
      clearRegistry: true,
    });
  });

  it("MAIN window while others remain → hide (never destroyed), keep registry", () => {
    // Both keep and kill hide the main window when it isn't last (it hosts Sparkle + the "main"
    // label). kill still tears down its agents.
    expect(planWindowClose("keep", false, true)).toEqual({
      killAgents: false,
      hide: true,
      clearRegistry: false,
    });
    expect(planWindowClose("kill", false, true)).toEqual({
      killAgents: true,
      hide: true,
      clearRegistry: false,
    });
  });

  it("main window that IS last → destroy on kill (app quits), hide on keep", () => {
    expect(planWindowClose("kill", true, true)).toEqual({
      killAgents: true,
      hide: false,
      clearRegistry: true,
    });
    expect(planWindowClose("keep", true, true)).toEqual({
      killAgents: false,
      hide: true,
      clearRegistry: false,
    });
  });
});

// SINGLE-WINDOW SHELL (CM-U7): one window hosts every project as a tab, so "Kill agents & close"
// has to reach every project with live agents — not just the tab in front (roborev 46248-H1).
const alpha = {
  id: "p1", name: "Alpha", rootPath: "/a", defaultBranch: null, createdAt: "",
  selectedAgentId: null, agents: [{ id: "a1" }, { id: "a2" }],
} as unknown as Project;
const beta = {
  id: "p2", name: "Beta", rootPath: "/b", defaultBranch: null, createdAt: "",
  selectedAgentId: null, agents: [{ id: "b1" }],
} as unknown as Project;
const dormant = {
  id: "p3", name: "Dormant", rootPath: "/c", defaultBranch: null, createdAt: "",
  selectedAgentId: null, agents: [{ id: "c1" }],
} as unknown as Project;

describe("projectsWithOpenAgents", () => {
  it("keeps every project with at least one agent in the open set", () => {
    const out = projectsWithOpenAgents([alpha, beta, dormant], ["a2", "b1"], live);
    expect(out.map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  it("drops projects whose agents are all closed (nothing to kill there)", () => {
    expect(projectsWithOpenAgents([alpha, dormant], ["a1"], live).map((p) => p.id)).toEqual(["p1"]);
  });

  it("is empty when nothing is open", () => {
    expect(projectsWithOpenAgents([alpha, beta], [], live)).toEqual([]);
  });

  it("ignores open ids that belong to no project (e.g. the app-owned Sparkle agent)", () => {
    expect(projectsWithOpenAgents([alpha], ["__sparkle_self__"], live)).toEqual([]);
  });
});

describe("closeScopeProjectNames", () => {
  it("puts the FRONT project first, then the other running ones", () => {
    expect(closeScopeProjectNames([alpha, beta], ["a1", "b1"], "p2", live)).toEqual(["Beta", "Alpha"]);
  });

  it("omits the front project when nothing in it is running", () => {
    expect(closeScopeProjectNames([alpha, beta], ["b1"], "p1", live)).toEqual(["Beta"]);
  });

  it("is empty when nothing is running (the prompt then names no project)", () => {
    expect(closeScopeProjectNames([alpha, beta], [], "p1", live)).toEqual([]);
  });
});

describe("killAllOpenAgents", () => {
  it("stops EVERY open project's open agents, not just the first project's", async () => {
    const kill = vi.fn(async () => {});
    const close = vi.fn();
    await killAllOpenAgents([alpha, beta, dormant], ["a1", "b1"], { kill, close }, live);
    // Both projects with a live agent are reached…
    expect(kill.mock.calls.flat()).toEqual(["a1", "b1"]);
    expect(close.mock.calls.flat()).toEqual(["a1", "b1"]);
    // …Alpha's CLOSED agent is not touched (roborev 46291-M2: the sweep must not reach tabs the
    // user never opened)…
    expect(kill).not.toHaveBeenCalledWith("a2");
    // …and the project nobody opened is left completely alone.
    expect(kill).not.toHaveBeenCalledWith("c1");
  });

  it("does nothing when no agent is open", async () => {
    const kill = vi.fn(async () => {});
    await killAllOpenAgents([alpha, beta], [], { kill, close: vi.fn() }, live);
    expect(kill).not.toHaveBeenCalled();
  });
});

describe("never-mounted agents (lazy panes — roborev 46319)", () => {
  const alpha = {
    id: "p1", name: "Alpha", agents: [{ id: "a1" }, { id: "a2" }],
  } as unknown as Project;

  it("scope + sweep skip open-but-never-mounted agents, leaving them to resume next launch", async () => {
    const mountedOnly = (id: string) => id === "a1";
    // a2 is open but was never mounted this session: not "running", so not in the scope…
    expect(projectsWithOpenAgents([alpha], ["a2"], mountedOnly)).toEqual([]);
    expect(closeScopeProjectNames([alpha], ["a2"], "p1", mountedOnly)).toEqual([]);
    // …and the sweep must not kill it or drop it from the open set.
    const kill = vi.fn(async () => {});
    const close = vi.fn();
    await killAllOpenAgents([alpha], ["a1", "a2"], { kill, close }, mountedOnly);
    expect(kill).toHaveBeenCalledWith("a1");
    expect(close).toHaveBeenCalledWith("a1");
    expect(kill).not.toHaveBeenCalledWith("a2");
    expect(close).not.toHaveBeenCalledWith("a2");
  });
});
