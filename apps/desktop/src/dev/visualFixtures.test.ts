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
import { PROJECTS_PERSIST_DEBOUNCE_MS, PROJECTS_PERSIST_KEY, debouncedProjectsStorage, flushProjectsPersist, useProjectStore } from "../stores/projectStore";
import { RUNTIME_PERSIST_KEY, useRuntimeStore } from "../stores/runtimeStore";
import { DICTATION_PERSIST_KEY, useDictationStore } from "../stores/dictationStore";
import type { Project } from "../types";
import { createJSONStorage } from "zustand/middleware";

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
  //
  // THE beforeEach IS THE TEST'S TEETH (roborev 54756). detachPersistence() mutates module-level
  // singletons, and the earlier describe block already calls applyVisualFixtures — so without
  // re-attaching, both stores arrive here ALREADY detached and these assertions pass no matter what
  // applyVisualFixtures does. That made them blind to the ordering the source calls load-bearing:
  // moving detachPersistence() to AFTER the setState calls would have kept the suite green while
  // production regressed completely. Re-attaching a live storage backend first means a write that
  // escapes is actually observable.
  //
  // A plain synchronous localStorage backend is substituted for the real debounced one on purpose:
  // the invariant under test is "no store write reaches storage at all", and removing the 400ms
  // timer removes a way for the test to pass by accident of timing.
  beforeEach(() => {
    flushProjectsPersist(); // drain anything an earlier test left pending
    const live = createJSONStorage(() => localStorage);
    for (const store of [useProjectStore, useRuntimeStore, useDictationStore]) {
      (store as unknown as { persist: { setOptions: (o: unknown) => void } }).persist.setOptions({
        storage: live,
      });
    }
    localStorage.removeItem(PROJECTS_PERSIST_KEY);
    localStorage.removeItem(RUNTIME_PERSIST_KEY);
    localStorage.removeItem(DICTATION_PERSIST_KEY);
  });

  it("leaves the persisted project blob untouched", () => {
    const REAL = JSON.stringify({ state: { projects: [{ id: "the-developers-real-project" }] } });
    localStorage.setItem(PROJECTS_PERSIST_KEY, REAL);
    try {
      expect(applyVisualFixtures("?visual=1", ON)).toBe(true);
      // In memory the fixture is live...
      expect(useProjectStore.getState().projects[0]!.id).toBe(FIXTURE_PROJECT_ID);
      // ...and nothing about it reached storage.
      expect(localStorage.getItem(PROJECTS_PERSIST_KEY)).toBe(REAL);
    } finally {
      localStorage.removeItem(PROJECTS_PERSIST_KEY);
    }
  });

  it("leaves the persisted runtime blob untouched — workflowStage IS persisted", () => {
    // Not a duplicate of the test above: runtimeStore's partialize persists workflowStage and
    // openAgentIds, both of which the fixture writes, so it needs its own detach and its own proof.
    const REAL = JSON.stringify({ state: { openAgentIds: ["real"], workflowStage: { a: "merged" } } });
    localStorage.setItem(RUNTIME_PERSIST_KEY, REAL);
    try {
      applyVisualFixtures("?visual=1", ON);
      expect(useProjectStore.getState().projects[0]!.id).toBe(FIXTURE_PROJECT_ID);
      expect(localStorage.getItem(RUNTIME_PERSIST_KEY)).toBe(REAL);
    } finally {
      localStorage.removeItem(RUNTIME_PERSIST_KEY);
    }
  });

  it("leaves the persisted MIC blob untouched — __sparkleMic writes a persisted field", () => {
    // roborev 56045. The dictation store is persist-backed (`partialize` keeps `enabled`), and the
    // `__sparkleMic` fixture handle writes exactly that field — so before it was added to
    // detachPersistence's loop, arming the mic for a capture wrote `enabled: true` to localStorage
    // and it OUTLIVED THE TAB. The default is `false` precisely so a cold start does not prompt for
    // microphone permission or start the ~482 MB model download, and DICTATION_PERSIST_KEY is
    // watched cross-window, so the escape could arm the mic in another live window too.
    const REAL = JSON.stringify({ state: { enabled: false, phase: "passive" } });
    localStorage.setItem(DICTATION_PERSIST_KEY, REAL);
    try {
      expect(applyVisualFixtures("?visual=1", ON)).toBe(true);
      // The WRITE `__sparkleMic` makes, made directly. This suite runs in the NODE environment, so
      // `window` does not exist and the handle — deliberately installed behind a `typeof window`
      // guard — is not there to call. What has to hold is a property of the STORE, not of the
      // handle: `enabled` is persisted, so any writer of it must find persistence already detached.
      // Driving setState is therefore the same assertion with one less layer of indirection, and it
      // stays true for the next fixture that writes this store.
      useDictationStore.setState({ enabled: true });
      // In memory the mic is armed, which is the whole point of the handle...
      expect(useDictationStore.getState().enabled).toBe(true);
      // ...and none of it reached storage.
      expect(localStorage.getItem(DICTATION_PERSIST_KEY)).toBe(REAL);
    } finally {
      localStorage.removeItem(DICTATION_PERSIST_KEY);
      useDictationStore.setState({ enabled: false });
    }
  });

  it("still survives the real debounced backend", () => {
    // RE-ATTACHES THE REAL BACKEND, AND PROVES IT IS LIVE BEFORE ASSERTING THE NEGATIVE.
    //
    // Two problems, both found by measuring rather than reading. First, the block's `beforeEach`
    // swaps in a synchronous `createJSONStorage(() => localStorage)` before EVERY test, so
    // `debouncedProjectsStorage` was not wired to the store at all and the timer advance below
    // drained a pending map nothing wrote into (roborev 54833). Second — and this is what a
    // mutation check caught after that was fixed — the assertion is "the blob is UNTOUCHED", which
    // holds just as well when NOTHING is attached. Deleting `flushProjectsPersist()` still passed.
    //
    // A negative assertion is only worth its name next to a positive control, so the control comes
    // first: a normal store mutation MUST reach disk through the 400ms window. Only then does
    // "fixtures leave it alone" mean the fixtures did it, rather than the wiring being absent.
    vi.useFakeTimers();
    const REAL = JSON.stringify({ state: { projects: [{ id: "real-under-debounce" }] } });
    (
      useProjectStore as unknown as { persist: { setOptions: (o: unknown) => void } }
    ).persist.setOptions({ storage: createJSONStorage(() => debouncedProjectsStorage) });
    try {
      // CONTROL: the debounced path is live and does reach localStorage.
      localStorage.setItem(PROJECTS_PERSIST_KEY, REAL);
      useProjectStore.setState((st) => ({ ...st }));
      vi.advanceTimersByTime(PROJECTS_PERSIST_DEBOUNCE_MS * 4);
      flushProjectsPersist();
      // `.not.toBe(REAL)` ALONE IS NOT A CONTROL: `null` satisfies it as readily as a successful
      // write, and `debouncedProjectsStorage` has both a `removeItem` path and a write-elision
      // branch. A regression into removing the key rather than writing it would leave this green
      // and the real assertion below green too — the same vacuousness this test exists to end
      // (roborev 55089). So assert the write POSITIVELY: a value is present, and it is the
      // persisted store shape rather than whatever else might have landed there.
      const wrote = localStorage.getItem(PROJECTS_PERSIST_KEY);
      const why = "control failed: the debounced backend never wrote, so the assertion below proves nothing";
      expect(wrote, why).not.toBeNull();
      expect(JSON.parse(wrote as string), why).toMatchObject({
        state: { projects: expect.any(Array) },
      });
      expect(wrote, why).not.toBe(REAL);

      // THE ACTUAL CLAIM: with fixtures on, persistence is detached and the blob survives.
      localStorage.setItem(PROJECTS_PERSIST_KEY, REAL);
      applyVisualFixtures("?visual=1", ON);
      useProjectStore.setState((st) => ({ ...st }));
      vi.advanceTimersByTime(PROJECTS_PERSIST_DEBOUNCE_MS * 4);
      flushProjectsPersist();
      expect(localStorage.getItem(PROJECTS_PERSIST_KEY)).toBe(REAL);
    } finally {
      vi.useRealTimers();
      localStorage.removeItem(PROJECTS_PERSIST_KEY);
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
