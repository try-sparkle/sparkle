// @vitest-environment jsdom
//
// The composer's side of the "+ New Build Agent" drop target (see useNewBuildAgentDrop):
// drags/drops over the button are the button's — the composer suppresses its drop outline
// and must NOT attach the files — while drops anywhere else keep attaching here. Plus the
// pending-attachments drain: paths queued for this agent before its composer mounted become
// tiles on activation. Boundary mocks mirror Composer.insertPrompt.test.tsx.
import { createRef } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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
import { NEW_BUILD_AGENT_DND_TARGET } from "../services/dndTargets";

// jsdom has no elementFromPoint — stub it to place the "cursor" over the marked button or not.
const button = document.createElement("button");
button.setAttribute("data-dnd-target", NEW_BUILD_AGENT_DND_TARGET);
let overButton = false;
document.elementFromPoint = vi.fn(() => (overButton ? button : document.body));

const fire = (payload: unknown) => act(() => captured.handler!({ payload }));

beforeEach(() => {
  vi.mocked(loadAttachment).mockClear();
  overButton = false;
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

  it("drains paths queued for its agentId into attachment tiles on mount", async () => {
    usePendingAttachmentsStore.getState().add("a1", ["/tmp/handoff.txt"]);
    renderComposer("a1");
    await waitFor(() => expect(loadAttachment).toHaveBeenCalledWith("/tmp/handoff.txt"));
    expect(await screen.findByText("handoff.txt")).toBeTruthy();
    expect(usePendingAttachmentsStore.getState().pending).toEqual({});
  });

  it("leaves other agents' queued paths alone", () => {
    usePendingAttachmentsStore.getState().add("someone-else", ["/tmp/theirs.txt"]);
    renderComposer("a1");
    expect(loadAttachment).not.toHaveBeenCalled();
    expect(usePendingAttachmentsStore.getState().drain("someone-else")).toEqual([
      "/tmp/theirs.txt",
    ]);
  });
});
