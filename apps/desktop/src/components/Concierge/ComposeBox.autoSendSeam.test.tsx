// @vitest-environment jsdom
//
// The two seams that connect the auto-send rail to the compose box (PRD 1 §4).
//
// THESE ARE THE TESTS THAT WERE MISSING, and their absence is the whole story of this feature: every
// unit of §4 was built and unit-tested green while the feature did not exist, because nothing tested
// the CONNECTION. Shipping the connection with tests for the new hook only — and `onFire` stubbed
// with a spy — would have left exactly the same hole one layer up: drop either prop from
// `ConciergeColumn`'s pass-through and the rail goes inert again with a fully green suite.
//
// So: assert the box REPORTS its text whatever wrote it, and that the submit it hands over runs the
// CURRENT text rather than a stale closure.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ComposeBox } from "./ComposeBox";

beforeEach(() => {
  // The box reads the dictation store for placeholder state; a bare store is fine here.
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function draw(props: Partial<Parameters<typeof ComposeBox>[0]> = {}) {
  const onSend = vi.fn();
  const onComposedText = vi.fn();
  // TYPED AS THE REAL CONTRACT: the registered fn RETURNS whether a message left the box, and this
  // file is the one whose subject is that contract. A `() => void` annotation here would erase it —
  // the empty-box row below is one assertion away from being the only guard on it.
  let registered: (() => boolean) | null = null;
  const registerSubmit = vi.fn((fn: (() => boolean) | null) => {
    registered = fn;
  });
  render(
    <ComposeBox
      onSend={props.onSend ?? onSend}
      onAttach={vi.fn()}
      onComposedText={onComposedText}
      registerSubmit={registerSubmit}
      {...props}
    />,
  );
  const box = () => screen.getByLabelText("Message") as HTMLTextAreaElement;
  return { onSend, onComposedText, registerSubmit, box, fire: () => registered?.() };
}

describe("onComposedText — the rail's only view of what it would send", () => {
  it("reports the contents on mount and on every change", () => {
    const { onComposedText, box } = draw();
    // Mount reports "", which is what tells the host this is a fresh box.
    expect(onComposedText).toHaveBeenCalledWith("");

    fireEvent.change(box(), { target: { value: "deploy the staging branch" } });
    expect(onComposedText).toHaveBeenLastCalledWith("deploy the staging branch");
  });

  it("reports text the box did not get from typing — the case it exists for", () => {
    // Auto-send only ever fires on DICTATED text, and `onTextEdit` deliberately does not report it
    // (the host uses that one to retire routing latches on a hand-emptied box). If this reported
    // only keystrokes the rail would be blind to speech, which is the whole feature.
    const { onComposedText, box } = draw();
    onComposedText.mockClear();

    // A dictated segment lands through setText, not through a change event on the textarea.
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(box(), "ship it");
      box().dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(onComposedText).toHaveBeenLastCalledWith("ship it");
  });
});

describe("registerSubmit — the rail fires the SAME path the button does", () => {
  it("hands over a submit that sends the CURRENT text, not the text at registration", () => {
    // The subtle part, and the reason there is a ref indirection: `submit` closes over `text` and
    // is rebuilt every render. Registering it directly would leave the host holding a closure over
    // an EMPTY box, firing sends that silently do nothing.
    const { onSend, box, fire } = draw();
    fireEvent.change(box(), { target: { value: "first" } });
    fireEvent.change(box(), { target: { value: "second" } });

    act(() => void fire());

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("second");
  });

  it("clears the box, exactly as the button does", () => {
    const { box, fire } = draw();
    fireEvent.change(box(), { target: { value: "ship it" } });
    act(() => void fire());
    expect(box().value).toBe("");
  });

  it("sends nothing from an empty box, and SAYS SO", () => {
    // `submit` early-returns on !canSend. The rail treats a no-op as "not sent" (see
    // UseAutoSendArgs.onFire) — but it must genuinely be a no-op, not an empty message.
    //
    // The RETURN VALUE is the half that matters to the rail, and it is what "not sent" is made of:
    // on a false the rail must not announce "Sent to …" into the live region and must not record a
    // tuning sample. Assert it here, not just `onSend`, because flipping this early return to
    // `return true` still typechecks and still sends nothing — the suite would stay green while
    // every empty-box auto-fire announced a phantom send to a screen-reader user and fed the corpus
    // that trains the thresholds.
    const { onSend, fire } = draw();
    let reported: boolean | undefined;
    act(() => {
      reported = fire();
    });
    expect(onSend).not.toHaveBeenCalled();
    expect(reported).toBe(false);
  });

  it("reports TRUE when a message really did leave the box", () => {
    // The other half of the same contract: a real send has to be distinguishable from the no-op
    // above, or the rail's silence would be indiscriminate rather than informed.
    const { box, fire } = draw();
    fireEvent.change(box(), { target: { value: "ship it" } });
    let reported: boolean | undefined;
    act(() => {
      reported = fire();
    });
    expect(reported).toBe(true);
  });

  it("unregisters on unmount, so the host cannot fire a dead box", () => {
    const { registerSubmit } = draw();
    expect(registerSubmit).toHaveBeenLastCalledWith(expect.any(Function));
    cleanup();
    expect(registerSubmit).toHaveBeenLastCalledWith(null);
  });
});
