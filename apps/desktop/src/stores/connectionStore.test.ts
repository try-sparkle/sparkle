import { describe, it, expect, beforeEach } from "vitest";
import { useConnectionStore } from "./connectionStore";

// Pure derivation store: isOnline = browser-online AND last-probe-ok. No persistence,
// so we just reset to a known-good (online) baseline before each case.
beforeEach(() => {
  useConnectionStore.setState({
    browserOnline: true,
    probeOk: true,
    isOnline: true,
    lastChecked: null,
  });
});

describe("connectionStore", () => {
  it("is online when the browser is online and the probe succeeds", () => {
    useConnectionStore.getState().setBrowserOnline(true);
    useConnectionStore.getState().applyProbe(true, 1000);
    expect(useConnectionStore.getState().isOnline).toBe(true);
  });

  it("is offline when the browser reports offline, even if the last probe succeeded", () => {
    useConnectionStore.getState().applyProbe(true, 1000);
    useConnectionStore.getState().setBrowserOnline(false);
    expect(useConnectionStore.getState().isOnline).toBe(false);
  });

  it("is offline when the probe fails though the browser thinks it is online (dead internet)", () => {
    useConnectionStore.getState().setBrowserOnline(true);
    useConnectionStore.getState().applyProbe(false, 2000);
    expect(useConnectionStore.getState().isOnline).toBe(false);
  });

  it("records the time of the most recent probe", () => {
    useConnectionStore.getState().applyProbe(false, 4242);
    expect(useConnectionStore.getState().lastChecked).toBe(4242);
  });

  it("recovers to online when a later probe succeeds", () => {
    useConnectionStore.getState().applyProbe(false, 1);
    expect(useConnectionStore.getState().isOnline).toBe(false);
    useConnectionStore.getState().applyProbe(true, 2);
    expect(useConnectionStore.getState().isOnline).toBe(true);
  });
});
