// @vitest-environment jsdom
//
// `onComposeInteraction` — the compose box's half of the countdown pause (bead sparkle-wfwypy).
//
// THE FOUNDER'S REPORT: *"when I start by talking, and then I start typing in the compose window,
// it's not pausing the auto send."*
//
// The predicate is proven pure in voice/composeInteraction.test.ts and the countdown's response to
// it in voice/useAutoSend.interactionPause.test.ts. Neither can see the fact THIS file owns, and it
// is the one the whole feature turns on: whether the real textarea actually reports the gestures.
// A hook that pauses perfectly on a signal nobody sends is the "defaulted seam" failure this repo
// names explicitly — every suite green, the feature inert in the app.
//
// So every row here drives the REAL DOM event a user's hand produces and asserts what reached the
// host, rather than calling the handler directly.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposeBox } from "./ComposeBox";
import type { MentionAgent } from "./mentions";
import type { ComposeInteractionKind } from "../../voice/composeInteraction";

afterEach(() => cleanup());

function agent(over: Partial<MentionAgent> & { id: string; name: string }): MentionAgent {
  return { projectId: "p1", projectName: "web", band: "running", canAcceptInput: true, ...over };
}

function setup() {
  const onComposeInteraction = vi.fn();
  render(
    <ComposeBox
      onSend={vi.fn()}
      onAttach={vi.fn()}
      mentionAgents={[agent({ id: "a1", name: "Blueprint UI/UX" })]}
      onComposeInteraction={onComposeInteraction}
    />,
  );
  return { onComposeInteraction };
}

const box = () => screen.getByLabelText("Message") as HTMLTextAreaElement;

/** Every kind reported so far, oldest first. */
function kinds(spy: ReturnType<typeof vi.fn>): ComposeInteractionKind[] {
  return spy.mock.calls.map((c) => c[0] as ComposeInteractionKind);
}

describe("the box reports the gestures that CHANGE the draft as edits", () => {
  it("MOUNTING IS NOT A GESTURE — nothing is reported until a hand moves", () => {
    // The paired negative for every row below. Without it, a box that reported "edit" on every
    // render would satisfy all of them, and would freeze the countdown permanently.
    const { onComposeInteraction } = setup();
    expect(onComposeInteraction).not.toHaveBeenCalled();
  });

  it.each([
    ["typing a character", "Deploy"],
    // Emptied by hand — seeded first, because React fires no change event when the value it is
    // handed matches the one already there, and a box that starts empty would report nothing.
    ["deleting back to nothing", ""],
    ["a middle-of-word edit", "Depl0y the branch"],
  ])("%s reports an edit", (_label, value) => {
    const { onComposeInteraction } = setup();
    fireEvent.change(box(), { target: { value: "seed", selectionStart: 4 } });
    onComposeInteraction.mockClear();
    fireEvent.change(box(), { target: { value, selectionStart: value.length } });
    expect(kinds(onComposeInteraction)).toEqual(["edit"]);
  });

  it("reports ONE edit per keystroke, so a burst cannot collapse into a single hold", () => {
    // The countdown re-arms its settle window on each gesture (useAutoSend). A box that reported
    // only the first character of a burst would let the hold expire mid-sentence — the founder's
    // bug, arriving a few keystrokes later.
    const { onComposeInteraction } = setup();
    for (const v of ["D", "De", "Dep"]) {
      fireEvent.change(box(), { target: { value: v, selectionStart: v.length } });
    }
    expect(kinds(onComposeInteraction)).toEqual(["edit", "edit", "edit"]);
  });
});

describe("…and the gestures that merely AIM at it as caret moves", () => {
  it.each([
    ["arrowing back through the sentence", { key: "ArrowLeft" }],
    ["jumping to the start", { key: "Home" }],
    ["select-all", { key: "a", metaKey: true }],
  ])("%s reports a caret gesture", (_label, init) => {
    const { onComposeInteraction } = setup();
    fireEvent.keyDown(box(), init);
    expect(kinds(onComposeInteraction)).toEqual(["caret"]);
  });

  it("a pointer press on the box reports one — placing a caret, or starting a drag-select", () => {
    const { onComposeInteraction } = setup();
    fireEvent.pointerDown(box());
    expect(kinds(onComposeInteraction)).toEqual(["caret"]);
  });

  it("A TYPING KEY DOES NOT REPORT A CARET GESTURE — it is counted once, by onChange", () => {
    // Both handlers sit on the same textarea, so the character keys are the overlap. Reporting them
    // twice would be harmless for the pause but would make `edited` flap: the second call carries
    // kind "caret", which does NOT floor the threshold, so the LAST word would win and a
    // hand-edited draft would silently keep the speech ladder's fast lane.
    const { onComposeInteraction } = setup();
    fireEvent.keyDown(box(), { key: "x" });
    expect(onComposeInteraction).not.toHaveBeenCalled();
  });
});

describe("picking a name off the @-mention list", () => {
  it("reports it, even though the insert never fires a change event", () => {
    // `chooseMention` writes the textarea PROGRAMMATICALLY (`applyEdit`), so React's onChange never
    // runs and the edit funnel above is blind to it. This is the row that catches the omission.
    const { onComposeInteraction } = setup();
    const ta = box();
    fireEvent.change(ta, { target: { value: "@Blue", selectionStart: 5 } });
    ta.selectionStart = 5;
    ta.selectionEnd = 5;
    fireEvent.select(ta);
    onComposeInteraction.mockClear();

    // mouseDown, not click — the picker commits on press so the textarea never loses focus.
    fireEvent.mouseDown(screen.getAllByTestId("concierge-mention-option")[0]!);
    expect(kinds(onComposeInteraction)).toContain("mention");
  });
});

describe("what the box must NOT report", () => {
  it("A DICTATED SEGMENT LANDING IN THE BOX IS NOT AN INTERACTION", () => {
    // ── THE MOST IMPORTANT ROW IN THIS FILE ────────────────────────────────────────────────────
    // Dictation writes this textarea programmatically several times a second while the user's hands
    // are nowhere near it. If those writes read as interactions, the countdown pauses on every
    // committed segment — transcription lag pushes the deadline out forever and the rail NEVER
    // FIRES, which is the exact failure autoSendTimer's module header is written to prevent.
    //
    // Assigning `.value` is what a programmatic write does; a user's edit arrives as a change event.
    const { onComposeInteraction } = setup();
    const ta = box();
    ta.value = "a segment the engine just committed";
    ta.selectionStart = ta.value.length;
    ta.selectionEnd = ta.value.length;
    // Even the selection event a real browser fires off that assignment must not count — the caret
    // wire is deliberately keyed to keydown/pointerdown, never to selection state.
    fireEvent.select(ta);
    expect(onComposeInteraction).not.toHaveBeenCalled();
  });

  it("a box mounted WITHOUT the rail seam does not crash on a gesture", () => {
    // The prop is optional; the agent composers mount this box with no countdown attached.
    render(<ComposeBox onSend={vi.fn()} onAttach={vi.fn()} />);
    const boxes = screen.getAllByLabelText("Message");
    // `!` because `noUncheckedIndexedAccess` types an index read as possibly undefined, and this
    // file's other queries go through helpers that already narrow. `getAllByLabelText` throws when
    // it matches nothing, so the last element is guaranteed to exist by the time we get here.
    const bare = boxes[boxes.length - 1]!;
    expect(() => {
      fireEvent.change(bare, { target: { value: "hi" } });
      fireEvent.keyDown(bare, { key: "ArrowLeft" });
      fireEvent.pointerDown(bare);
    }).not.toThrow();
  });
});
