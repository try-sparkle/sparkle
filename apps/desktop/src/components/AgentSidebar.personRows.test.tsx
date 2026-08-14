// @vitest-environment jsdom
//
// PERSON ROWS ARE ON SCREEN IN THE BUILD SIDEBAR. This is the goal of stage U3, and it is the one
// test that pins it.
//
// WHY IT RENDERS THE REAL `AgentSidebar` RATHER THAN `ChatSection`. The foundation for this feature
// — `engine/social`, `socialStore`, `PersonAvatar`, `AvailabilityDot`, `rowAnatomy` — was merged
// and fully unit-tested while being COMPLETELY INVISIBLE in the running app, because nothing
// rendered it. The founder's report was exactly that: *"I don't see that in the build."* A suite of
// component tests could not have caught it, and a `ChatSection` test on its own still cannot: the
// missing thing was the one render line in this file's subject. So this test drives the production
// entry point and asserts the SIDE EFFECT — the people's names are painted, inside the chat tree —
// which is false against `origin/main` and true only once that line exists.
//
// jsdom does not lay out and does not load the stylesheet (docs/jsdom-test-caveats.md). Nothing
// here measures a pixel; it reads text content, roles and attributes, all of which jsdom evaluates
// for real.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./HistorySearch", () => ({
  HistorySearch: () => null,
  relativeTime: () => "",
  renderSnippet: () => null,
}));
vi.mock("../services/branchStatus", () => ({
  projectAgentsStatus: vi.fn(() => Promise.resolve([])),
  refreshAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
  landAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
}));

import { AgentSidebar } from "./AgentSidebar";
import { CHAT_ADD_PERSON_TESTID } from "./ChatSectionHeader";
import { PERSON_ROW_TESTID } from "./PersonRow";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { SPARKLE_PANE_SIDE, useUiStore } from "../stores/uiStore";
import { resetCable, useCableStore } from "../stores/cableStore";
import { rowBoxFor } from "./rowAnatomy";
import { useHelperPrefs } from "../helper/helperPrefs";
import { allBandsVisible } from "../engine/buildSections";
import { useSocialStore, type Person } from "../stores/socialStore";
import { availabilityLabel } from "./AvailabilityDot";
import type { AgentTab, Project } from "../types";

function mkAgent(id: string, name: string): AgentTab {
  return {
    id, name, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: true, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,
  };
}

function seedProject(): Project {
  const project: Project = {
    id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
    createdAt: new Date(0).toISOString(), selectedAgentId: null,
    agents: [mkAgent("a1", "Alpha")],
  };
  useProjectStore.setState({ projects: [project] } as never);
  useRuntimeStore.setState({
    branchStatus: {}, workflowStage: {}, status: {},
    openAgentIds: ["a1"],
    open: vi.fn(),
    pollBranchStatus: vi.fn(() => Promise.resolve()),
  } as never);
  return project;
}

const ADA: Person = {
  socialId: "s-ada",
  username: "ada",
  displayName: "Ada Lovelace",
  availability: "available",
  relationship: "connected",
};
const GRACE: Person = {
  socialId: "s-grace",
  username: "grace_hopper",
  displayName: null,
  availability: "offline",
  relationship: "connected",
};

function seedPeople(...people: Person[]) {
  useSocialStore.setState({
    people: Object.fromEntries(people.map((p) => [p.socialId, p])),
  });
}

beforeEach(() => {
  useSocialStore.getState().reset();
  useUiStore.setState({
    collapsedOrchestrators: {},
    activeSpecial: null,
    statusFilter: allBandsVisible(),
    pairAssignment: {},
    leftProjectId: null,
    workModeBySide: { left: "build", right: "build" },
  } as never);
  useHelperPrefs.setState({ enabled: true } as never);
  resetCable();
});
afterEach(() => {
  cleanup();
  resetCable();
  useSocialStore.getState().reset();
});

describe("The Build sidebar paints PEOPLE", () => {
  it("renders a row per person, with their name, inside the chat tree", () => {
    seedPeople(ADA, GRACE);
    render(<AgentSidebar project={seedProject()} />);

    const tree = screen.getByRole("tree", { name: "Chats" });
    const rows = screen.getAllByTestId(PERSON_ROW_TESTID);
    expect(rows.length).toBe(2);

    // THE SIDE EFFECT: the names are on screen, and they are inside the chat tree rather than
    // merely somewhere in the document.
    const ada = screen.getByText("Ada Lovelace");
    const grace = screen.getByText("grace_hopper"); // no display name → the username, via personName
    expect(tree.contains(ada)).toBe(true);
    expect(tree.contains(grace)).toBe(true);
  });

  it("gives each row an availability affordance — in words, not colour alone", () => {
    seedPeople(ADA, GRACE);
    render(<AgentSidebar project={seedProject()} />);

    // The row's accessible name carries the state as a WORD…
    expect(
      screen.getByRole("treeitem", { name: `Ada Lovelace — ${availabilityLabel("available")}` }),
    ).toBeTruthy();
    expect(
      screen.getByRole("treeitem", { name: `grace_hopper — ${availabilityLabel("offline")}` }),
    ).toBeTruthy();

    // …and the dot is painted beside it, one per row, carrying the same state as a data hook.
    const dots = document.querySelectorAll("[data-availability]");
    expect(dots.length).toBe(2);
    expect(Array.from(dots).map((d) => d.getAttribute("data-availability")).sort()).toEqual([
      "available",
      "offline",
    ]);
  });

  it("sits ABOVE the stage ladder — top of the list, not appended after it", () => {
    seedPeople(ADA);
    render(<AgentSidebar project={seedProject()} />);

    const chatRow = screen.getByTestId(PERSON_ROW_TESTID);
    const agentTree = document.querySelector("[data-chat-tree]") as HTMLElement;
    const buildTree = document.querySelector("[data-agent-tree]") as HTMLElement;
    expect(buildTree).toBeTruthy();
    expect(agentTree.contains(chatRow)).toBe(true);
    // DOCUMENT_POSITION_FOLLOWING (4) means the build tree comes AFTER the chat block.
    expect(agentTree.compareDocumentPosition(buildTree) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("shows the block, and its [+], even with nobody in it", () => {
    render(<AgentSidebar project={seedProject()} />);
    expect(screen.getByRole("tree", { name: "Chats" })).toBeTruthy();
    expect(screen.getByTestId(CHAT_ADD_PERSON_TESTID)).toBeTruthy();
    expect(screen.queryAllByTestId(PERSON_ROW_TESTID).length).toBe(0);
  });

  it("leaves the BUILD tree untouched — agents are still agents", () => {
    seedPeople(ADA, GRACE);
    render(<AgentSidebar project={seedProject()} />);

    // The guard on the whole change: person rows must not have leaked into the build tree, whose
    // tabStopId / renderedRowIds / ArrowDown ring are keyed on AgentTab.
    const buildTree = screen.getByRole("tree", { name: "Build agents" });
    expect(buildTree.querySelectorAll(`[data-testid="${PERSON_ROW_TESTID}"]`).length).toBe(0);
    expect(screen.getByText("Alpha")).toBeTruthy();
  });

  it("hands the person rows the pair's REAL cable state, not a defaulted false", () => {
    // THE DEFAULTED-SEAM SHAPE (bead sparkle-lgbwf). `ChatSection`'s `jointOpen` used to carry a
    // `= false`, and this call site omitted it — so every person row in the shipping app was built
    // `jointOpen: false` forever while the agent rows beside it opened their concierge end, and no
    // test could see it because the component suites pass their own value. This asserts the
    // PRODUCTION wiring: patch the cable into the pair, then compare the row's box against the
    // shared rule for `jointOpen: true`.
    seedPeople(ADA);
    // The pair must have a SELECTED AGENT as well as a patched cable: `effectiveWired` projects a
    // circuit with nothing on the far end back to "off" (a cable plugged into nothing is not a
    // circuit), so patching alone would leave `jointOpen` false and this test would assert the
    // unwired box while claiming to have wired it.
    const project = seedProject();
    project.selectedAgentId = "a1";
    useProjectStore.setState({ projects: [project] } as never);
    // `null` far end — this suite is about which ROWS render, not about who the concierge talks to.
    useCableStore.getState().patch(SPARKLE_PANE_SIDE, null);
    render(<AgentSidebar project={project} />);

    const row = screen.getByTestId(PERSON_ROW_TESTID);
    const wired = rowBoxFor({ paneSide: SPARKLE_PANE_SIDE, jointOpen: true, isActive: false });
    const unwired = rowBoxFor({ paneSide: SPARKLE_PANE_SIDE, jointOpen: false, isActive: false });
    // The two really do differ, or the assertion below could not distinguish them.
    expect(wired.padLeft).not.toBe(unwired.padLeft);
    expect(row.style.paddingLeft).toBe(`${wired.padLeft}px`);
    expect(row.style.marginLeft).toBe(`${wired.marginLeft}px`);
  });

  it("never puts a SECOND mouth in the column — only the row that owns the pane draws one", () => {
    // A selected agent row paints `row-mouth-*`, which `rowAnatomy` documents as the claim "this
    // row feeds its terminal". Selecting a person does not move the pane before U6, so a person
    // row painting one too would give the column two rows each asserting a junction one of them
    // does not own.
    seedPeople(ADA);
    const project = seedProject();
    project.selectedAgentId = "a1";
    useProjectStore.setState({ projects: [project] } as never);
    render(<AgentSidebar project={project} />);

    // Baseline: the selected AGENT owns the pane and says so.
    expect(screen.getAllByTestId("row-mouth-top").length).toBe(1);

    fireEvent.click(screen.getByTestId(PERSON_ROW_TESTID));
    expect(screen.getByTestId(PERSON_ROW_TESTID).getAttribute("aria-selected")).toBe("true");
    // Still exactly one, and it is still the agent's.
    const mouths = screen.getAllByTestId("row-mouth-top");
    expect(mouths.length).toBe(1);
    expect(document.querySelector("[data-chat-tree]")?.contains(mouths[0] ?? null)).toBe(false);
  });

  it("renders only in the primary pair", () => {
    seedPeople(ADA);
    // `forcePairSide` is how a satellite column names its own side. The far side is not the pane
    // Sparkle lives on, and v1 has exactly one Chat block.
    const other = SPARKLE_PANE_SIDE === "right" ? "left" : "right";
    render(<AgentSidebar project={seedProject()} forcePairSide={other} />);
    expect(screen.queryByRole("tree", { name: "Chats" })).toBeNull();
    expect(screen.queryAllByTestId(PERSON_ROW_TESTID).length).toBe(0);
  });

  it("stays out of Plan mode, whose sidebar list is deliberately clear", () => {
    seedPeople(ADA);
    useUiStore.setState({
      workModeBySide: { left: "plan", right: "plan" },
    } as never);
    render(<AgentSidebar project={seedProject()} />);
    expect(screen.queryByRole("tree", { name: "Chats" })).toBeNull();
  });
});
