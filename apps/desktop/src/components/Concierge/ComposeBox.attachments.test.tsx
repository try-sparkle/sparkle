// @vitest-environment jsdom
//
// The compose box's attachment surface (parity row #21, bead sparkle-4562.3): staged files render
// as removable chips, an attachment alone is a sendable message, and the box exposes the drop
// target the host hit-tests. The box owns none of this state — it renders what it is given.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposeBox } from "./ComposeBox";
import { CONCIERGE_COMPOSE_DND_TARGET } from "../../services/dndTargets";
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

function setup(over: { attachments?: Attachment[]; dropActive?: boolean } = {}) {
  const onSend = vi.fn();
  const onRemoveAttachment = vi.fn();
  render(
    <ComposeBox
      onSend={onSend}
      onMicToggle={vi.fn()}
      onAttach={vi.fn()}
      onRemoveAttachment={onRemoveAttachment}
      {...over}
    />,
  );
  return { onSend, onRemoveAttachment };
}

const box = () => screen.getByRole("textbox", { name: "Message Sparkle" }) as HTMLTextAreaElement;
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

describe("ComposeBox — drop target", () => {
  it("marks itself so the host's window-global drag listener can hit-test it", () => {
    setup();
    const target = document.querySelector("[data-dnd-target]");
    expect(target?.getAttribute("data-dnd-target")).toBe(CONCIERGE_COMPOSE_DND_TARGET);
  });

  it("paints a drop affordance only while a drag is over it", () => {
    const { unmount } = renderWith(false);
    const calm = document.querySelector("[data-dnd-target]") as HTMLElement;
    expect(calm.style.outline).toBe("none");
    unmount();
    renderWith(true);
    const lit = document.querySelector("[data-dnd-target]") as HTMLElement;
    expect(lit.style.outline).toContain("dashed");
  });
});

function renderWith(dropActive: boolean) {
  return render(
    <ComposeBox
      onSend={vi.fn()}
      onMicToggle={vi.fn()}
      onAttach={vi.fn()}
      dropActive={dropActive}
    />,
  );
}
