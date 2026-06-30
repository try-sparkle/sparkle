// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SuggestionRow } from "./SuggestionRow";
import type { SuggestionButton } from "../../services/suggestions/types";

const btns: SuggestionButton[] = [
  { id: "a", label: "Rebase main, Issue PR, merge", value: "Rebase and PR.", kind: "prompt", source: "learned" },
  { id: "b", label: "Approve", value: "y\n", kind: "terminal", source: "heuristic" },
];

afterEach(cleanup);

describe("SuggestionRow", () => {
  it("renders nothing when not visible", () => {
    const { container } = render(
      <SuggestionRow buttons={btns} visible={false} onClick={() => {}} onDismiss={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when there are no buttons", () => {
    const { container } = render(
      <SuggestionRow buttons={[]} visible={true} onClick={() => {}} onDismiss={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders one pill per button, most-likely first", () => {
    render(<SuggestionRow buttons={btns} visible={true} onClick={() => {}} onDismiss={() => {}} />);
    expect(screen.getByText("Rebase main, Issue PR, merge")).toBeTruthy();
    expect(screen.getByText("Approve")).toBeTruthy();
  });

  it("calls onClick with the button when the label is clicked", () => {
    const onClick = vi.fn();
    render(<SuggestionRow buttons={btns} visible={true} onClick={onClick} onDismiss={() => {}} />);
    fireEvent.click(screen.getByText("Approve"));
    expect(onClick).toHaveBeenCalledWith(btns[1]);
  });

  it("calls onDismiss with the id when × is clicked", () => {
    const onDismiss = vi.fn();
    render(<SuggestionRow buttons={btns} visible={true} onClick={() => {}} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByLabelText("Dismiss Approve"));
    expect(onDismiss).toHaveBeenCalledWith("b");
  });
});
