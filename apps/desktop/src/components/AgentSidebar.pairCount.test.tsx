// @vitest-environment jsdom
//
// ADDING AND REMOVING A PAIR — and the property the control it replaced did not have: AN INVERSE.
//
// The old control was a `«` chevron that moved this project to the other side of the concierge.
// Because the pair count is DERIVED from the assignment map (engine/pairs.pairCountFor), sending
// the last left-side project back collapsed the second pair. That worked, and the user could not
// undo it — "now I don't know how to open it back up" — because nothing about a direction glyph
// says anything can come back.
//
// So the case that matters most here is the ROUND TRIP. A test that only asserts "clicking opens a
// pair" would have passed against the chevron too, which is exactly the shape AGENTS.md warns
// about: it would have been true before the change and proves nothing about what was fixed.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./StatusBar", () => ({ StatusBar: () => null }));
vi.mock("./HistorySearch", () => ({ HistorySearch: () => null }));
vi.mock("../services/openProjectTab", () => ({ openProjectTab: vi.fn() }));

import { AgentSidebar } from "./AgentSidebar";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { pairCountFor } from "../engine/pairs";
import { openProjectTab } from "../services/openProjectTab";
import type { AgentTab, Project } from "../types";

function mkAgent(id: string): AgentTab {
  return {
    id, name: `Agent ${id}`, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: true, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,
  };
}
function mkProject(id: string): Project {
  return {
    id, name: `Project ${id}`, rootPath: `/tmp/${id}`, defaultBranch: null,
    createdAt: new Date(0).toISOString(), selectedAgentId: null, agents: [mkAgent(`${id}-a1`)],
  };
}

const control = () => screen.getByTestId("pair-count-control");
/** The count the SHELL derives — the thing the user actually sees open or close. */
const pairs = () =>
  pairCountFor(useProjectStore.getState().projects, useUiStore.getState().pairAssignment);

function seed(ids = ["p1"]) {
  const projects = ids.map(mkProject);
  useProjectStore.setState({ projects, selectedProjectId: ids[0]! } as never);
  useRuntimeStore.setState({ branchStatus: {}, status: {} } as never);
  return projects;
}

beforeEach(() => {
  // CLEARED, or the close-branch assertion below cannot fail: `openProjectTab` is a module-level
  // `vi.fn()` and nothing in this repo's setup clears mocks between tests, so the OPEN branch in the
  // first test already records `openProjectTab("p1")` and satisfies it before the close test renders
  // anything (roborev 55376).
  vi.mocked(openProjectTab).mockClear();
  useUiStore.setState({
    workModeBySide: { left: "build", right: "build" }, pairAssignment: {}, leftProjectId: null, collapsedOrchestrators: {},
  } as never);
});
afterEach(cleanup);

describe("the pair control is REVERSIBLE", () => {
  it("opens the second pair, then closes it again — the round trip the chevron lacked", () => {
    const [p1] = seed(["p1"]);
    render(<AgentSidebar project={p1!} />);
    expect(pairs()).toBe(1);

    fireEvent.click(control());
    expect(pairs()).toBe(2);

    // THE HALF THAT WAS MISSING. The control is still there, still operable, and now does the
    // opposite — rather than the user hunting for an affordance that never announced itself.
    fireEvent.click(control());
    expect(pairs()).toBe(1);
  });

  it("shows PLUS with one pair and MINUS with two, so the inverse is legible before clicking", () => {
    const [p1] = seed(["p1"]);
    render(<AgentSidebar project={p1!} />);
    expect(control().getAttribute("aria-label")).toMatch(/open/i);

    fireEvent.click(control());
    expect(control().getAttribute("aria-label")).toMatch(/close/i);
    // …and the glyph changes with it, not just the label.
    expect(control().querySelector("svg")).toBeTruthy();
  });

  it("returns EVERY project on the closing side, not only the one that was clicked", () => {
    // A "close" that leaves the pair open holding the other projects is not a close. This is what
    // made the original control read as unpredictable with more than one project assigned.
    const projects = seed(["p1", "p2"]);
    useUiStore.setState({ pairAssignment: { p1: "left", p2: "left" } } as never);
    render(<AgentSidebar project={projects[0]!} />);
    expect(pairs()).toBe(2);

    fireEvent.click(control());
    expect(pairs()).toBe(1);
    const assignment = useUiStore.getState().pairAssignment;
    expect(Object.values(assignment).filter((s) => s === "left")).toHaveLength(0);
  });
});

describe("the pair control stays out of the way", () => {
  // REVEALED THROUGH THE HEADER, which is what a real pointer traverses. These used to dispatch
  // `mouseEnter` straight at the button — bypassing hit-testing entirely — and so were green
  // against a control that could never be revealed in a browser at all: it was `visibility:
  // hidden`, which is not a hit-test target and is skipped by Tab (roborev 55349).
  const header = () => screen.getByTestId("build-column-header");

  it("is revealed by hovering the HEADER, not by hovering itself", () => {
    const [p1] = seed(["p1"]);
    render(<AgentSidebar project={p1!} />);
    expect(control().style.opacity).toBe("0");
    fireEvent.mouseEnter(header());
    expect(control().style.opacity).toBe("1");
    fireEvent.mouseLeave(header());
    expect(control().style.opacity).toBe("0");
  });

  it("stays FOCUSABLE while hidden, so a keyboard user can reach it", () => {
    // The half `visibility: hidden` broke: a hidden control is removed from sequential focus
    // navigation, so Tab could never land on it and the focus reveal was dead too.
    const [p1] = seed(["p1"]);
    render(<AgentSidebar project={p1!} />);
    expect(control().style.visibility).not.toBe("hidden");
    // Focus bubbles to the header, which is what reveals it.
    fireEvent.focus(control());
    expect(control().style.opacity).toBe("1");
  });

  it("takes no clicks while hidden", () => {
    // An invisible control that still swallows presses is worse than an absent one — the same rule
    // the boundary tab follows.
    const [p1] = seed(["p1"]);
    render(<AgentSidebar project={p1!} />);
    expect(control().style.pointerEvents).toBe("none");
    fireEvent.mouseEnter(header());
    expect(control().style.pointerEvents).toBe("auto");
  });

  it("reserves its space, so the header does not shift as the pointer crosses it", () => {
    const [p1] = seed(["p1"]);
    render(<AgentSidebar project={p1!} />);
    expect(control().style.width).toBe("16px");
  });

  it("no longer offers the direction chevron it replaced", () => {
    const [p1] = seed(["p1"]);
    render(<AgentSidebar project={p1!} />);
    expect(screen.queryByTestId("send-to-other-pair")).toBeNull();
  });
});

describe("the pair control says what it will actually do", () => {
  it("names the LEFT pair from either column, rather than 'this side'", () => {
    // The control renders in BOTH columns, so "the second pair" and "this side" are wrong in at
    // least one of them: from the right column MINUS destroys the OTHER column, and from the left
    // column the projects go to the other side and this side ceases to exist. A user who reads the
    // label has to be able to predict the outcome — remedy copy is code.
    const projects = seed(["p1", "p2"]);
    useUiStore.setState({ pairAssignment: { p1: "left" } } as never);
    render(<AgentSidebar project={projects[0]!} />);
    expect(control().getAttribute("aria-label")).toBe(
      "Close the left pair — its projects return to the right",
    );
    cleanup();

    // …and from the RIGHT column it says the same thing, because it does the same thing.
    render(<AgentSidebar project={projects[1]!} />);
    expect(control().getAttribute("aria-label")).toContain("Close the left pair");
  });

  it("lands a selection when it closes, so the user's context does not vanish", () => {
    // Reassigning alone leaves `selectedProjectId` wherever it was, so the project the user was
    // looking at silently is not the one the surviving pair shows.
    const projects = seed(["p1", "p2"]);
    useUiStore.setState({ pairAssignment: { p1: "left" } } as never);
    render(<AgentSidebar project={projects[0]!} />);
    fireEvent.click(control());
    expect(openProjectTab).toHaveBeenLastCalledWith("p1");
    expect(openProjectTab).toHaveBeenCalledTimes(1);
  });
});

