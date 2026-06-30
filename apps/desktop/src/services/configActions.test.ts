// @vitest-environment jsdom
//
// Tests for the config write-back actions: each optimistically updates the store AND persists to
// config.toml via the (mocked) config service. The bulk path must use a SINGLE atomic write.
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Tauri-backed config service so no IPC is attempted under jsdom.
vi.mock("./config", () => ({
  setConfigValue: vi.fn().mockResolvedValue(undefined),
  setConfigValues: vi.fn().mockResolvedValue(undefined),
}));

import { setConfigValue, setConfigValues } from "./config";
import { setAiFeature, setAllAiFeatures, setMaxConcurrentWorkers } from "./configActions";
import { useSettingsStore } from "../stores/settingsStore";

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.getState().setAllAiFeatures(true);
  useSettingsStore.getState().setMaxConcurrentWorkers(20);
});

describe("configActions", () => {
  it("setAiFeature optimistically updates the store and writes the dotted path", async () => {
    await setAiFeature("composer", false);
    expect(useSettingsStore.getState().aiComposer).toBe(false);
    expect(setConfigValue).toHaveBeenCalledWith("ai.composer", false);
  });

  it("setAllAiFeatures updates all flags and writes them in ONE atomic call", async () => {
    await setAllAiFeatures(false);
    const s = useSettingsStore.getState();
    expect([s.aiAutoRename, s.cloudDictation, s.aiBrainstorm, s.aiComposer]).toEqual([
      false,
      false,
      false,
      false,
    ]);
    // A single batched write — not four separate ones (the anti-flicker fix).
    expect(setConfigValues).toHaveBeenCalledTimes(1);
    expect(setConfigValue).not.toHaveBeenCalled();
    expect(setConfigValues).toHaveBeenCalledWith({
      "ai.auto_rename": false,
      "ai.voice_dictation": false,
      "ai.brainstorm": false,
      "ai.composer": false,
    });
  });

  it("setMaxConcurrentWorkers clamps to >= 1 in both the store and the write", async () => {
    await setMaxConcurrentWorkers(0);
    expect(useSettingsStore.getState().maxConcurrentWorkers).toBe(1);
    expect(setConfigValue).toHaveBeenCalledWith("workers.max_concurrent", 1);
  });

  it("a write failure is swallowed but the optimistic store update stays", async () => {
    (setConfigValue as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("no ipc"));
    await setAiFeature("brainstorm", false);
    expect(useSettingsStore.getState().aiBrainstorm).toBe(false);
  });

  it("a bulk write failure is swallowed but all optimistic flags stay", async () => {
    (setConfigValues as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("no ipc"));
    await setAllAiFeatures(false);
    const s = useSettingsStore.getState();
    expect([s.aiAutoRename, s.cloudDictation, s.aiBrainstorm, s.aiComposer]).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });
});
