// The fixtures exist to make screenshots byte-stable, so what is worth asserting is DETERMINISM
// and the guards — not the specific agent names, which are free to change as long as they stay
// constants.
import { describe, expect, it, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEV_BYPASS_AUTH_FLAG } from "./devBypassAuth";
import {
  FIXTURE_NOW,
  FIXTURE_PRS,
  FIXTURE_PROJECT_ID,
  applyVisualFixtures,
  buildVisualFixture,
  visualConciergeWidth,
  visualFixturesRequested,
  visualPrsRequested,
} from "./visualFixtures";
import { PROJECTS_PERSIST_DEBOUNCE_MS, PROJECTS_PERSIST_KEY, debouncedProjectsStorage, flushProjectsPersist, useProjectStore } from "../stores/projectStore";
import { RUNTIME_PERSIST_KEY, useRuntimeStore } from "../stores/runtimeStore";
import { DICTATION_PERSIST_KEY, useDictationStore } from "../stores/dictationStore";
import {
  CONCIERGE_MAX_WIDTH,
  CONCIERGE_MIN_WIDTH,
  CONCIERGE_PAIRED_HARD_MAX,
  CONCIERGE_WIDTH_KEY,
  CONCIERGE_WIDTH_KEY_PAIRED,
  acceptsStoredConciergeWidth,
} from "../engine/columnResize";
import { goalStateOf } from "../engine/agentGoal";
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

  // The capture is the only thing that can answer "can the founder see a goal on the row", and it
  // can only answer it about states the roster actually contains. Before bead sparkle-6kz9q the
  // roster had NO goals at all, so the agent-sidebar shot was identical with the feature working
  // and with it entirely absent. These two assertions are what stop that returning: they pin the
  // COVERAGE the screenshot depends on, not the fixture's wording.
  it("carries a goal in each of the four states the row must distinguish", () => {
    const { project } = buildVisualFixture();
    const states = project.agents
      .map((a) => goalStateOf(a.goal, FIXTURE_NOW))
      .filter((s) => s !== "none");
    for (const want of ["unmet", "met", "expired", "escalated"] as const) {
      expect(states, `no fixture agent renders a ${want} goal`).toContain(want);
    }
  });

  it("keeps every goal on a PHOTOGRAPHABLE row — never on a nested worker", () => {
    // The invariant the whole table rests on, and it was verified by hand and asserted nowhere
    // (roborev 57429). A worker under a collapsed head renders as a one-line PEEK (AgentSidebar's
    // "THE PEEK"), not an AgentRow, so it has no goal chip: a goal parked there is invisible in the
    // very capture this fixture exists to feed. That is not hypothetical — it happened, and the
    // amber `expired` mark disappeared from the shot.
    //
    // The per-kind pairing test below does NOT catch it: with `expired` moved onto `vfx-agent-2`,
    // `vfx-agent-3` is still a goal-less nested-worker control and `build:top` still pairs, so the
    // suite stays green while the state stops being photographable. This is the assertion that
    // makes that red.
    const { project } = buildVisualFixture();
    for (const a of project.agents) {
      if (!a.goal) continue;
      expect(
        a.parentId,
        `${a.id} carries a goal but is nested — it renders as a peek, not a row`,
      ).toBeNull();
    }
  });

  it("pairs every goal-bearing agent kind with a SAME-KIND goal-less control", () => {
    // `some(a => a.goal === undefined)` is not enough, and the weaker version of this test passed
    // while the property failed (roborev 57331): the only goal-less rows were the two nested
    // WORKERS, and every goal sat on a top-level BUILD row. "Has a goal" was therefore perfectly
    // confounded with "is a top-level build row", so a capture could not show which of the two a
    // visible difference came from — the exact question the fixture exists to answer.
    //
    // A control has to differ in the ONE variable under test, so the assertion is per nesting
    // level: whatever kind of row carries a goal, a row of that same kind must lack one.
    const { project } = buildVisualFixture();
    const kindOf = (a: (typeof project.agents)[number]) =>
      `${a.kind}:${a.parentId === null ? "top" : "nested"}`;
    const withGoal = new Set(project.agents.filter((a) => a.goal).map(kindOf));
    const without = new Set(project.agents.filter((a) => !a.goal).map(kindOf));
    expect(withGoal.size).toBeGreaterThan(0);
    for (const k of withGoal) {
      expect(without, `no goal-less control among ${k} rows`).toContain(k);
    }
  });

  it("expresses every goal timestamp as an offset from the pinned instant", () => {
    // Same rule as `carries no wall-clock value` above, for the fields that test does not walk.
    // `goalStateOf` and the "3h 20m left" readout are both `now`-relative, so a wall-clock goal
    // would change the row's own TEXT between two runs of the same capture.
    const { project } = buildVisualFixture();
    const stamps = project.agents.flatMap((a) =>
      a.goal ? [a.goal.setAt, a.goal.metAt, a.goal.escalatedAt] : [],
    );
    expect(stamps.length).toBeGreaterThan(0);
    for (const t of stamps) {
      if (t !== undefined) expect(t).toBeLessThanOrEqual(FIXTURE_NOW);
    }
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

  // ── THE WIDTH WRITE PATH, WHICH ONLY THE PARSER USED TO COVER (roborev 57506) ────────────────
  //
  // `visualConciergeWidth` is well tested as a parser, and that is not the same fact as "the width
  // reaches the app". `Workspace` reads these two keys in a `useState` initialiser, so if either
  // string here drifts from the one it reads, `?concierge=190` becomes a silent no-op and the
  // `open-pr-menu-narrow` capture photographs the 380px DEFAULT under a filename claiming half
  // that — a screenshot that says the panel is contained when nothing was ever narrowed. The keys
  // are imported from `engine/columnResize` for exactly this reason; this asserts they are what
  // gets written.
  it("seeds BOTH concierge width keys, using the keys the shell actually reads", () => {
    localStorage.removeItem(CONCIERGE_WIDTH_KEY);
    localStorage.removeItem(CONCIERGE_WIDTH_KEY_PAIRED);
    expect(applyVisualFixtures("?visual=1&concierge=190", ON)).toBe(true);
    expect(localStorage.getItem(CONCIERGE_WIDTH_KEY)).toBe("190");
    // The paired key too: which one the shell reads depends on the pair count, and seeding only one
    // makes the fixture work or not work depending on a layout the capture did not ask about.
    expect(localStorage.getItem(CONCIERGE_WIDTH_KEY_PAIRED)).toBe("190");
  });

  it("leaves a developer's own width alone when no width was asked for", () => {
    // NOT a zustand-persisted key, so `detachPersistence` does not cover it — this is a real
    // preference on a real machine, and the only thing keeping it safe is that nothing writes it
    // unless `?concierge=` said so.
    localStorage.setItem(CONCIERGE_WIDTH_KEY, "421");
    localStorage.setItem(CONCIERGE_WIDTH_KEY_PAIRED, "1337");
    expect(applyVisualFixtures("?visual=1", ON)).toBe(true);
    expect(localStorage.getItem(CONCIERGE_WIDTH_KEY)).toBe("421");
    expect(localStorage.getItem(CONCIERGE_WIDTH_KEY_PAIRED)).toBe("1337");
  });

  it("leaves it alone for a width the shell itself would refuse", () => {
    // A value out of bounds parses to null, and null must mean "write nothing" rather than "write
    // the default" — otherwise an out-of-range parameter clobbers the real preference AND produces
    // a capture at a width nobody asked for. 40 is below the 50px column floor.
    localStorage.setItem(CONCIERGE_WIDTH_KEY, "421");
    applyVisualFixtures("?visual=1&concierge=40", ON);
    expect(localStorage.getItem(CONCIERGE_WIDTH_KEY)).toBe("421");
    localStorage.removeItem(CONCIERGE_WIDTH_KEY);
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

// ── THE OPT-IN PARAMETERS THE OPEN-PR SURFACE NEEDS ───────────────────────────────────────────
//
// Both exist because a whole class of chrome bug is invisible at a comfortable width: the open-PR
// menu shipped clipped to its column (bead sparkle-8g4qh) and no capture could have caught it,
// since every surface photographs the concierge at its 380px default. Parsing is asserted here
// rather than only in the browser because a parameter that silently fails to parse produces a
// capture of the DEFAULT state filed under a name claiming otherwise — the mislabelled-screenshot
// failure this harness has already hit twice.
describe("the concierge-width parameter", () => {
  // THE BOUNDS ARE THE SHELL'S, ASSERTED AS THE SHELL'S CONSTANTS — not as literals that happen to
  // match them today. This test previously pinned `1400` as the ceiling and `1401` as refused, and
  // both were wrong: the shell's cap is `COLUMN_HARD_MAX`, so it accepts and persists 1401. The
  // effect was that the founder's documented ~1920 cockpit width parsed to null, wrote no key, and
  // would have been photographed at the DEFAULT column under a filename claiming a wide one — the
  // very failure the block comment above says this parser exists to prevent (roborev 57518).
  it("reads a width the shell would accept, across its whole real range", () => {
    expect(visualConciergeWidth("?visual=1&concierge=190")).toBe(190);
    expect(visualConciergeWidth(`?visual=1&concierge=${CONCIERGE_MIN_WIDTH}`)).toBe(
      CONCIERGE_MIN_WIDTH,
    );
    // THE CONCIERGE'S OWN CEILING, not the generic column one. They are the same number today and
    // that is exactly the trap: `Workspace` validates against the concierge bounds, so a test
    // written against the column bounds tracks the wrong thing the moment they part (roborev 57514).
    expect(visualConciergeWidth(`?visual=1&concierge=${CONCIERGE_MAX_WIDTH}`)).toBe(
      CONCIERGE_MAX_WIDTH,
    );
    // The width the paired-key docblock names as a real founder layout. It sits above the old
    // literal ceiling, which is the concrete case that ceiling was silently refusing.
    expect(visualConciergeWidth("?visual=1&concierge=1920")).toBe(1920);
  });

  // ── THE PARSER AGREES WITH THE SHARED PREDICATE ──────────────────────────────────────────────
  //
  // SCOPED HONESTLY. This file is NODE-environment and never imports `Workspace`, so NOTHING here
  // can observe the shell — an earlier version of this block claimed it could, and the claim was
  // false in the way that matters: dropping the initialiser's validation left it green. What it
  // pins is one link: the parser's verdict tracks `acceptsStoredConciergeWidth`, which matters
  // because the parser is free to add bounds of its own (it already adds an integer check) and a
  // second bound bolted on here would silently narrow what the harness can ask for.
  //
  // THE COUPLING TO THE APP is asserted where it can actually be seen — `Workspace.resize.test.tsx`
  // seeds through `applyVisualFixtures` and mounts the real shell, so it goes red if the fixture
  // writes a key nobody reads or the initialiser refuses a width the fixture would seed.
  //
  // Swept rather than sampled, across every bound in both directions — INCLUDING the paired ceiling,
  // which the parser deliberately does NOT consult. That is the point of probing it: the initialiser
  // falls back from a refused paired width to the SINGLE width rather than to the default, so such a
  // width is still KEPT at that width, and a parser that rejected it would write no key and land on
  // the 360px default — mislabelling the capture it was guarding (roborev 57533). These probes fail
  // if someone re-adds the paired arm once the two ceilings part.
  //
  // KEPT, not PAINTED: in the two-pair layout paint is clamped by `conciergePairedMax`, so a width
  // between the two ceilings really does photograph narrow there. That hazard is real and belongs to
  // the per-surface paint guard in Workspace.resize.test.tsx, which mounts each surface in its own
  // layout — not to this bound (roborev 57534).
  it("accepts exactly what acceptsStoredConciergeWidth accepts — the parser adds no second bound", () => {
    const edges = [
      CONCIERGE_MIN_WIDTH,
      CONCIERGE_MAX_WIDTH,
      CONCIERGE_PAIRED_HARD_MAX,
      Math.min(CONCIERGE_MAX_WIDTH, CONCIERGE_PAIRED_HARD_MAX),
    ];
    const probes = new Set<number>([190, 360, 1000, 1920]);
    for (const e of edges) for (const d of [-1, 0, 1]) probes.add(e + d);
    for (const n of probes) {
      const honoured = acceptsStoredConciergeWidth(n, { paired: false });
      expect(visualConciergeWidth(`?visual=1&concierge=${n}`) !== null, `width ${n}`).toBe(honoured);
    }
  });

  it("is absent by default, so every existing surface keeps its baseline", () => {
    expect(visualConciergeWidth("?visual=1")).toBeNull();
    expect(visualConciergeWidth("")).toBeNull();
  });

  // FAILS CLOSED. A width the shell would refuse gets clamped away at render, so honouring it here
  // would seed a value the capture cannot actually show — a picture of the default under another
  // name. Null means "use the app's own default", which is at least true.
  it("refuses anything the shell would clamp or cannot read", () => {
    // Both rejected bounds are expressed as the shell's constants ± 1, so this test cannot drift
    // from the shell the way the literal `1401` did.
    const bad = [
      String(CONCIERGE_MIN_WIDTH - 1),
      String(CONCIERGE_MAX_WIDTH + 1),
      "0",
      "-200",
      "abc",
      "",
      "190.5",
      "1e3px",
    ];
    for (const b of bad) {
      expect(visualConciergeWidth(`?visual=1&concierge=${b}`), b).toBeNull();
    }
  });
});

describe("the open-PR parameter", () => {
  it("is opt-in — absent, the PR chip stays out of every other capture", () => {
    expect(visualPrsRequested("?visual=1")).toBe(false);
    expect(visualPrsRequested("?visual=1&prs=0")).toBe(false);
    expect(visualPrsRequested("")).toBe(false);
  });

  it("accepts the same two spellings every other flag here does", () => {
    expect(visualPrsRequested("?visual=1&prs=1")).toBe(true);
    expect(visualPrsRequested("?visual=1&prs=true")).toBe(true);
  });

  // THE ROWS MUST EXERCISE WHAT TRUNCATES. A fixture of three short green PRs reproduces none of
  // the four elisions the bug was reported as, so the capture would be green on a broken build.
  it("seeds rows that would show the elisions the bug was reported as", () => {
    // A red PR whose blocking reason is a multi-word string — this is the field that truncated to
    // "1 c…", and the one the founder could not read before pressing Merge.
    const red = FIXTURE_PRS.find((p) => p.checks === "failing");
    expect(red, "no failing PR — the blocking-reason row is what this surface is for").toBeTruthy();
    expect(red!.failingChecks!.length).toBeGreaterThan(1);
    // More than one green, so the primary action reads "Merge all ready (N)" — the long form that
    // was sliced to "Merge all re", not the short one.
    expect(FIXTURE_PRS.filter((p) => p.checks === "passing").length).toBeGreaterThan(1);
    // A subject and a branch long enough to have somewhere to truncate TO.
    expect(Math.max(...FIXTURE_PRS.map((p) => p.title.length))).toBeGreaterThan(50);
    expect(Math.max(...FIXTURE_PRS.map((p) => p.headRefName.length))).toBeGreaterThan(25);
  });
});
