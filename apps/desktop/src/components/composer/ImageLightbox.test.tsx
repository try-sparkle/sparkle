// @vitest-environment jsdom
//
// The lightbox's failure surface (roborev 53760). Both of its actions read `att.path` off disk, and
// since a SENT message keeps its attachments in the transcript (PRD §8) that path is routinely a
// temp file the OS has since reaped — so a failure here is the expected case, not an exotic one.
// It used to be swallowed into the log: the user picked a save location and then nothing happened.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  copy: vi.fn(async () => {}),
  download: vi.fn(async () => {}),
}));
vi.mock("./attachmentsApi", () => ({
  copyImageToClipboard: h.copy,
  downloadAttachment: h.download,
}));

import { ImageLightbox } from "./ImageLightbox";
import type { Attachment } from "./attachments";

const att: Attachment = {
  id: "s1",
  kind: "image",
  path: "/tmp/gone.png",
  name: "gone.png",
  dataUrl: "data:image/png;base64,AAA",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.copy.mockResolvedValue(undefined);
  h.download.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("ImageLightbox — failures are shown, not only logged", () => {
  it("says so when the download fails", async () => {
    h.download.mockRejectedValue(new Error("no such file"));
    render(<ImageLightbox att={att} onClose={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByTitle("Download…"));
    });
    expect(screen.getByRole("alert").textContent).toContain("Couldn't save that file");
  });

  it("says so when the copy fails", async () => {
    h.copy.mockRejectedValue(new Error("no such file"));
    render(<ImageLightbox att={att} onClose={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByTitle("Copy image to clipboard"));
    });
    expect(screen.getByRole("alert").textContent).toContain("Couldn't copy that image");
  });

  it("clears a stale failure when the next attempt succeeds", async () => {
    h.download.mockRejectedValueOnce(new Error("no such file"));
    render(<ImageLightbox att={att} onClose={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByTitle("Download…"));
    });
    expect(screen.queryByRole("alert")).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTitle("Download…"));
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("stays quiet on a download that works", async () => {
    render(<ImageLightbox att={att} onClose={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByTitle("Download…"));
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
