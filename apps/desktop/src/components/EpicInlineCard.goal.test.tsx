// @vitest-environment jsdom
//
// THE PRODUCTION SEAM for the epic card's goal field — `EpicInlineCard`, the connected wrapper the
// Epics column actually mounts.
//
// ══ WHY THIS FILE HAS TO EXIST ═════════════════════════════════════════════════════════════════
// `EpicCardGoal.test.tsx` drives the card with an INJECTED `onSetGoal`, which leaves the lines that
// SUPPLY it covered by nothing — the defaulted-seam trap AGENTS.md names (bead `sparkle-lgbwf`,
// seen 4×). Delete the `goal={...}` / `onSetGoal={...}` pair from `EpicInlineCard` and that suite
// stays green while the field silently stops rendering, because it is gated on
// `onSetGoal !== undefined`. This file makes that deletion red.
//
// It also pins the two gates that are easy to get backwards, and pins them by MOUNTING BOTH
// CANDIDATES rather than asserting absence on a card that was never rendered: a task card and an
// epic card, and a writable card and a read-only one. Absence in a component that is not in the
// tree proves nothing (AGENTS.md's fourth vacuous-test shape).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// The Tauri boundary is the only thing stubbed. `beadPriority` and the rest of the card run for
// real — a narrower mock of them would be mocking the very wiring this file exists to exercise.
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));

const { EpicInlineCard } = await import("./EpicInlineCard");
const { useProjectStore } = await import("../stores/projectStore");
type Bead = import("../services/beads").Bead;

const PROJECT = "p1";
const ROOT = "/repo";
const EPIC_ID = "sparkle-huw924";

function beadOf(id: string, over: Partial<Bead> = {}): Bead {
  return { id, title: id, description: "", status: "open", labels: [], type: "epic", ...over };
}

const EPIC = beadOf(EPIC_ID);

function seed() {
  useProjectStore.setState({
    projects: [
      {
        id: PROJECT,
        name: "repo",
        rootPath: ROOT,
        defaultBranch: null,
        createdAt: new Date(0).toISOString(),
        selectedAgentId: null,
        agents: [],
      },
    ],
  } as never);
}

const storedGoal = () =>
  useProjectStore.getState().projects.find((p) => p.id === PROJECT)?.epicGoals?.[EPIC_ID];

beforeEach(() => {
  vi.clearAllMocks();
  seed();
});
afterEach(cleanup);

function mount(over: Partial<Parameters<typeof EpicInlineCard>[0]> = {}) {
  return render(
    <EpicInlineCard
      bead={EPIC}
      projectId={PROJECT}
      rootPath={ROOT}
      allBeads={[EPIC]}
      {...over}
    />,
  );
}

const FIELD = "epics-bead-card-goal";

describe("EpicInlineCard — the goal wiring, not the rendering", () => {
  it("WRITES THE STORE, which is the only thing that makes the field real", async () => {
    mount();

    const field = await waitFor(() => screen.getByTestId(FIELD));
    fireEvent.change(field, { target: { value: "Ship the reviewer with nobody watching it" } });
    fireEvent.keyDown(field, { key: "Enter" });

    // THE SIDE EFFECT IS THE STORE RECORD, not the field's own value — the goal is a live input to
    // dispatch (`workerSpawn.ladderGoalFor`, `sendToBuild.epicGoalLadder`), so what matters is that
    // the thing those read actually changed.
    await waitFor(() => {
      expect(storedGoal()?.text).toBe("Ship the reviewer with nobody watching it");
    });
    // Stamped as HUMAN authority, which is what latches it against the auto-generator.
    expect(storedGoal()?.source).toBe("human");
  });

  it("READS the store, so an existing goal is not silently blank on open", async () => {
    useProjectStore
      .getState()
      .setEpicGoal(PROJECT, EPIC_ID, "A goal written before this card was opened", "human");

    mount();

    const field = (await waitFor(() => screen.getByTestId(FIELD))) as HTMLTextAreaElement;
    expect(field.value).toBe("A goal written before this card was opened");
  });

  it("draws the field on an UNTYPED bead that HAS CHILDREN — structure beats the type label", async () => {
    // THE BEHAVIOURAL CONTENT OF SWITCHING TO `isEpic`. The gate used to be a raw type-field test,
    // which denies the goal to every epic nobody remembered to type `epic` — and `isEpic` is
    // deliberately `isTypedEpic(bead) || has children`, structure first, because a parent edge is a
    // fact another bead asserted while the type field is a label someone did or did not set. Such a
    // bead renders in the Epics column already, so the raw test produced a card the column calls an
    // epic with no goal field on it.
    //
    // ALL THREE MOUNTED AT ONCE, for the reason the case below states: absence on a card rendered
    // alone proves nothing about the gate.
    const parent = beadOf("sparkle-untyped", { type: "task" });
    const child = beadOf("sparkle-untyped.1", { type: "task", parent: "sparkle-untyped" });
    const lone = beadOf("sparkle-lone", { type: "task" });

    const { container: parentBox } = render(
      <EpicInlineCard
        bead={parent}
        projectId={PROJECT}
        rootPath={ROOT}
        allBeads={[parent, child]}
      />,
    );
    const { container: loneBox } = render(
      <EpicInlineCard
        bead={lone}
        projectId={PROJECT}
        rootPath={ROOT}
        allBeads={[lone]}
      />,
    );

    await waitFor(() => {
      expect(parentBox.querySelector(`[data-testid="${FIELD}"]`)).not.toBeNull();
    });
    // The childless task beside it still has no field, so this is the CHILDREN doing the work
    // rather than the gate having been opened for everything.
    expect(loneBox.querySelector(`[data-testid="${FIELD}"]`)).toBeNull();
  });

  it("draws the field on an EPIC and not on a task — both mounted at once", async () => {
    const task = beadOf("sparkle-task1", { type: "task" });
    const { container: epicBox } = render(
      <EpicInlineCard
        bead={EPIC}
        projectId={PROJECT}
        rootPath={ROOT}
        allBeads={[EPIC]}
      />,
    );
    const { container: taskBox } = render(
      <EpicInlineCard
        bead={task}
        projectId={PROJECT}
        rootPath={ROOT}
        allBeads={[task]}
      />,
    );

    // BOTH IN THE TREE. Asserting absence on a task card rendered alone would pass for a gate keyed
    // to entirely the wrong thing — or to nothing at all.
    await waitFor(() => {
      expect(epicBox.querySelector(`[data-testid="${FIELD}"]`)).not.toBeNull();
    });
    expect(taskBox.querySelector(`[data-testid="${FIELD}"]`)).toBeNull();
  });

  it("withholds the field when there is no project path to write through", async () => {
    // The same `rootPath` gate every other control on this card takes: a read-only surface shows no
    // field rather than one whose save can only fail. Paired with the writable case above, so
    // "absent" is attributable to the gate rather than to the card never rendering.
    const { container: writable } = render(
      <EpicInlineCard
        bead={EPIC}
        projectId={PROJECT}
        rootPath={ROOT}
        allBeads={[EPIC]}
      />,
    );
    const { container: readOnly } = render(
      <EpicInlineCard
        bead={EPIC}
        projectId={PROJECT}
        rootPath={null}
        allBeads={[EPIC]}
      />,
    );

    await waitFor(() => {
      expect(writable.querySelector(`[data-testid="${FIELD}"]`)).not.toBeNull();
    });
    expect(readOnly.querySelector(`[data-testid="${FIELD}"]`)).toBeNull();
  });
});
