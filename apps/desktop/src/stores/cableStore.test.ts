import { beforeEach, describe, expect, it } from "vitest";
import { resetCable, useCableStore } from "./cableStore";

beforeEach(() => resetCable());

describe("cableStore", () => {
  it("rests unplugged and docked", () => {
    expect(useCableStore.getState().wired).toBe("off");
    expect(useCableStore.getState().overlay).toBe("off");
  });

  it("patches, and patching again moves the one live circuit", () => {
    useCableStore.getState().patch("left", null);
    expect(useCableStore.getState().wired).toBe("left");
    useCableStore.getState().patch("right", null);
    expect(useCableStore.getState().wired).toBe("right");
  });

  it("unbinds back to floating middle", () => {
    useCableStore.getState().patch("right", null);
    useCableStore.getState().unbind();
    expect(useCableStore.getState().wired).toBe("off");
  });

  it("docks a floating concierge when the cable is patched", () => {
    useCableStore.getState().overlayTo("assist");
    useCableStore.getState().patch("left", null);
    expect(useCableStore.getState().overlay).toBe("off");
    expect(useCableStore.getState().wired).toBe("left");
  });

  it("unbinds when the concierge floats", () => {
    useCableStore.getState().patch("left", null);
    useCableStore.getState().overlayTo("assist");
    expect(useCableStore.getState().wired).toBe("off");
  });

  // ── THE PINNED FAR END (roborev 63145, finding 4) ──────────────────────────────────────────────
  // The agent the concierge is talking to is recorded AT MOUNT TIME rather than re-derived from the
  // selection on every render. Without the pin the live cable followed whatever row was clicked
  // last, so looking at an agent silently changed who you were talking to.
  it("pins the agent the mount named", () => {
    useCableStore.getState().patch("right", "a1");
    expect(useCableStore.getState().agentId).toBe("a1");
  });

  it("re-aims onto a NEW agent on the same side", () => {
    // The no-op guard compares the agent too. Comparing only the side would swallow this — the
    // mount gesture would look inert while the concierge kept talking to the previous row, which is
    // the same class of silent mis-routing the pin exists to remove.
    useCableStore.getState().patch("right", "a1");
    useCableStore.getState().patch("right", "a2");
    expect(useCableStore.getState().agentId).toBe("a2");
  });

  it("drops the pin on unbind — a far end never outlives its cable", () => {
    useCableStore.getState().patch("right", "a1");
    useCableStore.getState().unbind();
    expect(useCableStore.getState().agentId).toBeNull();
  });

  it("drops the pin when the concierge floats, which is the other way to unwire", () => {
    // `overlayTo("assist")` unwires, so it has to clear the pin by the same rule. Covered
    // separately because it is a SECOND path to `wired: "off"` — one clearing and the other not is
    // exactly how a state nothing on screen claims comes to exist.
    useCableStore.getState().patch("left", "a1");
    useCableStore.getState().overlayTo("assist");
    expect(useCableStore.getState().wired).toBe("off");
    expect(useCableStore.getState().agentId).toBeNull();
  });

  // The reducers return the same object for a no-op, so an inert gesture must not notify. Without
  // that, the click-away handler would re-render the whole shell on every stray click.
  it("does not notify subscribers on an inert unbind", () => {
    let notified = 0;
    const stop = useCableStore.subscribe(() => notified++);
    useCableStore.getState().unbind();
    useCableStore.getState().unbind();
    stop();
    expect(notified).toBe(0);
  });
});
