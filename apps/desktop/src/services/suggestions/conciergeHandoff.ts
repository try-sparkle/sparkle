// HAND A PROMPT THE LOCAL ANSWERER WILL NOT ANSWER TO THE CONCIERGE, INSTEAD OF TO THE FOUNDER.
//
// ── THE REPORT (founder, 2026-08-13, third time asked) ──────────────────────────────────────────
// *"Why was @Sparkle Watcher Pusher Enforcement stuck on [a plan]? You are supposed to be seeing and
// approving these plans without me as the human needing to do that."* And, minutes later, twice more
// — an agent stopped on `gh pr view 1777`, and one stopped on a read-only `git rev-list --count`
// sweep: *"I don't know why the watcher is not watching it. I don't know why the pusher isn't
// pushing for it to be taken care of. I don't know why it's just sitting, waiting for someone like a
// human to handle it when you as a system should be handling it."*
//
// ── WHAT WAS ACTUALLY BROKEN, WHICH IS NOT WHAT IT LOOKED LIKE ──────────────────────────────────
// The Watcher (`autoApproveWatch`) was never asleep. It subscribes to every runtime store write,
// examines every agent in `waiting`/`approval`, waits out a 1200ms settle, and reads the screen. It
// SAW all three prompts. What it lacked was anywhere to send one it would not press itself:
// `approvalsRuntime.declined()` is documented as "I read this prompt and I am not going to answer
// it", and its only consequence is to surface the row to the FOUNDER at once. There was no third
// destination in the code, so every decline arm — five of them — pointed at one human.
//
// The three reports were TWO different arms, which is why this fix is wider than the first one asked
// for:
//
//   • THE PLAN PICKER (report 1) took the `!classification` arm. `classifyApproval` requires the menu
//     to reduce to a Yes/No PAIR (`looksLikePermission`: a plain "Yes" AND an explicit "No"). A
//     four-option plan menu — "1 · 2, progress-gated" … "4 · 1 — one re-arm only" — is not that
//     shape, so the classifier returned null and the Watcher dropped the screen silently. Not even a
//     `declined` was recorded; the prompt reached him when the 30-second grace ceiling lapsed.
//
//   • THE TWO BASH PROMPTS (reports 2 and 3) took the `rule !== "always"` arm — the OPPOSITE
//     situation. Both were textbook pairs, both classified cleanly as `bash`, and the Watcher knew
//     the exact keystroke. It declined because no `always` rule authorised it to press, which is
//     correct policy and must stay correct policy. It just had nobody to ask but him.
//
// Both arms end in the same place for the same reason, so the hand-off is fitted to the DECLINE, not
// to the classifier. Anything the local answerer will not press is offered to the concierge first.
//
// ── WHY THE CONCIERGE IS A CAPABLE ANSWERER AND WAS SIMPLY NEVER ASKED ──────────────────────────
// It already holds `read_picker_options` and `select_picker_option` (services/conciergeTools/
// terminal.ts). The second takes a `fingerprint` covering the question AND the options and refuses
// if the menu changed underneath, so it cannot press a button that is no longer the one it read. The
// machinery to answer these safely has been shipped for some time; nothing generated the ask.
//
// `conciergeProactive.observe()` does push the concierge — but only on a change in the `needs_you`
// digest, i.e. only once the row is ALREADY the founder's problem, and its prompt instructs the
// concierge to "summarize what needs them and what you recommend". That is an instruction to
// DESCRIBE the blockage to him, not to open the menu and answer it, and it carries neither the
// question nor the options. So the one existing channel arrives late and asks for the wrong thing.
// This module uses `notifyConcierge`, the notice channel, which speaks on its own terms.
//
// ── THE LINE BETWEEN "CONCIERGE ANSWERS IT" AND "THE FOUNDER MUST" (his call, 2026-08-13) ───────
// Asked directly where he wanted it drawn, he chose: DEFAULT IS THE CONCIERGE, with an explicit
// named deny-list that still reaches him — spend/billing/quota, credentials and secrets, anything
// destructive or irreversible, a product-direction call, and legal/account. That list lives in
// `conciergeEscalation.founderOnlyClass` and is deliberately biased toward him: a false "founder
// only" costs him a prompt he would have seen anyway, while a false "concierge" lets an agent press
// an irreversible button. See that module for the patterns.
//
// TWO REFUSALS ARE ENFORCED HERE RATHER THAN THERE, because they are facts about the PROMPT'S
// PROVENANCE that the text classifier cannot see:
//
//   1. AN UNREADABLE QUESTION IS NEVER HANDED ON. `routeUnclassifiedPrompt` refuses a menu whose
//      question could not be read (`unreadable-picker`), and this module honours that refusal by
//      declining to the founder. Routing to the concierge must not become a way to press a button
//      NOBODY read — it is the same property `select_picker_option` enforces with its empty-
//      fingerprint refusal, and it has to hold at both ends or it holds at neither.
//   2. A DENIED MCP TOOL IS NEVER HANDED ON. `mcpToolPolicy.isDeniedTool` already refuses anything
//      that spawns, discards, merges, pushes or speaks as the founder EVEN IF he set `mcp =
//      "always"`. That set IS the "destructive or irreversible" class in machine-readable form, so
//      its veto is absolute here too. The caller in `approvalsRuntime` keeps that arm pointed
//      straight at `declined` and never reaches this module — see the comment at that call site.
//
// ── ITS OWN SWITCH, NOT `ai.auto_approve` (his call, same conversation) ─────────────────────────
// `ai.auto_approve` means "let a purely local REGEX press buttons that nobody read". This is a
// different act: a reasoning agent READS the question and then answers. Coupling them would mean
// switching off the blind presser also silences the thing that reads — so `[approvals]
// .concierge_answers` (default true) governs this path alone. Turning auto-approve off therefore
// still leaves prompts being handled; it just stops them being handled unread. Two acts, two
// switches, two honest meanings.
//
// ── WHAT THIS DOES NOT COVER, DELIBERATELY ──────────────────────────────────────────────────────
// `maybeAutoResume` is untouched. The session-resume prompt's cost is a large slice of usage limits
// (config.rs says so where it defaults `resume` to "ask"), which puts it adjacent to the `spend`
// class the founder reserved for himself. It keeps today's behaviour until he says otherwise.
import { notifyConcierge } from "../conciergeNotifier";
import { readPickerOptions } from "../pickerRead";
import { notePromptAnswerOutcome } from "../../engine/blockedPromptGrace";
import { useSettingsStore } from "../../stores/settingsStore";
import { useProjectStore } from "../../stores/projectStore";
import { routeUnclassifiedPrompt, escalationNoticeText } from "./conciergeEscalation";
// FROM `heuristics`, NOT from `approvalsRuntime` — which re-exports it and would therefore work,
// while closing the runtime cycle (`approvalsRuntime` imports this module) that moving the function
// down to `heuristics` existed to prevent. A cycle that happens to resolve today is still the thing
// the move was for.
import { pickerSignature } from "./heuristics";
import { log } from "../../logger";

/**
 * Picker instances already offered to the concierge, per agent.
 *
 * WHY THIS IS NEEDED AT ALL: the Watcher re-decides an agent's screen on every status or capture
 * change, and an unanswered prompt STAYS ON SCREEN — that is the whole condition being fixed. So
 * without a de-dupe the identical notice is minted every few seconds for minutes on end, and the
 * scheduler's `notify` is idempotent on TEXT but the surrounding cost controls (a two-minute floor,
 * six turns an hour) would be spent re-offering something already owed.
 *
 * KEYED ON {@link pickerSignature}, the same option-set hash `maybeAutoApprove` de-dupes its
 * keystrokes with, so a re-rendered scrollback hashes identically and is suppressed while a
 * genuinely different menu is offered afresh. NOT shared with `handledSigs`: that set means
 * "answered", and adding to it would suppress a later legitimate auto-approve of the same picker.
 */
const offered = new Map<string, Set<string>>();

/** Per-agent bound on remembered signatures. A prompt this agent has not drawn in {@link
 *  OFFERED_PER_AGENT} distinct menus may be re-offered, which costs one extra notice — the notice
 *  channel deduplicates on text anyway, so the failure direction is harmless. */
const OFFERED_PER_AGENT = 32;

/** The agent's display name, for a notice a human may end up reading. Falls back to the id — an
 *  unnamed agent must still be nameable, and a notice saying "an agent" is one nobody can act on. */
function agentLabelFor(agentId: string): string {
  for (const p of useProjectStore.getState().projects) {
    const a = p.agents.find((x) => x.id === agentId);
    if (a) return a.name || agentId;
  }
  return agentId;
}

/** Is concierge routing switched on? Mirrored from `[approvals].concierge_answers`, default true. */
function conciergeAnswersEnabled(): boolean {
  return useSettingsStore.getState().conciergeAnswers;
}

/**
 * Offer `agentId`'s on-screen prompt to the concierge. Returns TRUE only when the concierge has
 * actually accepted it — in which case the caller must NOT report `declined`, because the prompt is
 * now someone's job and reporting a decline would surface it to the founder anyway, which is the
 * entire behaviour being removed.
 *
 * FALSE MEANS FALL BACK TO TODAY'S BEHAVIOUR, and it is returned for every reason a hand-off did not
 * happen: the switch is off, there is no readable menu, the deny-list claims it, or nobody was
 * listening. The caller's next line is its existing `declined(agentId)`, unchanged.
 *
 * "NOBODY WAS LISTENING" IS A REAL STATE AND MUST NOT BE READ AS DELIVERY. `notifyConcierge` returns
 * a boolean precisely because four other delivery paths in this app have been caught reporting
 * successes they never observed (see its header). No window open, host unmounted, scheduler disposed
 * or refusing at its ceiling — all of those come back `false`, and every one of them means this
 * prompt has no answerer but the founder. Treating an unaccepted push as an escalation would hide
 * the prompt for the full four-minute ceiling on the strength of a message that went nowhere.
 */
export function handOffToConcierge(agentId: string, scrollback: string): boolean {
  if (!conciergeAnswersEnabled()) return false;
  const verdict = routeUnclassifiedPrompt(scrollback);
  if (verdict.route === "none") return false; // no menu drawn — nothing to hand over
  if (verdict.route === "founder") {
    // Logged rather than silent: these two are the safety refusals, and the founder needs to be able
    // to tell "the concierge declined to answer this" from "nothing ever looked at it" — which is
    // exactly the ambiguity that made the original report hard to diagnose.
    log.info("approvals", "prompt kept for the founder", {
      agentId,
      reason: verdict.reason,
      founderClass: verdict.reason === "founder-only" ? verdict.founderClass : undefined,
    });
    return false;
  }
  const sig = pickerSignature(scrollback);
  const seen = offered.get(agentId) ?? new Set<string>();
  if (seen.has(sig)) {
    // ALREADY OFFERED, AND STILL TRUE. Report the escalation again anyway: the outcome is what holds
    // the row back from the founder, and it is compared against the CURRENT episode's start. A
    // re-drawn prompt opens a new episode, so an outcome recorded only on the first sighting would
    // predate it and the hold would lapse while the concierge is still working the same menu.
    notePromptAnswerOutcome(agentId, "escalated");
    return true;
  }
  // DELIVERY-TIME RE-VALIDATION (bead sparkle-st06sq). This notice may not reach the concierge for
  // seconds-to-a-minute — longer than the multi-question wizards that raise it stay on any one
  // question — so by the time it is spoken the menu is often gone and the agent is working again.
  // Hand the notice a predicate that re-reads the live screen at delivery and drops it if so.
  //
  // IT DROPS ON ONE THING ONLY: the reader looked at the screen and POSITIVELY SAW NO MENU
  // (`blind === "no-menu"`). Everything else keeps the notice. Two separate High reviews
  // (roborev 69361, 69362) landed on the same two ways the earlier `live.present &&
  // live.fingerprint === captured` form suppressed a real escalation, and both losses are
  // PERMANENT rather than deferred, because `seen.add(sig)` below makes the `seen.has(sig)` early
  // return the only thing a later watcher pass reaches:
  //
  //   • BLINDNESS IS NOT RESOLUTION. `present:false` has three causes, and only one of them is "no
  //     menu". `readPickerOptions` -> `liveOptionsFor` reads the LIVE XTERM BUFFER, which is null
  //     whenever the pane is unmounted — and per conciergeTools/terminal's own header, "on a real
  //     fleet most agents are unmounted most of the time". Clicking to another agent between raise
  //     and delivery therefore read as "the menu resolved". `footer-without-options` is the
  //     sparkle-99o9a blind-reader shape the raise-time guard below already refuses to trust, and
  //     trusting it here contradicted that. The `blind` discriminator exists to tell these apart
  //     and was not being consulted.
  //   • A DIFFERENT LIVE MENU IS STILL A "NEEDS YOU". `pickerFingerprint` hashes options + the
  //     question block; `pickerSignature` (the de-dupe above) hashes option labels + keystrokes
  //     only. A wizard's next question commonly shares the SIGNATURE and changes the FINGERPRINT —
  //     `1. Yes / 2. Yes, don't ask again / 3. No` is the ubiquitous shape — so question 1's notice
  //     was dropped for mismatch and question 2 could never raise one. The agent sat at a live
  //     menu with nothing owed. A repaint or wrap that shifts the parsed question block does the
  //     same to an UNCHANGED menu (`pickerFingerprint`'s QUESTION_CONTEXT_LINES fallback is
  //     documented as producing different hashes for one menu). The notice text tells the concierge
  //     to `read_picker_options` first and answer whatever is actually on screen, so delivering it
  //     against a moved-on question is correct, not a mis-answer.
  //
  // What is left is a strictly weaker filter than the original design intended, and deliberately:
  // the P0 rule is "never hide a row that needs action from me", and re-speaking a notice about a
  // menu that is still up costs a sentence, while dropping one costs the founder a stuck agent.
  //
  // THE RAISE-TIME GATE IS UNCHANGED. An empty fingerprint means the reader is blind to a menu that
  // IS on screen right now; attaching any predicate that re-reads through the same blind reader
  // would risk dropping on the spot. No predicate = always-deliver.
  const detected = readPickerOptions(agentId);
  const capturedFingerprint = detected.present ? detected.fingerprint : "";
  const revalidate =
    capturedFingerprint !== ""
      ? () => {
          const live = readPickerOptions(agentId);
          // A menu is up — still owed, whichever question it is now.
          if (live.present) return true;
          // Not present. Drop ONLY on a positively-read empty screen; every blind read keeps it.
          return live.blind !== "no-menu";
        }
      : undefined;
  const accepted = notifyConcierge(
    escalationNoticeText(agentLabelFor(agentId), verdict),
    "pusher",
    revalidate,
  );
  if (!accepted) {
    log.warn("approvals", "concierge hand-off refused; the prompt goes to the founder", { agentId });
    return false;
  }
  seen.add(sig);
  while (seen.size > OFFERED_PER_AGENT) {
    const oldest = seen.values().next();
    if (oldest.done) break;
    seen.delete(oldest.value);
  }
  offered.set(agentId, seen);
  // THE HOLD. `escalated` keeps the row out of the founder's needs-you band on a longer but still
  // finite ceiling (engine/blockedPromptGrace). It is not `handled` — nothing was typed — and it is
  // not `declined`, which would surface it at once. If the concierge never answers, that ceiling is
  // what puts the prompt back in front of him.
  notePromptAnswerOutcome(agentId, "escalated");
  log.info("approvals", "prompt handed to the concierge", {
    agentId,
    options: verdict.options.length,
  });
  return true;
}

/** Drop every remembered offer. Tests only — module state outlives a case, and a leaked signature
 *  silently suppresses the next one's hand-off. */
export function resetConciergeHandoffForTests(): void {
  offered.clear();
}
