// @vitest-environment jsdom
//
// TrayDashboard render + interaction tests. We mock @tauri-apps/plugin-opener so
// importing AgentSidebar (for formatElapsed) doesn't fail in the node/jsdom runner.
// cleanup is called after each test so DOM state doesn't bleed between renders.
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));

import { TrayDashboard } from "./TrayDashboard";
import type { TrayRoster } from "./trayRoster";

afterEach(cleanup);

const roster: TrayRoster = {
  counts: { red: 1, grey: 0, green: 1 },
  projects: [
    { id: "p1", name: "Alpha", agents: [
      { id: "b1", name: "Builder", kind: "build", status: "working", status_color: "#34c759", status_label: "Working", parent_id: null },
      { id: "w1", name: "Worker A", kind: "worker", status: "waiting", status_color: "#e0533f", status_label: "Needs you", parent_id: "b1" },
    ] },
  ],
};

describe("TrayDashboard", () => {
  it("renders the project header, agent names, and worker nested under its build parent", () => {
    render(<TrayDashboard roster={roster} now={Date.now()} onOpen={() => {}} />);
    expect(screen.getByText("Alpha")).toBeTruthy();
    // "Builder" appears once in the project section (status "working" → not in "Needs you" card)
    expect(screen.getByText("Builder")).toBeTruthy();
    expect(screen.getByText("Worker A")).toBeTruthy();
    // "Needs you" appears in: section header, pending-card status label, and AgentRow label
    expect(screen.getAllByText("Needs you").length).toBeGreaterThan(0);
  });

  it("calls onOpen with project+agent id (no prompt) when a row is clicked", () => {
    const onOpen = vi.fn();
    render(<TrayDashboard roster={roster} now={Date.now()} onOpen={onOpen} />);
    // Click the AgentRow name span for Builder (no recent_prompts → fallback title, no scroll target)
    fireEvent.click(screen.getByText("Builder"));
    expect(onOpen).toHaveBeenCalledWith("p1", "b1", undefined);
  });

  it("renders a recent-prompts breadcrumb and jumps to the clicked prompt", () => {
    const onOpen = vi.fn();
    const r: TrayRoster = {
      counts: { red: 0, grey: 0, green: 1 },
      projects: [
        { id: "p1", name: "Alpha", agents: [
          { id: "b1", name: "Builder", kind: "build", status: "working", status_color: "#34c759", status_label: "Working", parent_id: null,
            recent_prompts: [
              { id: "t1", text: "fix the login bug now" },
              { id: "t2", text: "add dark mode toggle please" },
            ] },
        ] },
      ],
    };
    render(<TrayDashboard roster={r} now={Date.now()} onOpen={onOpen} />);
    // Each crumb shows ~4 words + ellipsis; the agent's title ("Builder") is replaced by the breadcrumb.
    expect(screen.queryByText("Builder")).toBeNull();
    // Clicking the most-recent crumb jumps to that prompt id (t2).
    fireEvent.click(screen.getByText("add dark mode toggle…"));
    expect(onOpen).toHaveBeenCalledWith("p1", "b1", "t2");
    // Clicking an earlier crumb jumps to its id (t1).
    fireEvent.click(screen.getByText("fix the login bug…"));
    expect(onOpen).toHaveBeenCalledWith("p1", "b1", "t1");
  });

  it("calls onOpen with project+agent id when a Needs-you pending card is clicked", () => {
    const onOpen = vi.fn();
    render(<TrayDashboard roster={roster} now={Date.now()} onOpen={onOpen} />);
    // The pending card renders "{projectName} · {agent.name}" — only occurrence of this combined text
    fireEvent.click(screen.getByText("Alpha · Worker A"));
    expect(onOpen).toHaveBeenCalledWith("p1", "w1");
  });

  it("shows the empty state when there are no projects", () => {
    render(<TrayDashboard roster={{ counts: { red: 0, grey: 0, green: 0 }, projects: [] }} now={0} onOpen={() => {}} />);
    expect(screen.getByText("No projects running.")).toBeTruthy();
  });

  it("renders project groups in alphabetical order regardless of input order", () => {
    const unordered: TrayRoster = {
      counts: { red: 0, grey: 2, green: 0 },
      projects: [
        { id: "pz", name: "Zebra", agents: [
          { id: "z1", name: "ZAgent", kind: "build", status: "idle", status_color: "#8aa0c4", status_label: "Idle", parent_id: null },
        ] },
        { id: "pa", name: "Aardvark", agents: [
          { id: "a1", name: "AAgent", kind: "build", status: "idle", status_color: "#8aa0c4", status_label: "Idle", parent_id: null },
        ] },
      ],
    };
    render(<TrayDashboard roster={unordered} now={0} onOpen={() => {}} />);
    const headers = screen.getAllByText(/^(Zebra|Aardvark)$/);
    expect(headers).toHaveLength(2);
    expect(headers[0]!.textContent).toBe("Aardvark");
    expect(headers[1]!.textContent).toBe("Zebra");
  });
});
