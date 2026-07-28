// @vitest-environment jsdom
//
// The confirmation the user gets after dropping files on a terminal. The copy is the contract
// here: it must say WHAT was pasted, into WHOSE terminal, and that nothing has been SENT — the
// paths are sitting at the CLI's prompt waiting for the user's Enter, and a pill that overstates
// leaves them waiting for an answer nobody asked for. It must also be able to say the paste did
// NOT land, because there is no chip to fall back on.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TerminalDropPill, describeDrop } from "./TerminalDropPill";

afterEach(() => cleanup());

describe("describeDrop", () => {
  it("names images as images", () => {
    expect(describeDrop(1, 1)).toBe("1 image");
    expect(describeDrop(3, 3)).toBe("3 images");
  });

  it("names non-images as files — a .log is as pasteable as a .png", () => {
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

  it("says what was pasted, and into which agent's terminal", () => {
    renderPill();
    const pill = screen.getByTestId("terminal-drop-pill");
    expect(pill.textContent).toContain("2 files (1 of them images)");
    expect(pill.textContent).toContain("Kraken Auth");
    expect(pill.textContent).toContain("terminal");
    expect(pill.getAttribute("aria-label")).toBe("Pasted into Kraken Auth's terminal");
  });

  it("states plainly that nothing has been sent, and how to send it", () => {
    renderPill();
    const text = screen.getByTestId("terminal-drop-pill").textContent ?? "";
    expect(text).toContain("Nothing has been sent");
    expect(text).toContain("press Enter");
  });

  it("says the paste went NOWHERE when the terminal was gone", () => {
    // The one thing this pill may never do is confirm a delivery that did not happen: with the
    // drop no longer staging a chip, a silent failure loses the user's file outright.
    renderPill({ delivered: false });
    const pill = screen.getByTestId("terminal-drop-pill");
    expect(pill.textContent).toContain("went nowhere");
    expect(pill.textContent).not.toContain("Pasted 2 files");
    expect(pill.getAttribute("aria-label")).toBe(
      "Nothing pasted — Kraken Auth's terminal isn't running",
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
