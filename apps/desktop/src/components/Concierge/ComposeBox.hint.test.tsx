// @vitest-environment jsdom
//
// The compose box's keyboard-hint tagging, and the end-to-end behaviour it buys with HintOverlay:
// "/" puts the caret in the box; "k" fires Screenshot and "f" fires Upload, each a leaf that
// activates its button and dismisses the overlay.
//
// The overlay is mounted for real here rather than stubbed. The interesting failures in this
// feature are all in the seam between the two — a textarea that is clicked instead of focused, an
// attach button that is tagged but never badged — and a test that asserts only on attributes would
// pass through every one of them.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposeBox } from "./ComposeBox";
import { HintOverlay } from "../HintOverlay";
import { CHROME_HINTS } from "../../keyboardHints/hintTargets";

// jsdom gives every element a 0×0 rect and a null offsetParent, both of which the overlay's
// visibility filter rejects. Stub them so the tagged controls count as on screen.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 10, y: 10, top: 10, left: 10, right: 50, bottom: 30, width: 40, height: 20,
    toJSON: () => ({}),
  } as DOMRect);
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get() {
      return document.body;
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetParent;
});

function setup() {
  const onAttach = vi.fn();
  render(
    <>
      <ComposeBox onSend={vi.fn()} onAttach={onAttach} onRemoveAttachment={vi.fn()} />
      <HintOverlay />
    </>,
  );
  return { onAttach };
}

// A clean Control tap — the default trigger for the hint layer.
function controlTap() {
  fireEvent.keyDown(window, { key: "Control" });
  fireEvent.keyUp(window, { key: "Control" });
}

const box = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;

describe("ComposeBox — the prompt-box hint", () => {
  it("tags the textarea and asks for a top-anchored badge", () => {
    setup();
    expect(box().dataset.hint).toBe("prompt");
    // A ten-line box is the case a vertically centred badge reads wrong on: it would sit halfway
    // down an otherwise empty left edge, attached to nothing.
    expect(box().dataset.hintAnchor).toBe("top");
    expect(CHROME_HINTS.prompt).toBe("/");
  });

  it("puts the caret in the box, at the end of the existing draft", async () => {
    setup();
    fireEvent.change(box(), { target: { value: "half a draft" } });
    controlTap();
    expect(screen.getByText("/")).toBeTruthy();

    fireEvent.keyDown(window, { key: "/" });
    // THE WHOLE POINT. The overlay activates by click(), and click() on a textarea does not move
    // the caret — so without the focus path this badge would look completely inert.
    await waitFor(() => expect(document.activeElement).toBe(box()));
    expect(box().selectionStart).toBe("half a draft".length);
    // ...and the "/" itself never reaches the box it just focused.
    expect(box().value).toBe("half a draft");
  });

  it("does not leave the badge on screen after it has been used", async () => {
    setup();
    controlTap();
    fireEvent.keyDown(window, { key: "/" });
    await waitFor(() => expect(screen.queryByText("/")).toBeNull());
  });
});

describe("ComposeBox — the two attach-button hints", () => {
  const shot = () => screen.getByRole("button", { name: "Screenshot" });
  const upload = () => screen.getByRole("button", { name: "Upload" });

  it("tags both buttons at their approved characters", () => {
    setup();
    expect(shot().dataset.hint).toBe("attach-screenshot");
    expect(upload().dataset.hint).toBe("attach-upload");
    expect(CHROME_HINTS["attach-screenshot"]).toBe("k");
    expect(CHROME_HINTS["attach-upload"]).toBe("f");
  });

  // THE BADGES ARE ON SCREEN AT THE TOP LEVEL, which is the whole behavioural change here. They
  // used to be reachable only after selecting the paperclip's own "k", which opened a scoped
  // sub-layer; a single Control tap showed one badge where it now shows two.
  it("badges BOTH actions on a plain Control tap, with no trigger to press first", () => {
    setup();
    controlTap();
    expect(screen.getByText("k")).toBeTruthy();
    expect(screen.getByText("f")).toBeTruthy();
  });

  it("k fires Screenshot directly and closes the overlay", async () => {
    const { onAttach } = setup();
    controlTap();
    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() => expect(onAttach).toHaveBeenCalledWith("screenshot"));
    // A LEAF, not a chain: selecting it dismisses the overlay rather than re-collecting into a
    // sub-layer. Against the old form "k" left the overlay open showing "s" and "u".
    await waitFor(() => expect(screen.queryByText("k")).toBeNull());
    expect(screen.queryByText("f")).toBeNull();
  });

  it("f reaches Upload, so the second action is not mouse-only", async () => {
    const { onAttach } = setup();
    controlTap();
    fireEvent.keyDown(window, { key: "f" });
    // The service call is named for what it opens ("files"); the hint is named for what the user
    // sees ("upload"). ATTACH_ACTIONS carries both so neither name drifts into the other.
    await waitFor(() => expect(onAttach).toHaveBeenCalledWith("files"));
  });

  // The letters that USED to reach these two, back when they lived in a scope of their own. "s" is
  // the agent-pane composer's screenshot button and must not be answered by the concierge; "u" is
  // the "+ Cloud Agent" sidebar row. Neither surface is mounted here, so a stray badge for either
  // would mean this row had kept a mnemonic it no longer owns.
  it("no longer answers to the scoped letters the sub-layer gave them", () => {
    setup();
    controlTap();
    expect(screen.queryByText("s")).toBeNull();
    expect(screen.queryByText("u")).toBeNull();
  });

  it("leaves the caret in the draft — a leaf activation is not a focus trip", async () => {
    const { onAttach } = setup();
    fireEvent.change(box(), { target: { value: "mid sentence" } });
    box().focus();
    controlTap();
    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() => expect(onAttach).toHaveBeenCalledWith("screenshot"));
    // The chain used to FOCUS the paperclip on the way in and hand the caret back on the way out,
    // through `chainReturnRef`/`restoreFocus`. With nothing to expand, focus never leaves at all —
    // so the caret is still in the draft without any handback machinery to get it there.
    expect(document.activeElement).toBe(box());
  });
});

// A CLAIMED ESCAPE IS SUPPRESSED, or one press unwinds two layers: the hint sub-layer AND whatever
// else on screen dismisses on Escape (the kebab menu, the status strip, the model pill…).
describe("ComposeBox — Escape does not leak while a sub-layer unwinds", () => {
  let bystander: ((e: KeyboardEvent) => void) | null = null;
  afterEach(() => {
    if (bystander) document.removeEventListener("keydown", bystander);
    bystander = null;
  });

  let windowBystander: ((e: KeyboardEvent) => void) | null = null;
  afterEach(() => {
    if (windowBystander) window.removeEventListener("keydown", windowBystander, true);
    windowBystander = null;
  });

  // TWO COHORTS, and they are stopped by different things. The document/bubble one (the ⋯ menu, the
  // status strip) falls to stopPropagation; the window/CAPTURE one (the composer lightbox, the
  // shortcuts menu, the command palette) is on the SAME NODE as useHintMode's own listener, where
  // stopPropagation does nothing at all and only stopImmediatePropagation reaches. A bystander of
  // just the first kind cannot detect that class, which is why both are wired here.
  function withBystanders() {
    const onDocEscape = vi.fn();
    const onWindowCaptureEscape = vi.fn();
    bystander = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onDocEscape();
    };
    document.addEventListener("keydown", bystander);
    // Registered AFTER the hook's (which binds at mount), exactly as a surface that opens later
    // would be — that ordering is what stopImmediatePropagation can act on.
    windowBystander = (e: KeyboardEvent) => {
      if (e.key === "Escape") onWindowCaptureEscape();
    };
    window.addEventListener("keydown", windowBystander, true);
    return { onDocEscape, onWindowCaptureEscape };
  }

  // FIRED AT document.body, NOT at window. An event dispatched AT window has window as its target,
  // so a document listener is not on its path and never runs — a bystander wired to document would
  // sit silent no matter what we did, and both of these tests would pass vacuously. Pressing a key
  // for real targets the focused element, which is inside the document, so this is also the honest
  // shape. useHintMode still sees it first: it listens on window in the CAPTURE phase.
  const pressEscape = () => fireEvent.keyDown(document.body, { key: "Escape" });

  // THE "SWALLOWED ESCAPE" CASE MOVED, it was not dropped. It used to be staged here by pressing
  // "k" to open the paperclip's sub-layer and then Escaping out of it. There is no chaining trigger
  // in this surface any more, so the only layer Escape still unwinds is PAIR_PREFIX — which needs
  // more badges than a lone compose box can produce. It is pinned in HintOverlay.test.tsx
  // ("Escape backs out to the ordinary layer first, and only then dismisses").
  //
  // What is still this file's to prove is the OTHER half, below: with nothing to unwind, the press
  // must reach the surfaces around the composer. That half is the one that regresses quietly — a
  // stray `return true` in onEscape would make Escape stop working app-wide the moment hint mode
  // was open, and no chain test would notice.
  it("still lets the Escape that DISMISSES the overlay through", () => {
    setup();
    const { onDocEscape, onWindowCaptureEscape } = withBystanders();
    controlTap();
    // Nothing to unwind, so this press is an ordinary dismissal — other surfaces must still see it,
    // or Escape would stop working everywhere the moment hint mode was open.
    pressEscape();
    expect(onDocEscape).toHaveBeenCalledTimes(1);
    expect(onWindowCaptureEscape).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("k")).toBeNull();
  });
});
