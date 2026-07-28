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

  it("setPending carries capture attachments through untouched", () => {
    const attachments = [{ path: "/tmp/shot.png", dataUrl: "data:image/png;base64,AAAA" }];
    useHandoffStore
      .getState()
      .setPending({ projectId: "p1", text: "look at this", autoSend: false, attachments });
    expect(useHandoffStore.getState().pending?.attachments).toEqual(attachments);
  });

  it("attachments stay optional — existing callers without them still work", () => {
    useHandoffStore.getState().setPending({ projectId: "p1", text: "plain", autoSend: false });
    expect(useHandoffStore.getState().pending?.attachments).toBeUndefined();
  });

});
