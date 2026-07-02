// @vitest-environment jsdom
//
// Component-wiring tests for the pinned-prompt history dropdown (PinnedPrompt). Covers row
// interaction: hovering a row (or selecting it) reveals the Copy / Send to Composer / Jump
// actions, clicking selects, a second click expands the full selectable prompt, and rows carry
// no `title` tooltip. The dropdown also opens on hover over the header. With no prompt yet the
// component renders nothing. Jump scrolls the terminal to where a prompt was sent (or reports
// "scrolled out"). The clipboard boundary is mocked.
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

describe("PinnedPrompt — empty state", () => {
  it("renders nothing (no placeholder header) until there is a prompt", () => {
    const { container } = render(<PinnedPrompt prompt="" history={[]} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText(/no prompt yet/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Show prompt history" })).toBeNull();
  });
});

describe("PinnedPrompt — hover", () => {
  it("opens the dropdown on hover over the header, without a click", () => {
    render(<PinnedPrompt prompt="second prompt" history={HISTORY} />);
    expect(screen.queryByRole("listbox", { name: "Prompt history" })).toBeNull();
    const root = screen.getByTestId("pinned-prompt-root");
    fireEvent.mouseEnter(root);
    expect(screen.getByRole("listbox", { name: "Prompt history" })).toBeTruthy();
    fireEvent.mouseLeave(root);
    expect(screen.queryByRole("listbox", { name: "Prompt history" })).toBeNull();
  });

  it("reveals a row's Copy action on hover, without selecting it, and hides it on leave", () => {
    setup();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
    fireEvent.mouseEnter(rowA());
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
    expect(rowA().getAttribute("aria-selected")).toBe("false"); // hover reveals, doesn't select
    fireEvent.mouseLeave(rowA());
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  });

  it("keeps a selected row's actions visible after the pointer leaves it (still in menu)", () => {
    setup();
    fireEvent.click(rowA()); // select via click
    fireEvent.mouseEnter(rowA());
    // Pointer moves off the row but stays within the dropdown (relatedTarget inside the root), so
    // the menu doesn't close — only this row's hover ends. The row stays selected, so its actions
    // remain via the `selected` half of `showActions`.
    const list = screen.getByRole("listbox", { name: "Prompt history" });
    fireEvent.mouseLeave(rowA(), { relatedTarget: list });
    expect(rowA().getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy(); // shown via `selected`
  });
});

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
    expect(screen.queryByRole("listbox", { name: "Prompt history" })).toBeNull(); // closed
  });

  it("Send to Composer hands the full raw prompt to the parent and closes", () => {
    const { onSendToComposer } = setup();
    fireEvent.click(rowB());
    fireEvent.click(screen.getByRole("button", { name: "Send to Composer" }));
    expect(onSendToComposer).toHaveBeenCalledWith("second prompt\nwith a second line");
    expect(screen.queryByRole("listbox", { name: "Prompt history" })).toBeNull(); // closed
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

describe("PinnedPrompt — breadcrumb bar", () => {
  it("shows the last ≤4 prompts as a breadcrumb, oldest→newest, dropping older ones", () => {
    const long: PromptHistoryEntry[] = [
      { id: "1", text: "p1", at: 1 },
      { id: "2", text: "p2", at: 2 },
      { id: "3", text: "p3", at: 3 },
      { id: "4", text: "p4", at: 4 },
      { id: "5", text: "p5", at: 5 },
    ];
    render(<PinnedPrompt prompt="p5" history={long} />);
    // The oldest (p1) is dropped; the four most recent show (dropdown is closed, so these are the
    // breadcrumb segments, not dropdown rows).
    expect(screen.queryByText("p1")).toBeNull();
    for (const t of ["p2", "p3", "p4", "p5"]) expect(screen.getByText(t)).toBeTruthy();
  });

  it("collapses newlines in a segment to one line", () => {
    render(<PinnedPrompt prompt="second prompt" history={HISTORY} />);
    // entry b's raw text has a newline; the breadcrumb segment renders it collapsed.
    expect(screen.getByText("second prompt with a second line")).toBeTruthy();
  });

  it("renders one segment per prompt when there are fewer than four", () => {
    const { container } = render(<PinnedPrompt prompt="second prompt" history={HISTORY} />);
    expect(container.querySelectorAll('[data-testid^="ph-crumb-"]')).toHaveLength(2);
    expect(screen.getByTestId("ph-crumb-a")).toBeTruthy();
    expect(screen.getByTestId("ph-crumb-b")).toBeTruthy();
  });

  it("clicking a segment (dropdown closed) opens it with that prompt selected and expanded", () => {
    render(<PinnedPrompt prompt="second prompt" history={HISTORY} />);
    expect(screen.queryByRole("listbox", { name: "Prompt history" })).toBeNull();
    // Click the OLDER segment ("first prompt" = entry a) — the dropdown opens on that row.
    fireEvent.click(screen.getByTestId("ph-crumb-a"));
    expect(screen.getByRole("listbox", { name: "Prompt history" })).toBeTruthy();
    expect(rowA().getAttribute("aria-selected")).toBe("true");
    expect(rowA().getAttribute("data-expanded")).toBe("true");
    // Its actions are available immediately (selected row reveals them).
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
  });

  it("clicking a segment while the dropdown is already open (hover) selects+expands it", () => {
    render(<PinnedPrompt prompt="second prompt" history={HISTORY} />);
    // Open on hover first (clean slate — nothing selected), exercising onCrumbClick's `open` branch.
    fireEvent.mouseEnter(screen.getByTestId("pinned-prompt-root"));
    expect(rowA().getAttribute("aria-selected")).toBe("false");
    fireEvent.click(screen.getByTestId("ph-crumb-a"));
    expect(rowA().getAttribute("aria-selected")).toBe("true");
    expect(rowA().getAttribute("data-expanded")).toBe("true");
  });

  it("the caret opens the full history with nothing pre-selected (clean slate)", () => {
    render(<PinnedPrompt prompt="second prompt" history={HISTORY} />);
    fireEvent.click(screen.getByRole("button", { name: "Show prompt history" }));
    expect(screen.getByRole("listbox", { name: "Prompt history" })).toBeTruthy();
    expect(rowA().getAttribute("aria-selected")).toBe("false");
    expect(rowB().getAttribute("aria-selected")).toBe("false");
  });
});

describe("PinnedPrompt — Jump action", () => {
  it("offers Jump only when an onJumpToPrompt handler is provided", () => {
    setup(); // no onJumpToPrompt
    fireEvent.click(rowA());
    expect(screen.queryByRole("button", { name: "Jump" })).toBeNull();
  });

  it("Jump scrolls to the row's prompt id and closes when the marker is live", () => {
    const onJumpToPrompt = vi.fn(() => "scrolled" as const);
    setup({ onJumpToPrompt });
    fireEvent.click(rowB());
    fireEvent.click(screen.getByRole("button", { name: "Jump" }));
    expect(onJumpToPrompt).toHaveBeenCalledWith("b"); // newest row = entry b
    expect(screen.queryByRole("listbox", { name: "Prompt history" })).toBeNull(); // closed
  });

  it("Jump reports 'scrolled out' and keeps the menu open when the marker is gone", () => {
    const onJumpToPrompt = vi.fn(() => "missing" as const);
    setup({ onJumpToPrompt });
    fireEvent.click(rowB());
    fireEvent.click(screen.getByRole("button", { name: "Jump" }));
    expect(screen.getByRole("alert").textContent).toMatch(/scrolled out/i);
    // Menu stays open so the note is visible (the listbox is still mounted).
    expect(screen.getByRole("listbox", { name: "Prompt history" })).toBeTruthy();
  });
});
