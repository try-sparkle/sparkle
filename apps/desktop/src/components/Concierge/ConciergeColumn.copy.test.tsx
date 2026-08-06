// @vitest-environment jsdom
//
// Where the copy confirmation GOES. The column has exactly ONE `aria-live` region and the copy
// affordances must speak through it — via `controller.onCopied` → the host's `announce()` → the
// `announcement` prop — rather than growing a second announcer in the thread. Three roborev findings
// (52648 / 53010 / 53088) were that same mistake in three different places, and the contract is
// written down in ./types, ./ConciergeColumn and ./ComposeBox.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("../BalanceBadge", () => ({ BalanceBadge: () => null }));

import { ConciergeColumn } from "./ConciergeColumn";
import type { ConciergeController, ConciergeViewModel } from "./types";
import { enableAiEnhancementsForTests } from "../../testing/aiEnhancements";

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  enableAiEnhancementsForTests();
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
});
afterEach(() => cleanup());

const model: ConciergeViewModel = {
  scope: {},
  vitals: { needs_you: 0, questions: 0, running: 0, done: 0 },
  messages: [{ id: "a1", kind: "sparkle", text: "**Answer** with `source`." }],
};

function controllerSpy(): ConciergeController & { onCopied: ReturnType<typeof vi.fn> } {
  return {
    onSend: vi.fn(),
    onAttach: vi.fn(),
    onNudgeClick: vi.fn(),
    onNudgeAction: vi.fn(),
    onCopied: vi.fn(),
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("ConciergeColumn — copy confirmations", () => {
  it("reports a copy through the controller and adds no second live region", async () => {
    const controller = controllerSpy();
    const { container } = render(<ConciergeColumn model={model} controller={controller} />);

    // Exactly one, and it is the column's own announcer — before AND after a copy.
    const regions = () => container.querySelectorAll("[aria-live]");
    expect(regions()).toHaveLength(1);
    expect(regions()[0]).toBe(screen.getByTestId("concierge-announcer"));

    fireEvent.click(screen.getByTestId("concierge-copy-answer"));
    await settle();

    expect(writeText).toHaveBeenCalledWith("**Answer** with `source`.");
    expect(controller.onCopied).toHaveBeenCalledWith("answer");
    expect(container.querySelectorAll("[aria-live]")).toHaveLength(1);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
  });

  it("speaks the confirmation the integration layer hands back, in the existing region", () => {
    // The host answers `onCopied` by calling `announce()`, which arrives here as `announcement`.
    // Keyed on `seq`, so an identical repeat is still a real DOM change (roborev 53392).
    const controller = controllerSpy();
    const { rerender } = render(
      <ConciergeColumn
        model={model}
        controller={controller}
        announcement={{ seq: 1, text: "Answer copied to clipboard." }}
      />,
    );
    const region = screen.getByTestId("concierge-announcer");
    expect(region.textContent).toBe("Answer copied to clipboard.");

    rerender(
      <ConciergeColumn
        model={model}
        controller={controller}
        announcement={{ seq: 2, text: "Answer copied to clipboard." }}
      />,
    );
    expect(region.querySelector("[data-announce-seq]")?.getAttribute("data-announce-seq")).toBe("2");
  });

  it("passes the copy-on-selection preference down to the thread", async () => {
    const controller = controllerSpy();
    render(<ConciergeColumn model={model} controller={controller} copyOnSelection={false} />);

    const thread = screen.getByTestId("concierge-thread");
    const range = document.createRange();
    range.selectNodeContents(thread);
    const sel = window.getSelection();
    if (!sel) throw new Error("jsdom has no Selection");
    sel.removeAllRanges();
    sel.addRange(range);
    fireEvent.mouseDown(thread);
    fireEvent.mouseUp(thread);
    await settle();

    expect(writeText).not.toHaveBeenCalled();
    sel.removeAllRanges();
  });
});
