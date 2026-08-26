// @vitest-environment jsdom
//
// DRAGGING AN EPIC BETWEEN STAGES, ON THE FOUNDER'S ACTUAL SCREEN (bead `sparkle-7bumdz`).
//
// The founder, verbatim: *"for any epics, I should be able to drag them in the epic column. Into
// different stages."*
//
// ══ WHAT THIS FILE GUARDS THAT `epicDrop.test.ts` CANNOT ══════════════════════════════════════
// That file pins the RULE — what a drop onto each rung writes, and where the card then lands. What
// it cannot see is whether this column ASKS. Every one of its cases would stay green against a
// column with no drag handlers at all, exactly as `epicBoard.test.ts` stays green against a column
// that never passes a staffing predicate. So this file drives the real DOM: a real `dragStart` on a
// real row, a real `drop` on a real rung, through the column's own no-argument call into
// `applyEpicDrop` — which is also the only thing covering that module's `DEFAULT_DEPS` wiring.
//
// ══ AND WHY EVERY CASE ASSERTS THE MOVE, NOT THE CALL ═════════════════════════════════════════
// "assert `claimBead` was called" is the precondition, not the side effect — it passes against a
// column that writes correctly and renders the card in the wrong rung forever. So the moving cases
// re-seed the store with the state the write produces (which is what the refresh does in
// production) and assert the row is now under the TARGET rung and GONE from its old one, with a
// second epic mounted throughout that must not move.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));

/** The shape the column hands `applyEpicDrop`. Declared here rather than imported so this file
 *  asserts the CONTRACT the column is expected to honour, not whatever the module happens to take
 *  today — a widened parameter there should red this file, not slip through it. */
interface ApplyArgs {
  projectId: string;
  rootPath: string;
  epicId: string;
  prdPath: string | null;
  plan: { writes: { kind: string }[]; landsOn: string };
}

const applyEpicDrop = vi.fn<(a: ApplyArgs) => Promise<void>>(async () => {});
vi.mock("../services/applyEpicDrop", () => ({
  applyEpicDrop: (a: ApplyArgs) => applyEpicDrop(a),
}));

import { EpicsColumn } from "./EpicsColumn";
import { useBeadsStore } from "../stores/beadsStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useUiStore } from "../stores/uiStore";
import { bucketBeads, type Bead, type BeadStatus } from "../services/beads";
import type { AgentTab, Project } from "../types";

function epic(id: string, status: BeadStatus, labels: string[] = []): Bead {
  return {
    id,
    title: id,
    description: "",
    status,
    labels,
    parent: null,
    commentCount: 0,
    type: "epic",
  };
}

function projectWith(agents: AgentTab[] = []): Project {
  return { id: "p1", name: "Alpha", rootPath: "/tmp/alpha", agents } as unknown as Project;
}

function seed(beads: Bead[]) {
  useBeadsStore.setState((prev) => ({
    ...prev,
    byProject: {
      ...(prev as { byProject: Record<string, unknown> }).byProject,
      p1: { beads, board: bucketBeads(beads), loadedAt: 0 },
    },
    error: {},
  }) as never);
}

/** The epic ids under one rung — read from THAT rung's container, so "gone from the old one" is a
 *  real observation about that rung rather than about the document. */
function rungIds(key: string): string[] {
  return within(screen.getByTestId(`epics-stage-${key}`))
    .queryAllByTestId("epic-row")
    .map((r) => r.getAttribute("data-epic-id") ?? "");
}

function rowFor(id: string): HTMLElement {
  const row = screen
    .queryAllByTestId("epic-row")
    .find((r) => r.getAttribute("data-epic-id") === id);
  if (!row) throw new Error(`no row for ${id}`);
  return row;
}

/** jsdom builds no `DataTransfer`, so the handlers' `e.dataTransfer` reads would throw. This is the
 *  smallest stand-in that records what the column set — `dropEffect` IS the refusal signal, so it
 *  has to be observable rather than swallowed. */
function dt() {
  return { dropEffect: "uninitialized", effectAllowed: "all", setData: vi.fn(), getData: vi.fn() };
}

/** The whole gesture: pick `id` up, drag it over `rung`, let go. Returns the transfer so a caller
 *  can read back the `dropEffect` the column asked for. */
function dragTo(id: string, rung: string) {
  const transfer = dt();
  fireEvent.dragStart(rowFor(id), { dataTransfer: transfer });
  const stage = screen.getByTestId(`epics-stage-${rung}`);
  fireEvent.dragOver(stage, { dataTransfer: transfer });
  fireEvent.drop(stage, { dataTransfer: transfer });
  return transfer;
}

/** What the column asked for on its FIRST drop — and a loud failure rather than a confusing
 *  `undefined` dereference when it never asked at all. */
function droppedWith(): ApplyArgs {
  const call = applyEpicDrop.mock.calls[0];
  if (!call) throw new Error("applyEpicDrop was never called — the column wrote nothing");
  return call[0];
}

beforeEach(() => {
  applyEpicDrop.mockClear();
  applyEpicDrop.mockResolvedValue(undefined);
  useBeadsStore.setState({ startPolling: () => {}, stopPolling: () => {} } as never);
  useSettingsStore.setState({ beadsEnabled: true } as never);
  useUiStore.setState({ epicFocusBySide: { left: null, right: null } } as never);
  useRuntimeStore.setState({
    status: {},
    openAgentIds: [],
    lastObserved: {},
    branchStatus: {},
    workflowStage: {},
    observedAttention: {},
  } as never);
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("EpicsColumn — dragging an epic into a different stage", () => {
  // THE AFFORDANCE. It did not exist at all before this change: the column had no `draggable`
  // anywhere, which is the founder's actual complaint.
  it("makes every epic row draggable", () => {
    seed([epic("ep-a", "in_progress"), epic("ep-b", "open")]);
    render(<EpicsColumn project={projectWith()} side="right" />);
    for (const id of ["ep-a", "ep-b"]) {
      expect(rowFor(id).getAttribute("draggable")).toBe("true");
      expect(rowFor(id).getAttribute("aria-roledescription")).toBe("draggable epic card");
    }
  });

  // ══ THE HEADLINE: THE EPIC ACTUALLY MOVES, AND THE WRITE PERSISTS ═══════════════════════════
  it("moves an epic out of its old rung and into the one it was dropped on", () => {
    const { rerender } = render(<EpicsColumn project={projectWith()} side="right" />);
    seed([epic("ep-drag", "in_progress"), epic("ep-stay", "in_progress")]);
    rerender(<EpicsColumn project={projectWith()} side="right" />);

    // Where it starts. `ep-stay` is mounted throughout and must NOT move — without it this would
    // pass against a column that empties the rung, or that moves everything at once.
    expect(rungIds("unstaffed")).toEqual(["ep-drag", "ep-stay"]);
    expect(rungIds("backlog")).toEqual([]);

    dragTo("ep-drag", "backlog");

    // THE WRITE. Unclaiming is what Backlog means for an `in_progress` epic.
    expect(applyEpicDrop).toHaveBeenCalledTimes(1);
    const call = droppedWith();
    expect(call.epicId).toBe("ep-drag");
    expect(call.rootPath).toBe("/tmp/alpha");
    expect(call.projectId).toBe("p1");
    expect(call.plan.writes.map((w) => w.kind)).toEqual(["unclaim"]);
    expect(call.plan.landsOn).toBe("backlog");

    // THE MOVE ITSELF — the store now holds what that write produces, which is what the refresh
    // delivers in production. The card must be under Backlog and GONE from where it was.
    seed([epic("ep-drag", "open"), epic("ep-stay", "in_progress")]);
    rerender(<EpicsColumn project={projectWith()} side="right" />);
    expect(rungIds("backlog")).toEqual(["ep-drag"]);
    expect(rungIds("unstaffed")).toEqual(["ep-stay"]);
  });

  // THE P1 FIX, end to end. `spawn_build_agent` has no epic parameter and never binds, which is why
  // the column reads as zero active builds; a drop on Build: Active must go through `sendToBuild`.
  it("binds an orchestrator when an epic is dropped on Build: Active", () => {
    seed([epic("ep-a", "open")]);
    render(<EpicsColumn project={projectWith()} side="right" />);
    dragTo("ep-a", "inProgress");

    expect(droppedWith().plan.writes.map((w) => w.kind)).toEqual(["claim", "send-to-build"]);
  });

  // ...and the rung beside it must NOT spawn anything. This is the pair that makes either
  // assertion meaningful: one test alone passes for a column that always spawns, or never does.
  it("does NOT start an agent when the same epic is dropped on Build: Unstaffed", () => {
    seed([epic("ep-a", "open")]);
    render(<EpicsColumn project={projectWith()} side="right" />);
    dragTo("ep-a", "unstaffed");

    const kinds = droppedWith().plan.writes.map((w) => w.kind);
    expect(kinds).toEqual(["claim"]);
    expect(kinds).not.toContain("send-to-build");
  });

  it("carries the epic's PRD path through to the drop", () => {
    const withPrd: Bead = { ...epic("ep-a", "open"), description: "PRD file: PRD/thing.md" };
    seed([withPrd]);
    render(<EpicsColumn project={projectWith()} side="right" />);
    dragTo("ep-a", "inProgress");
    expect(droppedWith().prdPath).toBe("PRD/thing.md");
  });
});

describe("EpicsColumn — refusals happen DURING the drag", () => {
  // A refusal the user only discovers by letting go is indistinguishable from a broken control.
  // `dropEffect: "none"` is what paints the platform's own "no entry" cursor mid-gesture.
  it("refuses a drop on Planning and writes nothing", () => {
    seed([epic("ep-a", "in_progress")]);
    render(<EpicsColumn project={projectWith()} side="right" />);

    // Stepped rather than using the `dragTo` helper, because the verdict has to be observed WHILE
    // the drag is live: the drop itself ends the gesture, and at rest no rung carries a verdict at
    // all (the case below pins that). Asserting after the drop would be asserting about a column
    // that is no longer being dragged over.
    const transfer = dt();
    fireEvent.dragStart(rowFor("ep-a"), { dataTransfer: transfer });
    const stage = screen.getByTestId("epics-stage-planning");
    fireEvent.dragOver(stage, { dataTransfer: transfer });

    expect(stage.getAttribute("data-drop")).toBe("refuse");
    // The platform's own "no entry" cursor, mid-gesture.
    expect(transfer.dropEffect).toBe("none");

    // ══ THE REASON HAS TO APPEAR BEFORE THE DROP, BECAUSE THE DROP NEVER ARRIVES ══════════════
    // Per HTML5 DnD an element receives `drop` only if it cancelled `dragover` — and the refusing
    // path deliberately does not, which is what paints the "no entry" cursor. So a reason produced
    // in the drop handler is unreachable in a real browser; jsdom dispatches `drop` unconditionally
    // and would have reported that dead path as covered. Asserting here, mid-gesture and BEFORE any
    // drop is fired, is what makes this test a statement about the shipped path.
    expect(screen.getByTestId("epics-stage-refusal-planning").textContent).toMatch(/Planning/i);

    fireEvent.drop(stage, { dataTransfer: transfer });
    expect(applyEpicDrop).not.toHaveBeenCalled();
  });

  it("refuses a drop onto the rung the epic already sits in", () => {
    seed([epic("ep-a", "in_progress")]);
    render(<EpicsColumn project={projectWith()} side="right" />);

    // Stepped, and asserted BEFORE the drop, for the reason spelled out in the case above: a
    // refusing rung never receives `drop` outside jsdom.
    const transfer = dt();
    fireEvent.dragStart(rowFor("ep-a"), { dataTransfer: transfer });
    const stage = screen.getByTestId("epics-stage-unstaffed");
    fireEvent.dragOver(stage, { dataTransfer: transfer });

    expect(transfer.dropEffect).toBe("none");
    expect(screen.getByTestId("epics-stage-refusal-unstaffed").textContent).toMatch(/already/i);
    expect(applyEpicDrop).not.toHaveBeenCalled();
  });

  // AND THE STAFFING DROP IS NOT REFUSED. An epic already `in_progress` with no live agent sits in
  // Build: Unstaffed; dragging it onto Build: Active writes nothing to the bead, so the card does
  // not visibly travel — but it DOES bind an orchestrator, and refusing it was the defect that made
  // this column unable to do the one thing it was built for.
  it("accepts the staffing drop even though the card does not move", () => {
    seed([epic("ep-a", "in_progress")]);
    render(<EpicsColumn project={projectWith()} side="right" />);

    const transfer = dt();
    fireEvent.dragStart(rowFor("ep-a"), { dataTransfer: transfer });
    const stage = screen.getByTestId("epics-stage-inProgress");
    fireEvent.dragOver(stage, { dataTransfer: transfer });

    expect(stage.getAttribute("data-drop")).toBe("accept");
    expect(screen.queryByTestId("epics-stage-refusal-inProgress")).toBeNull();

    fireEvent.drop(stage, { dataTransfer: transfer });
    expect(droppedWith().plan.writes.map((w) => w.kind)).toEqual(["send-to-build"]);
  });

  it("accepts on the rungs it can write, in the same render", () => {
    seed([epic("ep-a", "in_progress")]);
    render(<EpicsColumn project={projectWith()} side="right" />);
    fireEvent.dragStart(rowFor("ep-a"), { dataTransfer: dt() });

    // The two verdicts side by side — a column that marked everything "accept" (or everything
    // "refuse") would fail one half of this.
    expect(screen.getByTestId("epics-stage-backlog").getAttribute("data-drop")).toBe("accept");
    expect(screen.getByTestId("epics-stage-planning").getAttribute("data-drop")).toBe("refuse");
    expect(screen.getByTestId("epics-stage-unstaffed").getAttribute("data-drop")).toBe("refuse");
  });

  // AT REST THE COLUMN IS EXACTLY WHAT IT WAS. No landing spots, no verdicts, nothing to explain —
  // the affordance appears only while a gesture is live.
  it("marks no rung at all when nothing is being dragged", () => {
    seed([epic("ep-a", "in_progress")]);
    render(<EpicsColumn project={projectWith()} side="right" />);
    for (const key of ["backlog", "planning", "unstaffed", "done"]) {
      expect(screen.getByTestId(`epics-stage-${key}`).getAttribute("data-drop")).toBeNull();
    }
  });

  // An abandoned drag (ESC, or a drop on the window chrome) must not leave every rung lit up as a
  // live landing spot for the rest of the session.
  it("clears the drag when the gesture ends without a drop", () => {
    seed([epic("ep-a", "in_progress")]);
    render(<EpicsColumn project={projectWith()} side="right" />);

    fireEvent.dragStart(rowFor("ep-a"), { dataTransfer: dt() });
    expect(screen.getByTestId("epics-stage-backlog").getAttribute("data-drop")).toBe("accept");

    fireEvent.dragEnd(rowFor("ep-a"), { dataTransfer: dt() });
    expect(screen.getByTestId("epics-stage-backlog").getAttribute("data-drop")).toBeNull();
    expect(applyEpicDrop).not.toHaveBeenCalled();
  });

  it("surfaces a failed write instead of reporting a move that did not happen", async () => {
    applyEpicDrop.mockRejectedValue(new Error("bd timed out"));
    seed([epic("ep-a", "in_progress")]);
    render(<EpicsColumn project={projectWith()} side="right" />);

    dragTo("ep-a", "backlog");

    const note = await screen.findByTestId("epics-stage-refusal-backlog");
    expect(note.textContent).toContain("bd timed out");
  });
});
