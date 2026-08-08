// @vitest-environment jsdom
//
// The hold gesture. Every row here describes behaviour the app did not have at all before the send
// tray: nothing in apps/desktop bound a held key to the microphone, so each of these fails against
// the previous code by way of the hook not existing.
//
// The listeners are on `window` and every event here is dispatched on `window`. That is the point
// of the feature ("hold ⌘ ANYWHERE"), and it is also what keeps these rows honest — firing at a
// different target than the listener is registered on is the wrong-target vacuous test the repo's
// `no-cross-target-event-dispatch` rule exists to catch.
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TALK_KEY, usePushToTalk, type UsePushToTalkArgs } from "./usePushToTalk";
import { clearHoldOrigin, holdOriginPending, takeHoldOriginAge } from "./holdOrigin";

afterEach(cleanup);

function Probe(props: UsePushToTalkArgs) {
  usePushToTalk(props);
  return null;
}

function mount(over: Partial<UsePushToTalkArgs> = {}) {
  const onHoldStart = vi.fn();
  const onHoldEnd = vi.fn();
  const onAbandon = vi.fn();
  const props: UsePushToTalkArgs = { active: true, onHoldStart, onHoldEnd, onAbandon, ...over };
  const view = render(<Probe {...props} />);
  return { onHoldStart, onHoldEnd, onAbandon, view, props };
}

const down = (init: Partial<KeyboardEventInit> = {}) =>
  fireEvent.keyDown(window, { key: TALK_KEY, ...init });
const up = () => fireEvent.keyUp(window, { key: TALK_KEY });

describe("hold ⌘ to talk, release to send", () => {
  it("the hold starts on keydown ANYWHERE in the window, not only in the compose box", () => {
    const { onHoldStart } = mount();
    down();
    expect(onHoldStart).toHaveBeenCalledTimes(1);
  });

  it("RELEASING sends — immediately, with no timer to wait out", () => {
    // The asymmetry with Speak, and the reason it exists: the user said where the utterance ended
    // by letting go, so making them then wait out a clock would make the deliberate mode feel
    // laggier than the automatic one.
    const { onHoldEnd, onAbandon } = mount();
    down();
    up();
    expect(onHoldEnd).toHaveBeenCalledTimes(1);
    expect(onAbandon).not.toHaveBeenCalled();
  });

  it("auto-repeat does NOT re-arm a mic that is already hot", () => {
    // Holding a key emits keydown many times a second. Only the first is the gesture beginning.
    const { onHoldStart } = mount();
    down();
    down({ repeat: true });
    down({ repeat: true });
    expect(onHoldStart).toHaveBeenCalledTimes(1);
  });

  it("a release with no hold in progress sends nothing", () => {
    // A bare ⌘ keyup with no preceding keydown — e.g. the key was already down when this mode was
    // entered. NOTE this row does NOT cover ⌘V; that one has its own, below, and the distinction
    // matters because this comment used to claim the ⌘V case and the assertion never exercised it.
    const { onHoldEnd } = mount();
    up();
    expect(onHoldEnd).not.toHaveBeenCalled();
  });

  it("⌘V DOES NOT SEND — an ordinary ⌘ chord is not a hold", () => {
    // THE SHARPEST EDGE ON THIS FEATURE. ⌘ is the OS's chord modifier as well as our talk key, so
    // ⌘V, ⌘A, ⌘C, ⌘Z, ⌘K, ⌘1…9 all begin with a `Meta` keydown and end with a `Meta` keyup. Without
    // the second-key branch every one of them dispatched the draft the instant ⌘ came back up — an
    // irreversible send nobody asked for, in the mode whose whole promise is that YOU decide when
    // the message goes.
    const { onHoldEnd, onAbandon } = mount();
    down();
    fireEvent.keyDown(window, { key: "v", metaKey: true });
    up();
    expect(onHoldEnd).not.toHaveBeenCalled();
    expect(onAbandon).toHaveBeenCalledTimes(1);
  });

  it("…and the mic is dropped the moment the chord starts, not when ⌘ comes up", () => {
    // The hold is abandoned on the SECOND KEYDOWN, so a long ⌘-held chord sequence is not spent
    // recording. Asserted separately from the no-send row above so a fix that merely suppressed the
    // send while leaving the mic hot would still fail here.
    const { onAbandon } = mount();
    down();
    fireEvent.keyDown(window, { key: "a", metaKey: true });
    expect(onAbandon).toHaveBeenCalledTimes(1);
  });

  it("a chord that continues does not abandon twice, and a fresh hold still works after", () => {
    const { onHoldStart, onAbandon, onHoldEnd } = mount();
    down();
    fireEvent.keyDown(window, { key: "c", metaKey: true });
    fireEvent.keyDown(window, { key: "v", metaKey: true });
    expect(onAbandon).toHaveBeenCalledTimes(1);
    up();
    // …and the gesture is not poisoned: the next deliberate hold sends as normal.
    down();
    up();
    expect(onHoldStart).toHaveBeenCalledTimes(2);
    expect(onHoldEnd).toHaveBeenCalledTimes(1);
  });

  it("only ⌘ is the talk key — other keys pass straight through", () => {
    const { onHoldStart, onHoldEnd } = mount();
    fireEvent.keyDown(window, { key: "Shift" });
    fireEvent.keyUp(window, { key: "Shift" });
    expect(onHoldStart).not.toHaveBeenCalled();
    expect(onHoldEnd).not.toHaveBeenCalled();
  });
});

describe("a hold that cannot end cleanly is ABANDONED, never sent", () => {
  it("window blur abandons — ⌘Tab never delivers its keyup", () => {
    // NOT DEFENSIVE. While ⌘ is held every stray letter becomes an OS chord, and ⌘Tab switches
    // application WITHOUT emitting the keyup for ⌘. Without this the hold never ends: the mic
    // stays hot indefinitely and the next thing said lands in a message the user thought they had
    // walked away from. Abandoning is the safe direction; a send nobody asked for is the failure
    // this whole feature exists to make impossible.
    const { onAbandon, onHoldEnd } = mount();
    down();
    fireEvent.blur(window);
    expect(onAbandon).toHaveBeenCalledTimes(1);
    expect(onHoldEnd).not.toHaveBeenCalled();
  });

  it("a keyup arriving AFTER an abandon does not send a second time", () => {
    // Coming back from another app and letting go of ⌘ must not deliver the message that was
    // already abandoned.
    const { onAbandon, onHoldEnd } = mount();
    down();
    fireEvent.blur(window);
    up();
    expect(onAbandon).toHaveBeenCalledTimes(1);
    expect(onHoldEnd).not.toHaveBeenCalled();
  });

  it("leaving Push to talk mid-hold abandons rather than sending", () => {
    const { onAbandon, onHoldEnd, view, props } = mount();
    down();
    view.rerender(<Probe {...props} active={false} />);
    expect(onAbandon).toHaveBeenCalledTimes(1);
    expect(onHoldEnd).not.toHaveBeenCalled();
  });

  it("a terminal taking the keyboard mid-hold abandons too", () => {
    // The tray is inert when a live PTY owns the keyboard, and an inert tray must not be holding a
    // hot microphone open behind the user's back.
    const { onAbandon, onHoldEnd, view, props } = mount();
    down();
    view.rerender(<Probe {...props} inert />);
    expect(onAbandon).toHaveBeenCalledTimes(1);
    expect(onHoldEnd).not.toHaveBeenCalled();
  });
});

describe("nothing is bound outside Push to talk", () => {
  it("an inactive tray ignores the key entirely", () => {
    const { onHoldStart, onHoldEnd } = mount({ active: false });
    down();
    up();
    expect(onHoldStart).not.toHaveBeenCalled();
    expect(onHoldEnd).not.toHaveBeenCalled();
  });

  it("an INERT tray ignores it too, even while Push to talk is selected", () => {
    const { onHoldStart } = mount({ inert: true });
    down();
    expect(onHoldStart).not.toHaveBeenCalled();
  });

  it("unmounting stops listening — a torn-down tray cannot arm a microphone", () => {
    const { onHoldStart, view } = mount();
    view.unmount();
    down();
    expect(onHoldStart).not.toHaveBeenCalled();
  });
});

describe("the keydown is STAMPED, so the latency it starts can be measured", () => {
  // sparkle-oyapv. Push to talk rests with the mic released, so this keydown is the start of a
  // ~200-600 ms span in which everything the founder says is lost — and until this stamp existed
  // nothing upstream of Rust recorded when the gesture happened, so that span had never been
  // measured. These rows assert the SIDE EFFECT (an origin is now pending) rather than that the
  // callback fired, which the rows above already cover and which would stay green with the stamp
  // deleted.
  beforeEach(() => clearHoldOrigin());

  it("a real keydown leaves an origin for the arm to bill against", () => {
    mount();
    down();
    expect(holdOriginPending()).toBe(true);
    // And it is a usable age, not merely a truthy slot: this is the number that reaches Rust.
    expect(takeHoldOriginAge()).toBeGreaterThanOrEqual(0);
  });

  it("stamps BEFORE onHoldStart, because everything that callback does is what is being measured", () => {
    // `onHoldStart` is what eventually reaches `invoke("start_dictation")` by way of applyIntent,
    // two store writes and a React effect. A stamp taken after it would silently exclude the whole
    // frontend half of the span — the half that had never been measured, i.e. the entire point.
    const pendingWhenCalled: boolean[] = [];
    mount({ onHoldStart: () => pendingWhenCalled.push(holdOriginPending()) });
    down();
    expect(pendingWhenCalled).toEqual([true]);
  });

  it("does not stamp for a key that is not the talk key", () => {
    mount();
    fireEvent.keyDown(window, { key: "a" });
    expect(holdOriginPending()).toBe(false);
  });

  it("auto-repeat does not re-stamp, so the origin stays the moment the key went DOWN", () => {
    // Re-stamping on repeat would reset the clock ~30×/second, so the reported latency would be
    // the time since the last REPEAT — a number near zero, published for the exact hold that is
    // losing words. Consuming the origin first makes the re-stamp observable: if a repeat stamped,
    // the slot would be full again.
    mount();
    down();
    expect(takeHoldOriginAge()).not.toBeNull();
    down({ repeat: true });
    down({ repeat: true });
    expect(holdOriginPending()).toBe(false);
  });

  it("does not stamp when the tray is inert or the mode is not push to talk", () => {
    // The listeners are unbound, so no gesture exists to bill.
    mount({ inert: true });
    down();
    expect(holdOriginPending()).toBe(false);

    cleanup();
    mount({ active: false });
    down();
    expect(holdOriginPending()).toBe(false);
  });
});

describe("fresh callbacks each render do not tear the hold apart", () => {
  it("a re-render mid-hold still delivers the release", () => {
    // The callbacks are read through a ref precisely so a parent passing new closures every render
    // does not rebuild the listeners mid-gesture — which would drop the keyup for a hold already in
    // progress, i.e. reproduce the stuck-hot microphone on purpose.
    const onHoldEnd = vi.fn();
    const first = vi.fn();
    const view = render(
      <Probe active onHoldStart={first} onHoldEnd={onHoldEnd} onAbandon={vi.fn()} />,
    );
    down();
    const second = vi.fn();
    view.rerender(
      <Probe active onHoldStart={second} onHoldEnd={onHoldEnd} onAbandon={vi.fn()} />,
    );
    up();
    expect(onHoldEnd).toHaveBeenCalledTimes(1);
  });
});
