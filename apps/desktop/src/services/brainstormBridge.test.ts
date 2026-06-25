import { describe, it, expect, afterEach, vi } from "vitest";
import { registerBrainstorm, sendToBrainstorm } from "./brainstormBridge";

// The bridge lets the connectivity re-query reach a Brainstorm agent whose chat state
// lives inside its (mounted) React panel. Panels register a handler keyed by agent id.
// The module's handler map is global, so each test registers through `track()` and we
// genuinely unregister everything afterward — real isolation, not unique-id luck.
describe("brainstormBridge", () => {
  const cleanups: Array<() => void> = [];
  const track = (off: () => void) => {
    cleanups.push(off);
    return off;
  };
  afterEach(() => {
    for (const off of cleanups) off();
    cleanups.length = 0;
  });

  it("delivers text to a registered handler and reports success", () => {
    const fn = vi.fn();
    track(registerBrainstorm("a1", fn));
    const ok = sendToBrainstorm("a1", "hi");
    expect(ok).toBe(true);
    expect(fn).toHaveBeenCalledWith("hi");
  });

  it("reports failure when no handler is registered for the agent", () => {
    expect(sendToBrainstorm("missing", "hi")).toBe(false);
  });

  it("stops delivering after the handler unregisters", () => {
    const fn = vi.fn();
    const off = track(registerBrainstorm("a2", fn));
    off();
    expect(sendToBrainstorm("a2", "hi")).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it("unregister only removes its own handler, not a newer one for the same id", () => {
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = track(registerBrainstorm("a3", first));
    track(registerBrainstorm("a3", second)); // remount replaced the handler
    offFirst(); // stale cleanup from the old mount must not drop the new handler
    expect(sendToBrainstorm("a3", "yo")).toBe(true);
    expect(second).toHaveBeenCalledWith("yo");
  });
});
