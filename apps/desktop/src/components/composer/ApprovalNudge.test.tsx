// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { ApprovalNudge } from "./ApprovalNudge";

// The write actions are injected so the component test never touches the Tauri config runtime.
function setup(over: Partial<Parameters<typeof ApprovalNudge>[0]> = {}) {
  const props = {
    category: "bash" as const,
    projectRoot: "/repo",
    onDismiss: vi.fn(),
    onOpenOptions: vi.fn(),
    setAlways: vi.fn(),
    setNever: vi.fn(),
    autoDismissMs: 4000,
    ...over,
  };
  render(<ApprovalNudge {...props} />);
  return props;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ApprovalNudge", () => {
  it("shows the nudge with the friendly category label", () => {
    setup();
    expect(screen.getByText("Auto-approve all commands next time?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Yes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "No" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Never" })).toBeTruthy();
  });

  it("Yes → writes 'always' to the project and shows the confirmation toast with a working Options link", () => {
    const p = setup();
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    expect(p.setAlways).toHaveBeenCalledWith("bash", "/repo");
    // Transitioned to the confirm toast.
    expect(screen.getByTestId("approval-confirm")).toBeTruthy();
    expect(screen.getByText(/auto-answer for you on commands prompts in this project/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Options" }));
    expect(p.onOpenOptions).toHaveBeenCalledTimes(1);
    // Clicking Options must NOT also dismiss (stopPropagation).
    expect(p.onDismiss).not.toHaveBeenCalled();
  });

  it("confirmation copy says 'all projects' when there is no project root (global fallback)", () => {
    setup({ projectRoot: null });
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    expect(screen.getByText(/auto-answer for you on commands prompts in all projects/i)).toBeTruthy();
  });

  it("the confirmation toast auto-dismisses after the timeout", () => {
    const p = setup({ autoDismissMs: 3000 });
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    expect(p.onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(p.onDismiss).toHaveBeenCalledTimes(1);
  });

  it("No → dismisses without writing any rule", () => {
    const p = setup();
    fireEvent.click(screen.getByRole("button", { name: "No" }));
    expect(p.onDismiss).toHaveBeenCalledTimes(1);
    expect(p.setAlways).not.toHaveBeenCalled();
    expect(p.setNever).not.toHaveBeenCalled();
  });

  it("Never → writes 'never' to the project and dismisses", () => {
    const p = setup();
    fireEvent.click(screen.getByRole("button", { name: "Never" }));
    expect(p.setNever).toHaveBeenCalledWith("bash", "/repo");
    expect(p.onDismiss).toHaveBeenCalledTimes(1);
    expect(p.setAlways).not.toHaveBeenCalled();
  });
});
