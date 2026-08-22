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
import { writePtyChainedStrict } from "../../pty";
import { notePromptAnswerOutcome } from "../../engine/blockedPromptGrace";
import { classifyApproval, headerRegion } from "./approvalClassifier";
import { mcpAutoAnswerable, mcpToolFromPrompt, isDeniedTool } from "./mcpToolPolicy";
import { detectResumePrompt, pickerSignature } from "./heuristics";
import { detectPlanPrompt, isPlanExitDialog } from "./planPrompt";
import { isFolderTrustDialog, trustAnswerFor } from "./trustPrompt";
import { routeUnclassifiedPrompt } from "./conciergeEscalation";
import { handOffToConcierge } from "./conciergeHandoff";
import {
  toApprovalMap,
  asResumeRule,
  resumeRuleComplaint,
  asPlanRule,
  planRuleComplaint,
  type ApprovalCategory,
  type ApprovalRule,
  type ResumeRule,
  type PlanRule,
} from "./approvalCategories";
import { log } from "../../logger";

// MOVED to `./heuristics`, and re-exported here so every existing caller and test keeps its
// import path. `conciergeHandoff` needs the same signature to de-dupe its hand-offs, and importing
// it from THIS module would close a runtime import cycle (this module imports the hand-off below).
// One definition, in the file they both already depend on — see the doc comment there.
export { pickerSignature } from "./heuristics";

/**
 * "I read this prompt and I am not going to answer it." Records `declined` for the blocked-prompt
 * grace window and returns the `null` the caller was returning anyway, so a decline arm stays one
 * line and cannot drift into a bare `return null`.
 *
 * WHICH ARMS GET THIS, AND WHICH MUST NOT. Only the returns taken AFTER the screen has been
 * recognised as a prompt — the master toggle being off, the denied-tool veto, an MCP tool the policy
 * will not auto-answer, a rule that is not `always`, a resume rule left at `ask`. Every one of those
 * is this module reading a real question and handing it to the human, which is precisely what
 * `declined` means and why it surfaces the row at once.
 *
 * NOT the "this isn't a prompt I recognise" arms (`!classification`, `!detected`). Reporting there
 * would fire on EVERY ordinary screen this runs against — a build log, an idle shell — and each one
 * would stamp an outcome that ends the hold for whatever prompt the agent draws next. That is not a
 * narrower version of the feature; it is the feature switched off, with the cost of a per-frame write.
 */
function declined(agentId: string): null {
  notePromptAnswerOutcome(agentId, "declined");
  return null;
}

/**
 * "I will not answer this — SO ASK THE CONCIERGE BEFORE ASKING THE FOUNDER."
 *
 * THE THIRD DESTINATION THAT DID NOT EXIST. Every arm below used to end at {@link declined}, whose
 * only consequence is to put the row in front of the founder at once. That made "the local regex
 * will not press this" and "only the human can decide this" the same sentence, and they are not: a
 * `gh pr view` prompt this module classified perfectly and refused for want of an `always` rule is
 * not a question that needs him — it is a question that needs SOMEBODY, and the concierge has been
 * able to answer it (`read_picker_options` + `select_picker_option`) the whole time without ever
 * being asked. Four separate reports from the founder in one morning, three of them the single
 * `rule !== "always"` arm below. See `conciergeHandoff` for the full account.
 *
 * ORDER MATTERS: the hand-off is tried FIRST and `declined` is the fallback, never both. Reporting a
 * decline after a successful hand-off would surface the prompt to him anyway (the give-up latch in
 * `blockedPromptGrace` is sticky for the whole ask), which is the exact behaviour being removed.
 */
function declineOrHandOff(agentId: string, scrollback: string): null {
  if (handOffToConcierge(agentId, scrollback)) return null;
  return declined(agentId);
}

/**
 * Type an auto-answer keystroke into `agentId`'s pane and REPORT WHAT BECAME OF IT to the
 * blocked-prompt grace window (engine/blockedPromptGrace).
 *
 * ══ WHY THE STRICT VARIANT ═════════════════════════════════════════════════════════════════════
 * This used to be `void writePtyChained(...)` — the TOLERANT write, which resolves even when the PTY
 * is gone (it exists to swallow the teardown race). Under it, ANSWERED and FAILED-TO-REACH are
 * literally indistinguishable from here: there is no rejection to observe, so this module could not
 * report a failure however hard it tried. That is the state the grace window cannot survive — an
 * unreachable pane means nobody but the founder is going to answer this prompt, and it is the case
 * he called out by name. The strict variant rejects with PtyGoneError, which is the only thing that
 * makes `unreachable` reportable at all.
 *
 * The promise was ALREADY ignored (`void`), so nothing about the write's timing or ordering changes;
 * what changes is that the rejection now has somewhere to go. BOTH arms are attached deliberately —
 * a `.then(ok)` alone would turn every dead-PTY auto-approve into an unhandled rejection.
 */
function typeAutoAnswer(
  agentId: string,
  keystroke: string,
  what: "auto-approve" | "auto-resume" | "auto-plan" | "auto-trust",
) {
  // Chained: the option keystroke carries its own CR (see pty.writePtyChainedStrict).
  void writePtyChainedStrict(agentId, keystroke).then(
    () => {
      notePromptAnswerOutcome(agentId, "handled");
    },
    (err: unknown) => {
      notePromptAnswerOutcome(agentId, "unreachable");
      log.warn("approvals", `${what} keystroke never reached the pane`, {
        agentId,
        e: String(err),
      });
    },
  );
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
  // NOT a `declined` report, deliberately — see the note above `maybeAutoApprove`. An unclassifiable
  // screen is not a decision about a prompt; there may be no prompt at all.
  if (!classification) {
    // STILL NOT A `declined` REPORT — the note above is unchanged and still governs: most screens
    // reaching this line are not prompts at all, and stamping an outcome on each would end the hold
    // for whatever prompt the agent draws next.
    //
    // But "I could not classify it" is NOT "there is no question here", and conflating those is the
    // founder's original report. His plan picker had FOUR options — "1 · 2, progress-gated" …
    // "4 · 1 — one re-arm only" — which `classifyApproval` refuses because it demands a Yes/No PAIR
    // (`looksLikePermission`). A readable menu this module cannot answer is precisely what the
    // concierge exists to answer, so it is offered one. The hand-off returns false for a screen with
    // no menu on it, which is what keeps this line silent for the ordinary build log.
    handOffToConcierge(agentId, scrollback);
    return null; // never auto-type on an unclassified screen
  }
  // Master toggle only — NOT credit-gated. Auto-approve is a purely local regex classifier that
  // spends no AI credits, so gating it on a positive balance would leave out-of-credit users blocked
  // by prompts forever. The on/off toggle (ai.auto_approve) is the sole gate here.
  //
  // AND ITS "OFF" DOES NOT SILENCE THE CONCIERGE (founder's call, 2026-08-13). Switching off a local
  // regex that presses buttons nobody read says nothing about whether a reasoning agent may READ the
  // question and then answer it. That is `[approvals].concierge_answers`, a separate switch, checked
  // inside the hand-off.
  if (!aiFeatureVisibleNow("autoApprove")) return declineOrHandOff(agentId, scrollback);
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
    // THE ONE ARM THAT IS NEVER HANDED TO THE CONCIERGE — deliberately `declined`, not
    // `declineOrHandOff`. `DENIED_TOOL_PATTERNS` is the set that spawns workers, discards agents,
    // merges, pushes, or speaks as the founder, and it is refused here EVEN IF he set
    // `mcp = "always"`. That is the "destructive or irreversible" class of his deny-list already
    // written down in machine-readable form, so routing it onward would let concierge routing
    // become a way around a veto that exists precisely to stop an unread press. It goes to him.
    return declined(agentId);
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
  //
  // BOTH ARMS NOW OFFER THE CONCIERGE FIRST. Neither is a statement that the FOUNDER must decide —
  // each is this module saying it has no standing authorisation to press. The denied-tool veto above
  // has already claimed everything that must never be pressed unread, so what reaches here is an
  // ordinary prompt with no rule behind it. That is the shape of three of the founder's four
  // reports: a read-only `gh pr view`, a read-only `git rev-list --count` sweep, and a PRD file
  // write — all classified correctly, all refused for want of an `always` rule, all landing on him.
  if (classification.category === "mcp") {
    if (mcpAutoAnswerable(promptRegion, rule) !== "auto") return declineOrHandOff(agentId, scrollback);
  } else if (rule !== "always") {
    return declineOrHandOff(agentId, scrollback);
  }
  const sig = pickerSignature(scrollback);
  // Already answered THIS picker instance: keep the buttons suppressed + the note shown, but never
  // re-send the keystroke (a re-hash of the same settled screen must not double-answer).
  // NOTHING IS REPORTED HERE either: the answer that settled this picker already reported its own
  // outcome, and re-stating it would overwrite a later, truer one (a `handled` written now would
  // undo the `unreachable` the write it refers to may have just recorded).
  if (handled.has(sig)) return classification.category;
  handled.add(sig);
  typeAutoAnswer(agentId, classification.approveOption, "auto-approve");
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
  // No report — the exact parallel of `!classification` above, for the same reason: a screen that is
  // not the resume prompt is not a decision about anything.
  if (!detected) return null; // not the resume prompt (or missing an option) → never auto-type
  // Gated on the SAME master toggle as auto-approve — this is a sub-option of it, so it must never
  // fire while the parent is off.
  if (!aiFeatureVisibleNow("autoApprove")) return declined(agentId);
  const root = projectRootForAgent(agentId);
  const rule = effectiveResumeRule(root);
  // "surface the prompt" is now literal rather than aspirational: `declined` is what takes this
  // prompt out of the grace window's hold and puts it in front of the founder immediately.
  if (rule === "ask") return declined(agentId); // user hasn't opted in → surface the prompt
  const sig = pickerSignature(scrollback);
  // Already answered THIS picker instance: keep buttons suppressed, but never re-send the keystroke
  // — and never re-report it either (see the same early return in maybeAutoApprove).
  if (handled.has(sig)) return rule;
  handled.add(sig);
  const option = rule === "summary" ? detected.summaryOption : detected.fullOption;
  typeAutoAnswer(agentId, option, "auto-resume");
  log.info("approvals", "auto-resumed", { agentId, mode: rule });
  return rule;
}

/**
 * What {@link maybeAutoPlan} did with the screen it was handed.
 *
 * `"asked"` IS THE LOAD-BEARING VALUE, and it is why this is not just `PlanRule | null`. Returning a
 * bare null for "I recognised the plan prompt and deliberately did not press it" let the caller fall
 * through to {@link maybeAutoApprove}, which cannot classify this dialog and therefore hands it to
 * the CONCIERGE — so `plan = "ask"`, whose whole promise is "ask me", ended with the prompt answered
 * by something else. `"asked"` means CLAIMED: this module has decided the screen's fate (surfaced it,
 * or routed it to the founder) and the caller must not offer it to another answerer.
 */
export type PlanOutcome = Exclude<PlanRule, "ask"> | "asked";

/**
 * Decide whether to auto-answer Claude Code's PLAN-EXIT prompt (if any) currently in `scrollback`,
 * and if so type the chosen affirmative's keystroke into the PTY exactly once per picker instance.
 *
 * Returns the mode it answered with ("auto" | "manual"), `"asked"` when it recognised the prompt and
 * deliberately left it for a human (see {@link PlanOutcome}), or null when this is not the plan-exit
 * prompt at all and the caller should carry on as before.
 *
 * ── WHY THIS PATH EXISTS AT ALL ───────────────────────────────────────────────────────────────
 * An agent that has finished writing a plan STOPS on this dialog and waits for a keypress. Nothing
 * in Sparkle answered it: {@link maybeAutoApprove}'s classifier refuses it by construction (no plain
 * "Yes", no "No" — every affirmative is a "Yes, and …" continuation) and that refusal is correct,
 * because pressing a continuation blind is the exact hazard `approvalClassifier.optionText` records.
 * The result was an agent sitting indefinitely with a complete, correct plan on screen until a human
 * walked over and pressed 1 — which blocked a real PR for hours.
 *
 * So this is the same SIBLING shape as {@link maybeAutoResume}: one question, recognised by its own
 * QUESTION TEXT (never by option number — "1." labels identical menus across unrelated questions),
 * with its own `[approvals].plan` rule and its own value domain. The approval classifier is left
 * exactly as strict as it was.
 *
 * ── THE ESCALATION GATE IS NOT OPTIONAL, AND IT RUNS BEFORE THE PRESS ─────────────────────────
 * Plan dialogs ALREADY had a governance path: `handOffToConcierge` → `routeUnclassifiedPrompt`
 * applies the founder's boundary (bead `sparkle-iwhzt`, his words: "spend, credentials, and product
 * direction stay with you; everything else I approve") over the dialog's question AND its option
 * labels. A local regex that presses first would make those classes unreachable for exactly the
 * dialog they were written for — a plan is the densest statement of intent an agent ever puts on
 * screen, so it is the LAST place to press without reading. `routeUnclassifiedPrompt` is called
 * rather than re-implemented so the gate reads the same text the router would have, by construction.
 *
 * ── WHY PLAN-*MODE* AGENTS ARE NOT EXEMPT ─────────────────────────────────────────────────────
 * An agent deliberately spawned with `--permission-mode plan` to produce a plan for a human to read
 * is a real case, and it was considered and rejected as an exemption (founder's call). Two reasons.
 * First, this dialog is not where a plan gets READ: the plan is already written into the transcript
 * above it, and it stays there whichever option is pressed — the only thing the prompt decides is
 * whether the agent now sits idle or starts working. Second, an exemption would have to be keyed on
 * spawn-time intent that this module cannot see from the scrollback, so it would be a guess about a
 * human's purpose enforced by a regex. The honest control is the rule itself: `plan = "ask"` at
 * global or project scope, which is one visible setting rather than an invisible special case.
 *
 * SECURITY: the keystroke comes ONLY from the local heuristic detector (detectPlanPrompt), never
 * from the AI/learned suggestion tier — preserving the raw-keystroke trust boundary.
 */
export function maybeAutoPlan(
  agentId: string,
  scrollback: string,
  handled: Set<string>,
): PlanOutcome | null {
  // THE BAIL IS THE PLAN PREDICATE, NOT THE ANSWERABILITY ONE — the same distinction this module's
  // router fix turns on, applied to the gate that enforces the opt-out. Bailing on
  // `detectPlanPrompt` meant that under a rename of the affirmatives (the shape that fix exists for)
  // this returned BEFORE the rule was read, so `plan = "ask"` stopped holding and the screen fell
  // through to `maybeAutoApprove` → the concierge. `detectPlanPrompt` is still required below, but
  // only by the arms that actually need a keystroke.
  //
  // No report on this arm — the exact parallel of `!classification` above: a screen that is not the
  // plan-exit prompt is not a decision about anything.
  if (!isPlanExitDialog(scrollback)) return null;
  // THE RULE IS READ BEFORE THE MASTER TOGGLE, and the order is load-bearing. An explicit
  // `plan = "ask"` is a statement about WHO decides, and it must hold whichever way the blind
  // presser is switched — checking the toggle first meant that turning OFF the more conservative
  // switch let the screen fall through to `maybeAutoApprove` → the concierge, which then answered
  // the prompt the opt-out promised to surface. The identical leak this path exists to close,
  // reached from the cautious direction.
  const root = projectRootForAgent(agentId);
  const rule = effectivePlanRule(root);
  if (rule === "ask") {
    // CLAIMED, and deliberately `declined` rather than `declineOrHandOff`. An explicit "ask me" is a
    // statement about WHO decides, not merely about who presses — routing it onward would let the
    // concierge answer the prompt the founder just said he wanted to see, which is the opposite of
    // what the settings row promises.
    declined(agentId);
    return "asked";
  }
  // Gated on the SAME master toggle as auto-approve — a sub-option of it, so it must never PRESS
  // while the parent is off. NOT claimed, deliberately: switching off the blind presser says nothing
  // about whether the concierge may READ this prompt and answer it (that is `concierge_answers`), so
  // an unset/auto/manual rule leaves the screen to `maybeAutoApprove`'s existing hand-off exactly as
  // it was before this path existed.
  //
  // `declineOrHandOff`, NOT a bare `declined`. Reporting a decline and THEN letting the caller hand
  // off is the one combination `declineOrHandOff`'s own doc forbids, and both of its outcomes are
  // wrong: a feed rebuild between the two writes latches the sticky `gaveUp` and interrupts the
  // founder for a prompt the concierge accepted, and no rebuild means the later `escalated`
  // overwrites the `declined` in the last-wins ledger so the report never happens at all. The
  // hand-off is de-duped per picker signature, so `maybeAutoApprove`'s second attempt is a no-op
  // re-stamp and `declined` fires only when the hand-off genuinely refuses.
  if (!aiFeatureVisibleNow("autoApprove")) return declineOrHandOff(agentId, scrollback);
  // THE FOUNDER'S BOUNDARY, over the same text the router sweeps. A plan that touches spend,
  // credentials or product direction goes to him even under `plan = "auto"`.
  const verdict = routeUnclassifiedPrompt(scrollback);
  if (verdict.route === "founder") {
    log.info("approvals", "plan prompt escalated rather than auto-answered", {
      agentId,
      reason: verdict.reason,
      founderClass: verdict.reason === "founder-only" ? verdict.founderClass : undefined,
    });
    // The hand-off re-runs the same routing and delivers it to him; `declined` is its fallback.
    declineOrHandOff(agentId, scrollback);
    return "asked";
  }
  const detected = detectPlanPrompt(scrollback);
  const option = rule === "auto" ? detected?.autoOption : detected?.manualOption;
  // The option this rule needs is not on THIS build's dialog — either the labels were renamed past
  // what `detectPlanPrompt` recognises, or only the other affirmative is present. Fail safe: surface
  // the prompt rather than pressing the option we DO recognise, which would silently give the
  // opposite of what the rule asked for.
  if (!option) {
    log.info("approvals", "plan prompt recognised but the rule's option is absent", {
      agentId,
      mode: rule,
    });
    declineOrHandOff(agentId, scrollback);
    return "asked";
  }
  const sig = pickerSignature(scrollback);
  // Already answered THIS picker instance: keep buttons suppressed, but never re-send the keystroke
  // — and never re-report it either (see the same early return in maybeAutoApprove).
  if (handled.has(sig)) return rule;
  handled.add(sig);
  typeAutoAnswer(agentId, option, "auto-plan");
  log.info("approvals", "auto-answered plan prompt", { agentId, mode: rule });
  return rule;
}

/**
 * What {@link maybeAutoTrust} did with the screen it was handed.
 *
 * `"asked"` IS THE LOAD-BEARING VALUE, exactly as it is for {@link PlanOutcome} — and here it is
 * load-bearing for a SAFETY reason rather than a routing one. See {@link maybeAutoTrust}.
 */
export type TrustOutcome = "trusted" | "asked";

/** The Sparkle-managed worktree recorded for `agentId`, or null when there is none.
 *
 *  ONE WRITER, and that is what makes this usable as a security input: `projectStore.setAgentWorktree`
 *  is fed the path Rust's `worktree_path()` minted from validated ids. Nothing a model said, and no
 *  id-to-path guessing. `trustPrompt.isManagedWorktreePath` re-checks the SHAPE anyway — see its
 *  doc for why that redundancy is deliberate. */
export function worktreePathForAgent(agentId: string): string | null {
  for (const p of useProjectStore.getState().projects) {
    const a = p.agents.find((x) => x.id === agentId);
    if (a) return a.worktreePath ?? null;
  }
  return null;
}

/**
 * Refuse a folder-trust dialog and CLAIM it — the shape every refusal in {@link maybeAutoTrust}
 * takes, factored out so each refusal is ONE line (see the note at the call sites).
 *
 * `declined`, deliberately NEVER `declineOrHandOff`. Routing this onward would let the concierge
 * answer the one prompt in Claude Code whose entire purpose is to ask a HUMAN whether they trust a
 * folder — which is not a narrower version of the safety scope, it is the scope switched off with an
 * extra hop in front of it.
 */
function declineTrust(agentId: string): TrustOutcome {
  log.info("approvals", "folder-trust dialog left for a human", { agentId });
  declined(agentId);
  return "asked";
}

/**
 * Decide whether to auto-answer Claude Code's FOLDER-TRUST dialog (if any) currently in
 * `scrollback`, and if so type the trust affirmative's keystroke exactly once per picker instance.
 *
 * Returns `"trusted"` when it answered, `"asked"` when it recognised the dialog and deliberately
 * left it for a human, or null when this is not the trust dialog at all.
 *
 * ── WHY THIS PATH EXISTS ──────────────────────────────────────────────────────────────────────
 * Every Sparkle agent spawns into a FRESH git worktree, so Claude Code raises its folder-trust
 * dialog on the agent's first frame and the agent sits there having done nothing. The PRIMARY fix is
 * in Rust — the spawn pre-seeds the trust key into the account config so the dialog never renders —
 * and this is the BACKSTOP for the two cases that seed structurally cannot cover: it lost a race
 * with the spawn, or it is absent (an older config, a hand-launched pane, a worktree cut before the
 * seed shipped).
 *
 * ══ `"asked"` IS A SAFETY CLAIM, NOT A ROUTING CONVENIENCE ═════════════════════════════════════
 * This dialog ALREADY reaches `maybeAutoApprove` and is already answerable by it. "Yes, I trust this
 * folder" is a plain yes (`PLAIN_YES` matches, no `YES_CONTINUATION` word in it) and "No, exit" is a
 * plain no, so `looksLikePermission` accepts it; the body — "read, edit, and execute files here" —
 * then classifies as `bash` off the word "execute". So today a user with `bash = "always"` has this
 * dialog auto-pressed FOR ANY FOLDER, and a user with no rule has it handed to the concierge.
 *
 * That is why recognising the dialog must CLAIM it in BOTH directions. Answering the in-scope case
 * is half the job; the other half is taking the OUT-OF-SCOPE case away from the general answerers,
 * so a genuine "do you trust this folder?" about a folder the founder opened by hand reaches HIM.
 * It is the one prompt in Claude Code whose entire purpose is to ask a human that question — a
 * machine answering it does not automate a chore, it deletes the control. Hence `declined` and never
 * `declineOrHandOff`: the concierge must not answer it either.
 *
 * ── WHAT "IN SCOPE" MEANS ─────────────────────────────────────────────────────────────────────
 * `trustPrompt.trustAnswerFor` is the whole rule and it lives there, as a pure function, so the
 * safety property is testable with no stores to seed: the folder must be
 * `<app data>/worktrees/<project id>/<agent id>` — the layout `worktree.rs::worktree_path` mints —
 * with the last segment matching THIS agent, and it must agree with the path the dialog prints when
 * it prints one. Every uncertain path returns null there and DECLINES here. If the path cannot be
 * established at all, that is a decline: "I could not tell" is not "it is fine".
 *
 * SECURITY: the keystroke comes ONLY from the local heuristic detector (detectTrustPrompt), never
 * from the AI/learned suggestion tier — preserving the raw-keystroke trust boundary.
 */
export function maybeAutoTrust(
  agentId: string,
  scrollback: string,
  handled: Set<string>,
): TrustOutcome | null {
  // THE BAIL IS THE DIALOG PREDICATE, NOT THE ANSWERABILITY ONE — the same distinction
  // `maybeAutoPlan` turns on. Bailing on `detectTrustPrompt` would mean that a build renaming the
  // affirmative past what the detector recognises silently returns the dialog to `maybeAutoApprove`,
  // where `bash = "always"` presses it for any folder. The rename must produce a decline, not a leak.
  //
  // No report on this arm: a screen that is not the trust dialog is not a decision about anything.
  if (!isFolderTrustDialog(scrollback)) return null;
  // Gated on the SAME master toggle as its three siblings — this is a sub-behaviour of "auto-respond
  // to prompts" and must never press while the parent is off. CLAIMED even so: switching off the
  // presser does not make it safe for the concierge to answer a trust question, which is the one
  // thing `declineOrHandOff` would do here.
  // BOTH REFUSALS ARE ONE LINE, so `scripts/mutation-check.sh` can judge them: commenting out the
  // head of a multi-line `if` whose body is a block leaves a dangling brace, the mutant will not
  // parse, and the guard becomes one no check can prove is live. The same reason `autoApproveWatch`
  // keeps its `ASK` test on one line.
  if (!aiFeatureVisibleNow("autoApprove")) return declineTrust(agentId);
  const option = trustAnswerFor(scrollback, agentId, worktreePathForAgent(agentId));
  // Out of scope, or the path could not be established, or the only affirmative widens past this
  // folder. All three are the same statement: the human decides this one.
  if (!option) return declineTrust(agentId);
  const sig = pickerSignature(scrollback);
  // Already answered THIS picker instance: never re-send the keystroke, and never re-report it
  // either (see the same early return in maybeAutoApprove).
  if (handled.has(sig)) return "trusted";
  handled.add(sig);
  // `typeAutoAnswer` reports `handled` to the blocked-prompt grace window on a delivered write and
  // `unreachable` on a dead pane — which is what keeps an agent parked on this dialog OUT of the
  // needs-you band while the answer lands, and surfaces it at once when it cannot land. Note the
  // burn rule in `engine/blockedPromptGrace`: a prompt identity is held ONCE and never again, so a
  // dialog that reappears after an app restart goes straight to red unless it is genuinely ANSWERED.
  // This path answers.
  typeAutoAnswer(agentId, option, "auto-trust");
  log.info("approvals", "auto-trusted a Sparkle-managed worktree", { agentId });
  return "trusted";
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

/** Effective plan-exit rule for a project (imperative). Project override beats global; when the
 *  project's value hasn't loaded (or there's no project) the global mirror answers. Always resolves
 *  to a concrete rule ("auto" is the default), never undefined. */
export function effectivePlanRule(root: string | null): PlanRule {
  const global = useSettingsStore.getState().planRule;
  if (!root) return global;
  const proj = useApprovalsStore.getState().planByRoot[root];
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
          // The plan sibling rides the same pull, for the same reason and with the same complaint.
          const planComplaint = planRuleComplaint(eff.config.approvals?.plan);
          if (planComplaint) log.warn("approvals", planComplaint, { root });
          useApprovalsStore.getState().setPlanForRoot(root, asPlanRule(eff.config.approvals?.plan));
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
