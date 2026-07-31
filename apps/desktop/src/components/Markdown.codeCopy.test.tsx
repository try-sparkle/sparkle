// @vitest-environment jsdom
//
// The per-code-block copy control. A fenced block is the worst thing in a transcript to select by
// hand — it is its own horizontal scroller, so a drag that strays sideways scrolls the block instead
// of extending the highlight — and it is the content most likely to be wanted whole, where half a
// command is not merely incomplete but dangerous. So the common case stops needing a drag.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CODE_COPY_TESTID, Markdown } from "./Markdown";

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
});
afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
});

const FENCED = ["Try this:", "", "```sh", "rm -rf ./build", "npm run dev", "```"].join("\n");

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("Markdown — code block copy", () => {
  it("copies the block's own text, and only that block", async () => {
    render(<Markdown text={FENCED} />);
    fireEvent.click(screen.getByTestId(CODE_COPY_TESTID));
    await settle();

    const copied = writeText.mock.calls[0]?.[0] as string;
    expect(copied).toContain("rm -rf ./build");
    expect(copied).toContain("npm run dev");
    // The prose around the fence is NOT part of the block.
    expect(copied).not.toContain("Try this:");
    // Nor is the fence syntax — this copies what is rendered, not the markdown source.
    expect(copied).not.toContain("```");
  });

  it("gives each fenced block its own control", () => {
    render(<Markdown text={["```", "one", "```", "", "```", "two", "```"].join("\n")} />);
    expect(screen.getAllByTestId(CODE_COPY_TESTID)).toHaveLength(2);
  });

  it("adds no control to prose that has no fence", () => {
    render(<Markdown text="Just a sentence with `inline code` in it." />);
    expect(screen.queryByTestId(CODE_COPY_TESTID)).toBeNull();
  });

  it("stays OUT of a selection that sweeps across the block", () => {
    // Without this the control would contribute a glyph to every multi-message copy that crossed a
    // code block, which is exactly the "no UI chrome in my clipboard" complaint.
    render(<Markdown text={FENCED} />);
    const btn = screen.getByTestId(CODE_COPY_TESTID);
    expect(btn.style.userSelect).toBe("none");
    // And it is not announced: the whole-answer button already copies this fence as part of the
    // answer's source, so a second stop on the tab order buys nothing.
    expect(btn.getAttribute("aria-hidden")).toBe("true");
    expect(btn.getAttribute("tabindex")).toBe("-1");
  });

  it("confirms only a copy that actually happened", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    render(<Markdown text={FENCED} />);
    const btn = screen.getByTestId(CODE_COPY_TESTID);
    fireEvent.click(btn);
    await settle();

    // jsdom has no execCommand fallback, so this is the "no path worked" case: no check mark, no lie.
    expect(btn.getAttribute("data-copied")).toBe("false");
  });
});
