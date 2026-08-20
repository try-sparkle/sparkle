// @vitest-environment jsdom
//
// CLICKING AN EPIC NARROWS THE BUILD COLUMN — the wiring, not the rule.
//
// `engine/epicFocus.test.ts` proves which agent ids survive the narrowing. That passes while the
// feature is completely inert, because the thing the founder operates is the chain neither half
// crosses:
//
//     epics column click → uiStore.epicFocusBySide → THIS column's ladder input → rows on screen
//
// So these assert the SIDE EFFECT — which rows are in the document — and never that the store field
// was written. "The selection was recorded" is a precondition; the founder's sentence is "filter the
// build orchestrators to be only the ones that refer to or are related to that Epic."
//
// AND EVERY CASE MOUNTS BOTH AGENTS AT ONCE. Asserting that the related agent survives is half the
// evidence: it passes for a rule that filters nothing. Asserting the unrelated one is absent in a
// column that never rendered it is worse than half — it is vacuous, and it is the shape bead
// `sparkle-foqoe` names. The assertion with power needs both rows to be renderable in the same
// call, so the fixture always seeds both and each case checks both.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  bead("ep-1.a"),
  bead("ep-2"),
  bead("ep-2.a"),
  // An epic NOBODY is working — the only way to observe the empty-because-narrowed state. The
  // first draft of the case below selected `ep-1.a`, which is the very bead an agent carries, so
  // it asserted an emptiness that could not occur.
  bead("ep-3"),
];

/** TWO orchestrators, one on each epic — so every case below can observe a real partition rather
 *  than the absence of a row that was never going to render. */
const PROJECT: Project = {
  id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
  createdAt: new Date(0).toISOString(), selectedAgentId: "onEpic1",
  agents: [
    mkAgent("onEpic1", "Alpha", { beadId: "ep-1.a" }),
    mkAgent("onEpic2", "Beta", { beadId: "ep-2.a" }),
  ],
};

beforeEach(() => {
  useProjectStore.setState({ projects: [PROJECT], selectedProjectId: "p1" } as never);
  useRuntimeStore.setState({ openAgentIds: [], status: {} } as never);
  useUiStore.setState({
    workModeBySide: { left: "build", right: "build" },
    epicFocusBySide: { left: null, right: null },
    pairAssignment: {},
  } as never);
  // The snapshot the column reads. `bucketBeads` rather than a hand-built `board`: a fixture whose
  // shape the production bucketer never produces is a fixture that tests nothing about production.
  useBeadsStore.setState({
    byProject: { p1: { beads: BEADS, board: bucketBeads(BEADS), polledAt: 0 } },
    error: {},
  } as never);
});
afterEach(() => {
  cleanup();
  useUiStore.setState({ epicFocusBySide: { left: null, right: null } } as never);
});

describe("the build column narrows to the selected epic", () => {
  it("shows BOTH orchestrators when no epic is selected", () => {
    // THE DEFAULT STATE OF THE APP, and the case that makes every other one meaningful: if this
    // failed, "the unrelated agent is absent" below would be true for a reason that has nothing to
    // do with the epic. Nothing is selected on launch, so a narrowing that fired here would empty
    // this column for every user on every start.
    render(<AgentSidebar project={PROJECT} />);
    expect(screen.queryByText("Alpha")).not.toBeNull();
    expect(screen.queryByText("Beta")).not.toBeNull();
  });

  it("DROPS the unrelated orchestrator once an epic is selected, and keeps the related one", () => {
    useUiStore.setState({ epicFocusBySide: { left: null, right: "ep-1" } } as never);
    render(<AgentSidebar project={PROJECT} />);
    // The side effect. Both directions in one call: keeping only means something against dropping.
    expect(screen.queryByText("Alpha")).not.toBeNull();
    expect(screen.queryByText("Beta")).toBeNull();
  });

  it("narrows the OTHER way for the other epic, so it is the epic that decides and not the order", () => {
    // The mirror case. Without it, a rule that always kept the FIRST agent would pass everything
    // above — the fixture's related agent happens to be first.
    useUiStore.setState({ epicFocusBySide: { left: null, right: "ep-2" } } as never);
    render(<AgentSidebar project={PROJECT} />);
    expect(screen.queryByText("Beta")).not.toBeNull();
    expect(screen.queryByText("Alpha")).toBeNull();
  });

  it("is PER SIDE — the left column's selection does not touch the right one", () => {
    // The two pairs are independent projects. One shared value would silently narrow the column the
    // user is not looking at, which is the reason every sibling key in uiStore is `BySide`.
    useUiStore.setState({ epicFocusBySide: { left: "ep-1", right: null } } as never);
    render(<AgentSidebar project={PROJECT} />);
    expect(screen.queryByText("Alpha")).not.toBeNull();
    expect(screen.queryByText("Beta")).not.toBeNull();
  });

  it("says WHY the column is empty rather than telling the user to start an agent", () => {
    // A filter whose explanation lives in a DIFFERENT column has to name itself where the emptiness
    // shows, or the user reads "no agents yet" about agents they can see the moment they clear it.
    useUiStore.setState({ epicFocusBySide: { left: null, right: "ep-3" } } as never);
    render(<AgentSidebar project={PROJECT} />);
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(screen.queryByText("Beta")).toBeNull();
    expect(document.body.textContent).toContain("No active build agents match your selected Epic.");
    expect(document.body.textContent).not.toContain("No Build agents yet");
  });
});

// ── THE WAY BACK, IN THIS COLUMN ─────────────────────────────────────────────────────────────
//
// The copy above used to end "Press Clear there to see them all again" — an instruction naming a
// button in a DIFFERENT column. The cases here assert the two controls that replaced it, and they
// assert the SIDE EFFECT the founder operates (the hidden rows come back), never merely that a
// button with the right label is in the document. A label is a precondition; a label wired to
// nothing renders identically and would pass a presence check.
//
// Both controls are asserted by TESTID rather than by text: "Show all" is also the label of the
// STATUS filter's own escape hatch 25 lines away in the same column, so `getByText` here would be
// answering a question about whichever one the query happened to reach first.
describe("clearing the epic focus from inside the build column", () => {
  it("brings the hidden rows back when the centered empty-state link is clicked", () => {
    // ep-3 is the epic nobody works, so this is the column-is-EMPTY case: the overlay renders and
    // its link is the only thing on screen offering a way out.
    useUiStore.setState({ epicFocusBySide: { left: null, right: "ep-3" } } as never);
    render(<AgentSidebar project={PROJECT} />);
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(screen.queryByText("Beta")).toBeNull();

    fireEvent.click(screen.getByTestId("epic-empty-show-all"));

    // The store went back to null AND the rows returned. The store half alone is the precondition
    // this file's header comment refuses to accept as evidence; the rows are the founder's sentence.
    expect(useUiStore.getState().epicFocusBySide.right).toBeNull();
    expect(screen.queryByText("Alpha")).not.toBeNull();
    expect(screen.queryByText("Beta")).not.toBeNull();
    expect(document.body.textContent).not.toContain("No active build agents match your selected Epic.");
  });

  it("offers the SAME way back from the header while the column is narrowed but NOT empty", () => {
    // THE CASE THE EMPTY STATE STRUCTURALLY CANNOT COVER, and the one the founder was actually in.
    // ep-1 matches Alpha, so `ordered.length` is 1 — the empty-state guard is false, no overlay
    // renders, and without the header control there is no in-column way back at all.
    useUiStore.setState({ epicFocusBySide: { left: null, right: "ep-1" } } as never);
    render(<AgentSidebar project={PROJECT} />);
    expect(screen.queryByText("Alpha")).not.toBeNull();
    expect(screen.queryByText("Beta")).toBeNull();
    // Pins that this is the non-empty path: the overlay must NOT be what is being clicked.
    expect(screen.queryByTestId("epic-empty-show-all")).toBeNull();

    fireEvent.click(screen.getByTestId("epic-clear-focus-build"));

    expect(useUiStore.getState().epicFocusBySide.right).toBeNull();
    expect(screen.queryByText("Beta")).not.toBeNull();
  });

  it("says WHICH filter the header control clears, because its label cannot", () => {
    // NOT decoration, and not a duplicate of the label assertion. "Show all" is the STATUS
    // filter's wording too — its reset sits in this same band — and the identical string appears
    // on two further buttons in this column. So the label alone cannot identify this control, and
    // a reader hovering it learns nothing without this. It regressed exactly once already: the
    // swap to `HeaderLink` dropped the tooltip silently, because the component took no `title`
    // (roborev 65983). Asserting the accessible name too, since that is the half a mouse user
    // never sees.
    useUiStore.setState({ epicFocusBySide: { left: null, right: "ep-1" } } as never);
    render(<AgentSidebar project={PROJECT} />);
    const clear = screen.getByTestId("epic-clear-focus-build");
    expect(clear.getAttribute("title")).toContain("clears the epic selected in the Epics column");
    expect(clear.getAttribute("aria-label")).toContain("clears the epic selected in the Epics column");
  });

  it("retires the header control once nothing is focused, so it is never a dead button", () => {
    // Both directions in one call. Asserting only that it appears under a focus passes for a
    // control that is ALWAYS mounted — which would sit in the header of every column on launch
    // offering to clear a filter nobody set.
    render(<AgentSidebar project={PROJECT} />);
    expect(screen.queryByTestId("epic-clear-focus-build")).toBeNull();

    cleanup();
    useUiStore.setState({ epicFocusBySide: { left: null, right: "ep-1" } } as never);
    render(<AgentSidebar project={PROJECT} />);
    expect(screen.queryByTestId("epic-clear-focus-build")).not.toBeNull();
  });

  it("centers the empty state over the VISIBLE column rather than flexing the scroll container", () => {
    // jsdom does no layout, so this can only pin the STYLE SHAPE — that the overlay route was
    // taken. It is still worth pinning: the alternative (making the scroll container a flex column
    // and giving the message `margin: auto`) also centers, and also turns the sticky New Agent
    // wrapper, ChatSection and every stage group into flex items — changing how children
    // contribute to `scrollHeight`, which is the input `listOverflows` is measured from. A future
    // edit that "simplifies" this into the flex route perturbs every mode, not just this one.
    // Real confirmation of the rendered centering is scripts/visual/capture.mjs.
    useUiStore.setState({ epicFocusBySide: { left: null, right: "ep-3" } } as never);
    render(<AgentSidebar project={PROJECT} />);

    const overlay = screen.getByTestId("epic-empty-overlay");
    expect(overlay.style.position).toBe("absolute");
    // jsdom keeps the authored `0` rather than normalising it to `0px`; the property is what
    // matters, not the serialisation.
    expect(overlay.style.inset).toBe("0");
    expect(overlay.style.alignItems).toBe("center");
    expect(overlay.style.justifyContent).toBe("center");
    // The containing block for `inset: 0`. Without this the overlay escapes to some ancestor and
    // is centered over the wrong box — the failure would be invisible to every assertion above.
    const scroll = screen.getByTestId("agent-list-scroll");
    expect(scroll.style.position).toBe("relative");
    // It paints over the create-button band, so it must not swallow clicks on it — while the link
    // inside it stays hittable.
    expect(overlay.style.pointerEvents).toBe("none");
    expect(screen.getByTestId("epic-empty-show-all").style.pointerEvents).toBe("auto");
  });
});
