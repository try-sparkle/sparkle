// @vitest-environment jsdom
//
// The surfaced sub-agent row: dot + name ABOVE its own blue bar (WorkflowLine), clickable to open,
// with a ✕ only when manually pinned. These pin the contract AgentSidebar relies on — the name is
// rendered and status-labelled, a click (or Enter/Space) fires onSelect, the bar renders for a
// stage, and the ✕ (pinned only) un-pins WITHOUT selecting.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubAgentRow } from "./SubAgentRow";

afterEach(cleanup);

describe("SubAgentRow", () => {
  it("renders the worker name and a status-labelled button", () => {
    render(
      <SubAgentRow
        name="Fix the parser"
        status="waiting"
        stage="building_unsaved"
        active={false}
        pinned={false}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText("Fix the parser")).toBeTruthy();
    // aria-label carries "<name> — <status label>" so the row is reachable + screen-reader clear.
    expect(screen.getByRole("button", { name: /Fix the parser — Needs you/i })).toBeTruthy();
  });

  it("labels an errored worker with the errored status", () => {
    render(
      <SubAgentRow
        name="Build API"
        status="errored"
        stage="building_unsaved"
        active={false}
        pinned={false}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /Build API — Errored/i })).toBeTruthy();
  });

  it("fires onSelect on click of the name", () => {
    const onSelect = vi.fn();
    render(
      <SubAgentRow
        name="W"
        status="approval"
        stage="building_unsaved"
        active={false}
        pinned={false}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /W — Approve/i }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("fires onSelect on Enter and Space (keyboard reachable)", () => {
    const onSelect = vi.fn();
    render(
      <SubAgentRow
        name="W"
        status="approval"
        stage="building_unsaved"
        active={false}
        pinned={false}
        onSelect={onSelect}
      />,
    );
    const row = screen.getByRole("button", { name: /W — Approve/i });
    fireEvent.keyDown(row, { key: "Enter" });
    fireEvent.keyDown(row, { key: " " });
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it("renders its own blue bar (WorkflowLine) for a stage, and none when stage is null", () => {
    const { rerender } = render(
      <SubAgentRow
        name="W"
        status="working"
        stage="building_unsaved"
        active={false}
        pinned={false}
        onSelect={() => {}}
      />,
    );
    // WorkflowLine renders a role="img" bar labelled "Workflow stage: …".
    expect(screen.getByRole("img", { name: /Workflow stage/i })).toBeTruthy();
    rerender(
      <SubAgentRow
        name="W"
        status="working"
        stage={null}
        active={false}
        pinned={false}
        onSelect={() => {}}
      />,
    );
    expect(screen.queryByRole("img", { name: /Workflow stage/i })).toBeNull();
  });

  it("shows the ✕ only when pinned, and unpinning does NOT select the row", () => {
    const onSelect = vi.fn();
    const onUnpin = vi.fn();
    const { rerender } = render(
      <SubAgentRow
        name="Pinned One"
        status="working"
        stage="building_unsaved"
        active={false}
        pinned={false}
        onSelect={onSelect}
        onUnpin={onUnpin}
      />,
    );
    // Not pinned → no ✕.
    expect(screen.queryByRole("button", { name: /Unpin Pinned One/i })).toBeNull();

    rerender(
      <SubAgentRow
        name="Pinned One"
        status="working"
        stage="building_unsaved"
        active={false}
        pinned={true}
        onSelect={onSelect}
        onUnpin={onUnpin}
      />,
    );
    const x = screen.getByRole("button", { name: /Unpin Pinned One/i });
    fireEvent.click(x);
    expect(onUnpin).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled(); // the ✕ stops propagation to the row's onSelect
  });

  it("calls the hover-group hooks on enter/leave", () => {
    const onHoverEnter = vi.fn();
    const onHoverLeave = vi.fn();
    render(
      <SubAgentRow
        name="W"
        status="working"
        stage="building_unsaved"
        active={false}
        pinned={false}
        onSelect={() => {}}
        onHoverEnter={onHoverEnter}
        onHoverLeave={onHoverLeave}
      />,
    );
    const row = screen.getByRole("button", { name: /W — /i }).parentElement!.parentElement!;
    fireEvent.mouseEnter(row);
    fireEvent.mouseLeave(row);
    expect(onHoverEnter).toHaveBeenCalledTimes(1);
    expect(onHoverLeave).toHaveBeenCalledTimes(1);
  });
});
