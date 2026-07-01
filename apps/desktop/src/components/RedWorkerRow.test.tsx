// @vitest-environment jsdom
//
// The minimal pop-out row for a RED worker: dot + name, clickable to open. These pin the contract
// AgentSidebar relies on — the name is rendered, the row is a button labelled with its status, and a
// click (or Enter/Space) fires onSelect — plus the deliberate absence of the heavier row chrome.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RedWorkerRow } from "./RedWorkerRow";

afterEach(cleanup);

describe("RedWorkerRow", () => {
  it("renders the worker name and a status-labelled button", () => {
    render(<RedWorkerRow name="Fix the parser" status="waiting" active={false} onSelect={() => {}} />);
    expect(screen.getByText("Fix the parser")).toBeTruthy();
    // aria-label carries "<name> — <status label>" so the row is reachable + screen-reader clear.
    expect(screen.getByRole("button", { name: /Fix the parser — Needs you/i })).toBeTruthy();
  });

  it("labels an errored worker with the errored status", () => {
    render(<RedWorkerRow name="Build API" status="errored" active={false} onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: /Build API — Errored/i })).toBeTruthy();
  });

  it("fires onSelect on click", () => {
    const onSelect = vi.fn();
    render(<RedWorkerRow name="W" status="approval" active={false} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("fires onSelect on Enter and Space (keyboard reachable)", () => {
    const onSelect = vi.fn();
    render(<RedWorkerRow name="W" status="approval" active={false} onSelect={onSelect} />);
    const row = screen.getByRole("button");
    fireEvent.keyDown(row, { key: "Enter" });
    fireEvent.keyDown(row, { key: " " });
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it("stays minimal — no elapsed timer, no drag handle (just dot + name)", () => {
    render(<RedWorkerRow name="Only A Name" status="waiting" active={false} onSelect={() => {}} />);
    const row = screen.getByRole("button");
    // Not draggable (that's the orchestrator/AgentRow affordance), and no "· Nm" elapsed suffix.
    expect(row.getAttribute("draggable")).not.toBe("true");
    expect(row.textContent).toBe("Only A Name");
  });
});
