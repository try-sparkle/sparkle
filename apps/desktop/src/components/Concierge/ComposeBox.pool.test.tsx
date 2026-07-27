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

/** Fire every live ResizeObserver callback — jsdom never will. Wrapped in `act` because the
 *  callback sets state, and an unflushed render would make the assertions read the OLD height. */
let fireResize: () => void = () => {};

beforeEach(() => {
  useUiStore.getState().setConciergeComposeH(null);
  const callbacks: (() => void)[] = [];
  fireResize = () => act(() => callbacks.forEach((cb) => cb()));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: () => void) {
        callbacks.push(cb);
      }
      observe() {}
      disconnect() {}
      unobserve() {}
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

/** Give an element the laid-out sizes jsdom refuses to compute. */
function stubSize(el: HTMLElement, o: { client?: number; offset?: number }) {
  if (o.client != null) {
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => o.client });
  }
  if (o.offset != null) {
    Object.defineProperty(el, "offsetHeight", { configurable: true, get: () => o.offset });
  }
}

/** A column shaped like the real one: the thread is `flex: 1`, so it gets whatever the compose box
 *  does not. `columnH` is the space those two SHARE (the section minus its fixed header), and the
 *  coupling is what makes the pool constant as the box grows — model it as a fixed thread height
 *  and the pool inflates with every drag, which no real layout does. */
function renderColumn({ columnH, chrome }: { columnH: number; chrome: number }) {
  const state = { columnH };
  const view = render(
    <section aria-label="Sparkle concierge">
      <div data-testid={CONCIERGE_THREAD_TESTID} />
      <ComposeBox onSend={vi.fn()} onMicToggle={vi.fn()} onAttach={vi.fn()} />
    </section>,
  );
  const thread = view.container.querySelector<HTMLElement>(
    `[data-testid="${CONCIERGE_THREAD_TESTID}"]`,
  )!;
  const root = box().closest("div[data-dnd-target]") as HTMLElement;
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
    renderColumn({ columnH: 500, chrome: 60 });
    fireResize();

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
    fireResize();

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
    const { state } = renderColumn({ columnH: 1200, chrome: 60 });
    fireResize();

    fireEvent.pointerDown(handle(), { clientY: 1000, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientY: -5000, pointerId: 1 });
    fireEvent.pointerUp(handle(), { clientY: -5000, pointerId: 1 });
    const tall = px(box().style.height);

    // A suggestions row mounts and takes 700px of the column away from the thread.
    state.columnH = 500;
    fireResize();
    expect(px(box().style.height)).toBeLessThan(tall);
  });

  it("falls back to the window when the thread is not in the DOM", () => {
    // A standalone ComposeBox (as other tests render it) must still work rather than clamp to zero.
    window.innerHeight = 900;
    render(<ComposeBox onSend={vi.fn()} onMicToggle={vi.fn()} onAttach={vi.fn()} />);
    fireResize();
    expect(px(box().style.height)).toBeGreaterThan(0);
  });
});
