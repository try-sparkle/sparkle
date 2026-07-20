import { describe, it, expect, beforeEach } from "vitest";
import { useDictationStore, DICTATION_PERSIST_KEY } from "./dictationStore";

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

  it("persists phase to the shared blob so active/paused carries across windows", () => {
    // The active/paused status the user selects must survive cross-window rehydration, exactly like
    // `enabled` (on/off) already does. That means `phase` must land in the persisted localStorage
    // blob (partialize), not stay window-local runtime state.
    useDictationStore.getState().setPhase("active");
    const raw = localStorage.getItem(DICTATION_PERSIST_KEY);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).state.phase).toBe("active");

    useDictationStore.getState().setPhase("passive");
    expect(JSON.parse(localStorage.getItem(DICTATION_PERSIST_KEY)!).state.phase).toBe("passive");
  });

  it("registerInsert(null) deregisters — insert() no longer calls old fn", () => {
    const seen: string[] = [];
    useDictationStore.getState().registerInsert((t) => seen.push(t));
    useDictationStore.getState().registerInsert(null);
    useDictationStore.getState().insert("should not appear");
    expect(seen).toEqual([]);
  });
});
