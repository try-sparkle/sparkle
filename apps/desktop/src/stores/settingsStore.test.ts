import { describe, it, expect, beforeEach } from "vitest";
import {
  effectiveChiefPat,
  aiFeatureMode,
  migrateSettings,
  useSettingsStore,
  type AiFeatureFlags,
} from "./settingsStore";

describe("effectiveChiefPat — PAT resolution order", () => {
  it("prefers a user-entered (stored) PAT, trimmed", () => {
    expect(effectiveChiefPat("  pat_user  ", "pat_runtime")).toBe("pat_user");
  });

  it("falls back to the runtime env-resolved PAT when nothing is stored", () => {
    expect(effectiveChiefPat("", "pat_runtime")).toBe("pat_runtime");
    expect(effectiveChiefPat("   ", "pat_runtime")).toBe("pat_runtime");
  });

  it("is empty when neither a stored nor a runtime PAT exists (no build-env token in tests)", () => {
    expect(effectiveChiefPat("", "")).toBe("");
    expect(effectiveChiefPat("")).toBe("");
  });
});

describe("maxConcurrentWorkers", () => {
  beforeEach(() => useSettingsStore.setState({ maxConcurrentWorkers: 4 }));
  it("defaults to 4", () => {
    expect(useSettingsStore.getState().maxConcurrentWorkers).toBe(4);
  });
  it("can be set, flooring at 1", () => {
    useSettingsStore.getState().setMaxConcurrentWorkers(8);
    expect(useSettingsStore.getState().maxConcurrentWorkers).toBe(8);
    useSettingsStore.getState().setMaxConcurrentWorkers(0);
    expect(useSettingsStore.getState().maxConcurrentWorkers).toBe(1); // never < 1
  });
});

describe("aiFeatureMode — derived All/Some/Off", () => {
  const flags = (over: Partial<AiFeatureFlags>): AiFeatureFlags => ({
    aiAutoRename: true,
    cloudDictation: true,
    aiBrainstorm: true,
    aiComposer: true,
    ...over,
  });

  it("is 'all' when every feature is on", () => {
    expect(aiFeatureMode(flags({}))).toBe("all");
  });

  it("is 'off' when every feature is off", () => {
    expect(
      aiFeatureMode({ aiAutoRename: false, cloudDictation: false, aiBrainstorm: false, aiComposer: false }),
    ).toBe("off");
  });

  it("is 'some' when any single feature differs (mixed)", () => {
    expect(aiFeatureMode(flags({ aiComposer: false }))).toBe("some");
    expect(aiFeatureMode(flags({ cloudDictation: false }))).toBe("some");
    expect(
      aiFeatureMode({ aiAutoRename: true, cloudDictation: false, aiBrainstorm: false, aiComposer: false }),
    ).toBe("some");
  });
});

describe("migrateSettings — v0→v1 preserves a prior AI opt-out", () => {
  it("maps a stored aiEnabled:false to all four feature flags off (no silent re-arm)", () => {
    const out = migrateSettings({ aiEnabled: false, chiefPat: "x" }, 0) as Record<string, unknown>;
    expect(out.aiAutoRename).toBe(false);
    expect(out.cloudDictation).toBe(false);
    expect(out.aiBrainstorm).toBe(false);
    expect(out.aiComposer).toBe(false);
    expect(out.chiefPat).toBe("x"); // other persisted fields preserved
  });
  it("leaves aiEnabled:true / absent alone (on-by-default values win)", () => {
    expect(migrateSettings({ aiEnabled: true }, 0)).toEqual({ aiEnabled: true });
    expect(migrateSettings({ chiefPat: "x" }, 0)).toEqual({ chiefPat: "x" });
  });
  it("is a no-op at the current version", () => {
    const blob = { aiEnabled: false };
    expect(migrateSettings(blob, 1)).toBe(blob);
  });
});

describe("settingsStore — AI feature setters", () => {
  beforeEach(() => {
    useSettingsStore.getState().setAllAiFeatures(true);
  });

  it("setAllAiFeatures(true) makes the mode 'all'; (false) makes it 'off'", () => {
    useSettingsStore.getState().setAllAiFeatures(true);
    expect(aiFeatureMode(useSettingsStore.getState())).toBe("all");
    useSettingsStore.getState().setAllAiFeatures(false);
    expect(aiFeatureMode(useSettingsStore.getState())).toBe("off");
    const s = useSettingsStore.getState();
    expect([s.aiAutoRename, s.cloudDictation, s.aiBrainstorm, s.aiComposer]).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it("unchecking one feature from 'all' drops the derived mode to 'some'", () => {
    useSettingsStore.getState().setAllAiFeatures(true);
    useSettingsStore.getState().setAiFeature("composer", false);
    expect(useSettingsStore.getState().aiComposer).toBe(false);
    expect(aiFeatureMode(useSettingsStore.getState())).toBe("some");
  });

  it("setAiFeature maps each menu key to its store field", () => {
    useSettingsStore.getState().setAllAiFeatures(false);
    useSettingsStore.getState().setAiFeature("autoRename", true);
    useSettingsStore.getState().setAiFeature("voiceDictation", true);
    useSettingsStore.getState().setAiFeature("brainstorm", true);
    useSettingsStore.getState().setAiFeature("composer", true);
    const s = useSettingsStore.getState();
    expect([s.aiAutoRename, s.cloudDictation, s.aiBrainstorm, s.aiComposer]).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(aiFeatureMode(s)).toBe("all");
  });
});

describe("settingsStore — Chief doc state", () => {
  beforeEach(() => {
    useSettingsStore.setState({ chiefDocStateByProject: {} });
  });

  it("setChiefProjectDocState replaces the per-project doc-state map", () => {
    const store = useSettingsStore;
    store.getState().setChiefProjectDocState("project_x", {
      "PRD/a.md": { hash: "h1", assetId: "asset_1" },
    });
    expect(store.getState().chiefDocStateByProject["project_x"]).toEqual({
      "PRD/a.md": { hash: "h1", assetId: "asset_1" },
    });
    // Replace (not merge): the old path is gone.
    store.getState().setChiefProjectDocState("project_x", {
      "PRD/b.md": { hash: "h2", assetId: "asset_2" },
    });
    expect(store.getState().chiefDocStateByProject["project_x"]).toEqual({
      "PRD/b.md": { hash: "h2", assetId: "asset_2" },
    });
  });

  it("clearChiefDocState drops the per-project map", () => {
    const store = useSettingsStore;
    store.getState().setChiefProjectDocState("project_y", { "PRD/a.md": { hash: "h", assetId: "a" } });
    store.getState().clearChiefDocState("project_y");
    expect(store.getState().chiefDocStateByProject["project_y"]).toBeUndefined();
  });
});
