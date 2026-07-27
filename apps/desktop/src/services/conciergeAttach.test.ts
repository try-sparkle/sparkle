// The concierge compose box's attachment seam (parity row #21, bead sparkle-4562.3):
//  - each attach KIND runs the right native picker, and a cancel stages nothing
//  - a picker/dialog failure resolves empty rather than rejecting into the compose box
//  - one unreadable file does not cost the user the rest of the batch
//  - the payload prefixes real paths (what the agent/brain reads) while the display never does
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  open: vi.fn(),
  captureScreenRegion: vi.fn(),
  loadAttachment: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: h.open }));
vi.mock("../screenshot", () => ({ captureScreenRegion: h.captureScreenRegion }));
// Only load_attachment is stubbed; screenshotAttachment stays real so the adapter is covered too.
vi.mock("../components/composer/attachmentsApi", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, loadAttachment: h.loadAttachment };
});

import {
  attachedDisplay,
  attachedPayload,
  loadAttachmentPaths,
  pickAttachments,
} from "./conciergeAttach";
import type { Attachment } from "../components/composer/attachments";

const att = (over: Partial<Attachment> = {}): Attachment => ({
  id: "a1",
  kind: "image",
  path: "/tmp/shot.png",
  name: "shot.png",
  dataUrl: "data:image/png;base64,AAA",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.loadAttachment.mockImplementation(async (path: string) =>
    att({ id: "att-" + path, path, name: path, kind: "file", dataUrl: undefined }),
  );
});

describe("pickAttachments — screenshot", () => {
  it("captures a region and stages it as an image attachment", async () => {
    h.captureScreenRegion.mockResolvedValue({ path: "/tmp/s.png", dataUrl: "data:image/png;base64,AAA" });
    const out = await pickAttachments("screenshot");
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("image");
    expect(out[0]?.path).toBe("/tmp/s.png");
    expect(h.open).not.toHaveBeenCalled();
  });

  it("stages nothing when the user presses Esc (the capture resolves null)", async () => {
    h.captureScreenRegion.mockResolvedValue(null);
    expect(await pickAttachments("screenshot")).toEqual([]);
  });

  it("stages nothing (rather than rejecting) when the capture throws", async () => {
    h.captureScreenRegion.mockRejectedValue(new Error("no screen-recording permission"));
    expect(await pickAttachments("screenshot")).toEqual([]);
  });
});

describe("pickAttachments — image / files", () => {
  it("opens a multi-select image dialog and loads every pick", async () => {
    h.open.mockResolvedValue(["/tmp/a.png", "/tmp/b.png"]);
    const out = await pickAttachments("image");
    expect(out.map((a) => a.path)).toEqual(["/tmp/a.png", "/tmp/b.png"]);
    const opts = h.open.mock.calls[0]?.[0] as {
      multiple: boolean;
      filters?: { extensions: string[] }[];
    };
    expect(opts.multiple).toBe(true);
    expect(opts.filters?.[0]?.extensions).toContain("png");
  });

  it("opens an UNFILTERED multi-select dialog for files", async () => {
    h.open.mockResolvedValue(["/tmp/log.txt"]);
    const out = await pickAttachments("files");
    expect(out.map((a) => a.path)).toEqual(["/tmp/log.txt"]);
    const opts = h.open.mock.calls[0]?.[0] as { multiple: boolean; filters?: unknown };
    expect(opts.multiple).toBe(true);
    expect(opts.filters).toBeUndefined();
  });
});

describe("pickAttachments — cancels and failures", () => {
  it("accepts a single-path return as well as an array", async () => {
    h.open.mockResolvedValue("/tmp/only.png");
    const out = await pickAttachments("image");
    expect(out.map((a) => a.path)).toEqual(["/tmp/only.png"]);
  });

  it("stages nothing when the picker is cancelled", async () => {
    h.open.mockResolvedValue(null);
    expect(await pickAttachments("files")).toEqual([]);
  });

  it("stages nothing (rather than rejecting) when the dialog cannot open", async () => {
    h.open.mockRejectedValue(new Error("NSOpenPanel returned nil"));
    expect(await pickAttachments("files")).toEqual([]);
  });
});

describe("loadAttachmentPaths", () => {
  it("keeps the readable files and drops only the one that failed", async () => {
    h.loadAttachment.mockImplementation(async (path: string) => {
      if (path === "/tmp/bad") throw new Error("EACCES");
      return att({ id: "att-" + path, path, name: path, kind: "file", dataUrl: undefined });
    });
    const out = await loadAttachmentPaths(["/tmp/ok1", "/tmp/bad", "/tmp/ok2"]);
    expect(out.map((a) => a.path)).toEqual(["/tmp/ok1", "/tmp/ok2"]);
  });
});

// What the AGENT reads vs what the THREAD shows are deliberately different renderings of the same
// message: the removed composer contract, kept (buildSendPayload / buildDisplay).
describe("payload vs display", () => {
  // A path with whitespace is the case quotePath exists for.
  const spaced = "/tmp/my@shots/a.png".replace("@", " ");
  const atts = [
    att({ id: "1", path: spaced, name: "a.png" }),
    att({ id: "2", path: "/tmp/log.txt", name: "log.txt", kind: "file", dataUrl: undefined }),
  ];
  const both = JSON.stringify(spaced) + " /tmp/log.txt";

  it("prefixes the (quoted) real paths to the typed text for the target", () => {
    expect(attachedPayload("  look at this  ", atts)).toBe(both + " look at this");
  });

  it("sends the attachments alone when the user typed nothing", () => {
    expect(attachedPayload("", atts)).toBe(both);
  });

  it("is a plain trimmed prompt when nothing is attached", () => {
    expect(attachedPayload("  ship it  ", [])).toBe("ship it");
  });

  it("never leaks a temp path into what the thread shows", () => {
    const display = attachedDisplay("look at this", atts);
    expect(display).toContain("look at this");
    expect(display).not.toContain("tmp");
    expect(display).toContain("1 image");
    expect(display).toContain("1 file");
  });

  // roborev 46911: this string lands in the concierge thread AND the pinned prompt header, both
  // governed by the app-wide "no emoji as icons — icons come from react-icons/fi" rule. It used to
  // be `buildDisplay`, whose `📷 1 image` glyphs were fine inside the old composer's own tile row
  // and are not fine here. The counts are pinned above; this pins the absence of the glyphs, which
  // is the half that silently regresses.
  it("renders the counts with no emoji", () => {
    const display = attachedDisplay("look at this", atts);
    expect(display).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("counts anything that is not an IMAGE as a file, including a kind added later", () => {
    // The split is `kind === "image"` vs everything else, so a future Attachment kind still shows
    // up in the counts rather than vanishing from them. Asserted with a kind outside today's union
    // (cast) — using the existing `kind: "file"` fixture would only re-test the line above
    // (roborev 49293).
    const future = { ...atts[1]!, id: "3", kind: "audio" as unknown as "file" };
    const display = attachedDisplay("", [atts[0]!, future]);
    expect(display).toMatch(/1 image/);
    expect(display).toMatch(/1 file/);
    expect(attachedDisplay("", [future, { ...future, id: "4" }])).toMatch(/2 files/);
  });
});
