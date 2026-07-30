// @vitest-environment jsdom
//
// The compose box's attachment surface (parity row #21, bead sparkle-4562.3): staged files render
// as removable chips, an attachment alone is a sendable message, and the box paints the drag
// affordance. The box owns none of this state — it renders what it is given.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposeBox } from "./ComposeBox";
import type { Attachment } from "./types";

afterEach(() => cleanup());

const shot: Attachment = {
  id: "s1",
  kind: "image",
  path: "/tmp/shot.png",
  name: "shot.png",
  dataUrl: "data:image/png;base64,AAA",
};
const logFile: Attachment = { id: "f1", kind: "file", path: "/tmp/build.log", name: "build.log" };

function setup(
  over: {
    attachments?: Attachment[];
    dropActive?: boolean;
    attachNotice?: string | null;
  } = {},
) {
  const onSend = vi.fn();
  const onRemoveAttachment = vi.fn();
  const onDismissAttachNotice = vi.fn();
  render(
    <ComposeBox
      onSend={onSend}
      onAttach={vi.fn()}
      onRemoveAttachment={onRemoveAttachment}
      onDismissAttachNotice={onDismissAttachNotice}
      {...over}
    />,
  );
  return { onSend, onRemoveAttachment, onDismissAttachNotice };
}

const box = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
const send = () => screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;

describe("ComposeBox — attachment chips", () => {
  it("renders no chip row when nothing is staged", () => {
    setup();
    expect(screen.queryByTestId("concierge-attachment-chips")).toBeNull();
  });

  it("names every staged file, with a thumbnail for images only", () => {
    setup({ attachments: [shot, logFile] });
    const chips = screen.getByTestId("concierge-attachment-chips");
    expect(chips.textContent).toContain("shot.png");
    expect(chips.textContent).toContain("build.log");
    const thumbs = chips.querySelectorAll("img");
    expect(thumbs).toHaveLength(1);
    expect(thumbs[0]?.getAttribute("src")).toBe(shot.dataUrl);
  });

  it("each chip has a remove control that reports its id", () => {
    const { onRemoveAttachment } = setup({ attachments: [shot, logFile] });
    fireEvent.click(screen.getByRole("button", { name: "Remove build.log" }));
    expect(onRemoveAttachment).toHaveBeenCalledWith("f1");
    fireEvent.click(screen.getByRole("button", { name: "Remove shot.png" }));
    expect(onRemoveAttachment).toHaveBeenLastCalledWith("s1");
  });
});

// An image alone is a message — the removed composer allowed attachments-only sends, and the
// concierge box is now the only place to make one.
describe("ComposeBox — sending with attachments", () => {
  it("Send is disabled with neither text nor attachments", () => {
    setup();
    expect(send().disabled).toBe(true);
  });

  it("Send is enabled by an attachment alone, and submits empty text", () => {
    const { onSend } = setup({ attachments: [shot] });
    expect(send().disabled).toBe(false);
    fireEvent.click(send());
    expect(onSend).toHaveBeenCalledWith("");
  });

  it("submits the trimmed text alongside the staged files", () => {
    const { onSend } = setup({ attachments: [shot] });
    fireEvent.change(box(), { target: { value: "  what is this  " } });
    fireEvent.keyDown(box(), { key: "Enter", metaKey: true });
    expect(onSend).toHaveBeenCalledWith("what is this");
    expect(box().value).toBe("");
  });
});

// The hit-test marker lives on the COLUMN around this box (ConciergeColumn), not on the box: a
// file dropped anywhere over the concierge attaches, and this ~90px strip is not what a cursor
// aims at. What the box still owns is the AFFORDANCE — the only signal a native OS drag gives the
// user that the file has somewhere to land.
describe("ComposeBox — drop affordance", () => {
  it("paints a drop affordance only while a drag is over the concierge", () => {
    const { unmount } = renderWith(false);
    const calm = screen.getByTestId("concierge-compose");
    expect(calm.style.outline).toBe("none");
    unmount();
    renderWith(true);
    const lit = screen.getByTestId("concierge-compose");
    expect(lit.style.outline).toContain("dashed");
  });

  it("does not claim the drag hit-test itself — the column owns it", () => {
    setup();
    expect(document.querySelector("[data-dnd-target]")).toBeNull();
  });
});

function renderWith(dropActive: boolean) {
  return render(
    <ComposeBox
      onSend={vi.fn()}
      onAttach={vi.fn()}
      dropActive={dropActive}
    />,
  );
}

// The box promises, under the drag, that the file will land. When it doesn't, the box is where the
// user is looking — so that is where it has to be told (bead sparkle-zviq).
describe("ComposeBox — attach failure notice", () => {
  it("renders nothing when there is no notice", () => {
    setup();
    expect(screen.queryByTestId("concierge-attach-notice")).toBeNull();
  });

  it("states the failure where the chip would have appeared", () => {
    setup({ attachNotice: "Couldn't attach notes.txt — Sparkle isn't allowed to read that folder." });
    const notice = screen.getByTestId("concierge-attach-notice");
    expect(notice.textContent).toContain("notes.txt");
    // The REASON is rendered, not just the name — that is the half that ends the bug report.
    expect(notice.textContent).toMatch(/allowed to read that folder/i);
    // An alert, so a screen reader announces it rather than leaving it to be noticed.
    expect(notice.getAttribute("role")).toBe("alert");
  });

  it("reports the dismissal to the owner of the state", () => {
    const { onDismissAttachNotice } = setup({ attachNotice: "Couldn't attach notes.txt — Sparkle isn't allowed to read that folder." });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss attachment error" }));
    expect(onDismissAttachNotice).toHaveBeenCalledTimes(1);
  });

  it("shows the notice ABOVE the staged chips, not in place of them", () => {
    // A partial failure renders both; the notice must not displace the files that DID land.
    setup({ attachments: [logFile], attachNotice: "Couldn't attach notes.txt — permission denied." });
    const notice = screen.getByTestId("concierge-attach-notice");
    const chips = screen.getByTestId("concierge-attachment-chips");
    expect(notice.compareDocumentPosition(chips) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
