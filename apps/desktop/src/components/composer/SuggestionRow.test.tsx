// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SuggestionRow } from "./SuggestionRow";
import type { SuggestionButton } from "../../services/suggestions/types";

const three: SuggestionButton[] = [
  { id: "a", label: "Rebase main, Issue PR, merge", value: "Rebase and PR.", kind: "prompt", source: "learned" },
  { id: "b", label: "Approve", value: "y\n", kind: "terminal", source: "heuristic" },
  { id: "c", label: "Run the tests", value: "Run the test suite.", kind: "prompt", source: "learned" },
];
const one: SuggestionButton[] = [three[0]!];

afterEach(cleanup);

describe("SuggestionRow", () => {
  it("renders nothing when not visible", () => {
    const { container } = render(
      <SuggestionRow buttons={three} visible={false} onClick={() => {}} onDismiss={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when there are no buttons", () => {
    const { container } = render(
      <SuggestionRow buttons={[]} visible={true} onClick={() => {}} onDismiss={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("with a single candidate: no caret is rendered and clicking the pill runs it", () => {
    const onClick = vi.fn();
    render(<SuggestionRow buttons={one} visible={true} onClick={onClick} onDismiss={() => {}} />);
    expect(screen.getByText("Rebase main, Issue PR, merge")).toBeTruthy();
    expect(screen.queryByLabelText("More suggested actions")).toBeNull();
    fireEvent.click(screen.getByText("Rebase main, Issue PR, merge"));
    expect(onClick).toHaveBeenCalledWith(one[0]);
  });

  it("with 3 candidates: only the primary shows at rest — no popover, but a caret is present", () => {
    render(<SuggestionRow buttons={three} visible={true} onClick={() => {}} onDismiss={() => {}} />);
    expect(screen.getByText("Rebase main, Issue PR, merge")).toBeTruthy();
    // #2 and #3 are hidden behind the caret until it's pressed.
    expect(screen.queryByText("Approve")).toBeNull();
    expect(screen.queryByText("Run the tests")).toBeNull();
    const caret = screen.getByLabelText("More suggested actions");
    expect(caret.getAttribute("aria-expanded")).toBe("false");
  });

  it("pressing the caret reveals candidates #2 and #3 as clickable buttons", () => {
    render(<SuggestionRow buttons={three} visible={true} onClick={() => {}} onDismiss={() => {}} />);
    fireEvent.click(screen.getByLabelText("More suggested actions"));
    expect(screen.getByLabelText("More suggested actions").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run the tests" })).toBeTruthy();
  });

  it("clicking a popover item runs THAT button and closes the popover", () => {
    const onClick = vi.fn();
    render(<SuggestionRow buttons={three} visible={true} onClick={onClick} onDismiss={() => {}} />);
    fireEvent.click(screen.getByLabelText("More suggested actions"));
    fireEvent.click(screen.getByRole("button", { name: "Run the tests" }));
    expect(onClick).toHaveBeenCalledWith(three[2]);
    // Popover closed: the item is gone and the caret reports collapsed.
    expect(screen.queryByRole("button", { name: "Run the tests" })).toBeNull();
    expect(screen.getByLabelText("More suggested actions").getAttribute("aria-expanded")).toBe("false");
  });

  it("Escape closes the popover", () => {
    render(<SuggestionRow buttons={three} visible={true} onClick={() => {}} onDismiss={() => {}} />);
    fireEvent.click(screen.getByLabelText("More suggested actions"));
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("an outside pointerdown closes the popover", () => {
    render(<SuggestionRow buttons={three} visible={true} onClick={() => {}} onDismiss={() => {}} />);
    fireEvent.click(screen.getByLabelText("More suggested actions"));
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("re-hiding the row closes any open popover (no stale-open on re-show)", () => {
    const { rerender } = render(
      <SuggestionRow buttons={three} visible={true} onClick={() => {}} onDismiss={() => {}} />,
    );
    fireEvent.click(screen.getByLabelText("More suggested actions"));
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    rerender(<SuggestionRow buttons={three} visible={false} onClick={() => {}} onDismiss={() => {}} />);
    rerender(<SuggestionRow buttons={three} visible={true} onClick={() => {}} onDismiss={() => {}} />);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.getByLabelText("More suggested actions").getAttribute("aria-expanded")).toBe("false");
  });

  it("clicking the primary pill runs buttons[0] (top action) even when extras exist", () => {
    const onClick = vi.fn();
    render(<SuggestionRow buttons={three} visible={true} onClick={onClick} onDismiss={() => {}} />);
    fireEvent.click(screen.getByText("Rebase main, Issue PR, merge"));
    expect(onClick).toHaveBeenCalledWith(three[0]);
  });

  it("calls onDismiss with the id when × is clicked", () => {
    const onDismiss = vi.fn();
    render(<SuggestionRow buttons={three} visible={true} onClick={() => {}} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByLabelText("Dismiss Rebase main, Issue PR, merge"));
    expect(onDismiss).toHaveBeenCalledWith("a");
  });
});
