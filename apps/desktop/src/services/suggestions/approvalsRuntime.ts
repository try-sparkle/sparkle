// Runtime glue for reading the EFFECTIVE auto-approve rule for a project, and keeping the
// per-project cache (approvalsStore) fresh from config.toml. Kept separate from approvalsStore so
// the store stays a plain zustand cache with no Tauri/React imports.
//
// Effective rule = project override beats global. `get_config(root)` already computes that merge in
// Rust (config::for_project), so a project's cached map here IS the effective map; we only fall back
// to the global settings mirror when a project's map hasn't loaded yet (or there is no project).
import { useEffect } from "react";
import { getConfig, onConfigChanged } from "../config";
import { safeUnlisten } from "../safeUnlisten";
import { useApprovalsStore } from "../../stores/approvalsStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useProjectStore } from "../../stores/projectStore";
import { aiFeatureVisibleNow } from "../aiGate";
import { writePtyChained } from "../../pty";
import { classifyApproval, headerRegion } from "./approvalClassifier";
import { mcpAutoAnswerable, mcpToolFromPrompt, isDeniedTool } from "./mcpToolPolicy";
import { detectClaudeCodePicker, detectResumePrompt } from "./heuristics";
import {
  toApprovalMap,
  asResumeRule,
  resumeRuleComplaint,
  type ApprovalCategory,
  type ApprovalRule,
  type ResumeRule,
} from "./approvalCategories";
import { log } from "../../logger";

/** A stable signature of the picker instance in `scrollback` — its option keystrokes + labels. Used
 *  to auto-answer each distinct picker at most once (a re-rendered scrollback keeps the same options,
 *  so it hashes identically and the resend is suppressed). Empty string when there is no picker. */
export function pickerSignature(scrollback: string): string {
  return detectClaudeCodePicker(scrollback)
    .map((b) => `${b.value}\u0000${b.label}`)
    .join("|");
}

/**
 * Decide whether to auto-answer the permission prompt (if any) currently in `scrollback`, and if so
 * type the plain-Yes keystroke into the PTY exactly once per picker instance. Returns the category
 * it auto-answered (so the caller shows the "Auto-approved {label}" note and suppresses buttons), or
 * null to fall through to the normal buttons.
 *
 * SECURITY: the keystroke comes ONLY from the local heuristic classifier (classifyApproval), never
 * from the AI/learned suggestion tier — preserving the existing raw-keystroke trust boundary.
 */
export function maybeAutoApprove(
  agentId: string,
  scrollback: string,
  handled: Set<string>,
): ApprovalCategory | null {
  const classification = classifyApproval(scrollback);
  if (!classification) return null; // not a classifiable permission prompt → never auto-type
  // Master toggle only — NOT credit-gated. Auto-approve is a purely local regex classifier that
  // spends no AI credits, so gating it on a positive balance would leave out-of-credit users blocked
  // by prompts forever. The on/off toggle (ai.auto_approve) is the sole gate here.
  if (!aiFeatureVisibleNow("autoApprove")) return null;
  // ---------------------------------------------------------------------------------------------
  // THE DENY VETO, deliberately ahead of the category branch and independent of it.
  //
  // Category is a REGEX GUESS, and a wrong guess must not be able to authorise a destructive tool.
  // The concrete hole this closes: `sparkle-orchestrator - spawn_worker(task: "run the build
  // command")` classifies as `bash` — the bash rule matches the word "command" inside the tool's own
  // arguments, and bash is checked before mcp. A user with `bash = "always"` (the founder's exact
  // config) would then have a worker spawned for them with no prompt, because a policy scoped to
  // `category === "mcp"` never runs on a prompt that landed in `bash`.
  //
  // So the veto keys on the PROMPT NAMING A DENIED TOOL, not on where the classifier filed it. It
  // can only ever add a prompt, never remove one.
  // Scoped to the picker HEADER REGION, the same region classifyApproval reads, so the tool name
  // comes from the prompt being decided rather than from anything earlier in the scrollback.
  const promptRegion = headerRegion(scrollback);
  const namedTool = mcpToolFromPrompt(promptRegion);
  if (namedTool && isDeniedTool(namedTool)) {
    log.info("approvals", "auto-approve vetoed (denied tool)", {
      agentId,
      category: classification.category,
      tool: namedTool,
    });
    return null;
  }
  const root = projectRootForAgent(agentId);
  const rule = effectiveApprovalRule(root, classification.category);
  // MCP prompts are decided per TOOL, not per category (services/suggestions/mcpToolPolicy).
  // `[approvals].mcp` is one bucket spanning `set_agent_activity` (writes a narration string) and
  // `sparkle_lifecycle` (discards an agent), so a single always/ask rule cannot express what the
  // human means. The policy narrows in BOTH directions: it auto-answers a short, individually
  // verified read-only list even with no rule set — which is what stops the narration prompts the
  // founder kept hitting — and it refuses anything that spawns, discards, merges, pushes, or speaks
  // as him EVEN IF he set `mcp = "always"`. An unreadable tool name always asks.
  if (classification.category === "mcp") {
    if (mcpAutoAnswerable(promptRegion, rule) !== "auto") return null;
  } else if (rule !== "always") {
    return null;
  }
  const sig = pickerSignature(scrollback);
  // Already answered THIS picker instance: keep the buttons suppressed + the note shown, but never
  // re-send the keystroke (a re-hash of the same settled screen must not double-answer).
  if (handled.has(sig)) return classification.category;
  handled.add(sig);
  // Chained: the option keystroke carries its own CR (see pty.writePtyChained).
  void writePtyChained(agentId, classification.approveOption);
  // The audit trail for an answer the human never saw. `tool` is the load-bearing field: a bare
  // category cannot distinguish a narration string that was auto-answered from a lifecycle op that
  // was, which is the exact question anyone reviewing this after the fact will be asking.
  log.info("approvals", "auto-approved", {
    agentId,
    category: classification.category,
    tool: namedTool ?? undefined,
  });
  return classification.category;
}

/**
 * Decide whether to auto-answer the session-resume prompt (if any) currently in `scrollback`, and if
 * so type the chosen mode's keystroke into the PTY exactly once per picker instance. Returns the mode
 * it answered with ("summary" | "full", so the caller can suppress buttons + show a note), or null to
 * fall through to the normal buttons.
 *
 * This is a SIBLING path to {@link maybeAutoApprove}: the resume prompt has no Yes/No pair, so the
 * approval classifier deliberately ignores it. It rides the SAME master toggle (ai.auto_approve) —
 * it's a sub-behavior of "auto-respond to prompts" — but its own `resume` rule decides the answer.
 *
 * SECURITY: the keystroke comes ONLY from the local heuristic detector (detectResumePrompt), never
 * from the AI/learned suggestion tier — preserving the raw-keystroke trust boundary.
 */
export function maybeAutoResume(
  agentId: string,
  scrollback: string,
  handled: Set<string>,
): Exclude<ResumeRule, "ask"> | null {
  const detected = detectResumePrompt(scrollback);
  if (!detected) return null; // not the resume prompt (or missing an option) → never auto-type
  // Gated on the SAME master toggle as auto-approve — this is a sub-option of it, so it must never
  // fire while the parent is off.
  if (!aiFeatureVisibleNow("autoApprove")) return null;
  const root = projectRootForAgent(agentId);
  const rule = effectiveResumeRule(root);
  if (rule === "ask") return null; // user hasn't opted into auto-resuming → surface the prompt
  const sig = pickerSignature(scrollback);
  // Already answered THIS picker instance: keep buttons suppressed, but never re-send the keystroke.
  if (handled.has(sig)) return rule;
  handled.add(sig);
  // Chained: the option keystroke carries its own CR (see pty.writePtyChained).
  void writePtyChained(agentId, rule === "summary" ? detected.summaryOption : detected.fullOption);
  log.info("approvals", "auto-resumed", { agentId, mode: rule });
  return rule;
}

/** The project root path that owns `agentId`, or null if it can't be resolved. */
export function projectRootForAgent(agentId: string): string | null {
  const project = useProjectStore
    .getState()
    .projects.find((p) => p.agents.some((a) => a.id === agentId));
  return project?.rootPath ?? null;
}

/** Effective rule for a category in a project (imperative). Project override beats global; when the
 *  project's map hasn't loaded (or there's no project) the global mirror answers. */
export function effectiveApprovalRule(
  root: string | null,
  category: ApprovalCategory,
): ApprovalRule | undefined {
  const global = useSettingsStore.getState().approvals;
  if (!root) return global[category];
  const proj = useApprovalsStore.getState().byRoot[root];
  // A loaded project map is already the merged effective view (Rust folds global in), so it fully
  // answers — including "unset" (undefined). Only fall through to the global mirror when it's absent.
  if (proj) return proj[category];
  return global[category];
}

/** Effective session-resume rule for a project (imperative). Project override beats global; when the
 *  project's value hasn't loaded (or there's no project) the global mirror answers. Always resolves
 *  to a concrete rule ("ask" is the default), never undefined. */
export function effectiveResumeRule(root: string | null): ResumeRule {
  const global = useSettingsStore.getState().resumeRule;
  if (!root) return global;
  const proj = useApprovalsStore.getState().resumeByRoot[root];
  // A loaded project value is already the merged effective view (Rust folds global in). Only fall
  // through to the global mirror when it hasn't loaded yet.
  return proj ?? global;
}

/**
 * Load and keep fresh the effective approval rules for `root` in approvalsStore. Mounted once per
 * project context (the composer). Re-pulls on every `config-changed` (a global OR project write
 * both fire it) so the cache tracks the file. No-op when `root` is null.
 */
export function useSyncProjectApprovals(root: string | null): void {
  useEffect(() => {
    if (!root) return;
    let cancelled = false;
    const pull = () =>
      getConfig(root)
        .then((eff) => {
          if (cancelled) return;
          useApprovalsStore.getState().setForRoot(root, toApprovalMap(eff.config.approvals));
          // The resume sibling rides the same config pull (it lives in the same [approvals] table).
          // A value this key does not accept is silently narrowed to "ask" below, which is the exact
          // opposite of what the user asked for. Say so — this is the only place the raw config value
          // and a logger are both in scope.
          const complaint = resumeRuleComplaint(eff.config.approvals?.resume);
          if (complaint) log.warn("approvals", complaint, { root });
          useApprovalsStore.getState().setResumeForRoot(root, asResumeRule(eff.config.approvals?.resume));
        })
        .catch((e) => log.debug("approvals", "getConfig failed", { root, e: String(e) }));
    void pull();
    const unlistenPromise = onConfigChanged(() => void pull());
    return () => {
      cancelled = true;
      void safeUnlisten(unlistenPromise);
    };
  }, [root]);
}
