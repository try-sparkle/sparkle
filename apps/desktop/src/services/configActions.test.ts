// @vitest-environment jsdom
//
// Tests for the config write-back actions: each optimistically updates the store AND persists to
// config.toml via the (mocked) config service. The bulk path must use a SINGLE atomic write.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Tauri-backed config service so no IPC is attempted under jsdom.
vi.mock("./config", () => ({
  setConfigValue: vi.fn().mockResolvedValue(undefined),
  setConfigValues: vi.fn().mockResolvedValue(undefined),
  unsetConfigValue: vi.fn().mockResolvedValue(undefined),
  setProjectConfigValue: vi.fn().mockResolvedValue(undefined),
  unsetProjectConfigValue: vi.fn().mockResolvedValue(undefined),
}));

// Mock the roborev daemon/hook shims so setRoborevEnabled's side effects are observable without IPC.
vi.mock("./roborev", () => ({
  installRoborev: vi.fn().mockResolvedValue(undefined),
  deactivateRoborev: vi.fn().mockResolvedValue(undefined),
  installRepoHooks: vi.fn().mockResolvedValue(undefined),
  removeRepoHooks: vi.fn().mockResolvedValue(undefined),
  // Default to a healthy machine; the gate tests below override per-case.
  roborevAuthSelftest: vi.fn().mockResolvedValue({ kind: "Passed" }),
}));

// Mock the drainer shim so setDrainerEnabled's launchd side effect is observable without IPC.
vi.mock("./drainer", () => ({
  ensureBacklogDrainer: vi.fn().mockResolvedValue("--install"),
}));

// Mock the worktree service so the plugin-install side effect is observable without IPC (and so
// importing it doesn't drag the pty module into jsdom).
vi.mock("./worktree", () => ({
  // Default to a healthy machine: the toggled plugin comes back present. Each test that cares
  // about a failure overrides this per-case.
  ensureDefaultPluginsInstalled: vi.fn().mockResolvedValue([
    { key: "superpowers", id: "superpowers@m", status: "alreadyPresent", message: null, detail: null },
    { key: "frontend_design", id: "frontend-design@m", status: "alreadyPresent", message: null, detail: null },
  ]),
}));

import {
  setConfigValue,
  setConfigValues,
  unsetConfigValue,
  setProjectConfigValue,
  unsetProjectConfigValue,
} from "./config";
import { roborevAuthSelftest } from "./roborev";
import { CLAUDE_LOGIN_COMMAND } from "./claudeSpawn";
import { ensureDefaultPluginsInstalled, type PluginInstallOutcome } from "./worktree";
import {
  setAiFeature,
  setAllAiFeatures,
  setAutoApprovePreset,
  setMaxConcurrentWorkers,
  setPluginEnabled,
  setToolEnabled,
  setRoborevEnabled,
  setDrainerEnabled,
  setResumeRule,
  authWarningFor,
  refreshRoborevAuth,
  markRoborevConsentPrompted,
  setImprovementConsent,
  backfillImprovementConsentMirror,
  setBuilderIndexEnabled,
  setStraudeEnabled,
  setOnePasswordAccount,
  setOnePasswordVault,
  setOnePasswordSeedWorktrees,
  allowAllConciergeTools,
  resetAllConciergeTools,
} from "./configActions";
import {
  CONCIERGE_TOOL_NAMES,
  CONCIERGE_TOOLS_CONFIG_TABLE,
} from "./conciergeTools/policy";
import { APPROVAL_CATEGORIES } from "./suggestions/approvalCategories";
import { useApprovalsStore } from "../stores/approvalsStore";
import {
  installRoborev,
  deactivateRoborev,
  installRepoHooks,
  removeRepoHooks,
} from "./roborev";
import { ensureBacklogDrainer } from "./drainer";
import { useSettingsStore, DEFAULT_SPARKLE_CONSENT, PLUGIN_DEFAULTS } from "../stores/settingsStore";
import { useProjectStore } from "../stores/projectStore";

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.getState().setAllAiFeatures(true);
  useSettingsStore.getState().setMaxConcurrentWorkers(20);
});

describe("setPluginEnabled — the [plugins] flags", () => {
  it("writes the snake_case TOML path, not the camelCase store key", () => {
    // frontendDesign → plugins.frontend_design. Getting this wrong writes a key nothing reads,
    // so the toggle would appear to work and change nothing.
    void setPluginEnabled("frontendDesign", false);
    expect(setConfigValue).toHaveBeenCalledWith("plugins.frontend_design", false);

    void setPluginEnabled("superpowers", false);
    expect(setConfigValue).toHaveBeenCalledWith("plugins.superpowers", false);
  });

  it("maps every sparkle* plugin key to its exact [plugins] TOML key", () => {
    // The camelCase→snake_case boundary is where a plugin row dies silently: a wrong leaf writes a
    // key Rust's KNOWN_PLUGINS does not claim, which parses fine, applies nothing, and is only
    // reported as an "unknown [plugins] key" warning in a log nobody is reading. The switch still
    // moves, so the row looks like it works.
    //
    // Asserted as literal strings rather than derived from the map under test — deriving both
    // sides would make this agree with any mapping at all, including a wrong one.
    for (const [key, path] of [
      ["sparkleGuardrails", "plugins.sparkle_guardrails"],
      ["sparkleFreshness", "plugins.sparkle_freshness"],
      ["sparkleMutationCheck", "plugins.sparkle_mutation_check"],
      ["sparkleConflictWatch", "plugins.sparkle_conflict_watch"],
      ["sparkleSecrets", "plugins.sparkle_secrets"],
      ["sparkleReviewProbes", "plugins.sparkle_review_probes"],
      ["sparklePusher", "plugins.sparkle_pusher"],
    ] as const) {
      vi.mocked(setConfigValue).mockClear();
      void setPluginEnabled(key, false);
      expect(setConfigValue).toHaveBeenCalledWith(path, false);
    }
  });

  it("maps every Tier 2 plugin key to its exact [plugins] TOML key", () => {
    // Same boundary as the test above, and the same silent death — but these seven keys
    // (sparkle-s3g2.7) are the ones a reader is most likely to "fix" into something plausible.
    // `codeSimplifier` is `code_simplifier`, not `code-simplifier` (that is the PLUGIN name, and
    // the hyphenated form is a [plugins] key Rust's KNOWN_PLUGINS does not claim — it parses,
    // applies nothing, and only shows up as an "unknown [plugins] key" warning in a log nobody
    // reads, while the switch still moves). Literal strings on both sides on purpose: deriving the
    // expectation from PLUGINS_CONFIG_PATH would make this agree with any mapping, wrong ones
    // included.
    for (const [key, path] of [
      ["hookify", "plugins.hookify"],
      ["codeSimplifier", "plugins.code_simplifier"],
      ["elementsOfStyle", "plugins.elements_of_style"],
      ["doubleShotLatte", "plugins.double_shot_latte"],
      ["compoundEngineering", "plugins.compound_engineering"],
      ["differentialReview", "plugins.differential_review"],
      ["reviewSquad", "plugins.review_squad"],
    ] as const) {
      vi.mocked(setConfigValue).mockClear();
      void setPluginEnabled(key, false);
      expect(setConfigValue).toHaveBeenCalledWith(path, false);
    }
  });

  it("ships every Tier 2 plugin ON by default", () => {
    // The bead is "default installed, invoked on demand" — the plugin has to be enabled for its
    // skills and commands to be AVAILABLE at all. PLUGIN_DEFAULTS is what the toggle paints before
    // the config hydrate answers, so a `false` here shows the user an off switch for a plugin that
    // is in fact installed and running. Rust's
    // `the_frontend_plugin_defaults_mirror_matches_this_tables_default_on_column` pins the other
    // direction (this file against KNOWN_PLUGINS); this pins the intended VALUE, so flipping both
    // mirrors to false in lockstep still fails here.
    for (const key of [
      "hookify",
      "codeSimplifier",
      "elementsOfStyle",
      "doubleShotLatte",
      "compoundEngineering",
      "differentialReview",
      "reviewSquad",
    ] as const) {
      expect(PLUGIN_DEFAULTS[key]).toBe(true);
    }
    // ...and this change must not have flipped the four unpublished sparkle_* rows along with them.
    for (const key of [
      "sparkleConflictWatch",
      "sparkleSecrets",
      "sparkleReviewProbes",
      "sparklePusher",
    ] as const) {
      expect(PLUGIN_DEFAULTS[key]).toBe(false);
    }
  });

  it("updates the store optimistically, before the write resolves", () => {
    useSettingsStore.setState({ pluginsEnabled: { ...useSettingsStore.getState().pluginsEnabled, superpowers: true } });
    const pending = setPluginEnabled("superpowers", false);
    // Already flipped — the UI must not wait on IPC to reflect the click.
    expect(useSettingsStore.getState().pluginsEnabled.superpowers).toBe(false);
    return pending;
  });

  it("keeps the optimistic store value when the config write fails", async () => {
    vi.mocked(setConfigValue).mockRejectedValueOnce(new Error("disk full"));
    useSettingsStore.setState({ pluginsEnabled: { ...useSettingsStore.getState().pluginsEnabled, frontendDesign: true } });
    // Must not throw: a failed persist is warned about, not surfaced as an unhandled rejection.
    await setPluginEnabled("frontendDesign", false);
    expect(useSettingsStore.getState().pluginsEnabled.frontendDesign).toBe(false);
  });

  it("installs the plugin when toggled ON, so it doesn't wait for the next launch", async () => {
    // The config write alone only makes future agents ENABLE the plugin, and Claude Code does not
    // fetch a settings-enabled plugin. Without this the toggle looks like it worked and the plugin
    // silently never loads until the app is restarted.
    await setPluginEnabled("superpowers", true);
    // The force KEY is the load-bearing argument. The pass keeps a per-process "already attempted"
    // set so an un-installable machine doesn't burn 90s network calls on every agent prepare — but
    // it also swallowed the user-initiated toggle, making "turn it off and on again" (the only
    // remedy the UI names) a silent no-op that rendered as success. It names ONE plugin (the TOML
    // key, not the camelCase store key) so clicking one row can't kick off the other rows' retries.
    expect(ensureDefaultPluginsInstalled).toHaveBeenCalledWith("superpowers");
  });

  it("does not install when toggled OFF, or when the config write failed", async () => {
    await setPluginEnabled("superpowers", false);
    expect(ensureDefaultPluginsInstalled).not.toHaveBeenCalled();

    // A write that didn't land means the installer would read the OLD config — don't chase it.
    vi.mocked(setConfigValue).mockRejectedValueOnce(new Error("disk full"));
    await setPluginEnabled("superpowers", true);
    expect(ensureDefaultPluginsInstalled).not.toHaveBeenCalled();
  });

  it("says so on the row when the install FAILED but the pass still resolved", async () => {
    // THE regression. The pass is best-effort by contract and returns Ok even when every install
    // failed, so before the per-plugin outcome existed this hint could never fire for the cases it
    // was written for (offline, marketplace outage, no claude) — the switch read ON with the plugin
    // absent. A rejection is NOT the signal; the outcome is.
    vi.mocked(ensureDefaultPluginsInstalled).mockResolvedValueOnce([
      {
        key: "superpowers",
        id: "superpowers@claude-plugins-official",
        status: "failed",
        message: "Sparkle couldn't install this plugin. Check your connection.",
        detail: "`claude plugin install` failed: getaddrinfo ENOTFOUND",
      },
    ]);
    await expect(setPluginEnabled("superpowers", true)).resolves.toBeUndefined();
    expect(useSettingsStore.getState().pluginsEnabled.superpowers).toBe(true);
    expect(useSettingsStore.getState().pluginInstallState.superpowers).toMatch(/couldn't install/);
  });

  it("never rejects when the whole pass fails, and still says so on the row", async () => {
    // A rejection means the pass itself couldn't run (no app-data dir, task panic) — distinct from
    // an install that failed, and still not something to render as a working toggle.
    vi.mocked(ensureDefaultPluginsInstalled).mockRejectedValueOnce(new Error("offline"));
    await expect(setPluginEnabled("superpowers", true)).resolves.toBeUndefined();
    expect(useSettingsStore.getState().pluginsEnabled.superpowers).toBe(true);
    expect(useSettingsStore.getState().pluginInstallState.superpowers).toMatch(
      /couldn't run the plugin install/,
    );
  });

  it("clears the row hint when the plugin really did install", async () => {
    vi.mocked(ensureDefaultPluginsInstalled).mockResolvedValueOnce([
      {
        key: "superpowers",
        id: "superpowers@claude-plugins-official",
        status: "installed",
        message: null,
        detail: null,
      },
    ]);
    await setPluginEnabled("superpowers", true);
    expect(useSettingsStore.getState().pluginInstallState.superpowers).toBeUndefined();
  });

  it("won't claim success for a plugin the pass never mentioned", async () => {
    // An outcome list that omits this plugin means the pass never considered it (a stale config
    // layer would do it). We can't see it installed, so we must not render the row as fine.
    vi.mocked(ensureDefaultPluginsInstalled).mockResolvedValueOnce([]);
    await setPluginEnabled("frontendDesign", true);
    expect(useSettingsStore.getState().pluginInstallState.frontendDesign).toMatch(
      /didn't report on it/,
    );
  });

  it("clears the row hint when the plugin was already present", async () => {
    // The common steady state, and the one that must NOT read as a problem.
    vi.mocked(ensureDefaultPluginsInstalled).mockResolvedValueOnce([
      {
        key: "superpowers",
        id: "superpowers@claude-plugins-official",
        status: "alreadyPresent",
        message: null,
        detail: null,
      },
    ]);
    await setPluginEnabled("superpowers", true);
    expect(useSettingsStore.getState().pluginInstallState.superpowers).toBeUndefined();
  });

  it("applies EVERY returned outcome, not just the toggled row's", async () => {
    // The pass reports on all enabled plugins, so it can newly discover that another row is broken.
    // Discarding that leaves the other row showing a stale value with the answer already in hand.
    vi.mocked(ensureDefaultPluginsInstalled).mockResolvedValueOnce([
      {
        key: "superpowers",
        id: "superpowers@claude-plugins-official",
        status: "installed",
        message: null,
        detail: null,
      },
      {
        key: "frontend_design",
        id: "frontend-design@claude-plugins-official",
        status: "failed",
        message: "Sparkle couldn't install this plugin. Check your connection.",
        detail: null,
      },
    ]);
    await setPluginEnabled("superpowers", true);
    expect(useSettingsStore.getState().pluginInstallState.superpowers).toBeUndefined();
    expect(useSettingsStore.getState().pluginInstallState.frontendDesign).toMatch(
      /couldn't install/,
    );
  });

  it("won't render an unrecognized status as success", async () => {
    // A future Rust status this build doesn't know about must fall through to a hint, not to null.
    vi.mocked(ensureDefaultPluginsInstalled).mockResolvedValueOnce([
      {
        key: "superpowers",
        id: "superpowers@claude-plugins-official",
        status: "somethingNew" as unknown as "failed",
        message: null,
        detail: null,
      },
    ]);
    await setPluginEnabled("superpowers", true);
    expect(useSettingsStore.getState().pluginInstallState.superpowers).toMatch(
      /couldn't confirm/,
    );
  });

  it("shows 'installing' while the fetch is outstanding and clears it on success", async () => {
    let release: (v: PluginInstallOutcome[]) => void = () => {};
    vi.mocked(ensureDefaultPluginsInstalled).mockReturnValueOnce(
      new Promise<PluginInstallOutcome[]>((r) => {
        release = r;
      }),
    );
    const pending = setPluginEnabled("frontendDesign", true);
    // One turn for the config write to settle — the install starts after it lands.
    await vi.waitFor(() =>
      expect(useSettingsStore.getState().pluginInstallState.frontendDesign).toBe("installing"),
    );
    // ...and it STAYS "installing" while the fetch is outstanding. A cold marketplace clone can
    // take seconds to minutes; the row must say so rather than looking idle.
    expect(useSettingsStore.getState().pluginInstallState.frontendDesign).toBe("installing");
    release([
      {
        key: "frontend_design",
        id: "frontend-design@claude-plugins-official",
        status: "installed",
        message: null,
        detail: null,
      },
    ]);
    await pending;
    expect(useSettingsStore.getState().pluginInstallState.frontendDesign).toBeUndefined();
  });

  it("clears any stale install state when the plugin is toggled back off", async () => {
    useSettingsStore.getState().setPluginInstallState("superpowers", "some old failure");
    await setPluginEnabled("superpowers", false);
    expect(useSettingsStore.getState().pluginInstallState.superpowers).toBeUndefined();
  });
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
    expect([
      s.aiAutoRename,
      s.cloudDictation,
      s.aiComposer,
      s.aiSuggestedActions,
      s.aiAutoApprove,
      s.aiConcierge,
    ]).toEqual([false, false, false, false, false, false]);
    // A single batched write — not separate ones (the anti-flicker fix).
    expect(setConfigValues).toHaveBeenCalledTimes(1);
    expect(setConfigValue).not.toHaveBeenCalled();
    expect(setConfigValues).toHaveBeenCalledWith({
      "ai.auto_rename": false,
      "ai.voice_dictation": false,
      "ai.composer": false,
      "ai.suggested_actions": false,
      "ai.auto_approve": false,
      "ai.concierge": false,
    });
  });

  describe("setAutoApprovePreset", () => {
    beforeEach(() => {
      // Start from a clean approvals map so a preset is applied against no prior rules.
      useSettingsStore.setState({ approvals: {} });
    });

    it("'full' sets every category to 'always' in the store and in ONE atomic write", async () => {
      await setAutoApprovePreset("full");
      const map = useSettingsStore.getState().approvals;
      for (const cat of APPROVAL_CATEGORIES) expect(map[cat]).toBe("always");
      expect(setConfigValues).toHaveBeenCalledTimes(1);
      expect(setConfigValues).toHaveBeenCalledWith({
        "approvals.skill": "always",
        "approvals.bash": "always",
        "approvals.edit": "always",
        "approvals.mcp": "always",
        "approvals.fetch": "always",
        "approvals.other": "always",
      });
      // Full includes commands, so nothing is unset.
      expect(unsetConfigValue).not.toHaveBeenCalled();
    });

    it("'except-bash' auto-approves the five non-bash categories and CLEARS the bash rule", async () => {
      await setAutoApprovePreset("except-bash");
      const map = useSettingsStore.getState().approvals;
      // bash stays unset so commands keep prompting; everything else is auto-approved.
      expect(map.bash).toBeUndefined();
      for (const cat of APPROVAL_CATEGORIES.filter((c) => c !== "bash")) {
        expect(map[cat]).toBe("always");
      }
      expect(setConfigValues).toHaveBeenCalledWith({
        "approvals.skill": "always",
        "approvals.edit": "always",
        "approvals.mcp": "always",
        "approvals.fetch": "always",
        "approvals.other": "always",
      });
      // bash must be explicitly removed from the file (not written as a value).
      expect(unsetConfigValue).toHaveBeenCalledWith("approvals.bash");
    });

    it("'except-bash' clears a pre-existing bash='always' rule so commands ask again", async () => {
      useSettingsStore.setState({ approvals: { bash: "always" } });
      await setAutoApprovePreset("except-bash");
      expect(useSettingsStore.getState().approvals.bash).toBeUndefined();
    });

    it("a write failure is swallowed but the optimistic map stays", async () => {
      (setConfigValues as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("no ipc"));
      await setAutoApprovePreset("full");
      expect(useSettingsStore.getState().approvals.bash).toBe("always");
    });

    it("'except-bash' does the bash unset FIRST — if it fails, the five approvals are NOT written", async () => {
      // The bash unset is the safety-relevant write (drop a command-approval rule). It runs first, so
      // a failure there bails before adding the five conveniences — the safe under-approve direction.
      (unsetConfigValue as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("no ipc"));
      await setAutoApprovePreset("except-bash");
      expect(unsetConfigValue).toHaveBeenCalledWith("approvals.bash");
      expect(setConfigValues).not.toHaveBeenCalled();
      // Optimistic store still reflects the intended end state; a later hydrate reconciles to the file.
      expect(useSettingsStore.getState().approvals.bash).toBeUndefined();
    });
  });

  it("setMaxConcurrentWorkers clamps to >= 1 in both the store and the write", async () => {
    await setMaxConcurrentWorkers(0);
    expect(useSettingsStore.getState().maxConcurrentWorkers).toBe(1);
    expect(setConfigValue).toHaveBeenCalledWith("workers.max_concurrent", 1);
  });

  it("a write failure is swallowed but the optimistic store update stays", async () => {
    (setConfigValue as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("no ipc"));
    await setAiFeature("composer", false);
    expect(useSettingsStore.getState().aiComposer).toBe(false);
  });

  it("a bulk write failure is swallowed but all optimistic flags stay", async () => {
    (setConfigValues as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("no ipc"));
    await setAllAiFeatures(false);
    const s = useSettingsStore.getState();
    expect([s.aiAutoRename, s.cloudDictation, s.aiComposer]).toEqual([false, false, false]);
  });

  describe("setRoborevEnabled", () => {
    beforeEach(() => {
      // Seed two projects so the hook sweep has real root paths to cover. Only rootPath matters to
      // setRoborevEnabled, so a partial Project shape (cast through unknown) is enough here.
      useProjectStore.setState({
        projects: [
          { id: "p1", name: "One", rootPath: "/repo/one", agents: [] },
          { id: "p2", name: "Two", rootPath: "/repo/two", agents: [] },
        ],
      } as unknown as Partial<ReturnType<typeof useProjectStore.getState>>);
    });

    it("turning ON: optimistic store + config write, then installs daemon + wires every repo's hooks", async () => {
      useSettingsStore.setState({ roborevEnabled: false });
      await setRoborevEnabled(true);
      expect(useSettingsStore.getState().roborevEnabled).toBe(true);
      expect(setConfigValue).toHaveBeenCalledWith("tools.roborev", true);
      expect(installRoborev).toHaveBeenCalledTimes(1);
      expect(deactivateRoborev).not.toHaveBeenCalled();
      expect(installRepoHooks).toHaveBeenCalledWith("/repo/one");
      expect(installRepoHooks).toHaveBeenCalledWith("/repo/two");
      expect(removeRepoHooks).not.toHaveBeenCalled();
    });

    it("turning OFF: optimistic store + config write, then deactivates daemon + removes every repo's hooks", async () => {
      useSettingsStore.setState({ roborevEnabled: true });
      await setRoborevEnabled(false);
      expect(useSettingsStore.getState().roborevEnabled).toBe(false);
      expect(setConfigValue).toHaveBeenCalledWith("tools.roborev", false);
      expect(deactivateRoborev).toHaveBeenCalledTimes(1);
      expect(installRoborev).not.toHaveBeenCalled();
      expect(removeRepoHooks).toHaveBeenCalledWith("/repo/one");
      expect(removeRepoHooks).toHaveBeenCalledWith("/repo/two");
      expect(installRepoHooks).not.toHaveBeenCalled();
    });

    it("turning ON with a passing self-test clears any previous auth warning", async () => {
      useSettingsStore.setState({ roborevEnabled: false, roborevAuthWarning: "stale warning" });
      await setRoborevEnabled(true);
      expect(useSettingsStore.getState().roborevAuthWarning).toBeNull();
    });

    // The whole point of the self-test: a daemon that can't authenticate must never leave the
    // toggle reading "on", because it would run happily and review nothing.
    it.each([["ClaudeMissing"], ["NotAuthenticated"], ["NotInstalled"]])(
      "turning ON with a %s verdict reverts to OFF, tears the daemon down, and explains why",
      async (kind) => {
        vi.mocked(roborevAuthSelftest).mockResolvedValueOnce({
          kind,
        } as Awaited<ReturnType<typeof roborevAuthSelftest>>);
        useSettingsStore.setState({ roborevEnabled: false, roborevAuthWarning: null });

        await setRoborevEnabled(true);

        expect(useSettingsStore.getState().roborevEnabled).toBe(false);
        expect(setConfigValue).toHaveBeenCalledWith("tools.roborev", false);
        expect(deactivateRoborev).toHaveBeenCalledTimes(1);
        // Hooks must NOT be wired: they'd enqueue reviews that can never run.
        expect(installRepoHooks).not.toHaveBeenCalled();
        expect(useSettingsStore.getState().roborevAuthWarning).toBeTruthy();
      },
    );

    it("turning ON with an inconclusive probe stays ON but warns (uncertainty must not block a working setup)", async () => {
      vi.mocked(roborevAuthSelftest).mockResolvedValueOnce(undefined);
      useSettingsStore.setState({ roborevEnabled: false, roborevAuthWarning: null });

      await setRoborevEnabled(true);

      expect(useSettingsStore.getState().roborevEnabled).toBe(true);
      expect(installRepoHooks).toHaveBeenCalledWith("/repo/one");
      expect(useSettingsStore.getState().roborevAuthWarning).toBeTruthy();
    });

    it("turning OFF clears the auth warning", async () => {
      useSettingsStore.setState({ roborevEnabled: true, roborevAuthWarning: "some warning" });
      await setRoborevEnabled(false);
      expect(useSettingsStore.getState().roborevAuthWarning).toBeNull();
    });
  });

  describe("setDrainerEnabled", () => {
    // This describe asserts .not.toHaveBeenCalled() across ordered cases, so call history must be
    // cleared between them (the configActions describe has no blanket beforeEach). clearAllMocks
    // keeps the mock implementations, only the recorded calls are dropped.
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("turning ON: optimistic store + config write, then installs the launchd supervisor", async () => {
      useSettingsStore.setState({ drainerEnabled: false });
      await setDrainerEnabled(true);
      expect(useSettingsStore.getState().drainerEnabled).toBe(true);
      expect(setConfigValue).toHaveBeenCalledWith("drainer.enabled", true);
      // The ACTUAL side effect: the launchd install/uninstall command runs with the same value.
      expect(ensureBacklogDrainer).toHaveBeenCalledWith(true);
    });

    it("turning OFF: optimistic store + config write, then uninstalls the supervisor", async () => {
      useSettingsStore.setState({ drainerEnabled: true });
      await setDrainerEnabled(false);
      expect(useSettingsStore.getState().drainerEnabled).toBe(false);
      expect(setConfigValue).toHaveBeenCalledWith("drainer.enabled", false);
      expect(ensureBacklogDrainer).toHaveBeenCalledWith(false);
    });

    it("turning ON with a failed config write short-circuits AND reverts the row", async () => {
      // ON is a START: if the write the next launch reads didn't land, we must not chase it with an
      // install the file won't corroborate — and the row must not keep asserting ON.
      vi.mocked(setConfigValue).mockRejectedValueOnce(new Error("disk full"));
      useSettingsStore.setState({ drainerEnabled: false });
      await setDrainerEnabled(true);
      expect(ensureBacklogDrainer).not.toHaveBeenCalled();
      expect(useSettingsStore.getState().drainerEnabled).toBe(false); // reverted to persisted value
    });

    it("turning OFF with a failed config write STILL uninstalls AND reverts the row (no silent un-kill)", async () => {
      // The dangerous half: a failed write on OFF must NOT leave the supervisor live while the UI
      // reads off. Stopping is safe regardless of the write, so the uninstall runs; and the row is
      // reverted to the persisted ON so it can't silently re-enable at next launch behind an OFF UI.
      vi.mocked(setConfigValue).mockRejectedValueOnce(new Error("disk full"));
      useSettingsStore.setState({ drainerEnabled: true });
      await setDrainerEnabled(false);
      expect(ensureBacklogDrainer).toHaveBeenCalledWith(false);
      expect(useSettingsStore.getState().drainerEnabled).toBe(true); // reverted: UI matches persisted state
    });
  });

  // The toggle gate alone leaves the two commonest states unchecked: tools.roborev DEFAULTS TO ON
  // and is persisted, so a fresh install and every restart never cross an OFF→ON edge. Without a
  // startup probe those users are back to a silently-broken daemon that looks healthy.
  describe("refreshRoborevAuth (startup probe)", () => {
    it("probes and warns when roborev is already ON without ever being toggled", async () => {
      vi.mocked(roborevAuthSelftest).mockResolvedValueOnce({ kind: "NotAuthenticated" });
      useSettingsStore.setState({ roborevEnabled: true, roborevAuthWarning: null });

      await refreshRoborevAuth();

      expect(roborevAuthSelftest).toHaveBeenCalledTimes(1);
      expect(useSettingsStore.getState().roborevAuthWarning).toContain(CLAUDE_LOGIN_COMMAND);
    });

    it("clears a stale warning when the probe now passes", async () => {
      vi.mocked(roborevAuthSelftest).mockResolvedValueOnce({ kind: "Passed" });
      useSettingsStore.setState({ roborevEnabled: true, roborevAuthWarning: "stale" });

      await refreshRoborevAuth();

      expect(useSettingsStore.getState().roborevAuthWarning).toBeNull();
    });

    it("warns but does NOT flip the toggle off (a transient launch failure must not disable it)", async () => {
      vi.mocked(roborevAuthSelftest).mockResolvedValueOnce({ kind: "ClaudeMissing" });
      useSettingsStore.setState({ roborevEnabled: true, roborevAuthWarning: null });

      await refreshRoborevAuth();

      expect(useSettingsStore.getState().roborevEnabled).toBe(true);
      expect(setConfigValue).not.toHaveBeenCalled();
      expect(deactivateRoborev).not.toHaveBeenCalled();
      expect(useSettingsStore.getState().roborevAuthWarning).toBeTruthy();
    });

    it("drops its result if roborev was turned off while the probe was in flight", async () => {
      // The probe can take ~90s. Resolve it only AFTER flipping the toggle off, so a late result
      // can't warn about a feature that's no longer enabled (or clobber the toggle's cleared state).
      let resolveProbe: (v: { kind: "NotAuthenticated" }) => void = () => {};
      vi.mocked(roborevAuthSelftest).mockReturnValueOnce(
        new Promise((r) => {
          resolveProbe = r;
        }),
      );
      useSettingsStore.setState({ roborevEnabled: true, roborevAuthWarning: null });

      const inFlight = refreshRoborevAuth();
      useSettingsStore.setState({ roborevEnabled: false });
      resolveProbe({ kind: "NotAuthenticated" });
      await inFlight;

      expect(useSettingsStore.getState().roborevAuthWarning).toBeNull();
    });

    it("doesn't probe at all when roborev is off", async () => {
      useSettingsStore.setState({ roborevEnabled: false, roborevAuthWarning: "stale" });
      await refreshRoborevAuth();
      expect(roborevAuthSelftest).not.toHaveBeenCalled();
      expect(useSettingsStore.getState().roborevAuthWarning).toBeNull();
    });
  });

  describe("authWarningFor", () => {
    it("is silent only for a confirmed pass", () => {
      expect(authWarningFor({ kind: "Passed" })).toBeNull();
    });

    it("never stays silent about a state where reviews can't happen", () => {
      // Including `undefined` (probe didn't run) and Unknown: an unverified daemon is precisely the
      // invisible-failure case, so it must still say something.
      const verdicts = [
        { kind: "NotInstalled" as const },
        { kind: "ClaudeMissing" as const },
        { kind: "NotAuthenticated" as const },
        { kind: "Unknown" as const, detail: "weird output" },
        undefined,
      ];
      for (const v of verdicts) {
        expect(authWarningFor(v), `verdict ${JSON.stringify(v)}`).toBeTruthy();
      }
    });

    it("tells the user the specific fix for each confident failure", () => {
      expect(authWarningFor({ kind: "NotInstalled" })).toContain("isn't installed");
      expect(authWarningFor({ kind: "ClaudeMissing" })).toContain("Install Claude Code");
      expect(authWarningFor({ kind: "NotAuthenticated" })).toContain("claude auth login");
    });

    it("names a command that EXISTS — never the non-existent `claude login` (sparkle-gwkui)", () => {
      // A remedy string is an instruction the user will follow. Both of these told people to run
      // `claude login`, which the CLI has no such subcommand for — following it left them exactly
      // as unauthenticated as before. Assert the bad form is gone, not merely that the good form is
      // present: "claude auth login" contains neither "claude login" nor a bare trailing "login".
      for (const v of [{ kind: "NotAuthenticated" as const }, undefined]) {
        const msg = authWarningFor(v) ?? "";
        expect(msg, `verdict ${JSON.stringify(v)}`).toContain(CLAUDE_LOGIN_COMMAND);
        expect(msg, `verdict ${JSON.stringify(v)}`).not.toContain("`claude login`");
      }
    });
  });

  it("markRoborevConsentPrompted flips the store flag and writes the consent path", async () => {
    useSettingsStore.setState({ roborevConsentPrompted: false });
    await markRoborevConsentPrompted();
    expect(useSettingsStore.getState().roborevConsentPrompted).toBe(true);
    expect(setConfigValue).toHaveBeenCalledWith("roborev.consent_prompted", true);
  });

  it("setImprovementConsent mirrors the mode to [improvement].consent and updates the store", async () => {
    useSettingsStore.setState({ sparkleImprovementConsent: "case_by_case" });
    await setImprovementConsent("always");
    // The whole point of the mirror: the chosen mode is written to the file under the snake_case
    // dotted path so a headless agent can read it.
    expect(setConfigValue).toHaveBeenCalledWith("improvement.consent", "always");
    // ...and the store is updated optimistically for an instant UI response.
    expect(useSettingsStore.getState().sparkleImprovementConsent).toBe("always");
  });

  it("setImprovementConsent keeps the optimistic store value when the config write fails", async () => {
    vi.mocked(setConfigValue).mockRejectedValueOnce(new Error("disk full"));
    useSettingsStore.setState({ sparkleImprovementConsent: "case_by_case" });
    await setImprovementConsent("never");
    // A failed file write is non-fatal — the optimistic update stands (the next hydrate reconciles).
    expect(useSettingsStore.getState().sparkleImprovementConsent).toBe("never");
  });

  // The back-fill closes the gap the writer above cannot: setImprovementConsent only fires on a
  // CHANGE, so a choice made before the mirror existed (or whose single write failed) lives in
  // localStorage while the file has no [improvement] section — and hydrate refuses to reconcile
  // that direction on purpose. Headless readers gate fail-closed on the file, so the user's
  // "always" reads as no-consent until something writes it. These assert the WRITE, not the state.
  describe("backfillImprovementConsentMirror", () => {
    // The helper takes the one field it reads, so these cases pass it directly — no synthetic
    // partial EffectiveConfig and no `as unknown` cast standing between the test and the contract.
    const effWith = (consent: string | null | undefined) => consent;

    it("writes the persisted choice when the file has no [improvement] section", async () => {
      useSettingsStore.setState({ sparkleImprovementConsent: "always" });
      await backfillImprovementConsentMirror(effWith(undefined));
      expect(setConfigValue).toHaveBeenCalledWith("improvement.consent", "always");
    });

    it("writes the persisted choice when the section exists but consent is null", async () => {
      // A backend that sends the section with an unset value is the same gap, not a written choice.
      useSettingsStore.setState({ sparkleImprovementConsent: "never" });
      await backfillImprovementConsentMirror(effWith(null));
      expect(setConfigValue).toHaveBeenCalledWith("improvement.consent", "never");
    });

    it("does not write when the file already carries a value", async () => {
      // The file is the source of truth. Writing here would let a stale store overwrite a value
      // the user (or a hand-edit) just put in the file.
      useSettingsStore.setState({ sparkleImprovementConsent: "always" });
      await backfillImprovementConsentMirror(effWith("never"));
      expect(setConfigValue).not.toHaveBeenCalled();
    });

    it("does not write when the persisted choice is the default", async () => {
      // An absent section already MEANS case_by_case, so writing it records a choice the user
      // never made while changing nothing.
      useSettingsStore.setState({ sparkleImprovementConsent: DEFAULT_SPARKLE_CONSENT });
      await backfillImprovementConsentMirror(effWith(undefined));
      expect(setConfigValue).not.toHaveBeenCalled();
    });

    it("treats an explicit empty-string consent as WRITTEN, not as absent", async () => {
      // The fail-closed case, and the one direction this back-fill must never move. `""` is falsy,
      // so a truthiness guard read it as "no value present" and overwrote it with the persisted
      // "always" — after which every headless reader (each gating on `=== "always"`) starts
      // forwarding retro data the file currently forbids. Writing `""` is how someone pins the
      // mirror shut, since it matches no reader; silently upgrading it inverts that choice.
      useSettingsStore.setState({ sparkleImprovementConsent: "always" });
      await backfillImprovementConsentMirror(effWith(""));
      expect(setConfigValue).not.toHaveBeenCalled();
    });

    it("survives a failed write and leaves the store alone", async () => {
      vi.mocked(setConfigValue).mockRejectedValueOnce(new Error("disk full"));
      useSettingsStore.setState({ sparkleImprovementConsent: "always" });
      await expect(backfillImprovementConsentMirror(effWith(undefined))).resolves.toBeUndefined();
      // Self-healing rather than fatal: the next launch re-runs the same back-fill.
      expect(useSettingsStore.getState().sparkleImprovementConsent).toBe("always");
    });
  });

  // The one non-obvious invariant of the 1Password write path: a blank vault UNSETS the key rather
  // than writing `vault_id = ""`. Rust reads a blank vault as "not chosen", so a stale empty string
  // would misrepresent the file as configured — and nothing else pins that.
  describe("1Password write-back", () => {
    beforeEach(() => {
      useSettingsStore.setState({
        onepasswordVaultId: null,
        onepasswordAccountId: null,
        onepasswordSeedWorktrees: false,
      });
    });
    afterEach(() => {
      // `vi.clearAllMocks()` does NOT drain a queued `mockRejectedValueOnce`, and these fields are
      // module-global: leave either behind and an unrelated describe later in the file fails with
      // "disk full" or reads a stale vault.
      vi.mocked(setConfigValue).mockReset().mockResolvedValue(undefined);
      useSettingsStore.setState({
        onepasswordVaultId: null,
        onepasswordAccountId: null,
        onepasswordSeedWorktrees: false,
      });
    });

    it("persists a trimmed vault id and updates the store optimistically", async () => {
      await setOnePasswordVault("  v1  ");
      expect(setConfigValue).toHaveBeenCalledWith("onepassword.vault_id", "v1");
      expect(unsetConfigValue).not.toHaveBeenCalled();
      expect(useSettingsStore.getState().onepasswordVaultId).toBe("v1");
    });

    it("UNSETS the key for a null vault rather than writing an empty string", async () => {
      await setOnePasswordVault(null);
      expect(unsetConfigValue).toHaveBeenCalledWith("onepassword.vault_id");
      expect(setConfigValue).not.toHaveBeenCalled();
      expect(useSettingsStore.getState().onepasswordVaultId).toBeNull();
    });

    it("treats a whitespace-only vault the same as null", async () => {
      await setOnePasswordVault("   ");
      expect(unsetConfigValue).toHaveBeenCalledWith("onepassword.vault_id");
      expect(setConfigValue).not.toHaveBeenCalled();
      expect(useSettingsStore.getState().onepasswordVaultId).toBeNull();
    });

    it("persists a trimmed account id and updates the store optimistically", async () => {
      // The user_uuid, not the email: two signed-in accounts can share an email, and `op` answers
      // an ambiguous handle with the same "multiple accounts found" the choice exists to end.
      await setOnePasswordAccount("  NZ36HQYBEVBWZMSWZLH77XMFJA  ");
      expect(setConfigValue).toHaveBeenCalledWith(
        "onepassword.account_id",
        "NZ36HQYBEVBWZMSWZLH77XMFJA",
      );
      expect(unsetConfigValue).not.toHaveBeenCalled();
      expect(useSettingsStore.getState().onepasswordAccountId).toBe("NZ36HQYBEVBWZMSWZLH77XMFJA");
    });

    it("UNSETS the account key rather than writing an empty string", async () => {
      // A stored `account_id = ""` would be passed as `--account ""` on every op invocation —
      // failing everything instead of degrading to "let `op` decide".
      await setOnePasswordAccount("   ");
      expect(unsetConfigValue).toHaveBeenCalledWith("onepassword.account_id");
      expect(setConfigValue).not.toHaveBeenCalled();
      expect(useSettingsStore.getState().onepasswordAccountId).toBeNull();
    });

    it("writes both directions of the worktree-seeding consent", async () => {
      await setOnePasswordSeedWorktrees(true);
      expect(setConfigValue).toHaveBeenCalledWith("onepassword.seed_worktrees", true);
      expect(useSettingsStore.getState().onepasswordSeedWorktrees).toBe(true);

      await setOnePasswordSeedWorktrees(false);
      expect(setConfigValue).toHaveBeenCalledWith("onepassword.seed_worktrees", false);
      expect(useSettingsStore.getState().onepasswordSeedWorktrees).toBe(false);
    });

    it("keeps the optimistic store update when the config write fails", async () => {
      // The pane must not appear to forget the vault the user just picked because the file write
      // lost a race; the next hydrate is what corrects a genuinely failed write.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        vi.mocked(setConfigValue).mockRejectedValueOnce(new Error("disk full"));
        await setOnePasswordVault("v9");
        expect(useSettingsStore.getState().onepasswordVaultId).toBe("v9");
        expect(warn).toHaveBeenCalled();
      } finally {
        // A failed assertion above must not leave the spy installed for the rest of the file.
        warn.mockRestore();
      }
    });
  });

  describe("setResumeRule", () => {
    const ROOT = "/repo";
    beforeEach(() => {
      useSettingsStore.setState({ resumeRule: "ask" });
      useApprovalsStore.setState({ resumeByRoot: {} });
    });

    it("global summary/full writes approvals.resume; global 'ask' clears it (the default)", async () => {
      await setResumeRule("summary", "global", null);
      expect(useSettingsStore.getState().resumeRule).toBe("summary");
      expect(setConfigValue).toHaveBeenCalledWith("approvals.resume", "summary");

      await setResumeRule("ask", "global", null);
      expect(useSettingsStore.getState().resumeRule).toBe("ask");
      expect(unsetConfigValue).toHaveBeenCalledWith("approvals.resume");
    });

    it("project summary/full writes the project's approvals.resume", async () => {
      await setResumeRule("full", "project", ROOT);
      expect(useApprovalsStore.getState().resumeByRoot[ROOT]).toBe("full");
      expect(setProjectConfigValue).toHaveBeenCalledWith(ROOT, "approvals.resume", "full");
    });

    it("project 'ask' writes an EXPLICIT ask when the global rule auto-resumes (per-project opt-out)", async () => {
      useSettingsStore.setState({ resumeRule: "summary" }); // global auto-resumes
      await setResumeRule("ask", "project", ROOT);
      // The project must be able to override a global summary/full — so an explicit "ask" is persisted.
      expect(setProjectConfigValue).toHaveBeenCalledWith(ROOT, "approvals.resume", "ask");
      expect(unsetProjectConfigValue).not.toHaveBeenCalled();
      expect(useApprovalsStore.getState().resumeByRoot[ROOT]).toBe("ask");
    });

    it("project 'ask' clears the key when the global rule is already 'ask' (nothing to override)", async () => {
      useSettingsStore.setState({ resumeRule: "ask" });
      await setResumeRule("ask", "project", ROOT);
      expect(unsetProjectConfigValue).toHaveBeenCalledWith(ROOT, "approvals.resume");
      expect(setProjectConfigValue).not.toHaveBeenCalled();
    });

    it("falls back to global scope when a project write has no projectRoot", async () => {
      await setResumeRule("summary", "project", null);
      expect(setConfigValue).toHaveBeenCalledWith("approvals.resume", "summary");
      expect(setProjectConfigValue).not.toHaveBeenCalled();
    });
  });
});

describe("setToolEnabled — the [tools] flags", () => {
  it("persists humanebench to tools.humanebench and flips the store optimistically", () => {
    // The dotted path is the whole contract: a wrong leaf writes a key Rust's PartialTools does
    // not claim, which parses fine, applies nothing, and is reported only as an ignored key. The
    // switch still moves, so the row looks like it works and the gate silently stays on.
    useSettingsStore.setState({ humanebenchEnabled: true });
    const pending = setToolEnabled("humanebench", false);
    // Optimistic: already flipped, without waiting on IPC.
    expect(useSettingsStore.getState().humanebenchEnabled).toBe(false);
    expect(setConfigValue).toHaveBeenCalledWith("tools.humanebench", false);
    return pending;
  });

  it("writes the same path turning it back ON", () => {
    vi.mocked(setConfigValue).mockClear();
    const pending = setToolEnabled("humanebench", true);
    expect(useSettingsStore.getState().humanebenchEnabled).toBe(true);
    expect(setConfigValue).toHaveBeenCalledWith("tools.humanebench", true);
    return pending;
  });
});

describe("setBuilderIndexEnabled", () => {
  beforeEach(() => {
    useSettingsStore.setState({ builderIndexEnabled: false, builderIndexModalOpen: false });
  });

  it("turning it ON opens the consent modal and writes NOTHING", async () => {
    // The whole point of the opt-in: a click on the switch must not be able to start publishing.
    // Only the modal's explicit confirmation writes tools.builder_index.
    await setBuilderIndexEnabled(true);
    expect(useSettingsStore.getState().builderIndexModalOpen).toBe(true);
    expect(useSettingsStore.getState().builderIndexEnabled).toBe(false);
    expect(setConfigValue).not.toHaveBeenCalled();
  });

  it("turning it OFF writes immediately, with no dialog in the way", async () => {
    useSettingsStore.setState({ builderIndexEnabled: true });
    await setBuilderIndexEnabled(false);
    expect(setConfigValue).toHaveBeenCalledWith("tools.builder_index", false);
    expect(useSettingsStore.getState().builderIndexEnabled).toBe(false);
    expect(useSettingsStore.getState().builderIndexModalOpen).toBe(false);
  });
});

describe("setStraudeEnabled", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      straudeEnabled: false,
      straudeModalOpen: false,
      builderIndexEnabled: false,
      builderIndexModalOpen: false,
    });
  });

  it("turning it ON opens the consent modal and writes NOTHING", async () => {
    // Same contract as the Builder Index: a click on the switch must not be able to start
    // publishing to a third party. Only the modal's explicit confirmation writes tools.straude.
    await setStraudeEnabled(true);
    expect(useSettingsStore.getState().straudeModalOpen).toBe(true);
    expect(useSettingsStore.getState().straudeEnabled).toBe(false);
    expect(setConfigValue).not.toHaveBeenCalled();
  });

  it("turning it OFF writes immediately, with no dialog in the way", async () => {
    useSettingsStore.setState({ straudeEnabled: true });
    await setStraudeEnabled(false);
    expect(setConfigValue).toHaveBeenCalledWith("tools.straude", false);
    expect(useSettingsStore.getState().straudeEnabled).toBe(false);
    expect(useSettingsStore.getState().straudeModalOpen).toBe(false);
  });

  // THE INDEPENDENCE PROPERTY, in the layer that could most easily break it. These are competing
  // leaderboards, so one destination's toggle touching the other's flag or modal would be a silent
  // third-party egress the user never answered a consent screen for.
  it("neither destination's toggle disturbs the other", async () => {
    await setStraudeEnabled(true);
    expect(useSettingsStore.getState().builderIndexModalOpen).toBe(false);
    expect(useSettingsStore.getState().builderIndexEnabled).toBe(false);

    useSettingsStore.setState({ straudeModalOpen: false });
    await setBuilderIndexEnabled(true);
    expect(useSettingsStore.getState().straudeModalOpen).toBe(false);
    expect(useSettingsStore.getState().straudeEnabled).toBe(false);

    useSettingsStore.setState({ straudeEnabled: true, builderIndexEnabled: true });
    await setStraudeEnabled(false);
    expect(setConfigValue).toHaveBeenCalledWith("tools.straude", false);
    expect(setConfigValue).not.toHaveBeenCalledWith("tools.builder_index", false);
    expect(useSettingsStore.getState().builderIndexEnabled).toBe(true);
  });
});

// The Concierge tools pane's two bulk gestures. What these pin is that each is ONE write — a
// permissions bulk applied key-by-key lets a config-changed hydrate land mid-bulk and revert the
// keys not yet written — and that the resulting state is legible per row afterwards.
describe("the concierge tool bulk actions", () => {
  beforeEach(() => {
    useSettingsStore.setState({ conciergeToolPolicy: {} });
  });

  it("allowAllConciergeTools writes an explicit allow for EVERY tool, in one atomic call", async () => {
    await allowAllConciergeTools();

    // One write, not 62 — and not the single-key setter.
    expect(setConfigValues).toHaveBeenCalledTimes(1);
    expect(setConfigValue).not.toHaveBeenCalled();
    expect(unsetConfigValue).not.toHaveBeenCalled();

    const written = vi.mocked(setConfigValues).mock.calls[0]![0];
    expect(Object.keys(written).length).toBe(CONCIERGE_TOOL_NAMES.length);
    for (const name of CONCIERGE_TOOL_NAMES) {
      expect(written[`${CONCIERGE_TOOLS_CONFIG_TABLE}.${name}`], name).toBe("allow");
    }
  });

  it("leaves EVERY row explicitly set, including the ones whose default was already allow", async () => {
    // The bulk grant's whole promise is that the result is undoable per row. A tool left implicit
    // because its derived default already said "allow" would render as "default" with no Reset —
    // two thirds of the pane telling the user it was decided for them right after they decided it.
    await allowAllConciergeTools();
    const policy = useSettingsStore.getState().conciergeToolPolicy;
    expect(Object.keys(policy).length).toBe(CONCIERGE_TOOL_NAMES.length);
    expect(new Set(Object.values(policy))).toEqual(new Set(["allow"]));
  });

  it("MERGES over a hand-edited key rather than dropping it", async () => {
    // config.toml is hand-editable, so the map can hold a key naming no tool. A bulk apply over the
    // catalog has no business silently discarding one.
    useSettingsStore.setState({ conciergeToolPolicy: { not_a_real_tool: "deny" } });
    await allowAllConciergeTools();
    expect(useSettingsStore.getState().conciergeToolPolicy.not_a_real_tool).toBe("deny");
  });

  it("resetAllConciergeTools clears the store and unsets the whole [concierge.tools] table", async () => {
    useSettingsStore.setState({
      conciergeToolPolicy: { merge_pr: "deny", quit_app: "allow", not_a_real_tool: "allwo" },
    });
    await resetAllConciergeTools();

    expect(useSettingsStore.getState().conciergeToolPolicy).toEqual({});
    // ONE unset of the table — not three unsets of its keys. Removing the table is also what takes
    // the unreadable hand-edited key with it; a "reset to defaults" that left a warning pill on a
    // row would not be a reset.
    expect(unsetConfigValue).toHaveBeenCalledTimes(1);
    expect(unsetConfigValue).toHaveBeenCalledWith(CONCIERGE_TOOLS_CONFIG_TABLE);
    expect(setConfigValue).not.toHaveBeenCalled();
    expect(setConfigValues).not.toHaveBeenCalled();
  });

  it("round-trips: allow everything, then reset, lands back on no rules at all", async () => {
    await allowAllConciergeTools();
    expect(Object.keys(useSettingsStore.getState().conciergeToolPolicy).length).toBeGreaterThan(0);
    await resetAllConciergeTools();
    expect(useSettingsStore.getState().conciergeToolPolicy).toEqual({});
  });

  it("ROLLS BACK a failed reset rather than reporting a revocation that didn't happen", async () => {
    // The unacceptable direction. Leaving the optimistic `{}` in place would render every row as
    // "default" — the pane reporting that authority was taken back — while config.toml still holds
    // the allow rules, including the irreversible ones. No config-changed fires on a rejected
    // write, so nothing would ever reconcile it; the grants come back silently on restart.
    const rules = { merge_pr: "allow", discard_agent: "allow" };
    useSettingsStore.setState({ conciergeToolPolicy: rules });
    vi.mocked(unsetConfigValue).mockRejectedValueOnce(new Error("read-only config"));

    await expect(resetAllConciergeTools()).resolves.toBeUndefined();
    expect(useSettingsStore.getState().conciergeToolPolicy).toEqual(rules);
  });

  it("rolls back a failed grant too, so no row claims a rule the file doesn't hold", async () => {
    useSettingsStore.setState({ conciergeToolPolicy: { merge_pr: "deny" } });
    vi.mocked(setConfigValues).mockRejectedValueOnce(new Error("disk full"));

    await expect(allowAllConciergeTools()).resolves.toBeUndefined();
    expect(useSettingsStore.getState().conciergeToolPolicy).toEqual({ merge_pr: "deny" });
  });

  it("does NOT roll back over an edit made while the bulk write was in flight", async () => {
    // That edit carried its own (successful) write, so restoring the pre-bulk snapshot over it
    // would discard a rule the file now holds — trading one mismatch for another.
    useSettingsStore.setState({ conciergeToolPolicy: {} });
    vi.mocked(setConfigValues).mockImplementationOnce(async () => {
      useSettingsStore.getState().setConciergeToolPolicy("merge_pr", "deny");
      throw new Error("disk full");
    });

    await allowAllConciergeTools();
    expect(useSettingsStore.getState().conciergeToolPolicy.merge_pr).toBe("deny");
  });
});
