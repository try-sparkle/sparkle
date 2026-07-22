// @vitest-environment jsdom
//
// Tests for the config write-back actions: each optimistically updates the store AND persists to
// config.toml via the (mocked) config service. The bulk path must use a SINGLE atomic write.
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import {
  setConfigValue,
  setConfigValues,
  unsetConfigValue,
  setProjectConfigValue,
  unsetProjectConfigValue,
} from "./config";
import { roborevAuthSelftest } from "./roborev";
import {
  setAiFeature,
  setAllAiFeatures,
  setAutoApprovePreset,
  setMaxConcurrentWorkers,
  setRoborevEnabled,
  setResumeRule,
  authWarningFor,
  refreshRoborevAuth,
  markRoborevConsentPrompted,
} from "./configActions";
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
    ]).toEqual([false, false, false, false, false]);
    // A single batched write — not separate ones (the anti-flicker fix).
    expect(setConfigValues).toHaveBeenCalledTimes(1);
    expect(setConfigValue).not.toHaveBeenCalled();
    expect(setConfigValues).toHaveBeenCalledWith({
      "ai.auto_rename": false,
      "ai.voice_dictation": false,
      "ai.composer": false,
      "ai.suggested_actions": false,
      "ai.auto_approve": false,
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
    it.each([["ClaudeMissing"], ["NotAuthenticated"]])(
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
