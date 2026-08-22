// @vitest-environment jsdom
//
// The control-gesture opt-out (DEFECT 4 of sparkle-bjbhw6). "Anything where there is an action that
// is click drag should not trigger drag to understand."
//
// jsdom has no PointerEvent constructor worth relying on, so the presses are dispatched as
// `new MouseEvent("pointerdown", …)` — the same idiom `ColumnPullTab.test.tsx` already uses. The
// listener does not care which constructor made the event; it reads `type` and `target`.
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTROL_GESTURE_ATTR,
  isControlGestureActive,
  isControlGestureTarget,
  watchControlGesture,
} from "./controlGesture";

/** Every disposer armed by a test, so a failure cannot leave the latch armed for the next one. */
const armed: Array<() => void> = [];

function arm(): () => void {
  const dispose = watchControlGesture(document);
  armed.push(dispose);
  return dispose;
}

afterEach(() => {
  while (armed.length) armed.pop()!();
  document.body.innerHTML = "";
});

/** Build `<div data-control-gesture="yes"><span>…</span></div>`-shaped markup and hand back the leaf. */
function mount(html: string): { root: HTMLElement; leaf: HTMLElement } {
  document.body.innerHTML = html;
  const root = document.body.firstElementChild as HTMLElement;
  const leaf = (root.querySelector("[data-leaf]") as HTMLElement | null) ?? root;
  return { root, leaf };
}

function press(el: EventTarget): void {
  el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
}

function release(el: EventTarget, type = "pointerup"): void {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
}

describe("isControlGestureTarget", () => {
  it("is true for the opted-out element itself", () => {
    const { root } = mount(`<div ${CONTROL_GESTURE_ATTR}="yes"></div>`);
    expect(isControlGestureTarget(root)).toBe(true);
  });

  it("is true for a descendant of an opted-out element", () => {
    const { leaf } = mount(`<div ${CONTROL_GESTURE_ATTR}="yes"><b><i data-leaf></i></b></div>`);
    expect(isControlGestureTarget(leaf)).toBe(true);
  });

  it("is true for a TEXT NODE inside an opted-out element — a press can land on one", () => {
    const { root } = mount(`<div ${CONTROL_GESTURE_ATTR}="yes">rail</div>`);
    expect(isControlGestureTarget(root.firstChild)).toBe(true);
  });

  it("is FALSE for ordinary content", () => {
    const { leaf } = mount(`<div><p data-leaf>Sparkle said this bit.</p></div>`);
    expect(isControlGestureTarget(leaf)).toBe(false);
  });

  it("is FALSE for any value other than yes — the attribute opts OUT, it does not merely exist", () => {
    const { root } = mount(`<div ${CONTROL_GESTURE_ATTR}="no"></div>`);
    expect(isControlGestureTarget(root)).toBe(false);
  });

  it("accepts a value that differs only in case or padding", () => {
    const { root } = mount(`<div ${CONTROL_GESTURE_ATTR}=" YES "></div>`);
    expect(isControlGestureTarget(root)).toBe(true);
  });

  it("keeps CLIMBING past a nearer element whose value is not yes", () => {
    // `closest("[data-control-gesture]")` stops at the inner div and reports content. The target is
    // nonetheless inside a control that opted out, so the answer must be true.
    const { leaf } = mount(
      `<div ${CONTROL_GESTURE_ATTR}="yes"><div ${CONTROL_GESTURE_ATTR}="no"><span data-leaf></span></div></div>`,
    );
    expect(isControlGestureTarget(leaf)).toBe(true);
  });

  it("is false for null and for a target that is not a Node", () => {
    expect(isControlGestureTarget(null)).toBe(false);
    expect(isControlGestureTarget(window)).toBe(false);
  });
});

describe("watchControlGesture", () => {
  it("latches on a press that lands on an opted-out control, and NOT on one that lands in content", () => {
    const { root, leaf } = mount(
      `<div><span ${CONTROL_GESTURE_ATTR}="yes" data-leaf>handle</span><p>content</p></div>`,
    );
    arm();
    expect(isControlGestureActive()).toBe(false);

    press(leaf);
    expect(isControlGestureActive()).toBe(true);

    release(leaf);
    // PAIRED, in the same test: the identical gesture on content must not latch — otherwise
    // "latched" proves nothing about the attribute.
    press(root.querySelector("p")!);
    expect(isControlGestureActive()).toBe(false);
  });

  it("holds the latch across the whole drag and releases it on pointerup", () => {
    const { leaf } = mount(`<div ${CONTROL_GESTURE_ATTR}="yes"><span data-leaf></span></div>`);
    arm();

    press(leaf);
    // The drag: `selectionchange` fires repeatedly with no pointer event between, which is exactly
    // why the latch cannot be re-derived from a target.
    document.dispatchEvent(new Event("selectionchange"));
    document.dispatchEvent(new Event("selectionchange"));
    expect(isControlGestureActive()).toBe(true);

    release(leaf);
    expect(isControlGestureActive()).toBe(false);
  });

  it("releases on pointercancel", () => {
    const { leaf } = mount(`<div ${CONTROL_GESTURE_ATTR}="yes"><span data-leaf></span></div>`);
    arm();
    press(leaf);
    expect(isControlGestureActive()).toBe(true);

    release(leaf, "pointercancel");
    expect(isControlGestureActive()).toBe(false);
  });

  it("releases on window blur — the backstop for a release that never arrives", () => {
    const { leaf } = mount(`<div ${CONTROL_GESTURE_ATTR}="yes"><span data-leaf></span></div>`);
    arm();
    press(leaf);
    expect(isControlGestureActive()).toBe(true);

    // CORRECTLY PAIRED, and the rule cannot see it. `watchControlGesture` registers its blur
    // backstop on `doc.defaultView` — i.e. `window` — which is a DIFFERENT file, so the rule sees
    // only that this test file dispatches at `window` while its other listeners sit on `document`.
    // A window dispatch reaching a window listener is exactly right; the rule's hazard (a window
    // dispatch never reaching a document listener) is not what is happening here.
    // eslint-disable-next-line sparkle-test/no-cross-target-event-dispatch
    window.dispatchEvent(new Event("blur"));
    expect(isControlGestureActive()).toBe(false);
  });

  describe("ORDERING — the latch is armed before anything else can read it", () => {
    it("is already set for a document listener registered BEFORE the watcher", () => {
      const { leaf } = mount(`<div ${CONTROL_GESTURE_ATTR}="yes"><span data-leaf></span></div>`);
      // THE LOSING INTERLEAVING, made explicit: this consumer wins on registration order, so if the
      // watcher armed in the bubble phase it would run SECOND and this would read false. Capture on
      // the document is what makes registration order irrelevant.
      const seen: boolean[] = [];
      const consumer = () => seen.push(isControlGestureActive());
      document.addEventListener("pointerdown", consumer);
      arm();

      press(leaf);
      document.removeEventListener("pointerdown", consumer);
      expect(seen).toEqual([true]);
    });

    it("is already set for a listener bound on the CONTROL ITSELF, which the bubble reaches first", () => {
      const { root, leaf } = mount(
        `<div ${CONTROL_GESTURE_ATTR}="yes"><span data-leaf></span></div>`,
      );
      // The deepest node in the tree: its bubble-phase handler runs before ANY document-level
      // bubble handler, whenever it was registered. Only a document CAPTURE listener beats it.
      const seen: boolean[] = [];
      root.addEventListener("pointerdown", () => seen.push(isControlGestureActive()));
      arm();

      press(leaf);
      expect(seen).toEqual([true]);
    });
  });

  describe("the disposer", () => {
    it("stops latching once disposed", () => {
      const { leaf } = mount(`<div ${CONTROL_GESTURE_ATTR}="yes"><span data-leaf></span></div>`);
      const dispose = arm();
      dispose();

      press(leaf);
      expect(isControlGestureActive()).toBe(false);
    });

    it("clears a latch that was set when it was disposed mid-drag", () => {
      const { leaf } = mount(`<div ${CONTROL_GESTURE_ATTR}="yes"><span data-leaf></span></div>`);
      const dispose = arm();
      press(leaf);
      expect(isControlGestureActive()).toBe(true);

      dispose();
      // A stuck latch would deafen every selection affordance for the rest of the session.
      expect(isControlGestureActive()).toBe(false);
    });

    it("keeps watching while ANOTHER consumer still holds it — the two hooks share one watcher", () => {
      const { leaf } = mount(`<div ${CONTROL_GESTURE_ATTR}="yes"><span data-leaf></span></div>`);
      arm();
      const second = arm();
      second();

      press(leaf);
      expect(isControlGestureActive()).toBe(true);
    });

    it("ignores a second call, so a double cleanup cannot unarm a live consumer", () => {
      const { leaf } = mount(`<div ${CONTROL_GESTURE_ATTR}="yes"><span data-leaf></span></div>`);
      const first = arm();
      arm();
      first();
      first();

      press(leaf);
      expect(isControlGestureActive()).toBe(true);
    });
  });
});
