// @vitest-environment jsdom
//
// THE SQUARE HEALTH ICON ON AN EPIC ROW (bead `sparkle-l06ax7`).
//
// The founder: *"I also would like to have status icons for the epics where they are green, amber,
// or red, just like the build agents. They should be square instead of circle ... The epics should
// be tied to the corresponding build agents and the statuses should be showing next to the epic
// row."*
//
// AND THE RULE THAT SETTLED WHAT "just like the build agents" MEANS EXACTLY, 2026-08-22: *"For the
// gray I do want it to work exactly like the Build Agent. That's the hard rule. The colors work the
// same between the two and don't let any instruction ever override that."* So the epic square's
// five values ARE `RollupDot`'s five — a questioning agent is BLUE on both surfaces, and an epic
// with nothing active on it is GRAY on both. The per-colour parity property itself is guarded in
// `EpicHealthSquare.test.tsx`; this file guards the wiring that gets a value to the row.
//
// ══ WHY EVERY CASE MOUNTS ALL FOUR EPICS AT ONCE ═══════════════════════════════════════════════
// Same trap `EpicsColumn.priorityChiclet.test.tsx` names, and it is sharper here because the states
// are a small enum: "render a red epic, assert the square is red" passes against a square hard-wired
// to red, against a square reading the WRONG epic's agents, and against a rollup that ignores its
// input. So the fixture below stands one epic of each state side by side and every assertion is
// that the four rendered squares DISAGREE in the specific way the rule says they should.
//
// It also means the no-agent state is tested where it actually matters: `ep-none` has no agent while
// three siblings do, so a rule that defaulted an unknown epic to green reddens here rather than
// passing on an empty column where every epic is agent-less anyway.
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
const EPICS = [epic("ep-red"), epic("ep-blue"), epic("ep-green"), epic("ep-none")];
const AGENTS = [
  build("a-red", "ep-red"),
  build("a-blue", "ep-blue"),
  build("a-green", "ep-green"),
  // ep-none deliberately has NONE.
];
const STATUS: Record<string, AgentTabStatus> = {
  "a-red": "waiting", // an on-screen prompt — `needs_you`
  "a-blue": "questions",
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
    // BLUE, not amber. A questioning agent's own build row is blue, and the founder's hard rule is
    // that the two surfaces use one set of colours.
    expect(healthOf("ep-blue")).toBe("blue");
    expect(healthOf("ep-green")).toBe("green");
    // THE STATE THE FOUNDER DID NOT NAME, and then did: *"Where it's not active right now, however
    // gray currently works, just make it the same."* Not green — "there are build agents that are
    // working" is false of it — and gray is what a build row with nothing happening is painted.
    expect(healthOf("ep-none")).toBe("gray");

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

  it("draws all four squares SOLID and in four different inks", () => {
    // THIS ASSERTION WAS INVERTED ON PURPOSE, 2026-08-22. The no-agent square used to be drawn
    // HOLLOW (transparent fill, amber outline) and this case pinned that. The founder overruled it —
    // *"For the gray I do want it to work exactly like the Build Agent. That's the hard rule."* — so
    // there is no hollow variant left: an epic with nothing active on it is a solid gray square,
    // which is what its agents' own rows would be painted.
    //
    // Asserted on the rendered INLINE style rather than on a class name, because there is no
    // stylesheet in jsdom to resolve a class against (docs/jsdom-test-caveats.md).
    seed(EPICS);
    render(<EpicsColumn project={projectWith(AGENTS)} side="right" />);
    const inks: string[] = [];
    for (const id of ["ep-red", "ep-blue", "ep-green", "ep-none"]) {
      const el = square(id)!;
      expect(el.style.background, id).not.toBe("transparent");
      expect(el.style.background, id).not.toBe("");
      expect(el.style.border, id).toBe("");
      inks.push(el.style.background);
    }
    // Four rows, four DIFFERENT inks: a square hard-wired to one colour, or one that lost a state by
    // folding two together, cannot satisfy this.
    expect(new Set(inks).size).toBe(4);
  });

  it("reads a MIXED fleet as orange, in either agent order", () => {
    // Two agents on one epic, in both orders across two renders. A rule that read `agents[0]` — or
    // that stopped at the first non-calm reading — passes one of these and fails the other. That
    // order-independence is what this case has always been for, and it still is.
    //
    // THE EXPECTED VALUE CHANGED ON PURPOSE, 2026-08-22: this fleet used to read `red`, because
    // `markOf` sent an orange dot through `bandOfRollup` (→ `needs_you`) and a half-broken epic was
    // indistinguishable from a fully stopped one. Telling those apart is the whole point of the
    // fifth state — the founder's *"some agents that are red and some that are not red […] probably
    // it should stay in Being Built"* — so an assertion of `red` here would now be pinning the
    // defect. See `engine/epicHealth`'s header.
    seed([epic("ep-mixed")]);
    const green = build("g", "ep-mixed");
    const red = build("r", "ep-mixed");
    useRuntimeStore.setState({ status: { g: "working", r: "waiting" } } as never);

    const first = render(<EpicsColumn project={projectWith([green, red])} side="right" />);
    expect(healthOf("ep-mixed")).toBe("orange");
    // ...and specifically NOT the old answer, so a regression to the band-only fold is caught here
    // and not only in the engine's own suite.
    expect(healthOf("ep-mixed")).not.toBe("red");
    // THE SQUARE MUST ACTUALLY BE PAINTED. `FILL` is keyed by `EpicHealth`, so a missing `orange`
    // entry yields `undefined` and renders a BLANK 9px box — the mark vanishing for exactly the
    // fleet the fifth state exists to surface. Asserting the colour reaches the DOM is what makes
    // that failure loud instead of invisible.
    const painted = square("ep-mixed")!;
    expect(painted.style.background).not.toBe("");
    expect(painted.style.background).not.toBe("transparent");
    first.unmount();

    render(<EpicsColumn project={projectWith([red, green])} side="right" />);
    expect(healthOf("ep-mixed")).toBe("orange");
  });

  it("still reads a fleet with NO green as red — the mixed arm did not swallow it", () => {
    // The paired case, and the reason the one above is about a CAUSE rather than a fixture: swap
    // the working agent for a second stopped one and the epic is fully stopped again. If this ever
    // reports `orange` too, the fleet test has stopped distinguishing "half broken" from "broken".
    seed([epic("ep-allred")]);
    useRuntimeStore.setState({ status: { r1: "waiting", r2: "blocked" } } as never);
    render(
      <EpicsColumn
        project={projectWith([build("r1", "ep-allred"), build("r2", "ep-allred")])}
        side="right"
      />,
    );
    expect(healthOf("ep-allred")).toBe("red");
  });

  it("goes GRAY, not green, when the epic's only agent has finished and gone idle", () => {
    // The other half of "just sitting there": the agents exist, and none of them is working. A rule
    // written as "any bound agent → green" passes every case above and fails only this one.
    seed([epic("ep-finished")]);
    useRuntimeStore.setState({ status: { done1: "idle" } } as never);
    render(
      <EpicsColumn project={projectWith([build("done1", "ep-finished")])} side="right" />,
    );
    expect(healthOf("ep-finished")).toBe("gray");
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
    // A shipped/done epic is finished, and painting a mark on it would report "nothing is active
    // here" about work that is complete. The rung header ("Done") is what tells the reader why
    // there is no mark.
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
    expect(healthOf("ep-live")).toBe("gray");
  });
});
