// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MentionPicker, nextIndex } from "./MentionPicker";
import { EXPERT_ROSTER } from "../services/expertRoster";

afterEach(cleanup);

describe("nextIndex", () => {
  it("moves forward and backward within range", () => {
    expect(nextIndex(0, 1, 5)).toBe(1);
    expect(nextIndex(3, -1, 5)).toBe(2);
  });

  it("wraps around both ends", () => {
    expect(nextIndex(4, 1, 5)).toBe(0);
    expect(nextIndex(0, -1, 5)).toBe(4);
  });

  it("returns 0 for an empty list", () => {
    expect(nextIndex(0, 1, 0)).toBe(0);
    expect(nextIndex(3, -1, 0)).toBe(0);
  });
});

describe("MentionPicker", () => {
  it("renders @chief first, ahead of the roster", () => {
    render(<MentionPicker query="" onPick={() => {}} onClose={() => {}} />);
    const list = screen.getByTestId("mention-picker-list");
    const handles = within(list)
      .getAllByRole("option")
      .map((el) => within(el).getByText(/^@/).textContent);
    expect(handles[0]).toBe("@chief");
    expect(handles).toContain("@architect");
  });

  it("shows the whole roster (no clipping) for an empty query", () => {
    render(<MentionPicker query="" onPick={() => {}} onClose={() => {}} />);
    const options = within(screen.getByTestId("mention-picker-list")).getAllByRole("option");
    // @chief + every roster entry.
    expect(options).toHaveLength(EXPERT_ROSTER.length + 1);
  });

  it("filters the roster as the query changes", () => {
    render(<MentionPicker query="account" onPick={() => {}} onClose={() => {}} />);
    expect(screen.getByText("@account-executive")).toBeTruthy();
    expect(screen.getByText("@account-manager")).toBeTruthy();
    expect(screen.queryByText("@architect")).toBeNull();
    // @chief still leads the filtered list.
    const handles = within(screen.getByTestId("mention-picker-list"))
      .getAllByRole("option")
      .map((el) => within(el).getByText(/^@/).textContent);
    expect(handles[0]).toBe("@chief");
  });

  it("calls onPick with the chief target when @chief is clicked", () => {
    const onPick = vi.fn();
    render(<MentionPicker query="" onPick={onPick} onClose={() => {}} />);
    fireEvent.click(screen.getByText("@chief"));
    expect(onPick).toHaveBeenCalledWith({ handle: "chief", kind: "chief" });
  });

  it("calls onPick with the voice handle + kind when a roster row is clicked", () => {
    const onPick = vi.fn();
    render(<MentionPicker query="architect" onPick={onPick} onClose={() => {}} />);
    fireEvent.click(screen.getByText("@architect"));
    expect(onPick).toHaveBeenCalledWith({ handle: "architect", kind: "voice" });
  });

  it("navigates with arrows and picks with Enter", () => {
    const onPick = vi.fn();
    render(<MentionPicker query="account" onPick={onPick} onClose={() => {}} />);
    const picker = screen.getByTestId("mention-picker");
    // Row 0 is @chief; ArrowDown lands on the first roster entry.
    fireEvent.keyDown(picker, { key: "ArrowDown" });
    fireEvent.keyDown(picker, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith({ handle: "account-executive", kind: "voice" });
  });

  it("shows @chief plus a 'no matching voices' note when the query matches no voices", () => {
    render(<MentionPicker query="zzzznotarole" onPick={() => {}} onClose={() => {}} />);
    // @chief still answers, so it remains pickable...
    expect(screen.getByText("@chief")).toBeTruthy();
    // ...but the user gets a clear signal that the roster filter matched nothing.
    expect(screen.getByText(/no matching voices/i)).toBeTruthy();
    // Only the @chief option is present (no voice rows).
    const options = within(screen.getByTestId("mention-picker-list")).getAllByRole("option");
    expect(options).toHaveLength(1);
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<MentionPicker query="" onPick={() => {}} onClose={onClose} />);
    fireEvent.keyDown(screen.getByTestId("mention-picker"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("has a scrollable, height-bounded list so a long roster never clips", () => {
    render(<MentionPicker query="" onPick={() => {}} onClose={() => {}} />);
    const list = screen.getByTestId("mention-picker-list");
    expect(list.style.overflowY).toBe("auto");
    expect(list.style.maxHeight).not.toBe("");
    expect(parseInt(list.style.maxHeight, 10)).toBeGreaterThan(0);
  });
});
