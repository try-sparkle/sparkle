// @vitest-environment jsdom
//
// `previewOpenOutcomeFor` is a PREDICTION, and it is the gate on the one thing this feature may
// never get wrong: a pane opening unasked. Design doc §10 states the failure mode plainly — "twenty
// agents finishing a build within a minute of each other, twenty panes stealing the screen, several
// of them showing a broken build. That is strictly worse than no feature."
//
// So this mirrors `agentReveal.outcome.test.ts` exactly: every row below starts from a state whose
// FULL conjunction is satisfied and breaks precisely ONE clause, which is what makes each row
// falsifiable — delete that clause from `previewOpenOutcomeFor` and exactly one of these fails.
//
// Plus the mirror test at the bottom, which is the only one here that can catch DRIFT: it drives
// the REAL production entry point (`applyPreviewStatus`, the fold that every Rust `preview:state`
// event goes through) rather than restating the prediction, and asserts that the pane opened when
// the prediction said "opened" and that every store is byte-identical when it declined.
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUTO_OPEN_REQUEST_TTL_MS,
  autoOpenPreviewIfWarranted,
  previewOpenOutcomeFor,
} from "./previewOpenOutcomeFor";
import { applyPreviewStatus } from "./preview";
import { usePreviewStore, type PreviewState } from "../stores/previewStore";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useUiStore } from "../stores/uiStore";

/**
 * The state in which ALL five conditions hold, so every row can break exactly one.
 *
 * Deliberately the founder's awkward shape, same as the reveal test's: the agent lives in `p2`,
 * which is assigned to the LEFT pair, while `selectedProjectId` (the RIGHT pair's slot) names `p1`.
 * A condition that reads `selectedProjectId` for a left-assigned project answers about a pair that
 * does not hold it — the exact confusion `selectProjectOnItsSide` exists for.
 */
function seedFullyEligible(over: { ui?: object; ps?: object; preview?: object } = {}) {
  useRuntimeStore.setState({ openAgentIds: ["ag2"] } as never);
  useUiStore.setState({
    openProjectIds: null,
    pairAssignment: { p2: "left" },
    leftProjectId: "p2",
    activeSpecial: null,
    workModeBySide: { left: "build", right: "build" },
    ...over.ui,
  } as never);
  useProjectStore.setState({
    projects: [
      { id: "p1", name: "sparkle", agents: [{ id: "ag1", name: "Build 7" }] },
      { id: "p2", name: "other", agents: [{ id: "ag2", name: "Build 8" }], selectedAgentId: "ag2" },
    ],
    selectedProjectId: "p1",
    ...over.ps,
  } as never);
  useSettingsStore.setState({ previewAutoOpen: "returning" } as never);
  usePreviewStore.setState({
    // Condition 2 — the user has opened a preview for this project once already this session.
    openedProjects: { p2: true },
    byAgent: {
      ag2: {
        id: "srv-1",
        status: "ready" as PreviewState,
        url: "http://127.0.0.1:5173",
        port: 5173,
        error: null,
        startedAt: Date.now(),
        reloadNonce: 0,
        // Condition 5 — it became worth surfacing just now.
        surfacedAt: Date.now(),
      },
    },
    ...over.preview,
  } as never);
}

beforeEach(() => seedFullyEligible());

describe("previewOpenOutcomeFor — the conjunction", () => {
  it("opens when every one of the five conditions holds", () => {
    expect(previewOpenOutcomeFor("p2", "ag2")).toBe("opened");
  });

  it("declines for an agent that is not in that project", () => {
    expect(previewOpenOutcomeFor("p2", "nope")).toBe("declined-gone");
  });

  it("declines for a project that does not exist", () => {
    expect(previewOpenOutcomeFor("nope", "ag2")).toBe("declined-gone");
  });

  // ══ CONDITION 1 — that agent is already the selected agent in its pair ═══════════════════════

  it("declines when the project's TAB is closed", () => {
    seedFullyEligible({ ui: { openProjectIds: ["p1"] } });
    expect(previewOpenOutcomeFor("p2", "ag2")).toBe("declined-not-selected");
  });

  it("declines when the project is not selected ON ITS OWN SIDE", () => {
    // p2 is LEFT-assigned, so the left slot is what has to name it. `selectedProjectId` being "p1"
    // is a fact about the RIGHT pair and must not be read as the answer here.
    seedFullyEligible({ ui: { leftProjectId: "p1" } });
    expect(previewOpenOutcomeFor("p2", "ag2")).toBe("declined-not-selected");
  });

  it("reads the RIGHT pair's selection for an unassigned project", () => {
    // Absent from the map means right (engine/pairs.sideOf), where `selectedProjectId` IS the slot.
    seedFullyEligible({ ui: { pairAssignment: {}, leftProjectId: null } });
    expect(previewOpenOutcomeFor("p2", "ag2")).toBe("declined-not-selected");
    seedFullyEligible({
      ui: { pairAssignment: {}, leftProjectId: null },
      ps: { selectedProjectId: "p2" },
    });
    expect(previewOpenOutcomeFor("p2", "ag2")).toBe("opened");
  });

  it("declines when a DIFFERENT agent is the project's selected one", () => {
    seedFullyEligible({
      ps: {
        projects: [
          { id: "p1", name: "sparkle", agents: [{ id: "ag1", name: "Build 7" }] },
          {
            id: "p2",
            name: "other",
            agents: [
              { id: "ag2", name: "Build 8" },
              { id: "ag3", name: "Build 9" },
            ],
            selectedAgentId: "ag3",
          },
        ],
      },
    });
    expect(previewOpenOutcomeFor("p2", "ag2")).toBe("declined-not-selected");
  });

  it("declines while an app-global overlay covers the pane", () => {
    // `uiStore.openPreview` clears `activeSpecial` for the Sparkle-pane side, so firing here would
    // DISMISS an overlay the user is reading — the loudest possible theft, from the one path that
    // is supposed to steal nothing.
    seedFullyEligible({ ui: { activeSpecial: "sparkle" } });
    expect(previewOpenOutcomeFor("p2", "ag2")).toBe("declined-overlay");
  });

  // ══ CONDITION 2 — the user opened a preview for this project at least once this session ══════

  it("declines when the user has never opened a preview for this project this session", () => {
    seedFullyEligible({ preview: { openedProjects: {} } });
    expect(previewOpenOutcomeFor("p2", "ag2")).toBe("declined-not-opened-this-session");
  });

  it("counts the session flag PER PROJECT, not globally", () => {
    seedFullyEligible({ preview: { openedProjects: { p1: true } } });
    expect(previewOpenOutcomeFor("p2", "ag2")).toBe("declined-not-opened-this-session");
  });

  // ══ CONDITION 3 — that pair is in Build mode; never interrupt Plan ═══════════════════════════

  it("declines while that column is on the Plan board", () => {
    // PER SIDE. The RIGHT column being on plan says nothing about a left-assigned project.
    seedFullyEligible({ ui: { workModeBySide: { left: "plan", right: "build" } } });
    expect(previewOpenOutcomeFor("p2", "ag2")).toBe("declined-not-build-mode");

    seedFullyEligible({ ui: { workModeBySide: { left: "build", right: "plan" } } });
    expect(previewOpenOutcomeFor("p2", "ag2")).toBe("opened");
  });

  // ══ CONDITION 4 — no preview is already open in that pair ════════════════════════════════════

  it("reports already-showing when that pair is ALREADY previewing this very agent", () => {
    seedFullyEligible({ ui: { workModeBySide: { left: "preview", right: "build" } } });
    expect(previewOpenOutcomeFor("p2", "ag2")).toBe("already-showing");
  });

  it("declines when that pair is previewing a DIFFERENT agent", () => {
    seedFullyEligible({
      ui: { workModeBySide: { left: "preview", right: "build" } },
      ps: {
        projects: [
          { id: "p1", name: "sparkle", agents: [{ id: "ag1", name: "Build 7" }] },
          {
            id: "p2",
            name: "other",
            agents: [
              { id: "ag2", name: "Build 8" },
              { id: "ag3", name: "Build 9" },
            ],
            selectedAgentId: "ag3",
          },
        ],
      },
    });
    expect(previewOpenOutcomeFor("p2", "ag2")).toBe("declined-already-open");
  });

  // ══ CONDITION 5 — fresher than the TTL ═══════════════════════════════════════════════════════

  it("declines a request older than the TTL", () => {
    seedFullyEligible({
      preview: {
        openedProjects: { p2: true },
        byAgent: {
          ag2: {
            id: "srv-1",
            status: "ready",
            url: "http://127.0.0.1:5173",
            port: 5173,
            error: null,
            startedAt: Date.now(),
            reloadNonce: 0,
            surfacedAt: Date.now() - AUTO_OPEN_REQUEST_TTL_MS - 1,
          },
        },
      },
    });
    expect(previewOpenOutcomeFor("p2", "ag2")).toBe("declined-stale");
  });

  it("declines when this agent has no preview entry at all", () => {
    seedFullyEligible({ preview: { openedProjects: { p2: true }, byAgent: {} } });
    expect(previewOpenOutcomeFor("p2", "ag2")).toBe("declined-stale");
  });

  it("declines when the entry never reached a state worth surfacing", () => {
    seedFullyEligible({
      preview: {
        openedProjects: { p2: true },
        byAgent: {
          ag2: {
            id: null,
            status: "starting",
            url: null,
            port: null,
            error: null,
            startedAt: Date.now(),
            reloadNonce: 0,
            surfacedAt: null,
          },
        },
      },
    });
    expect(previewOpenOutcomeFor("p2", "ag2")).toBe("declined-stale");
  });

  it("is EXCLUSIVE at the boundary — exactly TTL old is already stale", () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      seedFullyEligible({
        preview: {
          openedProjects: { p2: true },
          byAgent: {
            ag2: {
              id: "srv-1",
              status: "ready",
              url: "http://127.0.0.1:5173",
              port: 5173,
              error: null,
              startedAt: now,
              reloadNonce: 0,
              surfacedAt: now - AUTO_OPEN_REQUEST_TTL_MS,
            },
          },
        },
      });
      expect(previewOpenOutcomeFor("p2", "ag2")).toBe("declined-stale");
    } finally {
      vi.restoreAllMocks();
    }
  });
});

// ══ THE CONFIG — [preview] auto_open ═══════════════════════════════════════════════════════════

describe("previewOpenOutcomeFor — auto_open", () => {
  it('"never" declines even from a fully satisfied conjunction', () => {
    useSettingsStore.setState({ previewAutoOpen: "never" } as never);
    expect(previewOpenOutcomeFor("p2", "ag2")).toBe("declined-auto-open-disabled");
  });

  it('"never" wins over every other decline reason — it is checked first', () => {
    // The reason must not depend on WHICH other clause also fails, or the log line stops answering
    // "why didn't my preview open" and starts answering "which clause did we happen to test first".
    seedFullyEligible({ ui: { workModeBySide: { left: "plan", right: "build" } } });
    useSettingsStore.setState({ previewAutoOpen: "never" } as never);
    expect(previewOpenOutcomeFor("p2", "ag2")).toBe("declined-auto-open-disabled");
  });

  it('"always" opens through the two RETURNING-PREVIEWER clauses, and only those', () => {
    // Never previewed this project by hand, and no surfacing moment at all — both fatal under
    // `"returning"`, both irrelevant to `"always"`. Everything about WHERE the pane would land is
    // still satisfied, which is the half `"always"` does not get to skip.
    seedFullyEligible({ preview: { openedProjects: {}, byAgent: {} } });
    useSettingsStore.setState({ previewAutoOpen: "always" } as never);
    expect(previewOpenOutcomeFor("p2", "ag2")).toBe("opened");
  });

  // ══ WHAT `"always"` MAY NOT SKIP, and why these are not the same class of clause ═════════════
  //
  // `autoOpenPreviewIfWarranted` performs exactly ONE write: `openPreview(side)`, which flips that
  // column's mode. It does NOT select the project on that side, open its tab, or select the agent —
  // deliberately, because doing all of that is a full REVEAL, an interruption far larger than the
  // one §10 is authorising.
  //
  // The consequence is what these rows pin: `PreviewSlot` renders `project.selectedAgentId` of
  // whichever project that side is ALREADY showing (`Workspace.tsx` hands it `leftProject` /
  // `project`; `PreviewSlot.tsx:112-113` reads the agent off it). So flipping the mode for an agent
  // that is not what its pair is showing does not reveal that agent's preview — it covers the
  // terminal the user was watching with someone ELSE'S pane, usually the empty "no server" state.
  //
  // That is strictly worse than not firing, so "is this agent what its pair is showing" is not a
  // returning-previewer question at all; it is a precondition for the write to mean anything. Same
  // for the Plan board, which §10 states flatly ("never interrupt Plan") rather than as a tunable.
  // An earlier version of this file asserted the opposite and certified the wrong-pane behaviour as
  // intended — caught in review, and these rows are the correction.

  it('"always" still declines when the agent is not what its pair is showing', () => {
    seedFullyEligible({ ui: { leftProjectId: "p1" } });
    useSettingsStore.setState({ previewAutoOpen: "always" } as never);
    expect(previewOpenOutcomeFor("p2", "ag2")).toBe("declined-not-selected");
  });

  it('"always" still declines when the project\'s tab is closed', () => {
    seedFullyEligible({ ui: { openProjectIds: ["p1"] } });
    useSettingsStore.setState({ previewAutoOpen: "always" } as never);
    expect(previewOpenOutcomeFor("p2", "ag2")).toBe("declined-not-selected");
  });

  it('"always" still declines when a DIFFERENT agent is the project\'s selected one', () => {
    seedFullyEligible({
      ps: {
        projects: [
          { id: "p1", name: "sparkle", agents: [{ id: "ag1", name: "Build 7" }] },
          {
            id: "p2",
            name: "other",
            agents: [
              { id: "ag2", name: "Build 8" },
              { id: "ag3", name: "Build 9" },
            ],
            selectedAgentId: "ag3",
          },
        ],
      },
    });
    useSettingsStore.setState({ previewAutoOpen: "always" } as never);
    expect(previewOpenOutcomeFor("p2", "ag2")).toBe("declined-not-selected");
  });

  it('"always" still refuses to interrupt the Plan board', () => {
    seedFullyEligible({ ui: { workModeBySide: { left: "plan", right: "build" } } });
    useSettingsStore.setState({ previewAutoOpen: "always" } as never);
    expect(previewOpenOutcomeFor("p2", "ag2")).toBe("declined-not-build-mode");
  });

  it('"always" still refuses to steal a preview already open in that pair', () => {
    // The founder's escape hatch is "open more eagerly", not "take the pane away from whatever is
    // in it". Conditions 1-3 and 5 answer *is this user a returning previewer*; condition 4 and the
    // overlay guard answer *is something already on this screen* — a different question, and the
    // only one whose wrong answer destroys something the user is looking at.
    useSettingsStore.setState({ previewAutoOpen: "always" } as never);
    seedFullyEligible({
      ui: { workModeBySide: { left: "preview", right: "build" } },
      ps: {
        projects: [
          { id: "p1", name: "sparkle", agents: [{ id: "ag1", name: "Build 7" }] },
          {
            id: "p2",
            name: "other",
            agents: [
              { id: "ag2", name: "Build 8" },
              { id: "ag3", name: "Build 9" },
            ],
            selectedAgentId: "ag3",
          },
        ],
      },
    });
    useSettingsStore.setState({ previewAutoOpen: "always" } as never);
    expect(previewOpenOutcomeFor("p2", "ag2")).toBe("declined-already-open");
  });

  it('"always" still refuses to dismiss an app-global overlay', () => {
    useSettingsStore.setState({ previewAutoOpen: "always" } as never);
    seedFullyEligible({ ui: { activeSpecial: "sparkle" } });
    useSettingsStore.setState({ previewAutoOpen: "always" } as never);
    expect(previewOpenOutcomeFor("p2", "ag2")).toBe("declined-overlay");
  });

  it("an unrecognized value is read as the default, never as always", () => {
    // Rust validates and falls back, so the wire can only carry the three — but this reads a store
    // field, and a fail-open default here would auto-pop panes on a typo nobody can see.
    useSettingsStore.setState({ previewAutoOpen: "yes-please" } as never);
    seedFullyEligible({ preview: { openedProjects: {} } });
    useSettingsStore.setState({ previewAutoOpen: "yes-please" } as never);
    expect(previewOpenOutcomeFor("p2", "ag2")).toBe("declined-not-opened-this-session");
  });
});

// ══ PURITY, AND THE MIRROR ═════════════════════════════════════════════════════════════════════

/** Everything the auto-open path is able to touch, deep-compared. */
const stores = () =>
  JSON.stringify({
    ui: useUiStore.getState(),
    projects: useProjectStore.getState().projects,
    selectedProjectId: useProjectStore.getState().selectedProjectId,
    openAgentIds: useRuntimeStore.getState().openAgentIds,
    preview: usePreviewStore.getState().byAgent,
    openedProjects: usePreviewStore.getState().openedProjects,
  });

describe("previewOpenOutcomeFor writes nothing", () => {
  it("is a prediction — calling it repeatedly cannot change the answer", () => {
    const before = stores();
    expect(previewOpenOutcomeFor("p2", "ag2")).toBe("opened");
    expect(previewOpenOutcomeFor("p2", "ag2")).toBe("opened");
    expect(previewOpenOutcomeFor("p1", "ag1")).toBe("declined-not-selected");
    expect(stores()).toBe(before);
  });
});

describe("the prediction MATCHES what the real auto-open path does", () => {
  // Every row above breaks ONE clause and asserts the prediction notices. All of them would stay
  // green if the ACT half stopped honouring the prediction — so these two drive the production
  // entry point instead: `applyPreviewStatus` is the fold every Rust `preview:state` event goes
  // through, and it is what arms the trigger.
  const arrive = (state: PreviewState) =>
    applyPreviewStatus({
      id: "srv-1",
      agentId: "ag2",
      projectId: "p2",
      url: "http://127.0.0.1:5173",
      port: 5173,
      state,
      error: null,
    });

  it("a preview_state event reaching `ready` from a fully eligible state OPENS the pane", () => {
    // Start from "nothing has surfaced yet", so the event itself is the transition.
    seedFullyEligible({
      preview: {
        openedProjects: { p2: true },
        byAgent: {
          ag2: {
            id: "srv-1",
            status: "starting",
            url: null,
            port: null,
            error: null,
            startedAt: Date.now(),
            reloadNonce: 0,
            surfacedAt: null,
          },
        },
      },
    });
    expect(useUiStore.getState().workModeBySide.left).toBe("build");

    arrive("ready");

    // THE AGENT'S OWN SIDE — p2 is left-assigned, so the right column must not have moved.
    expect(useUiStore.getState().workModeBySide.left).toBe("preview");
    expect(useUiStore.getState().workModeBySide.right).toBe("build");

    // AND THE PANE RESOLVES TO THE AGENT THAT TRIGGERED IT. Asserting the mode alone was the hole
    // that let the `"always"` defect through review-free: `openPreview(side)` flips a mode and
    // nothing more, so a green "the column is on Preview" says nothing about WHAT is in it.
    // `PreviewSlot` looks the entry up as `byAgent[<that side's project>.selectedAgentId]`, so this
    // is the chain that has to hold for the flip to have shown anything.
    const uiAfter = useUiStore.getState();
    expect(uiAfter.leftProjectId).toBe("p2");
    const shown = useProjectStore
      .getState()
      .projects.find((p) => p.id === uiAfter.leftProjectId)?.selectedAgentId;
    expect(shown).toBe("ag2");
    expect(usePreviewStore.getState().byAgent[shown!]?.status).toBe("ready");
  });

  it('under "always", a pair showing a DIFFERENT agent is left alone', () => {
    // The mirror of the mirror, against the real trigger. Before this, `"always"` flipped the
    // column here and the pane rendered ag3's (absent) preview over the terminal in view.
    seedFullyEligible({
      ps: {
        projects: [
          { id: "p1", name: "sparkle", agents: [{ id: "ag1", name: "Build 7" }] },
          {
            id: "p2",
            name: "other",
            agents: [
              { id: "ag2", name: "Build 8" },
              { id: "ag3", name: "Build 9" },
            ],
            selectedAgentId: "ag3",
          },
        ],
      },
      preview: {
        openedProjects: { p2: true },
        byAgent: {
          ag2: {
            id: "srv-1", status: "starting", url: null, port: null, error: null,
            startedAt: 111, reloadNonce: 0, surfacedAt: null,
          },
        },
      },
    });
    useSettingsStore.setState({ previewAutoOpen: "always" } as never);
    const uiBefore = JSON.stringify(useUiStore.getState());

    arrive("ready");

    expect(useUiStore.getState().workModeBySide.left).toBe("build");
    expect(JSON.stringify(useUiStore.getState())).toBe(uiBefore);
  });

  it("a declined event leaves every store BYTE-IDENTICAL apart from the fold itself", () => {
    seedFullyEligible({
      preview: {
        // Condition 2 broken: this project has never had a manual preview.
        openedProjects: {},
        byAgent: {
          ag2: {
            id: "srv-1",
            status: "starting",
            url: null,
            port: null,
            error: null,
            startedAt: 111,
            reloadNonce: 0,
            surfacedAt: null,
          },
        },
      },
    });
    const uiBefore = JSON.stringify(useUiStore.getState());

    arrive("ready");

    expect(useUiStore.getState().workModeBySide.left).toBe("build");
    expect(JSON.stringify(useUiStore.getState())).toBe(uiBefore);
  });

  it("a re-emitted `serving` does NOT re-arm the trigger, even carrying a changed field", () => {
    // `surfacedAt` is a TRANSITION stamp, not a last-seen-at, and this is the case that proves it.
    //
    // An IDENTICAL repeat proves nothing here — `setPreview`'s `sameUpdate` bail already returns
    // the state untouched, so the transition guard is never even reached and a test built on that
    // shape passes with the guard deleted. (Measured: it did. This test was rewritten after a hand
    // mutation removing `prev?.status !== next.status` left it green.)
    //
    // So the repeat below differs in another field while the STATE stays the same, which is what a
    // dev server actually sends — a hot reload re-emits `serving`, and a port or url can move with
    // it. Stamp on that and the TTL is held open indefinitely: condition 5, the only clause
    // standing between "a build finished" and "a pane opened three minutes later", never binds.
    const now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      seedFullyEligible({
        preview: {
          openedProjects: { p2: true },
          byAgent: {
            ag2: {
              id: "srv-1",
              status: "starting",
              url: null,
              port: null,
              error: null,
              startedAt: now,
              reloadNonce: 0,
              surfacedAt: null,
            },
          },
        },
      });
      arrive("serving");
      expect(usePreviewStore.getState().byAgent.ag2?.surfacedAt).toBe(now);
      // That first transition legitimately opened the pane. Put the column back on Build, the way
      // the user does when they have finished looking — otherwise the re-emit below is judged
      // against condition 4 (`already-showing`) and never reaches the freshness clause at all.
      useUiStore.setState({ workModeBySide: { left: "build", right: "build" } } as never);

      // Time moves on, and the server re-announces itself on a different port.
      vi.mocked(Date.now).mockReturnValue(now + 60_000);
      applyPreviewStatus({
        id: "srv-1",
        agentId: "ag2",
        projectId: "p2",
        url: "http://127.0.0.1:5174",
        port: 5174,
        state: "serving",
        error: null,
      });

      // The stamp is the FIRST transition's, so the request is now an hour stale by TTL standards.
      expect(usePreviewStore.getState().byAgent.ag2?.surfacedAt).toBe(now);
      expect(previewOpenOutcomeFor("p2", "ag2")).toBe("declined-stale");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("`autoOpenPreviewIfWarranted` writes ONLY on `opened`", () => {
    seedFullyEligible({ preview: { openedProjects: {} } });
    const before = stores();
    expect(autoOpenPreviewIfWarranted("p2", "ag2")).toBe("declined-not-opened-this-session");
    expect(stores()).toBe(before);

    seedFullyEligible();
    expect(autoOpenPreviewIfWarranted("p2", "ag2")).toBe("opened");
    expect(useUiStore.getState().workModeBySide.left).toBe("preview");
  });
});
