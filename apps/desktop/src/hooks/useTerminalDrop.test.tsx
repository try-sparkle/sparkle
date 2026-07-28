// @vitest-environment jsdom
//
// Dropping files on an agent's TERMINAL. Covers the things that make this correct rather than
// merely working:
//   - the paths are pasted into the TERMINAL THAT WAS DROPPED ON — not handed to the concierge
//     compose box on the other side of the window, which is the behavior this replaced;
//   - the paste is NOT submitted: one bracketed paste, no carriage return, so the user types the
//     ask and presses Enter themselves;
//   - it resolves to the VISIBLE pane, never a background one stacked at the same coordinates;
//   - the same files cannot be pasted into TWO agents when a pane is hidden mid-drag (the
//     async-unlisten race — see the `live` flag in useTerminalDrop);
//   - a dead PTY is REPORTED, not swallowed — the confirmation may never claim a delivery that
//     did not happen;
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
  paste: vi.fn(),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (h: (event: { payload: unknown }) => void) => {
      captured.handlers.push(h);
      return new Promise<() => void>(() => {});
    },
  }),
}));
// A real class, so the hook's `instanceof PtyGoneError` branch is the one under test rather than a
// stand-in that always falls through to the generic error path. Declared through vi.hoisted because
// the vi.mock factory below is hoisted above it otherwise.
const { FakePtyGoneError } = vi.hoisted(() => ({
  FakePtyGoneError: class FakePtyGoneError extends Error {
    constructor(readonly id: string) {
      super(`no such pty: ${id}`);
      this.name = "PtyGoneError";
    }
  },
}));
vi.mock("../pty", () => ({
  pasteIntoPty: (id: string, text: string) => captured.paste(id, text),
  PtyGoneError: FakePtyGoneError,
}));
vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  buildDroppedPathsPaste,
  isTerminalDropPosition,
  useTerminalDrop,
  type TerminalDrop,
} from "./useTerminalDrop";
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

/** Terminal focus requests, per agent — the caller's `onPasted` (AgentPane puts the caret in the
 *  terminal so the user can type onto the text they can now see sitting there). */
const focused: string[] = [];

/** One pane's view of the hook, keyed by agent id, so a test can read either pane's affordance.
 *  Published from an effect (not assigned during render) so this stays inside the rules of hooks;
 *  the un-keyed effect runs after every render, so a read after act() is always current. */
const panes: Record<string, TerminalDrop> = {};
function Pane({ agentId, visible }: { agentId: string; visible: boolean }) {
  const drop = useTerminalDrop(visible, agentId, () => focused.push(agentId));
  useEffect(() => {
    panes[agentId] = drop;
  });
  return null;
}

/** Fire a synthetic drag event at ONE handler — by default the most recently registered — and let
 *  the paste promise settle, since the confirmation is only written once the write has landed. */
const fireAt = (payload: DragPayload, index = captured.handlers.length - 1) =>
  act(async () => {
    captured.handlers[index]!({ payload });
    await Promise.resolve();
    await Promise.resolve();
  });

const pastedInto = (agentId: string) =>
  captured.paste.mock.calls.filter((c) => c[0] === agentId).map((c) => c[1] as string);

beforeEach(() => {
  vi.clearAllMocks();
  captured.handlers = [];
  captured.paste.mockResolvedValue(undefined);
  cursorOver = "stage";
  focused.length = 0;
  document.elementFromPoint = vi.fn(() =>
    cursorOver === "stage" ? stageEl : cursorOver === "button" ? buttonEl : document.body,
  );
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

describe("buildDroppedPathsPaste", () => {
  it("space-joins the paths and leaves the caret clear of the last one", () => {
    // The trailing space is what stops the user's next character being glued onto the path.
    expect(buildDroppedPathsPaste(["/tmp/a.png", "/tmp/b.log"])).toBe("/tmp/a.png /tmp/b.log ");
  });

  it("shell-quotes a path that needs it, so it survives as ONE INERT token", () => {
    // The rule itself lives in services/shellQuote (shared with the composer's send payload, which
    // reaches the same shells); this asserts the drop path actually applies it.
    expect(buildDroppedPathsPaste(["/Users/me/My Photos/a.png"])).toBe(
      "'/Users/me/My Photos/a.png' ",
    );
    expect(buildDroppedPathsPaste(["/tmp/a`id`.png"])).toBe("'/tmp/a`id`.png' ");
  });
});

describe("pasting a drop into the agent's own terminal", () => {
  beforeEach(() => {
    render(<Pane agentId="agent-a" visible />);
  });

  it("pastes the dropped paths into THAT agent's terminal", async () => {
    // The whole point of the change: the drop lands where it was dropped, not in the Sparkle box.
    await fireAt({ type: "drop", position: at, paths: ["/tmp/a.png", "/tmp/b.log"] });
    expect(pastedInto("agent-a")).toEqual(["/tmp/a.png /tmp/b.log "]);
  });

  it("does NOT submit — no carriage return is ever written", async () => {
    // pasteIntoPty is the no-CR primitive; a submit would go through submitPrompt instead. Assert
    // on the payload too, so a future "helpful" \n can't sneak in on the same call.
    await fireAt({ type: "drop", position: at, paths: ["/tmp/a.png"] });
    expect(captured.paste).toHaveBeenCalledTimes(1);
    expect(pastedInto("agent-a")[0]).not.toMatch(/[\r\n]/);
  });

  it("reports what landed, and that it landed", async () => {
    await fireAt({ type: "drop", position: at, paths: ["/tmp/a.png"] });
    expect(panes["agent-a"]!.dropped).toEqual({ count: 1, images: 1, delivered: true });
  });

  it("gives the terminal the caret, so the user can type the ask onto the pasted path", async () => {
    await fireAt({ type: "drop", position: at, paths: ["/tmp/a.png"] });
    expect(focused).toEqual(["agent-a"]);
  });

  it("accepts NON-IMAGE files — image-ness only picks the wording", async () => {
    await fireAt({ type: "drop", position: at, paths: ["/tmp/server.log", "/tmp/data.csv"] });
    expect(pastedInto("agent-a")).toEqual(["/tmp/server.log /tmp/data.csv "]);
    expect(panes["agent-a"]!.dropped).toEqual({ count: 2, images: 0, delivered: true });
  });

  it("counts a mixed drop honestly, so the copy never calls a .csv an image", async () => {
    await fireAt({ type: "drop", position: at, paths: ["/tmp/a.png", "/tmp/notes.txt"] });
    expect(panes["agent-a"]!.dropped).toEqual({ count: 2, images: 1, delivered: true });
  });

  it("ignores a drop on the '+ New Build Agent' button", async () => {
    cursorOver = "button";
    await fireAt({ type: "drop", position: at, paths: ["/tmp/a.png"] });
    expect(captured.paste).not.toHaveBeenCalled();
  });

  it("ignores a drop outside the stage", async () => {
    cursorOver = "elsewhere";
    await fireAt({ type: "drop", position: at, paths: ["/tmp/a.png"] });
    expect(captured.paste).not.toHaveBeenCalled();
  });

  it("ignores a pathless drop", async () => {
    await fireAt({ type: "drop", position: at, paths: [] });
    expect(captured.paste).not.toHaveBeenCalled();
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

describe("a paste that does not land", () => {
  beforeEach(() => {
    render(<Pane agentId="agent-a" visible />);
  });

  it("says so when the agent's PTY is gone, instead of claiming a delivery", async () => {
    // The file went NOWHERE — it isn't a chip the user can find either, now that the drop no
    // longer stages one. A silent failure here loses it completely.
    captured.paste.mockRejectedValue(new FakePtyGoneError("agent-a"));
    await fireAt({ type: "drop", position: at, paths: ["/tmp/a.png"] });
    expect(panes["agent-a"]!.dropped).toEqual({ count: 1, images: 1, delivered: false });
  });

  it("does not steal the caret for a paste that never arrived", async () => {
    captured.paste.mockRejectedValue(new FakePtyGoneError("agent-a"));
    await fireAt({ type: "drop", position: at, paths: ["/tmp/a.png"] });
    expect(focused).toEqual([]);
  });

  it("reports an unexpected failure the same way — the user's fact is identical", async () => {
    captured.paste.mockRejectedValue(new Error("IPC exploded"));
    await fireAt({ type: "drop", position: at, paths: ["/tmp/a.png"] });
    expect(panes["agent-a"]!.dropped).toEqual({ count: 1, images: 1, delivered: false });
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
    expect(captured.paste.mock.calls).toEqual([["fg", "/tmp/a.png "]]);
  });

  it("a pane hidden mid-drag cannot paste the SAME files into a second agent", async () => {
    // THE RACE. Unlistening has to await the listen() promise, which in a real webview is an IPC
    // round-trip — so for a tick the just-hidden pane's handler is still registered alongside the
    // newly-visible pane's, and Tauri fans the drop to BOTH. Without the synchronous liveness flag
    // this writes the paths into two agents' terminals, and a terminal write cannot be taken back.
    // The unlisten promise here never resolves, which holds that window open for the whole test.
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

    expect(pastedInto("was-visible")).toEqual([]);
    expect(pastedInto("now-visible")).toEqual(["/tmp/shared.png "]);
  });

  it("hiding a pane clears its affordance and its confirmation", async () => {
    const { rerender } = render(<Pane agentId="a" visible />);
    await fireAt({ type: "enter", position: at, paths: ["/tmp/a.png"] });
    await fireAt({ type: "drop", position: at, paths: ["/tmp/a.png"] });
    expect(panes["a"]!.dropped).not.toBeNull();

    await act(async () => rerender(<Pane agentId="a" visible={false} />));
    expect(panes["a"]!.dropActive).toBe(false);
    expect(panes["a"]!.dropped).toBeNull();
    // The paste already landed in the terminal, where it stays — a cleared confirmation costs the
    // user nothing.
    expect(pastedInto("a")).toEqual(["/tmp/a.png "]);
  });
});
