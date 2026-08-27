// @vitest-environment jsdom
//
// ══ ONE PREDICATE, THREE SURFACES, ONE TEST THAT MOUNTS ALL THREE (bead sparkle-e9siq4) ═════════
//
// "Build It" is offered on three surfaces that share no chrome: the board's in-column CARD, the
// board's detail OVERLAY (a dialog), and the concierge's bead PILL (a card in a chat thread). It
// used to be gated twice, by two rules that disagreed and that neither surface could see the other
// of — a COLUMN-shaped gate on the card (`columnKey === "backlog" || "planning"`) and a TYPE-shaped
// gate on the other two. Measured: the intersection withheld the control from ~85% of open beads,
// and the union offered it on work already in progress. The fix put the predicate in the hook that
// already supplies the handler ({@link isStartable} in `useBeadBuildActions`) so all three read one
// value.
//
// ══ WHY THIS FILE EXISTS WHEN EACH SURFACE IS ALREADY COVERED ═══════════════════════════════════
// It is covered THREE TIMES, once per surface, in three files that each mount ONE of them:
// `BoardView.test.tsx` (card + overlay), `BeadCard.test.tsx` (the shared card in isolation),
// `useBeadBuildActions.test.ts` (the hook with no DOM). That is exactly the fourth vacuous shape in
// AGENTS.md — "the rule picks one of N targets, and the test asserts absence on targets never
// MOUNTED". Absence of Build It in a file that never renders the pill proves nothing about the
// pill, and it stays absent if the pill is re-gated on something else entirely. A per-surface suite
// cannot fail on DISAGREEMENT, because disagreement is a property of the three together and no one
// of those files can see two of them at once.
//
// So every row below mounts the CARD, the OVERLAY and the PILL in one tree, against one bead, and
// asserts each surface against `isStartable` — the predicate itself, not a hand-copied boolean. A
// surface that stops reading the shared hook fails here and nowhere else.
//
// The three testid prefixes are what make one tree unambiguous — the chrome spec in `BeadCard.tsx`
// gives the overlay `board-bead-card-*` and the concierge `concierge-bead-card-*`, while the
// in-column card's inline control is `StartControls`' own `board-card-build-it`.
//
// NOTE ON MOUNTING `BeadPill` DIRECTLY: `BeadPill.test.tsx` deliberately renders most of its rows
// through `<Markdown>`/`ConciergeThread`, because that file is guarding the LINKIFY CHAIN and a
// direct mount would keep passing with the chain cut. This file is guarding the BUILD GATE, which
// is downstream of resolution, so the direct mount is the right scope here — it is not an oversight
// to "fix" by routing these rows through markdown.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bead, Board } from "../../services/beads";
import type { Project } from "../../types";
import type { SparkleConfig, EffectiveConfig } from "../../services/config";

// ── The store seam. Both the board and the pill read `byProject`, so one fake snapshot feeds every
//    surface in the tree — which is the point: a divergence here would be the fixture's, not the
//    code's.
let snapshot: { beads: Bead[]; board: Board; loadedAt: number } | undefined;
function buildState() {
  return {
    byProject: { p1: snapshot } as Record<string, typeof snapshot>,
    loading: {} as Record<string, boolean>,
    error: {} as Record<string, string | undefined>,
    startPolling: vi.fn(),
    stopPolling: vi.fn(),
  };
}
vi.mock("../../stores/beadsStore", () => {
  const useBeadsStore = ((selector?: (s: ReturnType<typeof buildState>) => unknown) => {
    const state = buildState();
    return selector ? selector(state) : state;
  }) as unknown as { (sel?: unknown): unknown; getState: () => ReturnType<typeof buildState> };
  useBeadsStore.getState = () => buildState();
  return { useBeadsStore };
});

// `sendToBuildBlockedReason` is the handoff PREFLIGHT. `null` = not blocked. Present because an
// exhaustive factory returns `undefined` for anything it omits, which makes the guard throw.
vi.mock("../../services/sendToBuild", () => ({
  sendToBuild: vi.fn(),
  sendToBuildBlockedReason: () => null,
}));

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
vi.mock("../../services/config", () => ({
  getConfig: async (): Promise<EffectiveConfig> => ({ config: emptyConfig(), warnings: [] }),
  onConfigChanged: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("../../services/deliveryMonitor", () => ({
  startDeliveryMonitor: vi.fn(),
  stopDeliveryMonitor: vi.fn(),
}));
vi.mock("../DefineStageModal", () => ({
  DefineStageModal: () => <div data-testid="define-modal" />,
}));

// Keep the real beads helpers (bucketBeads, the epic index, the label constants) and stub only the
// `bd` WRITE wrappers the controls call, so nothing reaches Tauri.
vi.mock("../../services/beads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/beads")>();
  return {
    ...actual,
    claimBead: vi.fn().mockResolvedValue(undefined),
    labelBead: vi.fn().mockResolvedValue(undefined),
    closeBead: vi.fn().mockResolvedValue(undefined),
    markBeadDelivered: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock("../../services/beadsCommands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/beadsCommands")>();
  return {
    ...actual,
    beadsDetail: vi.fn(async () => ({
      bead: {} as unknown,
      fullDescription: "",
      children: { beads: [], total: 0, omitted: 0, omittedIds: [], limit: 100 },
      dependencies: [],
      dependents: [],
      comments: [] as unknown[],
      linksTruncated: false,
    })),
    beadsComment: vi.fn(async () => undefined),
  };
});

import { BoardView } from "../BoardView";
import { BeadPill, BeadPillProvider, type BeadPillContextValue } from "../Concierge/BeadPill";
import { isStartable } from "./useBeadBuildActions";
import { bucketBeads, epicIndexOf, STALLED_LABEL } from "../../services/beads";
import { useProjectStore } from "../../stores/projectStore";

const project: Project = {
  id: "p1",
  name: "Demo",
  rootPath: "/tmp/demo",
  defaultBranch: "main",
  createdAt: "2026-01-01",
  agents: [],
  selectedAgentId: null,
};

function bead(over: Partial<Bead> & { id: string; title: string }): Bead {
  return {
    description: "",
    status: "open",
    type: "task",
    priority: 2,
    labels: [],
    parent: null,
    commentCount: 0,
    ...over,
  };
}

/** The three surfaces, by the testid each chrome gives its Build It. */
const buildIt = {
  card: () => screen.queryByTestId("board-card-build-it"),
  overlay: () => screen.queryByTestId("board-bead-card-build-it"),
  pill: () => screen.queryByTestId("concierge-bead-card-build-it"),
};

/**
 * Mount the CARD, the OVERLAY and the PILL against one bead, in one tree.
 *
 * The overlay only exists once a card is opened and the pill's card only exists once the pill is
 * expanded, so both are driven here rather than left to each row — a row that forgot one would be
 * asserting absence on an unmounted surface, which is the whole failure this file exists to close.
 */
function mountAllThree(beads: Bead[], subject: Bead, blocked: string[] = []) {
  const blockedSet = new Set(blocked);
  snapshot = { beads, board: bucketBeads(beads, blockedSet), loadedAt: Date.now() };
  useProjectStore.setState({ projects: [project], selectedProjectId: "p1" });

  const ctx: BeadPillContextValue = {
    beads: new Map([
      [subject.id, { bead: subject, projectId: "p1", rootPath: project.rootPath }],
    ]),
    onViewOnBoard: vi.fn(() => true),
  };

  render(
    <>
      <BoardView project={project} side="right" />
      <BeadPillProvider value={ctx}>
        <BeadPill beadId={subject.id} />
      </BeadPillProvider>
    </>,
  );

  // Open the overlay by clicking the board card's BODY BUTTON, addressed through the card's own
  // testid rather than by its title text.
  //
  // NOT `getByText(title)`, which is what `BoardView.test.tsx` uses: those rows seed `board`
  // directly with `beads: []`, and an epic card with real children renders its title alongside the
  // child-count pill, so the accessible text is broken across elements and the match fails. Going
  // through the testid also means this helper is identical for the epic and task shapes, and a
  // MISSING card fails with a sentence that names the bead instead of a text-matcher hint — the
  // difference between "the card is not there" and "the title reads differently", which cost a
  // 15-minute run to tell apart the first time.
  //
  // Done BEFORE the pill is expanded, so only one board card is in the tree.
  const cardEl =
    screen.queryByTestId("board-card-epic") ?? screen.queryByTestId("board-card-task");
  if (cardEl === null) {
    throw new Error(
      `no board card rendered for ${subject.id} (${subject.status}) — it is bucketed into a lane this board does not render`,
    );
  }
  // The card's shell is a div so the Build It button can sit BESIDE the clickable body rather than
  // nested inside it; the body button is therefore the first button in the card, and Build It (when
  // offered at all) is a later sibling.
  fireEvent.click(within(cardEl).getAllByRole("button")[0]!);
  expect(screen.getByTestId("board-bead-card")).toBeTruthy();

  // Expand the pill into its card.
  fireEvent.click(screen.getByTestId("concierge-bead-pill"));
  expect(screen.getByTestId("concierge-bead-card")).toBeTruthy();

  return { blockedSet };
}

/** What the ONE predicate says about this bead — the thing all three surfaces must agree with. */
function predicate(beads: Bead[], subject: Bead, blocked: string[] = []) {
  return isStartable(subject, epicIndexOf(beads), new Set(blocked));
}

afterEach(() => {
  cleanup();
  snapshot = undefined;
});
beforeEach(() => {
  useProjectStore.setState({ projects: [], selectedProjectId: null });
});

describe("Build It — one predicate, three surfaces", () => {
  // ── THE AGREEING CASE ───────────────────────────────────────────────────────────────────────
  // An ordinary open task. All three offer it. Without this row the file could pass by hiding the
  // button everywhere, which is the 85%-withheld bug it is guarding against.
  it("offers Build It on the card, the overlay AND the pill for an open, unblocked bead", () => {
    const b = bead({ id: "sparkle-open1", title: "An open task" });
    mountAllThree([b], b);

    expect(predicate([b], b)).toBe(true);
    expect(buildIt.card()).toBeTruthy();
    expect(buildIt.overlay()).toBeTruthy();
    expect(buildIt.pill()).toBeTruthy();
  });

  // ── THE UNION BUG: THE TYPE GATE SAID YES ON WORK ALREADY RUNNING ───────────────────────────
  // `in_progress` is work already handed to an agent. The old overlay/pill gate asked only about
  // TYPE, so it offered Build It here and a second press handed the same work over twice. The
  // in-column card was accidentally right — not by knowing the rule, but because `inProgress` is
  // not `backlog`. A surface with no column had no way to be right at all.
  it("withholds Build It on all three for a bead already in progress", () => {
    const b = bead({ id: "sparkle-wip1", title: "Already running", status: "in_progress" });
    mountAllThree([b], b);

    expect(predicate([b], b)).toBe(false);
    expect(buildIt.card()).toBeNull();
    expect(buildIt.overlay()).toBeNull();
    expect(buildIt.pill()).toBeNull();
  });

  it("withholds Build It on all three for a closed bead", () => {
    const b = bead({ id: "sparkle-done1", title: "Finished work", status: "closed" });
    mountAllThree([b], b);

    expect(predicate([b], b)).toBe(false);
    expect(buildIt.card()).toBeNull();
    expect(buildIt.overlay()).toBeNull();
    expect(buildIt.pill()).toBeNull();
  });

  // ── THE INTERSECTION BUG, MIRRORED: THE COLUMN GATE SAID YES ────────────────────────────────
  // An epic that is status-`open` but whose every child is CLOSED sits in the BACKLOG column, so a
  // column-shaped gate offers Build It on finished work. `isStartable` refuses it on the roll-up.
  // This is the row a column-shaped rule cannot get right on ANY surface, board card included.
  it("withholds Build It on all three for an open epic whose children are all done", () => {
    const epic = bead({ id: "sparkle-epic1", title: "A finished epic", type: "epic" });
    const child = bead({
      id: "sparkle-epic1.1",
      title: "Its only child",
      status: "closed",
      parent: epic.id,
    });
    const beads = [epic, child];
    mountAllThree(beads, epic);

    expect(predicate(beads, epic)).toBe(false);
    expect(buildIt.card()).toBeNull();
    expect(buildIt.overlay()).toBeNull();
    expect(buildIt.pill()).toBeNull();
  });

  // ── DEPENDENCY-BLOCKED ──────────────────────────────────────────────────────────────────────
  it("withholds Build It on all three for a dependency-blocked bead", () => {
    const b = bead({ id: "sparkle-blk1", title: "Waiting on something" });
    mountAllThree([b], b, [b.id]);

    expect(predicate([b], b, [b.id])).toBe(false);
    expect(buildIt.card()).toBeNull();
    expect(buildIt.overlay()).toBeNull();
    expect(buildIt.pill()).toBeNull();
  });
});

// ══ WHAT THE LOSING CHANNEL COULD SAY, AND THE WINNER CANNOT ════════════════════════════════════
//
// AGENTS.md, "User-facing copy is code": before reconciling two disagreeing rules toward the
// stricter one, ask what the LENIENT side was doing with its leniency and whether the strict side
// can offer any replacement.
//
// Here the answer is NO, and this row pins the gap rather than pretending it closed. The STALLED
// label means the stall sweep spent the bead's restart and gave up; `beads.ts` names being picked
// up again as one of only three ways back, and Build It IS that pickup. `StartControls` therefore
// keeps its early return NARROW (roborev 65607) — when the predicate refuses a stalled bead it
// still renders a click-to-clear `stalled` chip, so the card's channel can say "refused, and here
// is the way out".
//
// The overlay and the pill render the SHARED `BeadCard`, which has no stalled chip at all. So on
// the two column-less surfaces the button simply vanishes with no remedy and no sentence: the
// reader's only routes back are to hunt the card down in the Blocked lane or run `bd label remove`
// at the CLI. The predicate is right to refuse on all three — that half is not in question — but
// the remedy did not travel with it, and this is the assertion that will notice when it does.
describe("Build It — the stalled remedy is NOT at parity, and that is the open gap", () => {
  it("refuses a stalled bead on all three, but only the card offers the way back", () => {
    const b = bead({ id: "sparkle-stall1", title: "Stalled work", labels: [STALLED_LABEL] });
    mountAllThree([b], b);

    // The predicate refuses, and every surface honours it. This half IS at parity.
    expect(predicate([b], b)).toBe(false);
    expect(buildIt.card()).toBeNull();
    expect(buildIt.overlay()).toBeNull();
    expect(buildIt.pill()).toBeNull();

    // The card keeps the remedy the refusal owes the user…
    expect(screen.queryByTestId("board-card-clear-stalled")).toBeTruthy();

    // …and the two column-less surfaces have nowhere to put it. ASSERTED, NOT ASSUMED: both are
    // mounted right now, so this is a statement about surfaces that are really in the tree. When
    // the remedy is given to the shared card, this row fails and should be rewritten to demand it
    // on all three — it is a gap marker, not a rule anybody wants.
    const overlay = screen.getByTestId("board-bead-card");
    const pillCard = screen.getByTestId("concierge-bead-card");
    expect(overlay.querySelector('[data-testid$="-clear-stalled"]')).toBeNull();
    expect(pillCard.querySelector('[data-testid$="-clear-stalled"]')).toBeNull();
  });
});
