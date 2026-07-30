// @vitest-environment jsdom
//
// THE collapsed-text pill and its modal — the shared primitive all three collapse surfaces draw
// (see TextPill's header). Two requirements are pinned here because they are the ones a plausible
// implementation gets wrong:
//
//   • THE PILL IS IDENTIFIABLE UNOPENED. A face reading only "Pasted text" is worse than the rows
//     it replaced, so the row below asserts the paste's OWN first line is on it — not merely that
//     some pill rendered.
//   • THE COPY BUTTON COPIES THE VERBATIM PASTE. Not the rendered `<pre>`, not the pill's label.
//     The clipboard boundary is stubbed at `navigator.clipboard` rather than by mocking
//     ../../clipboard, so the real copyToClipboard runs and this would catch it copying the wrong
//     string on its way through.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TextPill, pillSizeLabel } from "./TextPill";
import { TextPillModal } from "./TextPillModal";
import { collapseText, pillPreview } from "./attachments";

const BRIEF =
  "Concierge Reply Linter is up — here is the brief\n" +
  "\tsecond line, tab-indented\n" +
  "third\nfourth\nfifth\nsixth\nseventh\n";

const block = collapseText("b1", BRIEF);

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn(async () => {});
  Object.assign(navigator, { clipboard: { writeText } });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("TextPill — identifiable without opening it", () => {
  it("puts the paste's own first line on the face", () => {
    render(<TextPill block={block} onOpen={() => {}} />);
    const pill = screen.getByTestId("composer-text-pill");
    // The FACE, not a tooltip: the whole point is reading it at a glance.
    expect(pill.textContent).toContain("Concierge Reply Linter is up");
    // …and it is not the bare generic label the pill used to carry alone.
    expect(pill.textContent).not.toBe("Pasted text");
  });

  it("carries the size as a subtitle, so lines and characters are both legible", () => {
    render(<TextPill block={block} onOpen={() => {}} />);
    expect(screen.getByTestId("composer-text-pill").textContent).toContain(pillSizeLabel(block));
  });

  it("names itself for a screen reader with the same identifying text", () => {
    render(<TextPill block={block} onOpen={() => {}} />);
    expect(screen.getByTestId("composer-text-pill").getAttribute("aria-label")).toContain(
      pillPreview(BRIEF),
    );
  });

  it("falls back to a generic face only when there is nothing but whitespace", () => {
    render(<TextPill block={collapseText("b2", "\n\n\n\n\n\n")} onOpen={() => {}} />);
    expect(screen.getByTestId("composer-text-pill").textContent).toContain("Pasted text");
  });

  it("opens on click", () => {
    const onOpen = vi.fn();
    render(<TextPill block={block} onOpen={onOpen} />);
    fireEvent.click(screen.getByTestId("composer-text-pill"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("offers removal only where the block is staged, never where it is a record", () => {
    const { unmount } = render(<TextPill block={block} onOpen={() => {}} onRemove={() => {}} />);
    expect(screen.queryByLabelText("Remove pasted text")).toBeTruthy();
    unmount();
    // The transcript variant passes no onRemove: a sent message is a record, and a × on one
    // implies an edit the app cannot make.
    render(<TextPill block={block} variant="inline" onOpen={() => {}} />);
    expect(screen.queryByLabelText("Remove pasted text")).toBeNull();
  });

  it("reports its variant on the element, so a surface's choice is assertable", () => {
    render(<TextPill block={block} variant="inline" onOpen={() => {}} />);
    expect(screen.getByTestId("composer-text-pill").getAttribute("data-pill-variant")).toBe("inline");
  });
});

describe("TextPillModal", () => {
  it("shows the full text verbatim — every row, not the preview", () => {
    render(<TextPillModal block={block} onClose={() => {}} onShowAsText={() => {}} />);
    expect(screen.getByTestId("text-pill-full-text").textContent).toBe(BRIEF);
  });

  it("copies the VERBATIM paste, not the rendered pre or the pill's label", async () => {
    render(<TextPillModal block={block} onClose={() => {}} onShowAsText={() => {}} />);
    fireEvent.click(screen.getByTestId("text-pill-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith(BRIEF);
  });

  it("confirms the copy, so the user knows it took", async () => {
    render(<TextPillModal block={block} onClose={() => {}} onShowAsText={() => {}} />);
    fireEvent.click(screen.getByTestId("text-pill-copy"));
    await waitFor(() =>
      expect(screen.getByTestId("text-pill-copy").getAttribute("aria-label")).toBe("Copied"),
    );
  });

  it("does not claim a copy that failed", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    // With the async API rejecting, copyToClipboard falls through to execCommand — which jsdom
    // does not implement, so the copy reports failure and the tick must NOT appear.
    const exec = vi.fn(() => false);
    Object.assign(document, { execCommand: exec });
    render(<TextPillModal block={block} onClose={() => {}} onShowAsText={() => {}} />);
    fireEvent.click(screen.getByTestId("text-pill-copy"));
    await waitFor(() => expect(exec).toHaveBeenCalled());
    expect(screen.getByTestId("text-pill-copy").getAttribute("aria-label")).toBe(
      "Copy the full text",
    );
  });

  it("expands back to regular text on request", () => {
    const onShowAsText = vi.fn();
    render(<TextPillModal block={block} onClose={() => {}} onShowAsText={onShowAsText} />);
    fireEvent.click(screen.getByTestId("text-pill-show-as-text"));
    expect(onShowAsText).toHaveBeenCalledTimes(1);
  });
});
