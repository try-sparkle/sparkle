// @vitest-environment jsdom
//
// The read-only strip a SENT message's files draw as (PRD §8). The end-to-end path is covered in
// ConciergeHost.attachments.test.tsx; this file pins the shapes the component has to distinguish,
// which is where the interesting cases are — above all an IMAGE with no preview, the designed
// steady state after a restart (the base64 is deliberately not persisted) and after the live
// retention cap strips an older bubble.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  copy: vi.fn(async () => {}),
  download: vi.fn(async () => {}),
}));
// The lightbox's actions reach Tauri; the strip's own behavior is what is under test here.
vi.mock("./attachmentsApi", () => ({
  copyImageToClipboard: h.copy,
  downloadAttachment: h.download,
}));

import { AttachmentStrip } from "./AttachmentStrip";
import type { Attachment } from "./attachments";

const image: Attachment = {
  id: "s1",
  kind: "image",
  path: "/tmp/shot.png",
  name: "shot.png",
  dataUrl: "data:image/png;base64,AAA",
};
/** The same image after `stripDataUrls` — what a restored bubble holds. */
const stripped: Attachment = { id: "s1", kind: "image", path: "/tmp/shot.png", name: "shot.png" };
const file: Attachment = { id: "f1", kind: "file", path: "/tmp/notes.pdf", name: "notes.pdf" };

const strip = () => screen.getByTestId("concierge-message-attachments");

afterEach(cleanup);

describe("AttachmentStrip — the sent-message (read-only) surface", () => {
  it("renders nothing at all for a message that carried no files", () => {
    const { container } = render(<AttachmentStrip attachments={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("draws an image from its dataUrl", () => {
    render(<AttachmentStrip attachments={[image]} />);
    expect(within(strip()).getByRole("img", { name: "shot.png" }).getAttribute("src")).toBe(
      image.dataUrl,
    );
  });

  it("falls back to a chip for an IMAGE whose preview did not survive", () => {
    // Not a broken <img>: a stripped image has no src to give one, and a broken-image glyph where a
    // chip belongs is exactly what this fallback exists to prevent.
    render(<AttachmentStrip attachments={[stripped]} />);
    expect(within(strip()).queryByRole("img")).toBeNull();
    expect(strip().textContent).toContain("shot.png");
    // …and it says WHY, rather than looking like a thumbnail that failed to load.
    expect(screen.getByRole("button", { name: "View shot.png" }).title).toContain(
      "no preview available",
    );
  });

  it("shows a non-image as a named chip with its type", () => {
    render(<AttachmentStrip attachments={[file]} />);
    expect(within(strip()).queryByRole("img")).toBeNull();
    expect(strip().textContent).toContain("notes.pdf");
    expect(strip().textContent).toContain("PDF");
  });

  // ── THE READ-ONLY / REMOVABLE SPLIT ────────────────────────────────────────────────────────────
  //
  // `onRemove` is the ONLY difference between the transcript's copy of this strip and the draft's,
  // and until now neither half of that was covered: the strip's own suite never rendered the
  // removable branch, and the draft's "each chip has a remove control" case locates the × by
  // role+name and clicks it — which passes IDENTICALLY if the × were nested INSIDE the preview
  // button. So the one structural rule the component states ("a <button> inside a <button> is
  // invalid HTML, and browsers reparent it") had no assertion that could fail on it. (roborev 56045)
  it("grows NO remove control without onRemove — the sent-message copy is read-only", () => {
    render(<AttachmentStrip attachments={[image, file]} />);
    expect(screen.queryByRole("button", { name: /^Remove/ })).toBeNull();
  });

  it("puts the × BESIDE the preview button, never inside it", () => {
    render(<AttachmentStrip attachments={[image]} onRemove={vi.fn()} />);
    const remove = screen.getByRole("button", { name: "Remove shot.png" });
    const preview = screen.getByRole("button", { name: "View shot.png" });
    // The × must not be a descendant of the preview button. Walk up from the ×'s PARENT, not from
    // the × itself: `closest()` starts its walk AT the element, so `remove.closest("button")`
    // returns `remove` unconditionally — a tautology that passes just as happily when the × IS
    // nested. Starting one level up reaches the preview button only in the nested case, so this can
    // actually fail; verified by nesting the × with the two assertions below removed (roborev 56052).
    expect(remove.parentElement?.closest("button")).toBeNull();
    expect(preview.contains(remove)).toBe(false);
    expect(remove.parentElement).toBe(preview.parentElement);
  });

  it("removing does NOT also open the lightbox", () => {
    // The consequence of nesting, stated as behaviour: a click on a nested × bubbles to the preview
    // button and opens the viewer the user was trying to dismiss.
    const onRemove = vi.fn();
    render(<AttachmentStrip attachments={[image]} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove shot.png" }));
    expect(onRemove).toHaveBeenCalledWith("s1");
    expect(screen.queryByTitle("Download…")).toBeNull();
  });

  it("opens the ONE existing lightbox on click, and closes it again", () => {
    render(<AttachmentStrip attachments={[image]} />);
    fireEvent.click(screen.getByRole("button", { name: "View shot.png" }));
    expect(screen.getByTitle("Download…")).toBeTruthy();
    fireEvent.click(screen.getByTitle("Close"));
    expect(screen.queryByTitle("Download…")).toBeNull();
  });
});
