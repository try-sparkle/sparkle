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
import {
  useSettingsStore,
  normalizeAccountId,
  normalizeVaultId,
  type AiFeatureKey,
  type PluginKey,
  type ToolKey,
  type SparkleImprovementConsent,
} from "../stores/settingsStore";
import { useProjectStore } from "../stores/projectStore";
import {
  installRoborev,
  deactivateRoborev,
  installRepoHooks,
  removeRepoHooks,
  roborevAuthSelftest,
  type RoborevAuthVerdict,
} from "./roborev";
import {
  ensureDefaultPluginsInstalled,
  pluginInstallOutcomes,
  type PluginInstallOutcome,
} from "./worktree";
import { useApprovalsStore } from "../stores/approvalsStore";
import {
  DEFAULT_RESUME_RULE,
  type ApprovalCategory,
  type ApprovalRule,
  type ResumeRule,
} from "./suggestions/approvalCategories";
import { categoriesForPreset, type AutoApprovePreset } from "./autoApprovePreset";
import {
  conciergeToolConfigPath,
  CONCIERGE_TOOL_NAMES,
  CONCIERGE_TOOLS_CONFIG_TABLE,
  type PolicyDecision,
  type ToolPolicyOverrides,
} from "./conciergeTools/policy";

/** Menu feature key → its dotted config path under [ai]. */
const AI_CONFIG_PATH: Record<AiFeatureKey, string> = {
  autoRename: "ai.auto_rename",
  voiceDictation: "ai.voice_dictation",
  composer: "ai.composer",
  suggestedActions: "ai.suggested_actions",
  autoApprove: "ai.auto_approve",
  concierge: "ai.concierge",
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

/**
 * Set (or CLEAR, with null) one concierge tool's autonomy rule in the GLOBAL config.toml.
 *
 * Global scope only, and that is a security boundary rather than a simplification: `[concierge]` is
 * ignored in a per-project file (config.rs warns about it) precisely so a cloned repo cannot hand
 * the concierge standing authority over the user's machine.
 *
 * A null decision UNSETS the key rather than writing a "default" sentinel. The default is DERIVED
 * from the tool's risk class (services/conciergeTools/policy.ts), so an absent key is the only
 * honest way to say "use the default" — writing today's derived value would freeze it and quietly
 * stop tracking a future reclassification.
 */
export async function setConciergeToolPolicy(
  tool: string,
  decision: PolicyDecision | null,
): Promise<void> {
  useSettingsStore.getState().setConciergeToolPolicy(tool, decision);
  const path = conciergeToolConfigPath(tool);
  try {
    if (decision) await setConfigValue(path, decision);
    else await unsetConfigValue(path);
  } catch (e) {
    console.warn("config write failed (concierge tool policy)", e);
  }
}

/**
 * Set EVERY concierge tool to `allow` — the pane's one bulk grant.
 *
 * WRITES AN EXPLICIT RULE FOR EVERY TOOL, including the 41 whose derived default is already
 * `allow`. That looks redundant and is not. The point of a bulk grant is that the resulting state
 * is legible and undoable per row: a tool left implicit would read "default" rather than "set by
 * you" and offer no Reset, so a user who had just granted everything would be looking at a pane
 * that says two thirds of it was decided for them. It is also the only reading that stays true
 * later — a tool reclassified from `routine` to `irreversible` would otherwise have its default
 * flip to `ask` and silently withdraw a grant the human made deliberately.
 *
 * ONE atomic `set_values`, never 62 writes. Each write emits a `config-changed`, and a hydrate
 * landing mid-bulk would read a partially-written file and revert the keys not yet written.
 *
 * Undone in one gesture by `resetAllConciergeTools`.
 */
export async function allowAllConciergeTools(): Promise<void> {
  const applied = Object.fromEntries(CONCIERGE_TOOL_NAMES.map((n) => [n, "allow" as const]));
  await applyConciergeBulk(
    (s) => s.setConciergeToolPolicies(applied),
    () =>
      setConfigValues(
        Object.fromEntries(CONCIERGE_TOOL_NAMES.map((n) => [conciergeToolConfigPath(n), "allow"])),
      ),
    "allow all concierge tools",
  );
}

/**
 * Drop every explicit rule, returning every tool to the default its risk class derives.
 *
 * Unsets the `[concierge.tools]` TABLE rather than its keys one by one — one write, one event, and
 * it also takes hand-edited keys naming no tool with it (see CONCIERGE_TOOLS_CONFIG_TABLE). A
 * "reset to defaults" that left an unreadable rule behind would be a reset the pane still shows a
 * warning pill for.
 */
export async function resetAllConciergeTools(): Promise<void> {
  await applyConciergeBulk(
    (s) => s.replaceConciergeToolPolicies({}),
    () => unsetConfigValue(CONCIERGE_TOOLS_CONFIG_TABLE),
    "reset all concierge tools",
  );
}

/**
 * The shared optimistic-then-persist shape for the two bulk gestures — and, unlike every other
 * write in this file, ONE THAT ROLLS BACK.
 *
 * The house style here is "update optimistically, warn on failure, let the next hydrate reconcile
 * with the file". That is fine for a single row, and WRONG for these two, because the reconciling
 * hydrate never comes: `config-changed` is emitted by a successful write, so a rejected one leaves
 * no event behind and the optimistic state stands until the app restarts.
 *
 * For the reset that fails OPEN, which is the unacceptable direction. The store would already read
 * `{}` — every row rendering "default", the pane reporting a whole-pane revocation — while
 * config.toml still holds up to 62 `allow` rules including the 8 irreversible ones. The user
 * believes they took the authority back; the concierge still has it; and a restart quietly restores
 * the grants they think they removed.
 *
 * Rolling back is also the user-visible signal, which is why this does not additionally raise a
 * notice: the rows snap back to what the file still says, so "I pressed reset and nothing changed"
 * is a true report of the situation rather than a lie plus a toast.
 *
 * THE GUARD MATTERS. A rollback is only correct if nothing has moved since — if the human set one
 * row while the bulk write was in flight, that edit carried its own (likely successful) write, and
 * restoring the pre-bulk snapshot over it would discard a rule the file now holds, trading one
 * mismatch for another. So the snapshot is restored only while the store still reads exactly what
 * this call put there; otherwise the newer writer owns it.
 */
async function applyConciergeBulk(
  optimistic: (s: ReturnType<typeof useSettingsStore.getState>) => void,
  persist: () => Promise<void>,
  what: string,
): Promise<void> {
  const before = useSettingsStore.getState().conciergeToolPolicy;
  optimistic(useSettingsStore.getState());
  const applied = useSettingsStore.getState().conciergeToolPolicy;
  try {
    await persist();
  } catch (e) {
    console.warn(`config write failed (${what})`, e);
    if (sameToolPolicy(useSettingsStore.getState().conciergeToolPolicy, applied)) {
      useSettingsStore.getState().replaceConciergeToolPolicies(before);
    }
  }
}

/** Shallow equality over the rule maps — the values are strings, so this is the whole comparison. */
function sameToolPolicy(a: ToolPolicyOverrides, b: ToolPolicyOverrides): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
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
  onepassword: "tools.onepassword",
  builderIndex: "tools.builder_index",
};

/** Set (or clear) the 1Password vault backups are written to. A null id UNSETS the key rather
 *  than writing an empty string: Rust treats a blank vault_id as "not chosen", so leaving a stale
 *  `vault_id = ""` behind would misrepresent the file as configured. */
export async function setOnePasswordVault(vaultId: string | null): Promise<void> {
  // Normalize ONCE, through the store's exported rule, then branch on the result — set vs unset is
  // the only decision left here.
  const normalized = normalizeVaultId(vaultId);
  useSettingsStore.getState().setOnePasswordVaultId(normalized);
  try {
    if (normalized) await setConfigValue("onepassword.vault_id", normalized);
    else await unsetConfigValue("onepassword.vault_id");
  } catch (e) {
    console.warn("config write failed (onepassword vault)", e);
  }
}

/** Set (or clear) which 1Password account every `op` call acts as, by its `user_uuid`.
 *
 *  A null id UNSETS the key rather than writing an empty string — Rust would have to defend against
 *  `--account ""` on every invocation otherwise. Awaiting the write matters here beyond persistence:
 *  the Rust side reads this key at the moment it builds each `op` command line, and `set_config_value`
 *  refreshes the cached config before it returns, so a re-probe issued after this resolves already
 *  sees the new account. */
export async function setOnePasswordAccount(accountId: string | null): Promise<void> {
  const normalized = normalizeAccountId(accountId);
  useSettingsStore.getState().setOnePasswordAccountId(normalized);
  try {
    if (normalized) await setConfigValue("onepassword.account_id", normalized);
    else await unsetConfigValue("onepassword.account_id");
  } catch (e) {
    console.warn("config write failed (onepassword account)", e);
  }
}

/** Toggle restoring backed-up env files into each newly created agent worktree. */
export async function setOnePasswordSeedWorktrees(on: boolean): Promise<void> {
  useSettingsStore.getState().setOnePasswordSeedWorktrees(on);
  try {
    await setConfigValue("onepassword.seed_worktrees", on);
  } catch (e) {
    console.warn("config write failed (onepassword seed_worktrees)", e);
  }
}

/** Toggle one [tools] flag: optimistic store update, then persist to config.toml. */
export async function setToolEnabled(key: ToolKey, on: boolean): Promise<void> {
  useSettingsStore.getState().setToolEnabled(key, on);
  try {
    await setConfigValue(TOOLS_CONFIG_PATH[key], on);
  } catch (e) {
    console.warn("config write failed (tool)", e);
  }
}

/**
 * Toggle the Builder Index (tokenmaxxing leaderboard) reporter.
 *
 * Asymmetric on purpose, and the asymmetry IS the consent design:
 *   • ON  → does NOT write the config. It opens the consent modal, which is where the user reads
 *           what gets published, supplies a username + API key, and confirms. Only that
 *           confirmation flips `[tools].builder_index` on. Writing the flag here would mean a
 *           stray click had already opted them in to publishing.
 *   • OFF → writes immediately. Withdrawing consent must never need a dialog.
 *
 * Turning it off leaves the stored credentials alone so re-enabling doesn't mean re-typing a key;
 * "Turn off and forget" in the modal is the path that also clears them.
 */
export async function setBuilderIndexEnabled(on: boolean): Promise<void> {
  if (on) {
    useSettingsStore.getState().setBuilderIndexModalOpen(true);
    return;
  }
  await setToolEnabled("builderIndex", false);
}

/** Plugin key → its dotted config path under [plugins]. Note the snake_case leaf: the TOML key is
 *  `frontend_design`, not the camelCase store key. */
const PLUGINS_CONFIG_PATH: Record<PluginKey, string> = {
  superpowers: "plugins.superpowers",
  frontendDesign: "plugins.frontend_design",
  sparkleGuardrails: "plugins.sparkle_guardrails",
  sparkleFreshness: "plugins.sparkle_freshness",
  sparkleMutationCheck: "plugins.sparkle_mutation_check",
};

/** Store key → the `[plugins]` TOML key Rust reports back in a `PluginInstallOutcome`.
 *
 *  DERIVED, not a third hand-written copy of the plugin set: a new plugin missing from a fourth map
 *  would yield `undefined`, `find` would miss, and the row would show the false "couldn't confirm"
 *  hint instead of the truth. */
const pluginTomlKey = (key: PluginKey): string =>
  PLUGINS_CONFIG_PATH[key].slice("plugins.".length);

/** The reverse: an outcome's TOML key → the store key whose row it belongs to, or undefined for a
 *  plugin this build's UI doesn't know about. */
function pluginKeyForTomlKey(tomlKey: string): PluginKey | undefined {
  return (Object.keys(PLUGINS_CONFIG_PATH) as PluginKey[]).find(
    (k) => pluginTomlKey(k) === tomlKey,
  );
}

/** The row hint for a plugin that is switched ON but not actually on the machine. `null` when the
 *  plugin is present (installed just now, or already there).
 *
 *  Exported because this is the function that decides whether a toggle tells the truth. Before the
 *  outcome list existed it could NEVER fire: the command returned Ok even when every install
 *  failed, so the only path to a hint was a rejection — which the offline / marketplace-outage /
 *  no-claude cases never produce. The switch read ON with the plugin absent.
 *
 *  The remedy sentence comes from Rust so the copy sits next to the condition that produced it
 *  ("finish setup" vs "check your connection" are different actions). We deliberately do NOT keep a
 *  local paraphrase of it: a second copy would drift, and the case where it'd be used (a `failed`
 *  outcome with no message) is one where we genuinely don't know the remedy — which is what
 *  "couldn't confirm" says.
 *
 *  Anything that is not an explicit non-failure verdict falls through to a hint, so a status this
 *  build doesn't recognize can't render as success. */
export function pluginInstallHint(outcome: PluginInstallOutcome | undefined): string | null {
  if (!outcome) {
    // The pass ran but never mentioned this plugin — most likely it wasn't in the enabled set the
    // pass read, which means no install was even attempted for it.
    return "Sparkle couldn't confirm this plugin installed — the install pass didn't report on it. It's on, but agents may not see it yet.";
  }
  if (outcome.status === "installed" || outcome.status === "alreadyPresent") return null;
  return (
    outcome.message ??
    "Sparkle couldn't confirm this plugin installed. It's on, but agents may not see it yet."
  );
}

/** The hint for the case where the install pass ITSELF couldn't run (no app-data dir, a task panic)
 *  — distinct from an install that ran and failed, and from an outcome list that omitted the row. */
export function pluginPassFailedHint(): string {
  return "Sparkle couldn't run the plugin install. It's on, but agents won't see it until the next launch.";
}

/** Push a pass's verdicts onto the rows they belong to. Unknown keys (a plugin this build has no row
 *  for) are ignored rather than dropped loudly — the Rust table can legitimately lead the UI. */
export function applyPluginInstallOutcomes(outcomes: PluginInstallOutcome[]): void {
  const store = useSettingsStore.getState();
  for (const o of outcomes) {
    const rowKey = pluginKeyForTomlKey(o.key);
    if (!rowKey) continue;
    store.setPluginInstallState(rowKey, pluginInstallHint(o));
  }
}

/** Hydrate the plugin rows from the LAST install pass — the startup one, usually.
 *
 *  Without this the self-diagnosis loop only closed through a user action: the startup and
 *  agent-prepare passes computed a per-plugin verdict and logged it, so on the machine this whole
 *  mechanism exists for (install fails, "retries next launch", fails again) the pane showed the
 *  switch ON with no hint until someone happened to toggle it. Best-effort: a failure here just
 *  leaves the rows as they were. */
export async function refreshPluginInstallState(): Promise<void> {
  try {
    applyPluginInstallOutcomes(await pluginInstallOutcomes());
  } catch (e) {
    console.warn("couldn't read the last plugin install outcomes", e);
  }
}

/** Toggle one [plugins] flag: optimistic store update, then persist to config.toml. Written to the
 *  GLOBAL config (all projects); a repo can still override it in its own .sparkle/config.toml.
 *
 *  Turning one ON also kicks the installer, the same way setRoborevEnabled does its daemon/hook
 *  work: the config write alone only makes future agents' settings.local.json *enable* the plugin,
 *  and Claude Code doesn't fetch a settings-enabled plugin — so without this the plugin would sit
 *  enabled-but-absent until the next app launch ran the startup pass. Best-effort and never
 *  rejects: the command is idempotent, and a failure only defers the install to that launch. */
export async function setPluginEnabled(key: PluginKey, on: boolean): Promise<void> {
  useSettingsStore.getState().setPluginEnabled(key, on);
  try {
    await setConfigValue(PLUGINS_CONFIG_PATH[key], on);
  } catch (e) {
    console.warn("config write failed (plugin)", e);
    return; // the install pass reads the config, so don't chase a write that didn't land
  }
  if (!on) {
    useSettingsStore.getState().setPluginInstallState(key, null);
    return;
  }
  // Surface the fetch on the row while it runs, and say so if it didn't land. Without this the
  // switch reads ON with the plugin absent — the same invisible failure the install exists to fix,
  // just moved one step later. Same reasoning as roborevAuthWarning: "a daemon that can't
  // authenticate looks exactly like a healthy one".
  //
  // The force key is load-bearing. The install pass keeps a per-process "already attempted" set so
  // an un-installable machine doesn't burn two 90s network calls per plugin on every agent prepare
  // — but that set also swallowed THIS call, making toggle-off/on (the only remedy the UI names) a
  // silent no-op that rendered as success. A user asking for it explicitly always gets a real retry.
  // Scoped to THIS row: a bare "force everything" would re-run the other enabled-but-missing
  // plugins' installs inside this same awaited call, which is the burn the suppression prevents.
  const store = useSettingsStore.getState();
  store.setPluginInstallState(key, "installing");
  try {
    const outcomes = await ensureDefaultPluginsInstalled(pluginTomlKey(key));
    // Apply EVERY outcome, not just the toggled row's. The pass reports on all enabled plugins, so
    // it can newly discover that another row is broken (or newly fixed) — and that row's state
    // would otherwise keep whatever stale value it had, with the answer already in hand.
    for (const o of outcomes.filter((o) => o.status === "failed")) {
      // Log every failure, with the technical cause when there is one. Gating the log on `detail`
      // left the no-claude and suppressed cases showing a row hint with no console trace.
      console.warn("plugin not installed", o.id, o.message ?? "", o.detail ?? "");
    }
    applyPluginInstallOutcomes(outcomes);
    // If the pass said nothing at all about the row the user just clicked, don't leave it on
    // "installing" — and don't claim success we never saw.
    if (!outcomes.some((o) => o.key === pluginTomlKey(key))) {
      store.setPluginInstallState(key, pluginInstallHint(undefined));
    }
  } catch (e) {
    // A rejection means the PASS itself couldn't run (no app-data dir, task panic) — distinct from
    // "the install failed", which resolves with a failed outcome above.
    console.warn("plugin install pass failed (will retry next launch)", e);
    store.setPluginInstallState(key, pluginPassFailedHint());
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
    case "NotInstalled":
      return "Roborev isn't installed, so your commits won't be reviewed. Turn Roborev off and on again to reinstall it.";
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
  if (
    verdict?.kind === "ClaudeMissing" ||
    verdict?.kind === "NotAuthenticated" ||
    verdict?.kind === "NotInstalled"
  ) {
    // Confidently broken: revert to off and tear the daemon back down, so we don't leave a daemon
    // running that can only ever no-op. NotInstalled lands here too — installRoborev() ran just
    // above and the binary is still absent, so the install failed and reviews can never happen.
    // The warning above tells the user how to fix it.
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

/** Set the Sparkle-improvement consent mode. Optimistic store set (so the banner responds instantly)
 *  then MIRROR it to [improvement].consent in config.toml — the whole point of the mirror is to give
 *  headless agents (orchestrator / improvement pass), which can't read the webview store, a
 *  file-based read path to gate an auto-forward on `=== "always"`. A write failure is non-fatal: the
 *  optimistic update stands and the next hydrate reconciles from the file. */
export async function setImprovementConsent(mode: SparkleImprovementConsent): Promise<void> {
  useSettingsStore.getState().setSparkleImprovementConsent(mode);
  try {
    await setConfigValue("improvement.consent", mode);
  } catch (e) {
    console.warn("config write failed (improvement consent)", e);
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
