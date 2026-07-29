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
import { ensureDefaultPluginsInstalled, type PluginInstallOutcome } from "./worktree";
import {
  setAiFeature,
  setAllAiFeatures,
  setAutoApprovePreset,
  setMaxConcurrentWorkers,
  setPluginEnabled,
  setRoborevEnabled,
  setResumeRule,
  authWarningFor,
  refreshRoborevAuth,
  markRoborevConsentPrompted,
  setImprovementConsent,
  setBuilderIndexEnabled,
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
import { useSettingsStore } from "../stores/settingsStore";
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

  // The toggle gate alone leaves the two commonest states unchecked: tools.roborev DEFAULTS TO ON
  // and is persisted, so a fresh install and every restart never cross an OFF→ON edge. Without a
  // startup probe those users are back to a silently-broken daemon that looks healthy.
  describe("refreshRoborevAuth (startup probe)", () => {
    it("probes and warns when roborev is already ON without ever being toggled", async () => {
      vi.mocked(roborevAuthSelftest).mockResolvedValueOnce({ kind: "NotAuthenticated" });
      useSettingsStore.setState({ roborevEnabled: true, roborevAuthWarning: null });

      await refreshRoborevAuth();

      expect(roborevAuthSelftest).toHaveBeenCalledTimes(1);
      expect(useSettingsStore.getState().roborevAuthWarning).toContain("claude login");
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
      expect(authWarningFor({ kind: "NotAuthenticated" })).toContain("claude login");
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

  // The one non-obvious invariant of the 1Password write path: a blank vault UNSETS the key rather
  // than writing `vault_id = ""`. Rust reads a blank vault as "not chosen", so a stale empty string
  // would misrepresent the file as configured — and nothing else pins that.
  describe("1Password write-back", () => {
    beforeEach(() => {
      useSettingsStore.setState({ onepasswordVaultId: null, onepasswordSeedWorktrees: false });
    });
    afterEach(() => {
      // `vi.clearAllMocks()` does NOT drain a queued `mockRejectedValueOnce`, and these fields are
      // module-global: leave either behind and an unrelated describe later in the file fails with
      // "disk full" or reads a stale vault.
      vi.mocked(setConfigValue).mockReset().mockResolvedValue(undefined);
      useSettingsStore.setState({ onepasswordVaultId: null, onepasswordSeedWorktrees: false });
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
