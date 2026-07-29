import { beforeEach, describe, expect, it } from "vitest";
import { resetCable, useCableStore } from "./cableStore";

beforeEach(() => resetCable());

describe("cableStore", () => {
  it("rests unplugged and docked", () => {
    expect(useCableStore.getState().wired).toBe("off");
    expect(useCableStore.getState().overlay).toBe("off");
  });

  it("patches, and patching again moves the one live circuit", () => {
    useCableStore.getState().patch("left");
    expect(useCableStore.getState().wired).toBe("left");
    useCableStore.getState().patch("right");
    expect(useCableStore.getState().wired).toBe("right");
  });

  it("unbinds back to floating middle", () => {
    useCableStore.getState().patch("right");
    useCableStore.getState().unbind();
    expect(useCableStore.getState().wired).toBe("off");
  });

  it("docks a floating concierge when the cable is patched", () => {
    useCableStore.getState().overlayTo("assist");
    useCableStore.getState().patch("left");
    expect(useCableStore.getState().overlay).toBe("off");
    expect(useCableStore.getState().wired).toBe("left");
  });

  it("unbinds when the concierge floats", () => {
    useCableStore.getState().patch("left");
    useCableStore.getState().overlayTo("assist");
    expect(useCableStore.getState().wired).toBe("off");
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
