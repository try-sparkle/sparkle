import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  closeScopeProjectNames,
  killAllOpenAgents,
  planWindowClose,
  projectsWithOpenAgents,
  stopAgentsForClose,
  stopOpenProjectAgents,
} from "./windowClose";
import { resetPaneReadiness, setPaneFailed, setPaneReady } from "./paneReadiness";
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

  // `pty_kill` now holds each PTY open until its SessionEnd hook line lands, bounded at 750ms — and
  // a TIMEOUT is the ordinary shape for an agent whose Claude Code child already exited (it still
  // has a hook log, so the Rust side waits out the full deadline for a line that never comes).
  // Awaited one-at-a-time that is N × 750ms of a hung window with the prompt already dismissed.
  //
  // Asserted by START ORDER, not by elapsed time, so it is deterministic and clock-free: every kill
  // must be IN FLIGHT before any of them is allowed to resolve. The sequential version reaches only
  // the first, so it reds here rather than merely running slower.
  it("kills the agents CONCURRENTLY, so a slow PTY drain does not multiply by agent count", async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const kill = vi.fn(async (id: string) => {
      started.push(id);
      await gate;
    });
    const close = vi.fn();

    const sweep = stopOpenProjectAgents(project, new Set(["a1", "a2"]), { kill, close }, live);
    await Promise.resolve(); // let any microtask-deferred starts land

    expect(started).toEqual(["a1", "a2"]);
    // Nothing resolved yet, so this is genuinely "both in flight" rather than "both finished fast".
    expect(close).not.toHaveBeenCalled();

    release();
    await sweep;
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

// THE CATASTROPHE GUARD (sparkle-9ch9i): the close prompt used to fire the fleet-wide kill whenever
// the plan carried `killAgents`, INCLUDING the plans that only HIDE the window. Closing the main
// window while another window kept the app alive therefore stopped every project's agents across the
// whole fleet — 80+ agents in one second — while the app itself never went away. `stopAgentsForClose`
// is the gate that makes a hidden window incapable of stopping agents it does not own.
describe("stopAgentsForClose — the fleet-wide kill only fires when the app actually goes down", () => {
  const destroyAndKill = { killAgents: true, hide: false, clearRegistry: true };
  const hideAndKill = { killAgents: true, hide: true, clearRegistry: false };
  const hideAndKeep = { killAgents: false, hide: true, clearRegistry: false };

  it("stops EVERY open project's agents on a real quit (destroy, not hide)", async () => {
    const kill = vi.fn(async () => {});
    const close = vi.fn();
    await stopAgentsForClose(destroyAndKill, [alpha, beta, dormant], ["a1", "b1"], { kill, close }, live);
    // The app is exiting, so the deliberate single-window behaviour still holds: reach both running
    // projects (so neither resurrects next launch), and leave the untouched project alone.
    expect(kill.mock.calls.flat()).toEqual(["a1", "b1"]);
    expect(close.mock.calls.flat()).toEqual(["a1", "b1"]);
    expect(kill).not.toHaveBeenCalledWith("c1");
  });

  it("stops NOTHING when the window merely HIDES — the app stays alive, so the fleet keeps running", async () => {
    // This is the exact regression: `killAgents` is set AND agents are live, but the window is only
    // hiding. Under the pre-fix `if (plan.killAgents)` this killed a1 and b1 across two projects with
    // the app still up. The gate must leave the whole fleet untouched.
    const kill = vi.fn(async () => {});
    const close = vi.fn();
    await stopAgentsForClose(hideAndKill, [alpha, beta, dormant], ["a1", "b1"], { kill, close }, live);
    expect(kill).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("stops nothing on a plain keep-alive hide (no kill requested)", async () => {
    const kill = vi.fn(async () => {});
    await stopAgentsForClose(hideAndKeep, [alpha, beta], ["a1", "b1"], { kill, close: vi.fn() }, live);
    expect(kill).not.toHaveBeenCalled();
  });
});

// CLOSING ONE PROJECT MUST NEVER REACH ANOTHER (sparkle-9ch9i). The per-project teardown is what a
// project-scoped close (ProjectModal move/remove, a satellite handing its project back) runs, and it
// must be structurally incapable of touching a sibling project's agents or the app-owned agents
// (the concierge and the Improve-Sparkle agent), even when their ids sit in the same global open set.
describe("stopOpenProjectAgents is scoped to ONE project — siblings and the concierge survive", () => {
  it("closing Alpha stops only Alpha's agents; Beta's agent and the concierge are untouched", async () => {
    const kill = vi.fn(async () => {});
    const close = vi.fn();
    // The open set is GLOBAL: it holds Beta's live agent and the app-owned Sparkle/concierge agent
    // alongside Alpha's. A project-scoped close must ignore everything that is not Alpha's.
    await stopOpenProjectAgents(
      alpha,
      new Set(["a1", "a2", "b1", "__sparkle_self__"]),
      { kill, close },
      live,
    );
    expect(kill.mock.calls.flat().sort()).toEqual(["a1", "a2"]);
    // Beta belongs to a DIFFERENT project the user did not close…
    expect(kill).not.toHaveBeenCalledWith("b1");
    expect(close).not.toHaveBeenCalledWith("b1");
    // …and the concierge / Improve-Sparkle agent is not a project agent at all, so a project close
    // must never be able to stop it.
    expect(kill).not.toHaveBeenCalledWith("__sparkle_self__");
    expect(close).not.toHaveBeenCalledWith("__sparkle_self__");
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

// Everything above injects `isLive`, which keeps the invariants pane-free but leaves the PRODUCTION
// default — the one the app actually ships — completely uncovered. These drive real paneReadiness
// state and omit the argument, so `defaultIsLive`'s own rules are the thing under test (roborev
// 47018/49297).
describe("defaultIsLive — the shipped rule, driven by real pane readiness", () => {
  const alpha = {
    id: "p1", name: "Alpha", agents: [{ id: "a1" }],
  } as unknown as Project;

  beforeEach(() => resetPaneReadiness());
  afterEach(() => resetPaneReadiness());

  /** The states that mean "no process": the pane gave up, or was never mounted at all. Shared by
   *  both tables below so a third such state gets added in one place (roborev 53044). */
  const noProcessPanes = [
    ["failed", (): void => setPaneFailed("a1")],
    ["unmounted", (): void => undefined],
  ] as const;

  it.each([
    ["ready", (): void => setPaneReady("a1", true)],
    ["starting", (): void => setPaneReady("a1", false)],
  ] as const)("a %s pane HAS a process, so it is in scope and gets swept", async (_state, arrange) => {
    arrange();
    expect(projectsWithOpenAgents([alpha], ["a1"])).toEqual([alpha]);
    // The close prompt names it — the positive half of the "still running?" copy.
    expect(closeScopeProjectNames([alpha], ["a1"], "p1")).toEqual(["Alpha"]);
    const kill = vi.fn(async () => {});
    const close = vi.fn();
    await killAllOpenAgents([alpha], ["a1"], { kill, close });
    expect(kill).toHaveBeenCalledWith("a1");
    // …and it is dropped from the open set. Killing the PTY but skipping `close` would leave the
    // agent to silently resume next launch — the mirror of the bug the negative case guards.
    expect(close).toHaveBeenCalledWith("a1");
  });

  // killAllOpenAgents pre-filters through projectsWithOpenAgents, so the guard INSIDE
  // stopOpenProjectAgents is never the deciding check up there. The single-project close path calls
  // it directly, so cover its own default separately (roborev 52978) — for BOTH no-process states.
  // `unmounted` matters most: the never-mounted agent is the original bug (roborev 46319), and it
  // otherwise reaches this guard only through the sweep's pre-filter (roborev 53018).
  it.each(noProcessPanes)(
    "stopOpenProjectAgents applies the default rule itself for a %s pane, not just via the sweep's pre-filter",
    async (_state, arrange) => {
      arrange();
      const kill = vi.fn(async () => {});
      const close = vi.fn();
      await stopOpenProjectAgents(alpha, new Set(["a1"]), { kill, close });
      expect(kill).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
    },
  );

  it.each(noProcessPanes)("a %s pane has NO process — out of scope, and the sweep leaves it alone", async (_state, arrange) => {
    arrange();
    // The "still running?" warning must not name it, and the sweep must not drop it from the open
    // set: `failed` never spawned, so there is nothing to stop and removing it would silently
    // prevent its resume next launch.
    expect(projectsWithOpenAgents([alpha], ["a1"])).toEqual([]);
    expect(closeScopeProjectNames([alpha], ["a1"], "p1")).toEqual([]);
    const kill = vi.fn(async () => {});
    const close = vi.fn();
    await killAllOpenAgents([alpha], ["a1"], { kill, close });
    expect(kill).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("a Retry that republishes readiness puts a previously-failed pane back in scope", async () => {
    setPaneFailed("a1");
    expect(projectsWithOpenAgents([alpha], ["a1"])).toEqual([]);
    setPaneReady("a1", false); // Retry re-entered the prepare flow: a process exists again
    expect(projectsWithOpenAgents([alpha], ["a1"])).toEqual([alpha]);
  });
});
