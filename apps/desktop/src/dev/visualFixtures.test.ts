// The fixtures exist to make screenshots byte-stable, so what is worth asserting is DETERMINISM
// and the guards — not the specific agent names, which are free to change as long as they stay
// constants.
import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { AGENT_STATUS } from "@sparkle/ui";
import { sectionOfStage } from "../engine/buildSections";
import { GRAY_LEGAL_SECTIONS, grayFloorFor } from "../engine/stallEscalation";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEV_BYPASS_AUTH_FLAG } from "./devBypassAuth";
import {
  FIXTURE_NOW,
  FIXTURE_PRS,
  FIXTURE_PRS_BY_ROOT,
  FIXTURE_PROJECT_ID,
  FIXTURE_PROJECT_ROOT,
  FIXTURE_SECOND_PRS,
  FIXTURE_SECOND_PROJECT_ID,
  FIXTURE_SECOND_PROJECT_ROOT,
  applyVisualFixtures,
  buildSecondProjectFixture,
  buildVisualFixture,
  fixturePrsForRoot,
  visualConciergeWidth,
  visualFixturesRequested,
  visualPairCount,
  visualProjectCount,
  visualCaptureRun,
  visualPrsRequested,
} from "./visualFixtures";
import { agentLinkForPr } from "../components/OpenPrMenu";
import { stallReport } from "../engine/agentStall";
import { stallChipFor, stallInputsFor } from "../components/rowAttention";
import { bandOfStatus, sectionOfRow } from "../engine/buildSections";
import { uncommittedWorkEvidence } from "../engine/workflowStage";
import type { AgentTabStatus } from "../types";
import { useUiStore } from "../stores/uiStore";
import { isProjectOpen } from "../engine/openProjects";
import { PROJECTS_PERSIST_DEBOUNCE_MS, PROJECTS_PERSIST_KEY, debouncedProjectsStorage, flushProjectsPersist, useProjectStore } from "../stores/projectStore";
import { RUNTIME_PERSIST_KEY, useRuntimeStore } from "../stores/runtimeStore";
import { DICTATION_PERSIST_KEY, useDictationStore } from "../stores/dictationStore";
// The badge's and the thread's OWN derivations, so a drifted fixture fails here rather than
// shipping a screenshot of an empty row — see the inbox test below.
import { inFlight, pendingCount, useInboxStore } from "../stores/inboxStore";
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

  // ── THE QUEUED INBOX, WHICH ONLY A REAL RENDER CAN VERIFY ───────────────────────────────────
  //
  // The pending badge and the thread's queued bubbles (bead sparkle-zm0c8) were verified in jsdom,
  // and jsdom neither lays out nor paints — so the visual harness is the only place in this repo
  // that can show the founder's fix is actually VISIBLE. That only holds if the fixture really
  // seeds the store the components read: an unseeded `inboxStore` renders NOTHING (the badge
  // returns null on a zero count), so a capture would photograph an empty row under a filename
  // claiming otherwise. Exactly the failure the concierge-width test above exists to prevent.
  //
  // Asserts what the COMPONENTS derive, through their own helpers, rather than re-reading the
  // literal back out of the store — `pendingCount` is what the badge shows and `inFlight` is what
  // the thread lists, so a fixture whose stages drifted would fail here instead of shipping a
  // screenshot that proves nothing.
  // THE GATE, AND WHY IT IS THE FIRST THING ASSERTED. The first version of this fixture seeded
  // unconditionally, and `SELECTED_ROW_ID` is a top-level row rendered by `agent-sidebar`,
  // `workspace-unwired`, `workspace-wired-left` and `workspace-wired-right`. The harness scores each
  // surface app-vs-mock and the approved rev4 mock has no inbox badge — so an unconditional seed put
  // an app-only element into four existing surfaces' captures permanently, raising their measured
  // diff with no way to turn it off (roborev 58009). Asserting the DEFAULT is what stops that
  // returning; the opt-in case below would pass either way.
  it("does NOT seed the inbox by default, so no existing surface's baseline moves", () => {
    expect(applyVisualFixtures("?visual=1", ON)).toBe(true);
    const rowId = useProjectStore.getState().projects[0]!.agents[0]!.id;
    expect(useInboxStore.getState().byAgent[rowId] ?? []).toEqual([]);
  });

  it("seeds a queued inbox on the selected row, with one message at each lifecycle stage", () => {
    expect(applyVisualFixtures("?visual=1&inbox=1", ON)).toBe(true);
    const rowId = useProjectStore.getState().projects[0]!.agents[0]!.id;
    const entries = useInboxStore.getState().byAgent[rowId] ?? [];

    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.state)).toEqual(["pending", "delivered", "acknowledged"]);
    // The BADGE counts pending only — a mark that never goes away stops being read.
    expect(pendingCount(entries)).toBe(1);
    // The THREAD lists everything not yet acknowledged.
    expect(inFlight(entries).map((e) => e.id)).toEqual(["vfx-inbox-1", "vfx-inbox-2"]);
    // Every message carries real text, because the whole point of the surface is showing it.
    expect(entries.every((e) => e.text.trim().length > 0)).toBe(true);

    // DETERMINISM, the property this whole file exists for: a wall-clock `ts` would drift the 12h
    // expiry boundary between runs and make the baseline unstable.
    expect(entries.every((e) => e.ts < FIXTURE_NOW && e.ts > FIXTURE_NOW - 60 * 60_000)).toBe(true);
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

  // ── THE HARNESS RESETS WHAT IT DOES NOT SET (roborev 57717) ─────────────────────────────────
  //
  // Every surface gets a fresh PAGE but they share ONE BROWSER, and `localStorage` is origin-scoped.
  // So a surface that names no width did not get the app's default — it inherited the previous
  // surface's. `THEMES` is the outer loop, so the six width-less surfaces booted their DARK capture
  // carrying the last light-pass width, and `--surfaces=a,b` could reproduce it on demand. That is
  // how two grouped open-PR captures came out BYTE-IDENTICAL with one of them filed as "wide".
  it("CLEARS an inherited concierge width when the harness names none", () => {
    localStorage.setItem(CONCIERGE_WIDTH_KEY, "190");
    localStorage.setItem(CONCIERGE_WIDTH_KEY_PAIRED, "190");
    expect(applyVisualFixtures("?visual=1&capture=1", ON)).toBe(true);
    expect(localStorage.getItem(CONCIERGE_WIDTH_KEY)).toBeNull();
    expect(localStorage.getItem(CONCIERGE_WIDTH_KEY_PAIRED)).toBeNull();
  });

  it("still honours a width the harness DOES name", () => {
    localStorage.setItem(CONCIERGE_WIDTH_KEY, "190");
    expect(applyVisualFixtures("?visual=1&capture=1&concierge=360", ON)).toBe(true);
    expect(localStorage.getItem(CONCIERGE_WIDTH_KEY)).toBe("360");
    expect(localStorage.getItem(CONCIERGE_WIDTH_KEY_PAIRED)).toBe("360");
  });

  // The clear is gated on the HARNESS, not on `?visual=1`, because these keys are not
  // zustand-persisted — `detachPersistence` does not cover them, so they are a real preference on a
  // real machine. Wiping them because a developer opened their own dev server would be the fixture
  // destroying user data to tidy up after itself.
  it("does NOT clear a developer's width just because fixtures are on", () => {
    localStorage.setItem(CONCIERGE_WIDTH_KEY, "421");
    localStorage.setItem(CONCIERGE_WIDTH_KEY_PAIRED, "1337");
    expect(applyVisualFixtures("?visual=1", ON)).toBe(true);
    expect(localStorage.getItem(CONCIERGE_WIDTH_KEY)).toBe("421");
    expect(localStorage.getItem(CONCIERGE_WIDTH_KEY_PAIRED)).toBe("1337");
  });

  it("reads the capture marker strictly, and only from its own parameter", () => {
    expect(visualCaptureRun("?capture=1")).toBe(true);
    expect(visualCaptureRun("?capture=true")).toBe(true);
    expect(visualCaptureRun("")).toBe(false);
    expect(visualCaptureRun("?capture=0")).toBe(false);
    expect(visualCaptureRun("?capture=")).toBe(false);
    expect(visualCaptureRun("?visual=1")).toBe(false);
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
    // useUiStore is in this loop for the same reason it is in detachPersistence's: the fixture
    // writes its PERSISTED `openProjectIds` whenever a capture asks for a second pair or tab. An
    // earlier test in this file has already detached it, so without re-attaching, the assertion
    // below would hold no matter what applyVisualFixtures did — the vacuousness this block's own
    // header warns about.
    for (const store of [useProjectStore, useRuntimeStore, useDictationStore, useUiStore]) {
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

  // ── THE HANDLE'S RETURN VALUE IS THE HARNESS'S ONLY PROOF (roborev 57793) ────────────────────
  // The `mic` capture step verifies its effect by comparing what this returns against what it asked
  // for — the post-fix shape the `cable` step had to learn. That comparison is worth nothing if the
  // handle reports the request back instead of the STORE, so this drives the real handle and reads
  // the store independently.
  //
  // `window` is stubbed because this suite runs in the NODE environment and the handles are
  // deliberately installed behind a `typeof window` guard. Stubbing it is what lets the real
  // installed function be called at all, rather than re-implementing it here — which would test a
  // copy and leave the shipped one uncovered.
  it("__sparkleMic returns the state it actually wrote, not the state it was asked for", () => {
    const win: Record<string, unknown> = {};
    vi.stubGlobal("window", win);
    try {
      expect(applyVisualFixtures("?visual=1", ON)).toBe(true);
      const mic = win.__sparkleMic as (s: {
        enabled: boolean;
        status?: string;
        phase?: string;
        interim?: string;
        voiceSurface?: string;
      }) => {
        enabled: boolean;
        status: string;
        phase: string;
        interim: string;
        voiceSurface: string;
      };
      expect(typeof mic).toBe("function");

      const live = mic({ enabled: true, status: "listening", phase: "active" });
      // It reports the STORE — read back independently, so a handle that echoed its argument would
      // still have to have written it. `interim`/`voiceSurface` are reported even when unstated,
      // which is what lets the capture step hold an UNSTATED term to whatever the store actually
      // has rather than to what was asked for.
      expect(live).toEqual({
        enabled: true,
        status: "listening",
        phase: "active",
        interim: "",
        voiceSurface: "concierge",
      });
      expect(useDictationStore.getState().status).toBe("listening");
      expect(useDictationStore.getState().phase).toBe("active");

      // THE `composer-interim` FORM. Both fields must reach the STORE, not just the return value:
      // the composer reads them from the store, so a handle that reported them without writing
      // would photograph an empty box while claiming success.
      const preview = mic({
        enabled: true,
        status: "listening",
        phase: "active",
        voiceSurface: "concierge",
        interim: "still provisional",
      });
      expect(preview.interim).toBe("still provisional");
      expect(preview.voiceSurface).toBe("concierge");
      expect(useDictationStore.getState().interim).toBe("still provisional");
      expect(useDictationStore.getState().voiceSurface).toBe("concierge");

      // An UNSTATED interim is LEFT ALONE, exactly as an unstated phase is — the seed says nothing
      // about it, so it must not be silently cleared out from under a surface that set it.
      const untouched = mic({ enabled: true, status: "listening" });
      expect(untouched.interim).toBe("still provisional");
      // …and an explicit "" is how a surface CLEARS it, which must still work.
      expect(mic({ enabled: true, status: "listening", interim: "" }).interim).toBe("");

      // The `{enabled:false}` form every pre-existing caller uses: status DEFAULTS to idle rather
      // than inheriting whatever the previous surface left behind, which is the cross-surface leak
      // the capture harness's whole reset exists to stop.
      const off = mic({ enabled: false });
      expect(off.status).toBe("idle");
      expect(useDictationStore.getState().status).toBe("idle");
      // …and an unstated phase is LEFT ALONE rather than reset, which is why the step makes its
      // phase comparison conditional.
      expect(off.phase).toBe("active");
    } finally {
      vi.unstubAllGlobals();
      useDictationStore.setState({ enabled: false, status: "idle", phase: "passive" });
    }
  });

  it("leaves the persisted UI blob untouched — ?projects=2 writes the OPEN-TAB set", () => {
    // `openProjectIds` is on uiStore's PERSISTED side, and the fixture now writes it for
    // `?projects=2` as well as `?pairs=2`. Undetached, a developer who opened their own dev server
    // with one of those parameters would get their real tab strip rewritten on disk: two projects
    // they have never opened, and their own ones closed. That reads as data loss, not as a fixture.
    //
    // THE KEY IS READ OFF THE STORE, NOT RE-SPELLED. uiStore has no exported persist-key constant
    // (the other three stores do), and a hardcoded "sparkle-ui" here would keep passing while
    // asserting an unrelated key stayed untouched if the store ever renamed its blob — a test that
    // cannot fail. Asking the persist middleware for its own `name` cannot drift.
    const UI_KEY = (
      useUiStore as unknown as { persist: { getOptions: () => { name?: string } } }
    ).persist.getOptions().name;
    expect(UI_KEY, "uiStore's persist options carry no name — the key below would be undefined")
      .toBeTruthy();
    const key = UI_KEY as string;
    localStorage.removeItem(key);
    try {
      // CONTROL FIRST, for the reason the debounced test below spells out: "the blob is untouched"
      // is satisfied just as well by a store that is not wired to storage at all. Prove a plain
      // mutation DOES reach disk through this key before asserting that the fixture's does not.
      useUiStore.setState({ composerHeight: 321 });
      const wrote = localStorage.getItem(key);
      const why = "control failed: uiStore is not wired to localStorage, so the claim below is vacuous";
      expect(wrote, why).not.toBeNull();
      expect(JSON.parse(wrote as string), why).toMatchObject({ state: expect.any(Object) });

      const REAL = JSON.stringify({ state: { openProjectIds: ["the-developers-real-project"] } });
      localStorage.setItem(key, REAL);
      expect(applyVisualFixtures("?visual=1&projects=2", ON)).toBe(true);
      // In memory the second tab is open, which is the whole point of the parameter...
      expect(useUiStore.getState().openProjectIds).toEqual([
        FIXTURE_PROJECT_ID,
        FIXTURE_SECOND_PROJECT_ID,
      ]);
      // ...and none of it reached storage.
      expect(localStorage.getItem(key)).toBe(REAL);
    } finally {
      localStorage.removeItem(key);
      useUiStore.setState({ openProjectIds: null });
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

  // ── THE OWNED ROW (bead sparkle-obggv) ──────────────────────────────────────────────────────
  //
  // Driven through `agentLinkForPr`, the REAL function the menu renders the "Open agent" pill
  // from, rather than by reading `agentId` back off the fixture. Reading the field would assert a
  // precondition that was true the moment it was typed; the pill's existence depends on the id
  // ALSO naming an agent in the roster, and that join is the half a typo breaks. `agentLinkForPr`
  // is explicit that a known owner missing from the roster yields null rather than falling through
  // to the branch join — so the failure this guards is silent by construction: the surface would
  // capture a menu with no pill and pass.
  it("gives exactly one row an owner that RESOLVES to a fixture agent", () => {
    const { project } = buildVisualFixture();
    const resolved = FIXTURE_PRS.map((p) => agentLinkForPr(p, [project], project.id));

    const owned = resolved.filter((link) => link !== null);
    expect(owned, "no fixture PR resolves to an agent — the pill cannot be photographed").toHaveLength(1);
    // A NAMED agent: the pill's tooltip reads "Open <name>", so an id resolving to a nameless row
    // would photograph as a broken tooltip while this test still saw a non-null link.
    expect(owned[0]!.agentName).toBeTruthy();
    expect(project.agents.some((a) => a.id === owned[0]!.agentId)).toBe(true);

    // …AND THE OTHERS RESOLVE TO NOTHING. One owned row among six is what puts both states in one
    // frame; without this half, a menu that rendered the pill on EVERY row would look identical in
    // the capture and pass the assertion above.
    expect(resolved.filter((link) => link === null).length).toBe(FIXTURE_PRS.length - 1);
  });
});

// ── THE SECOND-PROJECT PARAMETER, AND THE PER-ROOT PR LOOKUP IT EXISTS FOR ────────────────────
//
// The open-PR menu becomes a MULTI-REPO surface the moment two projects are open, and none of what
// that adds — section headers, per-repo scoping, PR numbers that are unique only within a repo —
// is photographable against a workspace holding one project. Same opt-in discipline as every other
// parameter here: a capture that does not ask for it must be byte-identical to what it was.
describe("the second-project parameter", () => {
  it("is opt-in — absent, every existing surface keeps its single-project baseline", () => {
    expect(visualProjectCount("?visual=1")).toBe(1);
    expect(visualProjectCount("")).toBe(1);
    expect(visualProjectCount("?visual=1&prs=1&concierge=190")).toBe(1);
  });

  it("opens the second project for exactly `2`", () => {
    expect(visualProjectCount("?visual=1&projects=2")).toBe(2);
    expect(visualProjectCount("?projects=2&visual=1")).toBe(2);
  });

  it("fails closed on anything else, so a typo cannot half-apply", () => {
    // A malformed value must land on the DEFAULT seed rather than on a partly-seeded workspace: a
    // capture of "one project but the menu asked for two" is the mislabelled-screenshot failure.
    for (const v of ["", "0", "1", "3", "two", "true", "2.0", " 2"]) {
      expect(visualProjectCount(`?visual=1&projects=${v}`), v).toBe(1);
    }
  });

  it("is a DIFFERENT axis from ?pairs=2 — neither parameter implies the other", () => {
    // They are easy to conflate and they do different things: `pairs` opens a second COLUMN PAIR
    // (a project projected onto the left of the cockpit), `projects` opens a second TAB in the pair
    // that is already there. A surface asking for one must not silently get the other, because a
    // second pair re-lays-out the entire shell.
    expect(visualProjectCount("?visual=1&pairs=2")).toBe(1);
    expect(visualPairCount("?visual=1&projects=2")).toBe(1);
  });
});

describe("the per-root open-PR lookup", () => {
  it("answers each project's OWN rows, keyed on the root the command is invoked with", () => {
    // The shim used to answer every call with one array regardless of `root`. With two projects
    // open that photographs two identical sections — a picture that looks like working grouping
    // whatever the component does.
    expect(fixturePrsForRoot(FIXTURE_PROJECT_ROOT)).toBe(FIXTURE_PRS);
    expect(fixturePrsForRoot(FIXTURE_SECOND_PROJECT_ROOT)).toBe(FIXTURE_SECOND_PRS);
    expect(fixturePrsForRoot(FIXTURE_PROJECT_ROOT)).not.toBe(
      fixturePrsForRoot(FIXTURE_SECOND_PROJECT_ROOT),
    );
  });

  it("resolves an unknown root to NULL — unknown, not empty", () => {
    // `fetchOpenPrs` collapses every probe failure into null, and null and `[]` are different facts:
    // a confident "no PRs" on a probe that never ran is the false reassurance the badge exists to
    // prevent. An unknown root must answer the way the shim it wraps does.
    expect(fixturePrsForRoot("/Users/dev/Projects/never-seeded")).toBeNull();
    expect(fixturePrsForRoot("")).toBeNull();
    expect(fixturePrsForRoot(undefined)).toBeNull();
    expect(fixturePrsForRoot(null)).toBeNull();
    expect(fixturePrsForRoot(42)).toBeNull();
  });

  it("does not treat Object.prototype members as known roots", () => {
    // `root` arrives from the caller, so a bare index would make "toString" a known key resolving
    // to a function the menu would then try to iterate.
    for (const k of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
      expect(fixturePrsForRoot(k), k).toBeNull();
    }
  });

  it("keys the lookup on the rootPaths the seeded projects actually carry", () => {
    // THE COUPLING THAT SILENTLY BREAKS EVERYTHING. If a project's `rootPath` and its lookup key
    // drift by one character, the probe resolves to null, the menu renders NOTHING, and the capture
    // is a perfectly plausible-looking empty header rather than a failure.
    const { project } = buildVisualFixture();
    const second = buildSecondProjectFixture().project;
    expect(Object.keys(FIXTURE_PRS_BY_ROOT).sort()).toEqual(
      [project.rootPath, second.rootPath].sort(),
    );
    expect(fixturePrsForRoot(project.rootPath)).toBeTruthy();
    expect(fixturePrsForRoot(second.rootPath)).toBeTruthy();
  });

  it("puts a COLLIDING PR number in both lists, because that is what grouping has to survive", () => {
    // A PR number is unique within a repo and nowhere else, so a grouped menu that keys a row, a
    // selection, a merge or a React `key` on the number alone is wrong the moment two repos are
    // open. Without a collision in the fixture the capture cannot show that mistake.
    const first = new Set<number>(FIXTURE_PRS.map((p) => p.number));
    const shared = FIXTURE_SECOND_PRS.filter((p) => first.has(p.number));
    expect(shared.length, "no PR number is shared — the grouping bug would be unphotographable")
      .toBeGreaterThan(0);
    // …and the colliding rows must be TELLABLE APART by eye, or the picture proves nothing either.
    for (const dup of shared) {
      const other = FIXTURE_PRS.find((p) => p.number === dup.number)!;
      expect(dup.title).not.toBe(other.title);
      expect(dup.headRefName).not.toBe(other.headRefName);
      expect(dup.url).not.toBe(other.url);
      // OPPOSITE STATUSES, which is what makes the shot decisive rather than suggestive: a menu
      // resolving a row by number alone renders a wrong DOT and a wrong merge affordance — visible
      // at a glance — instead of a subtly wrong link a reader would have to open to catch.
      expect(dup.checks, `#${dup.number} carries the same status in both repos`).not.toBe(
        other.checks,
      );
    }
  });

  it("keeps the second list SHORTER, so the section boundary is the legible thing", () => {
    expect(FIXTURE_SECOND_PRS.length).toBeGreaterThanOrEqual(2);
    expect(FIXTURE_SECOND_PRS.length).toBeLessThan(FIXTURE_PRS.length);
  });
});

describe("applyVisualFixtures with a second project", () => {
  beforeEach(() => {
    useProjectStore.setState({ projects: [], selectedProjectId: null });
    useUiStore.setState({ openProjectIds: null, pairAssignment: {}, leftProjectId: null });
  });

  it("opens a second TAB, not a second PAIR", () => {
    // The two opt-ins are a pair of parameters it is easy to conflate, and getting it wrong is
    // expensive: a second pair re-lays-out the entire shell, so a `?projects=2` capture that
    // accidentally opened one would be a picture of a different layout under this surface's name.
    // A stale persisted assignment could do it on its own, which is why the seed CLEARS both rather
    // than leaving them alone.
    useUiStore.setState({
      pairAssignment: { [FIXTURE_SECOND_PROJECT_ID]: "left" },
      leftProjectId: FIXTURE_SECOND_PROJECT_ID,
    });
    expect(applyVisualFixtures("?visual=1&projects=2", ON)).toBe(true);
    expect(useUiStore.getState().pairAssignment).toEqual({});
    expect(useUiStore.getState().leftProjectId).toBeNull();
  });

  it("seeds two DISTINCT projects, both with a tab, when ?projects=2 is asked for", () => {
    expect(applyVisualFixtures("?visual=1&projects=2", ON)).toBe(true);
    const projects = useProjectStore.getState().projects;
    expect(projects.map((p) => p.id)).toEqual([FIXTURE_PROJECT_ID, FIXTURE_SECOND_PROJECT_ID]);
    // DISTINCT names and root paths: the name is rendered as a section header, so two near-identical
    // ones would make the capture unreadable as evidence, and two identical roots would collapse the
    // per-root lookup back into one list.
    expect(new Set(projects.map((p) => p.name)).size).toBe(2);
    expect(new Set(projects.map((p) => p.rootPath)).size).toBe(2);
    // OPEN — and asserted as an EXPLICIT SET, not only through the predicate. `isProjectOpen`
    // answers true for every project when the set is `null`, so a fixture that never wrote the set
    // at all would satisfy the predicate alone and leave this test unable to fail (the vacuous-test
    // trap). The written array is what makes the tab survive a stale persisted set, so assert it
    // directly, then run the app's own predicate over it rather than re-implementing the null rule.
    const open = useUiStore.getState().openProjectIds;
    expect(open, "the open-tab set must be written explicitly, not left as null").toEqual([
      FIXTURE_PROJECT_ID,
      FIXTURE_SECOND_PROJECT_ID,
    ]);
    for (const p of projects) expect(isProjectOpen(p.id, open), p.id).toBe(true);
    // The PRIMARY project stays selected, so the pane under the panel is the one every other
    // open-PR surface photographs.
    expect(useProjectStore.getState().selectedProjectId).toBe(FIXTURE_PROJECT_ID);
  });

  it("gives the second project's agents a status and a stage too", () => {
    expect(applyVisualFixtures("?visual=1&projects=2", ON)).toBe(true);
    const { status, workflowStage } = useRuntimeStore.getState();
    const all = useProjectStore.getState().projects.flatMap((p) => p.agents);
    expect(all.length).toBeGreaterThan(buildVisualFixture().project.agents.length);
    for (const a of all) {
      expect(status[a.id], a.id).toBeTruthy();
      expect(workflowStage[a.id], a.id).toBeTruthy();
    }
  });

  it("uses agent ids that cannot collide with the other projects'", () => {
    // Unlike the PR numbers, an agent id collision is a fixture BUG: two rows under one key make the
    // capture quietly wrong rather than fail.
    expect(applyVisualFixtures("?visual=1&projects=2&pairs=2", ON)).toBe(true);
    const ids = useProjectStore.getState().projects.flatMap((p) => p.agents.map((a) => a.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("composes with ?pairs=2 rather than replacing it", () => {
    // Both opt-ins at once: three projects, all open, and the LEFT pair still assigned — a capture
    // may legitimately want a two-pair cockpit whose right pair holds two tabs.
    expect(applyVisualFixtures("?visual=1&projects=2&pairs=2", ON)).toBe(true);
    const projects = useProjectStore.getState().projects;
    expect(projects).toHaveLength(3);
    const ui = useUiStore.getState();
    expect(ui.openProjectIds).toHaveLength(3);
    expect(ui.leftProjectId).toBeTruthy();
  });

  it("changes NOTHING when it is not asked for — the byte-identical baseline", () => {
    // The whole opt-in discipline in one assertion: without the parameter the store holds exactly
    // one project, and its tab set names exactly that project — behaviourally identical to the
    // store's own `null` ("everything is open") for a one-project workspace, so every existing
    // surface's baseline is untouched.
    expect(applyVisualFixtures("?visual=1&prs=1&concierge=190", ON)).toBe(true);
    expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual([FIXTURE_PROJECT_ID]);
    expect(useUiStore.getState().openProjectIds).toEqual([FIXTURE_PROJECT_ID]);
  });

  it("gives the seeded project a tab even against a HOSTILE persisted open set", () => {
    // roborev 57710. The tab set used to be written only when a second project or pair was asked
    // for, so on the default path all three ui keys were whatever `sparkle-ui` rehydrated. A
    // persisted `openProjectIds` that is a real array NOT naming the fixture project makes
    // `isProjectOpen` false — the seeded project gets NO TAB — and a stale `pairAssignment` opens a
    // second pair under a filename claiming a single-pair layout. Both are silent: the capture is a
    // plausible-looking picture of the wrong workspace.
    useUiStore.setState({
      openProjectIds: ["someone-elses-project"],
      pairAssignment: { "someone-elses-project": "left" },
      leftProjectId: "someone-elses-project",
    });
    expect(applyVisualFixtures("?visual=1&prs=1", ON)).toBe(true);
    const ui = useUiStore.getState();
    expect(ui.openProjectIds).toEqual([FIXTURE_PROJECT_ID]);
    expect(isProjectOpen(FIXTURE_PROJECT_ID, ui.openProjectIds)).toBe(true);
    expect(ui.pairAssignment).toEqual({});
    expect(ui.leftProjectId).toBeNull();
  });
});

// ── THE SHIM ITSELF, NOT JUST THE LOOKUP IT CALLS ─────────────────────────────────────────────
//
// roborev 57710. The headline behaviour — `project_open_prs` answered PER ROOT — lives at the
// `__TAURI_INTERNALS__.invoke` wrapper, and this file runs in the NODE environment where
// `typeof window !== "undefined"` is false, so that block never executed in any test. Testing
// `fixturePrsForRoot` in isolation therefore left the CALL SITE unverified: passing
// `FIXTURE_PROJECT_ROOT` instead of the command's own `root`, or reading `projectId` by mistake,
// collapses both projects back onto one list — the "two identical sections that look like working
// grouping" failure this whole change exists to prevent — with the suite still green.
//
// A hand-stubbed `globalThis.window` rather than a jsdom docblock: the block under test needs
// exactly one thing from a browser (an object at `window.__TAURI_INTERNALS__` it can wrap), and
// moving the whole file to jsdom would change the environment every other test here runs in.
describe("the project_open_prs shim", () => {
  const g = globalThis as unknown as { window?: unknown };
  const HAD_WINDOW = "window" in g;
  const REAL_WINDOW = g.window;

  afterEach(() => {
    if (HAD_WINDOW) g.window = REAL_WINDOW;
    else delete g.window;
  });

  /** Install a fake IPC boundary and return both it and the spy the shim must fall through to. */
  function stubWindow() {
    const inner = vi.fn((cmd: string, args?: unknown) => Promise.resolve(`inner:${cmd}:${!!args}`));
    g.window = { __TAURI_INTERNALS__: { invoke: inner } };
    return {
      inner,
      invoke: () =>
        (g.window as { __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> } })
          .__TAURI_INTERNALS__.invoke,
    };
  }

  it("answers each root with ITS OWN rows, reading `root` off the command's arguments", async () => {
    const { inner, invoke } = stubWindow();
    expect(applyVisualFixtures("?visual=1&prs=1&projects=2", ON)).toBe(true);
    // The exact argument shape `fetchOpenPrs` sends, `projectId` included — a shim reading the
    // wrong field would still find a string there and answer confidently with null.
    await expect(
      invoke()("project_open_prs", { root: FIXTURE_PROJECT_ROOT, projectId: FIXTURE_PROJECT_ID }),
    ).resolves.toBe(FIXTURE_PRS);
    await expect(
      invoke()("project_open_prs", {
        root: FIXTURE_SECOND_PROJECT_ROOT,
        projectId: FIXTURE_SECOND_PROJECT_ID,
      }),
    ).resolves.toBe(FIXTURE_SECOND_PRS);
    // UNKNOWN, NOT EMPTY — the same answer the transport shim gives for a command it cannot serve.
    await expect(invoke()("project_open_prs", { root: "/Users/dev/Projects/nope" })).resolves.toBeNull();
    await expect(invoke()("project_open_prs", {})).resolves.toBeNull();
    // None of that reached the real transport…
    expect(inner).not.toHaveBeenCalled();
    // …and every OTHER command still does, unchanged.
    await expect(invoke()("some_other_command", { a: 1 })).resolves.toBe(
      "inner:some_other_command:true",
    );
    expect(inner).toHaveBeenCalledWith("some_other_command", { a: 1 });
  });

  it("is not installed at all without ?prs=1", () => {
    // Opt-in at the IPC boundary too: the shim is installed for every page, so an answer that
    // leaked outside `?prs=1` would put a PR chip in every other surface's header.
    const { inner, invoke } = stubWindow();
    expect(applyVisualFixtures("?visual=1&projects=2", ON)).toBe(true);
    expect(invoke()).toBe(inner);
  });

  it("sends the argument name services/openPrs.ts actually invokes with", () => {
    // The coupling that no assertion in this file can otherwise see, pinned the way the FROZEN_CLOCK
    // test pins serve.mjs: read the real call site's source. If `fetchOpenPrs` ever renames `root`,
    // every root here resolves to null, the menu renders nothing, and the capture is a plausible
    // empty header rather than a failure.
    const src = readFileSync(resolve(__dirname, "../services/openPrs.ts"), "utf8");
    expect(
      src,
      "fetchOpenPrs no longer invokes project_open_prs with a `root` argument — the shim's key is stale",
    ).toMatch(/invoke<[^>]*>\(\s*"project_open_prs",\s*\{\s*root\b/);
  });
});

describe("the sparkle-biezi capture row — its ONE load-bearing property", () => {
  // WHY THIS TEST EXISTS (roborev 57769). `vfx-agent-8` is the row that photographs the expiry
  // colour fix, and its entire value rests on a property that was EMERGENT and pinned nowhere: that
  // `expired-goal` is its ONLY stall cause, so its dot is a direct readout of
  // `stallEscalation.OUTSTANDING` membership.
  //
  // That property falls out of three independent facts — `status: "idle"`, a `stage` that lands
  // OUTSIDE `hasUnmergedCommittedWork`'s band, and no seeded PR/dirty-tree evidence. Any one of them
  // can drift silently: move the row to `pull_request`, flip its status, or shift that band's upper
  // bound in workflowStage.ts, and the row picks up `unlanded-work`, paints red for a reason that has
  // nothing to do with expiry, and the capture goes vacuous — identical before and after — with the
  // whole suite still green. That is the same failure the row's own comment warns about, and the same
  // one that already bit this file twice (roborev 57429, 57331).
  //
  // Asserted through `stallInputsFor`, the PRODUCTION mapper, rather than a hand-built StallInput: a
  // fixture whose evidence I assembled myself would prove my assembly, not the app's.
  /** Every seeded row whose ONLY stall cause is `expired-goal`, as the harness would see it.
   *
   *  SHARED BY BOTH TESTS ON PURPOSE (roborev 57779). The second test used to re-find its subject by
   *  a DIFFERENT predicate — "the row at stage `merged` that has a goal" — and then assert that row's
   *  section is `remote_merged`, which is a tautology on a pure switch: it had selected the row BY
   *  that stage. Worse, the two tests could drift onto different rows and both stay green while
   *  neither described the row the capture actually photographs. Selecting once, by the property that
   *  matters, is what makes the stage assertion below a real claim.
   *
   *  Built through `stallInputsFor`, the PRODUCTION mapper, so this proves the app's evidence
   *  assembly rather than my restatement of it. The harness seeds the stage watermark and nothing
   *  else, so branchStatus and workflowState are genuinely absent here, not defaulted. */
  function soleExpiryRows() {
    const { project, status, workflowStage, branchStatus } = buildVisualFixture();
    const rows = project.agents.filter((a) => {
      const report = stallReport(
        stallInputsFor(status[a.id] as AgentTabStatus, FIXTURE_NOW, a.goal, {
          stageOverride: workflowStage[a.id],
        }),
      );
      return report.verdict === "stalled" && report.causes.length === 1 && report.causes[0] === "expired-goal";
    });
    return { rows, status, workflowStage, branchStatus };
  }

  it("every sole-expiry row is CALM — a red one could not show 'finished renders gray'", () => {
    const { rows, status } = soleExpiryRows();
    expect(
      rows.map((a) => a.name),
      "no fixture row has `expired-goal` as its sole stall cause — the agent-sidebar capture can no " +
        "longer photograph the expiry colour fix, and would look identical with or without it",
    ).not.toHaveLength(0);
    for (const r of rows) {
      expect(bandOfStatus(status[r.id] as AgentTabStatus), `${r.name} is not calm`).toBe("done");
    }
  });

  // ── THE PIN THE 2026-08-19 RULE REWRITES ────────────────────────────────────────────────────────
  // The test above says CALM, and calm is still true of every one of these rows: `lapsed` bands
  // `done` exactly as `idle` does, so expiry still never reddens anything and sparkle-biezi holds.
  //
  // What changed is the DOT, which is what the capture actually photographs. The founder, 2026-08-19:
  // *"Nothing should ever be gray unless it has been effectively finished. So that would be like a
  // remote merge domain or shipped status."* So "sole-expiry ⇒ gray" is no longer one rule — it
  // splits on section, and these fixtures happen to hold one row on each side of that split.
  //
  // BOTH POPULATIONS ARE ASSERTED NON-EMPTY. Absence in a section nothing occupies proves nothing —
  // it is the same vacuity the row's own comment warns about — so a fixture drifting entirely to one
  // side must fail here rather than silently testing a single case twice.
  it("after the terminal-gray floor, ONLY the merged-section expiry row keeps its gray dot", () => {
    const { rows, status, workflowStage } = soleExpiryRows();
    const seen = { gray: 0, amber: 0 };
    for (const r of rows) {
      const st = status[r.id] as AgentTabStatus;
      const section = sectionOfStage(workflowStage[r.id]!);
      const floored = grayFloorFor(st, section) ?? st;
      if (GRAY_LEGAL_SECTIONS.has(section)) {
        expect(AGENT_STATUS[floored].color, `${r.name} has shipped — gray is legal`).toBe(
          AGENT_STATUS.idle.color,
        );
        seen.gray += 1;
      } else {
        expect(floored, `${r.name} is short of a terminal section and must not read finished`).toBe(
          "lapsed",
        );
        expect(AGENT_STATUS[floored].color).toBe(AGENT_STATUS.lapsed.color);
        seen.amber += 1;
      }
    }
    expect(seen.gray, "no sole-expiry row in a terminal section — the control is gone").toBeGreaterThan(0);
    expect(seen.amber, "no sole-expiry row in a pre-terminal section — the rule is unphotographed").toBeGreaterThan(0);
    // The two colours must actually differ, or the capture shows one dot twice.
    expect(AGENT_STATUS.lapsed.color).not.toBe(AGENT_STATUS.idle.color);
  });

  it("covers BOTH stages the founder saw the bug at — merged, and pre-commit", () => {
    // His four red rows were not all alike: three were labelled MERGED TO MAIN, and Babysit PR 1104
    // sat in LOCAL: UNCOMMITTED. A fixture proving the rule from only one of those would leave the
    // other unphotographed, and they exercise different arms — the merged row's `hasUnlandedWork` is
    // false via the stage band, the pre-commit row's via a positively-read clean worktree.
    const { rows, workflowStage } = soleExpiryRows();
    const stages = rows.map((r) => workflowStage[r.id]);
    expect(stages, "no sole-expiry row at `merged`").toContain("merged");
    expect(stages, "no sole-expiry row at `building_unsaved`").toContain("building_unsaved");
  });

  it("the pre-commit sole-expiry row lands in `local_none`, NOT `local_uncommitted`", () => {
    // BUG 2, on the same row that proves BUG 1 — which is what the founder actually saw: one agent
    // reading "broken AND unsaved" while it was finished and holding nothing.
    const { rows, workflowStage, branchStatus } = soleExpiryRows();
    const row = rows.find((r) => workflowStage[r.id] === "building_unsaved");
    expect(row, "no pre-commit sole-expiry row").toBeDefined();
    // Its worktree must be POSITIVELY READ as empty; an unseeded row would read `undefined` and
    // stay in `local_uncommitted`, making the capture vacuous for this half.
    const holds = uncommittedWorkEvidence(branchStatus[row!.id]);
    expect(holds, "the row's worktree was never seeded — the capture cannot show the split").toBe(false);
    expect(sectionOfRow(workflowStage[row!.id]!, holds)).toBe("local_none");
  });

  it("keeps a DIRTY control at the same stage, in `local_uncommitted`, naming its files", () => {
    // The control that makes the split above mean something: same stage, same idle status, differing
    // only in whether the tree holds anything. Without it a capture could not show that the column
    // distinguishes them rather than having simply relabelled the rung.
    const { project, status, workflowStage, branchStatus } = buildVisualFixture();
    const dirty = project.agents.filter(
      (a) =>
        workflowStage[a.id] === "building_unsaved" &&
        status[a.id] === "idle" &&
        uncommittedWorkEvidence(branchStatus[a.id]) === true,
    );
    expect(dirty, "no idle pre-commit row with a dirty tree").not.toHaveLength(0);
    const row = dirty[0]!;
    expect(sectionOfRow(workflowStage[row.id]!, true)).toBe("local_uncommitted");
    // …and it NAMES what it holds — the other half of BUG 2.
    const chip = stallChipFor(
      stallReport(
        stallInputsFor(status[row.id] as AgentTabStatus, FIXTURE_NOW, row.goal, {
          bs: branchStatus[row.id],
          stageOverride: workflowStage[row.id],
        }),
      ),
      branchStatus[row.id],
    );
    expect(chip?.text).toMatch(/^\S+\.\w+/);
    expect(chip?.files.length).toBeGreaterThan(0);
  });
});
