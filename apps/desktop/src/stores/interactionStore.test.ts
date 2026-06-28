import { describe, it, expect, beforeEach } from "vitest";
import {
  shouldRecordTouch,
  useInteractionStore,
  TOUCH_THROTTLE_MS,
} from "./interactionStore";

describe("shouldRecordTouch", () => {
  it("records the first touch (no prior timestamp)", () => {
    expect(shouldRecordTouch(undefined, 1000)).toBe(true);
  });

  it("skips a touch within the throttle window", () => {
    expect(shouldRecordTouch(1000, 1000 + TOUCH_THROTTLE_MS - 1)).toBe(false);
  });

  it("records once the throttle window has elapsed", () => {
    expect(shouldRecordTouch(1000, 1000 + TOUCH_THROTTLE_MS)).toBe(true);
  });
});

describe("useInteractionStore.touch", () => {
  beforeEach(() => useInteractionStore.setState({ lastAt: {} }));

  it("stores the timestamp per agent on first interaction", () => {
    useInteractionStore.getState().touch("a", 5000);
    expect(useInteractionStore.getState().lastAt.a).toBe(5000);
  });

  it("collapses a rapid keystroke storm into a single write, then advances after the window", () => {
    const t = useInteractionStore.getState().touch;
    t("a", 5000); // first keystroke after idle → recorded
    t("a", 5100); // within window → skipped
    t("a", 5300); // within window → skipped
    expect(useInteractionStore.getState().lastAt.a).toBe(5000);
    t("a", 5000 + TOUCH_THROTTLE_MS); // window elapsed → recorded
    expect(useInteractionStore.getState().lastAt.a).toBe(5000 + TOUCH_THROTTLE_MS);
  });

  it("tracks agents independently", () => {
    useInteractionStore.getState().touch("a", 5000);
    useInteractionStore.getState().touch("b", 6000);
    expect(useInteractionStore.getState().lastAt).toEqual({ a: 5000, b: 6000 });
  });
});
