// @vitest-environment jsdom
//
// Interaction tests for the Auto-approve pane's "Session resume" row (the sub-option that
// auto-answers Claude Code's resume prompt). The config writers and the per-project sync hook are
// mocked so the test never touches the Tauri runtime; we assert the row calls setResumeRule with
// the right (rule, scope) and that "this project" is disabled with no project in focus.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Config writers → spies (the real ones invoke Tauri).
const setResumeRule = vi.fn();
const setApprovalRule = vi.fn();
const removeApprovalRuleEverywhere = vi.fn();
vi.mock("../services/configActions", () => ({
  setResumeRule: (...a: unknown[]) => setResumeRule(...a),
  setApprovalRule: (...a: unknown[]) => setApprovalRule(...a),
  removeApprovalRuleEverywhere: (...a: unknown[]) => removeApprovalRuleEverywhere(...a),
}));
// The per-project config pull hook is a no-op in the test (it would call getConfig → Tauri).
vi.mock("../services/suggestions/approvalsRuntime", () => ({ useSyncProjectApprovals: () => {} }));
// Master toggle reads on; the pane content renders regardless anyway.
vi.mock("../services/aiGate", () => ({ useAiFeatureVisible: () => true }));

// Drive the "current project" from a controllable value.
let currentProjectId: string | null = null;
vi.mock("../windowContext", () => ({ useCurrentProjectId: () => currentProjectId }));

import { ApprovalsMenu } from "./ApprovalsMenu";
import { useSettingsStore } from "../stores/settingsStore";
import { useApprovalsStore } from "../stores/approvalsStore";
import { useProjectStore } from "../stores/projectStore";

const ROOT = "/repo";

beforeEach(() => {
  setResumeRule.mockClear();
  currentProjectId = null;
  useSettingsStore.setState({ approvals: {}, resumeRule: "ask" });
  useApprovalsStore.setState({ byRoot: {}, resumeByRoot: {} });
  useProjectStore.setState({ projects: [] });
});
afterEach(() => cleanup());

/** The two scope groups both carry a "Resume from summary" button; [0] = all-projects, [1] = this-project. */
const summaryButtons = () => screen.getAllByRole("button", { name: "Resume from summary" });

describe("ApprovalsMenu — Session resume row", () => {
  it("renders the three resume choices in both scope groups", () => {
    render(<ApprovalsMenu />);
    expect(screen.getByText("Session resume")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Ask each time" }).length).toBe(2);
    expect(summaryButtons().length).toBe(2);
    expect(screen.getAllByRole("button", { name: "Resume full session" }).length).toBe(2);
  });

  it("all-projects choice writes global scope; this-project choice writes project scope", () => {
    currentProjectId = "p1";
    useProjectStore.setState({
      projects: [{ id: "p1", name: "repo", rootPath: ROOT, agents: [] }] as never,
    });
    render(<ApprovalsMenu />);

    fireEvent.click(summaryButtons()[0]!); // all-projects
    expect(setResumeRule).toHaveBeenCalledWith("summary", "global", ROOT);

    fireEvent.click(summaryButtons()[1]!); // this-project
    expect(setResumeRule).toHaveBeenCalledWith("summary", "project", ROOT);

    fireEvent.click(screen.getAllByRole("button", { name: "Resume full session" })[0]!);
    expect(setResumeRule).toHaveBeenCalledWith("full", "global", ROOT);
  });

  it("disables the this-project resume buttons when no project is in focus", () => {
    currentProjectId = null; // no project
    render(<ApprovalsMenu />);
    const [allProjects, thisProject] = summaryButtons() as [HTMLButtonElement, HTMLButtonElement];
    expect(allProjects.disabled).toBe(false);
    expect(thisProject.disabled).toBe(true);
    expect(thisProject.getAttribute("title")).toBe("No project in focus");
  });

  it("reflects the effective global rule as the active button", () => {
    useSettingsStore.setState({ resumeRule: "summary" });
    render(<ApprovalsMenu />);
    // The all-projects "Resume from summary" is highlighted (teal background) when it's the effective rule.
    const active = summaryButtons()[0]!;
    expect(active.style.background).not.toBe("transparent");
  });
});
