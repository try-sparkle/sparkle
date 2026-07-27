// @vitest-environment jsdom
//
// The confirmation the user gets after dropping files on a terminal. The copy is the contract
// here: it must say WHAT landed, to WHOM, and that nothing has been SENT — a terminal write cannot
// be taken back, so a pill that overstates is worse than no pill.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TerminalDropPill, describeDrop } from "./TerminalDropPill";

afterEach(() => cleanup());

describe("describeDrop", () => {
  it("names images as images", () => {
    expect(describeDrop(1, 1)).toBe("1 image");
    expect(describeDrop(3, 3)).toBe("3 images");
  });

  it("names non-images as files — a .log is as attachable as a .png", () => {
    expect(describeDrop(1, 0)).toBe("1 file");
    expect(describeDrop(2, 0)).toBe("2 files");
  });

  it("never calls a non-image an image in a mixed drop", () => {
    expect(describeDrop(3, 2)).toBe("3 files (2 of them images)");
  });
});

describe("TerminalDropPill", () => {
  const renderPill = (props?: Partial<Parameters<typeof TerminalDropPill>[0]>) =>
    render(
      <TerminalDropPill count={2} images={1} agentName="Kraken Auth" onDismiss={vi.fn()} {...props} />,
    );

  it("says what landed and to which agent", () => {
    renderPill();
    const pill = screen.getByTestId("terminal-drop-pill");
    expect(pill.textContent).toContain("2 files (1 of them images)");
    expect(pill.textContent).toContain("Kraken Auth");
    expect(pill.getAttribute("aria-label")).toBe("Attached to Kraken Auth");
  });

  it("states plainly that nothing has been sent", () => {
    renderPill();
    expect(screen.getByTestId("terminal-drop-pill").textContent).toContain(
      "Nothing has been sent yet",
    );
  });

  it("dismisses on the × and on Escape", async () => {
    const onDismiss = vi.fn();
    renderPill({ onDismiss });
    screen.getByLabelText("Dismiss").click();
    expect(onDismiss).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });
});
