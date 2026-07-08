import { describe, it, expect, vi } from "vitest";
import { handleImproveSparkleClick } from "./sparkleReveal";

describe("handleImproveSparkleClick", () => {
  // Improve Sparkle is per-window now: a click ALWAYS reveals this window's own copy in place,
  // regardless of which window it came from. There is no cross-window focus/broadcast anymore
  // (the old "secondary window focuses main + broadcasts" no-op-bug path is gone).
  it("reveals this window's Sparkle copy in place", () => {
    const activateLocal = vi.fn();
    handleImproveSparkleClick({ activateLocal });
    expect(activateLocal).toHaveBeenCalledTimes(1);
  });
});
