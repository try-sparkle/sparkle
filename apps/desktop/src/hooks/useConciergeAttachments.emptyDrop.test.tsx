// @vitest-environment jsdom
//
// THE FOUNDER'S BUG, at the listener that owns his compose window.
//
// "We can no longer drag photos or files into the Compose window. It doesn't work on any of the
// buttons." — the box LIT UP under the drag and then swallowed the drop, on every surface, with
// nothing in the log.
//
// The drag never carried paths. wry's macOS handler (wkwebview/drag_drop.rs::collect_paths) reads
// only the deprecated `NSFilenamesPboardType`; Finder still publishes it, but Photos, a browser
// image, Slack and the macOS screenshot thumbnail publish only the modern `public.file-url`. Those
// arrive as `paths: []`, and `if (paths.length === 0) return;` discarded them without a word.
//
// The two assertions below are the two halves of that, and BOTH fail against the pre-fix code:
// the file is never attached, and nothing is ever logged. The existing Composer.dropTarget.test.tsx
// could not catch either, because every payload it fires carries a non-empty `paths` array — the
// mock supplied the precondition that kept the broken branch unreachable.
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  handler: null as ((event: { payload: unknown }) => void) | null,
}));
const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
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
vi.mock("../services/conciergeAttach", () => ({
  // Mirrors the real AttachOutcome exactly — `failed`, not some invented key. A mock with the
  // wrong shape is how a test ends up asserting against a contract the app does not have.
  loadAttachmentPaths: vi.fn((paths: string[]) =>
    Promise.resolve({
      attachments: paths.map((p) => ({ id: `att-${p}`, kind: "file", path: p, name: p })),
      failed: [],
    }),
  ),
  pickAttachments: vi.fn(),
}));

import { useConciergeAttachments } from "./useConciergeAttachments";
import { loadAttachmentPaths } from "../services/conciergeAttach";
import { CONCIERGE_COLUMN_DND_TARGET } from "../services/dndTargets";
import { log } from "../logger";

// jsdom has no elementFromPoint. Put the cursor over the concierge column — the SAME element the
// `over` event hit-tests against, which is why the box lights up in the real app.
const column = document.createElement("div");
column.setAttribute("data-dnd-target", CONCIERGE_COLUMN_DND_TARGET);
document.elementFromPoint = vi.fn(() => column);

const overConcierge = { x: 120, y: 400 };

beforeEach(() => {
  invoke.mockReset();
  captured.handler = null;
  vi.mocked(loadAttachmentPaths).mockClear();
  vi.mocked(log.info).mockClear();
  vi.mocked(log.warn).mockClear();
});
afterEach(() => cleanup());

async function mounted() {
  const view = renderHook(() => useConciergeAttachments());
  await waitFor(() => expect(captured.handler).not.toBeNull());
  return view;
}

const fire = (payload: unknown) => act(() => captured.handler!({ payload }));

describe("concierge box — a drop whose drag carried no paths", () => {
  it("still lights the box up on drag-over (this half was never broken)", async () => {
    // Pinning the SYMPTOM the founder described, so the fix can't be mistaken for a hit-test bug:
    // `over` consults the position only, never `paths`, which is why the affordance painted
    // correctly while the drop died.
    const { result } = await mounted();
    fire({ type: "over", position: overConcierge });
    expect(result.current.dropActive).toBe(true);
  });

  // FAILS BEFORE THE FIX: loadAttachmentPaths is never called, because the empty `paths` array
  // returned early. Asserting the file ACTUALLY ATTACHES — the side effect — not that some
  // recovery function was invoked.
  it("recovers the file from the drag pasteboard and attaches it", async () => {
    invoke.mockResolvedValue(["/Users/x/photo.png"]);
    const { result } = await mounted();

    fire({ type: "drop", position: overConcierge, paths: [] });

    await waitFor(() => expect(loadAttachmentPaths).toHaveBeenCalledWith(["/Users/x/photo.png"]));
    await waitFor(() => expect(result.current.attachments).toHaveLength(1));
    expect(result.current.attachments[0]?.path).toBe("/Users/x/photo.png");
  });

  // FAILS BEFORE THE FIX: nothing at all was logged. This is the assertion that would have turned a
  // debugging session into a log grep, so it is worth its own test rather than a tail on the one
  // above.
  it("WARNS when there is nothing to recover, instead of discarding it silently", async () => {
    invoke.mockResolvedValue([]);
    await mounted();

    fire({ type: "drop", position: overConcierge, paths: [] });

    await waitFor(() =>
      expect(log.warn).toHaveBeenCalledWith(
        "composer",
        "a file was dropped but the drag carried no readable path",
        { where: "concierge-box" },
      ),
    );
    expect(loadAttachmentPaths).not.toHaveBeenCalled();
  });

  it("does not reach for the pasteboard when the drag DID carry paths", async () => {
    await mounted();
    fire({ type: "drop", position: overConcierge, paths: ["/tmp/from-finder.png"] });
    await waitFor(() =>
      expect(loadAttachmentPaths).toHaveBeenCalledWith(["/tmp/from-finder.png"]),
    );
    expect(invoke).not.toHaveBeenCalled();
  });
});
