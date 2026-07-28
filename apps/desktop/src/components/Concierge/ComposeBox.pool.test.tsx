// @vitest-environment jsdom
//
// The compose box's drag CEILING, measured against the real column.
//
// jsdom implements no ResizeObserver and no layout, so without the stubs below the whole
// measurement path early-returns and `availableH` silently stays at `window.innerHeight` — which is
// exactly the bug it replaced. A regression to window-sizing would otherwise keep every other test
// green (roborev 53586).
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposeBox } from "./ComposeBox";
import { useUiStore } from "../../stores/uiStore";
import {
  COMPOSE_MIN_THREAD_H,
  CONCIERGE_THREAD_TESTID,
} from "../../engine/composeBoxHeight";

/** Fire the ResizeObserver callbacks that are actually WATCHING `el` — jsdom never will.
 *
 *  Target-aware on purpose. A stub whose `observe()` is a no-op and which fires every callback
 *  regardless of what changed cannot detect a dropped `observe(...)`: delete the line and the test
 *  still passes, because the callback runs anyway. That is a test named for an invariant it cannot
 *  see violated, and it is the only coverage the thread-observation fix has (roborev 53599). */
let fireResize: (el: Element) => void = () => {};
/** Which elements the component asked to observe, so tests can assert the wiring directly. */
let observedTargets: Set<Element> = new Set();

beforeEach(() => {
  useUiStore.getState().setConciergeComposeH(null);
  const instances: { cb: () => void; targets: Set<Element> }[] = [];
  observedTargets = new Set();
  fireResize = (el: Element) =>
    act(() => instances.forEach((i) => i.targets.has(el) && i.cb()));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private targets = new Set<Element>();
      constructor(cb: () => void) {
        instances.push({ cb, targets: this.targets });
      }
      observe(el: Element) {
        this.targets.add(el);
        observedTargets.add(el);
      }
      unobserve(el: Element) {
        this.targets.delete(el);
        observedTargets.delete(el);
      }
      disconnect() {
        this.targets.clear();
      }
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const box = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
const handle = () => screen.getByTestId("concierge-compose-handle");
const px = (v: string) => parseFloat(v);


/** A column shaped like the real one: the thread is `flex: 1`, so it gets whatever the compose box
 *  does not. `columnH` is the space those two SHARE (the section minus its fixed header), and the
 *  coupling is what makes the pool constant as the box grows — model it as a fixed thread height
 *  and the pool inflates with every drag, which no real layout does. */
function renderColumn({ columnH, chrome }: { columnH: number; chrome: number }) {
  const state = { columnH };
  const view = render(
    <section aria-label="Sparkle concierge">
      <div data-testid={CONCIERGE_THREAD_TESTID} />
      <ComposeBox onSend={vi.fn()} onAttach={vi.fn()} />
    </section>,
  );
  const thread = view.container.querySelector<HTMLElement>(
    `[data-testid="${CONCIERGE_THREAD_TESTID}"]`,
  )!;
  const root = box().closest("div[data-testid='concierge-compose']") as HTMLElement;
  const textareaH = () => px(box().style.height || "0");
  // The root is the textarea PLUS the attach row, chips, interim line and handle.
  Object.defineProperty(root, "offsetHeight", {
    configurable: true,
    get: () => textareaH() + chrome,
  });
  Object.defineProperty(box(), "offsetHeight", { configurable: true, get: textareaH });
  Object.defineProperty(thread, "clientHeight", {
    configurable: true,
    get: () => Math.max(0, state.columnH - (textareaH() + chrome)),
  });
  return { thread, root, state, textareaH };
}

describe("the drag ceiling is measured, not assumed", () => {
  it("clamps to the THREAD+BOX pool, not to window.innerHeight", () => {
    // A small thread in a tall window: window-sizing would allow a far taller box.
    window.innerHeight = 2000;
    const { root } = renderColumn({ columnH: 500, chrome: 60 });
    fireResize(root);

    fireEvent.pointerDown(handle(), { clientY: 1000, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientY: -5000, pointerId: 1 }); // greedy drag upward
    const h = px(box().style.height);

    // pool = thread(300) + textarea(resting) ; ceiling = pool - MIN_THREAD_H
    expect(h).toBeLessThan(window.innerHeight - COMPOSE_MIN_THREAD_H);
  });

  it("leaves the thread its floor once the box's OWN chrome is accounted for", () => {
    // The unit mismatch: the ceiling is spent on the textarea, but the root carries ~60px more.
    // Measuring the pool in root units and spending it in textarea units quietly hands the thread
    // that much less than COMPOSE_MIN_THREAD_H promises.
    window.innerHeight = 2000;
    const CHROME = 60;
    const { root, textareaH } = renderColumn({ columnH: 700, chrome: CHROME });
    fireResize(root);

    fireEvent.pointerDown(handle(), { clientY: 1000, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientY: -5000, pointerId: 1 });

    // The pool is (column - chrome), constant as the box grows; the thread keeps its floor OUT OF
    // THAT POOL, which is only true once the chrome is subtracted.
    const pool = 700 - CHROME;
    expect(pool - textareaH()).toBeGreaterThanOrEqual(COMPOSE_MIN_THREAD_H);
    // And the whole root still fits inside the column.
    expect(root.offsetHeight).toBeLessThanOrEqual(700);
  });

  it("re-measures when the THREAD shrinks under it", () => {
    // A suggestions row mounting shrinks the thread (`flex: 1`). Neither the root nor the section
    // resizes when that happens, so without observing the thread the ceiling stays stale and too
    // large — and the persisted height would reproduce it on every launch.
    window.innerHeight = 2000;
    const { state, root, thread } = renderColumn({ columnH: 1200, chrome: 60 });
    // The wiring itself: if `observe(thread)` is ever dropped, this fails outright rather than
    // being papered over by a stub that fires every callback regardless of target.
    expect(observedTargets.has(thread)).toBe(true);
    fireResize(root);

    fireEvent.pointerDown(handle(), { clientY: 1000, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientY: -5000, pointerId: 1 });
    fireEvent.pointerUp(handle(), { clientY: -5000, pointerId: 1 });
    const tall = px(box().style.height);

    // A suggestions row mounts and takes 700px of the column away from the thread.
    state.columnH = 500;
    // Driven through the THREAD, because in the real DOM that is the only element that resizes
    // when a suggestions row mounts — neither the root nor the section does.
    fireResize(thread);
    expect(px(box().style.height)).toBeLessThan(tall);
  });

  it("falls back to the window when the thread is not in the DOM", () => {
    // A standalone ComposeBox (as other tests render it) must still work rather than clamp to zero.
    window.innerHeight = 900;
    render(<ComposeBox onSend={vi.fn()} onAttach={vi.fn()} />);
    const root = box().closest("div[data-testid='concierge-compose']") as HTMLElement;
    fireResize(root);
    // DISCRIMINATING: the old assertion (`> 0`) could not fail for any pool, since composeRenderH
    // floors at COMPOSE_MIN_H. Drag greedily and pin the ceiling to the WINDOW, which is what the
    // fallback branch is for — if it stops returning window.innerHeight, this fails.
    fireEvent.pointerDown(handle(), { clientY: 1000, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientY: -9000, pointerId: 1 });
    expect(px(box().style.height)).toBe(900 - COMPOSE_MIN_THREAD_H);
  });
});
