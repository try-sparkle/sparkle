import { describe, it, expect, beforeEach } from "vitest";
import { useDictationStore } from "./dictationStore";

const reset = () =>
  useDictationStore.setState({
    enabled: true,
    phase: "passive",
    insertTarget: null,
  });

describe("dictationStore — ambient fields", () => {
  beforeEach(reset);

  it("defaults: enabled true, phase passive", () => {
    const s = useDictationStore.getState();
    expect(s.enabled).toBe(true);
    expect(s.phase).toBe("passive");
  });

  it("togglePhase flips passive↔active", () => {
    useDictationStore.getState().togglePhase();
    expect(useDictationStore.getState().phase).toBe("active");
    useDictationStore.getState().togglePhase();
    expect(useDictationStore.getState().phase).toBe("passive");
  });

  it("insert() routes to the registered target", () => {
    const seen: string[] = [];
    useDictationStore.getState().registerInsert((t) => seen.push(t));
    useDictationStore.getState().insert("hello world");
    expect(seen).toEqual(["hello world"]);
  });

  it("insert() is a no-op when no target is registered", () => {
    expect(() => useDictationStore.getState().insert("x")).not.toThrow();
  });

  it("setEnabled toggles the enabled flag", () => {
    useDictationStore.getState().setEnabled(false);
    expect(useDictationStore.getState().enabled).toBe(false);
    useDictationStore.getState().setEnabled(true);
    expect(useDictationStore.getState().enabled).toBe(true);
  });

  it("setPhase sets the phase directly", () => {
    useDictationStore.getState().setPhase("active");
    expect(useDictationStore.getState().phase).toBe("active");
    useDictationStore.getState().setPhase("passive");
    expect(useDictationStore.getState().phase).toBe("passive");
  });

  it("registerInsert(null) deregisters — insert() no longer calls old fn", () => {
    const seen: string[] = [];
    useDictationStore.getState().registerInsert((t) => seen.push(t));
    useDictationStore.getState().registerInsert(null);
    useDictationStore.getState().insert("should not appear");
    expect(seen).toEqual([]);
  });
});
