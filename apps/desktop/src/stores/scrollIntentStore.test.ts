import { afterEach, describe, expect, it, vi } from "vitest";
import { useScrollIntentStore, applyScrollIntent } from "./scrollIntentStore";

afterEach(() => useScrollIntentStore.setState({ intents: {} }));

describe("scrollIntentStore", () => {
  it("request then consume returns the promptId once, then null", () => {
    const { request, consume } = useScrollIntentStore.getState();
    request("agent-1", "prompt-9");
    expect(consume("agent-1")).toBe("prompt-9");
    // Consuming clears it — a second consume finds nothing.
    expect(consume("agent-1")).toBeNull();
  });

  it("consume returns null for an agent with no pending intent", () => {
    expect(useScrollIntentStore.getState().consume("nobody")).toBeNull();
  });

  it("the latest request for an agent wins", () => {
    const { request, consume } = useScrollIntentStore.getState();
    request("a", "p1");
    request("a", "p2");
    expect(consume("a")).toBe("p2");
  });

  it("intents are independent per agent", () => {
    const { request, consume } = useScrollIntentStore.getState();
    request("a", "pa");
    request("b", "pb");
    expect(consume("a")).toBe("pa");
    // Consuming a left b untouched.
    expect(consume("b")).toBe("pb");
  });
});

describe("applyScrollIntent", () => {
  const base = () => ({ scrollToPrompt: vi.fn(() => "scrolled" as const), consume: vi.fn() });

  it("skips (no scroll, no consume) until visible AND ready with an intent", () => {
    for (const opts of [
      { intent: undefined, visible: true, ready: true },
      { intent: "p", visible: false, ready: true },
      { intent: "p", visible: true, ready: false },
    ]) {
      const d = base();
      expect(applyScrollIntent({ ...opts, ...d })).toBe("skipped");
      expect(d.scrollToPrompt).not.toHaveBeenCalled();
      expect(d.consume).not.toHaveBeenCalled();
    }
  });

  it("scrolls then consumes once visible + ready", () => {
    const d = base();
    expect(applyScrollIntent({ intent: "p9", visible: true, ready: true, ...d })).toBe("scrolled");
    expect(d.scrollToPrompt).toHaveBeenCalledWith("p9");
    expect(d.consume).toHaveBeenCalledOnce();
  });

  it("treats an absent terminal ref (undefined) as missing, but still consumes", () => {
    const d = { scrollToPrompt: vi.fn(() => undefined), consume: vi.fn() };
    expect(applyScrollIntent({ intent: "p", visible: true, ready: true, ...d })).toBe("missing");
    expect(d.consume).toHaveBeenCalledOnce(); // a missing marker is still "handled" — don't re-fire
  });

  it("returns missing and consumes when the marker is gone", () => {
    const d = { scrollToPrompt: vi.fn(() => "missing" as const), consume: vi.fn() };
    expect(applyScrollIntent({ intent: "p", visible: true, ready: true, ...d })).toBe("missing");
    expect(d.consume).toHaveBeenCalledOnce();
  });
});
