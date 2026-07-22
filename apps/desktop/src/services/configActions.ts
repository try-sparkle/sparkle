// Write-back actions for the config-mirrored settings (concurrency + AI flags). The TOML file is
// the source of truth, so a UI change persists to the file via set_config_value; the resulting
// config-changed event re-hydrates the store (App.tsx). We ALSO update the store optimistically so
// the control responds instantly without waiting for the file round-trip.
//
// These live outside settingsStore so the store stays free of the Tauri runtime (it must stay
// testable under jsdom). Failures are non-fatal: the optimistic update already happened and the
// next hydrate reconciles with the file.
import {
  setConfigValue,
  setConfigValues,
  unsetConfigValue,
  setProjectConfigValue,
  unsetProjectConfigValue,
} from "./config";
import { useSettingsStore, type AiFeatureKey, type ToolKey } from "../stores/settingsStore";
import { useProjectStore } from "../stores/projectStore";
import {
  installRoborev,
  deactivateRoborev,
  installRepoHooks,
  removeRepoHooks,
  roborevAuthSelftest,
  type RoborevAuthVerdict,
} from "./roborev";
import { useApprovalsStore } from "../stores/approvalsStore";
import {
  DEFAULT_RESUME_RULE,
  type ApprovalCategory,
  type ApprovalRule,
  type ResumeRule,
} from "./suggestions/approvalCategories";
import { categoriesForPreset, type AutoApprovePreset } from "./autoApprovePreset";
import {
  DEFAULT_WAKE_WORD,
  DEFAULT_STOP_WORD,
  DEFAULT_PAUSE_ON_SUBMIT,
} from "../voice/voiceDefaults";

/** Menu feature key → its dotted config path under [ai]. */
const AI_CONFIG_PATH: Record<AiFeatureKey, string> = {
  autoRename: "ai.auto_rename",
  voiceDictation: "ai.voice_dictation",
  brainstorm: "ai.brainstorm",
  composer: "ai.composer",
  suggestedActions: "ai.suggested_actions",
  autoApprove: "ai.auto_approve",
};

/** Scope an approval rule is written to: the machine-wide global file or the current project's file. */
export type ApprovalScope = "global" | "project";

/** The dotted config path for a category's rule (same key in both the global + project files). */
function approvalPath(category: ApprovalCategory): string {
  return `approvals.${category}`;
}

/**
 * Set a category rule ("always"/"never") at the given scope: optimistic store update, then persist
 * to the correct config.toml (global vs the project's `.sparkle/config.toml`). A project write needs
 * `projectRoot`; without one it falls back to the global scope so the rule is never silently dropped.
 */
export async function setApprovalRule(
  category: ApprovalCategory,
  rule: ApprovalRule,
  scope: ApprovalScope,
  projectRoot: string | null,
): Promise<void> {
  if (scope === "project" && projectRoot) {
    useApprovalsStore.getState().setProjectApproval(projectRoot, category, rule);
    try {
      await setProjectConfigValue(projectRoot, approvalPath(category), rule);
    } catch (e) {
      console.warn("config write failed (approval project)", e);
    }
    return;
  }
  useSettingsStore.getState().setGlobalApproval(category, rule);
  try {
    await setConfigValue(approvalPath(category), rule);
  } catch (e) {
    console.warn("config write failed (approval global)", e);
  }
}

/**
 * Clear a category rule at the given scope: optimistic store update, then remove the key from the
 * matching config.toml. A project clear optimistically falls back to the current global rule (the
 * effective value once the project override is gone) so the UI never flashes an unset state that
 * the config round-trip then corrects.
 */
export async function clearApprovalRule(
  category: ApprovalCategory,
  scope: ApprovalScope,
  projectRoot: string | null,
): Promise<void> {
  if (scope === "project" && projectRoot) {
    const globalRule = useSettingsStore.getState().approvals[category] ?? null;
    useApprovalsStore.getState().setProjectApproval(projectRoot, category, globalRule);
    try {
      await unsetProjectConfigValue(projectRoot, approvalPath(category));
    } catch (e) {
      console.warn("config write failed (approval clear project)", e);
    }
    return;
  }
  useSettingsStore.getState().setGlobalApproval(category, null);
  try {
    await unsetConfigValue(approvalPath(category));
  } catch (e) {
    console.warn("config write failed (approval clear global)", e);
  }
}

/** Remove a category rule from BOTH scopes so the effective state is truly unset (the pane's
 *  "Remove"). Clears global + (if a project is in context) the project override. */
export async function removeApprovalRuleEverywhere(
  category: ApprovalCategory,
  projectRoot: string | null,
): Promise<void> {
  await clearApprovalRule(category, "global", projectRoot);
  if (projectRoot) await clearApprovalRule(category, "project", projectRoot);
}

/**
 * Apply an Auto-Approve quick preset to the GLOBAL (all-projects) `[approvals]` rules in one pass, so
 * the ⋯-menu sub-choice under "Auto-answer permission prompts" is a single click:
 *   - "full"        → every category set to "always" (commands included).
 *   - "except-bash" → every category EXCEPT bash set to "always"; the bash rule is CLEARED so commands
 *                     keep prompting. We clear it (ask + nudge), NOT set it to "never" — "never" would
 *                     mute commands silently, which is the opposite of "except bash".
 * Optimistic store update first (so the segment highlights instantly), then persist. "full" is a
 * single atomic setConfigValues (all six keys). "except-bash" is unavoidably TWO writes (there is no
 * bulk "unset"): the bash unset PLUS the five "always" keys — see the ordering note below. Global
 * scope only — matches the menu's "all projects" intent; per-category / per-project fine-tuning stays
 * in the Auto-approve pane. The master `ai.auto_approve` must be ON for any rule to fire — that is the
 * checkbox this control is nested under (see approvalsRuntime.maybeAutoApprove).
 */
export async function setAutoApprovePreset(preset: AutoApprovePreset): Promise<void> {
  const store = useSettingsStore.getState();
  const alwaysCats = categoriesForPreset(preset);
  // Optimistic: set the preset's categories to "always"; for except-bash also clear bash so it asks.
  for (const cat of alwaysCats) store.setGlobalApproval(cat, "always");
  if (preset === "except-bash") store.setGlobalApproval("bash", null);
  try {
    if (preset === "except-bash") {
      // Two writes (no bulk "unset"). Do the bash unset FIRST so that if only one lands, we've DROPPED
      // a command-approval rule rather than ADDED five approvals — the safe direction for a
      // permissions control. If this rejects we bail before writing the five, and a later
      // config-changed hydrate reconciles the optimistic store back to the file.
      await unsetConfigValue(approvalPath("bash"));
    }
    await setConfigValues(Object.fromEntries(alwaysCats.map((cat) => [approvalPath(cat), "always"])));
  } catch (e) {
    console.warn("config write failed (auto-approve preset)", e);
  }
}

/** The dotted config path for the session-resume rule (same key in both the global + project files).
 *  A SIBLING of the approval categories under the same `[approvals]` table. */
const RESUME_PATH = "approvals.resume";

/**
 * Set the session-resume rule at the given scope.
 *
 * Unlike the approval categories — which have a distinct `never` value to override a global
 * `always` — the resume rule's only "off" state is `ask`. So a project must be able to sit on an
 * EXPLICIT `ask` to opt out of a global `summary`/`full`; simply clearing the key would fold the
 * project back to the (auto-resuming) global rule and there'd be no way to make one project stop.
 * Therefore, at PROJECT scope, choosing `ask` writes an explicit `resume = "ask"` whenever the
 * global rule auto-resumes; only when the global rule is itself `ask` (nothing to override) do we
 * clear the key to keep config.toml clean. At GLOBAL scope, `ask` is the default so we clear it.
 * A project write needs `projectRoot`; without one it falls back to the global scope.
 */
export async function setResumeRule(
  rule: ResumeRule,
  scope: ApprovalScope,
  projectRoot: string | null,
): Promise<void> {
  if (scope === "project" && projectRoot) {
    if (rule === DEFAULT_RESUME_RULE) {
      const globalRule = useSettingsStore.getState().resumeRule;
      // Effective value for this project is "ask" either way; the cache reflects that immediately.
      useApprovalsStore.getState().setProjectResume(projectRoot, DEFAULT_RESUME_RULE);
      try {
        if (globalRule === DEFAULT_RESUME_RULE) {
          // Nothing to override — drop the project key so we don't litter config with the default.
          await unsetProjectConfigValue(projectRoot, RESUME_PATH);
        } else {
          // Global auto-resumes; persist an explicit project "ask" so THIS project still surfaces
          // the prompt. This is the per-project opt-out the resume rule otherwise couldn't express.
          await setProjectConfigValue(projectRoot, RESUME_PATH, DEFAULT_RESUME_RULE);
        }
      } catch (e) {
        console.warn("config write failed (resume ask project)", e);
      }
      return;
    }
    useApprovalsStore.getState().setProjectResume(projectRoot, rule);
    try {
      await setProjectConfigValue(projectRoot, RESUME_PATH, rule);
    } catch (e) {
      console.warn("config write failed (resume project)", e);
    }
    return;
  }
  if (rule === DEFAULT_RESUME_RULE) {
    useSettingsStore.getState().setGlobalResume(DEFAULT_RESUME_RULE);
    try {
      await unsetConfigValue(RESUME_PATH);
    } catch (e) {
      console.warn("config write failed (resume clear global)", e);
    }
    return;
  }
  useSettingsStore.getState().setGlobalResume(rule);
  try {
    await setConfigValue(RESUME_PATH, rule);
  } catch (e) {
    console.warn("config write failed (resume global)", e);
  }
}

/** Toggle one AI feature: optimistic store update, then persist to config.toml. */
export async function setAiFeature(key: AiFeatureKey, on: boolean): Promise<void> {
  useSettingsStore.getState().setAiFeature(key, on);
  try {
    await setConfigValue(AI_CONFIG_PATH[key], on);
  } catch (e) {
    console.warn("config write failed (ai feature)", e);
  }
}

/** Tool key → its dotted config path under [tools]. */
const TOOLS_CONFIG_PATH: Record<ToolKey, string> = {
  analytics: "tools.analytics",
  beads: "tools.beads",
  github: "tools.github",
  guardrails: "tools.guardrails",
  roborev: "tools.roborev",
};

/** Toggle one [tools] flag: optimistic store update, then persist to config.toml. */
export async function setToolEnabled(key: ToolKey, on: boolean): Promise<void> {
  useSettingsStore.getState().setToolEnabled(key, on);
  try {
    await setConfigValue(TOOLS_CONFIG_PATH[key], on);
  } catch (e) {
    console.warn("config write failed (tool)", e);
  }
}

/** Toggle roborev (the per-commit AI code-review daemon). Beyond the config write, this has real
 *  side effects: turning it ON installs the daemon and wires roborev's git hooks into EVERY known
 *  project; turning it OFF deactivates the daemon and removes those hooks. The optimistic store
 *  update + config write go first (via setToolEnabled) so the UI flips instantly; the daemon/hook
 *  work is best-effort (each roborev.ts wrapper swallows + logs its own error) and never rejects. */
/** Turn an auth-probe verdict into an actionable sentence for the Roborev row, or null when there's
 *  nothing wrong. `undefined` (the probe couldn't run) is deliberately NOT silent: an unverified
 *  daemon is exactly the state that fails invisibly. */
export function authWarningFor(verdict: RoborevAuthVerdict | undefined): string | null {
  switch (verdict?.kind) {
    case "Passed":
      return null;
    case "ClaudeMissing":
      return "Roborev can't find the claude command, so your commits won't be reviewed. Install Claude Code, then turn Roborev on again.";
    case "NotAuthenticated":
      return "Roborev found claude but couldn't sign in, so your commits won't be reviewed. Run `claude login` in a terminal, then turn Roborev on again.";
    default:
      // Unknown verdict, or the probe didn't run at all. We can't claim it works and we can't claim
      // it's broken — say so, and leave it on rather than blocking on our own uncertainty.
      return "Sparkle couldn't confirm Roborev is able to review your commits. It's on — but if reviews never appear, run `claude login` in a terminal.";
  }
}

/**
 * Turn roborev on or off.
 *
 * Turning it ON probes the daemon's real environment before we let the toggle claim it's working.
 * The failure this guards against is silent: an unauthenticated daemon runs happily, reviews nothing,
 * and looks identical to a healthy one. On a CONFIDENT negative (no claude / can't sign in) we hand
 * the toggle back off and say why, so the UI never shows "on" for something that cannot work. An
 * inconclusive probe leaves it on with a warning — our own uncertainty shouldn't block a setup that
 * may well be fine.
 */
export async function setRoborevEnabled(on: boolean): Promise<void> {
  // Optimistic store set + persist tools.roborev to config.toml (same path as any other tool).
  await setToolEnabled("roborev", on);
  // Side effects: daemon + a sweep of every project's git hooks. Fire the hook sweep in parallel;
  // each call is independently best-effort.
  const projects = useProjectStore.getState().projects;
  const settings = useSettingsStore.getState();

  if (!on) {
    settings.setRoborevAuthWarning(null);
    await deactivateRoborev();
    await Promise.all(projects.map((p) => removeRepoHooks(p.rootPath)));
    return;
  }

  await installRoborev();
  const verdict = await roborevAuthSelftest();
  settings.setRoborevAuthWarning(authWarningFor(verdict));
  if (verdict?.kind === "ClaudeMissing" || verdict?.kind === "NotAuthenticated") {
    // Confidently broken: revert to off and tear the daemon back down, so we don't leave a daemon
    // running that can only ever no-op. The warning above tells the user how to fix it.
    await setToolEnabled("roborev", false);
    await deactivateRoborev();
    return;
  }
  await Promise.all(projects.map((p) => installRepoHooks(p.rootPath)));
}

/**
 * Re-probe roborev's auth and publish the result to the Roborev row. Call this at startup.
 *
 * Why it's needed on top of the toggle gate: `tools.roborev` DEFAULTS TO ON and is persisted, while
 * the warning is deliberately UI-only. So the two commonest states — a fresh install (already on,
 * never toggled) and every subsequent app launch — would otherwise never be probed at all, and an
 * unauthenticated daemon would go right back to looking healthy. That's the exact failure this
 * feature exists to prevent, so the check can't only live on the OFF→ON edge.
 *
 * Unlike the toggle path this only WARNS — it never flips the toggle off. A transient probe failure
 * at launch shouldn't silently disable a feature the user chose; being loud is enough here.
 */
export async function refreshRoborevAuth(): Promise<void> {
  if (!useSettingsStore.getState().roborevEnabled) {
    useSettingsStore.getState().setRoborevAuthWarning(null);
    return;
  }
  const verdict = await roborevAuthSelftest();
  // Re-read rather than reusing the pre-await snapshot: the probe can take ~90s, and the user may
  // have turned roborev OFF while we waited — publishing then would warn about a disabled feature.
  // Scope, precisely: this guards the off case only. An off→on→resolve sequence inside the same
  // window still lets this stale verdict overwrite the toggle's fresher one. Left alone on purpose
  // — both probes measure the same auth state, so they agree in all but a transient blip, and an
  // epoch counter would be real machinery for a self-correcting cosmetic race.
  if (!useSettingsStore.getState().roborevEnabled) return;
  useSettingsStore.getState().setRoborevAuthWarning(authWarningFor(verdict));
}

/** Record that the one-time roborev consent modal has been shown (so it never appears again),
 *  whichever choice the user made. Optimistic store set, then persist roborev.consent_prompted. */
export async function markRoborevConsentPrompted(): Promise<void> {
  useSettingsStore.getState().setRoborevConsentPrompted(true);
  try {
    await setConfigValue("roborev.consent_prompted", true);
  } catch (e) {
    console.warn("config write failed (roborev consent)", e);
  }
}

/** Bulk-set every AI feature in ONE atomic write. A single set_config_values call fires one
 *  config-changed at a consistent end state — separate per-key writes would each re-hydrate the
 *  store from a partially-written file and briefly revert the not-yet-written features. */
export async function setAllAiFeatures(on: boolean): Promise<void> {
  useSettingsStore.getState().setAllAiFeatures(on);
  try {
    // Derive the {dotted path: value} map from AI_CONFIG_PATH so the keys can't drift from the
    // single source of the menu-key → config-path mapping.
    const values = Object.fromEntries(Object.values(AI_CONFIG_PATH).map((path) => [path, on]));
    await setConfigValues(values);
  } catch (e) {
    console.warn("config write failed (ai bulk)", e);
  }
}

/** Toggle "delete merged branch on close": optimistic store update, then persist to config.toml. */
export async function setDeleteMergedBranch(on: boolean): Promise<void> {
  useSettingsStore.getState().setDeleteMergedBranch(on);
  try {
    await setConfigValue("workflow.delete_merged_branch", on);
  } catch (e) {
    console.warn("config write failed (delete merged branch)", e);
  }
}

/** Set the custom wake word: optimistic store update, then persist to config.toml. A blank/
 *  whitespace word falls back to the default (an empty custom phrase would never wake). */
export async function setWakeWord(word: string): Promise<void> {
  const w = word.trim() || DEFAULT_WAKE_WORD;
  useSettingsStore.getState().setWakeWord(w);
  try {
    await setConfigValue("voice.wake_word", w);
  } catch (e) {
    console.warn("config write failed (wake word)", e);
  }
}

/** Set the custom stop word: optimistic store update, then persist to config.toml. A blank/
 *  whitespace word falls back to the default. */
export async function setStopWord(word: string): Promise<void> {
  const w = word.trim() || DEFAULT_STOP_WORD;
  useSettingsStore.getState().setStopWord(w);
  try {
    await setConfigValue("voice.stop_word", w);
  } catch (e) {
    console.warn("config write failed (stop word)", e);
  }
}

/** Toggle "pause listening on submit": optimistic store update, then persist to config.toml. */
export async function setPauseOnSubmit(on: boolean): Promise<void> {
  useSettingsStore.getState().setPauseOnSubmit(on);
  try {
    await setConfigValue("voice.pause_on_submit", on);
  } catch (e) {
    console.warn("config write failed (pause on submit)", e);
  }
}

/** Reset the three voice settings to their built-in defaults in ONE atomic write. */
export async function resetVoiceSettings(): Promise<void> {
  const s = useSettingsStore.getState();
  s.setWakeWord(DEFAULT_WAKE_WORD);
  s.setStopWord(DEFAULT_STOP_WORD);
  s.setPauseOnSubmit(DEFAULT_PAUSE_ON_SUBMIT);
  try {
    await setConfigValues({
      "voice.wake_word": DEFAULT_WAKE_WORD,
      "voice.stop_word": DEFAULT_STOP_WORD,
      "voice.pause_on_submit": DEFAULT_PAUSE_ON_SUBMIT,
    });
  } catch (e) {
    console.warn("config write failed (voice reset)", e);
  }
}

/** Set the worker concurrency cap: optimistic store update, then persist to config.toml. */
export async function setMaxConcurrentWorkers(n: number): Promise<void> {
  const v = Math.max(1, Math.floor(n));
  useSettingsStore.getState().setMaxConcurrentWorkers(v);
  try {
    await setConfigValue("workers.max_concurrent", v);
  } catch (e) {
    console.warn("config write failed (max workers)", e);
  }
}
