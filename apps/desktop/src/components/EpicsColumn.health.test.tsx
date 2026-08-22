// @vitest-environment jsdom
//
// THE SQUARE HEALTH ICON ON AN EPIC ROW (bead `sparkle-l06ax7`).
//
// The founder: *"I also would like to have status icons for the epics where they are green, amber,
// or red, just like the build agents. They should be square instead of circle ... The epics should
// be tied to the corresponding build agents and the statuses should be showing next to the epic
// row."*
//
// ══ WHY EVERY CASE MOUNTS ALL FOUR EPICS AT ONCE ═══════════════════════════════════════════════
// Same trap `EpicsColumn.priorityChiclet.test.tsx` names, and it is sharper here because the states
// are a small enum: "render a red epic, assert the square is red" passes against a square hard-wired
// to red, against a square reading the WRONG epic's agents, and against a rollup that ignores its
// input. So the fixture below stands one epic of each state side by side and every assertion is
// that the four rendered squares DISAGREE in the specific way the rule says they should.
//
// It also means the fourth state is tested where it actually matters: `ep-none` has no agent while
// three siblings do, so a rule that defaulted an unknown epic to green (or to gray) reddens here
// rather than passing on an empty column where everything is unstaffed anyway.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));

import { EpicsColumn } from "./EpicsColumn";
import { useBeadsStore } from "../stores/beadsStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useUiStore } from "../stores/uiStore";
import { bucketBeads, type Bead } from "../services/beads";
import type { AgentTab, AgentTabStatus, Project } from "../types";

function epic(id: string, over: Partial<Bead> = {}): Bead {
  return { id, title: id, status: "open", labels: [], type: "epic", ...over } as Bead;
}

/** A build orchestrator bound to `epicId` — the edge `services/epicLadder` reads. */
function build(id: string, epicId: string): AgentTab {
  return { id, name: id, kind: "build", parentId: null, epicId } as unknown as AgentTab;
}

/** THE FIXTURE: four epics, one per state, and the agents that put them there. */
const EPICS = [epic("ep-red"), epic("ep-amber"), epic("ep-green"), epic("ep-none")];
const AGENTS = [
  build("a-red", "ep-red"),
  build("a-amber", "ep-amber"),
  build("a-green", "ep-green"),
  // ep-none deliberately has NONE.
];
const STATUS: Record<string, AgentTabStatus> = {
  "a-red": "waiting", // an on-screen prompt — `needs_you`
  "a-amber": "questions",
  "a-green": "working",
};

function projectWith(agents: AgentTab[]): Project {
  return { id: "p1", name: "Alpha", rootPath: "/tmp/alpha", agents } as unknown as Project;
}

function seed(beads: Bead[]) {
  useBeadsStore.setState((prev) => ({
    ...prev,
    byProject: {
      ...(prev as { byProject: Record<string, unknown> }).byProject,
      p1: { beads, board: bucketBeads(beads), polledAt: 0 },
    },
    error: {},
  }) as never);
}

function row(id: string): HTMLElement {
  const hit = screen
    .queryAllByTestId("epic-row")
    .find((r) => r.getAttribute("data-epic-id") === id);
  if (!hit) throw new Error(`no epic row for ${id}`);
  return hit;
}

/** The square inside one epic's row, or null when that row renders none. */
function square(id: string): HTMLElement | null {
  return row(id).querySelector<HTMLElement>('[data-testid="epic-health"]');
}

function healthOf(id: string): string {
  const el = square(id);
  if (!el) throw new Error(`no health square in the row for ${id}`);
  return el.getAttribute("data-health") ?? "";
}

beforeEach(() => {
  useBeadsStore.setState({ startPolling: () => {}, stopPolling: () => {} } as never);
  useSettingsStore.setState({ beadsEnabled: true } as never);
  useUiStore.setState({ epicFocusBySide: { left: null, right: null } } as never);
  useRuntimeStore.setState({
    status: { ...STATUS },
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

describe("EpicsColumn — the epic row's health square", () => {
  it("paints all four states differently in one column", () => {
    seed(EPICS);
    render(<EpicsColumn project={projectWith(AGENTS)} side="right" />);

    expect(healthOf("ep-red")).toBe("red");
    expect(healthOf("ep-amber")).toBe("amber");
    expect(healthOf("ep-green")).toBe("green");
    // THE STATE THE FOUNDER DID NOT NAME. Not green — "there are build agents that are working" is
    // false of it — and not gray, which this app reserves for finished work.
    expect(healthOf("ep-none")).toBe("unstaffed");

    // Four rows, four distinct verdicts: nothing here can be a constant.
    expect(new Set(EPICS.map((e) => healthOf(e.id))).size).toBe(4);
  });

  it("renders the mark as a SQUARE, which is how an epic row is told from an agent row", () => {
    // The founder said it twice in one sentence ("square instead of circle"), and a `borderRadius`
    // that crept up to the 999 capsule or to a disc would silently undo the distinction while every
    // colour assertion above stayed green.
    seed(EPICS);
    render(<EpicsColumn project={projectWith(AGENTS)} side="right" />);
    for (const e of EPICS) {
      const el = square(e.id);
      expect(el).not.toBeNull();
      const radius = el!.style.borderRadius;
      // HARD CORNERS, and the EMPTY STRING MUST FAIL. `el.style.borderRadius` is `""` when the
      // component declares no inline radius at all — and jsdom loads no stylesheet
      // (docs/jsdom-test-caveats.md), so a square that delegated its shape to a CSS class and was
      // rendered as a `border-radius: 50%` DISC would read `""` here. A `parseFloat(radius) || 0`
      // fallback turned that case from the one failure this assertion had into a pass, which is
      // precisely the distinction the test exists to defend. So: a declaration is required first.
      expect(radius).not.toBe("");
      expect(Number.parseFloat(radius)).toBeLessThanOrEqual(2);
      expect(radius.endsWith("%")).toBe(false);
      expect(el!.style.width).toBe(el!.style.height);
    }
  });

  it("draws the unstaffed square HOLLOW and the other three FILLED", () => {
    // The one visual difference that is doing semantic work: an empty box reads as "nobody is in
    // here". Asserted on the rendered style rather than on a class name, because there is no
    // stylesheet in jsdom to resolve a class against (docs/jsdom-test-caveats.md).
    seed(EPICS);
    render(<EpicsColumn project={projectWith(AGENTS)} side="right" />);
    const none = square("ep-none")!;
    expect(none.style.background).toBe("transparent");
    expect(none.style.border).not.toBe("none");
    for (const id of ["ep-red", "ep-amber", "ep-green"]) {
      const el = square(id)!;
      expect(el.style.background).not.toBe("transparent");
      expect(el.style.background).not.toBe("");
    }
    // ...and the hollow one is NOT drawn in the green ink, which is the specific lie to guard.
    expect(none.style.border).not.toContain(square("ep-green")!.style.background);
  });

  it("takes the WORST of an epic's agents, not the first or the last", () => {
    // Two agents on one epic, in both orders across two renders. A rule that read `agents[0]` — or
    // that stopped at the first non-calm reading — passes one of these and fails the other.
    seed([epic("ep-mixed")]);
    const green = build("g", "ep-mixed");
    const red = build("r", "ep-mixed");
    useRuntimeStore.setState({ status: { g: "working", r: "waiting" } } as never);

    const first = render(<EpicsColumn project={projectWith([green, red])} side="right" />);
    expect(healthOf("ep-mixed")).toBe("red");
    first.unmount();

    render(<EpicsColumn project={projectWith([red, green])} side="right" />);
    expect(healthOf("ep-mixed")).toBe("red");
  });

  it("goes UNSTAFFED, not green, when the epic's only agent has finished and gone idle", () => {
    // The other half of "just sitting there": the agents exist, and none of them is working. A rule
    // written as "any bound agent → green" passes every case above and fails only this one.
    seed([epic("ep-finished")]);
    useRuntimeStore.setState({ status: { done1: "idle" } } as never);
    render(
      <EpicsColumn project={projectWith([build("done1", "ep-finished")])} side="right" />,
    );
    expect(healthOf("ep-finished")).toBe("unstaffed");
  });

  // ── WHERE THE CROSS-COLUMN GUARD LIVES, AND WHY NOT HERE ────────────────────────────────────
  // Two reviews asked for a case here, unmocked, asserting the epic square agrees with what the
  // build column computes for the same store. FOUR fixtures were written that way — including one a
  // review specified verbatim — and each was run against BOTH call sites. Every one printed `red`
  // either way, so every one would have shipped green while proving nothing.
  //
  // The reason is mechanical and is written out in `hooks/useFinishedHeads.test.tsx`'s header: a
  // head's verdict only demotes the HEAD's published status, and `rollupDot` reads neither that nor
  // anything else the two maps disagree about. So the invariant is guarded in two places instead:
  //
  //   • `hooks/useFinishedHeads.test.tsx` — the two maps really do give different verdicts.
  //   • `hooks/finishedHeadsInputParity.test.ts` — every production caller passes the right one, and
  //     a third caller cannot slip past the list. THIS is the guard on the line that can regress;
  //     without it, reverting the argument left the whole suite green.

  it("renders NO square on a terminal rung, and still renders one beside it", () => {
    // A shipped/done epic is finished, and reporting "nobody is working on this" about finished
    // work is the founder's gray rule inverted. The rung header ("Done") is what tells the reader
    // why there is no mark.
    //
    // ══ THE RUNG HAS TO BE EXPANDED FIRST, AND THE FIRST CUT OF THIS TEST DID NOT ═══════════════
    // `OPEN_BY_DEFAULT` collapses Done/Shipped/Archived, so the closed epic's row is simply not in
    // the DOM at mount. Guarding the assertion with `if (row)` therefore made the ONLY test of
    // `health={epicHealthApplies(key) ? … : null}` dead code: deleting that conditional from
    // EpicsColumn left every test in this file green. So the rung is opened and the row is looked
    // up UNCONDITIONALLY — a fixture that stops landing in Done reds here instead of skipping.
    seed([epic("ep-done", { status: "closed" }), epic("ep-live")]);
    render(<EpicsColumn project={projectWith([])} side="right" />);
    fireEvent.click(screen.getByTestId("epics-stage-toggle-done"));

    const doneRow = row("ep-done");
    expect(doneRow.querySelector('[data-testid="epic-health"]')).toBeNull();
    // The live sibling still carries one, so a blanket "never render a square" cannot pass this.
    expect(healthOf("ep-live")).toBe("unstaffed");
  });
});
