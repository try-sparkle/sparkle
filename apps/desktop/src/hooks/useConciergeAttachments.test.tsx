// @vitest-environment jsdom
//
// Attachment state for the concierge compose box (parity row #21, bead sparkle-4562.3):
// add via picker, add via a drop ON the box, remove one, take-and-clear at send time, and
// restore after a send that did not land. Plus the drop scoping that keeps this listener from
// stealing a drop meant for "+ New Build Agent".
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type DragPayload =
  | { type: "enter" | "over"; position: { x: number; y: number }; paths?: string[] }
  | { type: "drop"; position: { x: number; y: number }; paths: string[] }
  | { type: "leave" };

const captured = vi.hoisted(() => ({
  handler: null as ((event: { payload: unknown }) => void) | null,
  pick: vi.fn(),
  loadPaths: vi.fn(),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (h: (event: { payload: unknown }) => void) => {
      captured.handler = h;
      return Promise.resolve(() => {
        captured.handler = null;
      });
    },
  }),
}));
vi.mock("../services/conciergeAttach", () => ({
  pickAttachments: captured.pick,
  loadAttachmentPaths: captured.loadPaths,
}));
vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { useConciergeAttachments, type ConciergeAttachments } from "./useConciergeAttachments";
import { CONCIERGE_COLUMN_DND_TARGET, NEW_BUILD_AGENT_DND_TARGET } from "../services/dndTargets";
import type { Attachment } from "../components/composer/attachments";
import type { AttachFailure } from "../services/conciergeAttach";

const file = (id: string): Attachment => ({
  id,
  kind: "file",
  path: "/tmp/" + id,
  name: id,
});

/** The successful shape of an AttachOutcome — the loader/picker now report failures too. */
const ok = (attachments: Attachment[]) => ({ attachments, failed: [] as AttachFailure[] });
/** One named failure with its reason — what the loader now hands back. */
const bad = (name: string, reason = "the file no longer exists") => ({ name, reason });

let api: ConciergeAttachments;
function Host() {
  api = useConciergeAttachments();
  return null;
}

// The hit test uses document.elementFromPoint (unimplemented in jsdom).
const boxEl = document.createElement("div");
boxEl.setAttribute("data-dnd-target", CONCIERGE_COLUMN_DND_TARGET);
const buttonEl = document.createElement("button");
buttonEl.setAttribute("data-dnd-target", NEW_BUILD_AGENT_DND_TARGET);
let cursorOver: "box" | "button" | "elsewhere" = "elsewhere";
const at = { x: 10, y: 10 };

const fire = async (payload: DragPayload) => {
  await act(async () => {
    captured.handler!({ payload });
    await Promise.resolve();
    await Promise.resolve();
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  cursorOver = "elsewhere";
  document.elementFromPoint = vi.fn(() =>
    cursorOver === "box" ? boxEl : cursorOver === "button" ? buttonEl : document.body,
  );
  captured.pick.mockResolvedValue(ok([]));
  captured.loadPaths.mockResolvedValue(ok([]));
  render(<Host />);
});
afterEach(() => cleanup());

describe("staging attachments", () => {
  it("starts empty", () => {
    expect(api.attachments).toEqual([]);
    expect(api.dropActive).toBe(false);
  });

  it("stages what the picker returned, for the kind the user clicked", async () => {
    captured.pick.mockResolvedValue(ok([file("a")]));
    await act(async () => {
      api.attach("image");
      await Promise.resolve();
    });
    expect(captured.pick).toHaveBeenCalledWith("image");
    expect(api.attachments.map((a) => a.id)).toEqual(["a"]);
  });

  it("appends across successive picks rather than replacing", async () => {
    captured.pick.mockResolvedValueOnce(ok([file("a")])).mockResolvedValueOnce(ok([file("b")]));
    await act(async () => {
      api.attach("files");
      await Promise.resolve();
    });
    await act(async () => {
      api.attach("screenshot");
      await Promise.resolve();
    });
    expect(api.attachments.map((a) => a.id)).toEqual(["a", "b"]);
  });

  it("a cancelled picker stages nothing", async () => {
    await act(async () => {
      api.attach("files");
      await Promise.resolve();
    });
    expect(api.attachments).toEqual([]);
  });
});

describe("remove / take / restore", () => {
  const stage = async (...ids: string[]) => {
    captured.pick.mockResolvedValue(ok(ids.map(file)));
    await act(async () => {
      api.attach("files");
      await Promise.resolve();
    });
  };

  it("removes one chip by id and leaves the rest", async () => {
    await stage("a", "b", "c");
    act(() => api.remove("b"));
    expect(api.attachments.map((x) => x.id)).toEqual(["a", "c"]);
  });

  it("take() returns the staged list and clears it in the same tick", async () => {
    await stage("a", "b");
    let taken: Attachment[] = [];
    act(() => {
      taken = api.take();
    });
    expect(taken.map((x) => x.id)).toEqual(["a", "b"]);
    expect(api.attachments).toEqual([]);
  });

  it("a second take() after a send returns nothing (no double delivery)", async () => {
    await stage("a");
    act(() => {
      api.take();
    });
    let second: Attachment[] = [];
    act(() => {
      second = api.take();
    });
    expect(second).toEqual([]);
  });

  it("restore() puts a failed send's files back, in front of anything newer", async () => {
    await stage("a");
    let taken: Attachment[] = [];
    act(() => {
      taken = api.take();
    });
    await stage("b");
    act(() => api.restore(taken));
    expect(api.attachments.map((x) => x.id)).toEqual(["a", "b"]);
  });
});

describe("drag and drop onto the compose box", () => {
  it("lights the drop affordance only while the cursor is over the box", async () => {
    cursorOver = "box";
    await fire({ type: "over", position: at });
    expect(api.dropActive).toBe(true);
    cursorOver = "elsewhere";
    await fire({ type: "over", position: at });
    expect(api.dropActive).toBe(false);
  });

  it("clears the affordance when the drag leaves the window", async () => {
    cursorOver = "box";
    await fire({ type: "enter", position: at, paths: ["/tmp/a"] });
    expect(api.dropActive).toBe(true);
    await fire({ type: "leave" });
    expect(api.dropActive).toBe(false);
  });

  it("attaches files dropped anywhere on the column", async () => {
    captured.loadPaths.mockResolvedValue(ok([file("a"), file("b")]));
    cursorOver = "box";
    await fire({ type: "drop", position: at, paths: ["/tmp/a", "/tmp/b"] });
    expect(captured.loadPaths).toHaveBeenCalledWith(["/tmp/a", "/tmp/b"]);
    expect(api.attachments.map((x) => x.id)).toEqual(["a", "b"]);
    expect(api.dropActive).toBe(false);
  });

  it("attaches EVERY file in one multi-file drop, not just the first", async () => {
    // Finder hands the whole selection over in a single drop payload; taking paths[0] (or
    // otherwise losing the tail) would silently drop files the user watched themselves select.
    const many = ["/tmp/a.png", "/tmp/b.png", "/tmp/c.log", "/tmp/d.csv"];
    captured.loadPaths.mockResolvedValue(ok(many.map((p, i) => file(String.fromCharCode(97 + i)))));
    cursorOver = "box";
    await fire({ type: "drop", position: at, paths: many });
    expect(captured.loadPaths).toHaveBeenCalledWith(many);
    expect(api.attachments.map((x) => x.id)).toEqual(["a", "b", "c", "d"]);
  });
});

// THE REPORTED BUG (bead sparkle-zviq): the box lights up under the drag, the drop is classified
// and logged, and then the file is discarded with nothing said. A user-initiated action that fails
// must never leave the user to notice an absence.
describe("a drop that loses files says so", () => {
  it("raises a notice naming the file that did not attach", async () => {
    captured.loadPaths.mockResolvedValue({
      attachments: [],
      failed: [bad("notes.txt", "Sparkle isn't allowed to read that folder")],
    });
    cursorOver = "box";
    await fire({ type: "drop", position: at, paths: ["/private/tmp/notes.txt"] });
    expect(api.attachments).toEqual([]);
    expect(api.attachNotice).toMatch(/notes\.txt/);
    // The REASON, not just the name. The app knew why it refused and said nothing — a notice that
    // repeats the silence in a louder font fixes nothing.
    expect(api.attachNotice).toMatch(/allowed to read that folder/i);
  });

  it("stays silent when every dropped file attached", async () => {
    captured.loadPaths.mockResolvedValue(ok([file("a")]));
    cursorOver = "box";
    await fire({ type: "drop", position: at, paths: ["/tmp/a"] });
    expect(api.attachNotice).toBeNull();
  });

  it("still stages the files that DID load alongside the notice", async () => {
    // A partial failure must not cost the user the rest of the batch, and must not hide it either.
    captured.loadPaths.mockResolvedValue({
      attachments: [file("a")],
      failed: [bad("bad.txt", "permission denied")],
    });
    cursorOver = "box";
    await fire({ type: "drop", position: at, paths: ["/tmp/a", "/tmp/bad.txt"] });
    expect(api.attachments.map((x) => x.id)).toEqual(["a"]);
    expect(api.attachNotice).toMatch(/bad\.txt/);
    expect(api.attachNotice).toMatch(/permission denied/i);
  });

  it("retracts the notice once a later drop succeeds", async () => {
    captured.loadPaths.mockResolvedValue({ attachments: [], failed: [bad("bad.txt")] });
    cursorOver = "box";
    await fire({ type: "drop", position: at, paths: ["/tmp/bad.txt"] });
    expect(api.attachNotice).toMatch(/bad\.txt/);

    captured.loadPaths.mockResolvedValue(ok([file("a")]));
    await fire({ type: "drop", position: at, paths: ["/tmp/a"] });
    expect(api.attachNotice).toBeNull();
  });

  it("clears the notice when the user dismisses it", async () => {
    captured.loadPaths.mockResolvedValue({ attachments: [], failed: [bad("bad.txt")] });
    cursorOver = "box";
    await fire({ type: "drop", position: at, paths: ["/tmp/bad.txt"] });
    expect(api.attachNotice).not.toBeNull();
    await act(async () => api.dismissNotice());
    expect(api.attachNotice).toBeNull();
  });

  it("reports a picker failure that names no file at all", async () => {
    captured.pick.mockResolvedValue({
      attachments: [],
      failed: [],
      error: "The file picker could not be opened.",
    });
    await act(async () => api.attach("files"));
    expect(api.attachNotice).toBe("The file picker could not be opened.");
  });

  it("says nothing when the picker was merely cancelled", async () => {
    captured.pick.mockResolvedValue(ok([]));
    await act(async () => api.attach("files"));
    expect(api.attachNotice).toBeNull();
  });
});

// The other two window-global drop listeners must keep their drops (no listener-order assumption
// anywhere): a drop on the New Build Agent button spawns an agent, a drop elsewhere belongs to the
// Sparkle pane composer. Neither may also land here.
describe("drop scoping", () => {
  it("ignores a drop on the New Build Agent button", async () => {
    cursorOver = "button";
    await fire({ type: "drop", position: at, paths: ["/tmp/a"] });
    expect(captured.loadPaths).not.toHaveBeenCalled();
    expect(api.attachments).toEqual([]);
  });

  it("ignores a drop anywhere outside the compose box", async () => {
    cursorOver = "elsewhere";
    await fire({ type: "drop", position: at, paths: ["/tmp/a"] });
    expect(captured.loadPaths).not.toHaveBeenCalled();
  });

  it("ignores a pathless drop on the box", async () => {
    cursorOver = "box";
    await fire({ type: "drop", position: at, paths: [] });
    expect(captured.loadPaths).not.toHaveBeenCalled();
  });
});

describe("a multi-file failure names every file but states the cause once", () => {
  it("groups several failures under their shared reason, stating it once", async () => {
    captured.loadPaths.mockResolvedValue({
      attachments: [],
      failed: [bad("a.txt", "permission denied"), bad("b.txt", "permission denied")],
    });
    cursorOver = "box";
    await fire({ type: "drop", position: at, paths: ["/tmp/a.txt", "/tmp/b.txt"] });
    expect(api.attachNotice).toMatch(/a\.txt/);
    expect(api.attachNotice).toMatch(/b\.txt/);
    // Stated ONCE — repeating it per file buries the cause in the list of names.
    expect(api.attachNotice!.match(/permission denied/gi)).toHaveLength(1);
  });
});
