import { describe, it, expect, beforeEach, vi } from "vitest";

const invoke = vi.fn((..._a: unknown[]) => Promise.resolve());
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { pauseActiveDictation, maybePauseOnSubmit } from "./dictationControls";
import { useDictationStore } from "../stores/dictationStore";
import { useSettingsStore } from "../stores/settingsStore";

beforeEach(() => {
  invoke.mockClear();
  useDictationStore.setState({ phase: "passive", interim: "" });
  useSettingsStore.setState({ pauseOnSubmit: true });
});

describe("pauseActiveDictation", () => {
  it("drops active → passive, clears interim, and closes the cloud stream", () => {
    useDictationStore.setState({ phase: "active", interim: "half a sentence" });
    pauseActiveDictation();
    expect(useDictationStore.getState().phase).toBe("passive");
    expect(useDictationStore.getState().interim).toBe("");
    expect(invoke).toHaveBeenCalledWith("stop_cloud_stream");
  });

  it("is a no-op when already passive (no phase change, no stream close)", () => {
    useDictationStore.setState({ phase: "passive" });
    pauseActiveDictation();
    expect(useDictationStore.getState().phase).toBe("passive");
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("maybePauseOnSubmit", () => {
  it("pauses when pauseOnSubmit is true and phase is active", () => {
    useSettingsStore.setState({ pauseOnSubmit: true });
    useDictationStore.setState({ phase: "active" });
    maybePauseOnSubmit();
    expect(useDictationStore.getState().phase).toBe("passive");
    expect(invoke).toHaveBeenCalledWith("stop_cloud_stream");
  });

  it("does NOT pause when pauseOnSubmit is false (keep listening)", () => {
    useSettingsStore.setState({ pauseOnSubmit: false });
    useDictationStore.setState({ phase: "active" });
    maybePauseOnSubmit();
    expect(useDictationStore.getState().phase).toBe("active");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("is a no-op when passive even if pauseOnSubmit is true", () => {
    useSettingsStore.setState({ pauseOnSubmit: true });
    useDictationStore.setState({ phase: "passive" });
    maybePauseOnSubmit();
    expect(useDictationStore.getState().phase).toBe("passive");
    expect(invoke).not.toHaveBeenCalled();
  });
});
