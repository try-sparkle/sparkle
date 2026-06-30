// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloseAgentPrompt } from "./CloseAgentPrompt";

afterEach(cleanup);

function setup(unsaved = false) {
  const onShip = vi.fn();
  const onSave = vi.fn();
  const onDiscard = vi.fn();
  const onCancel = vi.fn();
  render(
    <CloseAgentPrompt
      agentName="My Agent"
      unsaved={unsaved}
      onShip={onShip}
      onSave={onSave}
      onDiscard={onDiscard}
      onCancel={onCancel}
    />,
  );
  return { onShip, onSave, onDiscard, onCancel };
}

describe("CloseAgentPrompt", () => {
  it("fires Ship / Save from the choice screen", () => {
    const { onShip, onSave, onCancel } = setup();
    fireEvent.click(screen.getByText("Ship it"));
    expect(onShip).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Save for later"));
    expect(onSave).toHaveBeenCalledTimes(1);
    // The action buttons must NOT trigger the no-op cancel.
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("Discard requires an explicit confirm step before firing (destructive guard)", () => {
    const { onDiscard } = setup();
    // First click opens the confirm screen — it does NOT discard yet.
    fireEvent.click(screen.getByText("Discard"));
    expect(onDiscard).not.toHaveBeenCalled();
    // Only the explicit confirm fires it.
    fireEvent.click(screen.getByText("Delete permanently"));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it("Escape on the choice screen is a true no-op (onCancel), not a destructive action", () => {
    const { onCancel, onSave, onDiscard } = setup();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it("names the agent and reflects unsaved vs committed work", () => {
    setup(true);
    expect(screen.getByText(/My Agent/)).toBeTruthy();
    expect(screen.getByText(/uncommitted changes/)).toBeTruthy();
  });
});
