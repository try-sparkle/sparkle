import { describe, it, expect, beforeEach } from "vitest";
import { useHandoffStore } from "./handoffStore";

describe("handoffStore", () => {
  beforeEach(() => useHandoffStore.setState({ pending: null }));

  it("starts empty", () => {
    expect(useHandoffStore.getState().pending).toBeNull();
  });

  it("setPending stores the handoff and clear resets it", () => {
    useHandoffStore.getState().setPending({ projectId: "p1", text: "hello", autoSend: true });
    expect(useHandoffStore.getState().pending).toEqual({
      projectId: "p1",
      text: "hello",
      autoSend: true,
    });
    useHandoffStore.getState().clear();
    expect(useHandoffStore.getState().pending).toBeNull();
  });
});
