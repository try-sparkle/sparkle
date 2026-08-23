// @vitest-environment jsdom
//
// THE LIFECYCLE TEST `publish_attach_media` WAS MISSING — bead `sparkle-131ms.8`, roborev 68164.
//
// The first cut of `stagedAttachmentPaths` vetted the model's path against
// `pendingAttachmentsStore`, and its 32 tests passed because every one of them wrote that store
// DIRECTLY. Nothing modelled the fact that `ConciergeHost` subscribes to that store and DRAINS the
// entry the moment it is written (roborev 55403), so in the real app the vetting list was empty on
// every call, `media-not-staged` fired every time, and the happy path could never run — the exact
// `sparkle-16y6h` shape ("both suites passed, the shipped feature never once ran"), one layer up.
//
// So these tests deliberately never call `usePendingAttachmentsStore.setState`. They drive the
// REAL funnel — `useConciergeAttachments`, the hook the compose box actually uses — and then ask
// the SERVICE what it can see. That is what makes them able to fail: revert `stagedAttachmentPaths`
// to reading only the pending queue and the first two go red.
import { StrictMode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ pick: vi.fn(), loadPaths: vi.fn() }));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("../conciergeAttach", () => ({
  pickAttachments: captured.pick,
  loadAttachmentPaths: captured.loadPaths,
}));
vi.mock("../../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { useConciergeAttachments } from "../../hooks/useConciergeAttachments";
import { usePendingAttachmentsStore } from "../../stores/pendingAttachmentsStore";
import { useComposerAttachmentsMirror } from "../../stores/composerAttachmentsMirror";
import { stagedAttachmentPaths } from "./publish";
import type { Attachment } from "../../components/composer/attachments";

const SHOT = "/tmp/sparkle-shot.png";

function chip(path: string): Attachment {
  return { id: `att-${path}`, kind: "image", path, name: "sparkle-shot.png" };
}

beforeEach(() => {
  usePendingAttachmentsStore.setState({ pending: {} });
  useComposerAttachmentsMirror.setState({ paths: [], owner: null });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("what publish_attach_media is allowed to upload", () => {
  it("sees a file that is a chip on the compose box, with the handoff queue EMPTY", () => {
    // The state after any real staging gesture: the human dropped a file on the box (which never
    // touches the pending queue at all), or `attach_to_message` queued it and ConciergeHost already
    // drained it onto the box. Either way the queue is empty and the box holds the file.
    const { result } = renderHook(() => useConciergeAttachments());
    act(() => result.current.attachReady([chip(SHOT)]));

    expect(usePendingAttachmentsStore.getState().pending).toEqual({});
    expect(stagedAttachmentPaths()).toContain(SHOT);
  });

  it("still sees the file AFTER ConciergeHost drains the handoff queue — the drain is the bug", () => {
    // Drive the real sequence rather than asserting on a hand-set store: queue it the way
    // `attach_to_message` does, then perform the drain ConciergeHost's subscribed effect performs,
    // staging what it drained onto the box exactly as that effect does via `attachPaths`.
    const { result } = renderHook(() => useConciergeAttachments());
    act(() => {
      usePendingAttachmentsStore.getState().add("agent-1", [SHOT]);
    });
    // Pre-drain the queue answers. This assertion is what makes the next one meaningful: it pins
    // that the OLD implementation had something to find, so the failure below is the drain and not
    // a broken fixture.
    expect(stagedAttachmentPaths("agent-1")).toContain(SHOT);

    act(() => {
      const drained = usePendingAttachmentsStore.getState().drain("agent-1");
      result.current.attachReady(drained.map(chip));
    });

    // The queue is now empty — this is the state every real tool call observes.
    expect(usePendingAttachmentsStore.getState().pending["agent-1"]).toBeUndefined();
    expect(stagedAttachmentPaths("agent-1")).toContain(SHOT);
  });

  it("stops seeing a file once it is removed from the box", () => {
    // The mirror must not accumulate — a queue that is never drained would keep answering here,
    // which would turn a removed chip into a still-uploadable path.
    const { result } = renderHook(() => useConciergeAttachments());
    act(() => result.current.attachReady([chip(SHOT)]));
    expect(stagedAttachmentPaths()).toContain(SHOT);

    act(() => result.current.remove(`att-${SHOT}`));
    expect(stagedAttachmentPaths()).not.toContain(SHOT);
  });

  it("stops seeing a file once the message is sent (take clears the box)", () => {
    const { result } = renderHook(() => useConciergeAttachments());
    act(() => result.current.attachReady([chip(SHOT)]));
    act(() => {
      result.current.take();
    });
    expect(stagedAttachmentPaths()).not.toContain(SHOT);
  });

  it("forgets the path when the compose box UNMOUNTS — a phantom here is a public upload", () => {
    // roborev 68186. `ConciergeHost` unmounts when no project is open, and `apply` only runs on a
    // mutation of a MOUNTED box — so without a cleanup the last reading stands for the life of the
    // window. `stagedAttachmentPaths` is the SOLE gate on a model-supplied path reaching a public
    // upload, so that phantom would let the model publish a file the human dropped, never sent, and
    // closed the project on: no box, no chip, no human gesture anywhere in the sequence.
    const { result, unmount } = renderHook(() => useConciergeAttachments());
    act(() => result.current.attachReady([chip(SHOT)]));
    expect(stagedAttachmentPaths()).toContain(SHOT);

    act(() => unmount());

    // Asked through the SERVICE, which is the reader that matters — not through a handle captured
    // before the teardown.
    expect(stagedAttachmentPaths()).toEqual([]);
  });

  it("survives strict mode's double-invoke — a live box is not left marked dead", () => {
    // The liveness flag is SET ON ENTRY to the effect, not merely cleared on exit. Under strict
    // mode the effect runs, cleans up, and runs again; a flag that were only ever cleared would
    // leave this very-much-alive box marked dead, and every later stage would silently fail to
    // reach the mirror — the feature inert, with a green suite over it, for anyone running a dev
    // build. Asserted through the SERVICE, which is the reader that matters.
    const { result } = renderHook(() => useConciergeAttachments(), { wrapper: StrictMode });

    act(() => result.current.attachReady([chip(SHOT)]));

    expect(stagedAttachmentPaths()).toContain(SHOT);
  });

  it("an IN-FLIGHT drop that resolves after unmount cannot republish the phantom", async () => {
    // roborev 68221. Both async producers are uncancelled — `attachPaths` resolves
    // `loadAttachmentPaths(paths).then(settle)` and `settle -> add -> apply` — so `apply` is
    // reachable AFTER the unmount cleanup has already run. Without a liveness gate the dead hook's
    // late resolve re-takes ownership of the mirror, and that cleanup never runs again: the phantom
    // stands for the life of the window AND poisons the next mount, because the live box's
    // identity-checked cleanup then declines to clear a store owned by the dead token.
    //
    // The three lifecycle tests above cannot see this — every one of them mutates synchronously
    // before `unmount()`, so none of them has anything in flight across the teardown.
    let resolveLoad: ((outcome: { attachments: Attachment[]; failed: string[] }) => void) | null =
      null;
    captured.loadPaths.mockReturnValueOnce(
      new Promise((res) => {
        resolveLoad = res;
      }),
    );

    const { result, unmount } = renderHook(() => useConciergeAttachments());
    // Start the read, but do NOT settle it — this is the human clicking Upload, or dropping an
    // image large enough that `load_attachment` is still reading.
    act(() => result.current.attachPaths([SHOT]));
    expect(stagedAttachmentPaths()).toEqual([]);

    // They close the project while it is still in flight.
    act(() => unmount());
    expect(stagedAttachmentPaths()).toEqual([]);

    // Now the read lands, on a hook nobody is looking at.
    await act(async () => {
      resolveLoad?.({ attachments: [chip(SHOT)], failed: [] });
      await Promise.resolve();
    });

    expect(stagedAttachmentPaths()).toEqual([]);
  });

  it("a NEWLY MOUNTED box takes ownership immediately — last publish wins", () => {
    // The mount-publish half of the ownership contract, pinned on its own because the unmount test
    // above passes without it. React mounts the NEW instance BEFORE running the OLD one's cleanup,
    // so for that window two boxes are live and the outgoing one's list is still on file. The live
    // box must own the reading from its first render, not from its first mutation — otherwise a
    // tool call landing in that window is vetted against a box the human is no longer looking at.
    const first = renderHook(() => useConciergeAttachments());
    act(() => first.result.current.attachReady([chip(SHOT)]));
    expect(stagedAttachmentPaths()).toContain(SHOT);

    // Mount the successor WITHOUT tearing the first one down, which is the real interleaving.
    renderHook(() => useConciergeAttachments());

    expect(stagedAttachmentPaths()).toEqual([]);
  });

  it("a remount does not inherit the previous box's staged path", () => {
    // The other half of the ownership contract: React mounts the NEW instance before running the
    // OLD one's cleanup, so an unchecked clear would wipe the live box instead of the dead one.
    // Here the check is the simpler direction — nothing survives the teardown.
    const first = renderHook(() => useConciergeAttachments());
    act(() => first.result.current.attachReady([chip(SHOT)]));
    expect(stagedAttachmentPaths()).toContain(SHOT);
    act(() => first.unmount());

    const second = renderHook(() => useConciergeAttachments());
    expect(stagedAttachmentPaths()).toEqual([]);
    // ...and the fresh box still works.
    act(() => second.result.current.attachReady([chip("/tmp/other.png")]));
    expect(stagedAttachmentPaths()).toEqual(["/tmp/other.png"]);
  });

  it("still refuses a path that was never staged anywhere", () => {
    const { result } = renderHook(() => useConciergeAttachments());
    act(() => result.current.attachReady([chip(SHOT)]));
    expect(stagedAttachmentPaths()).not.toContain("/etc/passwd");
  });

  it("keeps the not-yet-mounted handoff window working — queued but not yet a chip", () => {
    // "+ New Build Agent" drops land here before that agent's composer exists. The queue stays a
    // real source; it is just no longer the ONLY one.
    renderHook(() => useConciergeAttachments());
    act(() => {
      usePendingAttachmentsStore.getState().add("agent-2", [SHOT]);
    });
    expect(stagedAttachmentPaths("agent-2")).toContain(SHOT);
  });
});
