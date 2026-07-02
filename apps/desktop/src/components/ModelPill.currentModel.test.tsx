// @vitest-environment jsdom
//
// Regression guard (roborev 27159): the dropdown renders the DYNAMIC catalog, so the agent's
// currently-selected model must still appear/selectable even when the user's BYOK /v1/models
// response omits it (no access, deprecated, partial response, or a curated id the key can't see).
// We mock the live catalog to a list that lacks the selected model and assert the pill unions it in.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/models", async (importActual) => {
  const actual = await importActual<typeof import("../services/models")>();
  return {
    ...actual, // keep real modelShortLabel / isDefaultModel (they read the curated list)
    // A dynamic catalog WITHOUT claude-opus-4-8 — as if the user's key can't see it.
    useModelCatalog: () => [
      { id: "default", label: "Default (Claude Code setting)", short: "Default" },
      { id: "claude-haiku-4-5", label: "Haiku 4.5", short: "Haiku" },
    ],
    refreshModelCatalog: vi.fn(async () => {}),
  };
});

import { ModelPill } from "./ModelPill";

afterEach(() => cleanup());

describe("ModelPill — current model always selectable when the dynamic catalog omits it", () => {
  it("unions the active model into the menu so it stays visible and focused", () => {
    render(<ModelPill value="claude-opus-4-8" onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Opus/ }));
    const menu = screen.getByTestId("model-pill-menu");
    // The selected model appears even though it's absent from the dynamic catalog.
    const opusRow = Array.from(menu.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Opus"),
    );
    expect(opusRow).toBeTruthy();
    // And it's the focused/active row (keyboard users land on their current model).
    expect(document.activeElement?.textContent).toContain("Opus");
  });

  it("clicking the union'd option fires onChange with its id", () => {
    const onChange = vi.fn();
    render(<ModelPill value="claude-opus-4-8" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /Opus/ }));
    // "Opus" also labels the trigger pill, so scope the click to the menu's option row.
    const menu = screen.getByTestId("model-pill-menu");
    const opusRow = Array.from(menu.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Opus"),
    )!;
    fireEvent.click(opusRow);
    expect(onChange).toHaveBeenCalledWith("claude-opus-4-8");
  });

  it("does not duplicate a model that IS in the dynamic catalog", () => {
    render(<ModelPill value="claude-haiku-4-5" onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Haiku/ }));
    const menu = screen.getByTestId("model-pill-menu");
    const haikuRows = Array.from(menu.querySelectorAll("button")).filter((b) =>
      b.textContent?.includes("Haiku"),
    );
    expect(haikuRows.length).toBe(1);
  });
});
