// @vitest-environment jsdom
//
// `pickerOpen` — the auto-send countdown's PAUSE signal while a native picker is on screen.
//
// The founder: *"If I click the screenshot or the upload icons, I want you to pause the countdown
// while those are active … a finder window open for the upload or the screenshot crosshairs open
// taking a screenshot, because it means that I'm taking an action, basically."*
//
// This file owns ONE half of that: that the controller reports the interval honestly. The other
// half — that the report reaches the reducer's pause and holds the send — is
// ../voice/useAutoSend.test.ts's "an OPEN ATTACH PICKER pauses the countdown".
//
// WHY THE PROMISE IS HELD OPEN BY THE TEST rather than resolved immediately. `pickAttachments` is
// the seam that stands in for the crosshairs and the Finder panel, and the interval this hook must
// report is exactly the interval that promise is pending. A mock that resolved on the spot would
// make every row below pass against a `pickerOpen` that was never true for a measurable moment —
// the vacuous shape this repo's guidance names, and the one that matters most here, because the
// whole feature IS the duration.
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../services/conciergeAttach", () => ({
  loadAttachmentPaths: vi.fn(),
  pickAttachments: vi.fn(),
}));

import { useConciergeAttachments } from "./useConciergeAttachments";
import { pickAttachments } from "../services/conciergeAttach";
import type { AttachOutcome } from "../services/conciergeAttach";

const picked = vi.mocked(pickAttachments);

/** An outcome carrying one file — what a picker the user actually chose in resolves. */
const ONE_FILE: AttachOutcome = {
  attachments: [{ id: "att-1", kind: "file", path: "/tmp/a.txt", name: "a.txt" }],
  failed: [],
};
/** What a CANCEL resolves: nothing staged, nothing failed, no error. `pickAttachments` never
 *  rejects, so this — not a rejection — is the shape a dismissed panel produces. */
const CANCELLED: AttachOutcome = { attachments: [], failed: [] };

/** A promise this test resolves by hand, standing in for a picker that stays on screen. */
function deferred<T>() {
  let settle!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    settle = res;
  });
  return { promise, settle };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("pickerOpen — true for exactly as long as a native picker is up", () => {
  it("is false at rest", () => {
    const { result } = renderHook(() => useConciergeAttachments());
    expect(result.current.pickerOpen).toBe(false);
  });

  it.each([["screenshot"], ["files"]] as const)(
    "goes true on the %s click and stays true while the picker is open",
    async (kind) => {
      // THE FAILING ROW for both icons. Before the fix nothing anywhere recorded that a picker was
      // open, so this read false throughout and the countdown ran underneath it.
      const d = deferred<AttachOutcome>();
      picked.mockReturnValue(d.promise);
      const { result } = renderHook(() => useConciergeAttachments());

      act(() => result.current.attach(kind));
      await waitFor(() => expect(result.current.pickerOpen).toBe(true));

      // Still true a while later — the panel has not closed, so neither has the flag. This is the
      // assertion that makes the row about a DURATION rather than about one instant.
      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current.pickerOpen).toBe(true);

      await act(async () => {
        d.settle(ONE_FILE);
        await d.promise;
      });
      await waitFor(() => expect(result.current.pickerOpen).toBe(false));
    },
  );

  it("goes true SYNCHRONOUSLY with the click, not after the picker appears", () => {
    // LOAD-BEARING. A native panel takes a few hundred ms to appear and the countdown ticks every
    // 100ms, so a flag raised on "the picker is visible" leaves a window in which the send still
    // fires — the founder's bug arriving slightly earlier rather than being fixed. `attach` must
    // have already recorded it by the time it returns.
    picked.mockReturnValue(deferred<AttachOutcome>().promise);
    const { result } = renderHook(() => useConciergeAttachments());
    act(() => result.current.attach("screenshot"));
    expect(result.current.pickerOpen).toBe(true);
  });

  it("COMES BACK DOWN ON A CANCEL — an escaped crosshair must not wedge the countdown", async () => {
    // Escape the crosshairs, or dismiss Finder without choosing. Nothing is staged, so `stagedSeq`
    // never moves and this flag is the ONLY thing that can un-pause the rail. Left true, the
    // countdown never fires again for the rest of the session.
    const d = deferred<AttachOutcome>();
    picked.mockReturnValue(d.promise);
    const { result } = renderHook(() => useConciergeAttachments());

    act(() => result.current.attach("files"));
    await waitFor(() => expect(result.current.pickerOpen).toBe(true));

    await act(async () => {
      d.settle(CANCELLED);
      await d.promise;
    });
    await waitFor(() => expect(result.current.pickerOpen).toBe(false));
    // …and it really was a cancel: nothing was staged.
    expect(result.current.attachments).toEqual([]);
    expect(result.current.stagedSeq).toBe(0);
  });

  it("comes back down when the picker FAILS, not only when it resolves cleanly", async () => {
    // A screen-recording permission denial resolves an outcome carrying `error`. That path sets a
    // notice and stages nothing — and it must still close the flag, for the same reason a cancel
    // must: there is no other signal that would.
    const d = deferred<AttachOutcome>();
    picked.mockReturnValue(d.promise);
    const { result } = renderHook(() => useConciergeAttachments());

    act(() => result.current.attach("screenshot"));
    await waitFor(() => expect(result.current.pickerOpen).toBe(true));

    await act(async () => {
      d.settle({ attachments: [], failed: [], error: "Couldn't take the screenshot — denied." });
      await d.promise;
    });
    await waitFor(() => expect(result.current.pickerOpen).toBe(false));
    expect(result.current.attachNotice).toContain("Couldn't take the screenshot");
  });

  it("TWO OVERLAPPING PICKERS: the first to close does not clear the flag", async () => {
    // Click Upload, then Screenshot before the panel returns. With a boolean instead of a counter,
    // whichever resolves first clears the flag while the other is still on screen — and the
    // countdown resumes underneath it, which is the exact bug one click later.
    const first = deferred<AttachOutcome>();
    const second = deferred<AttachOutcome>();
    picked.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useConciergeAttachments());

    act(() => result.current.attach("files"));
    act(() => result.current.attach("screenshot"));
    await waitFor(() => expect(result.current.pickerOpen).toBe(true));

    await act(async () => {
      first.settle(CANCELLED);
      await first.promise;
    });
    // STILL TRUE — the screenshot crosshairs are on screen.
    expect(result.current.pickerOpen).toBe(true);

    await act(async () => {
      second.settle(ONE_FILE);
      await second.promise;
    });
    await waitFor(() => expect(result.current.pickerOpen).toBe(false));
  });

  it("a DROP is not a picker — it stages without ever pausing the countdown", async () => {
    // The control row, and the boundary that keeps this flag meaning one thing. A drop has no
    // panel and no duration: the files are already in hand. It restarts the countdown through
    // `stagedSeq` instead (see ./useConciergeAttachments.stagedSeq.test.tsx). If this flag ever
    // went true here, the pause would outlive a gesture with nothing to close it.
    const { result } = renderHook(() => useConciergeAttachments());
    act(() => result.current.attachReady(ONE_FILE.attachments));
    expect(result.current.pickerOpen).toBe(false);
    expect(result.current.stagedSeq).toBe(1);
  });
});
