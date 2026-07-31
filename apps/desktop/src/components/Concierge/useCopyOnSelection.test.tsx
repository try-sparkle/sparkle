// @vitest-environment jsdom
//
// Copy-on-selection (PRD 1 §1). The clipboard BOUNDARY is stubbed at `navigator.clipboard` rather
// than by mocking ../../clipboard, deliberately: "goes through copyToClipboard" is part of the
// contract (that helper owns the execCommand fallback and the focus restore), so the tests exercise
// the real one and only fake the platform underneath it.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COPY_TOAST_MS, KEYBOARD_SELECTION_DEBOUNCE_MS, useCopyOnSelection } from "./useCopyOnSelection";

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.getSelection()?.removeAllRanges();
});

function Harness({ enabled = true, onCopied }: { enabled?: boolean; onCopied?: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const copied = useCopyOnSelection(ref, { enabled, onCopied });
  return (
    <div>
      {/* The concierge COLUMN — header above the thread, compose box below, exactly the sandwich the
          real one is. A drag from the header to the compose box is the enclosure case: both
          endpoints outside the thread, both inside the column. `outside` sits beyond the root, so it
          stands for another surface entirely. */}
      <div data-concierge-root>
        <p data-testid="header">Column header</p>
        <div ref={ref} data-testid="box">
          <p data-testid="inside">Sparkle said this bit.</p>
          <p data-testid="blank"> &nbsp; </p>
        </div>
        <p data-testid="compose">Draft in the compose box.</p>
      </div>
      <p data-testid="outside">Someone else&apos;s words.</p>
      {copied && <span data-testid="toast">Copied</span>}
    </div>
  );
}

/** Select a node's contents the way a drag does — a real Range in the real Selection. */
function selectContentsOf(testId: string): void {
  const range = document.createRange();
  range.selectNodeContents(screen.getByTestId(testId));
  const sel = window.getSelection();
  if (!sel) throw new Error("jsdom has no Selection");
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Let the async clipboard write and its `.then` settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** The gesture: press, drag (the selection is already installed), release. */
function releaseOverBox(): void {
  const box = screen.getByTestId("box");
  fireEvent.mouseDown(box);
  fireEvent.mouseUp(box);
}

describe("useCopyOnSelection", () => {
  it("copies the selection on mouseup when the setting is ON", async () => {
    const onCopied = vi.fn();
    render(<Harness onCopied={onCopied} />);
    selectContentsOf("inside");
    releaseOverBox();
    await settle();

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("Sparkle said this bit.");
    expect(onCopied).toHaveBeenCalledTimes(1);
  });

  it("does NOT copy when the setting is OFF", async () => {
    const onCopied = vi.fn();
    render(<Harness enabled={false} onCopied={onCopied} />);
    selectContentsOf("inside");
    releaseOverBox();
    await settle();

    expect(writeText).not.toHaveBeenCalled();
    expect(onCopied).not.toHaveBeenCalled();
    expect(screen.queryByTestId("toast")).toBeNull();
  });

  it("does nothing for a whitespace-only selection", async () => {
    const onCopied = vi.fn();
    render(<Harness onCopied={onCopied} />);
    selectContentsOf("blank");
    releaseOverBox();
    await settle();

    expect(writeText).not.toHaveBeenCalled();
    expect(onCopied).not.toHaveBeenCalled();
  });

  it("does nothing for a selection on a surface BEYOND the column", async () => {
    // `outside` stands for another surface entirely — beyond `[data-concierge-root]`. This is the
    // aim guard's case: the gesture was never pointed at this column, so nothing here is copied.
    // (A drag from the compose box INTO the thread is a different, supported gesture — it copies the
    // clamped thread text. See "clamps an overshooting drag" below.)
    const onCopied = vi.fn();
    render(<Harness onCopied={onCopied} />);
    selectContentsOf("outside");
    releaseOverBox();
    await settle();

    expect(writeText).not.toHaveBeenCalled();
    expect(onCopied).not.toHaveBeenCalled();
  });

  describe("the CLAMP's containment promise, not the aim guard's", () => {
    // These two selections PASS the aim guard — both endpoints are inside the concierge root — so
    // they reach the clamp, which every other "does not copy" test in this file short-circuits
    // before. Without a case on each side of the thread that path had no coverage at all.
    //
    // Two mechanisms enforce the outcome and the tests pin the OUTCOME, not one mechanism: the
    // explicit range-intersection early-out, and — even without it — the clamp degenerating, since
    // cutting a wholly-below range's END back to the thread's end puts it before its own start.
    // Deleting the intersection check alone therefore leaves these green; deleting the containment
    // logic outright turns them red, which is what they are for.
    it("copies nothing for a selection wholly BELOW the thread", async () => {
      const onCopied = vi.fn();
      render(<Harness onCopied={onCopied} />);
      selectContentsOf("compose");
      releaseOverBox();
      await settle();

      expect(writeText).not.toHaveBeenCalled();
      expect(onCopied).not.toHaveBeenCalled();
    });

    it("copies nothing for a selection wholly ABOVE the thread", async () => {
      const onCopied = vi.fn();
      render(<Harness onCopied={onCopied} />);
      selectContentsOf("header");
      releaseOverBox();
      await settle();

      expect(writeText).not.toHaveBeenCalled();
      expect(onCopied).not.toHaveBeenCalled();
    });
  });

  it("copies a KEYBOARD selection once, after the debounce settles", async () => {
    vi.useFakeTimers();
    const onCopied = vi.fn();
    render(<Harness onCopied={onCopied} />);
    selectContentsOf("inside");

    // shift+arrow: several selectionchange events, no mouseup at all.
    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
      vi.advanceTimersByTime(KEYBOARD_SELECTION_DEBOUNCE_MS - 50);
      document.dispatchEvent(new Event("selectionchange"));
      vi.advanceTimersByTime(KEYBOARD_SELECTION_DEBOUNCE_MS - 50);
    });
    // Still mid-gesture — nothing written yet.
    expect(writeText).not.toHaveBeenCalled();

    act(() => void vi.advanceTimersByTime(KEYBOARD_SELECTION_DEBOUNCE_MS));
    await settle();

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(onCopied).toHaveBeenCalledTimes(1);
  });

  it("does not copy twice when a double-click's mouseup and dblclick both land", async () => {
    // A dblclick arrives as mousedown/mouseup/mousedown/mouseup/dblclick, so the word is already
    // selected by the last mouseup. One clipboard write; one announcement.
    const onCopied = vi.fn();
    render(<Harness onCopied={onCopied} />);
    const box = screen.getByTestId("box");
    selectContentsOf("inside");
    fireEvent.mouseUp(box);
    await settle();
    fireEvent.dblClick(box);
    await settle();

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(onCopied).toHaveBeenCalledTimes(1);
  });

  it("still copies once when the two events land with NO await between them", async () => {
    // The version above inserts `await settle()` between the mouseup and the dblclick, which hands
    // the clipboard promise a microtask checkpoint that a real double-click never provides — the
    // browser dispatches mousedown/mouseup/mousedown/mouseup/dblclick back-to-back. With the
    // de-dupe claimed inside the write's `.then()`, this ordering announced TWICE into the column's
    // one live region; claiming it synchronously is what makes both orderings behave the same.
    const onCopied = vi.fn();
    render(<Harness onCopied={onCopied} />);
    const box = screen.getByTestId("box");
    selectContentsOf("inside");
    fireEvent.mouseUp(box);
    fireEvent.dblClick(box); // no checkpoint — the write is still in flight
    await settle();

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(onCopied).toHaveBeenCalledTimes(1);
  });

  describe("the drag is not interrupted", () => {
    // THE FOUNDER'S BUG: "when I copy boxes sometimes the part where I started copying loses its
    // initial anchor location." A drag across several messages is slow — the reader pauses to read,
    // or waits for the thread to scroll. Any pause longer than the keyboard debounce used to fire a
    // copy WHILE THE BUTTON WAS STILL DOWN, and `copyToClipboard`'s execCommand fallback tears the
    // live selection down (`removeAllRanges`) and rebuilds it (`addRange`) — under the user's
    // cursor, mid-gesture. The browser's drag then extends from a relocated anchor.
    it("does NOT copy while the button is still down, however long the drag pauses", async () => {
      vi.useFakeTimers();
      const onCopied = vi.fn();
      render(<Harness onCopied={onCopied} />);
      const box = screen.getByTestId("box");

      fireEvent.mouseDown(box);
      selectContentsOf("inside");
      // The reader pauses mid-drag — several debounce windows' worth.
      act(() => {
        document.dispatchEvent(new Event("selectionchange"));
        vi.advanceTimersByTime(KEYBOARD_SELECTION_DEBOUNCE_MS * 4);
      });

      expect(writeText).not.toHaveBeenCalled();
      expect(onCopied).not.toHaveBeenCalled();

      // And the gesture still completes normally when they let go.
      fireEvent.mouseUp(box);
      vi.useRealTimers();
      await settle();
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText).toHaveBeenCalledWith("Sparkle said this bit.");
    });

    it("completes a drag that RELEASES outside the thread", async () => {
      // Selecting to the end of an answer means overshooting past it — the release lands on the
      // compose box or the column edge, not on the scroller. With the gesture-end bound to the
      // container, that drag resolved into nothing at all and the user's highlight was simply lost.
      const onCopied = vi.fn();
      render(<Harness onCopied={onCopied} />);

      fireEvent.mouseDown(screen.getByTestId("box"));
      selectContentsOf("inside");
      fireEvent.mouseUp(screen.getByTestId("outside"));
      await settle();

      expect(writeText).toHaveBeenCalledWith("Sparkle said this bit.");
      expect(onCopied).toHaveBeenCalledTimes(1);
    });

    it("does not copy mid-drag for a gesture that STARTED outside the thread", async () => {
      // The mirror of the overshoot: a drag begun in the compose box and pulled up into the
      // transcript. While the press was bound to the container, this shape never armed the
      // suppression — so a mid-drag pause still fired a copy under the held button. It used to be
      // harmless only because the both-ends-inside guard refused it outright; clamping made it
      // copyable, so the asymmetry became a live re-opening of the anchor bug.
      vi.useFakeTimers();
      render(<Harness />);

      fireEvent.mouseDown(screen.getByTestId("outside"));
      selectContentsOf("inside");
      act(() => {
        document.dispatchEvent(new Event("selectionchange"));
        vi.advanceTimersByTime(KEYBOARD_SELECTION_DEBOUNCE_MS * 4);
      });

      expect(writeText).not.toHaveBeenCalled();
    });

    it("copies a selection that ENCLOSES the thread", async () => {
      // Dragging from the column header to the compose box puts BOTH endpoints outside the
      // transcript with the whole of it in between. An endpoint-in-the-thread test rejects that —
      // the reader sees everything highlighted and gets nothing, with no explanation. The clamp
      // handles it; the guard just has to recognise it as this column's gesture.
      render(<Harness />);
      const range = document.createRange();
      range.setStart(screen.getByTestId("header").firstChild!, 0);
      range.setEnd(screen.getByTestId("compose").firstChild!, 5);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);

      fireEvent.mouseDown(screen.getByTestId("header"));
      fireEvent.mouseUp(screen.getByTestId("compose"));
      await settle();

      const copied = writeText.mock.calls[0]?.[0] as string;
      expect(copied).toContain("Sparkle said this bit.");
      // Clamped to the THREAD: the column's own chrome is not part of the answer.
      expect(copied).not.toContain("Column header");
      expect(copied).not.toContain("Draft in the compose box");
    });

    it("does NOT copy a document-wide select-all", async () => {
      // `⌘A` with focus on the body spans the whole document, so it straddles the thread — but it is
      // a select-all aimed at whatever surface the user was looking at, not a gesture in this
      // column. A pure intersection test cannot tell it apart from the enclosure case above, and
      // accepting it silently replaces the clipboard with the entire transcript.
      const onCopied = vi.fn();
      render(<Harness onCopied={onCopied} />);
      const range = document.createRange();
      range.selectNodeContents(document.body);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);

      fireEvent.mouseDown(document.body);
      fireEvent.mouseUp(document.body);
      await settle();

      expect(writeText).not.toHaveBeenCalled();
      expect(onCopied).not.toHaveBeenCalled();
    });

    it("a press on ANOTHER surface does not re-copy a selection still standing here", async () => {
      // The de-dupe claim is what stops the document-wide release from copying a stale range again.
      // Moving the claim reset to the document alongside the suppression would clear it on any
      // press, so a click on a surface that does not collapse the selection (the mention picker and
      // the palette backdrop both preventDefault on mousedown) re-copied the concierge's words over
      // a clipboard the user had since filled from somewhere else — and announced it a second time.
      const onCopied = vi.fn();
      render(<Harness onCopied={onCopied} />);
      selectContentsOf("inside");
      releaseOverBox();
      await settle();
      expect(writeText).toHaveBeenCalledTimes(1);

      // A press elsewhere that leaves the selection standing, then its release.
      fireEvent.mouseDown(screen.getByTestId("outside"));
      fireEvent.mouseUp(screen.getByTestId("outside"));
      await settle();

      expect(writeText).toHaveBeenCalledTimes(1);
      expect(onCopied).toHaveBeenCalledTimes(1);
    });

    it("clamps an overshooting drag to the thread instead of dropping it", async () => {
      // Anchor inside, focus dragged out past the bottom. The containment guard used to require BOTH
      // ends inside and copy nothing otherwise. Clamping keeps foreign text out — the range is cut at
      // the container's own bounds — while still giving the user what they highlighted in here.
      render(<Harness />);
      const insideText = screen.getByTestId("inside").firstChild!;
      const outsideText = screen.getByTestId("outside").firstChild!;
      const range = document.createRange();
      range.setStart(insideText, 0);
      range.setEnd(outsideText, 8);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);

      fireEvent.mouseDown(screen.getByTestId("box"));
      fireEvent.mouseUp(screen.getByTestId("outside"));
      await settle();

      const copied = writeText.mock.calls[0]?.[0] as string;
      expect(copied).toContain("Sparkle said this bit.");
      expect(copied).not.toContain("Someone else");
    });

    it("re-copies when the SAME gesture is repeated, even one that began outside the thread", async () => {
      // The de-dupe claim must be released by any hand-made drag, not only one whose press landed in
      // the thread. Scoped to the press, a repeat of the header->compose gesture was a silent no-op:
      // the reader copies an answer, copies something else in ANOTHER app (no mouseup in Sparkle, so
      // nothing here clears the claim), comes back, drags the same words again — and gets nothing
      // written, no toast, and the other app's text still on the clipboard. They paste the wrong
      // thing, with no error anywhere.
      render(<Harness />);
      const drag = () => {
        const range = document.createRange();
        range.setStart(screen.getByTestId("header").firstChild!, 0);
        range.setEnd(screen.getByTestId("compose").firstChild!, 5);
        const sel = window.getSelection()!;
        fireEvent.mouseDown(screen.getByTestId("header"));
        sel.removeAllRanges();
        sel.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
        fireEvent.mouseUp(screen.getByTestId("compose"));
      };

      drag();
      await settle();
      expect(writeText).toHaveBeenCalledTimes(1);

      drag();
      await settle();
      expect(writeText).toHaveBeenCalledTimes(2);
      expect(writeText.mock.calls[1]?.[0]).toBe(writeText.mock.calls[0]?.[0]);
    });
  });

  it("shows the confirmation and clears it after the toast window", async () => {
    vi.useFakeTimers();
    render(<Harness />);
    selectContentsOf("inside");
    releaseOverBox();
    await settle();

    expect(screen.getByTestId("toast")).toBeTruthy();

    act(() => void vi.advanceTimersByTime(COPY_TOAST_MS + 10));
    expect(screen.queryByTestId("toast")).toBeNull();
  });

  it("does not claim success when the clipboard write fails", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    const onCopied = vi.fn();
    render(<Harness onCopied={onCopied} />);
    selectContentsOf("inside");
    releaseOverBox();
    await settle();

    // The helper's execCommand fallback is unavailable in jsdom, so this is the "no path worked"
    // case: no toast, no announcement, no lie.
    expect(onCopied).not.toHaveBeenCalled();
    expect(screen.queryByTestId("toast")).toBeNull();
  });

  it("a FAILED write does not become a 300ms retry loop", async () => {
    // THE LIVE-LOCK (roborev 55075). `copyToClipboard`'s fallback now restores the selection it
    // steals, and restoring dispatches `selectionchange` — twice, for `removeAllRanges` then
    // `addRange`. This hook listens for that event and re-arms its debounce on it.
    //
    // While a failed write also cleared `lastCopied`, those two facts closed a cycle: the debounce
    // fires, the dedupe guard no longer holds, the same words are copied, the write fails, the
    // selection is restored, the debounce re-arms — for as long as the selection stands, appending
    // a textarea and yanking focus out of whatever the user is typing in on every lap. It could not
    // happen before the restore existed, because a failed attempt used to leave the selection
    // collapsed and the follow-up bailed on that.
    //
    // The claim now survives a failure, so a retry costs a fresh gesture (`mousedown` clears it) and
    // a standing selection costs nothing.
    vi.useFakeTimers();
    writeText.mockRejectedValue(new Error("denied"));
    render(<Harness />);
    selectContentsOf("inside");
    releaseOverBox();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledTimes(1);

    // What the restore inside the fallback looks like from this hook's side.
    for (let i = 0; i < 3; i++) {
      act(() => void document.dispatchEvent(new Event("selectionchange")));
      act(() => void vi.advanceTimersByTime(KEYBOARD_SELECTION_DEBOUNCE_MS + 10));
    }
    await act(async () => {
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledTimes(1);
  });
});
