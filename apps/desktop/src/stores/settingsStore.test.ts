import { describe, it, expect, beforeEach } from "vitest";
import {
  effectiveChiefPat,
  aiFeatureMode,
  migrateSettings,
  useSettingsStore,
  AI_FEATURE_FIELD,
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
  beforeEach(() => useSettingsStore.setState({ maxConcurrentWorkers: 20 }));
  it("defaults to 20", () => {
    expect(useSettingsStore.getState().maxConcurrentWorkers).toBe(20);
  });
  it("can be set, flooring at 1", () => {
    useSettingsStore.getState().setMaxConcurrentWorkers(8);
    expect(useSettingsStore.getState().maxConcurrentWorkers).toBe(8);
    useSettingsStore.getState().setMaxConcurrentWorkers(0);
    expect(useSettingsStore.getState().maxConcurrentWorkers).toBe(1); // never < 1
  });
  it("has no upper cap (unbounded above)", () => {
    useSettingsStore.getState().setMaxConcurrentWorkers(999);
    expect(useSettingsStore.getState().maxConcurrentWorkers).toBe(999);
  });
});

describe("aiFeatureMode — derived All/Some/Off", () => {
  const flags = (over: Partial<AiFeatureFlags>): AiFeatureFlags => ({
    aiAutoRename: true,
    cloudDictation: true,
    aiBrainstorm: true,
    aiComposer: true,
    aiSuggestedActions: true,
    ...over,
  });

  it("is 'all' when every feature is on", () => {
    expect(aiFeatureMode(flags({}))).toBe("all");
  });

  it("is 'off' when every feature is off", () => {
    expect(
      aiFeatureMode({
        aiAutoRename: false,
        cloudDictation: false,
        aiBrainstorm: false,
        aiComposer: false,
        aiSuggestedActions: false,
      }),
    ).toBe("off");
  });

  it("is 'some' when any single feature differs (mixed)", () => {
    expect(aiFeatureMode(flags({ aiComposer: false }))).toBe("some");
    expect(aiFeatureMode(flags({ cloudDictation: false }))).toBe("some");
    expect(
      aiFeatureMode({
        aiAutoRename: true,
        cloudDictation: false,
        aiBrainstorm: false,
        aiComposer: false,
        aiSuggestedActions: false,
      }),
    ).toBe("some");
  });
});

describe("suggestedActions AI flag", () => {
  const allOn: AiFeatureFlags = {
    aiAutoRename: true,
    cloudDictation: true,
    aiBrainstorm: true,
    aiComposer: true,
    aiSuggestedActions: true,
  };

  it("maps the menu key to its store field", () => {
    expect(AI_FEATURE_FIELD.suggestedActions).toBe("aiSuggestedActions");
  });
  it("counts toward the All/Some/Off master", () => {
    expect(aiFeatureMode(allOn)).toBe("all");
    expect(aiFeatureMode({ ...allOn, aiSuggestedActions: false })).toBe("some");
  });
});

describe("migrateSettings — v0→v1 AI opt-out + v1→v2 autoApplyUpdates default", () => {
  it("maps a stored aiEnabled:false to all four feature flags off (no silent re-arm)", () => {
    const out = migrateSettings({ aiEnabled: false, chiefPat: "x" }, 0) as Record<string, unknown>;
    expect(out.aiAutoRename).toBe(false);
    expect(out.cloudDictation).toBe(false);
    expect(out.aiBrainstorm).toBe(false);
    expect(out.aiComposer).toBe(false);
    expect(out.chiefPat).toBe("x"); // other persisted fields preserved
  });
  it("leaves aiEnabled:true / absent alone, but seeds autoApplyUpdates:true (v1→v2)", () => {
    // From a pre-v2 store (version 0), the autoApplyUpdates default is added on upgrade.
    expect(migrateSettings({ aiEnabled: true }, 0)).toEqual({
      aiEnabled: true,
      autoApplyUpdates: true,
    });
    expect(migrateSettings({ chiefPat: "x" }, 0)).toEqual({
      chiefPat: "x",
      autoApplyUpdates: true,
    });
  });
  it("does not clobber an existing autoApplyUpdates value on migration", () => {
    expect(migrateSettings({ autoApplyUpdates: false }, 1)).toEqual({ autoApplyUpdates: false });
  });
  it("is a no-op at the current version", () => {
    const blob = { aiEnabled: false, autoApplyUpdates: true };
    expect(migrateSettings(blob, 2)).toBe(blob);
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
    useSettingsStore.getState().setAiFeature("suggestedActions", true);
    const s = useSettingsStore.getState();
    expect([
      s.aiAutoRename,
      s.cloudDictation,
      s.aiBrainstorm,
      s.aiComposer,
      s.aiSuggestedActions,
    ]).toEqual([true, true, true, true, true]);
    expect(aiFeatureMode(s)).toBe("all");
  });
});

describe("settingsStore — Sparkle improvement consent", () => {
  it("defaults to case_by_case (privacy-conservative: per-PR approval)", () => {
    // The live store default — what a fresh install gets before any user choice.
    expect(useSettingsStore.getInitialState().sparkleImprovementConsent).toBe("case_by_case");
  });

  it("setSparkleImprovementConsent updates the mode through all three values", () => {
    useSettingsStore.getState().setSparkleImprovementConsent("always");
    expect(useSettingsStore.getState().sparkleImprovementConsent).toBe("always");
    useSettingsStore.getState().setSparkleImprovementConsent("never");
    expect(useSettingsStore.getState().sparkleImprovementConsent).toBe("never");
    useSettingsStore.getState().setSparkleImprovementConsent("case_by_case");
    expect(useSettingsStore.getState().sparkleImprovementConsent).toBe("case_by_case");
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

describe("hydrateFromConfig — reflect config.toml into the store", () => {
  it("maps every effective-config field into the store and clamps max workers", () => {
    useSettingsStore.getState().hydrateFromConfig({
      config: {
        workflow: {
          require_pr: false,
          worktree_isolation: false,
          default_branch: "develop",
          born_fresh_from_base: false,
          delete_merged_branch: false,
          drift: { behind_nudge: 3, ahead_nudge: 4, changed_lines: 5 },
        },
        workers: { max_concurrent: 0 }, // out of range → clamped to 1
        ai: {
          auto_rename: false,
          voice_dictation: false,
          brainstorm: false,
          composer: true,
          suggested_actions: true,
        },
        freshness: {
          staleness_warn_commits: 25,
          stale_build_block_commits: 25,
          require_fresh_branch: true,
        },
      },
      warnings: ["w1", "w2"],
    });
    const s = useSettingsStore.getState();
    expect(s.maxConcurrentWorkers).toBe(1); // Math.max(1, floor(0))
    expect(s.requirePr).toBe(false);
    expect(s.worktreeIsolation).toBe(false);
    expect(s.defaultBranch).toBe("develop");
    expect(s.bornFreshFromBase).toBe(false);
    expect(s.deleteMergedBranch).toBe(false);
    expect(s.driftBehindNudge).toBe(3);
    expect(s.driftAheadNudge).toBe(4);
    expect(s.driftChangedLines).toBe(5);
    expect([s.aiAutoRename, s.cloudDictation, s.aiBrainstorm, s.aiComposer]).toEqual([
      false,
      false,
      false,
      true,
    ]);
    expect(s.configWarnings).toEqual(["w1", "w2"]);
  });
});
