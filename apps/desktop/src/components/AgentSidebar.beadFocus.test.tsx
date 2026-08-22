// @vitest-environment jsdom
//
// CLICKING A CHILD TASK NARROWS THE BUILD COLUMN FURTHER — the rung below the epic focus.
//
// The founder: "In the epic column if I click on a child task row, it would constrain the build
// agents that show to only be the ones that are related to that specific child task row… I can see
// the exact build agent or agents that are working on that child."
//
// `AgentSidebar.epicFocus.test.tsx` beside this one proves the EPIC rung and explains why these are
// written as they are; the same two rules govern here and they are the whole reason this file
// exists rather than a couple of extra cases over there:
//
//   1. ASSERT THE ROWS, NOT THE STORE. "The selection was recorded" is a precondition and passes
//      while the column is completely inert. The founder's sentence is about what is on screen.
//   2. MOUNT EVERY CANDIDATE AT ONCE. Bead `sparkle-foqoe`: a rule that picks one of N targets is
//      not tested by asserting absence in a component that was never in the tree — that absence
//      holds just as well when the rule is keyed to the wrong side entirely. So the fixture below
//      seeds an agent on the focused child, an agent on a SIBLING child, an agent on an unrelated
//      epic, an orchestrator on the epic itself, and a nested worker — all of them renderable in
//      the same call — and every case checks presence AND absence together.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./HistorySearch", () => ({ HistorySearch: () => null }));
vi.mock("../services/branchStatus", () => ({
  projectAgentsStatus: vi.fn(() => Promise.resolve([])),
  refreshAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
  landAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
}));

import { AgentSidebar } from "./AgentSidebar";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useBeadsStore } from "../stores/beadsStore";
import { bucketBeads, type Bead } from "../services/beads";
import type { AgentTab, Project } from "../types";

function mkAgent(id: string, name: string, over: Partial<AgentTab> = {}): AgentTab {
  return {
    id, name, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: true, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null, ...over,
  };
}

function bead(id: string, over: Partial<Bead> = {}): Bead {
  return { id, title: id, status: "open", labels: [], ...over } as Bead;
}

const BEADS: Bead[] = [
  bead("ep-1"),
  bead("ep-1.a"), // Alpha's task
  bead("ep-1.b"), // Bravo's task — the SIBLING, and the whole point of case-by-case absence
  bead("ep-1.c"), // nobody top-level; a nested WORKER carries it, so its head must survive
  bead("ep-1.d"), // NOBODY at all — the only way to observe the empty-because-narrowed state
  bead("ep-2"),
  bead("ep-2.a"), // Zulu's task, in a different epic entirely
];

/**
 * FIVE AGENTS, ALL MOUNTED IN EVERY CASE.
 *
 * `Omega` is the load-bearing one: it is an ORCHESTRATOR stamped with BOTH `epicId` and `beadId`
 * pointing at the epic, which is exactly what `sendToBuild.prepareHandoff` writes and exactly the
 * shape `services/epicLadder`'s doc records a misattribution against. It must come back for the
 * EPIC and must NOT come back for a CHILD it is not working — a filter that resolved each agent to
 * its owning epic and compared THAT to the focused id would keep Omega under every child of ep-1,
 * which is the wrong answer that looks right until you seed this row.
 *
 * `Whiskey` is a nested worker (`parentId: "omega"`), so it is not a top-level row. Focusing ITS
 * bead has to keep `Omega` — the row that actually renders — or the column empties in precisely the
 * case the founder is asking to see.
 */
const PROJECT: Project = {
  id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
  createdAt: new Date(0).toISOString(), selectedAgentId: "alpha",
  agents: [
    mkAgent("alpha", "Alpha", { beadId: "ep-1.a" }),
    mkAgent("bravo", "Bravo", { beadId: "ep-1.b" }),
    mkAgent("zulu", "Zulu", { beadId: "ep-2.a" }),
    mkAgent("omega", "Omega", { epicId: "ep-1", beadId: "ep-1" }),
    mkAgent("whiskey", "Whiskey", { parentId: "omega", beadId: "ep-1.c" }),
  ],
};

/** The four TOP-LEVEL rows, by visible name. Whiskey is deliberately absent: it is a worker folded
 *  behind Omega's roll-up (collapsed by default), so its name is not a row this column paints and
 *  asserting on it would be asserting about the wrong thing. */
const ROWS = ["Alpha", "Bravo", "Zulu", "Omega"] as const;

/** The rendered set, as names — so a case states which rows it expects in one literal and gets the
 *  presence AND absence halves from one assertion instead of four that can drift apart. */
function shownRows(): string[] {
  return ROWS.filter((n) => screen.queryByText(n) !== null);
}

beforeEach(() => {
  useProjectStore.setState({ projects: [PROJECT], selectedProjectId: "p1" } as never);
  useRuntimeStore.setState({ openAgentIds: [], status: {} } as never);
  useUiStore.setState({
    workModeBySide: { left: "build", right: "build" },
    epicFocusBySide: { left: null, right: null },
    beadFocusBySide: { left: null, right: null },
    pairAssignment: {},
  } as never);
  useBeadsStore.setState({
    byProject: { p1: { beads: BEADS, board: bucketBeads(BEADS), polledAt: 0 } },
    error: {},
  } as never);
});
afterEach(() => {
  cleanup();
  useUiStore.setState({
    epicFocusBySide: { left: null, right: null },
    beadFocusBySide: { left: null, right: null },
  } as never);
});

describe("the build column narrows to the selected CHILD TASK", () => {
  it("shows every top-level row when nothing is focused", () => {
    // The baseline that makes every absence below mean something. Without it, "Bravo is gone" is
    // satisfied by a column that never rendered Bravo under any condition.
    render(<AgentSidebar project={PROJECT} />);
    expect(shownRows()).toEqual(["Alpha", "Bravo", "Zulu", "Omega"]);
  });

  it("keeps ONLY the agent on that child — not its sibling, not the unrelated one, not the epic's own orchestrator", () => {
    // THE FOUNDER'S SENTENCE. All four rows are renderable; exactly one survives.
    //
    // Omega's absence is the assertion with the most power here and it is the one a plausible
    // wrong implementation fails: it is stamped `epicId: "ep-1"`, so any rule that asks "which epic
    // does this agent ladder up to" answers ep-1 for it and keeps it under EVERY child of ep-1.
    // It is not working ep-1.a, so it does not belong in ep-1.a's column.
    useUiStore.setState({
      epicFocusBySide: { left: null, right: "ep-1" },
      beadFocusBySide: { left: null, right: "ep-1.a" },
    } as never);
    render(<AgentSidebar project={PROJECT} />);
    expect(shownRows()).toEqual(["Alpha"]);
  });

  it("narrows the OTHER way for the SIBLING child, so it is the child that decides and not the order", () => {
    // The mirror. Without it, a rule that always kept the first agent in the array passes the case
    // above — Alpha happens to be first.
    useUiStore.setState({
      epicFocusBySide: { left: null, right: "ep-1" },
      beadFocusBySide: { left: null, right: "ep-1.b" },
    } as never);
    render(<AgentSidebar project={PROJECT} />);
    expect(shownRows()).toEqual(["Bravo"]);
  });

  it("keeps the ORCHESTRATOR when the child is carried by a WORKER folded beneath it", () => {
    // ep-1.c is Whiskey's bead, and Whiskey is not a top-level row. The column narrows
    // `topLevelOf(agents)`, so an id set holding only the worker matches nothing and the column
    // would go blank while an agent is plainly building that task. The head is the row that
    // renders, so the head is what has to survive.
    useUiStore.setState({
      epicFocusBySide: { left: null, right: "ep-1" },
      beadFocusBySide: { left: null, right: "ep-1.c" },
    } as never);
    render(<AgentSidebar project={PROJECT} />);
    expect(shownRows()).toEqual(["Omega"]);
  });

  it("is PER SIDE — a child focused on the left does not narrow the right column", () => {
    // The column under test answers to the RIGHT side (see the epic-focus file beside this one).
    // A focus that was not per-side would silently narrow the column the user is not looking at,
    // which is why every sibling key in uiStore is `BySide`.
    useUiStore.setState({
      epicFocusBySide: { left: "ep-1", right: null },
      beadFocusBySide: { left: "ep-1.a", right: null },
    } as never);
    render(<AgentSidebar project={PROJECT} />);
    expect(shownRows()).toEqual(["Alpha", "Bravo", "Zulu", "Omega"]);
  });
});

// ── HOW THE TWO RUNGS COMPOSE ────────────────────────────────────────────────────────────────
//
// The rule is stated once, in `uiStore.beadFocusBySide`: the narrower one wins, clearing the child
// returns to the EPIC rather than to everything, and changing the epic drops the child. These
// assert all three THROUGH THE RENDERED ROWS, because the store half is the precondition this file
// refuses to accept as evidence — a store that holds exactly the right value while the column
// reads the other key renders identically to no feature at all.
describe("the child focus and the epic focus compose", () => {
  it("returns the EPIC's whole set when only the epic is focused", () => {
    // The wider rung, with the same five agents mounted. Everything laddering to ep-1 comes back —
    // including Omega, whose stamped bead IS the epic, and Bravo, whose task is a sibling of the
    // one the next case focuses. Zulu, in another epic, does not.
    useUiStore.setState({ epicFocusBySide: { left: null, right: "ep-1" } } as never);
    render(<AgentSidebar project={PROJECT} />);
    expect(shownRows()).toEqual(["Alpha", "Bravo", "Omega"]);
  });

  it("falls BACK to the epic's set when the child is cleared, not to everything", () => {
    // The founder's gesture is a drill-DOWN, so undoing it must land one rung up. Landing on
    // "everything" would put Zulu — an agent in a different epic — back on screen under an epic
    // that is still selected and still highlighted in the next column.
    useUiStore.setState({
      epicFocusBySide: { left: null, right: "ep-1" },
      beadFocusBySide: { left: null, right: "ep-1.a" },
    } as never);
    render(<AgentSidebar project={PROJECT} />);
    expect(shownRows()).toEqual(["Alpha"]);

    fireEvent.click(screen.getByTestId("bead-clear-focus-build"));

    // The rows, not the store field. And the epic focus is untouched underneath — Zulu staying
    // away is what proves the fallback landed on the EPIC rather than on no filter at all.
    expect(shownRows()).toEqual(["Alpha", "Bravo", "Omega"]);
    expect(useUiStore.getState().epicFocusBySide.right).toBe("ep-1");
  });

  it("changes the RENDERED SET when focus moves straight from one child to its sibling", () => {
    // Not "the store value changed" — the column is re-driven from a live subscription, and a
    // memo keyed on the wrong dep would leave the previous rows painted while the state moved on.
    render(<AgentSidebar project={PROJECT} />);
    act(() => {
      useUiStore.setState({
        epicFocusBySide: { left: null, right: "ep-1" },
        beadFocusBySide: { left: null, right: "ep-1.a" },
      } as never);
    });
    expect(shownRows()).toEqual(["Alpha"]);

    act(() => {
      useUiStore.setState({ beadFocusBySide: { left: null, right: "ep-1.b" } } as never);
    });
    // Both halves of the swap: the new child's agent arrives AND the old one leaves. Asserting
    // only the arrival passes for a column that accumulates.
    expect(shownRows()).toEqual(["Bravo"]);
  });

  it("DROPS the child when the epic moves, so one epic's task never narrows another epic's column", () => {
    // uiStore rule 3, driven through the real setter rather than by writing both keys by hand — a
    // test that sets the end state itself proves nothing about the transition that produces it.
    useUiStore.setState({
      epicFocusBySide: { left: null, right: "ep-1" },
      beadFocusBySide: { left: null, right: "ep-1.a" },
    } as never);
    render(<AgentSidebar project={PROJECT} />);
    expect(shownRows()).toEqual(["Alpha"]);

    act(() => {
      useUiStore.getState().setEpicFocus("right", "ep-2");
    });

    // ep-2's set, and nothing of ep-1.a. A surviving child focus would render Alpha here — one
    // epic selected while the other epic's task decides the column.
    expect(shownRows()).toEqual(["Zulu"]);
    expect(useUiStore.getState().beadFocusBySide.right).toBeNull();
  });

  it("also drops the child when the SAME epic is re-clicked to clear it", () => {
    // The no-op guard's edge: `setEpicFocus` returns early when the epic key would not change, and
    // re-clicking the focused epic resolves to `null` — a value the epic key may already be at in
    // no other case. Toggling ep-1 off must take the child with it, or the column stays narrowed
    // to a task while nothing at all is selected in the epics column.
    useUiStore.setState({
      epicFocusBySide: { left: null, right: "ep-1" },
      beadFocusBySide: { left: null, right: "ep-1.a" },
    } as never);
    render(<AgentSidebar project={PROJECT} />);

    act(() => {
      useUiStore.getState().setEpicFocus("right", "ep-1");
    });

    expect(useUiStore.getState().epicFocusBySide.right).toBeNull();
    expect(useUiStore.getState().beadFocusBySide.right).toBeNull();
    expect(shownRows()).toEqual(["Alpha", "Bravo", "Zulu", "Omega"]);
  });
});

// ── THE EMPTY CASE IS THE COMMON CASE ────────────────────────────────────────────────────────
//
// A child task with nothing bound to it is ordinary, not an error. A column that simply goes blank
// reads as broken — and the "No Build agents yet" copy is actively wrong here, because it tells the
// user to start an agent when four of them are one click away.
describe("a child task nobody is working", () => {
  it("says the filter is on and that nothing is on this task, rather than going blank", () => {
    useUiStore.setState({
      epicFocusBySide: { left: null, right: "ep-1" },
      beadFocusBySide: { left: null, right: "ep-1.d" },
    } as never);
    render(<AgentSidebar project={PROJECT} />);

    expect(shownRows()).toEqual([]);
    expect(document.body.textContent).toContain("No build agents are working on this task.");
    // NOT the epic wording — that would send the user looking at an epic which plainly does have
    // agents — and NOT the start-an-agent wording.
    expect(document.body.textContent).not.toContain("match your selected Epic");
    expect(document.body.textContent).not.toContain("No Build agents yet");
  });

  it("offers a way back that returns to the EPIC, and the rows actually come back", () => {
    useUiStore.setState({
      epicFocusBySide: { left: null, right: "ep-1" },
      beadFocusBySide: { left: null, right: "ep-1.d" },
    } as never);
    render(<AgentSidebar project={PROJECT} />);
    expect(shownRows()).toEqual([]);

    // Its own testid, not the epic overlay's: the two links go to different places, and a shared
    // id would let a caller assert about whichever one the query reached first.
    const back = screen.getByTestId("bead-empty-show-all");
    expect(back.textContent?.trim()).toBe("Show the Epic's agents");
    fireEvent.click(back);

    // The side effect: the epic's rows return, the message is gone, and the epic focus below is
    // still in force (Zulu stays away).
    expect(shownRows()).toEqual(["Alpha", "Bravo", "Omega"]);
    expect(document.body.textContent).not.toContain("No build agents are working on this task.");
  });

  it("says 'Show all' instead when there is no epic underneath to fall back to", () => {
    // A child can be focused with no epic focus (uiStore writes the two keys independently), and
    // then the way back really IS to everything. Naming the wrong destination is the failure this
    // pins: "Show the Epic's agents" would be offering a set that does not exist.
    useUiStore.setState({ beadFocusBySide: { left: null, right: "ep-1.d" } } as never);
    render(<AgentSidebar project={PROJECT} />);
    expect(shownRows()).toEqual([]);
    expect(screen.getByTestId("bead-empty-show-all").textContent?.trim()).toBe("Show all");

    fireEvent.click(screen.getByTestId("bead-empty-show-all"));
    expect(shownRows()).toEqual(["Alpha", "Bravo", "Zulu", "Omega"]);
  });
});

// ── THE WAY BACK WHILE THE COLUMN IS NARROWED BUT NOT EMPTY ──────────────────────────────────
//
// The overlay above is gated on the column being EMPTY, so a child matching one of four agents
// narrows this column with no in-column escape at all unless the header carries one. Same
// reasoning as the epic rung's control beside it, one rung down.
describe("the header control for the child focus", () => {
  it("names the DESTINATION, and does not double up with the epic control", () => {
    useUiStore.setState({
      epicFocusBySide: { left: null, right: "ep-1" },
      beadFocusBySide: { left: null, right: "ep-1.a" },
    } as never);
    render(<AgentSidebar project={PROJECT} />);

    const clear = screen.getByTestId("bead-clear-focus-build");
    // "Show all" would be a lie: clearing the child hands the column back to the epic's three
    // rows, not to all four. The visible label is pinned as a LITERAL rather than read back off
    // the element, so an icon-only regression cannot make the containment check below vacuous.
    expect(clear.textContent?.trim()).toBe("Show Epic");
    const name = clear.getAttribute("aria-label") ?? "";
    // WCAG 2.5.3 (Label in Name): the accessible name must still CONTAIN what is painted, or a
    // voice-control user saying "click Show Epic" stops matching the control.
    expect(name).toContain("Show Epic");
    expect(name).toContain("clears the task");
    // No native `title`: `disableNativeTooltips()` strips it app-wide, so one could never show.
    expect(clear.getAttribute("title")).toBeNull();
    // Exactly ONE way back in the header. While a child is focused the epic filter is not the one
    // doing the narrowing, so offering to clear it would offer to clear something not in force.
    expect(screen.queryByTestId("epic-clear-focus-build")).toBeNull();
  });

  it("reads 'Show all' when no epic is underneath, and clears back to everything", () => {
    useUiStore.setState({ beadFocusBySide: { left: null, right: "ep-1.a" } } as never);
    render(<AgentSidebar project={PROJECT} />);
    const clear = screen.getByTestId("bead-clear-focus-build");
    expect(clear.textContent?.trim()).toBe("Show all");
    expect(shownRows()).toEqual(["Alpha"]);

    fireEvent.click(clear);
    expect(shownRows()).toEqual(["Alpha", "Bravo", "Zulu", "Omega"]);
  });

  it("retires the control once no child is focused, so it is never a dead button", () => {
    // Both directions in one case. Asserting only that it appears under a focus passes for a
    // control that is always mounted — offering to clear a filter nobody set.
    render(<AgentSidebar project={PROJECT} />);
    expect(screen.queryByTestId("bead-clear-focus-build")).toBeNull();

    cleanup();
    useUiStore.setState({ beadFocusBySide: { left: null, right: "ep-1.a" } } as never);
    render(<AgentSidebar project={PROJECT} />);
    expect(screen.queryByTestId("bead-clear-focus-build")).not.toBeNull();
  });

  it("leaves the EPIC control in place when only an epic is focused", () => {
    // The epic rung is untouched by this feature; its own file covers it, and this pins that the
    // new branch did not steal its mount.
    useUiStore.setState({ epicFocusBySide: { left: null, right: "ep-1" } } as never);
    render(<AgentSidebar project={PROJECT} />);
    expect(screen.queryByTestId("epic-clear-focus-build")).not.toBeNull();
    expect(screen.queryByTestId("bead-clear-focus-build")).toBeNull();
  });
});
