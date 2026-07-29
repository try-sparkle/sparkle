// @vitest-environment jsdom
//
// The compose box's keyboard-hint tagging, and the end-to-end behaviour it buys with HintOverlay:
// "/" puts the caret in the box, "k" opens the paperclip and chains into Screenshot / Upload.
//
// The overlay is mounted for real here rather than stubbed. The interesting failures in this
// feature are all in the seam between the two — a textarea that is clicked instead of focused, an
// attach action badged outside its chain — and a test that asserts only on attributes would pass
// through every one of them.
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
const clip = () => screen.getByRole("button", { name: "Attach" });

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

describe("ComposeBox — the paperclip hint", () => {
  it("tags the paperclip at the approved character", () => {
    setup();
    expect(clip().dataset.hint).toBe("attach");
    expect(CHROME_HINTS.attach).toBe("k");
  });

  it("k expands the group and chains into Screenshot and Upload", async () => {
    const { onAttach } = setup();
    controlTap();
    expect(screen.getByText("k")).toBeTruthy();

    fireEvent.keyDown(window, { key: "k" });
    // The paperclip's own click only EXPANDS the group, so closing here would leave the user on an
    // open menu with no badges. It stays open on the two things the clip can actually do.
    await waitFor(() => expect(screen.getByText("u")).toBeTruthy());
    expect(screen.getByText("s")).toBeTruthy();
    expect(screen.queryByText("k")).toBeNull(); // scoped: the trigger's own badge is spent

    fireEvent.keyDown(window, { key: "s" });
    await waitFor(() => expect(onAttach).toHaveBeenCalledWith("screenshot"));
  });

  it("u reaches Upload, so the second action isn't mouse-only", async () => {
    const { onAttach } = setup();
    controlTap();
    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() => expect(screen.getByText("u")).toBeTruthy());
    fireEvent.keyDown(window, { key: "u" });
    // The service call is named for what it opens ("files"); the hint is named for what the user
    // sees ("upload"). ATTACH_ACTIONS carries both so neither name drifts into the other.
    await waitFor(() => expect(onAttach).toHaveBeenCalledWith("files"));
  });

  // The group expands on HOVER too. If its actions were badged in the ordinary layer, their "s"
  // would collide with the agent-pane composer's screenshot mnemonic and one would be dead.
  it("does not badge the actions when the group was opened by hover instead of by k", () => {
    setup();
    fireEvent.mouseEnter(screen.getByTestId("concierge-attach"));
    controlTap();
    expect(screen.getByText("k")).toBeTruthy();
    expect(screen.queryByText("u")).toBeNull();
    expect(screen.queryByText("s")).toBeNull();
  });
});

// ABANDONING THE CHAIN MUST CLOSE WHAT IT OPENED (roborev 54675). The group latches open on
// `pinned`, whose release paths all run through focus leaving it — and a synthetic click focuses
// nothing. Entering the chain therefore FOCUSES the paperclip and leaving BLURS it, driving the
// component through its own machinery. These run against the real AttachControl: a stand-in
// modelling `open` as one useState is exactly the thing that would let this regress unnoticed.
describe("ComposeBox — abandoning the paperclip chain", () => {
  const actions = () => document.getElementById("concierge-attach-actions")!;

  it("puts focus in the group when the chain opens, which is what holds it expanded", async () => {
    setup();
    controlTap();
    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() => expect(screen.getByText("u")).toBeTruthy());
    expect(document.activeElement).toBe(clip());
    expect(actions().hidden).toBe(false);
  });

  it("Escape out of the chain collapses the group instead of stranding it open", async () => {
    setup();
    controlTap();
    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() => expect(screen.getByText("u")).toBeTruthy());

    fireEvent.keyDown(window, { key: "Escape" });
    // Back to the ordinary layer...
    expect(screen.getByText("k")).toBeTruthy();
    // ...and the disclosure the chain opened is shut. Left expanded it would sit in the compose row
    // with no badges on it (they're scoped out) and no keyboard way to close it.
    await waitFor(() => expect(actions().hidden).toBe(true));
    expect(clip().getAttribute("aria-expanded")).toBe("false");
  });

  it("dismissing the whole overlay collapses it too", async () => {
    setup();
    controlTap();
    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() => expect(screen.getByText("u")).toBeTruthy());

    controlTap(); // a second tap dismisses outright, never reaching onEscape
    await waitFor(() => expect(actions().hidden).toBe(true));
  });

  it("but CHOOSING an action still reaches it — the group is not collapsed out from under it", async () => {
    const { onAttach } = setup();
    controlTap();
    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() => expect(screen.getByText("u")).toBeTruthy());
    fireEvent.keyDown(window, { key: "s" });
    await waitFor(() => expect(onAttach).toHaveBeenCalledWith("screenshot"));
  });

  // ...AND THE RESTORE MUST NOT HAND FOCUS BACK INTO THE GROUP IT JUST CLOSED. If the paperclip
  // already held focus when the chain opened, "restoring" re-fires the group's focus handler and
  // re-expands it — stranded again, badges scoped away, no keyboard way out.
  //
  // Neither older cohort of tests reaches this: the collapse ones focus nothing (so the restore is
  // skipped as document.body) and the caret ones focus the textarea. It needs the trigger itself to
  // be the previous holder, which is the STEADY state, not a contrived one.
  it("stays collapsed when the chain was opened with the paperclip already focused", async () => {
    setup();
    clip().focus();
    controlTap();
    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() => expect(screen.getByText("u")).toBeTruthy());

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(actions().hidden).toBe(true));
    // AND focus goes back to the clip, not to <body>. "Nowhere else to go" here means the trigger
    // IS where the user was — a keyboard user who tabbed to it would otherwise lose their place and
    // the next Tab would restart from the top of the document. Collapsed-but-focused is only
    // possible because the handback is programmatic, which AttachControl reads as not-the-user.
    expect(document.activeElement).toBe(clip());
  });

  it("stays collapsed on a SECOND chain, the state any completed chain leaves behind", async () => {
    const { onAttach } = setup();
    // First chain, run to completion. AttachControl.close skips its handback because the clip is
    // what holds focus, so the clip is still focused when the next one starts.
    controlTap();
    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() => expect(screen.getByText("u")).toBeTruthy());
    fireEvent.keyDown(window, { key: "s" });
    await waitFor(() => expect(onAttach).toHaveBeenCalledWith("screenshot"));

    // Second chain, abandoned.
    controlTap();
    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() => expect(screen.getByText("u")).toBeTruthy());
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(actions().hidden).toBe(true));
    expect(document.activeElement).toBe(clip());
  });

  // THE FOCUS THE CHAIN TOOK HAS TO GO BACK. Opening it moves focus onto the paperclip, and letting
  // go with a bare blur() drops the caret on <body> — so the draft the user was mid-way through has
  // nowhere to type. Both exits restore it.
  it("returns the caret to the draft when the chain is abandoned", async () => {
    setup();
    fireEvent.change(box(), { target: { value: "mid sentence" } });
    box().focus();
    controlTap();
    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() => expect(document.activeElement).toBe(clip()));

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(box()));
  });

  it("returns the caret to the draft after an action is chosen, too", async () => {
    const { onAttach } = setup();
    fireEvent.change(box(), { target: { value: "mid sentence" } });
    box().focus();
    controlTap();
    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() => expect(screen.getByText("u")).toBeTruthy());

    fireEvent.keyDown(window, { key: "s" });
    await waitFor(() => expect(onAttach).toHaveBeenCalledWith("screenshot"));
    // AttachControl.close() skips its own focus handback when the paperclip is what holds focus,
    // which after a keyboard chain it always is — so without the restore the caret would be left on
    // the clip and the next keystroke would go nowhere.
    await waitFor(() => expect(document.activeElement).toBe(box()));
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

  it("swallows the Escape that backs out of the chain, from BOTH cohorts", async () => {
    setup();
    const { onDocEscape, onWindowCaptureEscape } = withBystanders();
    controlTap();
    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() => expect(screen.getByText("u")).toBeTruthy());

    pressEscape();
    expect(onDocEscape).not.toHaveBeenCalled();
    expect(onWindowCaptureEscape).not.toHaveBeenCalled();
    expect(screen.getByText("k")).toBeTruthy(); // the sub-layer did unwind
  });

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
