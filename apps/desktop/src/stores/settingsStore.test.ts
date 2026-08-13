import { describe, it, expect, beforeEach } from "vitest";
import {
  effectiveChiefPat,
  aiFeatureMode,
  migrateSettings,
  useSettingsStore,
  chiefLibraryOwner,
  enforcedWorkerCap,
  concurrencyBasis,
  AI_FEATURE_FIELD,
  type AiFeatureFlags,
} from "./settingsStore";
import type { EffectiveConfig } from "../services/config";

describe("effectiveChiefPat — PAT resolution order", () => {
  it("prefers the OS-keychain PAT, trimmed", () => {
    expect(effectiveChiefPat("  pat_keychain  ", "pat_user", "pat_runtime")).toBe("pat_keychain");
  });

  it("falls back to the legacy stored PAT when the keychain is empty", () => {
    expect(effectiveChiefPat("", "  pat_user  ", "pat_runtime")).toBe("pat_user");
  });

  it("falls back to the runtime env-resolved PAT when neither keychain nor stored is set", () => {
    expect(effectiveChiefPat("", "", "pat_runtime")).toBe("pat_runtime");
    expect(effectiveChiefPat("   ", "  ", "pat_runtime")).toBe("pat_runtime");
  });

  it("is empty when no keychain, stored, or runtime PAT exists (no build-env token in tests)", () => {
    expect(effectiveChiefPat("", "", "")).toBe("");
    expect(effectiveChiefPat("", "")).toBe("");
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
    aiConcierge: true,
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
        aiConcierge: false,
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
        aiConcierge: false,
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
    aiConcierge: true,
  };

  it("maps the menu key to its store field", () => {
    expect(AI_FEATURE_FIELD.suggestedActions).toBe("aiSuggestedActions");
  });
  it("counts toward the All/Some/Off master", () => {
    expect(aiFeatureMode(allOn)).toBe("all");
    expect(aiFeatureMode({ ...allOn, aiSuggestedActions: false })).toBe("some");
  });
});

describe("migrateSettings — v0→v1 AI opt-out, v1→v2 autoApplyUpdates, v2→v3 last-seen changelog", () => {
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
      lastSeenChangelogVersion: null,
    });
    expect(migrateSettings({ chiefPat: "x" }, 0)).toEqual({
      chiefPat: "x",
      autoApplyUpdates: true,
      lastSeenChangelogVersion: null,
    });
  });
  it("does not clobber an existing autoApplyUpdates value on migration", () => {
    expect(migrateSettings({ autoApplyUpdates: false }, 1)).toEqual({
      autoApplyUpdates: false,
      lastSeenChangelogVersion: null,
    });
  });
  it("v2→v3 adds lastSeenChangelogVersion as an EXPLICIT null, not an absent key", () => {
    // The distinction is load-bearing: WhatsNewPanel reads "no recorded version" as a first run and
    // seeds it to whatever is running, so an existing install sees only the release it is on rather
    // than the whole 35-release backlog. `toHaveProperty` with null fails on an absent key, which is
    // exactly what this is guarding.
    const out = migrateSettings({ chiefPat: "x" }, 2);
    expect(out).toHaveProperty("lastSeenChangelogVersion", null);
  });
  it("v2→v3 does not clobber a version already recorded", () => {
    expect(migrateSettings({ lastSeenChangelogVersion: "0.99.0" }, 2)).toEqual({
      lastSeenChangelogVersion: "0.99.0",
    });
  });
  it("is a no-op at the current version", () => {
    const blob = { aiEnabled: false, autoApplyUpdates: true, lastSeenChangelogVersion: "0.102.0" };
    expect(migrateSettings(blob, 3)).toBe(blob);
  });
});

describe("settingsStore — lastSeenChangelogVersion", () => {
  it("records a version and advances it", () => {
    useSettingsStore.setState({ lastSeenChangelogVersion: null });
    useSettingsStore.getState().setLastSeenChangelogVersion("0.99.0");
    expect(useSettingsStore.getState().lastSeenChangelogVersion).toBe("0.99.0");
    useSettingsStore.getState().setLastSeenChangelogVersion("0.102.0");
    expect(useSettingsStore.getState().lastSeenChangelogVersion).toBe("0.102.0");
  });
  it("IGNORES a blank version rather than storing one", () => {
    // useAppInfo reports "" until Rust answers; storing that would look like "nothing seen yet"
    // forever, so the panel would re-open on every launch.
    useSettingsStore.getState().setLastSeenChangelogVersion("0.102.0");
    useSettingsStore.getState().setLastSeenChangelogVersion("   ");
    expect(useSettingsStore.getState().lastSeenChangelogVersion).toBe("0.102.0");
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
    useSettingsStore.getState().setAiFeature("concierge", true);
    const s = useSettingsStore.getState();
    expect([
      s.aiAutoRename,
      s.cloudDictation,
      s.aiComposer,
      s.aiSuggestedActions,
      s.aiAutoApprove,
      s.aiConcierge,
    ]).toEqual([true, true, true, true, true, true]);
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

describe("hydrateFromConfig — [improvement].consent mirror", () => {
  // A minimal-but-complete effective config, with the [improvement] section swapped in per case.
  const baseConfig = {
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
  };
  const eff = (improvement?: { consent: "always" | "case_by_case" | "never" | null }) =>
    ({
      config: { ...baseConfig, ...(improvement ? { improvement } : {}) },
      warnings: [],
    }) as EffectiveConfig;

  it("adopts a written consent value from the file", () => {
    useSettingsStore.setState({ sparkleImprovementConsent: "case_by_case" });
    useSettingsStore.getState().hydrateFromConfig(eff({ consent: "always" }));
    expect(useSettingsStore.getState().sparkleImprovementConsent).toBe("always");
  });

  it("does NOT clobber a persisted choice when the [improvement] section is absent", () => {
    // First launch after upgrade: the file has no [improvement] yet. The store's persisted "always"
    // (from webview localStorage) must survive — this is the whole reason consent is nullable.
    useSettingsStore.setState({ sparkleImprovementConsent: "always" });
    useSettingsStore.getState().hydrateFromConfig(eff());
    expect(useSettingsStore.getState().sparkleImprovementConsent).toBe("always");
  });

  it("does NOT clobber a persisted choice when consent is explicitly null (unset)", () => {
    useSettingsStore.setState({ sparkleImprovementConsent: "never" });
    useSettingsStore.getState().hydrateFromConfig(eff({ consent: null }));
    expect(useSettingsStore.getState().sparkleImprovementConsent).toBe("never");
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

  // THE INVARIANT the machine-wide ratification rests on (bead `sparkle-axtkw`, roborev 55068).
  //
  // `[workers].max_concurrent` is machine-wide, and the reason there is exactly ONE spawn gate
  // rather than a per-agent one as well is that `enforcedWorkerCap` — `min(maxConcurrentWorkers,
  // effectiveMaxConcurrentWorkers)` — is not actually a min in any state hydrate can produce: both
  // fields come out of the same `pinnedCeiling ?? derived` / `min(pinnedCeiling, derived)` pair, so
  // they are equal. A per-agent gate written against `enforcedWorkerCap` therefore compared a
  // SMALLER count against the SAME threshold as the machine-wide gate and could never bind first.
  //
  // If a future change makes these two diverge, that reasoning silently stops holding and the
  // deleted per-agent gate becomes load-bearing again. This test is the tripwire for that, which is
  // why it sweeps the whole hydrate matrix instead of asserting one pair: pinned-below-derived,
  // pinned-above-derived, AUTO, a missing backend field, and the floors.
  it.each([
    ["pin below what the machine derives", 4, 40],
    ["pin above what the machine derives", 20, 3],
    ["pin equal to the derivation", 8, 8],
    ["AUTO — no pin at all", null, 40],
    ["AUTO on an unmeasurable machine", null, undefined],
    ["a backend too old to send the field", 7, undefined],
    ["a backend reporting zero", 20, 0],
  ])(
    "enforcedWorkerCap === effectiveMaxConcurrentWorkers after hydrate (%s)",
    (_label, pin, derived) => {
      useSettingsStore.getState().hydrateFromConfig(eff(pin, derived));
      const s = useSettingsStore.getState();
      // Not `toBeLessThanOrEqual` — EQUAL. "≤" is what the type of a min() suggests and it would
      // pass against a divergence, which is exactly the state this exists to catch.
      expect(enforcedWorkerCap(s)).toBe(s.effectiveMaxConcurrentWorkers);
      // ...and the min() cannot be clamping, i.e. the pin is never the smaller of the two.
      expect(s.effectiveMaxConcurrentWorkers).toBeLessThanOrEqual(s.maxConcurrentWorkers);
    },
  );

  // BUG 2/3 of the agent-ceiling audit. The app told a human "at-capacity: 46 of 32 slots… the
  // ceiling is derived from installed RAM" on an 18-core machine that was CPU-bound at 36 and
  // pinned at 32 — three numbers and the wrong reason. The provenance is computed in Rust next to
  // the number and mirrored VERBATIM; nothing here re-derives it, because every re-derivation of
  // "why is the cap this?" from the value alone has been wrong.
  describe("the ceiling's provenance", () => {
    /** The measured machine from the report, pinned at 32 while its cores derive 36. */
    const pinned: EffectiveConfig = {
      ...eff(32, 32),
      machine_max_concurrent: 36,
      concurrency_bound: "pinned",
      concurrency_basis: "pinned to 32 in config.toml ([workers].max_concurrent) — this machine could run 36",
    };

    it("mirrors the binding dimension and its sentence without reinterpreting either", () => {
      useSettingsStore.getState().hydrateFromConfig(pinned);
      const s = useSettingsStore.getState();
      expect(s.concurrencyBound).toBe("pinned");
      expect(s.machineMaxConcurrentWorkers).toBe(36);
      expect(concurrencyBasis(s)).toBe(pinned.concurrency_basis);
    });

    it("reports the cap it enforces — the two numbers are the same number", () => {
      useSettingsStore.getState().hydrateFromConfig(pinned);
      const s = useSettingsStore.getState();
      expect(enforcedWorkerCap(s)).toBe(32);
      // The machine's own limit is REPORTED, never enforced: it is context for the human, not a
      // second cap that some gate could read by mistake.
      expect(s.machineMaxConcurrentWorkers).toBeGreaterThan(enforcedWorkerCap(s));
    });

    it("names the CPU bound on a core-bound machine rather than blaming memory", () => {
      useSettingsStore.getState().hydrateFromConfig({
        ...eff(null, 36),
        machine_max_concurrent: 36,
        concurrency_bound: "cpu",
        concurrency_basis: "CPU-bound: 18 cores × 2 agents per core",
      });
      const s = useSettingsStore.getState();
      expect(s.concurrencyBound).toBe("cpu");
      expect(concurrencyBasis(s)).toBe("CPU-bound: 18 cores × 2 agents per core");
      expect(concurrencyBasis(s)).not.toMatch(/RAM/i);
    });

    // An older backend sends neither field. The fallback must be CAUSELESS, not a guess — saying
    // nothing about why beats naming the wrong dimension, which is the entire bug.
    it("degrades to a causeless sentence rather than assuming RAM", () => {
      useSettingsStore.getState().hydrateFromConfig(eff(null, 12));
      const s = useSettingsStore.getState();
      expect(s.concurrencyBound).toBe("unknown");
      expect(s.machineMaxConcurrentWorkers).toBe(12);
      expect(concurrencyBasis(s)).toBe("12 at once on this machine");
      expect(concurrencyBasis(s)).not.toMatch(/RAM|CPU|pinned/i);
    });

    it("never reports a machine limit below the cap it enforces", () => {
      // A backend that omits machine_max_concurrent must not make the UI claim the hardware is the
      // constraint when the enforced number is higher.
      useSettingsStore.getState().hydrateFromConfig(eff(null, 20));
      const s = useSettingsStore.getState();
      expect(s.machineMaxConcurrentWorkers).toBeGreaterThanOrEqual(enforcedWorkerCap(s));
    });
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
      expect(s.pluginsEnabled.superpowers).toBe(false);
      expect(s.pluginsEnabled.frontendDesign).toBe(true);
    });

    it("treats an absent [plugins] block as on-by-default (older backend)", () => {
      // Must match SparkleConfig::default(), which ships both plugins enabled — reading an omitted
      // section as `false` would silently turn the defaults off for anyone on an older backend.
      useSettingsStore
        .getState()
        .hydrateFromConfig(eff({ superpowers: false, frontend_design: false }));
      useSettingsStore.getState().hydrateFromConfig(eff());
      const s = useSettingsStore.getState();
      expect(s.pluginsEnabled.superpowers).toBe(true);
      expect(s.pluginsEnabled.frontendDesign).toBe(true);
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

  // ── THE UPGRADE PATH: A CONFIG THAT STILL CARRIES THE RETIRED [voice] KEYS ────────────────────
  // The wake word, the stop word and pause-on-submit were removed from this store when the wake
  // word itself was retired. Every installed client still has them written into its config.toml,
  // so hydration must simply ignore them — not throw, and not disturb the settings around them.
  //
  // The payload is cast because `voice` is no longer part of `SparkleConfig`. That cast IS the
  // point of the test: it reproduces the shape a real upgraded install sends at RUNTIME, which the
  // type can no longer describe. Asserting the surviving siblings (rather than only "it did not
  // throw") is what stops this passing vacuously.
  it("ignores a persisted [voice] block carrying the retired wake/stop keys", () => {
    // Deliberately built as a RUNTIME payload and cast, because `voice` is no longer part of
    // `SparkleConfig`. That cast is the point: this is the exact shape an upgraded install still
    // sends, which the type can no longer describe.
    const withRetiredKeys = {
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
        // The three retired keys, exactly as an existing config.toml still carries them.
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
      warnings: [],
    } as unknown as EffectiveConfig;
    expect(() => useSettingsStore.getState().hydrateFromConfig(withRetiredKeys)).not.toThrow();
    const s = useSettingsStore.getState();
    // The retired keys did not poison their neighbours: everything ELSE still hydrated. This is the
    // non-vacuous half — "it did not throw" alone would pass against a hydrate that did nothing.
    expect(s.requirePr).toBe(true);
    expect(s.maxConcurrentWorkers).toBe(5);
    expect(s.driftBehindNudge).toBe(10);
    // …and nothing resurrected them on the store.
    expect("wakeWord" in s).toBe(false);
    expect("stopWord" in s).toBe(false);
    expect("pauseOnSubmit" in s).toBe(false);
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

  it("hydrates the chosen account, and treats a blank one as no account chosen", () => {
    // The account is what `op` is told to act as; an unset value means "let `op` decide", which is
    // right for a single signed-in account and wrong the moment there are two.
    const eff = bare();
    eff.config.onepassword = {
      vault_id: "vault-abc",
      account_id: "  NZ36HQYBEVBWZMSWZLH77XMFJA  ",
      seed_worktrees: false,
    };
    useSettingsStore.getState().hydrateFromConfig(eff);
    expect(useSettingsStore.getState().onepasswordAccountId).toBe("NZ36HQYBEVBWZMSWZLH77XMFJA");

    // A blank id must not read as "an account is chosen" — it would go out as `--account ""`.
    useSettingsStore.setState({ onepasswordAccountId: "stale" });
    eff.config.onepassword = { vault_id: "vault-abc", account_id: "  ", seed_worktrees: false };
    useSettingsStore.getState().hydrateFromConfig(eff);
    expect(useSettingsStore.getState().onepasswordAccountId).toBeNull();

    // …and an older backend that doesn't send the key at all is "not chosen", not a crash.
    useSettingsStore.setState({ onepasswordAccountId: "stale" });
    eff.config.onepassword = { vault_id: "vault-abc", seed_worktrees: false };
    useSettingsStore.getState().hydrateFromConfig(eff);
    expect(useSettingsStore.getState().onepasswordAccountId).toBeNull();
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

// The concierge's per-tool autonomy rules. The pane and the policy layer both read this mirror, so
// what matters here is that it stays a faithful copy of `[concierge.tools]` — including values the
// policy layer will refuse to read, which must survive rather than being cleaned up into a
// permissive default.
describe("[concierge.tools] mirror", () => {
  /** A minimal-but-complete effective config, with `concierge` swapped in per case. */
  const eff = (concierge?: { tools: Record<string, string> }) =>
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
        ...(concierge ? { concierge } : {}),
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

  it("mirrors each tool rule verbatim", () => {
    useSettingsStore
      .getState()
      .hydrateFromConfig(eff({ tools: { merge_pr: "deny", list_projects: "allow" } }));
    expect(useSettingsStore.getState().conciergeToolPolicy).toEqual({
      merge_pr: "deny",
      list_projects: "allow",
    });
  });

  it("reads an ABSENT [concierge] section as no rules — which is a complete policy, not a gap", () => {
    // Every tool then sits on the default derived from its risk class, so an older backend that
    // omits the section is governed exactly as well as a current one with an empty table.
    useSettingsStore.getState().hydrateFromConfig(eff({ tools: { quit_app: "deny" } }));
    useSettingsStore.getState().hydrateFromConfig(eff());
    expect(useSettingsStore.getState().conciergeToolPolicy).toEqual({});
  });

  it("KEEPS a value the policy layer can't read, instead of tidying it away", () => {
    // The policy layer reads an unrecognized rule as "ask" — stricter than the derived default.
    // Dropping it here would silently restore `allow` on exactly the rule the user was tightening.
    useSettingsStore.getState().hydrateFromConfig(eff({ tools: { list_projects: "dney" } }));
    expect(useSettingsStore.getState().conciergeToolPolicy).toEqual({ list_projects: "dney" });
  });

  it("drops non-string values, which can never read as a rule", () => {
    const raw = { merge_pr: true, quit_app: 3, push_agent_branch: "ask" } as unknown as Record<
      string,
      string
    >;
    useSettingsStore.getState().hydrateFromConfig(eff({ tools: raw }));
    expect(useSettingsStore.getState().conciergeToolPolicy).toEqual({ push_agent_branch: "ask" });
  });

  it("setConciergeToolPolicy sets one rule and CLEARS by deleting the key", () => {
    // Clearing must delete rather than write a "default" sentinel: the default is derived, so a
    // frozen copy of today's value would stop tracking a future reclassification.
    const store = () => useSettingsStore.getState();
    // Start from a known table: the store is a module singleton shared with the hydrate cases above.
    useSettingsStore.setState({ conciergeToolPolicy: {} });
    store().setConciergeToolPolicy("merge_pr", "deny");
    store().setConciergeToolPolicy("quit_app", "ask");
    expect(store().conciergeToolPolicy).toEqual({ merge_pr: "deny", quit_app: "ask" });
    store().setConciergeToolPolicy("merge_pr", null);
    expect(store().conciergeToolPolicy).toEqual({ quit_app: "ask" });
    expect("merge_pr" in store().conciergeToolPolicy).toBe(false);
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

// Every Sparkle project id these cases use. Ownership is only meaningful for a project that still
// EXISTS: `chiefProjectByProject` is persisted and outlives removed projects, so a ghost entry must
// not be able to claim a library. Passing the live set explicitly is what enforces that.
const LIVE = ["a", "b", "fresh", "sparkle-proj", "never-linked"];

// sparkle-ojgvp. Until this, `setChiefProject` had exactly one caller — inside runChiefSync — so a
// link could never be re-pointed from anywhere in the app. Each case asserts the LEDGER's fate as
// well as the link's, because carrying a ledger across a re-link is the failure these actions
// exist to prevent: it is keyed by CHIEF project id and holds asset ids from the OLD library.
describe("relink / unlink a project's Chief library (sparkle-ojgvp)", () => {
  const seed = (links: Record<string, string>, ledgers: Record<string, unknown>) =>
    useSettingsStore.setState({
      chiefProjectByProject: links,
      chiefDocStateByProject: ledgers as Record<string, Record<string, never>>,
    });
  const s = () => useSettingsStore.getState();

  beforeEach(() => seed({}, {}));

  it("re-points the link and DROPS the outgoing ledger", () => {
    seed(
      { "sparkle-proj": "chief_old" },
      { chief_old: { "PRD/a.md": { hash: "h", assetId: "asset_in_old_library" } } },
    );

    s().relinkChiefProject("sparkle-proj", "chief_new", LIVE);

    expect(s().chiefProjectByProject["sparkle-proj"]).toBe("chief_new");
    // Holding asset ids from the old library would make the next run skip uploads whose hash
    // "matches" an asset the new project does not contain, and delete ids that are not there.
    expect(s().chiefDocStateByProject["chief_old"]).toBeUndefined();
  });

  it("leaves OTHER projects' ledgers alone", () => {
    seed(
      { a: "chief_a", b: "chief_b" },
      { chief_a: { "PRD/a.md": { hash: "h", assetId: "x" } }, chief_b: { "PRD/b.md": { hash: "h", assetId: "y" } } },
    );

    s().relinkChiefProject("a", "chief_new", LIVE);

    expect(s().chiefDocStateByProject["chief_b"]).toEqual({ "PRD/b.md": { hash: "h", assetId: "y" } });
    expect(s().chiefProjectByProject["b"]).toBe("chief_b");
  });

  it("is a no-op when the target is already the current link", () => {
    const ledger = { "PRD/a.md": { hash: "h", assetId: "x" } };
    seed({ a: "chief_a" }, { chief_a: ledger });

    s().relinkChiefProject("a", "chief_a", LIVE);

    // A stray click must not throw away a healthy ledger and force a full re-reconcile.
    expect(s().chiefDocStateByProject["chief_a"]).toEqual(ledger);
  });

  it("re-links a project that had no link yet, without disturbing any ledger", () => {
    seed({}, { chief_other: { "PRD/x.md": { hash: "h", assetId: "z" } } });

    s().relinkChiefProject("fresh", "chief_new", LIVE);

    expect(s().chiefProjectByProject["fresh"]).toBe("chief_new");
    expect(s().chiefDocStateByProject["chief_other"]).toBeDefined();
  });

  it("unlink forgets both the link and its ledger", () => {
    seed({ a: "chief_a" }, { chief_a: { "PRD/a.md": { hash: "h", assetId: "x" } } });

    s().unlinkChiefProject("a", LIVE);

    expect(s().chiefProjectByProject["a"]).toBeUndefined();
    expect(s().chiefDocStateByProject["chief_a"]).toBeUndefined();
  });

  it("unlink is a no-op for a project that was never linked", () => {
    seed({ b: "chief_b" }, { chief_b: { "PRD/b.md": { hash: "h", assetId: "y" } } });

    s().unlinkChiefProject("never-linked", LIVE);

    expect(s().chiefProjectByProject["b"]).toBe("chief_b");
    expect(s().chiefDocStateByProject["chief_b"]).toBeDefined();
  });
});

// The multi-linker cases roborev flagged. The ledger is keyed by CHIEF project id, so it is SHARED
// state whenever two Sparkle projects point at one library — and the earlier tests only ever used
// distinct ids, so none of this was covered.
describe("two Sparkle projects, one Chief library (sparkle-ojgvp)", () => {
  const s = () => useSettingsStore.getState();

  beforeEach(() =>
    useSettingsStore.setState({ chiefProjectByProject: {}, chiefDocStateByProject: {} }),
  );

  it("REFUSES to link a library another project already syncs into", () => {
    useSettingsStore.setState({ chiefProjectByProject: { b: "chief_shared" } });

    s().relinkChiefProject("a", "chief_shared", LIVE);

    // Sharing is mutually destructive, not merely redundant: syncProjectMarkdown treats the ledger
    // as the complete desired state for the one worktree it read, so each project would delete the
    // other's documents every round.
    expect(s().chiefProjectByProject["a"]).toBeUndefined();
    expect(s().chiefProjectByProject["b"]).toBe("chief_shared");
  });

  it("still allows re-selecting the library THIS project already owns", () => {
    useSettingsStore.setState({ chiefProjectByProject: { a: "chief_a" } });
    s().relinkChiefProject("a", "chief_a", LIVE);
    expect(s().chiefProjectByProject["a"]).toBe("chief_a");
  });

  it("relink KEEPS a shared ledger that another project still needs", () => {
    // Pre-existing persisted state can already contain sharing (it predates the guard above), so
    // the drop has to be conditional regardless of the refusal.
    const shared = { "PRD/a.md": { hash: "h", assetId: "x" } };
    useSettingsStore.setState({
      chiefProjectByProject: { a: "chief_shared", b: "chief_shared" },
      chiefDocStateByProject: { chief_shared: shared },
    });

    s().relinkChiefProject("a", "chief_new", LIVE);

    // Dropping it would strip B of every recorded assetId: its stale docs could never be deleted
    // (orphans forever) and it would re-upload its whole tree.
    expect(s().chiefDocStateByProject["chief_shared"]).toEqual(shared);
    expect(s().chiefProjectByProject["a"]).toBe("chief_new");
  });

  it("unlink KEEPS a shared ledger that another project still needs", () => {
    const shared = { "PRD/a.md": { hash: "h", assetId: "x" } };
    useSettingsStore.setState({
      chiefProjectByProject: { a: "chief_shared", b: "chief_shared" },
      chiefDocStateByProject: { chief_shared: shared },
    });

    s().unlinkChiefProject("a", LIVE);

    expect(s().chiefDocStateByProject["chief_shared"]).toEqual(shared);
    expect(s().chiefProjectByProject["b"]).toBe("chief_shared");
  });

  it("drops the ledger once the LAST linker leaves", () => {
    useSettingsStore.setState({
      chiefProjectByProject: { a: "chief_shared", b: "chief_shared" },
      chiefDocStateByProject: { chief_shared: { "PRD/a.md": { hash: "h", assetId: "x" } } },
    });

    s().unlinkChiefProject("a", LIVE);
    expect(s().chiefDocStateByProject["chief_shared"]).toBeDefined(); // b still there
    s().unlinkChiefProject("b", LIVE);
    expect(s().chiefDocStateByProject["chief_shared"]).toBeUndefined();
  });
});

// The two bugs roborev found in the anti-sharing guard itself (job 59752).
describe("claimChiefLibrary — atomic, and blind to ghosts (sparkle-ojgvp)", () => {
  const s = () => useSettingsStore.getState();

  beforeEach(() =>
    useSettingsStore.setState({ chiefProjectByProject: {}, chiefDocStateByProject: {} }),
  );

  it("a link left by a REMOVED project owns nothing", () => {
    // HIGH. chiefProjectByProject is persisted and is not pruned on every project-destruction
    // path, so it accumulates ghosts. Counting one as an owner is unrecoverable in-app: close a
    // project, re-add the same folder (new id, same name), ensureChiefProject name-matches back,
    // and every sync is refused against an owner the UI cannot even name.
    useSettingsStore.setState({ chiefProjectByProject: { ghost: "chief_x" } });

    expect(chiefLibraryOwner(s().chiefProjectByProject, "chief_x", "reborn", ["reborn"])).toBeNull();
    expect(s().claimChiefLibrary("reborn", "chief_x", ["reborn"])).toBe(true);
    expect(s().chiefProjectByProject["reborn"]).toBe("chief_x");
  });

  it("a link held by a LIVE project still owns it", () => {
    useSettingsStore.setState({ chiefProjectByProject: { b: "chief_x" } });
    expect(chiefLibraryOwner(s().chiefProjectByProject, "chief_x", "a", ["a", "b"])).toBe("b");
    expect(s().claimChiefLibrary("a", "chief_x", ["a", "b"])).toBe(false);
    expect(s().chiefProjectByProject["a"]).toBeUndefined();
  });

  it("two projects resolving onto the SAME library: exactly one wins", () => {
    // MEDIUM. The previous guard read the store, then resolved the library over an await, then
    // compared — so two projects with NO persisted link each computed an EMPTY claimed set and
    // each passed. Deciding and writing in one `set` is what makes the second call see the first.
    const first = s().claimChiefLibrary("a", "chief_shared", ["a", "b"]);
    const second = s().claimChiefLibrary("b", "chief_shared", ["a", "b"]);
    expect([first, second]).toEqual([true, false]);
    expect(s().chiefProjectByProject["a"]).toBe("chief_shared");
    expect(s().chiefProjectByProject["b"]).toBeUndefined();
  });

  it("re-claiming a library this project already holds succeeds and is idempotent", () => {
    useSettingsStore.setState({ chiefProjectByProject: { a: "chief_x" } });
    expect(s().claimChiefLibrary("a", "chief_x", ["a"])).toBe(true);
    expect(s().chiefProjectByProject["a"]).toBe("chief_x");
  });

  it("REFUSES BOTH projects when the persisted links already hold the sharing", () => {
    // The "we already hold it" shortcut must not answer ahead of the ownership check. Two live
    // projects whose links both name one library is reachable from state written before this guard
    // existed (and from a `project_gone` link neither project dropped) — and letting each through
    // because it "already holds" the link IS the mutual deletion: every round, each project's
    // sweep removes the other's documents. Neither may proceed until a human re-points one.
    useSettingsStore.setState({ chiefProjectByProject: { a: "chief_shared", b: "chief_shared" } });

    expect(s().claimChiefLibrary("a", "chief_shared", ["a", "b"])).toBe(false);
    expect(s().claimChiefLibrary("b", "chief_shared", ["a", "b"])).toBe(false);
    // A refusal, never a silent repair: the store does not get to pick which project loses its link.
    expect(s().chiefProjectByProject).toEqual({ a: "chief_shared", b: "chief_shared" });
  });

  it("a GHOST co-holder does not block the live project that also holds the link", () => {
    // The mirror of the case above: same shape, but the second holder no longer exists, so there
    // is nothing to destroy and refusing would strand the live project with no in-app remedy.
    useSettingsStore.setState({ chiefProjectByProject: { a: "chief_shared", ghost: "chief_shared" } });
    expect(s().claimChiefLibrary("a", "chief_shared", ["a"])).toBe(true);
  });
});
