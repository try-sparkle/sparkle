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

import { MessageAttachments } from "./MessageAttachments";
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

describe("MessageAttachments", () => {
  it("renders nothing at all for a message that carried no files", () => {
    const { container } = render(<MessageAttachments attachments={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("draws an image from its dataUrl", () => {
    render(<MessageAttachments attachments={[image]} />);
    expect(within(strip()).getByRole("img", { name: "shot.png" }).getAttribute("src")).toBe(
      image.dataUrl,
    );
  });

  it("falls back to a chip for an IMAGE whose preview did not survive", () => {
    // Not a broken <img>: a stripped image has no src to give one, and a broken-image glyph where a
    // chip belongs is exactly what this fallback exists to prevent.
    render(<MessageAttachments attachments={[stripped]} />);
    expect(within(strip()).queryByRole("img")).toBeNull();
    expect(strip().textContent).toContain("shot.png");
    // …and it says WHY, rather than looking like a thumbnail that failed to load.
    expect(screen.getByRole("button", { name: "View shot.png" }).title).toContain(
      "no preview available",
    );
  });

  it("shows a non-image as a named chip with its type", () => {
    render(<MessageAttachments attachments={[file]} />);
    expect(within(strip()).queryByRole("img")).toBeNull();
    expect(strip().textContent).toContain("notes.pdf");
    expect(strip().textContent).toContain("PDF");
  });

  it("opens the ONE existing lightbox on click, and closes it again", () => {
    render(<MessageAttachments attachments={[image]} />);
    fireEvent.click(screen.getByRole("button", { name: "View shot.png" }));
    expect(screen.getByTitle("Download…")).toBeTruthy();
    fireEvent.click(screen.getByTitle("Close"));
    expect(screen.queryByTitle("Download…")).toBeNull();
  });
});
