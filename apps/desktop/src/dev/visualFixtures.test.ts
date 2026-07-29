// The fixtures exist to make screenshots byte-stable, so what is worth asserting is DETERMINISM
// and the guards — not the specific agent names, which are free to change as long as they stay
// constants.
import { describe, expect, it, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEV_BYPASS_AUTH_FLAG } from "./devBypassAuth";
import {
  FIXTURE_NOW,
  FIXTURE_PROJECT_ID,
  applyVisualFixtures,
  buildVisualFixture,
  visualFixturesRequested,
} from "./visualFixtures";
import {
  PROJECTS_PERSIST_DEBOUNCE_MS,
  PROJECTS_PERSIST_KEY,
  flushProjectsPersist,
  useProjectStore,
} from "../stores/projectStore";
import { RUNTIME_PERSIST_KEY, useRuntimeStore } from "../stores/runtimeStore";
import type { Project } from "../types";

const ON = { DEV: true, [DEV_BYPASS_AUTH_FLAG]: "1" };

describe("visualFixturesRequested", () => {
  it("accepts the documented truthy spellings only", () => {
    expect(visualFixturesRequested("?visual=1")).toBe(true);
    expect(visualFixturesRequested("?visual=true")).toBe(true);
    expect(visualFixturesRequested("?foo=bar&visual=1")).toBe(true);
  });

  it("is off when absent, empty or falsy", () => {
    expect(visualFixturesRequested("")).toBe(false);
    expect(visualFixturesRequested("?visual=")).toBe(false);
    expect(visualFixturesRequested("?visual=0")).toBe(false);
    expect(visualFixturesRequested("?visual=false")).toBe(false);
    expect(visualFixturesRequested("?other=1")).toBe(false);
  });
});

describe("buildVisualFixture", () => {
  it("is a pure constant — two builds are byte-identical", () => {
    // The whole harness rests on this: if the fixture varied per call, every diff percentage would
    // be measuring the fixture rather than the design.
    expect(JSON.stringify(buildVisualFixture())).toBe(JSON.stringify(buildVisualFixture()));
  });

  it("carries no wall-clock value", () => {
    const before = Date.now();
    const { project } = buildVisualFixture();
    const stamps = project.agents.flatMap((a) => [
      a.createdAt ?? 0,
      ...a.promptHistory.map((p) => p.at),
    ]);
    // Every timestamp is an offset from the pinned instant, so all of them sit at or before it —
    // and none can have been minted from `before`.
    for (const t of stamps) {
      expect(t).toBeLessThanOrEqual(FIXTURE_NOW);
      expect(t).not.toBe(before);
    }
    expect(Date.parse(project.createdAt)).toBe(FIXTURE_NOW);
  });

  it("gives every agent a status and a workflow stage", () => {
    const { project, status, workflowStage } = buildVisualFixture();
    expect(project.agents.length).toBeGreaterThan(0);
    for (const a of project.agents) {
      expect(status[a.id]).toBeTruthy();
      expect(workflowStage[a.id]).toBeTruthy();
    }
  });

  it("selects an agent, so captures show the selected-row geometry", () => {
    const { project } = buildVisualFixture();
    expect(project.agents.some((a) => a.id === project.selectedAgentId)).toBe(true);
  });

  it("points every worker at a build parent that exists", () => {
    const { project } = buildVisualFixture();
    const ids = new Set(project.agents.map((a) => a.id));
    for (const a of project.agents) {
      if (a.parentId !== null) expect(ids.has(a.parentId)).toBe(true);
    }
  });
});

describe("applyVisualFixtures", () => {
  beforeEach(() => {
    useProjectStore.setState({ projects: [], selectedProjectId: null });
    useRuntimeStore.setState({ status: {}, workflowStage: {} });
  });

  it("refuses to seed when the dev auth bypass is off", () => {
    // The bypass is the DEV-only gate; without it a real session must never be overwritten just
    // because a URL happened to carry ?visual=1.
    expect(applyVisualFixtures("?visual=1", { DEV: true })).toBe(false);
    expect(applyVisualFixtures("?visual=1", { DEV: false, [DEV_BYPASS_AUTH_FLAG]: "1" })).toBe(
      false,
    );
    expect(useProjectStore.getState().projects).toEqual([]);
  });

  it("refuses to seed without ?visual=1, even with the bypass on", () => {
    expect(applyVisualFixtures("", ON)).toBe(false);
    expect(useProjectStore.getState().projects).toEqual([]);
  });

  it("seeds the project and the live runtime state when both gates pass", () => {
    expect(applyVisualFixtures("?visual=1", ON)).toBe(true);
    const ps = useProjectStore.getState();
    expect(ps.projects).toHaveLength(1);
    const seeded = ps.projects[0]!;
    expect(seeded.id).toBe(FIXTURE_PROJECT_ID);
    expect(ps.selectedProjectId).toBe(FIXTURE_PROJECT_ID);
    // Status is live-only (never persisted), so it has to be written on every boot or the rows
    // render with no dot at all.
    expect(Object.keys(useRuntimeStore.getState().status)).toHaveLength(seeded.agents.length);
  });

  it("replaces any pre-existing project rather than appending to them", () => {
    useProjectStore.setState({ projects: [{ id: "leftover" } as Project] });
    applyVisualFixtures("?visual=1", ON);
    const ids = useProjectStore.getState().projects.map((p) => p.id);
    expect(ids).toEqual([FIXTURE_PROJECT_ID]);
  });
});

describe("seeding never reaches disk", () => {
  // roborev 54701. Both seeded stores are persist-backed, so a plain setState writes THROUGH to
  // localStorage — which, for a developer who keeps the bypass flag in their environment and opens
  // their own dev server with ?visual=1, meant losing their real project list with no undo.
  it("leaves the persisted profile untouched, debounce included", () => {
    // Drain first. Earlier tests in this file mutated the store, and those writes are DEBOUNCED —
    // a still-pending one would land on top of the blob below and be misread as this seed's doing.
    flushProjectsPersist();
    vi.useFakeTimers();
    try {
      const REAL = JSON.stringify({ state: { projects: [{ id: "the-developers-real-project" }] } });
      localStorage.setItem(PROJECTS_PERSIST_KEY, REAL);

      expect(applyVisualFixtures("?visual=1", ON)).toBe(true);
      // In memory the fixture is live...
      expect(useProjectStore.getState().projects[0]!.id).toBe(FIXTURE_PROJECT_ID);
      // ...and the write is debounced, so run the clock past it before believing anything.
      vi.advanceTimersByTime(PROJECTS_PERSIST_DEBOUNCE_MS * 4);
      flushProjectsPersist();

      expect(localStorage.getItem(PROJECTS_PERSIST_KEY)).toBe(REAL);
    } finally {
      vi.useRealTimers();
      localStorage.removeItem(PROJECTS_PERSIST_KEY);
    }
  });

  it("shadows the real state in memory only, so a reload without ?visual=1 recovers it", () => {
    localStorage.setItem(RUNTIME_PERSIST_KEY, JSON.stringify({ state: { openAgentIds: ["real"] } }));
    try {
      applyVisualFixtures("?visual=1", ON);
      expect(localStorage.getItem(RUNTIME_PERSIST_KEY)).toContain("real");
    } finally {
      localStorage.removeItem(RUNTIME_PERSIST_KEY);
    }
  });
});

describe("the pinned clock", () => {
  it("matches FROZEN_CLOCK in scripts/visual/serve.mjs", () => {
    // These two constants are the same fact stated in two languages. If they drift, the harness
    // pins Date.now() to one instant while the fixture's timestamps are expressed against another,
    // and every elapsed readout silently goes wrong — the exact wall-clock dependence the fixture
    // exists to remove. Assert them equal rather than trusting a comment.
    const src = readFileSync(resolve(__dirname, "../../scripts/visual/serve.mjs"), "utf8");
    const m = src.match(/const FIXED = (\d+);/);
    expect(m, "FROZEN_CLOCK's `const FIXED = <epoch ms>;` line was not found").toBeTruthy();
    expect(Number(m![1])).toBe(FIXTURE_NOW);
  });
});
