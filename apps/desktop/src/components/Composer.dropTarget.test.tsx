// @vitest-environment jsdom
//
// The composer's side of the "+ New Build Agent" drop target (see useNewBuildAgentDrop):
// drags/drops over the button are the button's — the composer suppresses its drop outline
// and must NOT attach the files — while drops anywhere else keep attaching here. Plus the
// negative half of the pending-attachments queue: this composer must NOT drain it. The drain
// moved to the concierge compose box (ConciergeHost) when db29f0a48 removed the per-agent
// composer; see the comment on that row. Boundary mocks mirror Composer.insertPrompt.test.tsx.
import { createRef } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  handler: null as ((event: { payload: unknown }) => void) | null,
}));
vi.mock("../pty", () => ({
  submitPrompt: vi.fn(() => Promise.resolve()),
  writePty: vi.fn(() => Promise.resolve()),
}));
vi.mock("../screenshot", () => ({ captureScreenRegion: vi.fn(() => Promise.resolve(null)) }));
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
vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// Tile loading normally round-trips through Rust; resolve file tiles synchronously instead.
vi.mock("./composer/attachmentsApi", () => ({
  nextId: (() => {
    let seq = 0;
    return (prefix: string) => `${prefix}-${++seq}`;
  })(),
  loadAttachment: vi.fn((path: string) =>
    Promise.resolve({
      id: `att-${path}`,
      kind: "file" as const,
      path,
      name: path.split("/").pop()!,
    }),
  ),
  copyImageToClipboard: vi.fn(() => Promise.resolve()),
  downloadAttachment: vi.fn(() => Promise.resolve(true)),
  downloadAttachments: vi.fn(() => Promise.resolve(true)),
  screenshotAttachment: (path: string, dataUrl: string) => ({
    id: `shot-${path}`,
    kind: "image" as const,
    path,
    name: "screenshot.png",
    dataUrl,
  }),
}));

import { Composer } from "./Composer";
import { loadAttachment } from "./composer/attachmentsApi";
import { useDictationStore } from "../stores/dictationStore";
import { useUiStore } from "../stores/uiStore";
import { usePromptHistoryStore } from "../stores/promptHistoryStore";
import { usePendingAttachmentsStore } from "../stores/pendingAttachmentsStore";
import {
  CONCIERGE_COLUMN_DND_TARGET,
  NEW_BUILD_AGENT_DND_TARGET,
  reportDropWithNoTarget,
} from "../services/dndTargets";
import { log } from "../logger";

// jsdom has no elementFromPoint — stub it to place the "cursor" over one of the two surfaces that
// own a dropped file themselves (services/dndTargets.FILE_DROP_TARGETS), or over neither.
const button = document.createElement("button");
button.setAttribute("data-dnd-target", NEW_BUILD_AGENT_DND_TARGET);
const conciergeBox = document.createElement("div");
conciergeBox.setAttribute("data-dnd-target", CONCIERGE_COLUMN_DND_TARGET);
let overButton = false;
let overConciergeBox = false;
document.elementFromPoint = vi.fn(() =>
  overButton ? button : overConciergeBox ? conciergeBox : document.body,
);

const fire = (payload: unknown) => act(() => captured.handler!({ payload }));

beforeEach(() => {
  vi.mocked(loadAttachment).mockClear();
  vi.mocked(log.warn).mockClear();
  vi.mocked(log.debug).mockClear();
  vi.mocked(log.info).mockClear();
  overButton = false;
  overConciergeBox = false;
  captured.handler = null;
  useDictationStore.setState({ insertTarget: null, enabled: true, status: "idle", interim: "" });
  useUiStore.getState().setComposerMinimized(false);
  usePromptHistoryStore.setState({ history: [] });
  usePendingAttachmentsStore.setState({ pending: {} });
});
afterEach(() => cleanup());

function renderComposer(agentId = "a1") {
  render(
    <Composer
      agentId={agentId}
      active
      disabled={false}
      inputRef={createRef<HTMLTextAreaElement>()}
      onSubmitPrompt={vi.fn()}
    />,
  );
}

describe("Composer — new-build-agent drop target", () => {
  it("attaches a drop that lands anywhere else (existing behavior)", async () => {
    renderComposer();
    fire({ type: "drop", position: { x: 400, y: 400 }, paths: ["/tmp/notes.txt"] });
    expect(loadAttachment).toHaveBeenCalledWith("/tmp/notes.txt");
    expect(await screen.findByText("notes.txt")).toBeTruthy();
  });

  it("ignores a drop on the + New Build Agent button (the button's listener owns it)", async () => {
    renderComposer();
    overButton = true;
    fire({ type: "drop", position: { x: 10, y: 10 }, paths: ["/tmp/notes.txt"] });
    // Nothing loads and no tile appears — the file belongs to the NEW agent's composer.
    expect(loadAttachment).not.toHaveBeenCalled();
    expect(screen.queryByText("notes.txt")).toBeNull();
  });

  // The concierge compose box is the OTHER surface that owns its drops (useConciergeAttachments
  // stages the file for the next prompt). Both carve-outs come from one list now, but only the
  // button half had ever been pinned (roborev 51593) — and the failure mode is the one the code
  // comment warns about: the same file attaching twice, here AND in the concierge box.
  it("ignores a drop on the concierge compose box (it stages the file itself)", async () => {
    renderComposer();
    overConciergeBox = true;
    fire({ type: "drop", position: { x: 10, y: 10 }, paths: ["/tmp/notes.txt"] });
    expect(loadAttachment).not.toHaveBeenCalled();
    expect(screen.queryByText("notes.txt")).toBeNull();
  });

  it("suppresses the drop-here visual over the concierge box too", () => {
    renderComposer();
    const dropHint = () =>
      (screen.getByRole("textbox") as HTMLTextAreaElement).placeholder.startsWith("Drop the file");
    fire({ type: "enter", position: { x: 400, y: 400 }, paths: ["/tmp/a.png"] });
    expect(dropHint()).toBe(true);
    overConciergeBox = true;
    fire({ type: "over", position: { x: 10, y: 10 } });
    expect(dropHint()).toBe(false);
  });

  it("suppresses the drop-here visual while the drag is over the button", () => {
    renderComposer();
    // dropActive drives both the dashed textarea border and this placeholder — assert on the
    // placeholder (the border shorthand doesn't survive jsdom's style parsing).
    const dropHint = () =>
      (screen.getByRole("textbox") as HTMLTextAreaElement).placeholder.startsWith("Drop the file");
    fire({ type: "enter", position: { x: 400, y: 400 }, paths: ["/tmp/a.png"] });
    expect(dropHint()).toBe(true); // normal drag-over composer → "drop here" state
    overButton = true;
    fire({ type: "over", position: { x: 10, y: 10 } });
    expect(dropHint()).toBe(false); // over the button → the button's hover visual, not ours
    overButton = false;
    fire({ type: "over", position: { x: 400, y: 400 } });
    expect(dropHint()).toBe(true); // dragging back off the button re-arms the composer
  });

  // THE DRAIN ITSELF NO LONGER LIVES HERE. Files queued by a "+ New Build Agent" drop are staged on
  // the CONCIERGE compose box now — that is the input surface for a build agent since db29f0a48
  // removed the per-agent composer, and this Composer only ever renders for the Sparkle self-improve
  // agent, which no drop can key to. Coverage moved with the behaviour, to
  // ConciergeHost.test.tsx ("capture handoffs land in the compose box"). What stays here is the
  // half that is still this file's job: this composer must keep its hands OFF the queue, so a drop
  // can't be consumed by a surface that will never show it.
  it("never drains the new-build-agent queue — that belongs to the concierge box now", () => {
    usePendingAttachmentsStore.getState().add("a1", ["/tmp/handoff.txt"]);
    usePendingAttachmentsStore.getState().add("someone-else", ["/tmp/theirs.txt"]);
    renderComposer("a1");
    expect(loadAttachment).not.toHaveBeenCalled();
    // Both entries survive, its own included — untouched, not merely un-rendered.
    expect(usePendingAttachmentsStore.getState().drain("a1")).toEqual(["/tmp/handoff.txt"]);
    expect(usePendingAttachmentsStore.getState().drain("someone-else")).toEqual([
      "/tmp/theirs.txt",
    ]);
  });
});

// THE CATCH-ALL WIRING (roborev 53914). dndTargets covers the counter itself, but the half that
// decides whether the alarm behaves is HERE: this composer accepts any drop outside
// FILE_DROP_TARGETS — the sidebar, the tab strip, the top bar — none of which any `data-dnd-target`
// region describes, so without a registration the other listeners report those successful drops as
// dead. Deleting `registerCatchAllDropTarget()` restores exactly the false warnings the change
// removed; deleting `unregisterCatchAll()` from the cleanup leaks the counter and permanently
// disables the alarm for the session, and RATCHETS, because the Sparkle pane mounts and unmounts
// every time the user switches panes. Both mutations leave the rest of the suite green.
describe("Composer — registers as the window-global catch-all drop target", () => {
  /** A position over neither marked target, i.e. the drop only a catch-all would claim. */
  const nowhere = { x: 400, y: 400 };

  it("suppresses the dead-drop WARNING while it is mounted and active", () => {
    renderComposer();
    reportDropWithNoTarget(nowhere);
    expect(log.warn).not.toHaveBeenCalled();
    // Downgraded, not dropped — at INFO, which always forwards to the persistent log (debug
    // does not in a shipped build), so a support capture still carries the record.
    expect(log.info).toHaveBeenCalled();
  });

  it("releases the registration on unmount, so the alarm comes back", () => {
    renderComposer();
    cleanup();
    // A DIFFERENT position: the reporter dedupes on the last one it saw.
    reportDropWithNoTarget({ x: 401, y: 400 });
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("does not register at all when it is not the active pane", () => {
    render(
      <Composer
        agentId="a1"
        active={false}
        disabled={false}
        inputRef={createRef<HTMLTextAreaElement>()}
        onSubmitPrompt={vi.fn()}
      />,
    );
    reportDropWithNoTarget({ x: 402, y: 400 });
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});
