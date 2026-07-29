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
      <div ref={ref} data-testid="box">
        <p data-testid="inside">Sparkle said this bit.</p>
        <p data-testid="blank"> &nbsp; </p>
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

  it("does nothing when the selection is anchored OUTSIDE the container", async () => {
    // The drag that starts in the compose box and ends over the thread. Without the containment
    // guard this copies text the user never highlighted here — see the hook's header.
    const onCopied = vi.fn();
    render(<Harness onCopied={onCopied} />);
    selectContentsOf("outside");
    releaseOverBox();
    await settle();

    expect(writeText).not.toHaveBeenCalled();
    expect(onCopied).not.toHaveBeenCalled();
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
