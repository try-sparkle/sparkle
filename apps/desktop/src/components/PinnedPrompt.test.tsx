// @vitest-environment jsdom
//
// Component-wiring tests for the pinned-prompt history dropdown (PinnedPrompt). Covers the
// row interaction added when scroll-to-prompt was dropped: click selects + reveals the
// Copy / Send to Composer actions, a second click expands the full selectable prompt, and
// rows carry no `title` tooltip. The clipboard boundary is mocked.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const copyToClipboard = vi.fn((_t: string) => Promise.resolve(true));
vi.mock("../clipboard", () => ({ copyToClipboard: (t: string) => copyToClipboard(t) }));

import { PinnedPrompt } from "./PinnedPrompt";
import type { PromptHistoryEntry } from "../types";

// Store keeps history oldest-first; the dropdown reverses it, so the rendered order is b, a.
const HISTORY: PromptHistoryEntry[] = [
  { id: "a", text: "first prompt", at: 1_000 },
  { id: "b", text: "second prompt\nwith a second line", at: 2_000 },
];

function setup(overrides: Partial<Parameters<typeof PinnedPrompt>[0]> = {}) {
  const onSendToComposer = vi.fn();
  render(
    <PinnedPrompt
      prompt="second prompt"
      history={HISTORY}
      onSendToComposer={onSendToComposer}
      {...overrides}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Show prompt history" }));
  return { onSendToComposer };
}

// Rows are plain list items (not buttons — the action buttons live inside), keyed by test id.
const rowA = () => screen.getByTestId("ph-row-a");
const rowB = () => screen.getByTestId("ph-row-b");

beforeEach(() => copyToClipboard.mockClear());
afterEach(() => cleanup());

describe("PinnedPrompt — row actions", () => {
  it("reveals Copy / Send to Composer only after a row is selected", () => {
    setup();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
    fireEvent.click(rowA());
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send to Composer" })).toBeTruthy();
  });

  it("shows the actions on the selected row only (not every row)", () => {
    setup();
    fireEvent.click(rowA());
    expect(screen.getAllByRole("button", { name: "Copy" })).toHaveLength(1);
  });

  it("expands the full multi-line text on the second click and collapses on the third", () => {
    setup();
    fireEvent.click(rowB());
    expect(rowB().getAttribute("data-expanded")).toBe("false");

    fireEvent.click(rowB());
    expect(rowB().getAttribute("data-expanded")).toBe("true");
    const full = screen.getByTestId("ph-full-b");
    expect(full.textContent).toContain("\n"); // raw text, not the collapsed one-liner
    expect(full.style.userSelect).toBe("text"); // user can drag-select part of it

    fireEvent.click(rowB());
    expect(rowB().getAttribute("data-expanded")).toBe("false");
  });

  it("supports keyboard selection (Arrow/Home/End) and expand via the listbox", () => {
    setup();
    const list = screen.getByRole("listbox", { name: "Prompt history" });

    fireEvent.keyDown(list, { key: "ArrowDown" }); // -1 -> 0 (newest = b)
    expect(rowB().getAttribute("aria-selected")).toBe("true");
    expect(rowA().getAttribute("aria-selected")).toBe("false");
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy(); // actions revealed
    expect(list.getAttribute("aria-activedescendant")).toBe("ph-opt-b");

    fireEvent.keyDown(list, { key: "ArrowDown" }); // 0 -> 1 (a)
    expect(rowA().getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(list, { key: "ArrowUp" }); // 1 -> 0 (b)
    expect(rowB().getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(list, { key: "End" }); // -> last (a)
    expect(rowA().getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(list, { key: "Home" }); // -> first (b)
    expect(rowB().getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(list, { key: "Enter" }); // expand the selected row
    expect(rowB().getAttribute("data-expanded")).toBe("true");
  });

  it("Copy writes the full raw prompt to the clipboard and closes the dropdown", () => {
    setup();
    fireEvent.click(rowB());
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(copyToClipboard).toHaveBeenCalledWith("second prompt\nwith a second line");
    expect(screen.queryByRole("button", { name: "first prompt" })).toBeNull(); // closed
  });

  it("Send to Composer hands the full raw prompt to the parent and closes", () => {
    const { onSendToComposer } = setup();
    fireEvent.click(rowB());
    fireEvent.click(screen.getByRole("button", { name: "Send to Composer" }));
    expect(onSendToComposer).toHaveBeenCalledWith("second prompt\nwith a second line");
    expect(screen.queryByRole("button", { name: "first prompt" })).toBeNull(); // closed
  });

  it("hides Send to Composer when no handler is provided (composer feature off)", () => {
    setup({ onSendToComposer: undefined });
    fireEvent.click(rowA());
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send to Composer" })).toBeNull();
  });

  it("never renders a title tooltip on a row, collapsed or expanded", () => {
    setup();
    expect(rowB().getAttribute("title")).toBeNull();
    fireEvent.click(rowB()); // select
    fireEvent.click(rowB()); // expand
    expect(rowB().getAttribute("title")).toBeNull();
  });
});
