// Concierge dispatch/relay — the "translation layer" write path (Concierge Mode, bead sparkle-xzl8).
//
// The concierge column is the user's single point of interaction. When the user answers in the
// concierge box, THIS module routes that answer into the correct agent's terminal (PTY) so the user
// never types in the terminal directly. It reuses the exact primitives the phone-approvals relay and
// the composer already use (`pty.ts` + the suggestion detectors), and inherits their safety rules.
//
// SECURITY / SAFETY (mirrors services/relayGate.ts + services/suggestions/approvalClassifier.ts):
//   1. PTY id === agent id — a dispatch always targets a specific agent's own PTY.
//   2. Re-classify the agent's CURRENT scrollback immediately before writing. The screen may have
//      advanced since the concierge surfaced the prompt; we only ever send a keystroke that maps to
//      an option STILL present on screen.
//   3. When a picker/prompt is live we send ONLY a detector-provided option value (e.g. "2\n" / "y\n")
//      — never free text authored into a raw-mode picker (that could mis-select). If the user's answer
//      doesn't map to a live option we REFUSE and report the options back, rather than guessing.
//   4. Free text (no live prompt) goes through the strict `submitPrompt` (bracketed-paste + CR,
//      per-agent serialized) which REJECTS on a dead PTY — so a dropped answer is never silently
//      recorded as delivered.
//   5. Every keystroke is CR-framed via `frameSubmit` (raw-mode Ink pickers only accept `\r` as Enter).
//
// The model/brain never calls this with raw bytes — it can only recommend; the USER's typed answer is
// what drives a dispatch, and it is matched against locally-detected options here.
//
// SIDE-EFFECTS OF A PROMPT (CM-U7). The terminal-adjacent composer is gone — the concierge box is
// the only composer — so the things that composer did around a send now happen HERE, on the
// free-text path (the one that actually delivers a new prompt) — but ONLY when the caller says the
// text is a genuine USER PROMPT (`{ userPrompt: true }`). They are opt-IN because this module also
// carries machine-authored one-worders: the nudge card's Approve button falls back to free text
// when the picker has scrolled off, and the word "approve" must never land in the prompt history,
// debit a free-trial prompt, or become the agent's auto-name.
//   1. projectStore.appendPrompt — records the prompt for the pinned header + history dropdown,
//      and returns the id everything else keys on.
//   2. terminalMarkers.markAgentPrompt — drops a terminal marker under that id so "jump to this
//      prompt" can scroll back to it later this session.
//   3. agentNaming.maybeAutoName — summarizes the work into a short agent name (gated on the
//      autoRename AI feature, as it was in the composer).
//   4. promptHistoryStore.record — feeds the ghost-text suggestions the composer used to learn from.
// Plus the free-trial meter: recordTrialSend() debits ONE prompt AFTER delivery, exactly as the
// composer did, so a dispatched prompt is metered and a failed one never is.
//
// A picker keystroke is an ANSWER to a live prompt, not a new one: it records a `"picker"`-sourced
// entry (no marker, no meter, no naming) exactly as the composer did — components/promptHistory.ts
// keeps those entries out of every DISPLAY surface while still letting them advance the naming
// ladder's promptCount, and dropping the entry entirely would silently change that cadence.
//
// TRIAL GATE. The composer refused a send BEFORE delivery when the server said the free trial was
// spent, and debited after. Both halves live here now: trialSendAllowed() gates the free-text path
// (→ the "trial-spent" refusal the concierge surfaces), recordTrialSend() debits a delivered user
// prompt. The gate is unconditional on the free-text path — a spent trial can't drive an agent at
// all — while the debit stays tied to `userPrompt`, so a machine-authored fallback is never charged.
//
// PTY NOT UP YET. "Create an agent, then tell it what to do" reaches this module before the pane's
// PTY exists. Rather than dropping the prompt as `pty-gone` (what the composer's queue-and-flush
// prevented), a send aimed at an agent that IS open but not yet ready is QUEUED — bounded, per
// agent — and flushed by the pane on ptyReady (see services/pendingSends + flushPendingSends).
// A send that overflows that bound is refused as `queue-full`: "too many prompts are already
// waiting" is a different fact from "the terminal is gone", and only one of them asks the user to
// restart anything.

import { PtyGoneError, submitPrompt, writePtyChainedStrict } from "../pty";
import { describeAuthority, isDispatchAuthority, type DispatchAuthority } from "./dispatchAuthority";
import { frameSubmit } from "./relayGate";
import { log } from "../logger";
import { getAgentScrollback } from "./terminalScrollback";
import { markAgentPrompt } from "./terminalMarkers";
import { detectTerminalPrompts } from "./suggestions/heuristics";
import { maybeAutoName } from "./agentNaming";
import { recordTrialSend, trialSendAllowed } from "./trialMeter";
import { aiFeatureNow } from "./aiGate";
import { queuePendingSend, takePendingSends } from "./pendingSends";
import { paneState } from "./paneReadiness";
import { findKnownAgent } from "./knownAgents";
import { useProjectStore } from "../stores/projectStore";
import { usePromptHistoryStore } from "../stores/promptHistoryStore";
import type { SuggestionButton } from "./suggestions/types";

/** Where a dispatch was routed, or why it was refused. */
export type ConciergeDispatchPath =
  | "picker-option" // matched a live prompt option → sent that option's keystroke
  | "free-text" // no live prompt → sent the text as a prompt to the agent
  | "queued" // the agent's PTY isn't up yet → held, flushed when the pane reports ready
  | "queue-full" // the agent is starting but its hold queue is full (refused, NOT delivered)
  | "ambiguous-picker" // a prompt is live but the answer didn't map to any option (refused)
  | "addressed-at-picker" // a composed MESSAGE (addressed, or an attachment-carrying redirect)
                         // arrived while a picker owns stdin (refused — see neverPickerAnswer)
  | "empty" // nothing to dispatch (blank/whitespace answer)
  | "trial-spent" // the server says the free trial is spent (refused BEFORE delivery)
  | "expired" // held too long waiting for a PTY that never came up (NOT delivered)
  | "abandoned" // the pane closed or errored while the send was held (NOT delivered)
  | "agent-failed" // the pane GAVE UP (spawn error / Claude missing) — Retry is the remedy (NOT delivered)
  | "cloud-agent" // the target runs in the cloud — there is no local PTY to write to (NOT delivered)
  | "unauthorized" // no valid DispatchAuthority — nobody declared why this may be sent (NOT delivered)
  | "pty-gone"; // the agent's PTY was dead (answer NOT delivered)

export interface ConciergeDispatchResult {
  ok: boolean;
  path: ConciergeDispatchPath;
  agentId: string;
  /** The exact string written to the PTY (present only when ok). May contain attachment paths —
   *  never quote this at the user; quote `display`. */
  sent?: string;
  /** `sent` as the user should SEE it (counts, not temp paths). Present whenever `sent` is, so a
   *  caller that reconciles a deferred outcome in the thread has something safe to quote. */
  display?: string;
  /** The option that matched (present for path "picker-option"). */
  matchedLabel?: string;
  /** The live options offered, so the UI can prompt the user to pick. Present for BOTH picker
   *  refusals — "ambiguous-picker" and "addressed-at-picker" — since the second was split out of
   *  the first and carries the same options (roborev 54665/54673). */
  options?: SuggestionButton[];
}

/** How a dispatch should be treated. `userPrompt` marks the text as something the USER authored
 *  (the concierge compose box aimed at an agent) — the only case that records history, drops a
 *  marker, meters the trial and feeds auto-naming. Machine-authored text (the nudge Approve
 *  fallback) leaves `userPrompt` at its default of false and is delivered with no side-effects.
 *
 *  THREE RENDERINGS OF ONE MESSAGE (roborev 46911/46925). The removed composer built three strings
 *  and used each in exactly one place; collapsing them onto the wire text leaks attachment temp
 *  paths into surfaces the user reads:
 *    • `text` (the wire payload) — paths + typed text, the only one written to the PTY;
 *    • `display` — the typed text plus compact counts, for the pinned prompt header and the
 *      history dropdown (PinnedPrompt renders these verbatim);
 *    • `namingBasis` — the TYPED text only, for the ghost-suggestion corpus and the auto-name
 *      model. EMPTY for an attachments-only send, which is what makes naming skip it rather than
 *      handing the model a bare `/tmp/sparkle-shot-1753.png`.
 *  Both default to `text`, so a caller with no attachments is unaffected. */
export interface ConciergeDispatchOptions {
  /**
   * WHY is this text allowed to reach a build agent's terminal? See services/dispatchAuthority.
   *
   * REQUIRED and NON-DEFAULTED, which is the entire point (design §3 A1). The reported bug — user
   * text typed at the concierge silently forwarded to an agent — was not a stray code path; it was
   * `conciergeRouter` deciding a destination and this function delivering on the strength of that
   * decision alone. A default here (or an optional field) would let the next call site re-create it
   * with no type error, so there is deliberately no way to call this without naming the user gesture
   * that authorized the write.
   *
   * Note there is no `router` arm in the union, and there must never be one: a heuristic verdict is
   * not a user gesture. The router's verdict becomes legal only once it has been through
   * services/dispatchIntent and come out the other side as `{ kind: "countdown" }` — i.e. only once
   * the user has been shown the send and declined to stop it.
   */
  authority: DispatchAuthority;
  userPrompt?: boolean;
  /** What the prompt-history surfaces show. Defaults to the wire text. */
  display?: string;
  /** What ghost-text and auto-naming learn from; "" deliberately skips naming. Defaults to the
   *  wire text. */
  namingBasis?: string;
  /**
   * This text must NEVER be collapsed into a picker keystroke, however well it matches an option
   * on the agent's screen — and BECAUSE that is the claim, it is now read BEFORE the matcher runs
   * (see the picker block below): whether the text happens to match is irrelevant to a caller that
   * has already said it is not an answer.
   *
   * Set by the two callers that mean "the user composed a MESSAGE" (roborev 55400):
   *   • an @-ADDRESSED send — `@Kraken Auth yes`, see ConciergeHost's mention routing;
   *   • a REDIRECT of a message that CARRIED FILES — the replay carries the attachments' quoted
   *     paths, and a person who attached a picture to their question did not send an option.
   *
   * ══ WHY THE CALLER CANNOT ENFORCE THIS ITSELF (roborev 54569) ═══════════════════════════════
   * `answersLivePicker` is a MIRROR of the gate below, exported for callers that must know the
   * disposition before they build a payload — it decides nothing. The host suppressed it for an
   * addressed send and believed that made the message safe; it did not. The picker block below runs
   * on whatever text arrives, so `@Kraken Auth yes` still reached `matchAnswerToOption`, still read
   * as terse, and still wrote `y\r` — pressing a button in answer to a question the user never
   * read, which is the least recoverable thing this path can do. A host-level test could not catch
   * it either, because it mocks this function.
   *
   * The disposition therefore has to be declared TO the dispatcher, not decided beside it.
   *
   * It REFUSES rather than writing the text as free text, and that is deliberate. A live picker
   * owns the agent's stdin: free text plus a carriage return typed at a select prompt can move or
   * accept the highlighted row, so "send it as a message instead" would be a different accidental
   * keystroke rather than a fix.
   *
   * The refusal takes its OWN path, `addressed-at-picker`, and does not share `ambiguous-picker`.
   * Sharing was tried and was a dead end: that copy says the answer mapped to nothing and offers
   * "answer with just the option", and for an addressed message both are false — the text mapped
   * perfectly (which is WHY it was refused: an addressed message is a message, not a keystroke),
   * and answering with just the option is what the user already did. It sent them round a loop
   * whose only exit was guessing that the `@` was the problem. (roborev 54665; the follow-up
   * 54673 then removed the "drop the @" remedy from the new copy too — see ConciergeHost's
   * `refusalCopy`, where that advice could aim a bare "yes" at a different agent's picker.)
   */
  neverPickerAnswer?: boolean;
}

// WHOLE-PHRASE anchored (roborev 46311): the entire trimmed answer must be a member of the
// family — "go ahead" and "yes please" are answers; "yes, but rename the flag first" is an
// instruction; "yes-but-the-other-one" is neither (a \b prefix match used to accept it).
// The trailing class carries `?` as well as `.!` (roborev 46485-L): "ok?" and "yes?" are how
// people actually confirm, and dropping them to `ambiguous-picker` was an unintended narrowing.
const YES_WORDS =
  /^\s*(y|yes|yeah|yep|approve|approved|ok|okay|confirm|accept|allow|go|go ahead|do it|please do|sure|sure thing|yes please|sounds good)[.!?\s]*$/i;
const NO_WORDS =
  /^\s*(n|no|nope|deny|denied|reject|cancel|stop|don'?t|do not|no thanks|no thank you|not now)[.!?\s]*$/i;

/** True when the button is the plain-affirmative option: label "Yes…" or the y/N "y\n" value.
 *  Deliberately does NOT match any label merely starting with a standalone "y" (e.g. "Y - use YAML"),
 *  which would let a "yes"-family answer select a non-affirmative option on a non-yes/no picker. */
function isAffirmative(b: SuggestionButton): boolean {
  return /^\s*yes\b/i.test(b.label) || /^y[\r\n]*$/i.test(b.value);
}
/** True when the button is the negative option ("No", or the y/N "n" answer). */
function isNegative(b: SuggestionButton): boolean {
  return /^\s*no\b/i.test(b.label) || /^n[\r\n]*$/i.test(b.value);
}

/**
 * Map a user's free-text answer onto one of the live detector-provided options, or null if it
 * doesn't clearly correspond to any. PURE — the security-critical matching, unit-tested in isolation.
 * Never invents an option; only ever returns one of `options`.
 */
export function matchAnswerToOption(
  text: string,
  options: SuggestionButton[],
): SuggestionButton | null {
  if (options.length === 0) return null;
  const t = text.trim();
  if (t === "") return null;

  // 1. A bare option number the user typed ("2"). First match it against a numbered option's
  //    label/value; otherwise fall back to the 1-based on-screen POSITION (so "1" answers the first
  //    option even on a Yes/No picker whose labels are words). Out-of-range numbers stay unmatched.
  const asNum = t.match(/^(\d{1,2})[.)]?$/);
  if (asNum) {
    const n = asNum[1] ?? "";
    const hit = options.find((o) => o.label.trim() === n || o.value.replace(/[\r\n]+$/, "") === n);
    if (hit) return hit;
    const idx = parseInt(n, 10) - 1;
    if (idx >= 0 && idx < options.length) return options[idx]!;
  }

  // 2. Exact (case-insensitive) label match.
  const exact = options.find((o) => o.label.trim().toLowerCase() === t.toLowerCase());
  if (exact) return exact;

  // 3. Yes/approve family → the affirmative option; No/deny family → the negative option.
  if (YES_WORDS.test(t)) {
    const yes = options.find(isAffirmative);
    if (yes) return yes;
  }
  if (NO_WORDS.test(t)) {
    const no = options.find(isNegative);
    if (no) return no;
  }

  return null;
}

/**
 * The one lookup behind both predicates below.
 *
 * NOT a bare `projectStore` scan any more. That array is the user's build-agent roster and is not
 * the set of agents the app runs — the app-owned Sparkle self-improvement agent is deliberately
 * outside it — so scanning it made "Improve Sparkle" unaddressable from every surface that gates on
 * this. `findKnownAgent` (services/knownAgents) is the shared resolver; read its header for the
 * three arms and why the Sparkle one is not merely a special case of the last.
 */
const findAgent = findKnownAgent;

/**
 * Is this agent DEFINITELY a cloud agent (no local PTY)? The dispatcher's refusal test.
 *
 * Deliberately only true on EVIDENCE. An agent nothing can resolve may still have a live PTY — a
 * store/window sync gap, an agent mounted before its project row lands — and refusing it as
 * "cloud-agent" would be a lie about why the send failed. So would refusing on the `observed` arm's
 * `runtime: "unknown"`, which says "no record names the runtime", not "it is remote". Let the write
 * attempt decide; it reports pty-gone honestly if there's nothing there.
 */
function isCloudAgent(agentId: string): boolean {
  return findAgent(agentId)?.runtime === "cloud";
}

/**
 * Am I CONFIDENT this agent can receive a message? The router's gate — a different question from
 * `isCloudAgent`, and it fails the other way on purpose.
 *
 * The dispatcher is answering "must I refuse this?" and should only refuse on evidence. The router
 * is answering "should I aim an irreversible PTY write here?" and must decline without evidence:
 * an agent absent from the store usually means the project was unloaded or the agent removed,
 * which is precisely when delivery is least likely to work. So "not found" is FALSE here and does
 * not trigger a refusal there. Exported so the router asks this instead of copying the lookup.
 */
export function agentCanAcceptInput(agentId: string): boolean {
  const agent = findAgent(agentId);
  return !!agent && agent.runtime !== "cloud";
}

/** Read the agent's current terminal, detecting any live prompt options (empty if none on screen). */
export function liveOptionsFor(agentId: string): SuggestionButton[] {
  const scrollback = getAgentScrollback(agentId) ?? "";
  return detectTerminalPrompts(scrollback);
}

/**
 * Would `text` be taken as an answer to a picker the agent has on screen RIGHT NOW?
 *
 * A mirror of the two conditions `dispatchConciergeAnswer` applies below — a live-option match plus
 * terseness — for a caller that must know the disposition BEFORE it builds a payload. Change the
 * gate there and change it here.
 *
 * ══ IT HAS NO PRODUCTION CALLER TODAY, AND THE CONCIERGE BOX MUST NOT BECOME ONE AGAIN ═════════
 * The concierge compose box used to consult it. It prefixes the quoted paths of any staged
 * attachments onto the text it sends (`attachedPayload`), and that prefix defeats the matcher
 * completely — every arm of `matchAnswerToOption` is anchored (`YES_WORDS` is `^…$`), so
 * `"/var/folders/…/shot.png" Yes` matched nothing and came back `ambiguous-picker`. On a true it
 * therefore sent UNPREFIXED and left the files staged, on the reasoning that a picker answer is a
 * keystroke rather than a message that could carry a file.
 *
 * Both halves of that reasoning are gone. `routeMessage` can no longer return `agent` at all (see
 * conciergeRouter's header), so an unaddressed send never reaches this module — the lever fired only
 * on CONCIERGE-bound text and silently withheld the user's screenshot from the brain
 * (roborev 55033). And an ADDRESSED send arrives here with `neverPickerAnswer`, which refuses rather
 * than pressing a button, so it cannot become a keystroke either.
 *
 * Re-wiring it would also be unsafe in a second way. It reads the screen at SUBMIT while the
 * dispatch re-reads it after the countdown, so the two can disagree when a picker clears in
 * between — and the send then lands as an ordinary prompt stripped of the files it was meant to
 * carry. Whatever needs this next has to survive that gap.
 *
 * (Clicking a terminal-kind suggestion pill is unaffected either way: `applySuggestion` writes the
 * keystroke straight to the PTY and never reaches this module.)
 */
export function answersLivePicker(agentId: string, text: string): boolean {
  const options = liveOptionsFor(agentId);
  if (options.length === 0) return false;
  return isTerseAnswer(text, options) && matchAnswerToOption(text, options) !== null;
}

/**
 * Route a user's concierge answer to `agentId`'s terminal. Re-reads the CURRENT screen so we only
 * answer a still-present prompt. Returns a structured result; the concierge surfaces it (e.g. "sent",
 * "which option?", or "that agent's terminal has closed"). Never throws for the expected outcomes.
 */
export async function dispatchConciergeAnswer(
  agentId: string,
  text: string,
  /** No default, deliberately — `authority` must be declared. See ConciergeDispatchOptions. */
  opts: ConciergeDispatchOptions,
): Promise<ConciergeDispatchResult> {
  // THE GATE, and it runs before everything — ahead of the emptiness check, the cloud check and any
  // screen read. TypeScript already stops a call site that forgets `authority`; this is the belt for
  // the shapes the compiler never sees (a JS consumer, an object rebuilt off the wire, a future
  // store round trip). It FAILS CLOSED like every other check in this module: an unknown kind or a
  // blank id is not an authority, and we refuse rather than guess.
  if (!isDispatchAuthority(opts.authority)) {
    log.warn("concierge", "refused an un-authorized dispatch", { agentId });
    return { ok: false, path: "unauthorized", agentId };
  }
  // The audit line the union exists to make possible: a "why did it type that?" complaint resolves
  // to the gesture that permitted the write, not to a guess. `debug` because it is per-send and
  // debug forwarding is off outside DEV (see logger) — the devtools console still shows it.
  log.debug("concierge", `dispatching — ${describeAuthority(opts.authority)}`, {
    agentId,
    authority: opts.authority.kind,
  });
  if (text.trim() === "") return { ok: false, path: "empty", agentId };
  // A CLOUD agent has no local PTY — every write primitive here targets one, so refusing up
  // front with its own path beats the lie "its terminal has closed" (roborev 46916). Wiring a
  // cloud input path is tracked separately; until then the box is honest about the limit.
  if (isCloudAgent(agentId)) return { ok: false, path: "cloud-agent", agentId };
  const options = liveOptionsFor(agentId);

  if (options.length > 0) {
    // ══ THE DECLARED DISPOSITION IS CHECKED FIRST, BEFORE THE MATCH ═════════════════════════════
    // `neverPickerAnswer` says this text may never become a keystroke "however well it matches an
    // option on the agent's screen" — so whether it happens to match is irrelevant to it, and
    // asking the matcher first made the refusal a caller gets depend on the matcher's opinion of a
    // message that caller had already declared was not an answer.
    //
    // That ordering had a live consequence, not merely a tidiness one (roborev 55309). The
    // concierge prefixes staged attachments' quoted temp paths onto the wire, and every arm of
    // `matchAnswerToOption` is anchored — so an attachment-carrying send at a live picker never
    // matched, fell into `ambiguous-picker` below, and was told "I can't map that to a choice —
    // answer with just the option". Both halves are wrong for it: nothing was ambiguous, and the
    // user did not send an option at all, they sent a screenshot. The line they need is the
    // `addressed-at-picker` one — "it's waiting on a choice, so I didn't send that to it as a
    // message; open it and pick" — which under the old order they could reach only by matching,
    // i.e. by removing the file, which the copy never told them.
    if (opts.neverPickerAnswer) {
      return { ok: false, path: "addressed-at-picker", agentId, options };
    }
    const match = matchAnswerToOption(text, options);
    if (!match) {
      // A picker is on screen but the answer doesn't map to an option — do NOT guess a keystroke.
      return { ok: false, path: "ambiguous-picker", agentId, options };
    }
    // A USER-authored prompt that merely STARTS with a yes/no word is an instruction, not a picker
    // answer: collapsing "yes, but rename the flag first" onto `y\r` throws the rest of the
    // sentence away and answers the picker with something the user didn't mean. Only a terse
    // answer (a bare number, an exact option label, or a whole-phrase yes/no) may take the
    // keystroke path; anything else is refused WITH the options so the user can pick deliberately.
    // Machine callers (the nudge Approve relay) send a bare "approve", so they are unaffected.
    //
    // These two conditions — a live-option match plus terseness — are what `answersLivePicker`
    // above mirrors. Change the gate here and change it there.
    //
    // (`addressed-at-picker` gets its OWN path rather than reusing this one — roborev 54665. That
    // copy claims the answer mapped to nothing and offers "answer with just the option", and for a
    // DECLARED non-answer both are false: the text may have mapped perfectly, and answering with
    // just the option is either what the user already did or not what they were trying to do at
    // all. Sharing the line sent them round a loop with no stated exit.)
    if (opts.userPrompt && !isTerseAnswer(text, options)) {
      return { ok: false, path: "ambiguous-picker", agentId, options };
    }
    const sent = frameSubmit(match.value);
    try {
      // CHAINED because `sent` carries its own carriage return: an unchained write landing inside
      // another operation's paste→CR window would append this digit to THAT prompt and submit it
      // (roborev 54375). STRICT because the `catch` below reports pty-gone to the user and records
      // no turn — with the tolerant variant that branch is unreachable and this path claims a
      // delivery that never happened (roborev 54387). See pty.writePtyChainedStrict.
      await writePtyChainedStrict(agentId, sent);
      // Only a USER's answer is a turn: a machine-authored relay ("approve") must not write a
      // history entry, because that entry counts toward the naming ladder's promptCount and would
      // consume the first-turn deferral a self-reporting agent relies on.
      if (opts.userPrompt) recordPickerAnswer(agentId, match.label);
      // `display` is the LABEL, not the keystroke frame: `sent` here is "2\r" / "y\r", which is
      // the one thing no user-facing surface should ever quote back (roborev 49293/49294 —
      // `display` is documented as present whenever `sent` is, and this was the return that broke
      // that promise).
      return {
        ok: true,
        path: "picker-option",
        agentId,
        sent,
        display: match.label,
        matchedLabel: match.label,
      };
    } catch (err) {
      if (err instanceof PtyGoneError) return { ok: false, path: "pty-gone", agentId };
      throw err;
    }
  }

  // No live prompt → the answer is a new PROMPT. Refuse BEFORE delivery when the server says the
  // free trial is spent (the composer's pre-send gate, re-homed) so a spent trial can't keep
  // driving agents on the strength of the AuthGate overlay alone. Scoped to USER prompts, the same
  // scope as the debit: gating a relay we deliberately never charge would be a paywall on a
  // keystroke, and the AuthGate overlay already covers a trial-blocked user's whole app.
  if (opts.userPrompt && !trialSendAllowed()) return { ok: false, path: "trial-spent", agentId };

  // Queue ONLY when the pane said its PTY was still coming up AT SEND TIME (services/
  // paneReadiness). Read BEFORE the await: `submitPrompt` is asynchronous, so by the time a
  // rejection lands the pane may already have flipped to ready — and judging on the post-await
  // state would misread "wasn't up yet" as "the process died". An agent whose process exited is
  // `ready`, and nothing restarts it on its own, so holding a prompt for it would promise a
  // delivery that never happens.
  const wasStarting = paneState(agentId) === "starting";

  // Free text (strict: rejects a dead PTY).
  const display = opts.display ?? text;
  try {
    await submitPrompt(agentId, text);
    if (opts.userPrompt) recordPromptSideEffects(agentId, text, opts);
    return { ok: true, path: "free-text", agentId, sent: text, display };
  } catch (err) {
    if (err instanceof PtyGoneError) {
      // RE-READ the pane state after the await (roborev 47018): prepare() can fail while the
      // send is in flight — `wasStarting` alone would queue onto a pane that just published
      // `failed`, whose flush will never run. A pane that gave up gets its own truthful path
      // (the remedy is Retry / installing Claude, not "start it again").
      const nowState = paneState(agentId);
      if (nowState === "failed") return { ok: false, path: "agent-failed", agentId };
      if (wasStarting && (nowState === "starting" || nowState === "ready")) {
        if (
          queuePendingSend(
          {
            agentId,
            text,
            userPrompt: opts.userPrompt === true,
            // Carry the other two renderings across the wait: the flush below re-runs the side
            // effects, and a queued attachment send must not degrade to the raw payload just
            // because it was held for a few seconds (roborev 46911/46925).
            display: opts.display,
            namingBasis: opts.namingBasis,
          },
          // Anything the queue's staleness prune drops was promised to the user and would
          // otherwise disappear without a word — report it exactly as a flush-time expiry does
          // (roborev 53015).
          (dropped) => {
            for (const e of dropped) {
              emitOutcome({
                ok: false,
                path: "expired",
                agentId,
                sent: e.text,
                display: e.display ?? e.text,
              });
            }
          },
          )
        ) {
          // If the pane became ready while we were in flight, its own flush effect has already run
          // against an empty queue — drain here or this entry would sit until the TTL swept it.
          if (paneState(agentId) === "ready") void flushPendingSends(agentId);
          return { ok: true, path: "queued", agentId, sent: text, display };
        }
        // A FULL queue is its own refusal, not a dead PTY: the agent is starting normally, there
        // are simply already MAX_PER_AGENT prompts waiting on it. Falling through to `pty-gone`
        // would tell the user to restart a terminal that is coming up fine (roborev 46280).
        return { ok: false, path: "queue-full", agentId };
      }
      return { ok: false, path: "pty-gone", agentId };
    }
    throw err;
  }
}

/** Listeners for outcomes the USER didn't directly await — i.e. everything that happens to a
 *  QUEUED prompt after the concierge already said "I'll send that when it's ready". The concierge
 *  subscribes and reconciles its promise in the thread. */
type OutcomeListener = (r: ConciergeDispatchResult) => void;
const outcomeListeners = new Set<OutcomeListener>();

/** Subscribe to deferred send outcomes (queued prompts delivered, dropped, or re-failed).
 *  Returns an unsubscribe fn. */
export function onDeferredSendOutcome(cb: OutcomeListener): () => void {
  outcomeListeners.add(cb);
  return () => outcomeListeners.delete(cb);
}

function emitOutcome(r: ConciergeDispatchResult): void {
  for (const cb of outcomeListeners) {
    try {
      cb(r);
    } catch {
      // A listener's failure must never break a delivery that already landed.
    }
  }
}

/**
 * Deliver everything queued for `agentId` (see services/pendingSends). Called by the agent's pane
 * once its PTY reports ready. Resolves to the results, oldest first. Every outcome is ALSO
 * broadcast (onDeferredSendOutcome) so the concierge can reconcile the promise it made when the
 * prompt was queued — including entries that aged out and were never delivered.
 */
// NO authority re-check here, and that is correct rather than an oversight: a queued entry only
// exists because a dispatch already PASSED the gate above and then found the PTY still coming up.
// The flush is the second half of that one authorized send, not a new one. Re-deriving an authority
// at flush time would mean inventing one — exactly the "dispatch because the code decided to" the
// gate exists to eliminate.
export async function flushPendingSends(agentId: string): Promise<ConciergeDispatchResult[]> {
  const { due, expired } = takePendingSends(agentId);
  const out: ConciergeDispatchResult[] = [];
  for (const entry of expired) {
    const r: ConciergeDispatchResult = {
      ok: false,
      path: "expired",
      agentId,
      sent: entry.text,
      display: entry.display ?? entry.text,
    };
    out.push(r);
    emitOutcome(r);
  }
  for (const entry of due) {
    const display = entry.display ?? entry.text;
    let r: ConciergeDispatchResult;
    try {
      await submitPrompt(agentId, entry.text);
      if (entry.userPrompt) recordPromptSideEffects(agentId, entry.text, entry);
      r = { ok: true, path: "free-text", agentId, sent: entry.text, display };
    } catch (err) {
      if (!(err instanceof PtyGoneError)) throw err;
      r = { ok: false, path: "pty-gone", agentId, sent: entry.text, display };
    }
    out.push(r);
    emitOutcome(r);
  }
  return out;
}

/**
 * Void everything held for `agentId` WITH a reported outcome — called when the pane unmounts for
 * good or its spawn errors, i.e. the PTY this queue was waiting on will never come up. A held
 * prompt was promised ("I'll send that the moment it's ready"); discarding it silently would
 * leave that promise dangling forever (roborev 46311). No-op when nothing is held.
 */
export function abandonPendingSends(agentId: string): void {
  const { due, expired } = takePendingSends(agentId);
  for (const entry of [...expired, ...due]) {
    emitOutcome({
      ok: false,
      path: "abandoned",
      agentId,
      sent: entry.text,
      display: entry.display ?? entry.text,
    });
  }
}

/**
 * Is `text` an answer a picker can take verbatim, rather than an instruction that merely opens
 * with a yes/no word? True for a bare option number, an exact option label, or a whole-phrase
 * member of the yes/no families (with optional trailing punctuation) — NOT any single bare word,
 * which is what this used to accept (roborev 46311/46485-L). PURE — the safety-critical half of
 * the user-prompt guard.
 */
export function isTerseAnswer(text: string, options: SuggestionButton[]): boolean {
  const t = text.trim().replace(/[.!?]+$/, "").trim();
  if (t === "") return false;
  if (/^\d{1,2}[.)]?$/.test(t)) return true;
  if (options.some((o) => o.label.trim().toLowerCase() === t.toLowerCase())) return true;
  // Whole-phrase yes/no family membership, not a whitespace count (roborev 46311): "go ahead"
  // and "yes please" are terse answers; a hyphenated token that merely starts with a yes-word
  // ("yes-but-the-other-one") is not.
  return YES_WORDS.test(t) || NO_WORDS.test(t);
}

/** A picker ANSWER, once its keystroke has landed. It is not a prompt — no marker, no trial debit,
 *  no auto-naming — but it IS recorded with source "picker" exactly as the composer recorded it,
 *  because components/promptHistory.ts's contract is "hidden from display surfaces, still counted
 *  by the naming ladder". Best-effort: an agent whose project can't be resolved records nothing. */
function recordPickerAnswer(agentId: string, label: string): void {
  const project = useProjectStore
    .getState()
    .projects.find((p) => p.agents.some((a) => a.id === agentId));
  if (!project) return;
  useProjectStore.getState().appendPrompt(project.id, agentId, label, "picker");
}

/** Everything that used to hang off the composer's onSubmitPrompt, run once a USER prompt is
 *  DELIVERED (see the side-effects note in the file header). Best-effort by construction: an agent
 *  whose project can't be resolved simply gets no history entry, and an unmounted terminal no
 *  marker — neither is a reason to fail a send that already landed. */
function recordPromptSideEffects(
  agentId: string,
  text: string,
  renderings: Pick<ConciergeDispatchOptions, "display" | "namingBasis"> = {},
): void {
  // Debit one free-trial prompt on the server. Self-gates: a no-op for entitled users, and it
  // never throws (see trialMeter).
  void recordTrialSend();
  // Each surface gets the rendering meant for it (see ConciergeDispatchOptions). Both fall back to
  // the wire text, which is exactly right when nothing was attached.
  const shown = (renderings.display ?? text).trim();
  const basis = (renderings.namingBasis ?? text).trim();
  // The composer's fifth side-effect: teach the ghost-text suggestions from what the user actually
  // TYPED — never an attachment path, which would poison the corpus with unrepeatable temp names.
  // Global (not per-agent), and it self-ignores empties/over-long prompts.
  usePromptHistoryStore.getState().record(basis);
  const project = useProjectStore
    .getState()
    .projects.find((p) => p.agents.some((a) => a.id === agentId));
  if (!project) return;
  // Record the TRIMMED display text: leading/trailing whitespace would otherwise land in the
  // pinned header while naming (below) used the trimmed form — two readings of the same prompt.
  const promptId = useProjectStore.getState().appendPrompt(project.id, agentId, shown);
  markAgentPrompt(agentId, promptId);
  // Fire-and-forget: no-ops if the name is pinned or no API key is configured. Gated on the
  // auto-rename AI feature, and skipped for an empty basis so the naming model is never asked to
  // summarize nothing — which is precisely the attachments-only send.
  if (basis && aiFeatureNow("autoRename")) void maybeAutoName(project.id, agentId, basis);
}

