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
import { CONCIERGE_COMPOSE_DND_TARGET, NEW_BUILD_AGENT_DND_TARGET } from "../services/dndTargets";
import { useTerminalDropStore } from "../stores/terminalDropStore";
import type { Attachment } from "../components/composer/attachments";

const file = (id: string): Attachment => ({
  id,
  kind: "file",
  path: "/tmp/" + id,
  name: id,
});

let api: ConciergeAttachments;
function Host() {
  api = useConciergeAttachments();
  return null;
}

// The hit test uses document.elementFromPoint (unimplemented in jsdom).
const boxEl = document.createElement("div");
boxEl.setAttribute("data-dnd-target", CONCIERGE_COMPOSE_DND_TARGET);
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
  captured.pick.mockResolvedValue([]);
  captured.loadPaths.mockResolvedValue([]);
  useTerminalDropStore.setState({ queue: [] });
  render(<Host />);
});
afterEach(() => cleanup());

describe("staging attachments", () => {
  it("starts empty", () => {
    expect(api.attachments).toEqual([]);
    expect(api.dropActive).toBe(false);
  });

  it("stages what the picker returned, for the kind the user clicked", async () => {
    captured.pick.mockResolvedValue([file("a")]);
    await act(async () => {
      api.attach("image");
      await Promise.resolve();
    });
    expect(captured.pick).toHaveBeenCalledWith("image");
    expect(api.attachments.map((a) => a.id)).toEqual(["a"]);
  });

  it("appends across successive picks rather than replacing", async () => {
    captured.pick.mockResolvedValueOnce([file("a")]).mockResolvedValueOnce([file("b")]);
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
    captured.pick.mockResolvedValue(ids.map(file));
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

  it("attaches files dropped ON the box", async () => {
    captured.loadPaths.mockResolvedValue([file("a"), file("b")]);
    cursorOver = "box";
    await fire({ type: "drop", position: at, paths: ["/tmp/a", "/tmp/b"] });
    expect(captured.loadPaths).toHaveBeenCalledWith(["/tmp/a", "/tmp/b"]);
    expect(api.attachments.map((x) => x.id)).toEqual(["a", "b"]);
    expect(api.dropActive).toBe(false);
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

// Files dropped on an agent's TERMINAL (hooks/useTerminalDrop) reach the box through this hook, so
// they become the SAME chips the pickers produce and inherit remove / take / restore rather than
// growing a second attachment mechanism beside them.
describe("pickup of a terminal drop", () => {
  it("stages what was dropped on the terminal, through the ordinary load path", async () => {
    captured.loadPaths.mockResolvedValue([file("dropped")]);
    await act(async () => {
      useTerminalDropStore.getState().enqueue("agent-a", ["/tmp/shot.png"]);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(captured.loadPaths).toHaveBeenCalledWith(["/tmp/shot.png"]);
    expect(api.attachments.map((a) => a.id)).toEqual(["dropped"]);
  });

  it("takes the queue exactly once — a second pickup delivers nothing twice", async () => {
    captured.loadPaths.mockResolvedValue([file("dropped")]);
    await act(async () => {
      useTerminalDropStore.getState().enqueue("agent-a", ["/tmp/shot.png"]);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(useTerminalDropStore.getState().queue).toEqual([]);
    expect(captured.loadPaths).toHaveBeenCalledTimes(1);
    expect(api.attachments).toHaveLength(1);
  });

  it("appends to files already staged by the pickers rather than replacing them", async () => {
    captured.pick.mockResolvedValue([file("picked")]);
    await act(async () => {
      api.attach("files");
      await Promise.resolve();
    });
    captured.loadPaths.mockResolvedValue([file("dropped")]);
    await act(async () => {
      useTerminalDropStore.getState().enqueue("agent-a", ["/tmp/shot.png"]);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.attachments.map((a) => a.id)).toEqual(["picked", "dropped"]);
  });

  it("accepts NON-IMAGE paths — the payload is paths the agent reads off disk", async () => {
    captured.loadPaths.mockResolvedValue([file("server.log")]);
    await act(async () => {
      useTerminalDropStore.getState().enqueue("agent-a", ["/tmp/server.log"]);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(captured.loadPaths).toHaveBeenCalledWith(["/tmp/server.log"]);
    expect(api.attachments.map((a) => a.id)).toEqual(["server.log"]);
  });

  it("picks up a drop that landed BEFORE the column mounted", async () => {
    // The drop can beat this effect by a tick; files staged nowhere would be silently lost.
    cleanup();
    useTerminalDropStore.getState().enqueue("agent-a", ["/tmp/early.png"]);
    captured.loadPaths.mockResolvedValue([file("early")]);
    await act(async () => {
      render(<Host />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.attachments.map((a) => a.id)).toEqual(["early"]);
  });

  it("a dropped file is removable and restorable like any other", async () => {
    // The whole point of feeding the existing list: a mis-drop is undoable without sending it, and
    // a send that does not land hands the files back (ConciergeHost calls restore on failure).
    captured.loadPaths.mockResolvedValue([file("dropped")]);
    await act(async () => {
      useTerminalDropStore.getState().enqueue("agent-a", ["/tmp/shot.png"]);
      await Promise.resolve();
      await Promise.resolve();
    });
    let staged: Attachment[] = [];
    act(() => {
      staged = api.take();
    });
    expect(staged.map((a) => a.id)).toEqual(["dropped"]);
    expect(api.attachments).toEqual([]);

    act(() => api.restore(staged));
    expect(api.attachments.map((a) => a.id)).toEqual(["dropped"]);

    act(() => api.remove("dropped"));
    expect(api.attachments).toEqual([]);
  });
});
