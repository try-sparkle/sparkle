// @vitest-environment jsdom
//
// Dropping files on an agent's TERMINAL. Covers the four things that make this correct rather than
// merely working:
//   - the drop is queued for the agent whose pane was dropped on, and NOT sent;
//   - it resolves to the VISIBLE pane, never a background one stacked at the same coordinates;
//   - the same files cannot land on TWO agents when a pane is hidden mid-drag (the async-unlisten
//     race — see the `live` flag in useTerminalDrop);
//   - non-image files are accepted; image-ness only picks the confirmation's wording.
import { useEffect } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type DragPayload =
  | { type: "enter" | "over"; position: { x: number; y: number }; paths?: string[] }
  | { type: "drop"; position: { x: number; y: number }; paths: string[] }
  | { type: "leave" };

// Every registered handler is kept, and the unlisten promise NEVER resolves — which is exactly the
// real condition the `live` flag exists for: unlistening is an IPC round-trip, so a handler stays
// registered for a tick after its pane stops being visible. Tests can therefore fire at a STALE
// handler deliberately and assert it is inert.
const captured = vi.hoisted(() => ({
  handlers: [] as ((event: { payload: unknown }) => void)[],
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (h: (event: { payload: unknown }) => void) => {
      captured.handlers.push(h);
      return new Promise<() => void>(() => {});
    },
  }),
}));
vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { useTerminalDrop, isTerminalDropPosition, type TerminalDrop } from "./useTerminalDrop";
import { useTerminalDropStore } from "../stores/terminalDropStore";
import { useUiStore } from "../stores/uiStore";
import { NEW_BUILD_AGENT_DND_TARGET, TERMINAL_STAGE_DND_TARGET } from "../services/dndTargets";

// The hit test uses document.elementFromPoint (unimplemented in jsdom). The "+ New Build Agent"
// button is nested INSIDE the stage in the real DOM, so the button element's closest() must find
// the stage too — that is what makes the carve-out a real precedence rule rather than two
// unrelated regions.
const stageEl = document.createElement("div");
stageEl.setAttribute("data-dnd-target", TERMINAL_STAGE_DND_TARGET);
const buttonEl = document.createElement("button");
buttonEl.setAttribute("data-dnd-target", NEW_BUILD_AGENT_DND_TARGET);
stageEl.appendChild(buttonEl);

let cursorOver: "stage" | "button" | "elsewhere" = "stage";
const at = { x: 10, y: 10 };

/** One pane's view of the hook, keyed by agent id, so a test can read either pane's affordance.
 *  Published from an effect (not assigned during render) so this stays inside the rules of hooks;
 *  the un-keyed effect runs after every render, so a read after act() is always current. */
const panes: Record<string, TerminalDrop> = {};
function Pane({ agentId, visible }: { agentId: string; visible: boolean }) {
  const drop = useTerminalDrop(visible, agentId);
  useEffect(() => {
    panes[agentId] = drop;
  });
  return null;
}

/** Fire a synthetic drag event at ONE handler — by default the most recently registered. */
const fireAt = (payload: DragPayload, index = captured.handlers.length - 1) =>
  act(() => {
    captured.handlers[index]!({ payload });
  });

const queuedFor = (agentId: string) =>
  useTerminalDropStore.getState().queue.filter((b) => b.agentId === agentId);

beforeEach(() => {
  vi.clearAllMocks();
  captured.handlers = [];
  cursorOver = "stage";
  document.elementFromPoint = vi.fn(() =>
    cursorOver === "stage" ? stageEl : cursorOver === "button" ? buttonEl : document.body,
  );
  useTerminalDropStore.setState({ queue: [] });
});
afterEach(() => cleanup());

describe("isTerminalDropPosition", () => {
  it("claims the terminal stage", () => {
    cursorOver = "stage";
    expect(isTerminalDropPosition(at)).toBe(true);
  });

  it("stands down over the '+ New Build Agent' button nested inside it", () => {
    // That button spawns a NEW agent for its drops; this hook must not also claim them.
    cursorOver = "button";
    expect(isTerminalDropPosition(at)).toBe(false);
  });

  it("ignores anywhere outside the stage", () => {
    cursorOver = "elsewhere";
    expect(isTerminalDropPosition(at)).toBe(false);
  });
});

describe("attaching a drop to the visible agent", () => {
  beforeEach(() => {
    render(<Pane agentId="agent-a" visible />);
  });

  it("queues the dropped paths for that agent", async () => {
    await fireAt({ type: "drop", position: at, paths: ["/tmp/a.png", "/tmp/b.log"] });
    expect(useTerminalDropStore.getState().queue).toEqual([
      { agentId: "agent-a", paths: ["/tmp/a.png", "/tmp/b.log"] },
    ]);
  });

  it("does NOT send — it only stages, and says so", async () => {
    await fireAt({ type: "drop", position: at, paths: ["/tmp/a.png"] });
    // The confirmation reports what landed; nothing here writes to a PTY.
    expect(panes["agent-a"]!.dropped).toEqual({ count: 1, images: 1 });
  });

  it("gives the one compose box the caret so the user can type the ask", async () => {
    const before = useUiStore.getState().composeFocusSeq;
    await fireAt({ type: "drop", position: at, paths: ["/tmp/a.png"] });
    expect(useUiStore.getState().composeFocusSeq).toBe(before + 1);
  });

  it("accepts NON-IMAGE files — image-ness only picks the wording", async () => {
    await fireAt({ type: "drop", position: at, paths: ["/tmp/server.log", "/tmp/data.csv"] });
    expect(queuedFor("agent-a")[0]!.paths).toEqual(["/tmp/server.log", "/tmp/data.csv"]);
    expect(panes["agent-a"]!.dropped).toEqual({ count: 2, images: 0 });
  });

  it("counts a mixed drop honestly, so the copy never calls a .csv an image", async () => {
    await fireAt({ type: "drop", position: at, paths: ["/tmp/a.png", "/tmp/notes.txt"] });
    expect(panes["agent-a"]!.dropped).toEqual({ count: 2, images: 1 });
  });

  it("ignores a drop on the '+ New Build Agent' button", async () => {
    cursorOver = "button";
    await fireAt({ type: "drop", position: at, paths: ["/tmp/a.png"] });
    expect(useTerminalDropStore.getState().queue).toEqual([]);
  });

  it("ignores a drop outside the stage", async () => {
    cursorOver = "elsewhere";
    await fireAt({ type: "drop", position: at, paths: ["/tmp/a.png"] });
    expect(useTerminalDropStore.getState().queue).toEqual([]);
  });

  it("ignores a pathless drop", async () => {
    await fireAt({ type: "drop", position: at, paths: [] });
    expect(useTerminalDropStore.getState().queue).toEqual([]);
    expect(panes["agent-a"]!.dropped).toBeNull();
  });

  it("lights the drag-over affordance only over the stage, and clears it on leave and on drop", async () => {
    // A native OS drag fires no mouse events, so this flag is the ONLY drop signal the user gets.
    await fireAt({ type: "enter", position: at, paths: ["/tmp/a.png"] });
    expect(panes["agent-a"]!.dropActive).toBe(true);

    cursorOver = "elsewhere";
    await fireAt({ type: "over", position: at });
    expect(panes["agent-a"]!.dropActive).toBe(false);

    cursorOver = "stage";
    await fireAt({ type: "over", position: at });
    expect(panes["agent-a"]!.dropActive).toBe(true);

    await fireAt({ type: "leave" });
    expect(panes["agent-a"]!.dropActive).toBe(false);

    await fireAt({ type: "enter", position: at, paths: ["/tmp/a.png"] });
    await fireAt({ type: "drop", position: at, paths: ["/tmp/a.png"] });
    expect(panes["agent-a"]!.dropActive).toBe(false);
  });

  it("dismiss() clears the confirmation", async () => {
    await fireAt({ type: "drop", position: at, paths: ["/tmp/a.png"] });
    act(() => panes["agent-a"]!.dismiss());
    expect(panes["agent-a"]!.dropped).toBeNull();
  });
});

describe("resolving to the VISIBLE pane", () => {
  it("a background pane never listens, so it can never claim the drop", async () => {
    // Both panes stay MOUNTED and stacked at the same coordinates (Workspace keeps them alive so a
    // tab switch can't kill a PTY), so elementFromPoint alone cannot tell them apart — only one
    // subscribes at all.
    render(
      <>
        <Pane agentId="bg" visible={false} />
        <Pane agentId="fg" visible />
      </>,
    );
    expect(captured.handlers).toHaveLength(1); // the hidden pane registered nothing

    await fireAt({ type: "drop", position: at, paths: ["/tmp/a.png"] });
    expect(useTerminalDropStore.getState().queue).toEqual([
      { agentId: "fg", paths: ["/tmp/a.png"] },
    ]);
  });

  it("a pane hidden mid-drag cannot attach the SAME files to a second agent", async () => {
    // THE RACE. Unlistening has to await the listen() promise, which in a real webview is an IPC
    // round-trip — so for a tick the just-hidden pane's handler is still registered alongside the
    // newly-visible pane's, and Tauri fans the drop to BOTH. Without the synchronous liveness flag
    // this queues the same paths for two agents. The unlisten promise here never resolves, which
    // holds that window open for the whole test.
    const { rerender } = render(
      <>
        <Pane agentId="was-visible" visible />
        <Pane agentId="now-visible" visible={false} />
      </>,
    );
    expect(captured.handlers).toHaveLength(1);

    // The user switches agents while still dragging.
    rerender(
      <>
        <Pane agentId="was-visible" visible={false} />
        <Pane agentId="now-visible" visible />
      </>,
    );
    expect(captured.handlers).toHaveLength(2); // both handlers are live with Tauri right now

    const paths = ["/tmp/shared.png"];
    await fireAt({ type: "drop", position: at, paths }, 0); // the STALE handler
    await fireAt({ type: "drop", position: at, paths }, 1); // the current one

    expect(queuedFor("was-visible")).toEqual([]);
    expect(useTerminalDropStore.getState().queue).toEqual([{ agentId: "now-visible", paths }]);
  });

  it("hiding a pane clears its affordance and its confirmation", async () => {
    const { rerender } = render(<Pane agentId="a" visible />);
    await fireAt({ type: "enter", position: at, paths: ["/tmp/a.png"] });
    await fireAt({ type: "drop", position: at, paths: ["/tmp/a.png"] });
    expect(panes["a"]!.dropped).not.toBeNull();

    await act(async () => rerender(<Pane agentId="a" visible={false} />));
    expect(panes["a"]!.dropActive).toBe(false);
    expect(panes["a"]!.dropped).toBeNull();
    // The files were staged regardless — a cleared confirmation costs the user nothing.
    expect(queuedFor("a")).toHaveLength(1);
  });
});
