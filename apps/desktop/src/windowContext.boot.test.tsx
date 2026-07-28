// @vitest-environment jsdom
//
// `AppBoot`'s cold-start hygiene, which stopped being a formality once satellites existed.
//
// Both durable maps it touches — the label→project window registry and the satellite ownership map —
// are written by satellites as well as by main, and only on the SATELLITE's own mount. This effect
// runs on every mount of `<App/>`: the error card's "Reload UI" remounts the tree, and so does HMR.
// A main-window reload therefore used to erase rows for windows that were still on screen, which
// cost a duplicated PTY (ownership) and misrouted capture-sends (registry).
//
// The pure helpers are tested next to their modules. What is only testable HERE is the wiring:
// that boot PRUNES rather than wipes, and that a failed liveness query is not read as "nothing is
// live".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

// A FACTORY, not a stored promise. A pre-built `Promise.reject(...)` sitting in a variable is
// unhandled from the moment it is created until something awaits it, which vitest reports as an
// unhandled rejection even though the code under test handles it correctly.
const getWindows = vi.hoisted(() => ({
  current: async (): Promise<Array<{ label: string }>> => [],
}));
vi.mock("@tauri-apps/api/window", () => ({
  getAllWindows: () => getWindows.current(),
}));

import { APP_WINDOW_LABEL, AppBoot } from "./windowContext";
import {
  SATELLITE_REGISTRY_KEY,
  releaseSatellite,
  settleSatellite,
} from "./services/satelliteWindows";
import {
  WINDOW_REGISTRY_KEY,
  clearWindowProject,
  findWindowForProject,
  setWindowProject,
} from "./services/windowRegistry";
import { useProjectStore } from "./stores/projectStore";

const w = window as unknown as Record<string, unknown>;

beforeEach(() => {
  localStorage.clear();
  w.__TAURI_INTERNALS__ = {};
  useProjectStore.setState({ projects: [], selectedProjectId: null } as never);
});
afterEach(() => {
  cleanup();
  delete w.__TAURI_INTERNALS__;
});

/**
 * Let the boot effect's async prune actually RUN before asserting.
 *
 * `waitFor` is not enough and was the bug in the first draft of these tests: it evaluates its
 * callback synchronously on entry, and every assertion here is already true at render time — so the
 * wipe regression they exist to catch would have left them green. The prune is a
 * `void (async () => { await import(...); ... })()` chain, so the flush has to outlast a dynamic
 * import plus a promise tick.
 */
async function flushPrune() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

/** Both maps seeded as they would be with one project torn out into project-1. */
function seedTornOut() {
  settleSatellite("p1", "project-1");
  setWindowProject("project-1", "p1");
}

describe("AppBoot hygiene with a LIVE satellite", () => {
  beforeEach(() => {
    getWindows.current = async () => [{ label: "main" }, { label: "project-1" }];
  });

  it("keeps the satellite's ownership row across a main-window reload", async () => {
    seedTornOut();
    render(<AppBoot>{null}</AppBoot>);
    await flushPrune();
    expect(JSON.parse(localStorage.getItem(SATELLITE_REGISTRY_KEY)!)).toEqual({
      p1: "project-1",
    });
  });

  it("keeps the satellite's window-registry row too", async () => {
    // Erasing this one is quieter but not harmless: findWindowForProject answers null, and
    // capture-sends / orchestration events for a torn-out project fall through to main, which
    // adopts them and navigates onto the re-dock placeholder while the satellite is the window
    // actually showing that project.
    seedTornOut();
    render(<AppBoot>{null}</AppBoot>);
    await flushPrune();
    expect(findWindowForProject("p1")).toBe("project-1");
  });
});

describe("AppBoot hygiene with NO satellite", () => {
  beforeEach(() => {
    getWindows.current = async () => [{ label: "main" }];
  });

  it("clears a stranded row — the true cold start after a crash", async () => {
    seedTornOut();
    render(<AppBoot>{null}</AppBoot>);
    await flushPrune();
    expect(JSON.parse(localStorage.getItem(SATELLITE_REGISTRY_KEY)!)).toEqual({});
    expect(findWindowForProject("p1")).toBeNull();
  });
});

describe("AppBoot when the window list cannot be read", () => {
  beforeEach(() => {
    getWindows.current = async () => {
      throw new Error("no window manager");
    };
  });

  it("does not reject — both callers use `void`, so a throw is an unhandled rejection", async () => {
    // AppBoot calls this once; Workspace calls it on EVERY window focus. An unguarded throw would
    // surface as an unhandled rejection on an ordinary user action.
    const { reconcileSatellites } = await import("./services/satelliteWindows");
    seedTornOut();
    await expect(reconcileSatellites({ boot: true })).resolves.toBe(false);
  });

  it("leaves BOTH maps untouched rather than falling back to a wipe", async () => {
    // A fallback wipe here would silently reinstate the erase-a-live-satellite's-row bug on every
    // remount, for any transient failure. An unanswerable liveness question is not evidence that
    // nothing is live.
    seedTornOut();
    render(<AppBoot>{null}</AppBoot>);
    await flushPrune();
    expect(JSON.parse(localStorage.getItem(SATELLITE_REGISTRY_KEY)!)).toEqual({ p1: "project-1" });
    expect(findWindowForProject("p1")).toBe("project-1");
  });
});

// Selecting a torn-out tab is now an ordinary click — the tab both raises the satellite and selects
// it, so main's re-dock placeholder stays reachable. That made main's registry write dangerous:
// `findWindowForProject` returns the FIRST match in insertion order, so two labels mapping to one
// project elects whichever was written first, and in production that is `main` (it writes its row at
// boot; the satellite's row is appended later). The election then names the window rendering nothing
// but a placeholder, and it adopts capture-sends / orchestration requests the satellite should take.
//
// ORDER MATTERS IN THESE TESTS and getting it wrong is how the first version of them passed with the
// fix removed: seeding the satellite's row first put `project-1` at the head of the map, so the
// election answered "project-1" whether or not main also held a row. Main's row is seeded FIRST here,
// matching production — and the assertions read the MAP, not just the election, so "main holds no row
// for a torn-out project" is stated directly rather than inferred from who won.
describe("main does not claim the registry row for a project it only shows a placeholder for", () => {
  beforeEach(() => {
    getWindows.current = async () => [{ label: "main" }, { label: "project-1" }];
  });

  function selectProject(id: string, name: string) {
    useProjectStore.setState({
      projects: [
        {
          id, name, rootPath: `/tmp/${id}`, defaultBranch: null,
          createdAt: new Date(0).toISOString(), selectedAgentId: null, agents: [],
        },
      ],
      selectedProjectId: id,
    } as never);
  }

  it("holds NO row for a torn-out project, even with main's row written first", async () => {
    setWindowProject(APP_WINDOW_LABEL, "p1"); // main's boot row — inserted FIRST, as in production
    seedTornOut();
    selectProject("p1", "Alpha");
    render(<AppBoot>{null}</AppBoot>);
    await flushPrune();
    expect(JSON.parse(localStorage.getItem(WINDOW_REGISTRY_KEY)!)).toEqual({ "project-1": "p1" });
    expect(findWindowForProject("p1")).toBe("project-1");
  });

  it("does claim it for a project main really is rendering", async () => {
    selectProject("p2", "Beta");
    render(<AppBoot>{null}</AppBoot>);
    await flushPrune();
    expect(findWindowForProject("p2")).toBe("main");
  });

  it("drops main's row the moment the SELECTED project is torn out", async () => {
    // The half of the fix that is the ownership subscription rather than the guard. This is the
    // most common path of all — tear out the tab you are looking at — and the selection never
    // changes, so an effect keyed only on `[projectId]` would never re-run.
    selectProject("p1", "Alpha");
    render(<AppBoot>{null}</AppBoot>);
    await flushPrune();
    expect(findWindowForProject("p1")).toBe("main");

    await act(async () => {
      settleSatellite("p1", "project-1");
      setWindowProject("project-1", "p1"); // as the satellite does on its own mount
    });
    expect(JSON.parse(localStorage.getItem(WINDOW_REGISTRY_KEY)!)).toEqual({ "project-1": "p1" });
    expect(findWindowForProject("p1")).toBe("project-1");
  });

  it("takes the row back when the project is re-docked", async () => {
    setWindowProject(APP_WINDOW_LABEL, "p1");
    seedTornOut();
    selectProject("p1", "Alpha");
    render(<AppBoot>{null}</AppBoot>);
    await flushPrune();
    expect(findWindowForProject("p1")).toBe("project-1");

    // Re-dock: the satellite clears its own rows on the way out.
    await act(async () => {
      clearWindowProject("project-1");
      releaseSatellite("p1");
    });
    expect(findWindowForProject("p1")).toBe("main");
  });
});
