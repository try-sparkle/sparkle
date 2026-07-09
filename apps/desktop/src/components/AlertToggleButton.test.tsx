// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AlertToggleButton } from "./AlertToggleButton";

afterEach(cleanup);

describe("AlertToggleButton", () => {
  it("shows 'Dismiss Alert' and fires onDismiss (not onReenable) on click", () => {
    const onDismiss = vi.fn();
    const onReenable = vi.fn();
    render(
      <AlertToggleButton
        kind="dismiss"
        statusColor="#e0533f"
        onDismiss={onDismiss}
        onReenable={onReenable}
      />,
    );
    const btn = screen.getByRole("button", { name: "Dismiss Alert" });
    fireEvent.click(btn);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onReenable).not.toHaveBeenCalled();
  });

  it("shows 'Re-enable Alert' and fires onReenable (not onDismiss) on click", () => {
    const onDismiss = vi.fn();
    const onReenable = vi.fn();
    render(
      <AlertToggleButton
        kind="reenable"
        statusColor="#888"
        onDismiss={onDismiss}
        onReenable={onReenable}
      />,
    );
    const btn = screen.getByRole("button", { name: "Re-enable Alert" });
    fireEvent.click(btn);
    expect(onReenable).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("stops the click from bubbling to the row (so it doesn't select/collapse the card)", () => {
    const onRowClick = vi.fn();
    render(
      <div onClick={onRowClick}>
        <AlertToggleButton
          kind="dismiss"
          statusColor="#e0533f"
          onDismiss={vi.fn()}
          onReenable={vi.fn()}
        />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss Alert" }));
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("uses statusColor for its text + border so it stays theme-legible", () => {
    render(
      <AlertToggleButton
        kind="dismiss"
        statusColor="rgb(224, 83, 63)"
        onDismiss={vi.fn()}
        onReenable={vi.fn()}
      />,
    );
    const btn = screen.getByRole("button", { name: "Dismiss Alert" });
    expect(btn.style.color).toBe("rgb(224, 83, 63)");
    expect(btn.style.border).toContain("rgb(224, 83, 63)");
  });
});
