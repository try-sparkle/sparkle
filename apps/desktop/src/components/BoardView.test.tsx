// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bead, Board } from "../services/beads";
import { C } from "../theme/colors";
import { TAG } from "./labelTreatment";
import type { AgentTab, Project } from "../types";

// Mock the beads store so no real `bd`/Tauri invoke happens. startPolling/stopPolling are spies;
// the snapshot is whatever `snapshot` holds when the component reads it (selector form).
const startPolling = vi.fn();
const stopPolling = vi.fn();
let snapshot: { beads: Bead[]; board: Board; loadedAt: number } | undefined;
let error: string | undefined;

function buildState() {
  return {
    byProject: { p1: snapshot } as Record<string, typeof snapshot>,
    loading: {} as Record<string, boolean>,
    error: { p1: error } as Record<string, string | undefined>,
    startPolling,
    stopPolling,
  };
}

vi.mock("../stores/beadsStore", () => {
  // Support both the hook form `useBeadsStore((s) => ...)` and `useBeadsStore.getState()`.
  const useBeadsStore = ((selector?: (s: ReturnType<typeof buildState>) => unknown) => {
    const state = buildState();
    return selector ? selector(state) : state;
  }) as unknown as { (sel?: unknown): unknown; getState: () => ReturnType<typeof buildState> };
  useBeadsStore.getState = () => buildState();
  return { useBeadsStore };
});

// `sendToBuildBlockedReason` is the PREFLIGHT every handoff below calls before it claims the bead
// (roborev 55139). It must be in the mock: an exhaustive factory like this one returns `undefined`
// for anything it omits, so a missing entry makes the guard throw and the handoff never runs —
// which is exactly how these four tests failed when it was added. `null` = "not blocked".
const blockedReasonMock = vi.fn<(p: string, e: string, m?: string) => string | null>(() => null);
vi.mock("../services/sendToBuild", () => ({
  sendToBuild: vi.fn(),
  // Forwards ALL args, so tests can assert the MODE each handler passes. The previous version
  // dropped them (`() => blockedReasonMock()`), which is why a call site that never passed "task"
  // went unnoticed while a unit test of the function itself passed (roborev 55145).
  sendToBuildBlockedReason: (...a: [string, string, string?]) => blockedReasonMock(...a),
}));

// ── Definable Done & Delivered (Unit 5) mocks ────────────────────────────────────────────────
// getConfig returns whatever `configState` holds; onConfigChanged is a no-op subscription. Tests
// set `configState` (via defineDone/defineDelivered) to drive the definitions the board reads.
import type { SparkleConfig, EffectiveConfig, StageCriterion } from "../services/config";

function emptyConfig(): SparkleConfig {
  return {
    workflow: {} as SparkleConfig["workflow"],
    workers: {} as SparkleConfig["workers"],
    ai: {} as SparkleConfig["ai"],
    roborev: {} as SparkleConfig["roborev"],
    freshness: {} as SparkleConfig["freshness"],
    capture: {} as SparkleConfig["capture"],
    done: { description: null, criteria: [] },
    delivered: {
      description: null,
      detected_method: null,
      confidence: null,
      confidence_note: null,
      learned: false,
      criteria: [],
    },
  };
}
let configState: SparkleConfig = emptyConfig();
const getConfig = vi.fn(
  async (..._a: unknown[]): Promise<EffectiveConfig> => ({ config: configState, warnings: [] }),
);
vi.mock("../services/config", () => ({
  getConfig: (...a: unknown[]) => getConfig(...a),
  onConfigChanged: vi.fn().mockResolvedValue(() => {}),
}));

const startDeliveryMonitor = vi.fn();
const stopDeliveryMonitor = vi.fn();
vi.mock("../services/deliveryMonitor", () => ({
  startDeliveryMonitor: (...a: unknown[]) => startDeliveryMonitor(...a),
  stopDeliveryMonitor: (...a: unknown[]) => stopDeliveryMonitor(...a),
}));

// The Define/Edit modal is exercised in its own suite; here we stub it to a marker so we can assert
// it opened with the right stageKey without pulling in Haiku/detector/config wiring.
vi.mock("./DefineStageModal", () => ({
  DefineStageModal: ({ stageKey, onClose }: { stageKey: string; onClose: () => void }) => (
    <div data-testid="define-modal">
      define-modal:{stageKey}
      <button onClick={onClose}>close-modal</button>
    </div>
  ),
}));

// Keep the real beads helpers (bucketBeads, childrenOf, labels) but stub the bd-write wrappers the
// Start button / badge chips call, so no Tauri invoke happens.
// COUNTS CARD RENDERS. `isEpicIndexed` is called UNCONDITIONALLY in the body of `Card`, so its
// call count is the number of cards that rendered. (The first probe tried was
// `openChildCountIndexed`, which sits behind `beadIsEpic ? ... : 0` and therefore counted zero for
// a board of plain tasks -- a probe that silently measures nothing is the same failure as the
// vacuous test it was meant to prevent, so it is worth naming.) The other two call sites in this
// file -- `StartControls` and `DetailOverlay` -- render only for a backlog/planning EPIC and for an
// open overlay respectively, and this describe block has neither.
const cardRenders = { count: 0 };

vi.mock("../services/beads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/beads")>();
  return {
    ...actual,
    isEpicIndexed: (...a: Parameters<typeof actual.isEpicIndexed>) => {
      cardRenders.count++;
      return actual.isEpicIndexed(...a);
    },
    claimBead: vi.fn().mockResolvedValue(undefined),
    labelBead: vi.fn().mockResolvedValue(undefined),
    // The confirm-first "Mark as …" control drives these — stub so no Tauri/`bd` invoke happens.
    closeBead: vi.fn().mockResolvedValue(undefined),
    markBeadDelivered: vi.fn().mockResolvedValue(undefined),
  };
});

// Stub ONLY the two comment IPC wrappers the DetailOverlay now drives on open (read) and on submit
// (write), so opening a card triggers no real Tauri invoke. Everything else in the module (the error
// helpers `setBeadPriority` depends on) stays real via `importOriginal`.
const beadsDetailMock = vi.fn(async (..._a: unknown[]) => ({
  bead: {} as unknown,
  fullDescription: "",
  children: { beads: [], total: 0, omitted: 0, omittedIds: [], limit: 100 },
  dependencies: [],
  dependents: [],
  comments: [] as unknown[],
  linksTruncated: false,
}));
const beadsCommentMock = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("../services/beadsCommands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/beadsCommands")>();
  return {
    ...actual,
    beadsDetail: (...a: unknown[]) => beadsDetailMock(...a),
    beadsComment: (...a: unknown[]) => beadsCommentMock(...a),
  };
});

import { BoardView, boardScrollDelta, sameDeliveryUpdate } from "./BoardView";
import { sendToBuild } from "../services/sendToBuild";
import { bucketBeads, claimBead, labelBead, closeBead, markBeadDelivered } from "../services/beads";
import { useCriteriaStore } from "../services/criteriaStore";
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";
import { NO_BOARD_FILTER } from "../services/boardFilters";
import { dismissibleSurfaceOpen, unbindsOnKey } from "../engine/cable";
import { useCableStore } from "../stores/cableStore";
import { waitFor } from "@testing-library/react";
import { useComposeHandoffStore } from "../stores/composeHandoffStore";
import { beadChatDraft } from "../services/beadChat";

/** Point the mocked config at a defined "Done" (a single criterion of the given kind). */
function defineDone(criterion: StageCriterion = { text: "Merged into origin/main", kind: "auto", signal: "merged_to_main" }) {
  configState.done = { description: "Merged into the remote main branch.", criteria: [criterion] };
}
/** Point the mocked config at a defined "Delivered". */
function defineDelivered(criterion: StageCriterion = { text: "Deployed to prod", kind: "manual", signal: null }) {
  configState.delivered = {
    description: "Shipped to production.",
    detected_method: "release_tag",
    confidence: "high",
    confidence_note: "Ships via GitHub Releases.",
    learned: false,
    criteria: [criterion],
  };
}

const project: Project = {
  id: "p1",
  name: "Demo",
  rootPath: "/tmp/demo",
  defaultBranch: "main",
  createdAt: "2026-01-01",
  agents: [],
  selectedAgentId: null,
};

function bead(partial: Partial<Bead> & { id: string; title: string }): Bead {
  return {
    description: "",
    status: "open",
    labels: [],
    parent: null,
    commentCount: 0,
    ...partial,
  };
}

const board: Board = {
  backlog: [
    bead({ id: "p1-a1", title: "Backlog one", description: "First backlog task description." }),
    bead({ id: "p1-a2", title: "Backlog two" }),
  ],
  blocked: [],
  inProgress: [bead({ id: "p1-b1", title: "Doing now", status: "in_progress" })],
  done: [bead({ id: "p1-c1", title: "Finished", status: "closed" })],
  delivered: [
    bead({ id: "p1-d1", title: "Delivered task", status: "closed", labels: ["delivered"] }),
  ],
  archived: [],
};

afterEach(() => {
  cleanup();
  snapshot = undefined;
  error = undefined;
  startPolling.mockClear();
  stopPolling.mockClear();
  vi.mocked(sendToBuild).mockClear();
  // Reset the Definable Done & Delivered state between tests.
  configState = emptyConfig();
  getConfig.mockClear();
  startDeliveryMonitor.mockClear();
  stopDeliveryMonitor.mockClear();
  vi.mocked(closeBead).mockClear();
  vi.mocked(markBeadDelivered).mockClear();
  // claimBead too: the at-capacity test asserts it was NOT called, which a leaked call from an
  // earlier test would silently defeat (or, worse, make pass only because of suite ordering).
  vi.mocked(claimBead).mockClear();
  // Reset the preflight globally, not per-describe: a test that sets it to "blocked" would
  // otherwise leak into every later handoff test and refuse handoffs they expect to succeed.
  blockedReasonMock.mockReset();
  blockedReasonMock.mockReturnValue(null);
  useCriteriaStore.setState({ ticks: {} });
  useProjectStore.setState({ projects: [], selectedProjectId: null });
  beadsDetailMock.mockClear();
  beadsCommentMock.mockClear();
});

beforeEach(() => {
  snapshot = { beads: [], board, loadedAt: Date.now() };
  error = undefined;
  // SEED THE STORE. DetailOverlay reads `rootPath` from it, and every overlay handler claims only
  // `if (rootPath)`. Unseeded, `rootPath` is null, so `claimBead` is DEAD in these tests and every
  // `expect(claimBead).not.toHaveBeenCalled()` here passed vacuously — with the guard deleted, with
  // the guard moved after the claim, and before the guard existed at all (roborev 55152). Seeding is
  // what makes "refuses WITHOUT claiming" — the ordering this whole change is about — assertable.
  // NO `as never` here. This seed is the single object the claim assertions depend on, and
  // `as never` satisfies every setState overload — so if ProjectState's fields are renamed,
  // BoardView fails to compile and gets fixed while this seed compiles unchanged, silently reverts
  // rootPath to null, and quietly makes every claim assertion vacuous again (roborev 55155). Typed,
  // a rename breaks HERE too, which is the point.
  useProjectStore.setState({ projects: [project], selectedProjectId: project.id });
  // Self-verifying: if this ever stops taking effect, `rootPath` silently returns to null and every
  // claimBead assertion in this file quietly re-inerts with a GREEN suite. Fail loudly instead.
  if (useProjectStore.getState().projects[0]?.rootPath !== project.rootPath) {
    throw new Error("BoardView tests: project store seed did not take effect — claim assertions would be vacuous");
  }
});

// ══ TERMINAL-COLUMN RENDER CAP ════════════════════════════════════════════════════════════════
//
// THE DEFECT THIS PINS: the cap was wired as `key === "archived"`, and NOTHING in this repo ever
// writes `ARCHIVED_LABEL`. `columnOf` only ever READS it, so the Archived column is permanently
// empty — the cap guarded an empty column while every closed bead fell through to DONE, uncapped.
// On the founder's store that is 4,476 of 7,507 beads mounted as live cards behind a board he is
// trying to click.
//
// BOTH COLUMNS ARE MOUNTED IN THE SAME RENDER, deliberately. Asserting only that Done is capped
// would pass just as well if the cap had been applied to EVERY column, which would hide live work
// in Backlog — the failure mode that makes a cap worse than the stall. The pair is the assertion:
// terminal is capped, live is not.
// ══ (3)+(4) MEMOISED CARDS, AND THE STABLE STATE THAT MAKES THE MEMO BITE ═════════════════════
//
// These two are ONE change, not two, and the tests say so. `React.memo` on `Card` is worthless
// while `BoardView` hands its children a new object identity every render — a memo that misses
// every time costs a props comparison per card and skips nothing. So the delivery monitor's tick
// must stop minting fresh state, AND the cards must be memoised; either alone measures as no
// improvement at all.
describe("BoardView — cards are memoised against unrelated re-renders", () => {
  const N = 40;

  function cardsBoard(): Board {
    return {
      backlog: Array.from({ length: N }, (_, i) => bead({ id: `p1-m${i}`, title: `Card ${i}` })),
      blocked: [],
      inProgress: [],
      done: [],
      delivered: [],
      archived: [],
    };
  }

  /** Drive the monitor callback BoardView registered, the way the real timer would. */
  const tick = async (update: unknown) => {
    await waitFor(() => expect(startDeliveryMonitor).toHaveBeenCalled());
    const cb = startDeliveryMonitor.mock.calls.at(-1)?.[1] as ((u: unknown) => void) | undefined;
    if (cb === undefined) throw new Error("delivery monitor was never started");
    act(() => cb(update));
  };

  const chip = (status: string) => ({ signals: [], detectable: true, status });

  beforeEach(() => {
    snapshot = { beads: [], board: cardsBoard(), loadedAt: Date.now() };
    // The monitor only starts once "delivered" is a DEFINED stage — otherwise the effect stops it
    // and this whole describe would drive a callback that was never registered.
    defineDelivered();
  });

  // ── MEASURED RELATIVE TO THE MOUNT, NOT AGAINST A HARDCODED N ────────────────────────────────
  // `isEpicIndexed` is called once per card BY `Card` — but not ONLY by `Card`. `main` has since
  // dropped the column+type gate so `StartControls` mounts on every card, and it resolves through
  // the same index, so the per-card call count is now 3 and is free to change again. Pinning the
  // mount to `N` made this assert an implementation detail of unrelated components: it broke at
  // `expected 120 to be 40` on a merge that touched none of this.
  //
  // What the memo actually claims is a RATIO, and the ratio is what is asserted now: an unrelated
  // re-render costs ZERO card work, and a real change costs the SAME work the mount did. Both are
  // exact, neither cares how many resolver calls one card makes.
  it("does not re-render a single card when only the delivery chip changes", async () => {
    render(<BoardView project={project} side="right" />);
    const mountCost = cardRenders.count;
    expect(mountCost).toBeGreaterThan(0); // the mount really did render cards

    cardRenders.count = 0;
    await tick(chip("Release v1 detected"));

    // BoardView itself re-rendered -- the chip text is new -- but NO card's props changed, so every
    // one of them skipped. Before the memo this was the full `mountCost`.
    expect(cardRenders.count).toBe(0);
  });

  it("PAIRED: a snapshot that actually changes the cards still re-renders them", () => {
    const { rerender } = render(<BoardView project={project} side="right" />);
    const mountCost = cardRenders.count;
    expect(mountCost).toBeGreaterThan(0);
    cardRenders.count = 0;

    // The half that proves the memo is not simply frozen. A test that only asserted "0 renders"
    // would pass just as happily against a card that can never update again, which is a far worse
    // bug than the stall this fixes.
    snapshot = { beads: [], board: cardsBoard(), loadedAt: Date.now() + 1 };
    rerender(<BoardView project={project} side="right" />);
    // The SAME cost as the mount: every card re-rendered, none skipped.
    expect(cardRenders.count).toBe(mountCost);
  });

  // NOTE ON WHAT IS *NOT* TESTED HERE, because a test that was here got this wrong. An
  // "identical tick does not re-render a card" assertion looks like it guards the idle re-render,
  // and it is VACUOUS: with `Card` memoised, an identical tick and a fresh-but-equal tick both
  // produce zero card renders, so it passes with the state bail-out DELETED (mutation-checked --
  // it did). The card probe cannot see that fix at all; the bail-out's effect is on BoardView's own
  // render and on `inReleaseByBead`, one level above what this probe measures. The comparator is
  // therefore tested directly, below.
  it("keeps rendering the chip correctly across repeated ticks", async () => {
    render(<BoardView project={project} side="right" />);
    await tick(chip("Release v1 detected"));
    await tick(chip("Release v1 detected"));
    expect(screen.getByText("Release v1 detected")).toBeTruthy();
    await tick(chip("Release v2 detected"));
    expect(screen.getByText("Release v2 detected")).toBeTruthy();
  });
});

// ══ (4) THE COMPARATOR THAT STOPS THE 90-SECOND IDLE RE-RENDER ════════════════════════════════
//
// The delivery monitor fires on a timer and always hands back a FRESH object, so `setDelivery(u)`
// changed React state on every tick whether or not the delivery picture had moved -- an untouched
// board rebuilding `inReleaseByBead` and re-deriving every downstream prop, forever.
//
// This is tested as a PURE FUNCTION rather than through the component on purpose: see the note in
// the describe above. Through the component the fix is invisible, because the card memo already
// absorbs the difference.
describe("sameDeliveryUpdate", () => {
  const sig = (beadId: string, inRelease: boolean, tags: string[] = []) => ({
    beadId,
    inRelease,
    tags,
  });
  const upd = (status: string, detectable: boolean, signals: ReturnType<typeof sig>[]) => ({
    status,
    detectable,
    signals,
  });

  it("treats two DISTINCT but equal updates as the same", () => {
    const a = upd("Release v1", true, [sig("b1", true, ["v1"]), sig("b2", false)]);
    const b = upd("Release v1", true, [sig("b1", true, ["v1"]), sig("b2", false)]);
    expect(a).not.toBe(b); // genuinely different objects, or this proves nothing
    expect(sameDeliveryUpdate(a, b)).toBe(true);
  });

  it("null handling is exact", () => {
    expect(sameDeliveryUpdate(null, null)).toBe(true);
    expect(sameDeliveryUpdate(null, upd("x", true, []))).toBe(false);
    expect(sameDeliveryUpdate(upd("x", true, []), null)).toBe(false);
  });

  // EVERY FIELD, one at a time. A comparator that misses a field does not merely fail to optimise
  // — it PINS STALE STATE, and the UI silently stops updating. That is a worse bug than the
  // re-render it was written to prevent, so each field gets its own case rather than a single
  // "different objects differ" assertion that a partial implementation would also satisfy.
  it("notices a changed status", () => {
    expect(sameDeliveryUpdate(upd("v1", true, []), upd("v2", true, []))).toBe(false);
  });

  it("notices a changed detectable", () => {
    expect(sameDeliveryUpdate(upd("v1", true, []), upd("v1", false, []))).toBe(false);
  });

  it("notices an added or removed signal", () => {
    expect(sameDeliveryUpdate(upd("v1", true, []), upd("v1", true, [sig("b1", true)]))).toBe(false);
    expect(sameDeliveryUpdate(upd("v1", true, [sig("b1", true)]), upd("v1", true, []))).toBe(false);
  });

  it("notices a changed beadId, inRelease, or tag", () => {
    const base = upd("v1", true, [sig("b1", true, ["t1"])]);
    expect(sameDeliveryUpdate(base, upd("v1", true, [sig("b2", true, ["t1"])]))).toBe(false);
    expect(sameDeliveryUpdate(base, upd("v1", true, [sig("b1", false, ["t1"])]))).toBe(false);
    expect(sameDeliveryUpdate(base, upd("v1", true, [sig("b1", true, ["t2"])]))).toBe(false);
    expect(sameDeliveryUpdate(base, upd("v1", true, [sig("b1", true, [])]))).toBe(false);
  });
});

describe("BoardView — terminal columns are render-capped", () => {
  const CAP = 50;
  // > CAP * 3, so the paging assertions below still have cards left to reveal on the third page.
  const OVER = 200;

  /**
   * EVERY COLUMN SEEDED PAST THE CAP, and that is the whole design of this fixture.
   *
   * The first version populated only `backlog` and `done`. Absence of an overflow marker in a
   * column that was never mounted proves nothing (the N-targets rule in AGENTS.md), and the hole
   * was concrete rather than theoretical: `TERMINAL_COLUMNS = new Set(["done"])` -- the cap
   * silently dropped from Shipped and Archived -- passed that suite unchanged, and so did adding
   * `"blocked"`, which would hide LIVE work. The two mutations originally reported as evidence
   * happened to be the two that seeding could catch; the likelier regression, one key added to or
   * dropped from the set, was invisible (roborev 65673).
   */
  function bigBoard(): Board {
    const col = (p: string) =>
      Array.from({ length: OVER }, (_, i) => bead({ id: `p1-${p}${i}`, title: `${p} ${i}` }));
    return {
      backlog: col("backlog"),
      blocked: col("blocked"),
      inProgress: col("prog"),
      done: col("done"),
      delivered: col("del"),
      archived: col("arch"),
    };
  }

  const cardsIn = (columnKey: string) => {
    const col = document.querySelector(`[data-board-column="${columnKey}"]`);
    if (col === null) throw new Error(`column ${columnKey} not mounted`);
    // EXACT testids, not the `board-card-` PREFIX. The prefix form counted controls INSIDE a card
    // as cards: `main` added `board-card-build-it` and `board-card-clear-stalled`, so a 50-card
    // column measured 100 and every cap assertion here failed on a merge that had not touched the
    // cap at all. A card is one of exactly two testids; anything else under that prefix is chrome.
    return col.querySelectorAll(
      '[data-testid="board-card-epic"], [data-testid="board-card-task"]',
    ).length;
  };

  const LIVE = ["backlog", "blocked", "inProgress"] as const;
  /** Archived is capped too, but it is COLLAPSED by default so it mounts nothing until opened. */
  const TERMINAL_EXPANDED = ["done", "delivered"] as const;

  beforeEach(() => {
    snapshot = { beads: [], board: bigBoard(), loadedAt: Date.now() };
  });

  it("caps every terminal column and no live one, in a single render", () => {
    render(<BoardView project={project} side="right" />);

    for (const key of TERMINAL_EXPANDED) {
      expect(cardsIn(key)).toBe(CAP);
      expect(screen.getByTestId(`board-column-overflow-${key}`).textContent).toContain(
        `+${OVER - CAP} more not shown`,
      );
    }
    // THE HALF THAT FAILS IF THE CAP IS APPLIED TOO WIDELY. A card you cannot see in a live column
    // is work you will not do, which is worse than the stall this cap fixes.
    for (const key of LIVE) {
      expect(cardsIn(key)).toBe(OVER);
      expect(screen.queryByTestId(`board-column-overflow-${key}`)).toBeNull();
    }
  });

  it("caps Archived once it is expanded, having mounted nothing while collapsed", () => {
    render(<BoardView project={project} side="right" />);
    expect(cardsIn("archived")).toBe(0); // collapsed: a header and a count, no cards

    fireEvent.click(screen.getByTestId("board-column-expand-archived"));
    expect(cardsIn("archived")).toBe(CAP);
  });

  it("reveals one more page per Show more click, not the whole pile", () => {
    render(<BoardView project={project} side="right" />);
    expect(cardsIn("done")).toBe(CAP);

    // WITHOUT THIS AFFORDANCE THE CAP IS A CONTENT BUG, not a perf fix: the beads past the cap
    // would be unreachable. One page per click is what keeps the DOM bounded by what was asked for.
    fireEvent.click(screen.getByTestId("board-column-show-more-done"));
    expect(cardsIn("done")).toBe(CAP * 2);

    fireEvent.click(screen.getByTestId("board-column-show-more-done"));
    expect(cardsIn("done")).toBe(CAP * 3);
  });

  // ── THE PAGE COUNTER MUST NOT OUTLIVE THE REASON IT WAS RAISED ──────────────────────────────
  it("resets paging when Archived is collapsed, so re-expanding is cheap again", () => {
    render(<BoardView project={project} side="right" />);
    fireEvent.click(screen.getByTestId("board-column-expand-archived"));
    fireEvent.click(screen.getByTestId("board-column-show-more-archived"));
    fireEvent.click(screen.getByTestId("board-column-show-more-archived"));
    expect(cardsIn("archived")).toBe(CAP * 3);

    // Collapse is the user saying "make this cheap again". Keeping `pages` would mount 150 cards in
    // one frame on the next expand -- worse than the unbounded column this replaced.
    fireEvent.click(screen.getByText("Collapse"));
    expect(cardsIn("archived")).toBe(0);

    fireEvent.click(screen.getByTestId("board-column-expand-archived"));
    expect(cardsIn("archived")).toBe(CAP);
  });

  it("keeps Collapse reachable once a collapsible column is paged to its END", () => {
    // THE STATE THE FIRST VERSION OF THIS SUITE NEVER ENTERED. `Collapse` used to live inside the
    // `overflow > 0` block, so paging to the end unmounted the footer and took the only way back to
    // the cheap state with it — permanently, for the session. Archived with 51-100 beads hits that
    // after ONE click, so it is the common case, not a corner (roborev 65718).
    snapshot = {
      beads: [],
      board: {
        ...bigBoard(),
        archived: Array.from({ length: 60 }, (_, i) =>
          bead({ id: `p1-arch${i}`, title: `arch ${i}` }),
        ),
      },
      loadedAt: Date.now(),
    };
    render(<BoardView project={project} side="right" />);
    fireEvent.click(screen.getByTestId("board-column-expand-archived"));
    fireEvent.click(screen.getByTestId("board-column-show-more-archived"));

    // Paged past the end: 60 of 60 shown, so there is no overflow left to report.
    expect(cardsIn("archived")).toBe(60);
    expect(screen.queryByTestId("board-column-show-more-archived")).toBeNull();

    // ...and the escape hatch is STILL THERE, and still resets the paging.
    fireEvent.click(screen.getByText("Collapse"));
    expect(cardsIn("archived")).toBe(0);
    fireEvent.click(screen.getByTestId("board-column-expand-archived"));
    expect(cardsIn("archived")).toBe(CAP);
  });

  it("does not hand a filter-cleared dataset the previous column's page count", () => {
    render(<BoardView project={project} side="right" />);
    fireEvent.click(screen.getByTestId("board-column-show-more-done"));
    expect(cardsIn("done")).toBe(CAP * 2);

    // NARROW, THEN CLEAR. Both are ordinary in-UI controls that swap `viewBoard[key]` wholesale
    // under a reused Column, and the first fix only covered the Tasks/Epics toggles — so the leak
    // survived on this path (roborev 65718). Paging is invisible while narrowed, which is what
    // makes the restore surprising.
    act(() => {
      useUiStore.setState((st) => ({
        boardAgentFilterBySide: { ...st.boardAgentFilterBySide, right: "agent-1" },
      }));
    });
    act(() => {
      useUiStore.setState((st) => ({
        boardAgentFilterBySide: { ...st.boardAgentFilterBySide, right: null },
      }));
    });

    expect(cardsIn("done")).toBe(CAP);
  });

  it("does not hand a PRIORITY-filter-cleared dataset the previous page count", () => {
    // THE SECOND HALF OF `datasetKey`, pinned separately ON PURPOSE. The agent-filter test above
    // and this one cover two DIFFERENT terms, and the earlier mutation check dropped both at once
    // -- which proves only that at least one mattered. That is the "one fix, N call sites, only one
    // site checked" shape in AGENTS.md: with just the agent test, deleting the `boardFilter` term
    // leaves the suite green while the leak survives on the priority/date path, which has its own
    // in-UI Clear (roborev 65726). Mutation-checked by removing ONLY the boardFilter term.
    render(<BoardView project={project} side="right" />);
    fireEvent.click(screen.getByTestId("board-column-show-more-done"));
    expect(cardsIn("done")).toBe(CAP * 2);

    act(() => {
      useUiStore.getState().setBoardFilter("right", { ...NO_BOARD_FILTER, priority: 0 });
    });
    act(() => {
      useUiStore.getState().setBoardFilter("right", NO_BOARD_FILTER);
    });

    expect(cardsIn("done")).toBe(CAP);
  });

  it("does not hand a swapped dataset the previous column's page count", () => {
    render(<BoardView project={project} side="right" />);
    fireEvent.click(screen.getByTestId("board-column-show-more-done"));
    expect(cardsIn("done")).toBe(CAP * 2);

    // The Tasks/Epics toggles swap `viewBoard[key]` wholesale while React reuses the Column
    // instance, so a stale counter would mount pages of a dataset it was never expanded against.
    fireEvent.click(screen.getByTestId("board-plan-kind-epics"));
    fireEvent.click(screen.getByTestId("board-plan-kind-epics"));
    expect(cardsIn("done")).toBe(CAP);
  });
});

describe("BoardView", () => {
  it("starts polling on mount and stops on unmount", () => {
    const { unmount } = render(<BoardView project={project} side="right" />);
    expect(startPolling).toHaveBeenCalledWith("p1", "/tmp/demo");
    unmount();
    expect(stopPolling).toHaveBeenCalledWith("p1");
  });

  it("renders the four columns with their cards bucketed correctly", () => {
    render(<BoardView project={project} side="right" />);
    // Column headers, addressed by lane so they cannot be confused with card text — the terminal
    // lane and the terminal STAGE badge are both "Shipped", deliberately (one vocabulary).
    expect(screen.getByTestId("lane-label-backlog").textContent).toContain("Backlog");
    expect(screen.getByTestId("lane-label-inProgress").textContent).toContain("Being built");
    expect(screen.getByTestId("lane-label-done").textContent).toContain("Done");
    expect(screen.getByTestId("lane-label-delivered").textContent).toContain("Shipped");
    // The count renders UNDER the title, inside the same lane stack.
    expect(screen.getByTestId("lane-count-backlog").textContent).toBe("2");
    // Cards land in the right buckets.
    expect(screen.getByText("Backlog one")).toBeTruthy();
    expect(screen.getByText("Backlog two")).toBeTruthy();
    expect(screen.getByText("Doing now")).toBeTruthy();
    expect(screen.getByText("Finished")).toBeTruthy();
    expect(screen.getByText("Delivered task")).toBeTruthy();
    // Bead ids show on the cards.
    expect(screen.getByText("p1-a1")).toBeTruthy();
  });

  it("renders each card's unified progress stage label (mapped from bead status)", () => {
    render(<BoardView project={project} side="right" />);
    // short stage labels: open→Planned, in_progress→Unsaved, closed→Merged, delivered→Shipped.
    expect(screen.getAllByText("Planned").length).toBeGreaterThanOrEqual(2); // two backlog beads
    expect(screen.getByText("Unsaved")).toBeTruthy(); // the in-progress bead
    expect(screen.getByText("Merged")).toBeTruthy(); // the done bead
    // "Shipped" is now BOTH the terminal lane label and this card's stage badge, so scope to the
    // card: the lane's copy lives inside lane-label-delivered.
    const shipped = screen.getAllByText("Shipped");
    expect(shipped.length).toBe(2);
    const lane = screen.getByTestId("lane-label-delivered");
    expect(shipped.filter((el) => !lane.contains(el))).toHaveLength(1); // the delivered bead
  });

  it("shows the loading state when there is no snapshot yet", () => {
    snapshot = undefined;
    render(<BoardView project={project} side="right" />);
    expect(screen.getByText("Loading tasks…")).toBeTruthy();
  });

  it("shows an empty-column hint and keeps a prior snapshot visible on error", () => {
    snapshot = {
      beads: [],
      board: { backlog: [], blocked: [], inProgress: [], done: [], delivered: [], archived: [] },
      loadedAt: Date.now(),
    };
    error = "bd blew up";
    render(<BoardView project={project} side="right" />);
    // Error surfaces but the (empty) board still renders.
    expect(screen.getByText("bd blew up")).toBeTruthy();
    // The four non-definable lanes (Backlog, Blocked, Being built, Archived) show the empty hint;
    // the two definable ones (Done, Shipped) show the Define CTA instead. An empty Archived column
    // is collapsible but has nothing to collapse, so it falls through to the same hint.
    expect(screen.getAllByText("Nothing here yet").length).toBe(4);
    expect(screen.getByText("Define “Done”")).toBeTruthy();
    expect(screen.getByText("Define “Shipped”")).toBeTruthy();
  });

  it("opens a detail overlay with the full description when a card is clicked", () => {
    const long = "Line one of the description.\nLine two after a newline that is quite long ".repeat(3);
    snapshot = {
      beads: [],
      board: {
        backlog: [
          bead({
            id: "p1-x1",
            title: "Detailed task",
            description: long,
            type: "feature",
            priority: 2,
            labels: ["ui", "kanban"],
          }),
        ],
        blocked: [],
        inProgress: [],
        done: [],
        delivered: [],
        archived: [],
      },
      loadedAt: Date.now(),
    };
    // Raw-textContent matcher: the description preserves newlines (whiteSpace: pre-wrap), so we
    // match the literal string rather than the whitespace-normalized form getByText uses.
    const fullDesc = (_: string, el: Element | null) => el?.textContent === long;
    render(<BoardView project={project} side="right" />);
    // Before click, the full description text is not present (only a truncated preview).
    expect(screen.queryByText(fullDesc)).toBeNull();
    fireEvent.click(screen.getByText("Detailed task"));
    // After click, the detail overlay shows the full description plus metadata.
    expect(screen.getByText(fullDesc)).toBeTruthy();
    expect(screen.getByText("feature")).toBeTruthy();
    expect(screen.getByText("ui, kanban")).toBeTruthy();
    // A close affordance exists.
    expect(screen.getByLabelText("Close")).toBeTruthy();
  });

  // ══ ESCAPE CLOSES THE OVERLAY — AND MUST NOT COST THE CABLE ══════════════════════════════════
  // Adding an Escape handler made this an Escape-owning surface. `engine/cable.ts` decides whether
  // a press unbinds the concierge by PROBING THE DOM (`dismissibleSurfaceOpen`), and Workspace's
  // listener is registered at app mount so it runs BEFORE this one. Without a marker the probe can
  // see, rung 1 unwires the cable and arms rung 2, and the user's NEXT Escape clears the build row
  // in every pair — the failure roborev 55478 was closed to prevent (roborev 59115, High).
  describe("BoardView — the detail overlay's Escape contract", () => {
    function overlaySnapshot() {
      snapshot = {
        beads: [],
        board: {
          backlog: [bead({ id: "p1-x1", title: "Detailed task", priority: 2 })],
          blocked: [],
          inProgress: [],
          done: [],
          delivered: [],
          archived: [],
        },
        loadedAt: Date.now(),
      };
    }

    it("marks the panel as a dismissible surface, so Escape does not unbind the cable", () => {
      overlaySnapshot();
      render(<BoardView project={project} side="right" />);
      expect(dismissibleSurfaceOpen(document)).toBe(false);

      fireEvent.click(screen.getByText("Detailed task"));
      // THE ASSERTION THAT MATTERS: the cable's own probe must see this overlay. Asserting
      // `role="dialog"` directly would pin the attribute; asserting the probe pins the BEHAVIOUR,
      // and still fails if someone swaps the marker for one the selector does not list.
      expect(dismissibleSurfaceOpen(document)).toBe(true);
      // …which is what makes the cable decline to unbind on this press.
      expect(unbindsOnKey({ ...useCableStore.getState() }, "Escape", { dismissibleOpen: true })).toBe(
        false,
      );
    });

    it("closes on Escape", () => {
      overlaySnapshot();
      render(<BoardView project={project} side="right" />);
      fireEvent.click(screen.getByText("Detailed task"));
      expect(screen.getByTestId("board-bead-card")).toBeTruthy();

      fireEvent.keyDown(window, { key: "Escape" });
      expect(screen.queryByTestId("board-bead-card")).toBeNull();
    });

    it("yields the press to an OPEN priority menu instead of closing underneath it", () => {
      overlaySnapshot();
      render(<BoardView project={project} side="right" />);
      fireEvent.click(screen.getByText("Detailed task"));
      // Open the priority menu — it is the innermost layer. The `-trigger` suffix matters: the bare
      // testid is the wrapper span, and clicking that does nothing.
      fireEvent.click(screen.getByTestId("board-bead-card-priority-trigger"));
      expect(screen.getByTestId("board-bead-card-priority-menu")).toBeTruthy();

      fireEvent.keyDown(window, { key: "Escape" });
      // Same-phase listeners fire in REGISTRATION order, so this overlay's handler runs FIRST —
      // without the beadCardMenuIsOpen() guard it would close the card out from under the menu and
      // the menu's own defaultPrevented bail would swallow the press entirely.
      expect(screen.getByTestId("board-bead-card")).toBeTruthy();
    });

    it("leaves a press another layer already claimed alone", () => {
      overlaySnapshot();
      render(<BoardView project={project} side="right" />);
      fireEvent.click(screen.getByText("Detailed task"));

      const e = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
      e.preventDefault();
      window.dispatchEvent(e);
      expect(screen.getByTestId("board-bead-card")).toBeTruthy();
    });
  });

  // ══ THE COMMENT READ PATH IS LAZY — ON OPEN, NEVER ON THE 5s POLL ════════════════════════════
  // `beads_detail` carries `--include-comments`; pulling it on every poll for every bead would
  // hammer the contended bd store. These pin that it fires ONLY when a card opens, and that the
  // compose box drives the real `beadsComment` write path.
  describe("BoardView — the bead comment thread", () => {
    function overlaySnapshot() {
      snapshot = {
        beads: [],
        board: {
          backlog: [bead({ id: "p1-x1", title: "Detailed task", priority: 2 })],
          blocked: [],
          inProgress: [],
          done: [],
          delivered: [],
          archived: [],
        },
        loadedAt: Date.now(),
      };
    }

    it("does NOT read comments on the board poll — only when a card is opened", async () => {
      overlaySnapshot();
      render(<BoardView project={project} side="right" />);
      // The board is rendered from the poll snapshot. The comment read must not have run yet: if it
      // were wired into the list path this would already be non-zero.
      expect(beadsDetailMock).not.toHaveBeenCalled();

      fireEvent.click(screen.getByText("Detailed task"));
      // Opening the card is the ONLY thing that fetches comments — and with this bead's id.
      await waitFor(() => expect(beadsDetailMock).toHaveBeenCalledTimes(1));
      expect(beadsDetailMock).toHaveBeenCalledWith("/tmp/demo", "p1-x1");
    });

    it("posts a typed comment through beadsComment with the bead id and text", async () => {
      overlaySnapshot();
      render(<BoardView project={project} side="right" />);
      fireEvent.click(screen.getByText("Detailed task"));
      await waitFor(() => expect(beadsDetailMock).toHaveBeenCalled());

      const box = screen.getByTestId("board-bead-card-comments-input") as HTMLTextAreaElement;
      fireEvent.change(box, { target: { value: "a human note" } });
      fireEvent.click(screen.getByTestId("board-bead-card-comments-submit"));

      // THE SIDE EFFECT: the shipped write path was called with THIS project, THIS bead, THIS text —
      // not merely that a button rendered.
      await waitFor(() => expect(beadsCommentMock).toHaveBeenCalledWith("/tmp/demo", "p1-x1", "a human note"));
    });

    it("renders comments returned by the detail read", async () => {
      overlaySnapshot();
      beadsDetailMock.mockResolvedValueOnce({
        bead: {} as unknown,
        fullDescription: "",
        children: { beads: [], total: 0, omitted: 0, omittedIds: [], limit: 100 },
        dependencies: [],
        dependents: [],
        comments: [
          { id: "c-1", author: "DROdio", text: "the first comment", createdAt: "2026-08-12T00:00:00Z" },
        ],
        linksTruncated: false,
      });
      render(<BoardView project={project} side="right" />);
      fireEvent.click(screen.getByText("Detailed task"));
      // The thread shows the fetched comment body once the lazy read resolves.
      expect(await screen.findByText("the first comment")).toBeTruthy();
    });
  });

  // The batch button is gated on the bead being an EPIC, not merely on its body naming a PRD.
  // `parsePrdRef` matches a "PRD file:" line in ANY body, so a task carrying a back-link resolved a
  // non-empty prdEpics — and a length-only gate offered "Build all N epics in this PRD" on a card
  // for a bead that is not one of them, one press from claiming every epic in that PRD.
  it("does NOT offer build-all-PRD on a non-epic that merely links a PRD", () => {
    const prd = "PRD file: PRD/2026-06-27-build-the-app.md";
    const task = bead({ id: "p1-t1", title: "A mere task", type: "task", description: prd });
    const e1 = bead({ id: "p1-e1", title: "Epic one", type: "epic", description: prd });
    const e2 = bead({ id: "p1-e2", title: "Epic two", type: "epic", description: prd });
    snapshot = {
      beads: [task, e1, e2],
      board: { backlog: [task, e1, e2], blocked: [], inProgress: [], done: [], delivered: [], archived: [] },
      loadedAt: Date.now(),
    };
    render(<BoardView project={project} side="right" />);
    fireEvent.click(screen.getByText("A mere task"));
    // Two epics DO share this PRD, so a length-only gate would render the batch button here.
    expect(screen.queryByTestId("board-bead-card-build-all-prd")).toBeNull();
    // The single-bead Build It is still correct for a task.
    expect(screen.getByTestId("board-bead-card-build-it")).toBeTruthy();
  });

  // ══ THE OPEN CARD FOLLOWS THE POLL ═══════════════════════════════════════════════════════════
  // The overlay used to hold the clicked Bead OBJECT, and `beadsStore` replaces its snapshot
  // wholesale every 5s — so an open card was a photograph. That silently broke the priority write:
  // `BeadCard` clears its optimistic value only when `bead.priority` agrees, an acknowledgement a
  // frozen object can never deliver (knightwatch probe 5199421526#6).
  it("shows the LATEST bead, not the one captured at click time", () => {
    const before = bead({ id: "p1-x1", title: "Old title", priority: 3 });
    snapshot = {
      beads: [before],
      board: { backlog: [before], blocked: [], inProgress: [], done: [], delivered: [], archived: [] },
      loadedAt: Date.now(),
    };
    const { rerender } = render(<BoardView project={project} side="right" />);
    fireEvent.click(screen.getByText("Old title"));
    expect(screen.getByTestId("board-bead-card")).toBeTruthy();

    // A poll lands with a NEW title and priority for the same id.
    const after = bead({ id: "p1-x1", title: "New title", priority: 0 });
    snapshot = {
      beads: [after],
      board: { backlog: [after], blocked: [], inProgress: [], done: [], delivered: [], archived: [] },
      loadedAt: Date.now() + 1,
    };
    rerender(<BoardView project={project} side="right" />);

    // The OPEN card re-reads it. Holding the object showed "Old title" forever.
    const card = screen.getByTestId("board-bead-card");
    expect(card.textContent).toContain("New title");
    expect(card.textContent).not.toContain("Old title");
  });

  it("closes the overlay when the bead leaves the board entirely", () => {
    const b = bead({ id: "p1-x1", title: "Vanishing" });
    snapshot = {
      beads: [b],
      board: { backlog: [b], blocked: [], inProgress: [], done: [], delivered: [], archived: [] },
      loadedAt: Date.now(),
    };
    const { rerender } = render(<BoardView project={project} side="right" />);
    fireEvent.click(screen.getByText("Vanishing"));
    expect(screen.getByTestId("board-bead-card")).toBeTruthy();

    snapshot = {
      beads: [],
      board: { backlog: [], blocked: [], inProgress: [], done: [], delivered: [], archived: [] },
      loadedAt: Date.now() + 1,
    };
    rerender(<BoardView project={project} side="right" />);
    // A detail card for a bead the board no longer has would contradict everything else on screen.
    expect(screen.queryByTestId("board-bead-card")).toBeNull();
  });

  it("has no free-form edit controls on the COLLAPSED board — inputs/selects/textareas appear only on open", () => {
    const { container } = render(<BoardView project={project} side="right" />);
    // No edit controls anywhere on the collapsed board (buttons exist: cards open detail, epics get
    // Start). The board is a read/navigate surface — the one deliberate exception is the comment
    // compose box, which lives on the OPENED card, not here.
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector("select")).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    // Opening detail introduces exactly ONE edit control — the comment compose box (the founder's
    // ask). Still no `input`/`select`: this is a comment thread, not an edit grid.
    fireEvent.click(screen.getByText("Backlog one"));
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector("select")).toBeNull();
    // The compose textarea IS present now, and it is the only textbox on the surface.
    expect(screen.getByTestId("board-bead-card-comments-input")).toBeTruthy();
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  });

  it("counts each column", () => {
    render(<BoardView project={project} side="right" />);
    // Backlog header lives in a row that also shows its count (2). Scope the lookup to that header.
    const backlogHeader = screen.getByText("Backlog").parentElement as HTMLElement;
    expect(within(backlogHeader).getByText("2")).toBeTruthy();
  });
});

describe("BoardView — Build It (epic handoff)", () => {
  beforeEach(() => blockedReasonMock.mockReturnValue(null));
  function epicSnapshot(description: string) {
    return {
      beads: [],
      board: {
        backlog: [bead({ id: "p1-e1", title: "Build the app", type: "epic", description })],
        blocked: [],
        inProgress: [],
        done: [],
        delivered: [],
        archived: [],
      },
      loadedAt: Date.now(),
    };
  }

  // AT CAPACITY THE HANDOFF MUST NOT CLAIM THE BEAD FIRST.
  //
  // Every handoff here calls claimBead (→ in_progress) before sendToBuild. That was harmless while
  // sendToBuild only threw for an unknown project — a state the caller had ruled out — but the
  // machine-wide cap makes claim-then-fail routine: the epic would sit in progress with no
  // orchestrator, and nothing un-claims it. On a BACKLOG card it is worse, because the claim moves
  // the card out of the `backlog` column that renders the button at all, so the affordance the user
  // just pressed disappears and the retry is only reachable through the detail overlay
  // (roborev 55139). So: refuse BEFORE mutating, show why, and leave the bead alone.
  it("at capacity, refuses without claiming the bead — and says why", async () => {
    blockedReasonMock.mockReturnValue("This machine has 8 of its 8 agent slots taken.");
    snapshot = epicSnapshot("Ship the app.");
    render(<BoardView project={project} side="right" />);
    fireEvent.click(screen.getByText("Build the app"));
    // BY TESTID. This used to walk up from the epic status pill ("not started") to find a sibling
    // Build It — a pill the unified card replaced with the workflow stage, per the founder's call
    // that the Think→Plan→Build vocabulary wins. The card exposes the button directly, which also
    // disambiguates it from the backlog CARD's own Build It without any DOM walking.
    fireEvent.click(screen.getByTestId("board-bead-card-build-it"));

    await waitFor(() => expect(screen.getByText(/8 of its 8 agent slots/)).toBeTruthy());
    expect(sendToBuild).not.toHaveBeenCalled();
    // THE point: the bead is untouched, so the card stays where the user can retry it.
    expect(claimBead).not.toHaveBeenCalled();
  });

  // ASSERTED AT THE CALL SITE, not on the function.
  //
  // The preflight's `mode` DEFAULTS to "epic", and each handler must pass its own. A unit test of
  // sendToBuildBlockedReason("p1","e1","task") passes whether or not any caller actually supplies
  // the argument — which is precisely how the single-task handler shipped without it, rendering
  // "Starting this plan…" for a one-bead handoff (roborev 55145). So: assert what the HANDLERS pass.
  it("each handoff tells the preflight which KIND of build it is", async () => {
    snapshot = epicSnapshot("Ship the app.");
    render(<BoardView project={project} side="right" />);
    fireEvent.click(screen.getByText("Build the app"));
    // BY TESTID. This used to walk up from the epic status pill ("not started") to find a sibling
    // Build It — a pill the unified card replaced with the workflow stage, per the founder's call
    // that the Think→Plan→Build vocabulary wins. The card exposes the button directly, which also
    // disambiguates it from the backlog CARD's own Build It without any DOM walking.
    fireEvent.click(screen.getByTestId("board-bead-card-build-it"));

    // SETTLE the handler before returning: it now suspends at `await claimBead(...)`, so without
    // this its continuation (sendToBuild / onClose / setBuildBusy) runs after the test body — outside
    // act(), and in the same window as afterEach's mockClear, which can leak a call into the next
    // test where `expect(claimBead).not.toHaveBeenCalled()` cannot tell a leak from a real call.
    await waitFor(() => expect(sendToBuild).toHaveBeenCalled());

    const epicCall = blockedReasonMock.mock.calls.at(-1)!;
    expect(epicCall[1]).toBe("p1-e1");
    // NOW EXPLICITLY "epic", where this used to assert the absence of a mode.
    //
    // The original assertion existed because the call site passed NOTHING and leaned on the
    // preflight's "epic" default, so `?? "epic"` would have passed against `undefined` too
    // (roborev 55155). The shared hook states the mode on both paths, which removes the ambiguity
    // that assertion was defending against rather than weakening it — and this still fails if the
    // epic path ever starts announcing itself as a task, which is the fact the row is here to pin.
    expect(epicCall[2]).toBe("epic");
  });

  // The build-all LOOP: the ceiling can be reached partway through a batch, and claiming an epic we
  // then cannot hand off would mark it in progress with no orchestrator. It must stop cleanly and
  // say how far it got — and without a test here, neutralising that guard leaves the suite green
  // (roborev 55150).
  it("build-all stops at the ceiling, reporting progress and leaving the rest untouched", async () => {
    const prd = "PRD file: PRD/shared.md";
    const e1 = bead({ id: "p1-e1", title: "Epic one", type: "epic", description: prd });
    const e2 = bead({ id: "p1-e2", title: "Epic two", type: "epic", description: prd });
    snapshot = {
      beads: [e1, e2],
      board: { backlog: [e1, e2], blocked: [], inProgress: [], done: [], delivered: [], archived: [] },
      loadedAt: Date.now(),
    };
    // Let the FIRST epic through, then hit the ceiling on the second.
    let call = 0;
    blockedReasonMock.mockImplementation(() =>
      ++call > 1 ? "This machine has 8 of its 8 agent slots taken." : null,
    );

    render(<BoardView project={project} side="right" />);
    fireEvent.click(screen.getByText("Epic one")); // open the detail overlay
    fireEvent.click(screen.getByTestId("board-bead-card-build-all-prd"));

    // Stopped partway, and SAID so — the number is what tells the user the batch is incomplete.
    await waitFor(() => expect(screen.getByText(/Started 1 of 2/)).toBeTruthy());
    expect(screen.getByText(/the rest are untouched/)).toBeTruthy();
    // Only the FIRST epic was handed off AND claimed; the blocked one is left alone rather than
    // marked in progress with no orchestrator behind it. With the store seeded, the claim assertion
    // is real rather than inert.
    expect(vi.mocked(sendToBuild)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendToBuild)).toHaveBeenCalledWith(
      expect.objectContaining({ epicId: "p1-e1" }),
    );
    expect(vi.mocked(claimBead)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(claimBead)).toHaveBeenCalledWith("/tmp/demo", "p1-e1");
  });

  // The single-task guard's REFUSAL BEHAVIOUR, not just the argument it passes.
  //
  // The mode test below runs with the preflight returning null, so deleting the whole
  // `if (blocked) { … return; }` block leaves it green — the mutated code takes the identical path.
  // (My earlier mutation neutralised the CALL, which only broke the argument assertion. Deleting the
  // BLOCK is the mutation that matters here.) roborev 55152.
  it("the SINGLE-TASK Build It refuses at capacity without claiming or handing off", async () => {
    blockedReasonMock.mockReturnValue("Building this task would need another agent.");
    snapshot = {
      beads: [],
      board: {
        backlog: [bead({ id: "p1-t2", title: "Another small task", type: "task" })],
        blocked: [],
        inProgress: [],
        done: [],
        delivered: [],
        archived: [],
      },
      loadedAt: Date.now(),
    };
    render(<BoardView project={project} side="right" />);
    fireEvent.click(screen.getByText("Another small task"));
    fireEvent.click(
      screen.getByTestId("board-bead-card-build-it"),
    );

    await waitFor(() => expect(screen.getByText(/Building this task/)).toBeTruthy());
    expect(vi.mocked(sendToBuild)).not.toHaveBeenCalled();
    expect(vi.mocked(claimBead)).not.toHaveBeenCalled();
  });

  it("the SINGLE-TASK Build It passes mode 'task', so the refusal never calls it a plan", async () => {
    // A task-typed bead renders the task-level Build It (BoardView's `isTask` branch).
    snapshot = {
      beads: [],
      board: {
        backlog: [bead({ id: "p1-t1", title: "One small task", type: "task" })],
        blocked: [],
        inProgress: [],
        done: [],
        delivered: [],
        archived: [],
      },
      loadedAt: Date.now(),
    };
    render(<BoardView project={project} side="right" />);
    fireEvent.click(screen.getByText("One small task")); // open the detail overlay
    fireEvent.click(
      screen.getByTestId("board-bead-card-build-it"),
    );

    // Same reason as above: settle the async handler inside the test.
    await waitFor(() => expect(sendToBuild).toHaveBeenCalled());

    const call = blockedReasonMock.mock.calls.at(-1)!;
    expect(call[1]).toBe("p1-t1");
    // THE assertion: without this argument the preflight silently defaults to "epic" and the user is
    // told "Starting this plan…" for a one-bead build (roborev 55145).
    expect(call[2]).toBe("task");
  });

  it("shows the status pill + Build It on an epic and hands off with the parsed PRD path", async () => {
    snapshot = epicSnapshot("Ship the app.\n\nPRD file: PRD/2026-06-27-build-the-app.md");
    render(<BoardView project={project} side="right" />);
    fireEvent.click(screen.getByText("Build the app")); // open the epic's detail overlay
    // The epic rollup pill ("not started") is gone; the unified card states progress in the
    // Think→Plan→Build vocabulary instead — one status vocabulary across every surface, which was
    // the point. An open epic with no worker reads "Planned".
    expect(screen.getByTestId("board-bead-card-stage-label").textContent).toBe("Planned");
    // The backlog card ALSO carries a "Build It" (renamed from Start), so scope the click to the
    // overlay's status row — the "not started" pill and the overlay's Build It button are siblings.
    // BY TESTID. This used to walk up from the epic status pill ("not started") to find a sibling
    // Build It — a pill the unified card replaced with the workflow stage, per the founder's call
    // that the Think→Plan→Build vocabulary wins. The card exposes the button directly, which also
    // disambiguates it from the backlog CARD's own Build It without any DOM walking.
    fireEvent.click(screen.getByTestId("board-bead-card-build-it"));
    // AWAITED: with the store seeded, `await claimBead(...)` genuinely runs before the handoff, so
    // this is a microtask later. It only read as synchronous while the claim was dead code.
    await waitFor(() =>
      expect(sendToBuild).toHaveBeenCalledWith({
        projectId: "p1",
        epicId: "p1-e1",
        prdPath: "PRD/2026-06-27-build-the-app.md",
        // EXPLICIT now. The old call site omitted `mode` and leaned on sendToBuild's "epic"
        // default; the shared hook states it. Behaviourally identical (sendToBuild.ts branches
        // only on `=== "task"`), and stating it is what roborev 55145 asked for after an omitted
        // mode made a single-task build announce itself as a plan.
        mode: "epic",
      }),
    );
    // …and the claim really happened, which the null-rootPath fixture could never show.
    expect(claimBead).toHaveBeenCalledWith("/tmp/demo", "p1-e1");
  });

  it("hands off a PRD-less epic with prdPath null (no longer blocks)", async () => {
    // The "no linked PRD" hard block was removed (unify Build It affordances): a PRD-less epic now
    // hands off with prdPath null and sendToBuild seeds off `bd show <epicId>` instead of blocking.
    snapshot = epicSnapshot("no PRD link in this body");
    render(<BoardView project={project} side="right" />);
    fireEvent.click(screen.getByText("Build the app"));
    // BY TESTID. This used to walk up from the epic status pill ("not started") to find a sibling
    // Build It — a pill the unified card replaced with the workflow stage, per the founder's call
    // that the Think→Plan→Build vocabulary wins. The card exposes the button directly, which also
    // disambiguates it from the backlog CARD's own Build It without any DOM walking.
    fireEvent.click(screen.getByTestId("board-bead-card-build-it"));
    await waitFor(() =>
      expect(sendToBuild).toHaveBeenCalledWith({
        projectId: "p1",
        epicId: "p1-e1",
        prdPath: null,
        mode: "epic",
      }),
    );
  });
});

/** The card node for a title, ignoring the "part of epic" back-links that repeat a parent's name. */
function titleNodeGlobal(title: string): HTMLElement | null {
  return (
    screen
      .queryAllByText(title)
      .find((n) => n.closest('[data-testid="part-of-epic"]') === null) ?? null
  );
}

describe("BoardView — Start button + decompose badges (spec §7)", () => {
  afterEach(() => {
    vi.mocked(claimBead).mockClear();
    vi.mocked(labelBead).mockClear();
  });

  /** A backlog epic (with an optional child so Start is enabled) + labels. */
  function startSnapshot(over: { labels?: string[]; withChild?: boolean; description?: string }) {
    const epic = bead({
      id: "p1-e1",
      title: "Epic to start",
      type: "epic",
      description: over.description ?? "Body.\n\nPRD file: PRD/2026-07-01-epic.md",
      labels: over.labels ?? [],
    });
    // `status: "in_progress"` MATTERS now and did not before. `beads.columnFor` derives the column
    // FROM the status, so a bead in `inProgress` with status `open` is a snapshot real data cannot
    // produce — and Build It, which is now offered on every not-yet-started bead, would correctly
    // appear on it and make "Build It" ambiguous in every test below. The fixture was lying; it
    // isn't any more.
    const child = bead({
      id: "p1-e1.1",
      title: "Child task",
      type: "task",
      parent: "p1-e1",
      status: "in_progress",
    });
    const beads = over.withChild === false ? [epic] : [epic, child];
    snapshot = {
      beads,
      board: {
        backlog: [epic],
        blocked: [],
        inProgress: over.withChild === false ? [] : [child],
        done: [],
        delivered: [],
        archived: [],
      },
      loadedAt: Date.now(),
    };
  }

  // The FOURTH call site (StartControls.handleStart). Without this, deleting its guard leaves the
  // suite green — the other Start tests all run with the preflight returning null (roborev 55150).
  it("Start refuses at capacity WITHOUT claiming, so the card keeps its button", async () => {
    blockedReasonMock.mockReturnValue("This machine has 8 of its 8 agent slots taken.");
    startSnapshot({});
    render(<BoardView project={project} side="right" />);
    fireEvent.click(screen.getByTestId("board-card-build-it"));

    await waitFor(() => expect(screen.getByText(/8 of its 8 agent slots/)).toBeTruthy());
    expect(sendToBuild).not.toHaveBeenCalled();
    // The claim is what would move this card out of `backlog` — the column that renders the button
    // at all — so leaving the bead alone is what keeps the retry reachable.
    expect(claimBead).not.toHaveBeenCalled();
  });

  it("claims the epic then hands off to Build with the parsed PRD path", async () => {
    startSnapshot({});
    render(<BoardView project={project} side="right" />);
    fireEvent.click(screen.getByTestId("board-card-build-it"));
    await waitFor(() => expect(sendToBuild).toHaveBeenCalled());
    expect(claimBead).toHaveBeenCalledWith("/tmp/demo", "p1-e1");
    // `mode: "epic"` is EXPLICIT now. `StartControls` used to take `sendToBuild`'s default, which
    // was silently correct while only epics could reach it and would have seeded a bug with "fan
    // out across worker agents" the moment one could.
    expect(sendToBuild).toHaveBeenCalledWith({
      projectId: "p1",
      epicId: "p1-e1",
      prdPath: "PRD/2026-07-01-epic.md",
      mode: "epic",
    });
    // Start must not ALSO open the detail overlay (stopPropagation).
    expect(screen.queryByLabelText("Close")).toBeNull();
  });

  it("passes prdPath null for a PRD-less epic instead of blocking", async () => {
    startSnapshot({ description: "no prd reference" });
    render(<BoardView project={project} side="right" />);
    fireEvent.click(screen.getByTestId("board-card-build-it"));
    await waitFor(() => expect(sendToBuild).toHaveBeenCalled());
    expect(sendToBuild).toHaveBeenCalledWith({
      projectId: "p1",
      epicId: "p1-e1",
      prdPath: null,
      mode: "epic",
    });
  });

  it("disables Start (tooltip decomposing…) while the epic has zero children", () => {
    startSnapshot({ withChild: false });
    render(<BoardView project={project} side="right" />);
    const start = screen.getByTestId("board-card-build-it") as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(start.title).toContain("decomposing…");
    fireEvent.click(start);
    expect(claimBead).not.toHaveBeenCalled();
    expect(sendToBuild).not.toHaveBeenCalled();
  });

  // ══ A REFUSAL MUST NOT EAT THE REMEDY ═══════════════════════════════════════════════════════
  // The sweep writes `stalled` to mean "we spent this epic's restart and it bought nothing; wait
  // for the human", and `beads.ts` names being PICKED UP as one of only three ways back — Build It
  // being that pickup. So excluding stalled beads from Build It removed the last in-app way out,
  // and the `if (!buildIt) return null` that did it took the decompose-failed retry badge down with
  // it (roborev 65607). Both halves are asserted here.
  it("keeps the click-to-clear way out on a STALLED bead whose Build It is withheld", async () => {
    startSnapshot({ labels: ["stalled", "decompose-failed"] });
    render(<BoardView project={project} side="right" />);
    // The refusal itself: a stalled bead is not handed to an agent.
    expect(screen.queryByTestId("board-card-build-it")).toBeNull();
    // ...but the way back survives it — both badges, not just the one for the label under test.
    expect(screen.getByTestId("board-card-clear-stalled")).toBeTruthy();
    expect(screen.getByText("decompose failed")).toBeTruthy();
    // And following it actually clears the label, which is what brings Build It back next poll.
    fireEvent.click(screen.getByTestId("board-card-clear-stalled"));
    await waitFor(() =>
      expect(labelBead).toHaveBeenCalledWith("/tmp/demo", "remove", "p1-e1", "stalled"),
    );
  });

  // ══ THE CHIP MUST MIRROR THE SWEEP'S CLEAR, NOT HALF OF IT ══════════════════════════════════
  // `epicSweepRunner` takes STALLED_LABEL and SWEEP_NO_AUTO_LABEL off TOGETHER, and says why:
  // "leaving the marker behind would reset the epic on every tick from here on". A chip that
  // removed only the first orphans the marker where the sweep can no longer reach it — the
  // condition it keys on (`already-escalated`) is exactly what clearing the stalled label erases —
  // and the orphan resurfaces much later as ONE EXTRA automatic restart on an epic whose contract
  // is "wait for the human" (roborev 65617).
  it("clears the sweep's no-auto marker alongside the stalled label, never orphaning it", async () => {
    startSnapshot({ labels: ["stalled", "stalled-no-auto-restart"] });
    render(<BoardView project={project} side="right" />);
    fireEvent.click(screen.getByTestId("board-card-clear-stalled"));
    await waitFor(() =>
      expect(labelBead).toHaveBeenCalledWith(
        "/tmp/demo",
        "remove",
        "p1-e1",
        "stalled-no-auto-restart",
      ),
    );
    // BOTH, not either — asserting only the marker would pass a handler that dropped the label.
    expect(labelBead).toHaveBeenCalledWith("/tmp/demo", "remove", "p1-e1", "stalled");
  });

  it("disables Start and shows a click-to-clear badge while labeled decomposing", async () => {
    startSnapshot({ labels: ["decomposing"] });
    render(<BoardView project={project} side="right" />);
    expect((screen.getByTestId("board-card-build-it") as HTMLButtonElement).disabled).toBe(true);
    // The badge itself clears the label (the user's way out of a stuck decompose).
    fireEvent.click(screen.getByText("decomposing…"));
    await waitFor(() =>
      expect(labelBead).toHaveBeenCalledWith("/tmp/demo", "remove", "p1-e1", "decomposing"),
    );
  });

  it("shows a decompose-failed chip whose click clears the label so the next sweep retries", async () => {
    startSnapshot({ labels: ["decompose-failed"] });
    render(<BoardView project={project} side="right" />);
    fireEvent.click(screen.getByText(/decompose failed/i));
    await waitFor(() =>
      expect(labelBead).toHaveBeenCalledWith("/tmp/demo", "remove", "p1-e1", "decompose-failed"),
    );
  });

  // ══ WHICH CARDS OFFER BUILD IT — THE FOUNDER-FACING CONTRACT ════════════════════════════════
  // This replaces "shows Build It only on backlog epic cards (not tasks, not other columns)",
  // which pinned the behaviour he filed as broken: on his live store that rule left 1,753 of 2,074
  // open beads — every one of 1,652 bugs — with no way to start work from the board.
  //
  // EVERY CANDIDATE IS MOUNTED AT ONCE, which is the only shape with power here. A test that
  // renders one card and checks the button is present proves nothing about a gate keyed to the
  // wrong side of the question; a test that renders none and checks it is absent proves less. The
  // assertion that bites names all of them and says what each one gets.
  it("offers Build It on every NOT-YET-STARTED card of any type, and on no started one", () => {
    const startable = [
      bead({ id: "p1-t1", title: "Plain task", type: "task" }),
      bead({ id: "p1-b1", title: "A bug", type: "bug" }),
      bead({ id: "p1-f1", title: "A feature", type: "feature" }),
      bead({ id: "p1-c1", title: "A chore", type: "chore" }),
    ];
    const running = bead({
      id: "p1-r1",
      title: "Running task",
      type: "task",
      status: "in_progress",
    });
    const finished = bead({ id: "p1-d1", title: "Finished task", type: "task", status: "closed" });
    // ── THE THREE OPEN-BUT-UNSTARTABLE LANES ────────────────────────────────────────────────────
    // All three are `status: "open"`, so a gate that read only the status would offer Build It on
    // every one of them. They are mounted HERE, on the board, and not only in the hook's own suite,
    // because that is the surface the founder presses and the one where the old column gate used to
    // exclude them by accident.
    const depBlocked = bead({ id: "p1-x1", title: "Blocked task", type: "task" });
    const stalled = bead({ id: "p1-x2", title: "Stalled task", type: "task", labels: ["stalled"] });
    const doneEpic = bead({ id: "p1-x3", title: "Rolled-up epic", type: "epic" });
    const doneKid = bead({
      id: "p1-x3.1",
      title: "Its only child",
      type: "task",
      parent: "p1-x3",
      status: "closed",
    });
    snapshot = {
      beads: [...startable, running, finished, depBlocked, stalled, doneEpic, doneKid],
      board: {
        backlog: [...startable, stalled, doneEpic],
        blocked: [depBlocked],
        inProgress: [running],
        done: [finished, doneKid],
        delivered: [],
        archived: [],
      },
      loadedAt: Date.now(),
    };
    render(<BoardView project={project} side="right" />);

    // SCOPED TO THE CARD, NOT THE COLUMN — the first draft of this test used the column, and all
    // four type assertions silently read the SAME first card's button while reporting four passes.
    const buildItIn = (title: string) => {
      const card = titleNodeGlobal(title)?.closest(
        "[data-testid=\"board-card-epic\"],[data-testid=\"board-card-task\"]",
      ) as HTMLElement | null;
      return card ? within(card).queryAllByTestId("board-card-build-it") : [];
    };

    for (const b of startable) {
      const [btn] = buildItIn(b.title);
      expect(btn, `${b.type} should offer Build It`).toBeTruthy();
      // ENABLED, not merely present. The epic-only "no children yet → decomposing…" guard must not
      // reach a bug or a task: those ARE the unit of work and never have children, so applying it
      // would render a button on all 1,652 bugs that can never be pressed — the same defect wearing
      // a different disguise.
      expect((btn as HTMLButtonElement).disabled, `${b.type} should be pressable`).toBe(false);
    }
    // ...and the other half of the pair: work that is not startable is not offered a handoff.
    // Started or finished —
    expect(buildItIn("Running task")).toHaveLength(0);
    expect(buildItIn("Finished task")).toHaveLength(0);
    // — and open, but not "not started yet". Each of these was offered-and-pressable in the first
    // draft of this change and was caught by review; pressing them would have handed an agent a
    // bead with unmet prerequisites, re-handed off work the sweep had given up on, and claimed a
    // finished epic to in_progress respectively.
    expect(buildItIn("Blocked task")).toHaveLength(0);
    expect(buildItIn("Stalled task")).toHaveLength(0);
    expect(buildItIn("Rolled-up epic")).toHaveLength(0);
  });
});

describe("BoardView — Definable Done & Delivered (Unit 5)", () => {
  it("shows the Define CTA for an undefined Done column and NOT for Backlog/In Progress", async () => {
    render(<BoardView project={project} side="right" />);
    await waitFor(() => expect(getConfig).toHaveBeenCalledWith("/tmp/demo"));
    // Undefined Done/Delivered → centered blue Define CTA in the column body.
    expect(screen.getByText("Define “Done”")).toBeTruthy();
    expect(screen.getByText("Define “Shipped”")).toBeTruthy();
    // The inert columns never get a Define affordance.
    expect(screen.queryByText("Define “Backlog”")).toBeNull();
    expect(screen.queryByText("Define “Being built”")).toBeNull();
  });

  it("opens the Define modal for the matching stage when a Done/Delivered header is clicked", async () => {
    render(<BoardView project={project} side="right" />);
    // The Done column TITLE is a button (Backlog/In Progress titles are plain text). Its accessible
    // name is the label; the "Define what …" hover lives on the title attribute.
    const doneHeader = screen.getByRole("button", { name: "Done" });
    expect(doneHeader.title).toMatch(/Define what “Done” means/i);
    fireEvent.click(doneHeader);
    expect(screen.getByTestId("define-modal").textContent).toContain("define-modal:done");
    // Closing the modal removes it.
    fireEvent.click(screen.getByText("close-modal"));
    expect(screen.queryByTestId("define-modal")).toBeNull();
    // Backlog / In Progress headers are inert (not buttons).
    expect(screen.queryByRole("button", { name: "Backlog" })).toBeNull();
    expect(screen.queryByRole("button", { name: "In Progress" })).toBeNull();
  });

  it("opens the Delivered modal from its empty-state CTA button", async () => {
    render(<BoardView project={project} side="right" />);
    await waitFor(() => expect(screen.getByText("Define “Shipped”")).toBeTruthy());
    fireEvent.click(screen.getByText("Define “Shipped”"));
    expect(screen.getByTestId("define-modal").textContent).toContain("define-modal:delivered");
  });

  it("shows a defined-column status chip and no Define CTA once Done is defined", async () => {
    defineDone();
    snapshot = {
      beads: [],
      board: { backlog: [], blocked: [], inProgress: [], done: [], delivered: [], archived: [] },
      loadedAt: Date.now(),
    };
    render(<BoardView project={project} side="right" />);
    await waitFor(() => expect(screen.getByText("defined")).toBeTruthy());
    expect(screen.queryByText("Define “Done”")).toBeNull();
  });

  it("surfaces a per-card criteria chip and, once all criteria are met, a Mark control", async () => {
    // Done defined with a single MANUAL criterion → a backlog card evaluates toward Done.
    defineDone({ text: "Reviewed by a teammate", kind: "manual", signal: null });
    snapshot = {
      beads: [],
      board: {
        backlog: [bead({ id: "p1-m1", title: "Needs review" })],
        blocked: [],
        inProgress: [],
        done: [],
        delivered: [],
        archived: [],
      },
      loadedAt: Date.now(),
    };
    render(<BoardView project={project} side="right" />);
    // Compact progress chip appears ("0 of 1" met) — no Mark control yet.
    await waitFor(() => expect(screen.getByText("0 of 1")).toBeTruthy());
    expect(screen.queryByText("Mark as Done")).toBeNull();
    // Expand the popover, tick the manual criterion → allMet → the Mark control appears.
    fireEvent.click(screen.getByText("0 of 1"));
    fireEvent.click(screen.getAllByRole("checkbox")[0]!);
    await waitFor(() => expect(screen.getByText("1 of 1")).toBeTruthy());
    expect(screen.getByText("Mark as Done")).toBeTruthy();
  });

  it("clicking Mark as Done performs the real bd move (closeBead) once criteria are met", async () => {
    defineDone({ text: "Reviewed by a teammate", kind: "manual", signal: null });
    snapshot = {
      beads: [],
      board: {
        backlog: [bead({ id: "p1-m1", title: "Needs review" })],
        blocked: [],
        inProgress: [],
        done: [],
        delivered: [],
        archived: [],
      },
      loadedAt: Date.now(),
    };
    render(<BoardView project={project} side="right" />);
    await waitFor(() => expect(screen.getByText("0 of 1")).toBeTruthy());
    fireEvent.click(screen.getByText("0 of 1")); // expand popover
    fireEvent.click(screen.getAllByRole("checkbox")[0]!); // tick the manual criterion → allMet
    fireEvent.click(await screen.findByText("Mark as Done"));
    await waitFor(() => expect(closeBead).toHaveBeenCalledWith("/tmp/demo", "p1-m1"));
    expect(markBeadDelivered).not.toHaveBeenCalled();
  });

  it("clicking Mark as Delivered performs the real bd move (markBeadDelivered)", async () => {
    // A closed card in the Done column evaluates toward Delivered; a met manual criterion enables Mark.
    defineDelivered({ text: "Deployed to prod verified", kind: "manual", signal: null });
    snapshot = {
      beads: [],
      board: {
        backlog: [],
        blocked: [],
        inProgress: [],
        done: [bead({ id: "p1-d9", title: "Landed feature", status: "closed" })],
        delivered: [],
        archived: [],
      },
      loadedAt: Date.now(),
    };
    render(<BoardView project={project} side="right" />);
    await waitFor(() => expect(screen.getByText("0 of 1")).toBeTruthy());
    fireEvent.click(screen.getByText("0 of 1"));
    fireEvent.click(screen.getAllByRole("checkbox")[0]!);
    fireEvent.click(await screen.findByText("Mark as Delivered"));
    await waitFor(() => expect(markBeadDelivered).toHaveBeenCalledWith("/tmp/demo", "p1-d9"));
    expect(closeBead).not.toHaveBeenCalled();
  });

  it("starts the delivery monitor only once Delivered is defined, and stops it on unmount", async () => {
    defineDelivered();
    const { unmount } = render(<BoardView project={project} side="right" />);
    await waitFor(() =>
      expect(startDeliveryMonitor).toHaveBeenCalledWith(
        "/tmp/demo",
        expect.any(Function),
        expect.any(Function),
      ),
    );
    unmount();
    expect(stopDeliveryMonitor).toHaveBeenCalled();
  });
});

// The per-agent FEEDBACK filter (feedback-pill-and-filter): a build-agent row's FEEDBACK pill sets
// uiStore.boardAgentFilter to its agent id, then jumps here. The board must then show ONLY beads
// carrying that agent's `agent:<id>` label — the beads it created or commented on — and offer a
// clearable banner. Client-side over the already-bucketed columns; the poll/fetch are untouched.
describe("BoardView — per-agent feedback filter (feedback-pill-and-filter)", () => {
  afterEach(() => {
    // The filter lives in the real uiStore singleton (a module-level store), so clear it or it leaks
    // into every later suite in this file and silently hides their beads.
    useUiStore.getState().setBoardAgentFilter("right", null);
  });

  function labeledSnapshot() {
    const mine = bead({ id: "p1-mine", title: "My feedback bead", labels: ["agent:agent-x"] });
    const other = bead({ id: "p1-other", title: "Someone elses bead", labels: ["agent:agent-y"] });
    snapshot = {
      beads: [mine, other],
      board: { backlog: [mine, other], blocked: [], inProgress: [], done: [], delivered: [], archived: [] },
      loadedAt: Date.now(),
    };
  }

  // THE mutation-check target for the filter: deleting the client-side narrow (so displayBoard ===
  // board) renders BOTH beads, which fails the `queryByText(...).toBeNull()` below.
  it("with boardAgentFilter set, renders ONLY beads labeled agent:<id> and hides the rest", () => {
    labeledSnapshot();
    useUiStore.getState().setBoardAgentFilter("right", "agent-x");
    render(<BoardView project={project} side="right" />);
    // The matching bead is shown…
    expect(screen.getByText("My feedback bead")).toBeTruthy();
    // …and the non-matching one is HIDDEN. This is the assertion the filter exists to satisfy.
    expect(screen.queryByText("Someone elses bead")).toBeNull();
  });

  it("shows a clearable banner, and Clear restores the full board", () => {
    labeledSnapshot();
    useUiStore.getState().setBoardAgentFilter("right", "agent-x");
    render(<BoardView project={project} side="right" />);
    const banner = screen.getByTestId("board-agent-filter-banner");
    // No agent by that id is registered on the project here, so this exercises the CLOSED-AGENT
    // fallback — see the two tests below, which pin each branch explicitly.
    expect(banner.textContent).toContain("agent-x");
    // Clear drops the filter → the store goes null AND the hidden bead comes back.
    fireEvent.click(within(banner).getByText("Clear"));
    expect(useUiStore.getState().boardAgentFilterBySide.right).toBeNull();
    expect(screen.getByText("Someone elses bead")).toBeTruthy();
  });

  // ── THE BANNER NAMES THE AGENT, NOT ITS UUID ────────────────────────────────────────────────
  // The founder's report: 'it tells me "Showing feedback from agent a4e23b93-0b03-…" but I need to
  // know what that agent name is'. The id was always resolvable — `agents` is scoped to this
  // board's project and already read for the worker rows — so this is a lookup that was simply
  // never done, not missing data.
  //
  // MUTATION TARGET: reverting the banner to `{boardAgentFilter}` makes the name assertion fail AND
  // the not-the-uuid assertion fail. A test that only asserted the name were present would stay
  // green if both were printed, so the negative is the load-bearing half.
  it("resolves the filtered agent's id to its DISPLAY NAME and does not print the uuid", () => {
    labeledSnapshot();
    const agentId = "a4e23b93-0b03-4be8-bd6f-f8c5df274c84";
    const mine = bead({ id: "p1-mine", title: "My feedback bead", labels: [`agent:${agentId}`] });
    snapshot = {
      beads: [mine],
      board: { backlog: [mine], blocked: [], inProgress: [], done: [], delivered: [], archived: [] },
      loadedAt: Date.now(),
    };
    useProjectStore.setState({
      projects: [
        {
          ...project,
          agents: [
            {
              id: agentId,
              name: "Stripe Checkout Flow",
              namePinned: true,
              selfNamed: false,
              aiTitle: null,
              autoNameVariants: null,
            } as AgentTab,
          ],
        },
      ],
      selectedProjectId: project.id,
    });
    useUiStore.getState().setBoardAgentFilter("right", agentId);
    render(<BoardView project={project} side="right" />);

    const label = screen.getByTestId("board-agent-filter-label");
    expect(label.textContent).toContain("Stripe Checkout Flow");
    // The whole point: the uuid is GONE from the banner.
    expect(label.textContent).not.toContain(agentId);
  });

  // The agent was closed, or the project switched under an open board. The filter is NOT cleared
  // (the beads are still labelled `agent:<id>`, so the board really is narrowed and this banner is
  // the only explanation for why) — but it must say so in words rather than printing a bare uuid as
  // if it were a name, and it must never render an empty <strong>.
  it("says the agent is closed, with a truncated id, when the id does not resolve", () => {
    labeledSnapshot();
    useUiStore.getState().setBoardAgentFilter("right", "a4e23b93-0b03-4be8-bd6f-f8c5df274c84");
    render(<BoardView project={project} side="right" />);

    const label = screen.getByTestId("board-agent-filter-label");
    expect(label.textContent).toContain("closed agent");
    expect(label.textContent).toContain("a4e23b93");
    // Truncated, not the whole uuid.
    expect(label.textContent).not.toContain("f8c5df274c84");
    // The filter survives — dropping it would leave a silently short board.
    expect(useUiStore.getState().boardAgentFilterBySide.right).toBe(
      "a4e23b93-0b03-4be8-bd6f-f8c5df274c84",
    );
  });

  it("renders the full board (and NO banner) when no filter is set", () => {
    labeledSnapshot();
    render(<BoardView project={project} side="right" />);
    expect(screen.queryByTestId("board-agent-filter-banner")).toBeNull();
    expect(screen.getByText("My feedback bead")).toBeTruthy();
    expect(screen.getByText("Someone elses bead")).toBeTruthy();
  });
});

// ── PRIORITY + DATE-RANGE FILTER ──────────────────────────────────────────────────────────────
// The founder: "I want to be able to only look at cards of a certain priority status and also a
// certain date range." The rules themselves are unit-tested in services/boardFilters.test.ts; what
// these cover is that BoardView actually APPLIES them, and that an emptied board explains itself.
describe("BoardView — priority and date filters", () => {
  afterEach(() => {
    useUiStore.getState().setBoardFilter("right", NO_BOARD_FILTER);
  });

  const RECENT = new Date(Date.now() - 3600_000).toISOString();
  const OLD = new Date(Date.now() - 60 * 24 * 3600_000).toISOString();

  function mixedSnapshot() {
    const p0 = bead({ id: "p1-p0", title: "Urgent one", priority: 0, updatedAt: RECENT });
    const p2 = bead({ id: "p1-p2", title: "Later one", priority: 2, updatedAt: RECENT });
    const stale = bead({ id: "p1-old", title: "Ancient one", priority: 0, updatedAt: OLD });
    snapshot = {
      beads: [p0, p2, stale],
      board: { backlog: [p0, p2, stale], blocked: [], inProgress: [], done: [], delivered: [], archived: [] },
      loadedAt: Date.now(),
    };
  }

  // MUTATION TARGET: dropping `matchesBoardFilter` from BoardView's keep() renders all three.
  it("shows only the selected priority and hides the others", () => {
    mixedSnapshot();
    useUiStore.getState().setBoardFilter("right", { ...NO_BOARD_FILTER, priority: 0 });
    render(<BoardView project={project} side="right" />);
    expect(screen.getByText("Urgent one")).toBeTruthy();
    expect(screen.getByText("Ancient one")).toBeTruthy();
    expect(screen.queryByText("Later one")).toBeNull();
  });

  it("applies the date window, and the created/updated switch selects which date", () => {
    mixedSnapshot();
    useUiStore.getState().setBoardFilter("right", { ...NO_BOARD_FILTER, dateWindow: "24h" });
    const { unmount } = render(<BoardView project={project} side="right" />);
    expect(screen.getByText("Urgent one")).toBeTruthy();
    // 60 days old on `updatedAt` — outside a 24h window.
    expect(screen.queryByText("Ancient one")).toBeNull();
    unmount();

    // The same bead has NO createdAt, and an unreadable date must KEEP a bead rather than hide it
    // (sparkle-qogah). Flipping the field therefore brings it back.
    useUiStore
      .getState()
      .setBoardFilter("right", { ...NO_BOARD_FILTER, dateWindow: "24h", dateField: "created" });
    render(<BoardView project={project} side="right" />);
    expect(screen.getByText("Ancient one")).toBeTruthy();
  });

  it("both axes combine — a recent bead of the wrong priority is still hidden", () => {
    mixedSnapshot();
    useUiStore
      .getState()
      .setBoardFilter("right", { ...NO_BOARD_FILTER, priority: 0, dateWindow: "24h" });
    render(<BoardView project={project} side="right" />);
    expect(screen.getByText("Urgent one")).toBeTruthy();
    expect(screen.queryByText("Later one")).toBeNull(); // recent, wrong priority
    expect(screen.queryByText("Ancient one")).toBeNull(); // right priority, too old
  });

  // ══ AN EMPTIED BOARD MUST SAY WHY ═══════════════════════════════════════════════════════════
  // Five empty columns read as "this project has no work". The count is the honest part: it says
  // the cards exist and the filter is why they are not on screen.
  it("explains an emptied board and reports how many cards are hidden", () => {
    mixedSnapshot();
    // No bead has priority 3, so everything is filtered out.
    useUiStore.getState().setBoardFilter("right", { ...NO_BOARD_FILTER, priority: 3 });
    render(<BoardView project={project} side="right" />);

    const notice = screen.getByTestId("board-filter-empty-notice");
    expect(notice.textContent).toContain("No cards match this filter");
    expect(notice.textContent).toContain("3");
    // And Clear restores every card.
    fireEvent.click(within(notice).getByText("Clear filters"));
    expect(screen.getByText("Urgent one")).toBeTruthy();
    expect(screen.getByText("Later one")).toBeTruthy();
    expect(screen.getByText("Ancient one")).toBeTruthy();
  });

  // A PARTIAL narrow is self-evident — cards are on screen — so the notice must not fire. Without
  // this the banner would appear over a board that is visibly working.
  it("shows NO empty notice while the filter still leaves cards on screen", () => {
    mixedSnapshot();
    useUiStore.getState().setBoardFilter("right", { ...NO_BOARD_FILTER, priority: 0 });
    render(<BoardView project={project} side="right" />);
    expect(screen.queryByTestId("board-filter-empty-notice")).toBeNull();
  });

  // ══ THE TWO FILTERS STACK, AND THE NOTICE MUST ONLY SPEAK FOR ITS OWN ═══════════════════════
  // The agent filter and the priority/date filter sit on the same seam. Measuring the doubly
  // filtered board against the UNfiltered snapshot attributes the agent filter's removals to this
  // notice (roborev 59075). Both rows below failed before the baseline was moved.
  describe("with the per-agent feedback filter ALSO active", () => {
    afterEach(() => {
      useUiStore.getState().setBoardAgentFilter("right", null);
    });

    function stackedSnapshot() {
      // 4 beads; only 1 belongs to agent-x; that one is P2.
      const mine = bead({ id: "p1-m", title: "Mine P2", priority: 2, labels: ["agent:agent-x"] });
      const others = [1, 2, 3].map((n) =>
        bead({ id: `p1-o${n}`, title: `Other ${n}`, priority: 0, labels: ["agent:agent-y"] }),
      );
      const all = [mine, ...others];
      snapshot = {
        beads: all,
        board: { backlog: all, blocked: [], inProgress: [], done: [], delivered: [], archived: [] },
        loadedAt: Date.now(),
      };
    }

    it("counts only what the PRIORITY filter hid, not the agent filter's removals", () => {
      stackedSnapshot();
      useUiStore.getState().setBoardAgentFilter("right", "agent-x");
      // The agent filter leaves 1 bead (P2); filtering to P0 hides that ONE.
      useUiStore.getState().setBoardFilter("right", { ...NO_BOARD_FILTER, priority: 0 });
      render(<BoardView project={project} side="right" />);

      const notice = screen.getByTestId("board-filter-empty-notice");
      // ONE, not four. The other three were never this filter's to hide.
      expect(notice.textContent).toContain("1");
      expect(notice.textContent).not.toContain("4");
    });

    it("stays silent when the AGENT filter is what emptied the board", () => {
      stackedSnapshot();
      // No bead carries this agent, so the agent filter alone empties the board…
      useUiStore.getState().setBoardAgentFilter("right", "agent-nobody");
      // …while a board filter is set but is not the cause.
      useUiStore.getState().setBoardFilter("right", { ...NO_BOARD_FILTER, priority: 0 });
      render(<BoardView project={project} side="right" />);

      // Firing here would blame the wrong control AND offer a "Clear filters" button that resets
      // only boardFilter — leaving the board just as empty. The agent banner above owns this case.
      expect(screen.queryByTestId("board-filter-empty-notice")).toBeNull();
      expect(screen.getByTestId("board-agent-filter-banner")).toBeTruthy();
    });
  });

  it("shows NO empty notice when the board is genuinely empty and no filter is set", () => {
    snapshot = {
      beads: [],
      board: { backlog: [], blocked: [], inProgress: [], done: [], delivered: [], archived: [] },
      loadedAt: Date.now(),
    };
    render(<BoardView project={project} side="right" />);
    expect(screen.queryByTestId("board-filter-empty-notice")).toBeNull();
  });
});

// ── THE WHEEL MOVES THE BOARD, NOT ONE COLUMN'S CARDS ─────────────────────────────────────────
//
// A kanban is a HORIZONTAL thing and the wheel is the gesture people reach for to travel along it,
// but the browser will not do that unaided: `deltaY` scrolls the nearest ancestor overflowing on Y,
// and the only such ancestor here is a column's card list. So the board could never be moved by a
// wheel at all — the founder's BACKLOG (606 items) ate every scroll while BLOCKED sat clipped at
// the right edge with no gesture that would bring it in.
describe("boardScrollDelta — which thing the wheel moves", () => {
  const atRest = { scrollTop: 0, scrollHeight: 100, clientHeight: 100 };
  const roomBelow = { scrollTop: 0, scrollHeight: 900, clientHeight: 300 };
  const atBottom = { scrollTop: 600, scrollHeight: 900, clientHeight: 300 };

  it("moves the BOARD when the pointer is not over a card list at all", () => {
    // Column headers, the gaps between columns, the padding — most of the board's surface.
    expect(boardScrollDelta({ deltaX: 0, deltaY: 120 }, null)).toBe(120);
    expect(boardScrollDelta({ deltaX: 0, deltaY: -120 }, null)).toBe(-120);
  });

  it("moves the BOARD over a column whose cards all fit — there is nothing to scroll there", () => {
    expect(boardScrollDelta({ deltaX: 0, deltaY: 120 }, atRest)).toBe(120);
  });

  it("leaves a column that can still move in the wheel's own direction alone", () => {
    // The exception, and the reason a 606-card column stays readable: while the list has room the
    // list keeps the event. Board-always-wins would make those cards reachable only by dragging a
    // scrollbar, which trades the founder's bug for a worse one.
    expect(boardScrollDelta({ deltaX: 0, deltaY: 120 }, roomBelow)).toBe(0);
    expect(boardScrollDelta({ deltaX: 0, deltaY: -120 }, atBottom)).toBe(0);
  });

  it("hands the board the event once that column is at its end — one continuous gesture", () => {
    expect(boardScrollDelta({ deltaX: 0, deltaY: 120 }, atBottom)).toBe(120);
    expect(boardScrollDelta({ deltaX: 0, deltaY: -120 }, roomBelow)).toBe(-120);
  });

  it("keeps its hands off a horizontal gesture, which already lands on the board", () => {
    // The board row IS the nearest X scroller, so the browser does this one right unaided; adding
    // to scrollLeft as well would double every trackpad swipe.
    expect(boardScrollDelta({ deltaX: 90, deltaY: 4 }, null)).toBe(0);
    expect(boardScrollDelta({ deltaX: 0, deltaY: 0 }, null)).toBe(0);
  });

  it("reads a LINE-mode wheel in pixels, like the sidebar's forwarder already does", () => {
    // A mouse in DOM_DELTA_LINE mode reports ~3 per notch. Taken raw, the board would creep 3px a
    // notch — indistinguishable from "the wheel does nothing", which is the bug being fixed.
    expect(boardScrollDelta({ deltaX: 0, deltaY: 3, deltaMode: 1 }, null)).toBe(48);
    expect(boardScrollDelta({ deltaX: 0, deltaY: -3, deltaMode: 1 }, null)).toBe(-48);
    expect(boardScrollDelta({ deltaX: 0, deltaY: 1, deltaMode: 2 }, null)).toBe(400);
    // The normalisation reaches the RETURNED VALUE with a list in play too, not just the null case:
    // a list at its end hands the gesture over, and what it hands over is 48px, not 3.
    expect(boardScrollDelta({ deltaX: 0, deltaY: 3, deltaMode: 1 }, atBottom)).toBe(48);
  });

  it("decides the handoff on DIRECTION alone — never on how big the gesture is", () => {
    // Worth pinning because the obvious "improvement" is to compare travel against slack, which
    // would change when the board takes over on every column. It does not: `room`/`scrollTop` are
    // tested against a sub-pixel constant, and the delta contributes only its SIGN. A list with
    // 20px left keeps a 3-line gesture and a 1000px one alike.
    const nearlyDone = { scrollTop: 0, scrollHeight: 320, clientHeight: 300 };
    expect(boardScrollDelta({ deltaX: 0, deltaY: 3, deltaMode: 1 }, nearlyDone)).toBe(0);
    expect(boardScrollDelta({ deltaX: 0, deltaY: 3, deltaMode: 0 }, nearlyDone)).toBe(0);
    expect(boardScrollDelta({ deltaX: 0, deltaY: 1000, deltaMode: 0 }, nearlyDone)).toBe(0);
  });

  it("treats a sub-pixel remainder as 'at the end'", () => {
    // Fractional scrollHeight (zoom, fractional DPR) otherwise leaves a list able to scroll by a
    // hair forever, and the board would never take over — the original bug, restored by rounding.
    expect(boardScrollDelta({ deltaX: 0, deltaY: 120 }, { scrollTop: 0, scrollHeight: 300.4, clientHeight: 300 })).toBe(120);
  });
});

describe("the board's scroll containers", () => {
  it("scrolls the columns sideways when a wheel arrives over a list with no room left", () => {
    render(<BoardView project={project} side="right" />);
    const row = screen.getByTestId("board-columns");
    // jsdom has no layout, so scrollLeft is a permanent 0 there — make it a real settable property
    // so the handler's write is observable. The GEOMETRY below is the test's actual input.
    Object.defineProperty(row, "scrollLeft", { value: 0, writable: true, configurable: true });
    const list = row.querySelector("[data-board-column-list]") as HTMLElement;
    expect(list).toBeTruthy();

    fireEvent.wheel(list, { deltaX: 0, deltaY: 150 });
    expect(row.scrollLeft).toBe(150);
  });

  it("leaves the board alone while the column under the pointer still has cards to reveal", () => {
    render(<BoardView project={project} side="right" />);
    const row = screen.getByTestId("board-columns");
    Object.defineProperty(row, "scrollLeft", { value: 0, writable: true, configurable: true });
    const list = row.querySelector("[data-board-column-list]") as HTMLElement;
    Object.defineProperty(list, "scrollHeight", { value: 900, configurable: true });
    Object.defineProperty(list, "clientHeight", { value: 300, configurable: true });

    fireEvent.wheel(list, { deltaX: 0, deltaY: 150 });
    expect(row.scrollLeft).toBe(0);
  });

  it("gives each axis exactly one owner", () => {
    const { container } = render(<BoardView project={project} side="right" />);
    const row = screen.getByTestId("board-columns");
    // The row is the X scroller and NOT a Y one. Left `visible`, CSS would force overflow-y to
    // `auto` here (one axis non-visible forces the other) and put a second vertical scroller around
    // the columns, so "which thing did I just scroll" would have no answer.
    expect(row.style.overflowX).toBe("auto");
    expect(row.style.overflowY).toBe("hidden");
    // ...and each card list is the Y scroller and NOT an X one. That same CSS rule is what silently
    // made these horizontal scrollers: any card wider than its column gave the list scrollable
    // width, and one sideways nudge pushed the text out of view on the LEFT — the founder's clipped
    // titles ("window drop is", "causes").
    const lists = container.querySelectorAll<HTMLElement>("[data-board-column-list]");
    // Six columns now: Backlog / Blocked / Being built / Done / Shipped / Archived. Each owns one
    // vertical scroller (the archived column's list is present even while collapsed).
    expect(lists.length).toBe(6);
    for (const l of lists) {
      expect(l.style.overflowY).toBe("auto");
      expect(l.style.overflowX).toBe("hidden");
      // CONTAINED ON Y ONLY, and the suffix is load-bearing (roborev 57312). A hidden axis is a
      // CLIPPED scrollport, not an absent one, so this element is still a scroll container on X —
      // an unsuffixed `overscroll-behavior: contain` latches a horizontal swipe HERE, where nothing
      // can move, instead of letting it chain to the board row. Over a column tall enough to be a
      // scroller that leaves NO gesture that reaches the board, since the vertical rule hands the
      // list the wheel: the exact bug this file is guarding, on the exact column that reported it.
      expect(l.style.overscrollBehaviorY).toBe("contain");
      expect(l.style.overscrollBehavior).toBe("");
      expect(l.style.overscrollBehaviorX).toBe("");
    }
  });

  it("leaves a horizontal gesture to the browser rather than half-handling it", () => {
    render(<BoardView project={project} side="right" />);
    const row = screen.getByTestId("board-columns");
    Object.defineProperty(row, "scrollLeft", { value: 0, writable: true, configurable: true });
    const list = row.querySelector("[data-board-column-list]") as HTMLElement;
    // The row is the nearest X scroller, so the browser already moves it; adding to scrollLeft here
    // as well would double every trackpad swipe.
    fireEvent.wheel(list, { deltaX: 150, deltaY: 2 });
    expect(row.scrollLeft).toBe(0);
  });

  it("lets a card be narrower than its longest word, so a title wraps instead of overflowing", () => {
    // The other half of the clipped-title fix: hiding the axis alone would CLIP the overflow rather
    // than scroll it, which is no better. Bead titles carry paths and branch names with no break
    // opportunity, so the text has to be allowed to break anywhere and the card to shrink below it.
    render(<BoardView project={project} side="right" />);
    const title = screen.getByText("Backlog one");
    expect(title.style.overflowWrap).toBe("anywhere");
    // The description preview carries the same text, and the same risk.
    expect(screen.getByText("First backlog task description.").style.overflowWrap).toBe("anywhere");
    // And NO `minWidth: 0` anywhere on the way up (roborev 57312): the content-based automatic
    // minimum is a MAIN-AXIS rule, and every box here is an item of a column-direction flex
    // container, so `min-width: auto` already resolves to 0. Declaring it is dead style that reads
    // as load-bearing — pin its absence so it does not come back as cargo.
    const body = title.closest("button") as HTMLElement;
    const card = body.parentElement as HTMLElement;
    expect(card.style.background).toBeTruthy(); // it really is the card shell, not another wrapper
    expect(body.style.minWidth).toBe("");
    expect(card.style.minWidth).toBe("");
  });
});

describe("the board's header", () => {
  it("does not restate the project name above the columns", () => {
    // Founder's call: the tab bar directly above already says which project this is, and a 17px
    // row plus its hairline was ~44px of board height spent repeating it — taken from the cards.
    render(<BoardView project={project} side="right" />);
    expect(screen.queryByText(/Tasks —/)).toBeNull();
    expect(screen.queryByText(`Tasks — ${project.name}`)).toBeNull();
  });

  it("still surfaces a fetch error, which that row also carried", () => {
    error = "bd blew up";
    render(<BoardView project={project} side="right" />);
    expect(screen.getByTestId("board-error").textContent).toBe("bd blew up");
  });

  it("reserves no banner when there is no error", () => {
    render(<BoardView project={project} side="right" />);
    expect(screen.queryByTestId("board-error")).toBeNull();
  });
});

// ── Fix #1: PRIORITY ON THE CARD FACE ──────────────────────────────────────────────────────────
// The founder asked to see a bead's priority on EVERY card in the columns, not only after opening
// one. These assert the SIDE EFFECT — the chip on a collapsed card reflects that bead's OWN
// priority — so a chip wired to a constant (or to the wrong bead) fails rather than passing.
describe("the priority chip on a card face", () => {
  function boardWith(beads: Bead[]): Board {
    return { backlog: beads, blocked: [], inProgress: [], done: [], delivered: [], archived: [] };
  }

  it("shows each backlog card's own priority, on the card and not just in the overlay", () => {
    const p0 = bead({ id: "p1-pri0", title: "Urgent one", priority: 0 });
    const p3 = bead({ id: "p1-pri3", title: "Someday", priority: 3 });
    snapshot = { beads: [p0, p3], board: boardWith([p0, p3]), loadedAt: Date.now() };
    render(<BoardView project={project} side="right" />);

    // Two chips, one per card, each carrying THAT card's priority — the wiring, not a constant.
    const chips = screen.getAllByTestId("bead-priority-chip");
    expect(chips).toHaveLength(2);
    const byPriority = chips.map((c) => c.getAttribute("data-priority"));
    expect(byPriority).toContain("0");
    expect(byPriority).toContain("3");
    // The label reads P0 for the urgent one — the collapsed card is where it now lives.
    const p0Chip = chips.find((c) => c.getAttribute("data-priority") === "0");
    expect(p0Chip?.textContent).toContain("P0");
  });

  it("renders P? for a card with no priority set (an unset priority is worth seeing, not hiding)", () => {
    const none = bead({ id: "p1-nopri", title: "Unprioritised" });
    snapshot = { beads: [none], board: boardWith([none]), loadedAt: Date.now() };
    render(<BoardView project={project} side="right" />);
    const chip = screen.getByTestId("bead-priority-chip");
    expect(chip.getAttribute("data-priority")).toBe("");
    expect(chip.textContent).toContain("P?");
  });
});

// ── Fix #4: THE ARCHIVED COLUMN ────────────────────────────────────────────────────────────────
// A far-right column for closed+archived beads, collapsed by default and render-capped so a
// ~1,800-bead pile never mounts eagerly.
describe("the archived column", () => {
  function boardWithArchived(archived: Bead[]): Board {
    return { backlog: [], blocked: [], inProgress: [], done: [], delivered: [], archived };
  }

  it("renders an Archived column header after Shipped", () => {
    snapshot = { beads: [], board, loadedAt: Date.now() };
    render(<BoardView project={project} side="right" />);
    const columns = screen.getByTestId("board-columns");
    const labels = Array.from(columns.querySelectorAll("[data-board-column]")).map((el) =>
      el.getAttribute("data-board-column"),
    );
    expect(labels).toEqual(["backlog", "blocked", "inProgress", "done", "delivered", "archived"]);
  });

  it("does NOT mount archived cards by default — it shows a count and an expand affordance", () => {
    const a1 = bead({ id: "p1-arc1", title: "Old junk one", status: "closed", labels: ["archived"] });
    const a2 = bead({ id: "p1-arc2", title: "Old junk two", status: "closed", labels: ["archived"] });
    snapshot = { beads: [a1, a2], board: boardWithArchived([a1, a2]), loadedAt: Date.now() };
    render(<BoardView project={project} side="right" />);
    // The SIDE EFFECT of "collapsed/lazy": the cards are NOT in the DOM.
    expect(screen.queryByText("Old junk one")).toBeNull();
    expect(screen.queryByText("Old junk two")).toBeNull();
    // ...but the way in is, and it names the count.
    const expand = screen.getByTestId("board-column-expand-archived");
    expect(expand.textContent).toContain("2");
  });

  it("mounts the cards once expanded", () => {
    const a1 = bead({ id: "p1-arc1", title: "Old junk one", status: "closed", labels: ["archived"] });
    snapshot = { beads: [a1], board: boardWithArchived([a1]), loadedAt: Date.now() };
    render(<BoardView project={project} side="right" />);
    expect(screen.queryByText("Old junk one")).toBeNull();
    fireEvent.click(screen.getByTestId("board-column-expand-archived"));
    expect(screen.getByText("Old junk one")).toBeTruthy();
  });

  it("caps how many cards it mounts even when expanded, and counts the overflow", () => {
    // 60 archived beads, cap 50: expanding must mount at most the cap, never all 60.
    const many = Array.from({ length: 60 }, (_, i) =>
      bead({ id: `p1-arc-${i}`, title: `Archived ${i}`, status: "closed", labels: ["archived"] }),
    );
    snapshot = { beads: many, board: boardWithArchived(many), loadedAt: Date.now() };
    render(<BoardView project={project} side="right" />);
    fireEvent.click(screen.getByTestId("board-column-expand-archived"));
    // The first card mounts; a card past the cap does not.
    expect(screen.getByText("Archived 0")).toBeTruthy();
    expect(screen.queryByText("Archived 59")).toBeNull();
    // The unrendered remainder is a count (60 - 50 = 10), never DOM nodes.
    expect(screen.getByTestId("board-column-overflow-archived").textContent).toContain("10");
  });
});

// ══ TASKS / EPICS — the Plan board's two independent kind toggles (sparkle-xelans.6) ═══════════
//
// WHAT THESE HAVE TO PROVE, and why the obvious test would not. The pure bucketing is already
// covered in `services/epicBoard.test.ts`; what is NOT covered by that, and what actually broke the
// founder's ability to see epics, is the WIRING — that the toggle reaches the store, that the store
// reaches the memo, and that the memo reaches the column render. A test that rendered the board and
// asserted an epic is on it would pass against the code as it was BEFORE any of this existed,
// because epics were always on the board; they were just mixed into the task columns.
//
// So every case below mounts an epic AND a plain task AND the epic's own child in one snapshot, and
// asserts the full row: which column each one landed in, and that the others are absent. Absence
// alone is the trap (AGENTS.md, the "N targets" case) — a card missing from Planning proves nothing
// if nothing was ever going to be there.
describe("BoardView — Tasks / Epics kind toggles", () => {
  /** One snapshot holding all three kinds at once: an epic whose children are all open (so it rolls
   *  up to `planning`), that epic's child, and an unrelated plain task in the same Backlog pile. */
  function seedEpicSnapshot() {
    const beads: Bead[] = [
      // NOT "The epic": a trailing bare word `epic` is now scrubbed from the DISPLAYED title
      // (epicDisplayTitle), and these tests locate cards BY their rendered text. The title is
      // incidental here — what is under test is bucketing by epic-ness, which comes from having a
      // child, not from the name. The scrub itself is pinned in services/beads.epicTitle.test.ts.
      bead({ id: "p1-epic", title: "Parent rollup" }),
      bead({ id: "p1-epic.1", title: "Epic child", parent: "p1-epic" }),
      bead({ id: "p1-task", title: "Plain task" }),
    ];
    snapshot = { beads, board: bucketBeads(beads), loadedAt: Date.now() };
  }

  /** The CARD TITLE node bearing this text, ignoring the "Part of Epic: <name>" back-link that a
   *  child card now also carries. Without this scoping a bare `getByText` matches twice and throws
   *  "Found multiple elements" — the queries below are about which column a CARD sits in, and the
   *  back-link is not a card. `scope` narrows to one board in the two-sided test. */
  const titleNode = (title: string, scope?: HTMLElement): HTMLElement | null =>
    (scope ? within(scope) : screen)
      .queryAllByText(title)
      .find((n) => n.closest('[data-testid="part-of-epic"]') === null) ?? null;

  const columnOf = (title: string): string | null => {
    const card = titleNode(title);
    return card ? (card.closest("[data-board-column]")?.getAttribute("data-board-column") ?? null) : null;
  };

  const ALL_KINDS = { left: { tasks: true, epics: true }, right: { tasks: true, epics: true } };

  beforeEach(() => {
    seedEpicSnapshot();
    useUiStore.setState({ planKindsBySide: { ...ALL_KINDS } });
  });
  afterEach(() => {
    useUiStore.setState({ planKindsBySide: { ...ALL_KINDS } });
  });

  it("defaults to BOTH KINDS ON — the board is exactly what it was before these controls existed", () => {
    const { container } = render(<BoardView project={project} side="right" />);
    expect(screen.getByTestId("board-plan-kind-tasks").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("board-plan-kind-epics").getAttribute("aria-pressed")).toBe("true");
    // All three visible, all in the task columns, and NO Planning column anywhere.
    expect(columnOf("Parent rollup")).toBe("backlog");
    expect(columnOf("Epic child")).toBe("backlog");
    expect(columnOf("Plain task")).toBe("backlog");
    expect(container.querySelector('[data-board-column="planning"]')).toBeNull();
  });

  // ── EPICS RISE TO THE TOP OF THEIR COLUMN WHEN BOTH KINDS ARE ON ────────────────────────────
  // The founder: "I don't see any epics in it when I have tasks turned on. I do see epics when it's
  // only epics." Both halves of that were true and neither was a filter bug — the epic WAS on the
  // board, bucketed by its own status into Backlog among the tasks, and on a real store that pile
  // is thousands long.
  //
  // WHICH COLUMN is asserted alongside the order deliberately: an implementation that fixed
  // findability by re-bucketing epics into their own column would satisfy an order-only assertion
  // while making one bead sit in different columns depending on a toggle. Backlog is still Backlog.
  it("puts epics ABOVE the tasks in the same column, without re-bucketing them", () => {
    // Seeded so the epic is NOT already first: `bucketBeads` preserves input order, so a fixture
    // with the epic written first would pass against no implementation at all.
    const beads: Bead[] = [
      bead({ id: "p1-task", title: "Plain task" }),
      bead({ id: "p1-epic", title: "Parent rollup" }),
      bead({ id: "p1-epic.1", title: "Epic child" }),
      bead({ id: "p1-task2", title: "Second task" }),
    ];
    snapshot = { beads, board: bucketBeads(beads), loadedAt: Date.now() };

    const { container } = render(<BoardView project={project} side="right" />);

    const backlog = container.querySelector('[data-board-column="backlog"]')!;
    const epic = titleNode("Parent rollup", backlog as HTMLElement)!;
    const task = titleNode("Plain task", backlog as HTMLElement)!;
    expect(epic).toBeTruthy();
    expect(task).toBeTruthy();
    // Still Backlog for both — the epic did not move columns.
    expect(columnOf("Parent rollup")).toBe("backlog");
    expect(columnOf("Plain task")).toBe("backlog");
    // FALSE before this change, where input order put "Plain task" first.
    expect(epic.compareDocumentPosition(task) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("leaves a column's order alone when it holds no epics", () => {
    // The other half: a stable split must not reshuffle a pile it has nothing to lift. Without this
    // an implementation that sorted unconditionally would pass the test above and churn every
    // task-only column on every render.
    const beads: Bead[] = [
      bead({ id: "t1", title: "First task" }),
      bead({ id: "t2", title: "Second task" }),
      bead({ id: "t3", title: "Third task" }),
    ];
    snapshot = { beads, board: bucketBeads(beads), loadedAt: Date.now() };

    const { container } = render(<BoardView project={project} side="right" />);
    const backlog = container.querySelector('[data-board-column="backlog"]')! as HTMLElement;
    const first = titleNode("First task", backlog)!;
    const third = titleNode("Third task", backlog)!;
    expect(first.compareDocumentPosition(third) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // ══ THERE IS NO "BOTH" ═══════════════════════════════════════════════════════════════════════
  // The founder's actual instruction, and the one thing a rename of the old control would leave
  // untouched — so it is asserted directly rather than inferred from the two toggles existing.
  // Both halves matter: the control is GONE (no third button, no element bearing its label), and
  // the group holds exactly two toggles, so a "Both" reintroduced under any name also fails.
  it("offers exactly two toggles and NO Both control", () => {
    render(<BoardView project={project} side="right" />);
    const group = screen.getByTestId("board-plan-kinds");
    expect(within(group).queryByText(/^both$/i)).toBeNull();
    expect(screen.queryByTestId("board-epic-view-both")).toBeNull();
    const toggles = within(group).getAllByRole("button");
    // The marker is an <svg>, so it contributes no textContent — this reads the labels alone. It is
    // deliberately NOT stripping characters any more: an earlier cut used `✓`/`○` glyphs and had to
    // strip them here, which quietly coupled "is there a Both button" to the marker's appearance.
    expect(toggles.map((b) => b.textContent)).toEqual(["Tasks", "Epics"]);
  });

  // ══ SELECTED AND UNSELECTED MUST LOOK DIFFERENT, PER PILL ════════════════════════════════════
  // The founder asked for "either selected or unselected" — a state you can read off the control
  // itself, not inferred from which sibling is highlighted. A filled-vs-empty pill ALONE is the
  // language of a segmented control (one of N wins), which is the wrong reading now that both can
  // be on at once, so each pill carries its own marker.
  //
  // THE ASSERTION NEEDS ONE OF EACH ON SCREEN AT THE SAME TIME. Reading only the selected pill
  // would pass against a control that renders the same mark unconditionally — absence has to be
  // observed on a mounted sibling, not on a state the test never rendered. So: turn one off, then
  // read BOTH.
  it("marks each pill selected or unselected on its own, with one of each mounted", () => {
    render(<BoardView project={project} side="right" />);
    const marker = (kind: "tasks" | "epics") =>
      screen.getByTestId(`board-plan-kind-${kind}-marker`);

    // Both on: both marked selected.
    expect(marker("tasks").getAttribute("data-mark")).toBe("on");
    expect(marker("epics").getAttribute("data-mark")).toBe("on");

    fireEvent.click(screen.getByTestId("board-plan-kind-epics"));

    // One of each, side by side — the shape that can actually fail.
    expect(marker("tasks").getAttribute("data-mark")).toBe("on");
    expect(marker("epics").getAttribute("data-mark")).toBe("off");
    // AN ICON, NOT A CHARACTER — the founder's standing rule, enforced repo-wide by
    // glyphIcons.test.ts, which holds BoardView.tsx at zero on its SWEPT list. Asserting an <svg>
    // in BOTH states is what stops a future edit quietly swapping either one back to a dingbat:
    // `data-mark` alone would still read "off" for a `○`.
    expect(marker("tasks").querySelector("svg")).not.toBeNull();
    expect(marker("epics").querySelector("svg")).not.toBeNull();
    expect(marker("epics").textContent).toBe("");
    // ...and the difference is not carried by the marker alone: the selected pill is filled and
    // the unselected one is not. Asserting they DIFFER (rather than pinning literal colours, which
    // are theme tokens and would make this a palette test) is what survives a re-theme.
    const tasksBg = screen.getByTestId("board-plan-kind-tasks").style.background;
    const epicsBg = screen.getByTestId("board-plan-kind-epics").style.background;
    expect(tasksBg).not.toBe(epicsBg);
    expect(epicsBg).toBe("transparent");

    // The marker is decoration — the accessible state is aria-pressed, and a screen reader must not
    // hear "✓" as part of the name.
    expect(marker("epics").getAttribute("aria-hidden")).toBe("true");
  });

  // The click target must not move when the mark changes. A control whose label jumps sideways on
  // every press reads as broken however correct it is, and the fixed-width spacer that prevents it
  // is invisible in review — so it is pinned here rather than trusted.
  it("keeps the pill geometry identical across the two states", () => {
    render(<BoardView project={project} side="right" />);
    const epics = () => screen.getByTestId("board-plan-kind-epics");
    const on = { border: epics().style.border, padding: epics().style.padding };

    fireEvent.click(epics());

    // Same box: a 1px border in BOTH states (never `none`, which would shrink the box by 2px), and
    // the marker still occupies its slot rather than vanishing.
    expect(epics().style.padding).toBe(on.padding);
    // jsdom does NOT expand the `border` shorthand, so `style.borderWidth` reads empty here even
    // though the property is set — assert the shorthand both states actually carry instead.
    expect(epics().style.border).toContain("1px");
    expect(on.border).toContain("1px");
    // The marker still occupies its slot rather than vanishing: an icon in BOTH states, so the
    // label cannot slide left when the check turns into a ring.
    expect(
      screen.getByTestId("board-plan-kind-epics-marker").querySelector("svg"),
    ).not.toBeNull();
  });

  it("clearing Tasks leaves EPICS only — the epic moves to a PLANNING column and the tasks go", () => {
    const { container } = render(<BoardView project={project} side="right" />);
    fireEvent.click(screen.getByTestId("board-plan-kind-tasks"));

    // The column exists now — it never did with tasks on the board, in any combination.
    expect(container.querySelector('[data-board-column="planning"]')).not.toBeNull();
    expect(screen.getByTestId("lane-label-planning").textContent).toContain("Planning");
    // The epic is IN it, and specifically not left behind in Backlog.
    expect(columnOf("Parent rollup")).toBe("planning");
    // ...and both non-epics are gone from the whole board, not merely from Planning.
    expect(titleNode("Epic child")).toBeNull();
    expect(screen.queryByText("Plain task")).toBeNull();
  });

  it("clearing Epics is the exact complement — the epic goes, its child and the plain task stay", () => {
    const { container } = render(<BoardView project={project} side="right" />);
    fireEvent.click(screen.getByTestId("board-plan-kind-epics"));

    expect(titleNode("Parent rollup")).toBeNull();
    expect(columnOf("Epic child")).toBe("backlog");
    expect(columnOf("Plain task")).toBe("backlog");
    // The ladder is an epics-only column set; keeping tasks keeps the familiar six.
    expect(container.querySelector('[data-board-column="planning"]')).toBeNull();
  });

  // ══ THE TOGGLES ARE INDEPENDENT — the property the old exclusive mode could not have ══════════
  // With a tri-state switch, pressing one button always cleared the other; asserting the board
  // narrowed would pass either way. What has power here is that the UNTOUCHED toggle keeps its
  // state across a press of the other, in both directions — mount both, press one, read both.
  it("toggles each kind INDEPENDENTLY — pressing one never moves the other", () => {
    render(<BoardView project={project} side="right" />);
    const tasks = () => screen.getByTestId("board-plan-kind-tasks");
    const epics = () => screen.getByTestId("board-plan-kind-epics");

    fireEvent.click(epics());
    expect(epics().getAttribute("aria-pressed")).toBe("false");
    expect(tasks().getAttribute("aria-pressed")).toBe("true"); // untouched by the other press

    fireEvent.click(epics()); // and it is a TOGGLE, not a one-way set
    expect(epics().getAttribute("aria-pressed")).toBe("true");
    expect(tasks().getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(tasks());
    expect(tasks().getAttribute("aria-pressed")).toBe("false");
    expect(epics().getAttribute("aria-pressed")).toBe("true");
  });

  // Both off is reachable BY DESIGN (the second click of a two-click gesture must not silently undo
  // the first), so the board owes the user an explanation and a remedy that actually works. The
  // remedy is asserted by FOLLOWING it: press it and the cards come back.
  it("says so when NEITHER kind is shown, and Show both refills the board", () => {
    render(<BoardView project={project} side="right" />);
    fireEvent.click(screen.getByTestId("board-plan-kind-tasks"));
    fireEvent.click(screen.getByTestId("board-plan-kind-epics"));

    // Every card is gone — not just the epic, not just the tasks.
    expect(titleNode("Parent rollup")).toBeNull();
    expect(titleNode("Epic child")).toBeNull();
    expect(screen.queryByText("Plain task")).toBeNull();
    // ...and the board says why rather than reading as a project with no work.
    expect(screen.getByTestId("board-plan-kinds-empty-notice")).toBeTruthy();

    fireEvent.click(screen.getByTestId("board-plan-kinds-show-both"));
    expect(screen.queryByTestId("board-plan-kinds-empty-notice")).toBeNull();
    expect(columnOf("Parent rollup")).toBe("backlog");
    expect(columnOf("Epic child")).toBe("backlog");
    expect(columnOf("Plain task")).toBe("backlog");
  });

  // The affordance that keeps the Epics column from being read-only. An epic sitting in Planning is
  // the most startable thing on the board — a written plan nobody picked up — so the Start controls
  // have to reach it. Gated on `backlog` alone they would not, and nothing else would have said so.
  it("offers the Start controls on a PLANNING epic, not just a Backlog one", () => {
    render(<BoardView project={project} side="right" />);
    // SCOPED TO THE EPIC'S OWN CARD, not counted across the board. A board-wide count used to work
    // because the epic was the only thing that could carry Build It; now every startable card does,
    // so the two views legitimately hold different totals and an equality on them would fail for a
    // reason that has nothing to do with the epic surviving its move.
    const epicBuildIt = () => {
      const card = titleNode("Parent rollup")?.closest(
        "[data-testid=\"board-card-epic\"],[data-testid=\"board-card-task\"]",
      ) as HTMLElement | null;
      return card ? within(card).queryByTestId("board-card-build-it") : null;
    };
    expect(epicBuildIt(), "backlog epic").toBeTruthy();
    fireEvent.click(screen.getByTestId("board-plan-kind-tasks")); // → epics only; it moves to Planning
    expect(columnOf("Parent rollup")).toBe("planning"); // the move actually happened
    expect(epicBuildIt(), "planning epic").toBeTruthy(); // ...and the control came with it
  });

  // ══ BOTH BOARDS MOUNTED AT ONCE — the only shape that can catch this ═══════════════════════
  //
  // The first version of this test asserted only the STORE, which is true by construction of the
  // action and therefore proved nothing about the board. Worse, every other test in this file
  // renders `side="right"`, so the read (`planKindsBySide[side]`) and the write
  // (`togglePlanKind(side, …)`) were only ever exercised with the same literal side — replacing
  // BOTH with a hardcoded "right", i.e. deleting the per-side wiring entirely, left all the tests
  // green. That is exactly the "N targets, only one mounted" trap AGENTS.md names, and roborev
  // 65269 caught it.
  //
  // The assertion with power needs both targets in the tree at once and reads the RENDERED result
  // on each: the clicked board gains a Planning column and loses the tasks, and the other board is
  // still showing all three beads in its six task columns.
  it("keeps the kinds per side — switching one board does not reshape the other", () => {
    const { container } = render(
      <>
        <BoardView project={project} side="left" />
        <BoardView project={project} side="right" />
      </>,
    );
    const boards = container.querySelectorAll("[data-board-side]");
    const left = boards[0] as HTMLElement;
    const right = boards[1] as HTMLElement;
    expect(left.getAttribute("data-board-side")).toBe("left");
    expect(right.getAttribute("data-board-side")).toBe("right");

    // Precondition: both boards start identical, so a difference below is caused by the click.
    expect(left.querySelector('[data-board-column="planning"]')).toBeNull();
    expect(right.querySelector('[data-board-column="planning"]')).toBeNull();

    fireEvent.click(within(right).getByTestId("board-plan-kind-tasks"));

    // The clicked board reshaped...
    expect(right.querySelector('[data-board-column="planning"]')).not.toBeNull();
    expect(within(right).queryByText("Plain task")).toBeNull();
    expect(titleNode("Parent rollup", right)).toBeTruthy();
    // ...and the other one did NOT — still six task columns, still holding all three beads, and its
    // own Tasks toggle still reads pressed.
    expect(within(left).getByTestId("board-plan-kind-tasks").getAttribute("aria-pressed")).toBe("true");
    expect(left.querySelector('[data-board-column="planning"]')).toBeNull();
    expect(within(left).getByText("Plain task")).toBeTruthy();
    expect(titleNode("Parent rollup", left)).toBeTruthy();
    expect(titleNode("Epic child", left)).toBeTruthy();
  });
});

// ── EPIC CARDS READ DIFFERENTLY FROM TASK CARDS, IN BOTH DIRECTIONS ─────────────────────────────
// The founder: "I want epic cards to have a different colored background than regular cards", plus
// a gold EPIC pill, a "Contains N tasks" expander, and — the mirror of the pill — a "Part of Epic"
// link on the child so the relationship is legible from BOTH ends.
//
// EVERY ASSERTION HERE IS ABOUT A DIFFERENCE, not about presence. "The card rendered" and "a title
// is on screen" were already true before this change and would prove nothing; each test below
// contrasts an epic against a task in the SAME render, which is the shape that can actually fail.
describe("BoardView — epic vs task card treatment", () => {
  // One board holding both kinds at once. Mounting BOTH matters: an assertion that something is
  // absent from a card that was never rendered passes for the wrong reason.
  function seedEpicBoard() {
    const epic = bead({ id: "p1-e1", title: "Concierge chat surface (epic)", type: "epic" });
    const kidOpen = bead({ id: "p1-e1.1", title: "Child one", parent: "p1-e1" });
    const kidDoing = bead({
      id: "p1-e1.2",
      title: "Child two",
      parent: "p1-e1",
      status: "in_progress",
    });
    const kidClosed = bead({
      id: "p1-e1.3",
      title: "Child three",
      parent: "p1-e1",
      status: "closed",
    });
    const orphan = bead({ id: "p1-solo", title: "Orphan task" });
    snapshot = {
      beads: [epic, kidOpen, kidDoing, kidClosed, orphan],
      board: {
        backlog: [epic, kidOpen, orphan],
        blocked: [],
        inProgress: [],
        done: [],
        delivered: [],
        archived: [],
      },
      loadedAt: Date.now(),
    };
    return { epic, kidOpen, orphan };
  }

  const epicCard = () => screen.getAllByTestId("board-card-epic")[0]!;

  it("gives an epic card a DIFFERENT background from a task card", () => {
    seedEpicBoard();
    render(<BoardView project={project} side="right" />);
    const epicBg = epicCard().style.background;
    const taskBg = screen.getAllByTestId("board-card-task")[0]!.style.background;
    // The contract is that they DIFFER — pinning the literal would just restate colors.ts.
    expect(epicBg).not.toBe("");
    expect(epicBg).not.toBe(taskBg);
  });

  it("puts the EPIC pill on the epic card and on no task card", () => {
    seedEpicBoard();
    render(<BoardView project={project} side="right" />);
    const pill = within(epicCard()).getByTestId("epic-pill");
    expect(pill.textContent).toBe("EPIC");
    // ── THE PILL'S APPEARANCE, NOT JUST ITS TEXT (roborev 65326) ────────────────────────────────
    // `textContent === "EPIC"` was the only rendered assertion, and it survives deleting the fill,
    // the ink, and the `...TAG` spread — i.e. the whole point of the control. The token PAIR is
    // measured in theme/epicCardContrast.test.ts without ever rendering this component, and the
    // two ratchets that pushed the pill onto `TAG` are `<=` counters over hand-typed literals, so
    // they stay green whether or not this component spreads it. Nothing tied the two together.
    //
    // These four do. The first two are what makes it GOLD rather than inheriting the card's ink;
    // the last two are what makes "built from TAG, not re-derived by eye" a fact a future edit has
    // to keep true instead of a comment — the card button sets `fontFamily: FONT_UI`, so a dropped
    // spread would silently inherit that.
    expect(pill.style.background).toBe(C.epicPillFill);
    expect(pill.style.color).toBe(C.onEpicPillFill);
    expect(pill.style.fontFamily).toBe(TAG.fontFamily);
    expect(pill.style.letterSpacing).toBe(TAG.letterSpacing);
    for (const task of screen.getAllByTestId("board-card-task")) {
      expect(within(task).queryByTestId("epic-pill")).toBeNull();
    }
  });

  it("scrubs a trailing '(epic)' from the DISPLAYED title only", () => {
    const { epic } = seedEpicBoard();
    render(<BoardView project={project} side="right" />);
    expect(within(epicCard()).getByText("Concierge chat surface")).toBeTruthy();
    expect(screen.queryByText("Concierge chat surface (epic)")).toBeNull();
    // The STORED title is untouched — the founder ruled a bulk bd rewrite out explicitly.
    expect(epic.title).toBe("Concierge chat surface (epic)");
  });

  it("counts only OPEN children in 'Contains N tasks'", () => {
    seedEpicBoard();
    render(<BoardView project={project} side="right" />);
    // Three children exist; one is closed. A total-children count would read 3 and is what this
    // rules out.
    expect(within(epicCard()).getByTestId("epic-contains-tasks").textContent).toContain(
      "Contains 2 tasks",
    );
  });

  it("is COLLAPSED by default and expands in place on click", () => {
    seedEpicBoard();
    render(<BoardView project={project} side="right" />);
    const card = epicCard();
    // Collapsed: the child rows are not in the tree at all.
    expect(within(card).queryAllByTestId("epic-child-row")).toHaveLength(0);
    expect(
      within(card).getByTestId("epic-contains-tasks").getAttribute("aria-expanded"),
    ).toBe("false");
    fireEvent.click(within(card).getByTestId("epic-contains-tasks"));
    expect(within(epicCard()).queryAllByTestId("epic-child-row").length).toBeGreaterThan(0);
    // ...and collapses again, so the toggle is a toggle and not a one-way door.
    fireEvent.click(within(epicCard()).getByTestId("epic-contains-tasks"));
    expect(within(epicCard()).queryAllByTestId("epic-child-row")).toHaveLength(0);
  });

  it("says so plainly for an epic with no children, with no expander", () => {
    const childless = bead({ id: "p1-e9", title: "Fresh plan", type: "epic" });
    snapshot = {
      beads: [childless],
      board: {
        backlog: [childless],
        blocked: [],
        inProgress: [],
        done: [],
        delivered: [],
        archived: [],
      },
      loadedAt: Date.now(),
    };
    render(<BoardView project={project} side="right" />);
    expect(screen.getByText("Contains no tasks yet")).toBeTruthy();
    expect(screen.queryByTestId("epic-contains-tasks")).toBeNull();
  });

  it("opens the CHILD's own card when an expanded child row is clicked", () => {
    seedEpicBoard();
    render(<BoardView project={project} side="right" />);
    fireEvent.click(within(epicCard()).getByTestId("epic-contains-tasks"));
    const rows = within(epicCard()).getAllByTestId("epic-child-row");
    // "Child two" is in_progress and is NOT rendered as a board card in this fixture, so finding it
    // in a dialog can only be the overlay the click opened.
    const row = rows.find((r) => r.textContent?.includes("Child two"))!;
    fireEvent.click(row);
    expect(within(screen.getByRole("dialog")).getByText("Child two")).toBeTruthy();
  });

  it("shows the parent epic's NAME on a child card, and nothing on an orphan", () => {
    seedEpicBoard();
    render(<BoardView project={project} side="right" />);
    const cards = screen.getAllByTestId("board-card-task");
    const child = cards.find((c) => c.textContent?.includes("Child one"))!;
    const orphan = cards.find((c) => c.textContent?.includes("Orphan task"))!;
    const link = within(child).getByTestId("part-of-epic");
    // The NAME, scrubbed — "a raw id like sparkle-131ms tells him nothing at a glance".
    expect(link.textContent).toContain("Part of Epic:");
    expect(link.textContent).toContain("Concierge chat surface");
    expect(link.textContent).not.toContain("p1-e1");
    // Orphans are normal, not an error state, and must not be visually shamed.
    expect(within(orphan).queryByTestId("part-of-epic")).toBeNull();
  });

  it("opens the EPIC's card when the parent link is clicked", () => {
    seedEpicBoard();
    render(<BoardView project={project} side="right" />);
    const child = screen
      .getAllByTestId("board-card-task")
      .find((c) => c.textContent?.includes("Child one"))!;
    fireEvent.click(within(child).getByTestId("part-of-epic"));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("p1-e1")).toBeTruthy();
  });
});

// ── THE BEAD CARD'S CHAT BUTTON, AND THE WINDOW THAT MUST NOT HAVE IT ────────────────────────────
//
// bead sparkle-1cpomd. `onBeadChat` is optional on BoardView, and its ABSENCE is the entire
// mechanism that hides the Chat button in the satellite window — which mounts no `ConciergeHost`
// and no composer anywhere in its tree, so a draft handed to `composeHandoffStore` there would land
// in a store with NO READER and be dropped silently (ConciergeHost logs log.error on exactly that).
//
// ══ WHY BOTH BOARDS ARE MOUNTED IN ONE TREE ═══════════════════════════════════════════════════
// AGENTS.md's rule for a rule that picks one of N targets: absence in a component that is not in
// the tree proves NOTHING — it is absent because there is no element to paint, and it stays absent
// when the switch is keyed to the wrong thing entirely. So both configurations render side by side
// in the same document, both cards are OPENED, and the assertions are made against each container:
// the main-window one PAINTS the button, the satellite one does not. One direction alone is half
// the evidence.
//
// The satellite's real call site is pinned separately, in satellite/SatelliteApp.test.tsx — this
// file can only prove what a BoardView configured that way renders, not that SatelliteApp
// configures it that way.
describe("BoardView — the bead card's Chat button follows onBeadChat, nothing else", () => {
  function chatSnapshot() {
    snapshot = {
      beads: [],
      board: {
        backlog: [bead({ id: "p1-x1", title: "Detailed task", priority: 2 })],
        blocked: [],
        inProgress: [],
        done: [],
        delivered: [],
        archived: [],
      },
      loadedAt: Date.now(),
    };
  }

  /** Both windows' boards, in one document, each with its detail overlay OPEN. */
  function mountBothWindows(onBeadChat: (b: Bead) => void) {
    chatSnapshot();
    render(
      <>
        {/* Exactly how Workspace.tsx calls it: there is a composer behind this board. */}
        <div data-testid="main-window-tree">
          <BoardView project={project} side="right" onBeadChat={onBeadChat} />
        </div>
        {/* Exactly how satellite/SatelliteApp.tsx calls it: no composer in this tree. */}
        <div data-testid="satellite-tree">
          <BoardView project={project} side="left" />
        </div>
      </>,
    );
    const main = screen.getByTestId("main-window-tree");
    const satellite = screen.getByTestId("satellite-tree");
    // Open the card in BOTH, so each container really does hold a rendered bead card.
    fireEvent.click(within(main).getByText("Detailed task"));
    fireEvent.click(within(satellite).getByText("Detailed task"));
    // Self-verifying, for the reason the project seed above is: if either overlay failed to open,
    // the absence assertion below would pass against an empty container — vacuously.
    expect(within(main).getByTestId("board-bead-card")).toBeTruthy();
    expect(within(satellite).getByTestId("board-bead-card")).toBeTruthy();
    return { main, satellite };
  }

  it("paints the button in the window WITH a composer and not in the one without — both mounted", () => {
    const { main, satellite } = mountBothWindows(vi.fn());
    expect(within(main).getByTestId("board-bead-card-chat")).toBeTruthy();
    expect(within(satellite).queryByTestId("board-bead-card-chat")).toBeNull();
    // …while every other control the card offers is present on BOTH, which is what makes the line
    // above a statement about THIS button rather than about a satellite card that renders nothing.
    expect(within(satellite).getByTestId("board-bead-card-title")).toBeTruthy();
    expect(within(satellite).getByTestId("board-bead-card-close")).toBeTruthy();
  });

  it("clicking it writes the RE: draft for THAT bead into the compose handoff", () => {
    useComposeHandoffStore.setState({ handoff: null });
    const onBeadChat = vi.fn((b: Bead) => {
      useComposeHandoffStore.getState().set({
        origin: "bead-chat",
        projectId: project.id,
        text: beadChatDraft(b),
        attachments: [],
        route: "sparkle",
      });
    });
    const { main } = mountBothWindows(onBeadChat);
    fireEvent.click(within(main).getByTestId("board-bead-card-chat"));
    // THE BEAD IS BOUND AT THE CALL SITE. A handler that ignored its argument — or that closed over
    // the wrong bead — would still fire, so the assertion is on WHICH bead came through.
    expect(onBeadChat).toHaveBeenCalledTimes(1);
    expect(onBeadChat.mock.calls[0]![0]!.id).toBe("p1-x1");
    const h = useComposeHandoffStore.getState().take();
    expect(h?.text).toBe("RE: @Detailed task ");
    expect(h?.route).toBe("sparkle");
    expect(h?.origin).toBe("bead-chat");
  });

  it("does not close the card — the reference is started, the card stays readable", () => {
    const { main } = mountBothWindows(vi.fn());
    fireEvent.click(within(main).getByTestId("board-bead-card-chat"));
    expect(within(main).getByTestId("board-bead-card")).toBeTruthy();
  });
});

// ══ CARD ORDER — THE FOUNDER'S "I'M NOT SEEING EPICS" (bead sparkle-hhb5re) ═══════════════════
//
// THE BOARD HAD NO COMPARATOR AT ALL BEFORE THIS. `bucketBeads` pushes each bead into a column in
// INPUT ORDER and `Column` renders `beads.slice(0, cap)` verbatim; `beadsStore` states it outright
// ("bucketBeads preserves input order within each column and the board RENDERS that order"). The
// P0-first board the founder sees is `bd`'s own default output leaking through — measured over a
// 7,779-row store, priorities are non-decreasing with zero inversions, while WITHIN a band the
// order is arbitrary. So there was nothing in this repo that went red if bd changed its mind.
//
// EVERY FIXTURE BELOW IS FED IN DELIBERATELY SCRAMBLED ORDER for that reason. A suite that handed
// the board a pre-sorted column would go green against a board that does no sorting whatsoever —
// the assertion would have been true before the change, which is the vacuous shape AGENTS.md names
// as this fleet's number-one finding.
describe("BoardView — column order", () => {
  // Both epic ENCODINGS the shared resolver accepts, in one fixture:
  //   `p1-e0` is a STRUCTURAL epic (`p1-kid` names it as parent), typed `task`.
  //   `p1-e1` / `p1-e2` are TYPED epics with no children at all.
  // Mixing them is the point. `Card` paints the orange EPIC pill through `isEpicIndexed`, so a
  // sort that understood only one encoding would promote a strict SUBSET of the chipped cards and
  // leave the rest sorting like tasks — a card that visually says EPIC and sorts like a task,
  // which is worse than the interleaving this bead is about.
  const cards = [
    bead({ id: "p1-e0", title: "Structural epic", priority: 0, updatedAt: "2026-01-01T00:00:00Z" }),
    bead({ id: "p1-e1", title: "Typed epic one", priority: 1, type: "epic", updatedAt: "2026-02-01T00:00:00Z" }),
    bead({ id: "p1-e2", title: "Typed epic two", priority: 2, type: "epic", updatedAt: "2026-03-01T00:00:00Z" }),
    bead({ id: "p1-t0", title: "Task zero", priority: 0, updatedAt: "2026-04-01T00:00:00Z" }),
    bead({ id: "p1-t1", title: "Task one", priority: 1, updatedAt: "2026-05-01T00:00:00Z" }),
    bead({ id: "p1-t2", title: "Task two", priority: 2, updatedAt: "2026-06-01T00:00:00Z" }),
    bead({ id: "p1-kid", title: "Child task", priority: 3, parent: "p1-e0", updatedAt: "2026-07-01T00:00:00Z" }),
  ];
  /** NOT in priority order, and not in epic-then-task order either — and note the P1 PAIR arrives
   *  task-BEFORE-epic (`p1-t1` at index 1, `p1-e1` last). That is deliberate: the priority-filter
   *  test below narrows to exactly that pair, and with the two in the other order it would assert
   *  an order the board already had, going green against a board that does no sorting at all. */
  const SCRAMBLED = ["p1-t2", "p1-t1", "p1-t0", "p1-e2", "p1-kid", "p1-e0", "p1-e1"];
  const scrambled = () => SCRAMBLED.map((id) => cards.find((c) => c.id === id)!);

  /** The same seven cards in EVERY column, each column's copy independently scrambled. Status is
   *  irrelevant here — the columns are seeded directly rather than through `columnFor`, which is
   *  what lets one fixture assert "each column" without inventing five different bead states. */
  function orderBoard(): Board {
    return {
      backlog: scrambled(),
      blocked: scrambled(),
      inProgress: scrambled(),
      done: scrambled(),
      delivered: scrambled(),
      archived: [],
    };
  }

  /** The five columns the founder named. Archived is excluded because it renders COLLAPSED by
   *  default — it mounts no cards, so asserting an order in it would assert on an empty list. */
  const COLUMNS = ["backlog", "blocked", "inProgress", "done", "delivered"] as const;

  /** One column's cards, top to bottom, as `{ id, epic }` — `epic` read from the ORANGE PILL the
   *  founder actually looks at, not from the card's own testid. */
  function column(key: string): { id: string; epic: boolean }[] {
    const col = document.querySelector(`[data-board-column="${key}"]`);
    if (!col) throw new Error(`no column ${key} on screen`);
    return Array.from(col.querySelectorAll('[data-testid^="board-card-"]')).map((el) => {
      const id = cards.find((c) => el.textContent?.includes(c.id))?.id;
      if (!id) throw new Error("a rendered card matched no fixture id");
      return { id, epic: el.querySelector('[data-testid="epic-pill"]') !== null };
    });
  }

  const ids = (key: string) => column(key).map((c) => c.id);

  beforeEach(() => {
    // `beads` is the UNFILTERED store the epic index is built from, and it must be seeded: with
    // the harness default of `[]` nothing points at `p1-e0`, so the structural epic silently
    // resolves as a task and half this fixture stops testing what it names.
    snapshot = { beads: cards, board: orderBoard(), loadedAt: Date.now() };
    useUiStore.getState().setBoardFilter("right", NO_BOARD_FILTER);
  });

  afterEach(() => {
    useUiStore.getState().setBoardFilter("right", NO_BOARD_FILTER);
  });

  // ── THE DEFAULT ORDER, IN EVERY COLUMN ──────────────────────────────────────────────────────
  // The founder, verbatim: "we should have p zero epics show first and then all the p zero tasks
  // and then p one epics would show below that. Each column, and then all the p one tasks,
  // etcetera. So epics basically show at the beginning of the priority list."
  it("interleaves P0 epic, P0 task, P1 epic, P1 task … in every column", () => {
    render(<BoardView project={project} side="right" />);
    for (const key of COLUMNS) {
      expect(ids(key)).toEqual([
        "p1-e0", // P0 epic
        "p1-t0", // P0 task
        "p1-e1", // P1 epic
        "p1-t1", // P1 task
        "p1-e2", // P2 epic
        "p1-t2", // P2 task
        "p1-kid", // P3 task
      ]);
    }
  });

  // ── THE PILL AND THE SORT MUST NAME THE SAME SET ────────────────────────────────────────────
  // The failure this guards is the one the bead calls worse than today's behaviour: a card that
  // renders the orange EPIC pill and sorts like a task. Asserted POSITIONALLY under the Type sort
  // — every pilled card must be in the LEADING RUN — so it cannot pass by both facts happening to
  // be read off the same variable: a sort that understood only `type === "epic"` would leave the
  // structural epic `p1-e0` pilled but stranded below the tasks.
  it("promotes exactly the cards that show the orange EPIC pill (Type sort)", () => {
    useUiStore.getState().setBoardFilter("right", { ...NO_BOARD_FILTER, sortBy: "type" });
    render(<BoardView project={project} side="right" />);
    for (const key of COLUMNS) {
      const col = column(key);
      const pilled = col.filter((c) => c.epic).map((c) => c.id);
      const leading = col.slice(0, pilled.length).map((c) => c.id);
      expect(pilled.length).toBe(3); // both encodings resolved, not just the typed pair
      expect(leading).toEqual(pilled);
      // And the leading run really is every epic, in priority order.
      expect(pilled).toEqual(["p1-e0", "p1-e1", "p1-e2"]);
    }
  });

  it("puts a P0 TASK above a P2 EPIC by default, and the other way round under Type", () => {
    render(<BoardView project={project} side="right" />);
    const dflt = ids("backlog");
    expect(dflt.indexOf("p1-t0")).toBeLessThan(dflt.indexOf("p1-e2"));

    cleanup();
    useUiStore.getState().setBoardFilter("right", { ...NO_BOARD_FILTER, sortBy: "type" });
    render(<BoardView project={project} side="right" />);
    const byType = ids("backlog");
    expect(byType.indexOf("p1-e2")).toBeLessThan(byType.indexOf("p1-t0"));
  });

  it("orders by date, newest and oldest, following the Created/Updated field", () => {
    useUiStore.getState().setBoardFilter("right", { ...NO_BOARD_FILTER, sortBy: "newest" });
    render(<BoardView project={project} side="right" />);
    expect(ids("backlog")).toEqual(["p1-kid", "p1-t2", "p1-t1", "p1-t0", "p1-e2", "p1-e1", "p1-e0"]);

    cleanup();
    useUiStore.getState().setBoardFilter("right", { ...NO_BOARD_FILTER, sortBy: "oldest" });
    render(<BoardView project={project} side="right" />);
    expect(ids("backlog")).toEqual(["p1-e0", "p1-e1", "p1-e2", "p1-t0", "p1-t1", "p1-t2", "p1-kid"]);
  });

  // ── THE ORDER SURVIVES THE FILTER CHIPS ─────────────────────────────────────────────────────
  // The Priority and Date controls NARROW the board; they must re-sort what survives rather than
  // dissolving the order. Asserted with a filter that removes cards from the middle of the
  // sequence, so an implementation that sorted BEFORE filtering and an implementation that never
  // sorted at all are both distinguishable from a correct one.
  it("keeps the order under an active Priority filter", () => {
    useUiStore.getState().setBoardFilter("right", { ...NO_BOARD_FILTER, priority: 1 });
    render(<BoardView project={project} side="right" />);
    // Only the P1 pair survives, epic first.
    expect(ids("backlog")).toEqual(["p1-e1", "p1-t1"]);
  });

  it("keeps the order under an active Date-window filter", () => {
    // `now` sits inside the fixture's own span so the window cuts it in half: a 30-day window
    // ending 2026-03-15 drops `p1-e0` (Jan 1) and `p1-e1` (Feb 1) and keeps everything from Mar 1
    // on. What survives is a MIX — one epic and four tasks — which is what makes this assert
    // ordering rather than mere survival.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T00:00:00Z"));
    try {
      useUiStore
        .getState()
        .setBoardFilter("right", { ...NO_BOARD_FILTER, dateWindow: "30d", dateField: "updated" });
      render(<BoardView project={project} side="right" />);
      expect(ids("backlog")).toEqual([
        "p1-t0", // P0 task  — the two P0/P1 epics were filtered out …
        "p1-t1", // P1 task
        "p1-e2", // P2 EPIC  — … and the surviving one still sorts above its band's task,
        "p1-t2", // P2 task  —     which is the property the filter must not dissolve.
        "p1-kid", // P3 task
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  // ── THE LIVE GESTURE: THE SORT CHANGES WHILE THE BOARD IS MOUNTED ───────────────────────────
  // Every case above seeds the sort BEFORE the first render, which tests the ordering but NOT the
  // transition. The user's actual gesture is picking a sort on a board that is already on screen,
  // and that is a SEAM: `BoardFilterBar` writes the store, `BoardView` reads it. Both halves were
  // green while the seam was broken — `setBoardFilter`'s hand-written no-op guard did not compare
  // `sortBy`, so the write was discarded and the control was completely inert with nothing failing
  // anywhere. This drives the store the way the chip does and asserts the CARDS MOVED.
  it("re-sorts a board that is already on screen when the sort changes", () => {
    render(<BoardView project={project} side="right" />);
    const before = ids("backlog");
    expect(before).toEqual(["p1-e0", "p1-t0", "p1-e1", "p1-t1", "p1-e2", "p1-t2", "p1-kid"]);

    // Exactly what the chip's `onPick` does — no remount, no re-seed.
    act(() => {
      useUiStore.getState().setBoardFilter("right", { ...NO_BOARD_FILTER, sortBy: "type" });
    });

    const after = ids("backlog");
    // Asserted as an inequality FIRST: a board that ignored the change entirely would still satisfy
    // a bare `toEqual` against whichever order happened to be right.
    expect(after).not.toEqual(before);
    expect(after).toEqual(["p1-e0", "p1-e1", "p1-e2", "p1-t0", "p1-t1", "p1-t2", "p1-kid"]);

    // …and BACK, so this cannot pass for a board that reorders once and then latches.
    act(() => {
      useUiStore.getState().setBoardFilter("right", { ...NO_BOARD_FILTER, sortBy: "priority" });
    });
    expect(ids("backlog")).toEqual(before);
  });

  // ── BOTH MODES ──────────────────────────────────────────────────────────────────────────────
  // Epics-only swaps the whole column set for the seven-stage ladder via `bucketEpics`, which does
  // its own filtering and also does not sort. One comparator has to serve both, so the mode that
  // is NOT the default is asserted directly rather than assumed.
  it("orders the Epics-only ladder too", () => {
    useUiStore.setState({
      planKindsBySide: {
        left: { tasks: true, epics: true },
        right: { tasks: false, epics: true },
      },
    } as never);
    // SEEDED REVERSED, on purpose. `bucketEpics` routes an epic that HAS children to the ladder's
    // Planning stage, so the ladder's Backlog holds only the two childless typed epics — and in
    // the shared fixture they already arrive P1-then-P2. Asserting that order would be vacuous:
    // it is the input order. Handing the column P2-then-P1 is what makes a green here mean the
    // comparator ran on this mode's path too.
    snapshot = {
      beads: cards,
      board: { ...orderBoard(), backlog: [cards[2]!, cards[1]!, cards[0]!] },
      loadedAt: Date.now(),
    };
    try {
      useUiStore.getState().setBoardFilter("right", { ...NO_BOARD_FILTER, sortBy: "type" });
      render(<BoardView project={project} side="right" />);
      expect(ids("backlog")).toEqual(["p1-e1", "p1-e2"]);
      // The structural epic is not lost — it is in Planning, which is the ladder column the task
      // board has no bucket for and the one a `Board`-shaped loop would silently skip.
      expect(ids("planning")).toEqual(["p1-e0"]);
    } finally {
      useUiStore.setState({
        planKindsBySide: {
          left: { tasks: true, epics: true },
          right: { tasks: true, epics: true },
        },
      } as never);
    }
  });
});

// ══ THE STATUS CHIP SAYS THE STAGE THE CARD IS SITTING IN (bead sparkle-az6di8) ═══════════════
//
// The founder, verbatim: *"I want them to have the actual status. So instead of saying open, it
// should say something like 'Being Built'."* The chip used to print bd's wire status, which can
// only ever be one of three words and puts backlog, blocked and planned-but-unstarted all under
// `open` — a card reading `open` beneath a header reading `Being built` contradicts the thing next
// to it.
//
// ── WHY THESE ROWS DRIVE THE BOARD RATHER THAN CALLING `stageLabel` ──────────────────────────
// The label is threaded from the bucketing that PLACED the card (`placedIn`), and a unit test of
// the label function alone would pass with that thread cut — the fallback re-derives a column from
// the bead and produces the same word for the ordinary cases. So every row below opens a real
// card on a real board, and the two that matter (blocked, and the epic ladder's Planning) are
// chosen because THE FALLBACK CANNOT PRODUCE THEM: blockedness is a dependency fact no bead
// carries, and Planning is a roll-up of an epic's children. If `placedIn` stops being passed,
// those two go red while the rest stay green.
describe("BoardView — the bead card's status chip is the board stage, not the wire status", () => {
  const meta = () => screen.getByTestId("board-bead-card-meta").textContent ?? "";

  /** The CARD bearing this title, ignoring the "Part of Epic: <name>" back-link a child card also
   *  carries — a bare `getByText` matches both and throws. Same scoping the plan-kinds describe
   *  above uses, and it is needed here for exactly one row (the epic on the task board, where its
   *  child is visible beside it). */
  const openCard = (title: string) => {
    const node = screen
      .queryAllByText(title)
      .find((n) => n.closest('[data-testid="part-of-epic"]') === null);
    if (node === undefined) throw new Error(`no card titled ${title}`);
    fireEvent.click(node);
  };

  it("says 'Being built' — not 'open', not 'in progress' — for a card in that column", () => {
    render(<BoardView project={project} side="right" />);
    fireEvent.click(screen.getByText("Doing now")); // the sole inProgress card
    // THE FOUNDER'S OWN PHRASE, and byte-for-byte the column header above it.
    expect(meta()).toContain("Being built");
    expect(meta()).not.toContain("in progress");
    expect(meta()).not.toContain("in_progress");
    expect(meta()).not.toContain("open");
  });

  it("says 'Backlog' for an open card in Backlog", () => {
    render(<BoardView project={project} side="right" />);
    fireEvent.click(screen.getByText("Backlog two"));
    expect(meta()).toContain("Backlog");
    expect(meta()).not.toContain("open");
  });

  it("says 'Done' for a closed card, and 'Shipped' for a delivered one", () => {
    render(<BoardView project={project} side="right" />);
    fireEvent.click(screen.getByText("Finished"));
    expect(meta()).toContain("Done");
    expect(meta()).not.toContain("closed");
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByText("Delivered task"));
    expect(meta()).toContain("Shipped");
    expect(meta()).not.toContain("closed");
  });

  // ── THE ROW THE FALLBACK CANNOT PASS ────────────────────────────────────────────────────────
  // This bead's own `status` is plain `open` and it carries no label saying otherwise — bd's answer
  // to "is it blocked" is a DEPENDENCY, which `columnFor` can only see when handed the blocked set
  // the board was bucketed with. So a chip that re-derived from the bead would read "Backlog" here.
  // Reading the placement back off the board is what makes it read "Blocked", and it is what makes
  // the chip agree with the header the reader just clicked through.
  it("says 'Blocked' for a bead the BOARD placed in Blocked, though its own status is open", () => {
    const blocked = bead({ id: "p1-z1", title: "Waiting on a dep" });
    snapshot = {
      beads: [],
      board: { ...board, backlog: [], blocked: [blocked] },
      loadedAt: Date.now(),
    };
    render(<BoardView project={project} side="right" />);
    fireEvent.click(screen.getByText("Waiting on a dep"));
    expect(meta()).toContain("Blocked");
    expect(meta()).not.toContain("Backlog");
    expect(meta()).not.toContain("open");
  });

  // ── THE OTHER ROW THE FALLBACK CANNOT PASS: THE CHIP FOLLOWS THE MODE ───────────────────────
  // The rule is "whatever bucketing placed this card", NOT "always columnFor". In Epics-only mode
  // the seven-rung ladder places the card, and an open epic whose children are all open is placed
  // in PLANNING by the child roll-up — a fact about its children that nothing on the epic bead
  // itself records. The same epic in the default (task) view sits in Backlog and correctly says so,
  // which is why both halves are asserted: one alone would pass for a chip wired to either rule.
  it("mirrors the EPIC LADDER's rung in Epics-only mode — 'Planning', not 'Backlog'", () => {
    const beads: Bead[] = [
      bead({ id: "p1-epic", title: "Parent rollup" }),
      bead({ id: "p1-epic.1", title: "Epic child", parent: "p1-epic" }),
    ];
    snapshot = { beads, board: bucketBeads(beads), loadedAt: Date.now() };
    useUiStore.setState({
      planKindsBySide: { left: { tasks: true, epics: true }, right: { tasks: false, epics: true } },
    });
    render(<BoardView project={project} side="right" />);
    fireEvent.click(screen.getByText("Parent rollup"));
    expect(meta()).toContain("Planning");
    expect(meta()).not.toContain("Backlog");
    expect(meta()).not.toContain("open");
    useUiStore.setState({
      planKindsBySide: { left: { tasks: true, epics: true }, right: { tasks: true, epics: true } },
    });
  });

  it("says 'Backlog' for that SAME epic on the task board — the chip follows the mode", () => {
    const beads: Bead[] = [
      bead({ id: "p1-epic", title: "Parent rollup" }),
      bead({ id: "p1-epic.1", title: "Epic child", parent: "p1-epic" }),
    ];
    snapshot = { beads, board: bucketBeads(beads), loadedAt: Date.now() };
    useUiStore.setState({
      planKindsBySide: { left: { tasks: true, epics: true }, right: { tasks: true, epics: true } },
    });
    render(<BoardView project={project} side="right" />);
    openCard("Parent rollup");
    expect(meta()).toContain("Backlog");
    expect(meta()).not.toContain("Planning");
  });

  // ── ONE VOCABULARY, BOTH BOARDS (the second defect this change closes) ──────────────────────
  // The epic ladder used to label this column "Building" while the task board labelled it "Being
  // built" — the same column, two names, so a reader who toggled Epics watched a stage rename
  // itself. Both headers now read from `epicBoard.STAGE_LABELS`. Asserted by RENDERING both modes
  // and comparing what is on screen, rather than by comparing two constants: the constants are the
  // implementation, and a third hand-written list could reintroduce the drift without touching them.
  it("names the in-progress column identically on the task board and the epic ladder", () => {
    const beads: Bead[] = [
      bead({ id: "p1-epic", title: "Parent rollup" }),
      bead({ id: "p1-epic.1", title: "Epic child", parent: "p1-epic" }),
    ];
    snapshot = { beads, board: bucketBeads(beads), loadedAt: Date.now() };

    useUiStore.setState({
      planKindsBySide: { left: { tasks: true, epics: true }, right: { tasks: true, epics: true } },
    });
    const tasks = render(<BoardView project={project} side="right" />);
    const taskBoardLabel = screen.getByTestId("lane-label-inProgress").textContent ?? "";
    tasks.unmount();

    useUiStore.setState({
      planKindsBySide: { left: { tasks: true, epics: true }, right: { tasks: false, epics: true } },
    });
    render(<BoardView project={project} side="right" />);
    const ladderLabel = screen.getByTestId("lane-label-inProgress").textContent ?? "";

    expect(ladderLabel).toContain("Being built");
    expect(ladderLabel).not.toContain("Building");
    // The identity itself — the thing that was false before this change.
    expect(ladderLabel).toBe(taskBoardLabel);
    useUiStore.setState({
      planKindsBySide: { left: { tasks: true, epics: true }, right: { tasks: true, epics: true } },
    });
  });
});
