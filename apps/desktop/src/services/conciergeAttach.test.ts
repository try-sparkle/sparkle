// The concierge compose box's attachment seam (parity row #21, bead sparkle-4562.3):
//  - each attach KIND runs the right native picker, and a cancel stages nothing
//  - a picker/dialog failure resolves empty rather than rejecting into the compose box
//  - one unreadable file does not cost the user the rest of the batch
//  - the payload prefixes real paths (what the agent/brain reads) while the display never does
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  pickFiles: vi.fn(),
  captureScreenRegion: vi.fn(),
  loadAttachment: vi.fn(),
}));

// The picker seam is services/dialog.ts's pickFiles, NOT the plugin's open() — see the guard test
// at the bottom of this file for why that distinction is load-bearing.
vi.mock("./dialog", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, pickFiles: h.pickFiles };
});
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
    expect(h.pickFiles).not.toHaveBeenCalled();
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
  it("opens an image picker narrowed to the image extensions and loads every pick", async () => {
    h.pickFiles.mockResolvedValue(["/tmp/a.png", "/tmp/b.png"]);
    const out = await pickAttachments("image");
    expect(out.map((a) => a.path)).toEqual(["/tmp/a.png", "/tmp/b.png"]);
    const [title, extensions] = h.pickFiles.mock.calls[0] as [string, string[]];
    expect(title).toMatch(/image/i);
    expect(extensions).toContain("png");
  });

  it("opens an UNFILTERED picker for files", async () => {
    h.pickFiles.mockResolvedValue(["/tmp/log.txt"]);
    const out = await pickAttachments("files");
    expect(out.map((a) => a.path)).toEqual(["/tmp/log.txt"]);
    const [title, extensions] = h.pickFiles.mock.calls[0] as [string, string[] | undefined];
    expect(title).toMatch(/file/i);
    expect(extensions).toBeUndefined();
  });
});

describe("pickAttachments — cancels and failures", () => {
  it("stages nothing when the picker is cancelled (an empty list)", async () => {
    h.pickFiles.mockResolvedValue([]);
    expect(await pickAttachments("files")).toEqual([]);
  });

  // pickFiles already swallows a refused panel into [], so this is defence in depth: the compose box
  // must survive a picker that rejects no matter which layer stopped catching.
  it("stages nothing (rather than rejecting) when the picker throws", async () => {
    h.pickFiles.mockRejectedValue(new Error("picker unavailable"));
    expect(await pickAttachments("files")).toEqual([]);
  });
});

// The crash this guards against: +[NSOpenPanel openPanel] returns nil when the XPC service that
// vends panels cannot be launched, objc2-app-kit's generated binding UNWRAPS that nil, and
// tauri-plugin-dialog then panics a second time on the resulting RecvError. Two dead processes, no
// recovery. The directory picker moved to our own nil-checked Rust command for that reason and this
// path was left behind on the theory that files were unaffected — they were not, because it is one
// class method serving both modes. Re-importing the plugin here re-arms the crash, so the import is
// pinned rather than left to a comment.
describe("picker seam", () => {
  it("does NOT go through @tauri-apps/plugin-dialog", async () => {
    // Assert the raw source actually LOADED first: a swallowed ?raw import would leave `undefined`
    // to be stringified, which trivially fails to match and turns this guard into a no-op.
    const src = await import("./conciergeAttach?raw");
    expect(typeof src.default, "?raw import must yield the module source").toBe("string");
    expect(String(src.default)).not.toMatch(/from\s+["']@tauri-apps\/plugin-dialog["']/);
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
  // A path with whitespace is the case the quoting exists for. The rule is POSIX single-quoting
  // (services/shellQuote), NOT JSON/double quoting: this payload can reach a live `kind: "shell"`
  // tab, where submitPrompt supplies the carriage return itself (roborev 54375).
  const spaced = "/tmp/my@shots/a.png".replace("@", " ");
  const atts = [
    att({ id: "1", path: spaced, name: "a.png" }),
    att({ id: "2", path: "/tmp/log.txt", name: "log.txt", kind: "file", dataUrl: undefined }),
  ];
  const both = `'${spaced}' /tmp/log.txt`;

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
