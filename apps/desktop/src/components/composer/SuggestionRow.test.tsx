// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

// Stub the Feather icons with identifiable markers so the CtaIcon branch (check for the control CTA,
// arrow for the prompt CTAs) is actually assertable. Without this the icon choice is invisible to
// the suite: react-icons all render as bare <svg>, so an inverted branch — or a CtaIcon returning
// null for everything — would stay green.
vi.mock("react-icons/fi", () => ({
  FiX: () => <span data-icon="x" />,
  FiCheck: () => <span data-icon="check" />,
  FiChevronDown: () => <span data-icon="chevron" />,
  FiArrowUpRight: () => <span data-icon="arrow" />,
}));

import { SuggestionRow } from "./SuggestionRow";
import { C } from "../../theme/colors";
import type { SuggestionButton } from "../../services/suggestions/types";

const three: SuggestionButton[] = [
  { id: "a", label: "Rebase main, Issue PR, merge", value: "Rebase and PR.", kind: "prompt", source: "learned" },
  { id: "b", label: "Approve", value: "y\n", kind: "terminal", source: "heuristic" },
  { id: "c", label: "Run the tests", value: "Run the test suite.", kind: "prompt", source: "learned" },
];
const one: SuggestionButton[] = [three[0]!];

// The stage-derived CTAs (engine/agentCta). Both carry source:"control" — that, not `kind`, is what
// marks a button as a CTA: Land/Push are kind:"prompt" (they tell the AGENT to act, so the repo's
// contracts run) while Close is a kind:"control" app action.
const landToMain: SuggestionButton = {
  id: "cta:landToMain",
  label: "Land to Main",
  value: "Land this to main.",
  kind: "prompt",
  source: "control",
};
const closeAgent: SuggestionButton = {
  id: "control:closeAgent",
  label: "Close Build Agent",
  value: "control:closeAgent",
  kind: "control",
  source: "control",
};

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

// The stage-driven CTA renders as the filled primary pill with its alternates behind the existing
// caret. A CTA is identified by source === "control", NOT by kind: "Land to Main" is a prompt (it
// tells the agent to act) but must still read as the one recommended action.
describe("SuggestionRow — stage-driven CTA", () => {
  // Read the pill's RESOLVED background off the element itself, selected by testid — not a substring
  // match on a serialized style walked to via parentElement, which a wrapper div or a success-tinted
  // border would silently flip.
  const pill = () => screen.getByTestId("suggestion-pill");
  const filled = () => pill().style.background === C.successInk;

  it("a prompt-kind CTA still renders as the filled primary pill", () => {
    render(
      <SuggestionRow buttons={[landToMain]} visible={true} onClick={() => {}} onDismiss={() => {}} />,
    );
    expect(screen.getByText("Land to Main")).toBeTruthy();
    expect(filled()).toBe(true);
  });

  it("an ordinary learned suggestion stays a neutral pill", () => {
    render(<SuggestionRow buttons={one} visible={true} onClick={() => {}} onDismiss={() => {}} />);
    expect(filled()).toBe(false);
  });

  it("a control-kind CTA (Close) renders filled too", () => {
    render(
      <SuggestionRow buttons={[closeAgent]} visible={true} onClick={() => {}} onDismiss={() => {}} />,
    );
    expect(filled()).toBe(true);
  });

  // The icon branch is the only real logic in CtaIcon, so assert the glyph, not just the fill (the
  // fill is driven by `source`, the icon by `kind` — a fill-only test can't see an inverted branch).
  it("a prompt CTA gets the arrow glyph (it hands work back to the agent)", () => {
    render(
      <SuggestionRow buttons={[landToMain]} visible={true} onClick={() => {}} onDismiss={() => {}} />,
    );
    const label = screen.getByText("Land to Main").closest("button")!;
    expect(label.querySelector('[data-icon="arrow"]')).toBeTruthy();
    expect(label.querySelector('[data-icon="check"]')).toBeNull();
  });

  it("the control CTA gets the check glyph (it finishes the job)", () => {
    render(
      <SuggestionRow buttons={[closeAgent]} visible={true} onClick={() => {}} onDismiss={() => {}} />,
    );
    const label = screen.getByText("Close Build Agent").closest("button")!;
    expect(label.querySelector('[data-icon="check"]')).toBeTruthy();
    expect(label.querySelector('[data-icon="arrow"]')).toBeNull();
  });

  it("an ordinary suggestion gets NO glyph", () => {
    render(<SuggestionRow buttons={one} visible={true} onClick={() => {}} onDismiss={() => {}} />);
    const label = screen.getByText("Rebase main, Issue PR, merge").closest("button")!;
    expect(label.querySelector("[data-icon]")).toBeNull();
  });

  it("the popover carries each alternate's own glyph", () => {
    // An ordinary suggestion is the primary so BOTH CTAs land in the popover — that's the only
    // arrangement covering its arrow AND check branches at once. (Making a CTA the primary would
    // just trade one popover branch for the other.)
    render(
      <SuggestionRow
        buttons={[three[1]!, landToMain, closeAgent]}
        visible={true}
        onClick={() => {}}
        onDismiss={() => {}}
      />,
    );
    fireEvent.click(screen.getByLabelText("More suggested actions"));
    const landItem = screen.getByRole("button", { name: "Land to Main" });
    expect(landItem.querySelector('[data-icon="arrow"]')).toBeTruthy();
    expect(landItem.querySelector('[data-icon="check"]')).toBeNull();
    const closeItem = screen.getByRole("button", { name: "Close Build Agent" });
    expect(closeItem.querySelector('[data-icon="check"]')).toBeTruthy();
    expect(closeItem.querySelector('[data-icon="arrow"]')).toBeNull();
  });

  it("an ordinary suggestion in the popover stays bare", () => {
    render(
      <SuggestionRow
        buttons={[landToMain, three[2]!]}
        visible={true}
        onClick={() => {}}
        onDismiss={() => {}}
      />,
    );
    fireEvent.click(screen.getByLabelText("More suggested actions"));
    const plain = screen.getByRole("button", { name: "Run the tests" });
    expect(plain.querySelector("[data-icon]")).toBeNull();
  });

  // Pins the re-key itself. The popover previously showed FiCheck for ANY kind === "control"; it now
  // requires source === "control" too. A control-kind button from a NON-control source is the only
  // fixture that tells the old rule from the new one — control/control and prompt/learned both
  // behave identically under either.
  it("a control-kind button from a non-control source gets no glyph (source, not kind, marks a CTA)", () => {
    const oddball: SuggestionButton = {
      id: "h:ctl",
      label: "Heuristic Control",
      value: "control:somethingElse",
      kind: "control",
      source: "heuristic",
    };
    render(
      <SuggestionRow
        buttons={[landToMain, oddball]}
        visible={true}
        onClick={() => {}}
        onDismiss={() => {}}
      />,
    );
    fireEvent.click(screen.getByLabelText("More suggested actions"));
    const item = screen.getByRole("button", { name: "Heuristic Control" });
    expect(item.querySelector("[data-icon]")).toBeNull();
  });

  it("renders the CTA primary with a caret when alternates exist, and fires the chosen one", () => {
    const onClick = vi.fn();
    render(
      <SuggestionRow
        buttons={[landToMain, three[2]!, closeAgent]}
        visible={true}
        onClick={onClick}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText("Land to Main")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("More suggested actions"));
    fireEvent.click(screen.getByRole("button", { name: "Run the tests" }));
    expect(onClick).toHaveBeenCalledWith(three[2]);
  });

  it("the escape-hatch Close is reachable from the caret", () => {
    const onClick = vi.fn();
    render(
      <SuggestionRow
        buttons={[landToMain, closeAgent]}
        visible={true}
        onClick={onClick}
        onDismiss={() => {}}
      />,
    );
    fireEvent.click(screen.getByLabelText("More suggested actions"));
    fireEvent.click(screen.getByRole("button", { name: "Close Build Agent" }));
    expect(onClick).toHaveBeenCalledWith(closeAgent);
  });

  it("renders no caret when the CTA has no alternates", () => {
    render(
      <SuggestionRow buttons={[landToMain]} visible={true} onClick={() => {}} onDismiss={() => {}} />,
    );
    expect(screen.queryByLabelText("More suggested actions")).toBeNull();
  });
});
