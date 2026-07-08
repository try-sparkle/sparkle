// @vitest-environment jsdom
//
// The "Close this worker?" modal: copy, the green-stroke "Close worker" button, and the quieter
// "keep it open" link. Escape / backdrop default to the non-destructive keep.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CloseWorkerPrompt } from "./CloseWorkerPrompt";

afterEach(() => cleanup());

describe("CloseWorkerPrompt", () => {
  it("renders the recommendation copy and both actions", () => {
    render(<CloseWorkerPrompt onClose={vi.fn()} onKeep={vi.fn()} />);
    expect(screen.getByText("Close this worker?")).toBeTruthy();
    expect(screen.getByText(/landed on main/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close worker" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "keep it open" })).toBeTruthy();
  });

  it("'Close worker' calls onClose, not onKeep", () => {
    const onClose = vi.fn();
    const onKeep = vi.fn();
    render(<CloseWorkerPrompt onClose={onClose} onKeep={onKeep} />);
    fireEvent.click(screen.getByRole("button", { name: "Close worker" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onKeep).not.toHaveBeenCalled();
  });

  it("'keep it open' calls onKeep, not onClose", () => {
    const onClose = vi.fn();
    const onKeep = vi.fn();
    render(<CloseWorkerPrompt onClose={onClose} onKeep={onKeep} />);
    fireEvent.click(screen.getByRole("button", { name: "keep it open" }));
    expect(onKeep).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Escape defaults to keep (non-destructive)", () => {
    const onClose = vi.fn();
    const onKeep = vi.fn();
    render(<CloseWorkerPrompt onClose={onClose} onKeep={onKeep} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onKeep).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
  });
});
