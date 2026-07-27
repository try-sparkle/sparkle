import { describe, it, expect, beforeEach } from "vitest";
import {
  effectiveChiefPat,
  aiFeatureMode,
  migrateSettings,
  useSettingsStore,
  enforcedWorkerCap,
  AI_FEATURE_FIELD,
  type AiFeatureFlags,
} from "./settingsStore";
import type { EffectiveConfig } from "../services/config";

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
    aiComposer: true,
    aiSuggestedActions: true,
    aiAutoApprove: true,
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
        aiComposer: false,
        aiSuggestedActions: false,
        aiAutoApprove: false,
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
        aiComposer: false,
        aiSuggestedActions: false,
        aiAutoApprove: false,
      }),
    ).toBe("some");
  });
});

describe("suggestedActions AI flag", () => {
  const allOn: AiFeatureFlags = {
    aiAutoRename: true,
    cloudDictation: true,
    aiComposer: true,
    aiSuggestedActions: true,
    aiAutoApprove: true,
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
    expect([s.aiAutoRename, s.cloudDictation, s.aiComposer]).toEqual([false, false, false]);
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
    useSettingsStore.getState().setAiFeature("composer", true);
    useSettingsStore.getState().setAiFeature("suggestedActions", true);
    useSettingsStore.getState().setAiFeature("autoApprove", true);
    const s = useSettingsStore.getState();
    expect([
      s.aiAutoRename,
      s.cloudDictation,
      s.aiComposer,
      s.aiSuggestedActions,
      s.aiAutoApprove,
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

// The concurrency the app ENFORCES (sparkle-01xv / sparkle-asz5). `maxConcurrentWorkers` is what
// the user asked for; `effectiveMaxConcurrentWorkers` is what this machine's RAM can actually hold,
// computed in Rust. Spawning to the former is how 24 agents × ~4 GiB got a Mac jetsam-killed.
describe("effectiveMaxConcurrentWorkers — the RAM-aware enforced cap", () => {
  /** Minimal effective-config payload; only the fields these tests care about vary. */
  const eff = (max_concurrent: number | null, effective_max_concurrent?: number): EffectiveConfig =>
    ({
      config: {
        workflow: {
          require_pr: true,
          worktree_isolation: true,
          default_branch: "main",
          born_fresh_from_base: true,
          delete_merged_branch: true,
          drift: { behind_nudge: 10, ahead_nudge: 15, changed_lines: 1000 },
        },
        workers: { max_concurrent, agent_heap_mb: 3072 },
        ai: {
          auto_rename: true,
          voice_dictation: true,
          composer: true,
          suggested_actions: true,
          auto_approve: true,
        },
        freshness: {
          staleness_warn_commits: 25,
          stale_build_block_commits: 25,
          require_fresh_branch: true,
        },
        capture: { popover_shortcut: "ctrl+shift+r" },
        done: { description: null, criteria: [] },
        delivered: {
          description: null,
          detected_method: null,
          confidence: null,
          confidence_note: null,
          learned: false,
          criteria: [],
        },
      },
      warnings: [],
      effective_max_concurrent,
    }) as EffectiveConfig;

  it("takes the RAM-derived value when it is below what the user configured", () => {
    useSettingsStore.getState().hydrateFromConfig(eff(20, 3));
    const s = useSettingsStore.getState();
    // The slider still shows the user's choice...
    expect(s.maxConcurrentWorkers).toBe(20);
    // ...but the enforced cap is what the machine can hold.
    expect(s.effectiveMaxConcurrentWorkers).toBe(3);
  });

  // AUTO (max_concurrent absent) is the DEFAULT, so this is the path most installs take.
  it("uses the machine-derived value when the user has pinned no ceiling", () => {
    useSettingsStore.getState().hydrateFromConfig(eff(null, 40));
    const s = useSettingsStore.getState();
    expect(s.effectiveMaxConcurrentWorkers).toBe(40);
    // Both fields agree, so enforcedWorkerCap's min() can't clamp against a stale default.
    expect(s.maxConcurrentWorkers).toBe(40);
    expect(enforcedWorkerCap(s)).toBe(40);
  });

  // THE bug this guard exists for: Math.floor(null) is 0, and Math.max(1, 0) is 1 — so an
  // unguarded read would silently throttle every auto-configured install to ONE worker.
  it("does not collapse to a single worker when no ceiling is pinned", () => {
    useSettingsStore.getState().hydrateFromConfig(eff(null, 12));
    const s = useSettingsStore.getState();
    expect(s.effectiveMaxConcurrentWorkers).toBe(12);
    expect(enforcedWorkerCap(s)).toBeGreaterThan(1);
  });

  it("auto still floors at 1 when the backend reports nothing usable", () => {
    useSettingsStore.getState().hydrateFromConfig(eff(null, undefined));
    expect(useSettingsStore.getState().effectiveMaxConcurrentWorkers).toBe(1);
  });

  it("never exceeds the configured ceiling even if the backend reports a larger value", () => {
    // Defense in depth: an explicit max_concurrent is a ceiling, so spare RAM must not raise it.
    useSettingsStore.getState().hydrateFromConfig(eff(4, 40));
    expect(useSettingsStore.getState().effectiveMaxConcurrentWorkers).toBe(4);
  });

  it("falls back to the configured value when the backend omits the field", () => {
    // An older Rust backend predating memory-aware concurrency sends no effective_max_concurrent.
    useSettingsStore.getState().hydrateFromConfig(eff(7, undefined));
    expect(useSettingsStore.getState().effectiveMaxConcurrentWorkers).toBe(7);
  });

  it("floors at 1 so the orchestrator can always make progress", () => {
    useSettingsStore.getState().hydrateFromConfig(eff(20, 0));
    expect(useSettingsStore.getState().effectiveMaxConcurrentWorkers).toBe(1);
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
          composer: true,
          suggested_actions: true,
          auto_approve: true,
        },
        roborev: { consent_prompted: false },
        freshness: {
          staleness_warn_commits: 25,
          stale_build_block_commits: 25,
          require_fresh_branch: true,
        },
        capture: { popover_shortcut: "ctrl+shift+r" },
        voice: { wake_word: "Hey Jarvis", stop_word: "Jarvis, halt", pause_on_submit: false },
        done: { description: null, criteria: [] },
        delivered: {
          description: null,
          detected_method: null,
          confidence: null,
          confidence_note: null,
          learned: false,
          criteria: [],
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
    expect([s.aiAutoRename, s.cloudDictation, s.aiComposer]).toEqual([false, false, true]);
    expect(s.configWarnings).toEqual(["w1", "w2"]);
    // Voice mirror
    expect(s.wakeWord).toBe("Hey Jarvis");
    expect(s.stopWord).toBe("Jarvis, halt");
    expect(s.pauseOnSubmit).toBe(false);
  });

  describe("[plugins] mirror", () => {
    /** A minimal-but-complete effective config, with `plugins` swapped in per case. */
    const eff = (plugins?: { superpowers: boolean; frontend_design: boolean }) =>
      ({
        config: {
          workflow: {
            require_pr: true,
            worktree_isolation: true,
            default_branch: "",
            born_fresh_from_base: true,
            delete_merged_branch: true,
            drift: { behind_nudge: 10, ahead_nudge: 15, changed_lines: 1000 },
          },
          workers: { max_concurrent: 5 },
          ai: {
            auto_rename: true,
            voice_dictation: true,
            composer: true,
            suggested_actions: true,
            auto_approve: true,
          },
          ...(plugins ? { plugins } : {}),
          roborev: { consent_prompted: false },
          freshness: {
            staleness_warn_commits: 25,
            stale_build_block_commits: 25,
            require_fresh_branch: true,
          },
          capture: { popover_shortcut: "ctrl+shift+r" },
          done: { description: null, criteria: [] },
          delivered: {
            description: null,
            detected_method: null,
            confidence: null,
            confidence_note: null,
            learned: false,
            criteria: [],
          },
        },
        warnings: [],
      }) satisfies EffectiveConfig;

    it("mirrors each [plugins] flag independently", () => {
      useSettingsStore
        .getState()
        .hydrateFromConfig(eff({ superpowers: false, frontend_design: true }));
      const s = useSettingsStore.getState();
      expect(s.superpowersEnabled).toBe(false);
      expect(s.frontendDesignEnabled).toBe(true);
    });

    it("treats an absent [plugins] block as on-by-default (older backend)", () => {
      // Must match SparkleConfig::default(), which ships both plugins enabled — reading an omitted
      // section as `false` would silently turn the defaults off for anyone on an older backend.
      useSettingsStore
        .getState()
        .hydrateFromConfig(eff({ superpowers: false, frontend_design: false }));
      useSettingsStore.getState().hydrateFromConfig(eff());
      const s = useSettingsStore.getState();
      expect(s.superpowersEnabled).toBe(true);
      expect(s.frontendDesignEnabled).toBe(true);
    });
  });

  describe("[tools].builder_index hydration", () => {
    /** A minimal effective config whose [tools] block is whatever the caller passes. */
    const eff = (tools?: Record<string, boolean>) =>
      ({
        config: {
          workflow: {
            require_pr: true,
            worktree_isolation: true,
            default_branch: "",
            born_fresh_from_base: true,
            delete_merged_branch: true,
            drift: { behind_nudge: 10, ahead_nudge: 15, changed_lines: 1000 },
          },
          workers: { max_concurrent: 5 },
          ai: {
            auto_rename: true,
            voice_dictation: true,
            composer: true,
            suggested_actions: true,
            auto_approve: true,
          },
          ...(tools
            ? {
                tools: {
                  analytics: true,
                  beads: true,
                  github: true,
                  guardrails: true,
                  roborev: true,
                  onepassword: false,
                  ...tools,
                },
              }
            : {}),
          roborev: { consent_prompted: false },
          freshness: {
            staleness_warn_commits: 25,
            stale_build_block_commits: 25,
            require_fresh_branch: true,
          },
          capture: { popover_shortcut: "ctrl+shift+r" },
          done: { description: null, criteria: [] },
          delivered: {
            description: null,
            detected_method: null,
            confidence: null,
            confidence_note: null,
            learned: false,
            criteria: [],
          },
        },
        warnings: [],
      }) satisfies EffectiveConfig;

    it("mirrors an explicit true", () => {
      useSettingsStore.getState().hydrateFromConfig(eff({ builder_index: true }));
      expect(useSettingsStore.getState().builderIndexEnabled).toBe(true);
    });

    it("reads an ABSENT key as OFF — the opposite of its on-by-default siblings", () => {
      // Every other [tools] flag hydrates `?? true`. This one must not: an older backend (or a
      // config file that never mentions it) would otherwise start publishing token totals to a
      // public leaderboard that the user never opted into.
      useSettingsStore.getState().hydrateFromConfig(eff({ builder_index: true }));
      useSettingsStore.getState().hydrateFromConfig(eff({}));
      expect(useSettingsStore.getState().builderIndexEnabled).toBe(false);
      // Same for a payload with no [tools] block at all.
      useSettingsStore.getState().hydrateFromConfig(eff({ builder_index: true }));
      useSettingsStore.getState().hydrateFromConfig(eff());
      expect(useSettingsStore.getState().builderIndexEnabled).toBe(false);
    });
  });

  it("falls back to the default voice words when the config has no [voice] block", () => {
    // Simulate an older backend that predates the [voice] section (voice omitted at runtime).
    const eff = {
      config: {
        workflow: {
          require_pr: true,
          worktree_isolation: true,
          default_branch: "",
          born_fresh_from_base: true,
          delete_merged_branch: true,
          drift: { behind_nudge: 10, ahead_nudge: 15, changed_lines: 1000 },
        },
        workers: { max_concurrent: 5 },
        ai: {
          auto_rename: true,
          voice_dictation: true,
          composer: true,
          suggested_actions: true,
          auto_approve: true,
        },
        roborev: { consent_prompted: false },
        freshness: {
          staleness_warn_commits: 25,
          stale_build_block_commits: 25,
          require_fresh_branch: true,
        },
        capture: { popover_shortcut: "ctrl+shift+r" },
        done: { description: null, criteria: [] },
        delivered: {
          description: null,
          detected_method: null,
          confidence: null,
          confidence_note: null,
          learned: false,
          criteria: [],
        },
      },
      warnings: [],
    } satisfies EffectiveConfig; // `voice` is optional, so omitting it typechecks (older backend)
    useSettingsStore.getState().hydrateFromConfig(eff);
    const s = useSettingsStore.getState();
    expect(s.wakeWord).toBe("Hey Sparkle");
    expect(s.stopWord).toBe("Sparkle, stop");
    expect(s.pauseOnSubmit).toBe(true);
  });

  it("treats an empty/whitespace configured word as the default", () => {
    useSettingsStore.getState().hydrateFromConfig({
      config: {
        workflow: {
          require_pr: true,
          worktree_isolation: true,
          default_branch: "",
          born_fresh_from_base: true,
          delete_merged_branch: true,
          drift: { behind_nudge: 10, ahead_nudge: 15, changed_lines: 1000 },
        },
        workers: { max_concurrent: 5 },
        ai: {
          auto_rename: true,
          voice_dictation: true,
          composer: true,
          suggested_actions: true,
          auto_approve: true,
        },
        roborev: { consent_prompted: false },
        freshness: {
          staleness_warn_commits: 25,
          stale_build_block_commits: 25,
          require_fresh_branch: true,
        },
        capture: { popover_shortcut: "ctrl+shift+r" },
        voice: { wake_word: "   ", stop_word: "", pause_on_submit: false },
        done: { description: null, criteria: [] },
        delivered: {
          description: null,
          detected_method: null,
          confidence: null,
          confidence_note: null,
          learned: false,
          criteria: [],
        },
      },
      warnings: [],
    });
    const s = useSettingsStore.getState();
    expect(s.wakeWord).toBe("Hey Sparkle"); // whitespace-only → default
    expect(s.stopWord).toBe("Sparkle, stop"); // empty → default
    expect(s.pauseOnSubmit).toBe(false); // a real boolean is still honored
  });
});

describe("voice setters", () => {
  it("setWakeWord / setStopWord / setPauseOnSubmit update the store", () => {
    useSettingsStore.getState().setWakeWord("Computer");
    useSettingsStore.getState().setStopWord("Computer, stop");
    useSettingsStore.getState().setPauseOnSubmit(false);
    const s = useSettingsStore.getState();
    expect(s.wakeWord).toBe("Computer");
    expect(s.stopWord).toBe("Computer, stop");
    expect(s.pauseOnSubmit).toBe(false);
  });
});

describe("1Password env backup — config hydration", () => {
  // A minimal effective config with no [tools] and no [onepassword] section: exactly what an
  // older Rust backend (predating this feature) sends.
  const bare = (): EffectiveConfig => ({
    config: {
      workflow: {
        require_pr: true,
        worktree_isolation: true,
        default_branch: "main",
        born_fresh_from_base: true,
        delete_merged_branch: true,
        drift: { behind_nudge: 10, ahead_nudge: 15, changed_lines: 1000 },
      },
      workers: { max_concurrent: 5 },
      ai: {
        auto_rename: true,
        voice_dictation: true,
        composer: true,
        suggested_actions: true,
        auto_approve: true,
      },
      roborev: { consent_prompted: false },
      freshness: {
        staleness_warn_commits: 25,
        stale_build_block_commits: 25,
        require_fresh_branch: true,
      },
      capture: { popover_shortcut: "ctrl+shift+r" },
      done: { description: null, criteria: [] },
      delivered: {
        description: null,
        detected_method: null,
        confidence: null,
        confidence_note: null,
        learned: false,
        criteria: [],
      },
    },
    warnings: [],
  });

  it("defaults to off/unset — the one tool that must not ship on", () => {
    // Every other tool hydrates `?? true`. This one can't: without an account, the `op` CLI, and
    // a chosen vault it can do nothing, so an absent section must never read as enabled.
    useSettingsStore.getState().hydrateFromConfig(bare());
    const s = useSettingsStore.getState();
    expect(s.onepasswordEnabled).toBe(false);
    expect(s.onepasswordVaultId).toBeNull();
    expect(s.onepasswordSeedWorktrees).toBe(false);
    // Sanity: the absent [tools] block still reads the OTHER tools as on, so this test is
    // really pinning the asymmetry rather than a blanket "everything defaults off".
    expect(s.roborevEnabled).toBe(true);
  });

  it("hydrates the flag, vault and seeding from config", () => {
    const eff = bare();
    eff.config.tools = {
      analytics: true,
      beads: true,
      github: true,
      guardrails: true,
      roborev: true,
      onepassword: true,
    };
    eff.config.onepassword = { vault_id: "vault-abc", seed_worktrees: true };
    useSettingsStore.getState().hydrateFromConfig(eff);
    const s = useSettingsStore.getState();
    expect(s.onepasswordEnabled).toBe(true);
    expect(s.onepasswordVaultId).toBe("vault-abc");
    expect(s.onepasswordSeedWorktrees).toBe(true);
  });

  it("treats a null vault_id as no vault picked", () => {
    const eff = bare();
    eff.config.onepassword = { vault_id: null, seed_worktrees: false };
    useSettingsStore.getState().hydrateFromConfig(eff);
    expect(useSettingsStore.getState().onepasswordVaultId).toBeNull();
  });

  it.each(["", "   ", "\t\n"])(
    "normalizes a blank vault_id (%j) on the way in, like the setter and Rust do",
    (blank) => {
      // Hydration is the third write path into this field and used to be the only one that passed
      // `""` through verbatim — which every "is a vault picked?" check downstream reads as YES.
      useSettingsStore.setState({ onepasswordVaultId: "stale" });
      const eff = bare();
      eff.config.onepassword = { vault_id: blank, seed_worktrees: false };
      useSettingsStore.getState().hydrateFromConfig(eff);
      expect(useSettingsStore.getState().onepasswordVaultId).toBeNull();
    },
  );

  it("trims a padded vault_id rather than storing the padding", () => {
    const eff = bare();
    eff.config.onepassword = { vault_id: "  vault-abc  ", seed_worktrees: false };
    useSettingsStore.getState().hydrateFromConfig(eff);
    expect(useSettingsStore.getState().onepasswordVaultId).toBe("vault-abc");
  });

  it("reads onepassword as OFF when a [tools] block predates the flag (backend skew)", () => {
    // The likeliest real skew payload: an older backend that has [tools] but no onepassword key.
    // A stray `?? true` copy-paste would flip the tool on for everyone running that build.
    const eff = bare();
    // Build the CURRENT shape, then delete the key an older backend wouldn't have sent. A literal
    // cast would keep compiling if ToolsConfig gained another required field, quietly ceasing to
    // model "older backend" while the rest of the suite caught the change.
    const tools: NonNullable<typeof eff.config.tools> = {
      analytics: true,
      beads: true,
      github: true,
      guardrails: true,
      roborev: true,
      onepassword: true,
    };
    delete (tools as Partial<typeof tools>).onepassword;
    eff.config.tools = tools;
    useSettingsStore.getState().hydrateFromConfig(eff);
    expect(useSettingsStore.getState().onepasswordEnabled).toBe(false);
    expect(useSettingsStore.getState().roborevEnabled).toBe(true);
  });
});

describe("1Password setters", () => {
  it("setOnePasswordVaultId trims, and empties to null", () => {
    useSettingsStore.getState().setOnePasswordVaultId("  vault-xyz  ");
    expect(useSettingsStore.getState().onepasswordVaultId).toBe("vault-xyz");

    // A blank id must clear the vault rather than being stored verbatim — an empty string would
    // read as "configured" everywhere downstream and make every op call fail opaquely.
    useSettingsStore.getState().setOnePasswordVaultId("   ");
    expect(useSettingsStore.getState().onepasswordVaultId).toBeNull();

    useSettingsStore.getState().setOnePasswordVaultId("v2");
    useSettingsStore.getState().setOnePasswordVaultId(null);
    expect(useSettingsStore.getState().onepasswordVaultId).toBeNull();
  });

  it("setToolEnabled drives the onepassword flag through TOOL_FIELD", () => {
    useSettingsStore.getState().setToolEnabled("onepassword", true);
    expect(useSettingsStore.getState().onepasswordEnabled).toBe(true);
    useSettingsStore.getState().setToolEnabled("onepassword", false);
    expect(useSettingsStore.getState().onepasswordEnabled).toBe(false);
  });

  it("setOnePasswordSeedWorktrees updates the store", () => {
    useSettingsStore.getState().setOnePasswordSeedWorktrees(true);
    expect(useSettingsStore.getState().onepasswordSeedWorktrees).toBe(true);
  });
});
