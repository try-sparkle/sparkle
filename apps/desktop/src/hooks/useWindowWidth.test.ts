// @vitest-environment jsdom
//
// THE LIVE HALF, which is the entire reason this is a hook rather than a one-time read — and which
// nothing asserted when it shipped (roborev 55869). Every caller's test stubbed `window.innerWidth`
// BEFORE render and never dispatched a `resize`, so replacing the hook body with
// `useState(() => window.innerWidth)` and deleting the effect left all of them green. That is the
// vacuous-test shape AGENTS.md names, and it is exactly what let a stale bound ship unnoticed.
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useWindowWidth } from "./useWindowWidth";

const real = window.innerWidth;
function setWidth(px: number) {
  Object.defineProperty(window, "innerWidth", { value: px, configurable: true });
}
afterEach(() => setWidth(real));

describe("useWindowWidth", () => {
  it("reports the width at mount", () => {
    setWidth(1440);
    expect(renderHook(() => useWindowWidth()).result.current).toBe(1440);
  });

  it("UPDATES on a real resize event — delete the listener and this is the row that reddens", () => {
    setWidth(1440);
    const { result } = renderHook(() => useWindowWidth());
    expect(result.current).toBe(1440);

    act(() => {
      setWidth(900);
      window.dispatchEvent(new Event("resize"));
    });

    // The value FOLLOWED the window. A one-time read would still say 1440 here.
    expect(result.current).toBe(900);
  });

  it("stops listening once unmounted, so a late resize cannot set state on a dead hook", () => {
    setWidth(1440);
    const { result, unmount } = renderHook(() => useWindowWidth());
    unmount();

    act(() => {
      setWidth(600);
      window.dispatchEvent(new Event("resize"));
    });

    // Unchanged, and — the actual point — no "setState on an unmounted component" warning.
    expect(result.current).toBe(1440);
  });
});
