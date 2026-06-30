// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloseAgentPrompt } from "./CloseAgentPrompt";

afterEach(cleanup);

function setup() {
  const onShip = vi.fn();
  const onSave = vi.fn();
  const onDiscard = vi.fn();
  const onCancel = vi.fn();
  render(
    <CloseAgentPrompt onShip={onShip} onSave={onSave} onDiscard={onDiscard} onCancel={onCancel} />,
  );
  return { onShip, onSave, onDiscard, onCancel };
}

describe("CloseAgentPrompt", () => {
  it("fires the matching handler for each of Ship / Save / Discard", () => {
    const { onShip, onSave, onDiscard, onCancel } = setup();
    fireEvent.click(screen.getByText("Ship it"));
    expect(onShip).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Keep it for later"));
    expect(onSave).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Discard it"));
    expect(onDiscard).toHaveBeenCalledTimes(1);
    // The action buttons must NOT trigger the no-op cancel.
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("Escape is a true no-op (onCancel), not a destructive Save", () => {
    const { onCancel, onSave } = setup();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });
});
