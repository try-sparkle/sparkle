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
//
// CLOUD AGENTS (design 2026-08-01 §Decision 7, bead sparkle-1g0r). This module used to refuse every
// cloud agent outright — honestly, because every write primitive above targets a LOCAL PTY and there
// was no cloud input path to reach. There is one now, and it has been there all along, simply
// unreachable from here: `CloudTransport.write` → `agent_input` → the relay's `writeInput` → the
// sandbox PTY's stdin. So a PROMPT to a cloud agent is delivered through `getTransport({id, runtime})`
// — the same selector the terminal uses — and only the framing differs (see `frameCloudSubmit`).
//
// WHAT DOES NOT FOLLOW, and must not be quietly assumed: an APPROVAL. An approval is not a
// keystroke — it is an answer to a specific prompt whose UI state lives with the agent, and sending
// it blind down `agent_input` is the "remedy that does the unsafe thing" failure AGENTS.md names.
// Two shapes are therefore still refused for a cloud agent, both with the `cloud-agent` path:
//   • an approval GESTURE (the nudge card's Approve — see `ANSWERS_AGENTS_PROMPT`), and
//   • any send made while a PICKER is live on the agent's screen, because that is the send this
//     module would otherwise collapse into a bare `y\r` keystroke.
// A cloud agent's picker is answered in its own pane, where the person can read the question.

// The paste markers and their filter come from the LEAF `../pasteMarkers`, not from `../pty` which
// merely re-exports them. `pty` is stubbed wholesale by ~44 suites, and a wholesale vi.mock factory
// replaces the module's entire export surface — so reaching `stripPasteMarkers` THROUGH `pty` makes
// it `undefined` inside every one of those suites, silently dropping the guard while the tests stay
// green. Two of this module's own suites already work around that by rebuilding the three names from
// `importOriginal`; the leaf import removes the need. Enforced by
// `sparkle-security/no-reexported-security-helper`.
import { PASTE_END, PASTE_START, stripPasteMarkers } from "../pasteMarkers";
import { PtyGoneError, submitPrompt, writePtyChainedStrict } from "../pty";
import {
  describeAuthority,
  isDispatchAuthority,
  isHumanAuthored,
  type DispatchAuthority,
  type DispatchAuthorityKind,
} from "./dispatchAuthority";
import { getTransport } from "./agentTransport";
import { getRelaySocket } from "./relayClient";
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
import { getAgentViewport } from "./terminalViewport";
import { isClaudeCodeScreen } from "../engine/claudeCodeScreen";
// The blocked-prompt grace window's outcome channel. A VALUE import, and it does not close a cycle:
// that module imports `ConciergeDispatchPath` from here `import type`, which erases at compile time.
import { answerOutcomeForPath, notePromptAnswerOutcome } from "../engine/blockedPromptGrace";
import { pickerFingerprint } from "./pickerFingerprint";
import {
  screenBlocksWrite,
  screenIsCredentialField,
  screenIsYesNoPrompt,
} from "../voice/dictationTerminalRoute";
import { useInteractionStore } from "../stores/interactionStore";
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
  | "cloud-agent" // the target runs in the cloud and this send is an ANSWER to its on-screen prompt
                  // (an approval gesture, or any send made while a picker is live) — that has to be
                  // answered in its own pane, where the question is readable (NOT delivered).
                  // A cloud PROMPT is delivered; see the cloud note in this file's header.
  | "cloud-offline" // the target runs in the cloud and the relay socket isn't connected, so there is
                    // nothing to emit `agent_input` on (NOT delivered). Its own path rather than a
                    // silent ok: `CloudTransport.write` no-ops on a null socket, and reporting that
                    // as a delivery is the one lie this module exists to prevent.
  | "alternate-screen" // a full-screen app (vim/less/htop) owns the screen, which would EXECUTE the
                       // write as commands (refused — see the guard in dispatchConciergeAnswer)
  | "blocked-prompt" // the screen is sitting at something that must not receive free text — a
                     // credential field, an ssh host-key confirmation, a `(yes/no)` — and this write
                     // would be pasted AND SUBMITTED into it (refused). Distinct from
                     // `alternate-screen` because the remedy is different: answer what is on screen,
                     // rather than quit the full-screen app.
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
  /**
   * THIS WRITE IS A PICKER PRESS, and here is the menu it is answering (bead sparkle-jk8zt).
   *
   * A FINGERPRINT, NEVER A BOOLEAN, and that is the whole design. The dispatcher does not take this
   * as a claim — it re-derives the fingerprint from the CURRENT screen and compares. A caller that
   * cannot name the live menu gets nothing; a caller that can has proved the menu is really there,
   * because `pickerFingerprint` hashes the question along with the option shape.
   *
   * WHAT IT BUYS: exemption from the alternate-screen refusal, and nothing else. Claude Code's
   * permission dialog replaces the composer box that `isClaudeCodeScreen` requires, so that
   * predicate reads a live approval prompt as a full-screen app — see the guard for the full
   * account. Every other guard on this path still runs on a picker press, the credential checks
   * included.
   *
   * SET BY EXACTLY ONE CALLER: `conciergeTools/terminal`'s `selectPickerOption`, after its own
   * fingerprint check. It is deliberately NOT reachable from `send_to_agent_terminal`'s tool
   * schema, so free text cannot acquire the exemption by asking for it.
   */
  pickerPress?: { fingerprint: string };
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
 * Does this authority kind mean the send is an ANSWER to a prompt on the agent's own screen, rather
 * than a message TO the agent?
 *
 * The distinction only matters for cloud agents (see the header): a message is deliverable over
 * `agent_input`, an answer is not, because the UI state it answers lives with the agent and this
 * side cannot press its button on the user's behalf.
 *
 * A TOTAL `Record`, not a `Set` or a `switch` — the same shape and the same reason as
 * `dispatchAuthority`'s `HUMAN_AUTHORED`: adding an arm to `DispatchAuthority` is a compile error
 * here until someone decides which side of the line it sits on, and "message" is the permissive
 * answer, so default-by-omission is exactly the wrong default.
 */
const ANSWERS_AGENTS_PROMPT: Record<DispatchAuthorityKind, boolean> = {
  // The nudge card's Approve exists to answer a permission prompt the agent has on screen. It is
  // THE approval gesture, and the one this narrowing is about.
  "nudge-approve": true,
  // Everything else is a message the user (or the concierge) composed FOR the agent.
  mention: false,
  // Approving a block of text the concierge PROPOSED is approving a message, not answering the
  // agent's question — the thing being approved is what we are about to send, not what it asked.
  approval: false,
  countdown: false,
  // A MOUNTED send is prose the user composed for the agent, exactly like an addressed one — the
  // cable changes how fast it goes, never what it is. It also agrees with the `userPrompt: true`
  // that same path already hands the dispatcher, which is what stops a terse mounted line being
  // matched against a live picker and pressing a button (roborev 54569).
  mount: false,
  redirect: false,
  // A TERMINAL-kind suggestion pill writes its keystroke straight to the PTY and never reaches this
  // module (see `applySuggestion`); anything that does reach here is prose.
  suggestion: false,
  "concierge-tool": false,
  "goal-continue": false,
};

/** Is this dispatch an approval GESTURE — the nudge card's Approve? See `ANSWERS_AGENTS_PROMPT`. */
function isApprovalGesture(opts: ConciergeDispatchOptions): boolean {
  return ANSWERS_AGENTS_PROMPT[opts.authority.kind] === true;
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
 *
 * ══ THIS IS THE LOCAL-PTY QUESTION, AND IT STAYS FALSE FOR CLOUD ════════════════════════════════
 * A cloud agent can now take a PROMPT (see the header), so "can it receive a message" is no longer
 * what this predicate answers. It is left alone on purpose: its callers outside the compose box —
 * `sendControlKey`, dictation, the API-recovery ping — all write RAW BYTES to a local PTY, and a
 * cloud agent has none. Flipping it would send those writes into `writePtyChainedStrict` for a PTY
 * that does not exist. Use {@link agentCanAcceptPrompt} for the "can I send it a message" question.
 */
export function agentCanAcceptInput(agentId: string): boolean {
  const agent = findAgent(agentId);
  return !!agent && agent.runtime !== "cloud";
}

/**
 * Can this agent be sent a PROMPT — a message, as opposed to a keystroke?
 *
 * True for a cloud agent, which is the whole difference from {@link agentCanAcceptInput}: the
 * dispatcher delivers a cloud prompt over the transport (header), so a surface that gates a compose
 * send on "can it take a message" must ask THIS or it will refuse a send that would have worked.
 *
 * Fails closed on an unknown id for the same reason `agentCanAcceptInput` does — a surface asking
 * this is about to aim an irreversible write, and "the store has never heard of it" is precisely
 * when delivery is least likely to work.
 */
export function agentCanAcceptPrompt(agentId: string): boolean {
  return findAgent(agentId) !== undefined;
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
 * Tell the blocked-prompt grace window what just became of an answer attempt, and hand the result
 * straight back.
 *
 * ONE FUNNEL, NOT N SPRINKLED CALLS, and that is the whole reason it exists rather than a
 * `notePromptAnswerOutcome` beside each `return`. This function has sixteen return arms and grows a
 * new one every few roborev rounds; a per-arm call means the next arm added is silently unreported,
 * and an unreported REFUSAL is the exact failure the grace window was built to remove — the founder's
 * prompt stays hidden for the full ceiling because nothing said the answerer had given up on it.
 * Routing every arm through here makes "did you report it?" a property of the wrapper, not of the
 * author's memory.
 *
 * The classification is NOT re-derived here: `answerOutcomeForPath` is exhaustive over
 * `ConciergeDispatchPath` with a `never` guard, so a new path is a compile error there until someone
 * decides which of handled/declined/unreachable it is. Deciding it twice would let the two copies
 * disagree, and the safe-looking arm (`handled`) is the one that hides a prompt.
 */
function reportAnswerOutcome(result: ConciergeDispatchResult): ConciergeDispatchResult {
  notePromptAnswerOutcome(result.agentId, answerOutcomeForPath(result.path));
  return result;
}

/**
 * Route a user's concierge answer to `agentId`'s terminal. Re-reads the CURRENT screen so we only
 * answer a still-present prompt. Returns a structured result; the concierge surfaces it (e.g. "sent",
 * "which option?", or "that agent's terminal has closed"). Never throws for the expected outcomes.
 *
 * The body is `routeConciergeAnswer` below; this wrapper exists ONLY to put every one of its returns
 * through {@link reportAnswerOutcome}. See that function for why the reporting is not written at the
 * individual arms. A thrown (unexpected) error reports nothing on purpose: nothing was decided about
 * the prompt, so the grace window's ceiling is the honest backstop.
 */
export async function dispatchConciergeAnswer(
  agentId: string,
  text: string,
  /** No default, deliberately — `authority` must be declared. See ConciergeDispatchOptions. */
  opts: ConciergeDispatchOptions,
): Promise<ConciergeDispatchResult> {
  return reportAnswerOutcome(await routeConciergeAnswer(agentId, text, opts));
}

async function routeConciergeAnswer(
  agentId: string,
  text: string,
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
  // ══ THE SCREEN GUARD LIVES HERE, NOT IN EACH CALLER ═════════════════════════════════════════════
  // Every door into a local PTY in this app comes through this function — the concierge composer's
  // two gestures, the concierge's own `send_to_agent_terminal` tool, the nudge Approve relay, and
  // the goal-continuation auto-resume. Until now the only screen fact it read was "is a picker
  // live", so a write into an agent sitting in `vim`/`less`/`htop` was pasted AND submitted, where
  // the alternate-screen app reads it as COMMANDS rather than as input. That guard did get built —
  // twice — but each time in a CALLER (dictation, then the composer), which is why the third and
  // fourth callers never inherited it. Putting it at the chokepoint means the next caller does.
  //
  // ONLY the alternate-buffer refusal is taken here, deliberately — not the whole of
  // `terminalWriteRefusal`:
  //   • `no-viewport` (the terminal isn't mounted in this window) is a LEGITIMATE state for several
  //     callers — an `@Name` address at an agent whose pane is elsewhere, an auto-resume with no
  //     window open at all — so refusing it here would break shipped paths to guard a screen nobody
  //     is looking at. The callers that must refuse it already weigh it themselves (ConciergeHost
  //     refuses a MOUNT on it; dictation treats it as fatal).
  //   • `awaiting-input` is the picker case, which this function does not refuse but ANSWERS, a few
  //     lines down, when the text maps to an option. Hoisting it would break that.
  // Alternate-screen is the one refusal that is unconditionally right for every caller: no write of
  // any kind belongs on that screen, whoever authored it.
  // ══ …UNLESS THE ALTERNATE BUFFER IS JUST CLAUDE CODE (bead sparkle-v7k3y, roborev 57704) ═══════
  // Claude Code holds this buffer for its ordinary busy state, and Claude Code is what every agent
  // in this app runs — so an unconditional refusal here fires on the most common state in the app.
  // The founder, mounted to an agent reading "Running 1 shell command · 1m 24s", was bounced.
  //
  // THIS LINE IS THE ONE THAT ACTUALLY DECIDES IT. Relaxing only `terminalWriteRefusal` (the
  // caller-side pre-check) moved the refusal here without changing what the founder sees: the send
  // falls through the loosened pre-check and is refused at the chokepoint, and ConciergeHost posts
  // the SAME "full-screen app" sentence from `refusalCopy`. Both have to agree, which is why they
  // now share one predicate rather than two hand-kept-in-step conditions.
  //
  // `isClaudeCodeScreen` requires the live-TUI composer box PLUS a corroborating family precisely
  // because of where we are: everything below this line pastes AND SUBMITS via `submitPrompt`, so a
  // false positive on a `vim` session is an ENTERED line, not merely a typed one.
  const screen = getAgentViewport(agentId);
  // ══ READ ONCE, AND REUSED BY THE PICKER BLOCK BELOW ═══════════════════════════════════════════
  // Hoisted because the credential arm now has to know whether a menu is up. It must be ONE read,
  // not two: `liveOptionsFor` re-runs the detector over the CURRENT scrollback, so a second call
  // could straddle a redraw and let the two decisions disagree about whether a picker is live —
  // and the guard would then refuse a screen the block below was about to answer.
  //
  // (A first cut left the block's own call in place. That broke four rows in
  // `conciergeDispatch.renderings.test.ts`, which queue their options with `mockReturnValueOnce`:
  // the extra call consumed the queued value and the picker block saw an empty list, turning a
  // `picker-option` into `free-text`. The suite was right and the comment claiming re-reading was
  // harmless was wrong.)
  const pickerOptions = liveOptionsFor(agentId);
  const claudeCodeHoldsTheBuffer = !!screen?.alternateBuffer && isClaudeCodeScreen(screen.text);
  // ══ A FINGERPRINTED PICKER PRESS IS ITS OWN EVIDENCE (bead sparkle-jk8zt) ══════════════════════
  // THE BUG THIS FIXES: the concierge could not answer ANY approval prompt. Four agents in one day,
  // four for four, every `select_picker_option` refused `alternate-screen` — while
  // `read_picker_options` SUCCEEDED on the same agent in the same instant, returning clean numbered
  // options and a stable fingerprint. Two detectors disagreeing about one terminal at one moment.
  //
  // THE WRONG ONE WAS THE WRITE PATH, and the mechanism is exact: `isClaudeCodeScreen` REQUIRES the
  // composer box (its family D, mandatory — see that module's header), and Claude Code's permission
  // dialog REPLACES the composer box. So on a permission prompt exactly one family survives (the
  // tool-call glyphs) and the predicate returns false. `claudeCodeScreen.test.ts` pins this
  // (`claudeCodeMarkerFamilies(APPROVAL_2_1_220) === 1`) and calls it the safe answer — which it is,
  // for FREE TEXT. It made the carve-out structurally incapable of firing during a picker, i.e.
  // precisely when answering one is the point.
  //
  // THE GUARD IS NOT DELETED AND ITS PREMISE IS NOT WEAKENED. Typed text in a real pager runs as
  // commands, and that cannot be walked back. What changes is that ONE write earns an exception: an
  // option press whose fingerprint the DISPATCHER ITSELF just re-derived from the CURRENT screen.
  //
  // WHY THAT IS EVIDENCE RATHER THAN A CALLER'S WORD. `pickerPress` carries a fingerprint, never a
  // boolean, and the match below is recomputed here — not trusted. `pickerFingerprint` hashes the
  // QUESTION together with the option shape, so a match means this function has just read the same
  // live menu the caller read. `vim`, `less` and `htop` have no menu for `liveOptionsFor` to find,
  // so they produce no options, no fingerprint, and take the refusal exactly as before.
  //
  // FREE TEXT STAYS REFUSED IN THIS STATE, which is the other half of the contract. `pickerPress` is
  // reachable only from `selectPickerOption`; the model-facing `send_to_agent_terminal` passes just
  // `userPrompt`, so no tool call can set it and no prose can ride this exception onto that screen.
  const verifiedPickerPress =
    opts.pickerPress !== undefined &&
    opts.pickerPress.fingerprint !== "" &&
    pickerOptions.length > 0 &&
    pickerFingerprint(agentId, pickerOptions) === opts.pickerPress.fingerprint;
  if (screen?.alternateBuffer && !claudeCodeHoldsTheBuffer && !verifiedPickerPress) {
    log.warn("concierge", "refused a write into a full-screen app", { agentId });
    return { ok: false, path: "alternate-screen", agentId };
  }
  // ══ RECOGNISING CLAUDE CODE IS NOT A SAFETY VERDICT (roborev 57718) ═════════════════════════════
  // `claudeCodeScreen`'s own doc says so — "do not let a true from this function stand in for
  // [screenBlocksWrite]" — and the first cut of the line above did exactly that. The two guards had
  // always travelled together in `terminalWriteRefusal`; skipping the alternate-screen arm here took
  // only the first half, and the OTHER two callers of this function (`conciergeTools/terminal`, the
  // goal auto-resume) have no screen guard of their own — they were relying entirely on the
  // unconditional refusal that was just removed.
  //
  // THE CONCRETE HOLE: a Claude Code pane running a Bash tool that stopped at `[sudo] password for
  // …:` or `Username for 'https://github.com':` still draws its composer box and its busy status
  // bar, so it is recognised. `liveOptionsFor` is a PICKER detector and does not match a credential
  // prompt, so the send fell through to `submitPrompt` and pasted AND SUBMITTED prose into a field
  // that echoes nothing. That write was refused before this change. The four field misses
  // `WRITE_BLOCKING_PROMPTS`/`CREDENTIAL_WORD` were grown from are exactly this class.
  //
  // Scoped to the case we relaxed, deliberately: only when Claude Code is why the buffer check was
  // skipped. A normal-buffer screen keeps whatever behaviour it had, so this restores what was taken
  // away without quietly widening the chokepoint's remit.
  // ══ …AND A CREDENTIAL PROMPT BLOCKS ON ANY BUFFER (bead sparkle-p9hs5) ═════════════════════════
  // The arm below only fires when Claude Code is why the alternate-screen refusal was skipped, which
  // left a NORMAL-buffer screen reaching `submitPrompt` with no screen check at all. `ConciergeHost`
  // has its own pre-check, but the other two callers of this function — the model-issued
  // `send_to_agent_terminal` and the goal auto-resume — do not, so for them this is the only guard
  // there is.
  //
  // CONCRETE: a pane whose Claude Code has exited, or whose shell is running `sudo -v` / `ssh` /
  // `gh auth login`, sits on the NORMAL buffer at `[sudo] password for …:`. `liveOptionsFor` is a
  // PICKER detector and matches nothing there, so the send fell through and was pasted AND SUBMITTED
  // into a field that echoes nothing.
  //
  // `screenIsCredentialPrompt`, NOT `screenBlocksWrite`, and the distinction is the whole reason
  // that predicate was split out. `screenBlocksWrite` is a SUPERSET of `screenAwaitsInput`, and this
  // sits ABOVE the picker block — so calling it here would refuse every live picker instead of
  // ANSWERING it, which this file's own header says must not be hoisted. The non-picker arms are
  // exactly the hazard that has no other home.
  // GATED ON THERE BEING NO LIVE PICKER (roborev 58512), which the first cut of this guard missed.
  // `screenIsCredentialPrompt` is not purely the non-picker half after all: `WRITE_BLOCKING_PROMPTS`
  // carries `/\(\s*yes\s*\/\s*no/i`, and a `(yes/no)` confirmation IS a live picker to this
  // dispatcher — `suggestions/heuristics`' own `YN` emits the Approve/Deny pair for exactly that
  // shape. So `Overwrite existing config? (yes/no)` was being refused here instead of answered with
  // `y\r`, for every caller including the nudge Approve relay. That is the same
  // refusing-above-the-picker-block hazard this arm's doc claims to avoid, narrowed to the yes/no
  // family rather than removed.
  //
  // A REAL credential prompt yields NO options — `[sudo] password for …:` is not a menu — so the
  // sudo/token/host-key cases this guard exists for still block, and the shipped `answersLivePicker`
  // mirror keeps agreeing with what the dispatcher will actually do. Those two are documented as
  // having to agree; the first cut made them disagree.
  // GATED ON WHICH ARM MATCHED, NOT ON "are there any options" (roborev 58529). The first cut waived
  // the whole predicate whenever the detector found anything, and the two sides read DIFFERENT
  // SOURCES: `pickerOptions` parses the SCROLLBACK (50 lines for the Claude picker, 12 for a generic
  // menu) while the credential check reads the VIEWPORT. So a menu merely still in scrollback — not
  // what the screen is waiting on — switched the guard off.
  //
  // That reported SUCCESS while doing the harm: `CHOICE_KEYWORD` contains `enter`, so
  // `Enter your vault password:` under a still-visible `1) … 2) …` run parses as a menu, and a terse
  // "1" was submitted as `1\r` INTO THE CONCEALED FIELD with `ok: true, path: "picker-option"`.
  //
  // `screenIsCredentialField` excludes only the `(yes/no)` arm — the single shape genuinely
  // ambiguous between "must not receive free text" and "a picker to answer". A password line, the
  // credential tail, `type "yes" to confirm`, and ssh's host-key prompt all block regardless of what
  // the scrollback still holds. ssh matters specifically: it carries `(yes/no)` but wants the whole
  // word `yes` while the detector's Approve sends `y`, so answering it would report a delivery ssh
  // rejected.
  // AND THE `(yes/no)` ARM IS WAIVED ONLY BY A *LIVE* PICKER (roborev 58540), which the previous cut
  // dropped entirely. `screenIsCredentialField` excludes that arm unconditionally, so a confirmation
  // with NO detected options stopped blocking — and the detector's YN only fires when `yes/no` sits
  // in the last two non-empty scrollback lines, with the generic-menu branch short-circuiting it.
  //
  //     Overwrite existing config? (yes/no)
  //     Waiting for response…
  //     Press Ctrl-C to abort.
  //
  // YN misses (the prompt is three lines up), `pickerOptions` is empty, nothing blocks, and the send
  // pastes AND SUBMITS prose into a live confirmation. The goal auto-resume hits it every 15s.
  //
  // So: refuse a credential FIELD always, and refuse a yes/no prompt too whenever there is no picker
  // to answer it with. That is the shape roborev 58529 asked for, and this restores the half of it
  // the last commit lost.
  // ══ THE WAIVER READS THE SAME TEXT THE GUARD DOES (roborev 58562) ═════════════════════════════
  // FIFTH ROUND ON THIS GUARD, and every previous one was the same shape: a waiver computed from the
  // SCROLLBACK deciding whether to skip a check computed from the VIEWPORT. `liveOptionsFor` parses
  // 50 lines (Claude picker) or 12 (generic menu) of scrollback; `screenIsYesNoPrompt` reads the
  // viewport. So a menu merely still in scrollback kept waiving a live prompt three lines up — and
  // `detectTerminalPrompts` short-circuits on the menu branches BEFORE it evaluates YN, so it did
  // not even have to be a yes/no menu.
  //
  // Rather than patch that instance again, the waiver now runs the detector over `screen.text`
  // ITSELF. One source, one region, so the two halves cannot disagree about what is on screen —
  // which is the class, not the case.
  //
  // AND IT MUST BE THE YES/NO PAIR, not merely "some options": the exclusion exists only because a
  // yes/no confirmation is answerable, so any OTHER picker shape leaves the prompt refused.
  //
  // The picker block below still reads `pickerOptions` from the scrollback — that is its shipped
  // behaviour and not this guard's to change.
  const viewportOptions = screen ? detectTerminalPrompts(screen.text) : [];
  const viewportOffersYesNo =
    viewportOptions.length === 2 && viewportOptions.every((o) => /^[yn]\n?$/.test(o.value));
  if (
    screen &&
    (screenIsCredentialField(screen.text) ||
      (!viewportOffersYesNo && screenIsYesNoPrompt(screen.text)))
  ) {
    log.warn("concierge", "refused a write into a credential prompt", { agentId });
    return { ok: false, path: "blocked-prompt", agentId };
  }
  if (claudeCodeHoldsTheBuffer && screenBlocksWrite(screen.text)) {
    log.warn("concierge", "refused a write into a blocked prompt on a Claude Code screen", {
      agentId,
    });
    return { ok: false, path: "blocked-prompt", agentId };
  }
  // ══ ANSWER FROM THE TEXT THE WAIVER READ (roborev 58575) ═══════════════════════════════════════
  // The previous round made the WAIVER read the viewport but left the ANSWER parsed from the
  // scrollback, so the same cross-source harm survived mirrored. `detectClaudeCodePicker` scans the
  // last 50 non-empty SCROLLBACK lines with no requirement that the footer be near the end, while
  // `screen.text` is only the visible rows. So a Claude Code picker scrolled just above the viewport,
  // with a shell's `Overwrite existing config? (yes/no)` now on the last visible line, gave:
  // viewport → the y/n pair → waiver fires; scrollback → the stale picker's `1\n`/`2\n`; and a terse
  // "2" pressed a DIGIT into the live confirmation, returning ok:true / picker-option.
  //
  // So when the waiver fired, the options come from the same text that justified it. Otherwise the
  // scrollback parse stands, which is this block's shipped behaviour for every other screen.
  const options = viewportOffersYesNo ? viewportOptions : pickerOptions;

  // ══ A CLOUD AGENT LEAVES THE LOCAL-PTY PATH HERE ════════════════════════════════════════════════
  // Read the screen FIRST (above) rather than short-circuiting on the runtime the way the old
  // blanket refusal did: whether a picker is live is exactly what decides between "this is a
  // message I can relay" and "this is an answer only its own pane can give". Everything below this
  // line — the picker collapse, the pending-send queue, `submitPrompt` — is local-PTY machinery a
  // cloud agent has no counterpart for.
  if (isCloudAgent(agentId)) return deliverCloudPrompt(agentId, text, opts, options);

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
      if (opts.userPrompt) recordPickerAnswer(agentId, match.label, isHumanAuthored(opts.authority));
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
    // `machine` reuses the SAME authorship question the goal-debt release below asks — "did a person
    // write this prose?" — because that is exactly the question a quota wall needs answered. An
    // auto-resume (`goal-continue`) and a concierge-composed relay (`concierge-tool`) are both
    // machine-authored, and neither is evidence that the human is present to be told anything.
    await submitPrompt(agentId, text, { machine: !isHumanAuthored(opts.authority) });
    // `userPrompt` says "record this as a prompt"; `isHumanAuthored` says "a person wrote it". They
    // are NOT the same question, and `send_to_agent_terminal` is where they part company: it passes
    // `userPrompt: true` for prose the concierge LLM composed. Only the second may release an agent's
    // goal debt (roborev 55588).
    if (opts.userPrompt)
      recordPromptSideEffects(agentId, text, opts, isHumanAuthored(opts.authority));
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
            // AUTHORSHIP RIDES ALONG TOO (roborev 55628). Same argument as the renderings below and
            // the same failure shape: the flush re-runs the side effects, so a decision this call
            // site has in hand and does not carry gets re-invented downstream — and the invented
            // answer here is `appendPrompt`'s `humanAuthored = true` default, which releases the
            // agent's goal debt. Deriving it at flush time is not an option: the flush has no
            // authority (see its own note on why re-deriving one there would be inventing it).
            humanAuthored: isHumanAuthored(opts.authority),
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

/**
 * The wire form of a cloud submit: one bracketed paste plus the carriage return that sends it.
 *
 * ONE STRING, NOT TWO WRITES, and that is the difference from the local `deliverSubmit` rather than
 * an omission. Locally the paste and the CR are two `pty_write` calls with a beat between them so
 * the CLI finishes ingesting the paste first. Over the relay each `write` is a separate
 * `agent_input` event whose SERVER handler is `async` and awaits an ownership lookup before it
 * touches stdin — so two emits can reach `sandbox.pty.sendInput` in either order, and a CR that
 * overtakes its paste submits an empty line and leaves the prompt sitting in the composer. A single
 * emit is one `writeInput` call and cannot be reordered against itself.
 *
 * Marker-stripped exactly as every other paste this app frames: the text here is user- and
 * model-authored, and an embedded `ESC[201~` would close paste mode mid-payload and have the tail
 * read as KEYSTROKES (pty.ts's note on roborev 2197/54397 — the sandbox runs the same CLI).
 */
export function frameCloudSubmit(text: string): string {
  return `${PASTE_START}${stripPasteMarkers(text)}${PASTE_END}\r`;
}

/**
 * Deliver a concierge send to a CLOUD agent, or refuse it with the specific reason.
 *
 * The three refusals, in the order they are asked:
 *   1. An ANSWER to the agent's own screen — an approval gesture, or any send made while a picker
 *      is live. See the header: this is the one thing that does not follow from the wire existing.
 *      Returns the live `options` when there are any, so the caller can say what it is waiting on.
 *   2. The free trial is spent — the same pre-delivery gate the local free-text path applies, for
 *      the same reason, and scoped the same way (USER prompts only).
 *   3. No relay socket — `CloudTransport.write` silently no-ops on a null socket, so without this
 *      a dropped prompt would come back `ok: true`.
 *
 * On delivery it runs the SAME `recordPromptSideEffects` a local free-text send runs. That is not
 * incidental: the pinned prompt header, the history dropdown, auto-naming, the ghost-text corpus and
 * the trial debit all key on it, and a cloud prompt that skipped them would leave every one of those
 * surfaces blind to an agent the user is actively driving.
 *
 * There is no QUEUE arm here and there should not be: a cloud session is already running
 * server-side before its tab exists, so "the terminal isn't up yet" — the state `pendingSends`
 * exists for — has no cloud counterpart.
 */
async function deliverCloudPrompt(
  agentId: string,
  text: string,
  opts: ConciergeDispatchOptions,
  options: SuggestionButton[],
): Promise<ConciergeDispatchResult> {
  if (isApprovalGesture(opts) || options.length > 0) {
    log.debug("concierge", "refused an answer aimed at a cloud agent's own screen", { agentId });
    return {
      ok: false,
      path: "cloud-agent",
      agentId,
      ...(options.length > 0 ? { options } : {}),
    };
  }
  if (opts.userPrompt && !trialSendAllowed()) return { ok: false, path: "trial-spent", agentId };
  // Asked BEFORE the write, not after: the transport has no failure channel to read afterwards.
  if (!getRelaySocket()) {
    log.warn("concierge", "cloud prompt not sent — no relay connection", { agentId });
    return { ok: false, path: "cloud-offline", agentId };
  }
  getTransport({ id: agentId, runtime: "cloud" }).write(frameCloudSubmit(text));
  const display = opts.display ?? text;
  if (opts.userPrompt) recordPromptSideEffects(agentId, text, opts, isHumanAuthored(opts.authority));
  // `free-text`, the same path a local prompt takes — the caller's question is "did my message go
  // to the agent", and the answer is yes by the same route it would have been for a local one.
  // `sent` is the TEXT, not the framed payload, exactly as the local free-text return does.
  return { ok: true, path: "free-text", agentId, sent: text, display };
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
  // ══ THE DEFERRED HALF OF THE GRACE WINDOW'S OUTCOME CHANNEL ═══════════════════════════════════
  // Every deferred outcome passes through here — a queued prompt finally delivered, one that aged
  // out (`expired`), one whose pane died while it waited (`pty-gone`), one abandoned by an unmount.
  // The three failures are exactly the case the direct path CANNOT report: the dispatch already
  // answered `queued` (→ `handled`, keep holding), and if the send then never lands, nothing else
  // would ever correct that and the founder's prompt would ride out the whole 30s ceiling.
  //
  // BEFORE the listeners, not after: a listener throwing is swallowed below by design, and the
  // grace window must not be hostage to that. It reports the LATEST outcome for the agent, so an
  // older entry's expiry followed by a fresh `queued` correctly ends on the in-flight send.
  reportAnswerOutcome(r);
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
      // `entry.humanAuthored` for the same reason the debt release below reads it rather than the
      // parameter default: the queued path must not re-derive an answer the entry already carries.
      await submitPrompt(agentId, entry.text, { machine: !entry.humanAuthored });
      // `entry.humanAuthored`, NOT the parameter default (roborev 55628). The gate that keeps
      // machine-composed prose from clearing a human's escalation latch went onto the direct path
      // and missed this one, which re-opened the hole for any concierge send that had to wait for a
      // starting PTY. The entry carries the answer precisely so this line does not have to guess.
      if (entry.userPrompt)
        recordPromptSideEffects(agentId, entry.text, entry, entry.humanAuthored);
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
 *  by the naming ladder". Best-effort: an agent whose project can't be resolved records nothing.
 *
 *  `humanAuthored` is threaded for the THIRD time in this file, and this was the path still open
 *  after the other two were closed (roborev 55691). It is not a theoretical hole: this branch is
 *  taken when a dispatch's text is terse and matches a live option, and `isTerseAnswer` accepts a
 *  bare number, an exact label, or a whole-phrase yes/no — precisely the shape
 *  `sendToAgentTerminal` produces when the concierge answers a permission prompt with "approve".
 *  Reaching `appendPrompt` with the default meant an LLM's "yes" cleared `escalatedAt`, `continues`,
 *  `totalContinues` and `goalDebt`, refilling the very bound `projectStore.releaseGoalDebt` warns
 *  no machine dispatch may reach. */
function recordPickerAnswer(agentId: string, label: string, humanAuthored: boolean): void {
  const project = useProjectStore
    .getState()
    .projects.find((p) => p.agents.some((a) => a.id === agentId));
  if (!project) return;
  useProjectStore.getState().appendPrompt(project.id, agentId, label, "picker", humanAuthored);
}

/** Everything that used to hang off the composer's onSubmitPrompt, run once a USER prompt is
 *  DELIVERED (see the side-effects note in the file header). Best-effort by construction: an agent
 *  whose project can't be resolved simply gets no history entry, and an unmounted terminal no
 *  marker — neither is a reason to fail a send that already landed. */
/** Exported for the BRIEF-AT-LAUNCH path (AgentPane): a brief delivered as claude's positional
 *  prompt never passes through `submitPrompt`, so it has to record the same five side-effects here
 *  or the pinned header, prompt history and auto-naming would all be blind to the agent's opening
 *  instruction — the exact blindness `engine/newAgentAttention.isBriefless` then misreads. */
export function recordPromptSideEffects(
  agentId: string,
  text: string,
  renderings: Pick<ConciergeDispatchOptions, "display" | "namingBasis"> = {},
  /** Did a PERSON compose this text? Forwarded to `appendPrompt`, which releases the agent's goal
   *  retry budget and escalation only for a human send. See dispatchAuthority.isHumanAuthored. */
  humanAuthored = true,
): void {
  // Debit one free-trial prompt on the server. Self-gates: a no-op for entitled users, and it
  // never throws (see trialMeter).
  void recordTrialSend();
  // A DELIVERED USER PROMPT IS AN INTERACTION WITH THAT AGENT — recorded here, ABOVE the project
  // lookup below, because it is true of any agent the concierge can reach and not only of ones that
  // own a project tab.
  //
  // This is the last side effect still owed from a composer's onSubmitPrompt, and it arrived late
  // because the pane that needed it was the last to keep a composer. The sidebar's elapsed timer
  // reads `max(promptHistory.at, interactionStore.lastAt[id])`: a project agent's prompt resets it
  // via the `appendPrompt` below, but IMPROVE SPARKLE has no AgentTab, so `!project` returns early
  // and nothing downstream of here runs for it. Its old pane-local composer called `touch()` itself
  // for exactly that reason; with that composer gone and the concierge the only way in, the timer
  // would climb while the user was actively prompting the agent — the reported bug, relocated
  // (roborev 54812, and the AGENTS.md "a fix that changes WHEN something happens" rule).
  //
  // Harmless where it is redundant: the timer takes the max of the two sources, and Terminal.onData
  // already touches this same key when the user types into a terminal directly.
  useInteractionStore.getState().touch(agentId);
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
  const promptId = useProjectStore
    .getState()
    .appendPrompt(project.id, agentId, shown, "composer", humanAuthored);
  markAgentPrompt(agentId, promptId);
  // Fire-and-forget: no-ops if the name is pinned or no API key is configured. Gated on the
  // auto-rename AI feature, and skipped for an empty basis so the naming model is never asked to
  // summarize nothing — which is precisely the attachments-only send.
  if (basis && aiFeatureNow("autoRename")) void maybeAutoName(project.id, agentId, basis);
}

