// @vitest-environment jsdom
//
// The per-agent Claude model pill (sparkle-i6rw): shows the current model's short label, opens
// the curated dropdown on click, fires onChange with the picked id, and keeps its clicks from
// bubbling to the agent card underneath.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ModelPill } from "./ModelPill";

afterEach(() => cleanup());

describe("ModelPill", () => {
  it("shows 'Default' for an agent with no model and the short label for a chosen one", () => {
    const { rerender } = render(<ModelPill value={undefined} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Default/ })).toBeTruthy();
    rerender(<ModelPill value="claude-opus-4-8" onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Opus/ })).toBeTruthy();
  });

  it("opens the dropdown on click and fires onChange with the picked model id", () => {
    const onChange = vi.fn();
    render(<ModelPill value={undefined} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(screen.getByText("Haiku 4.5"));
    expect(onChange).toHaveBeenCalledWith("claude-haiku-4-5");
    // Picking closes the menu.
    expect(screen.queryByText("Haiku 4.5")).toBeNull();
  });

  it("picking 'Default (Claude Code setting)' fires onChange with the 'default' sentinel", () => {
    const onChange = vi.fn();
    render(<ModelPill value="claude-opus-4-8" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /Opus/ }));
    fireEvent.click(screen.getByText("Default (Claude Code setting)"));
    expect(onChange).toHaveBeenCalledWith("default");
  });

  it("clicking the backdrop dismisses without a pick; aria-expanded tracks the menu", () => {
    const onChange = vi.fn();
    render(<ModelPill value={undefined} onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: /Default/ });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    // Backdrop AND menu are portaled to document.body so the hover card's stacking context
    // (fixed + zIndex + drop-shadow filter) can neither shrink the backdrop nor paint the
    // card-trapped menu below it.
    const backdrop = screen.getByTestId("model-pill-backdrop");
    expect(backdrop.parentElement).toBe(document.body);
    fireEvent.click(backdrop);
    expect(screen.queryByTestId("model-pill-menu")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("the menu is a body-portaled sibling painted ABOVE its backdrop (hit-testable picks)", () => {
    // jsdom has no hit-testing, so pin the stacking relationship the real browser relies on:
    // both layers live in the ROOT stacking context and the menu's z beats the backdrop's —
    // a menu left inside the hover card's own context could never win that comparison
    // (roborev 24831/24832).
    render(<ModelPill value={undefined} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button"));
    const backdrop = screen.getByTestId("model-pill-backdrop");
    const menu = screen.getByTestId("model-pill-menu");
    expect(menu.parentElement).toBe(document.body);
    expect(Number(menu.style.zIndex)).toBeGreaterThan(Number(backdrop.style.zIndex));
  });

  it("menu options are real buttons (keyboard-operable), not click-only divs", () => {
    render(<ModelPill value={undefined} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button"));
    const items = Array.from(
      screen.getByTestId("model-pill-menu").querySelectorAll("button"),
    );
    expect(items.length).toBeGreaterThan(1);
    // The active option takes focus on open so keyboard users land inside the list.
    expect(document.activeElement?.textContent).toContain("Default (Claude Code setting)");
  });

  it("a window scroll closes the menu (its position was captured at open and would go stale)", () => {
    render(<ModelPill value={undefined} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByTestId("model-pill-menu")).toBeTruthy();
    fireEvent.scroll(window);
    expect(screen.queryByTestId("model-pill-menu")).toBeNull();
    // Scroll-dismiss must NOT hand focus back to the trigger — focus() scrolls it into view,
    // fighting the very scroll that caused the dismissal.
    expect(document.activeElement).not.toBe(screen.getByRole("button"));
  });

  it("a window resize also closes the menu (separate listener from the scroll path)", () => {
    render(<ModelPill value={undefined} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByTestId("model-pill-menu")).toBeTruthy();
    fireEvent(window, new Event("resize"));
    expect(screen.queryByTestId("model-pill-menu")).toBeNull();
  });

  it("an unknown/legacy model id is union'd into the list and takes focus (stays selectable)", () => {
    // Phase 2: the current model is always union'd into the menu (roborev 27159), so an
    // unknown/legacy id now gets its OWN focused row rather than falling back to the first option.
    // Either way keyboard users land INSIDE the list — here, on their actual current model.
    render(<ModelPill value="claude-old-model" onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button"));
    expect(document.activeElement?.textContent).toContain("claude-old-model");
  });

  it("Escape closes the dropdown without a pick", () => {
    const onChange = vi.fn();
    render(<ModelPill value={undefined} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Fable 5")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("Fable 5")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("clicks never bubble to the agent card underneath (stopPropagation)", () => {
    const cardClick = vi.fn();
    render(
      <div onClick={cardClick}>
        <ModelPill value={undefined} onChange={vi.fn()} />
      </div>,
    );
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(screen.getByText("Sonnet 5"));
    expect(cardClick).not.toHaveBeenCalled();
  });
});
