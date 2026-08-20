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
// ONE definition of "which option is the plain Yes", shared with the module that already governs
// these screens (bead sparkle-voudj7). See `isAffirmative` for what a second, looser copy cost.
import { optionText, PLAIN_YES, YES_CONTINUATION } from "./suggestions/approvalClassifier";
import { maybeAutoName } from "./agentNaming";
import { recordTrialSend, trialSendAllowed } from "./trialMeter";
import { aiFeatureNow } from "./aiGate";
import { queuePendingSend, takePendingSends } from "./pendingSends";
import {
  abandonAllScreenHeldSends,
  reinstateScreenHeldSends,
  screenHoldGeneration,
  sweepExpiredScreenHolds,
  takeScreenHeldSends,
} from "./screenHoldQueue";
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
  /** Present, and always `"screen"`, on an outcome belonging to the SCREEN hold rather than to the
   *  PTY-not-ready hold a few lines above. The two share one `"queued"` path, but the
   *  founder-facing wording differs — "the screen is busy" is not "it's still starting up" — so a
   *  caller that wants the right one reads this.
   *
   *  ⚠️ NOTHING ENQUEUES A SCREEN HOLD ANY MORE (bead sparkle-93wnu3). The only producer was the
   *  mounted send, and a mounted send is now DELIVERED — see {@link mountedHumanSend}. The queue,
   *  its drain and this field are inert; they are removed in the follow-up, and are kept for one
   *  change so the behavioural fix lands on its own and can be reverted on its own. Do not add a
   *  new producer: a hold whose release depends on the same predicate that caused it is how the
   *  founder's message came to be dropped fifteen minutes after he was promised it would arrive. */
  heldReason?: "screen";
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
   * SET BY EXACTLY TWO CALLERS, both of which derive the fingerprint from the live screen rather
   * than accepting one from anybody else: `conciergeTools/terminal`'s `selectPickerOption` (after
   * its own fingerprint check) and `ConciergeHost`'s Approve relay via {@link pickerPressFor}
   * (bead sparkle-voudj7 — the founder's Approve button was refused eight times running because it
   * set nothing here). It remains deliberately NOT reachable from `send_to_agent_terminal`'s tool
   * schema, so free text cannot acquire the exemption by asking for it.
   */
  pickerPress?: { fingerprint: string };
  /**
   * THE HUMAN IS LOOKING AT THIS SCREEN — the send came from a pane he MOUNTED and typed into.
   * A send so marked is DELIVERED: none of the screen refusals apply to it.
   *
   * ══ THE FOUNDER'S RULE, AND WHY "HOLD" WAS THE WRONG READING OF IT (bead sparkle-93wnu3) ══════
   * The rule has not changed since bead sparkle-tbsvf: *"The alt-screen refusal stays for
   * PROGRAMMATIC senders (the concierge writing via MCP). It must NEVER apply to the human typing
   * into a pane he deliberately mounted."* This flag used to be spelled `holdForScreenClear` and
   * implemented that rule as QUEUE-INSTEAD-OF-REFUSE. Holding IS applying it, and the queue made
   * the failure worse rather than better:
   *
   *   • The hold's release condition is the SAME predicate that caused it (hooks/useScreenHoldDrain
   *     re-ran `terminalWriteRefusal`), so a screen the predicate is WRONG about never clears —
   *     the message waits out MAX_AGE_MS and is then dropped. Measured: `__sparkle_self__`, whose
   *     pane the founder had open in front of him, told him "screen is busy right now — I'll send
   *     that the moment it clears" and delivered nothing.
   *   • CLAUDE CODE HOLDS THE ALTERNATE BUFFER AT ALL TIMES on v2.1.237 — captured from a real PTY
   *     at a bare idle prompt, `buffer.active.type === "alternate"` (see
   *     `capturedScreens.fixture.ts` for the capture recipe). So EVERY agent in this app sits
   *     permanently on the "prove you are Claude Code or be refused" branch, and one
   *     false negative from a content heuristic makes that pane unreachable rather than merely
   *     inconvenient.
   *
   * Asked directly (2026-08-20) whether a mounted send may ever be held, the founder chose
   * *"Never hold — just send it: a mounted send is delivered immediately, always. You are looking
   * at the pane; your eyes are the guard."* That is what this flag now means.
   *
   * SET BY EXACTLY ONE CALLER: ConciergeHost's MOUNTED composer send. The scoping is the whole
   * safety argument, not an implementation detail — the screen refusals exist because a write that
   * lands wrong on `vim` or a credential field cannot be taken back, and that is exactly as true
   * for a MODEL guessing at a screen it cannot see (`send_to_agent_terminal`) or an auto-resume
   * firing every 15s as it ever was. Neither may set this.
   *
   * ══ AND IT IS NOT THE GUARD BY ITSELF — READ {@link mountedHumanSend} ══════════════════════════
   * The human/machine half is read from the validated AUTHORITY, which a flag cannot spoof, so a
   * machine-authored caller that sets this is refused anyway and a `mount` authority is exempt
   * WITHOUT it. The flag survives for the human authorities that are not `mount` — chiefly the
   * mounted send that went through a COUNTDOWN and therefore arrives as `{kind: "countdown"}`.
   */
  mountedSend?: boolean;
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

/**
 * True when the button is the PLAIN-affirmative option: a bare "Yes…" label or the y/N `"y\n"`
 * value. Deliberately does NOT match a label merely starting with a standalone "y" (e.g.
 * "Y - use YAML"), which would let a "yes"-family answer select a non-affirmative option.
 *
 * ══ IT READS THE LABEL THROUGH `optionText`, AND THAT IS THE WHOLE FIX (bead sparkle-voudj7) ═══
 * `detectClaudeCodePicker` renders every option as ``${n} · ${label}``, so a real permission dialog
 * arrives here as `"1 · Yes"` — never as `"Yes"`. Testing `^yes\b` against the WHOLE label therefore
 * matched nothing on the single most common picker in the app, and every unit fixture that "proved"
 * this predicate worked was hand-built as `{ label: "Yes" }`: a shape production cannot emit. The
 * cost was the BLOCKED row's Approve button, which sends the literal word "approve" (a `YES_WORDS`
 * member) and so fell straight through to `ambiguous-picker` on the exact dialogs it exists to
 * answer.
 *
 * ══ AND `!YES_CONTINUATION` IS NOT DECORATION — IT IS THE SAFETY HALF ═════════════════════════
 * Stripping the ordinal without it is WORSE than the bug it fixes. Claude Code's plan-mode dialog
 * offers only continuations:
 *
 *     1. Yes, and auto-accept edits
 *     2. Yes, and manually approve edits
 *     3. No, keep planning
 *
 * With a bare `^yes\b` every one of those is affirmative, so a single Approve click would press
 * option 1 and turn on auto-accept edits FOR THE SESSION — a standing grant nobody asked for, from
 * a button whose whole promise is answering one question. Before the ordinal strip these labels
 * matched nothing and the press was safely refused, so widening the predicate alone would have
 * converted a harmless refusal into a silent privilege escalation (roborev 64206).
 *
 * SHARED WITH `approvalClassifier`, NOT RE-DERIVED. That module governs the same screens and has
 * always applied exactly this rule (`findApproveOption`); this predicate briefly carried a second,
 * looser copy, which is how the two came apart. One definition, imported.
 */
function isAffirmative(b: SuggestionButton): boolean {
  const text = optionText(b);
  return (PLAIN_YES.test(text) && !YES_CONTINUATION.test(text)) || /^y[\r\n]*$/i.test(b.value);
}
/** True when the button is the negative option ("No", or the y/N "n" answer).
 *
 *  NO CONTINUATION EXCLUSION HERE, deliberately: "No, and tell Claude what to do" and "No, keep
 *  planning" ARE the deny option on the dialogs above, and declining is never the escalation the
 *  affirmative side has to guard against. */
function isNegative(b: SuggestionButton): boolean {
  return /^\s*no\b/i.test(optionText(b)) || /^n[\r\n]*$/i.test(b.value);
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
  //
  // ══ AND "AFFIRMATIVE" MEANS THE PLAIN YES, NEVER A CONTINUATION (bead sparkle-voudj7) ═════════
  // A "Yes, and …" option is not a stronger yes, it is a DIFFERENT act: "Yes, and don't ask again"
  // and "Yes, and auto-accept edits" hand over a standing grant for the rest of the session, which
  // is not what anyone typing "yes" — or pressing a one-click Approve — asked for. `isAffirmative`
  // carries that exclusion, so this `find` cannot return one however the menu is ordered, and a
  // dialog offering ONLY continuations (Claude Code's plan-mode prompt) matches nothing here and
  // falls through to `ambiguous-picker` — a refusal whose copy says "open it to choose", which is
  // the honest answer when no option means plain approval.
  //
  // Position is deliberately NOT the defence. An earlier cut of this preferred a bare Yes and fell
  // back to the first affirmative, which is the same thing as trusting Claude Code's ordering — and
  // on the plan-mode dialog, whose affirmatives are all continuations, that fallback pressed
  // "auto-accept edits" (roborev 64206).
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
  // A message composed FOR the orchestrator ("resume this epic"), not an answer to anything on its
  // screen. A stalled agent has no live picker by construction — that is what made it stalled.
  "epic-restart": false,
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
 * The `pickerPress` evidence for answering the menu this agent has on screen RIGHT NOW with `text`,
 * or `undefined` when there is no such menu, no fingerprint for it, or `text` answers nothing on it.
 *
 * ══ WHY A UI BUTTON NEEDS THIS AT ALL (bead sparkle-voudj7) ═══════════════════════════════════
 * THE FIELD SYMPTOM: the founder pressed the BLOCKED row's Approve EIGHT times in a row and got
 * "…is in a full-screen app right now, so I didn't send the approval… Quit it and approve again."
 * every time. The full-screen app was the agent's OWN Claude Code picker — there was nothing of his
 * to quit, and quitting it would have discarded the very question he was approving. The advice was
 * unfollowable, so the button was not merely broken but inescapably so.
 *
 * THE MECHANISM is the one `sparkle-jk8zt` already documented for the model-facing tool, arriving
 * through a second door. `isClaudeCodeScreen` REQUIRES the composer box, and a permission dialog
 * REPLACES it — so a live picker reads as a full-screen app to the write path, and the
 * alternate-screen arm refuses. `selectPickerOption` escapes that by carrying a fingerprint;
 * `ConciergeHost`'s Approve relay carried nothing, so it took the refusal every single time.
 * `select_picker_option` SUCCEEDING on the same agent in the same instant is what proved it.
 *
 * IT IS EVIDENCE, NOT A FLAG, and that is why this returns a fingerprint rather than a boolean.
 * The dispatcher does not trust it: it re-derives the fingerprint from the CURRENT screen and
 * compares (see `verifiedPickerPress`), so a menu that MOVED between this call and the dispatch
 * refuses itself. `vim`, `less` and `htop` have no menu for `liveOptionsFor` to find, so they yield
 * no options, no fingerprint, and take the alternate-screen refusal exactly as before.
 *
 * THE `matchAnswerToOption` CONJUNCT IS LOAD-BEARING, not a convenience. Without it a caller could
 * acquire the alternate-screen exemption for text that maps to NO option, and that text would fall
 * past the picker block to `submitPrompt` — i.e. pasted AND SUBMITTED as free text onto the very
 * screen the guard exists to keep prose off. Requiring a match means the exemption can only ever be
 * spent on a keystroke this module has already decided the menu accepts.
 */
export function pickerPressFor(agentId: string, text: string): { fingerprint: string } | undefined {
  const options = liveOptionsFor(agentId);
  if (options.length === 0) return undefined;
  if (!matchAnswerToOption(text, options)) return undefined;
  const fingerprint = pickerFingerprint(agentId, options);
  // "" is `pickerFingerprint`'s sentinel for "found options but could not locate the question they
  // belong to" — the state where two different dialogs with the same option shape are
  // indistinguishable. `selectPickerOption` refuses outright on it (`unreadable-picker`) and the
  // dispatcher rejects it in `verifiedPickerPress`; returning it here would only manufacture a
  // waiver the dispatcher is about to throw away.
  return fingerprint === "" ? undefined : { fingerprint };
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
/**
 * IS THIS THE HUMAN TYPING INTO A PANE HE MOUNTED? — the founder's refusal scope, made structural.
 *
 * A `true` here means the SCREEN REFUSALS DO NOT APPLY to this send. It is delivered, whatever the
 * screen looks like. See {@link ConciergeDispatchOptions.mountedSend} for the rule in the founder's
 * own words, for the measurement that killed the queue-instead-of-refuse compromise, and for why
 * "hold it until the screen clears" was never what he asked for.
 *
 * ══ WHY THIS IS NOT JUST `opts.mountedSend` ═════════════════════════════════════════════════════
 * That flag is a BOOLEAN THE CALLER PASSES, and its own doc states the rule it cannot enforce:
 * "neither [`send_to_agent_terminal`] nor an auto-resume may set this". Nothing stopped them. The
 * options bag is plain data, so a tool call that set it — by design, by a copied call site, or by an
 * object rebuilt off the wire — would buy itself the founder's exemption on a screen it cannot see.
 * That is the same "each new caller arrives unguarded" failure this module's screen guard was
 * hoisted here to end, and a convention in a docstring is not a guard.
 *
 * So the human/machine half is read from the AUTHORITY, which is validated at the top of
 * `routeConciergeAnswer` and cannot be spoofed by a flag: `isHumanAuthored` is a `Record` over the
 * union, so a NEW authority kind is a compile error there until someone decides which side of this
 * line it sits on. `concierge-tool` and `goal-continue` are false, and they keep the outright
 * refusal however they are called.
 *
 * ══ AND WHY THE FLAG IS STILL READ ══════════════════════════════════════════════════════════════
 * Being human-authored is necessary, not sufficient. Most human authorities are a BUTTON PRESS at a
 * live prompt (`approval`, `nudge-approve`, `suggestion`) made from the concierge column rather than
 * from a mounted terminal, and the person clicking one of those is NOT looking at that agent's
 * screen. Those keep the refusal, which loses them nothing: the words are restored to the box.
 *
 * `mount` is exempt from needing the flag at all, because it IS the founder's case: he typed into a
 * terminal he had patched a cable into and is watching.
 *
 * ══ THE EXEMPTION IS THE *AUTHORITY'S*, NOT EVERY MOUNTED SEND'S (roborev 64466, Medium) ═════════
 * An earlier draft of this said "a mounted send is never bounced, whoever calls this". That claims
 * more than the code does, and the gap is a SHIPPED path: a mounted send made while presence is AWAY
 * — an explicit `setAway()`, an unfocused window, an idle voice session — does not dispatch
 * immediately. It ARMS an intent and dispatches at expiry as `{kind: "countdown"}`, even though
 * `mentionAim.via` is still `"mount"`. That send is exempt on the FLAG, which ConciergeHost passes
 * from the very same `via === "mount"` test (see its `promptAgent` call).
 *
 * So, precisely: the `mount` AUTHORITY needs no flag; a mounted send that goes through the countdown
 * still does. Do NOT read the exemption as making that argument redundant and drop it — that
 * reintroduces the founder's original bug for the mounted-while-away case. Two rows guard it, at the
 * two layers, and BOTH are needed: `conciergeDispatch.altScreen.test.ts` pins that this module
 * honours the flag under a `countdown` authority, and `ConciergeHost.mounted.test.tsx` runs a
 * mounted-while-AWAY send to expiry and pins that the call site still passes it. The second is the
 * one that catches the realistic edit, which is not a deletion but a NARROWING to
 * `authority.kind === "mount"` — every immediate mounted row stays green under that, because on
 * that path the authority IS `mount` (roborev 64476).
 */
function mountedHumanSend(opts: ConciergeDispatchOptions): boolean {
  // The machine half, first and unconditionally: a programmatic sender is never exempt, flag or no
  // flag.
  if (!isHumanAuthored(opts.authority)) return false;
  return opts.authority.kind === "mount" || opts.mountedSend === true;
}

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
  // ══ …AND NOT AT ALL WHEN THE HUMAN IS LOOKING AT IT (bead sparkle-93wnu3) ═════════════════════
  // `mountedHumanSend` is the founder typing into a pane he mounted. He can see whether that pane
  // is `vim`; the heuristic above only GUESSES, and on a fleet where Claude Code holds the
  // alternate buffer at all times (measured on v2.1.237, at a bare idle prompt) a single false
  // negative made his own pane permanently unreachable. His rule, verbatim: the alt-screen refusal
  // "must NEVER apply to the human typing into a pane he deliberately mounted."
  if (
    screen?.alternateBuffer &&
    !claudeCodeHoldsTheBuffer &&
    !verifiedPickerPress &&
    !mountedHumanSend(opts)
  ) {
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
    !mountedHumanSend(opts) &&
    (screenIsCredentialField(screen.text) ||
      (!viewportOffersYesNo && screenIsYesNoPrompt(screen.text)))
  ) {
    log.warn("concierge", "refused a write into a credential prompt", { agentId });
    return { ok: false, path: "blocked-prompt", agentId };
  }
  // ── A VERIFIED PICKER PRESS IS WAIVED HERE TOO, FOR THE REASON IT IS WAIVED ABOVE ────────────
  // This arm and the alternate-screen arm are two refusals of the SAME write, and until now only
  // the first had the carve-out — which was survivable ONLY because `isClaudeCodeScreen` returned
  // false on a permission dialog, so `claudeCodeHoldsTheBuffer` was false and this arm never ran
  // during a picker. Fixing that predicate (a live dialog IS Claude Code) makes this arm the one
  // that fires, and a press that used to be answered comes back `blocked-prompt` instead: the same
  // "the concierge cannot answer ANY approval prompt" bug that `sparkle-jk8zt` fixed, re-entering
  // through the second door. `conciergeDispatch.pickerPress.test.ts` catches it.
  //
  // The premise is unchanged and is not weakened. `screenBlocksWrite` is true here because the
  // screen is AWAITING INPUT — it is a dialog — and answering that dialog by its own option is
  // exactly the act this guard exists to permit rather than prevent. `verifiedPickerPress` is not
  // the caller's word for it: the fingerprint was re-derived from the CURRENT screen a few lines
  // up, so a match means this function has just read the same live menu. FREE TEXT still takes the
  // refusal — `pickerPress` is reachable only from `selectPickerOption`, never from the
  // model-facing `send_to_agent_terminal`, which is what keeps prose off this screen.
  if (
    claudeCodeHoldsTheBuffer &&
    !verifiedPickerPress &&
    !mountedHumanSend(opts) &&
    screenBlocksWrite(screen.text)
  ) {
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

  // ══ A LIVE PICKER DOES NOT SILENCE THE FOUNDER (beads sparkle-9gsjqm, sparkle-93wnu3) ═════════
  // THE FOUNDER'S BUG, reported more than once: text typed into a MOUNTED pane does not reach the
  // agent. `neverPickerAnswer` is TRUE for every mounted composer send (see ConciergeHost's
  // `!!mentionAim && addressable`), so a mounted send made while a picker happened to be on screen
  // took `addressed-at-picker` and BOUNCED. An earlier fix made those three arms HOLD instead of
  // refuse, which only moved the loss later: the hold's release condition is a predicate that can be
  // permanently wrong about the screen, and the message was dropped at MAX_AGE_MS.
  //
  // So a MOUNTED SEND SKIPS THIS BLOCK ENTIRELY and reaches `submitPrompt` below as ordinary free
  // text — which is the one thing the block's arms were all trying to avoid doing BLINDLY, and the
  // founder is not blind: he mounted the pane and is looking at it.
  //
  // ══ AND IT IS ALWAYS FREE TEXT, NEVER A KEYSTROKE — DELIBERATELY ══════════════════════════════
  // A first cut of this carved out "…unless the text is an unambiguous terse answer to the menu",
  // so a mounted `"1"` would still press option 1. That carve-out was UNREACHABLE and its test was
  // vacuous (roborev 65708, Medium): it required `!opts.neverPickerAnswer`, and the only caller
  // that can mark a send `mounted` sets `neverPickerAnswer` from the very same `via === "mount"`
  // condition — so the two can never disagree, and the test had to hand-build a combination no
  // caller produces.
  //
  // Reinstating it would need the CALL SITE to decide, and that is the wrong answer anyway: the
  // standing rule for an addressed send is that AN ADDRESSED MESSAGE IS A MESSAGE, NOT A KEYSTROKE
  // (roborev 54569/55400), precisely because pressing a button the human never read is the least
  // recoverable thing this path can do. A mounted send is an addressed send. Answering a menu
  // deliberately still has its own surfaces — the Approve relay and the suggestion pills, both of
  // which carry a re-derived fingerprint (`verifiedPickerPress`) that free text cannot acquire.
  //
  // Nothing changes for anyone else. `mountedHumanSend` is false for a `concierge-tool` send, the
  // goal auto-resume, and every button press made from the concierge column, so all of them take
  // the refusals below verbatim.
  if (options.length > 0 && !mountedHumanSend(opts)) {
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
 * Deliver everything queued for `agentId` in the SCREEN-hold queue (services/screenHoldQueue).
 *
 * ⚠️ INERT SINCE bead sparkle-93wnu3 — nothing enqueues a screen hold any more (see
 * `ConciergeDispatchResult.heldReason`). Kept for one change so the behavioural fix lands alone;
 * removed in the follow-up.
 *
 * The mirror of `flushPendingSends` above, and it shares that function's shape deliberately — same
 * outcome broadcast, same expired-vs-due split — but reads the SEPARATE screen-hold queue with its
 * own, longer TTL, and every outcome it emits carries `heldReason: "screen"` (see that field's doc)
 * so a deferred reader can tell this hold apart from the PTY-not-ready one and say something true
 * about it — the agent DID come up; it is its screen that was busy.
 *
 * DELIVERS AT MOST ONE DUE ENTRY PER CALL (roborev 64268's Medium — a prior version tried to
 * re-check the screen between writes within one call and loop through the rest, but that cannot
 * see the hazard it was meant to prevent: `submitPrompt`'s `await` resolves once the PTY has
 * ACCEPTED the write, not once the agent has processed it and xterm has redrawn — a dialog the
 * first write raises appears seconds later, well after a synchronous re-read of the viewport would
 * have already passed). Any further due entries are re-queued and hooks/useScreenHoldDrain's own
 * 1500ms poll interval is what gives the screen a REAL chance to change before the next one is
 * tried, re-reading the viewport from scratch rather than trusting a stale read.
 *
 * THE RE-QUEUE IS GENERATION-GUARDED (roborev 64289's Medium). `takeScreenHeldSends` above empties
 * the queue before the `await`, so if the pane is abandoned WHILE that write is in flight,
 * `abandonScreenHeldSends` finds an already-empty queue and reports nothing — and re-queuing `rest`
 * afterward would resurrect it into a dead agent's queue (or a relaunch's, under the same id, that
 * the founder never typed into). Capturing the generation before the take and checking it again
 * after the await is what tells "nothing changed" apart from "this agent was abandoned while I was
 * waiting"; see `screenHoldGeneration`'s own doc for why the bump is atomic with the clear.
 *
 * THE RE-QUEUE PREFERS THE OLDER ENTRIES (also roborev 64289's Medium). `reinstateScreenHeldSends`
 * merges `rest` with whatever queued in during the await and keeps the oldest — a plain per-entry
 * `queueScreenHeldSend` loop let mid-flush arrivals occupy the cap first and refuse the OLDER
 * promised sends instead, the exact ordering inversion the `at`-insert change in screenHoldQueue.ts
 * was made to prevent.
 */
export async function flushScreenHeldSends(agentId: string): Promise<ConciergeDispatchResult[]> {
  const generationBefore = screenHoldGeneration(agentId);
  const { due, expired } = takeScreenHeldSends(agentId);
  const out: ConciergeDispatchResult[] = [];
  for (const entry of expired) {
    const r: ConciergeDispatchResult = {
      ok: false,
      path: "expired",
      agentId,
      sent: entry.text,
      display: entry.display ?? entry.text,
      heldReason: "screen",
    };
    out.push(r);
    emitOutcome(r);
  }
  const [first, ...rest] = due;
  // `rest`'s handling lives in `finally` (roborev 64312's Medium): `takeScreenHeldSends` above
  // already emptied the queue, so if `submitPrompt` or `recordPromptSideEffects` throws anything
  // OTHER than `PtyGoneError`, that error re-throws past the `try` below — and without `finally`,
  // control never reached this block at all. Up to MAX_PER_AGENT still-due, explicitly-promised
  // sends would vanish with no re-queue and no outcome, an unobserved rejection on the only real
  // caller (`useScreenHoldDrain`'s `void flushScreenHeldSends(...)`). `finally` runs regardless of
  // how the try block exits, so `rest` is always reinstated or reported before this function's own
  // promise settles (rejected or not).
  try {
    if (first) {
      const display = first.display ?? first.text;
      let r: ConciergeDispatchResult;
      try {
        await submitPrompt(agentId, first.text, { machine: !first.humanAuthored });
        if (first.userPrompt)
          recordPromptSideEffects(agentId, first.text, first, first.humanAuthored);
        r = { ok: true, path: "free-text", agentId, sent: first.text, display, heldReason: "screen" };
      } catch (err) {
        if (!(err instanceof PtyGoneError)) throw err;
        r = { ok: false, path: "pty-gone", agentId, sent: first.text, display, heldReason: "screen" };
      }
      out.push(r);
      emitOutcome(r);
    }
  } finally {
    if (rest.length > 0) {
      if (screenHoldGeneration(agentId) !== generationBefore) {
        // Abandoned while the first write was in flight — do not resurrect anything into its (now
        // dead, or relaunched-under-the-same-id) queue. Report the truth instead.
        for (const entry of rest) {
          emitOutcome({
            ok: false,
            path: "abandoned",
            agentId,
            sent: entry.text,
            display: entry.display ?? entry.text,
            heldReason: "screen",
          });
        }
      } else {
        reinstateScreenHeldSends(
          agentId,
          rest,
          (evicted) => {
            for (const e of evicted) {
              emitOutcome({
                ok: false,
                path: "queue-full",
                agentId,
                sent: e.text,
                display: e.display ?? e.text,
                heldReason: "screen",
              });
            }
          },
          (dropped) => {
            for (const d of dropped) {
              emitOutcome({
                ok: false,
                path: "expired",
                agentId,
                sent: d.text,
                display: d.display ?? d.text,
                heldReason: "screen",
              });
            }
          },
        );
      }
    }
  }
  return out;
}

/**
 * Report and clear ONLY the entries in `agentId`'s screen-hold queue that have aged out — for a
 * screen that is STILL blocked, where `flushScreenHeldSends` (which would deliver the still-live
 * ones) must not run. Without this, an agent whose screen never clears drops out of
 * `agentIdsWithScreenHolds`'s default (live-only) view once every entry has expired, and nothing
 * ever visits it again to report the expiry or free the queue — roborev 64238's High. Called from
 * hooks/useScreenHoldDrain on the "still blocked" branch; a no-op when nothing has expired.
 */
export function sweepExpiredScreenHeldSends(agentId: string): void {
  for (const entry of sweepExpiredScreenHolds(agentId)) {
    emitOutcome({
      ok: false,
      path: "expired",
      agentId,
      sent: entry.text,
      display: entry.display ?? entry.text,
      heldReason: "screen",
    });
  }
}

/**
 * STOP THE HOLD CLOCK WHILE THERE IS NO SCREEN TO READ (bead sparkle-9gsjqm).
 *
 * Called by hooks/useScreenHoldDrain on the `no-viewport` tick — the agent's terminal simply is not
 * mounted in this window (the founder unmounted, switched the cable to another pair, or the pane
 * lives in a window that is not this one). That is NOT the same fact as "the screen is busy", and
 * the drain used to treat the two identically: it swept, waited, and let the hold age out to
 * `expired` after MAX_AGE_MS without ever having had a chance to deliver it. The hook's own header
 * says the opposite — a hold "must still arrive; it does not become void because he looked away" —
 * so the code contradicted the promise the founder was actually made.
 *
 * WHY THE FIX IS THE CLOCK AND NOT THE SWEEP. Merely skipping `sweepExpiredScreenHeldSends` here
 * changes nothing anyone can observe: the entry stays in the queue, and the next flush classifies
 * it `expired` by the same MAX_AGE_MS rule and hands it back undelivered. The 15-minute ceiling is
 * a real policy (see screenHoldQueue's header for why it is not pendingSends' 2 minutes) and this
 * does not raise it — it measures it against time the screen was actually WATCHABLE, which is the
 * only kind of waiting the ceiling was ever reasoning about.
 *
 * SHIFTS BY ONE DELTA, NEVER RE-STAMPS EACH ENTRY TO `now`. Re-stamping would flatten every held
 * entry onto the same instant, and `reinstateScreenHeldSends` sorts by `at` — so a message that
 * arrived DURING the hidden stretch would sort ahead of the older ones it follows, the exact
 * ordering inversion roborev 64289 was filed about. Anchoring the shift on the NEWEST entry moves
 * the whole queue by one amount, so relative order (and relative age) survives untouched.
 *
 * IT PROTECTS THE LIVE ENTRIES, IT DOES NOT RESURRECT DEAD ONES. Anything already past MAX_AGE_MS
 * when this runs aged out for some reason OTHER than the screen being unreadable — it was visible
 * and blocked, or nothing polled at all (a sleeping machine fires no interval) — so it is swept and
 * REPORTED first, exactly as the blocked branch would have. Un-expiring those would deliver a
 * message typed an hour ago into a session that has moved on, which is the harm services/pendingSends'
 * own header is about. Given the drain's 1500ms cadence, an entry can only reach this function
 * already expired through one of those two routes; the ordinary hidden case never accrues the age.
 *
 * WHAT BOUNDS THIS. Not a second timer: the pane's own lifetime. `AgentPane` reports and clears
 * both hold queues via `abandonScreenHeldSends` on unmount and on a spawn give-up, so a hold can
 * only outlive the founder's attention for as long as the agent it is aimed at still exists — which
 * is precisely the window the hook's header promises to cover. `MAX_PER_AGENT` still caps how many
 * can wait, so a hidden pane refuses a sixth send with a truthful `queue-full` rather than
 * accumulating an outbox.
 */
export function deferScreenHoldsWhileHidden(agentId: string): void {
  // Reported and cleared through the SAME path the blocked branch uses, rather than a second copy
  // of the emit — see the doc above for why an already-expired entry is not this function's to save.
  sweepExpiredScreenHeldSends(agentId);
  // Everything the sweep left is live against the real clock, so this take can use it: `due` is the
  // whole remaining queue and `expired` is empty by construction.
  const { due } = takeScreenHeldSends(agentId);
  if (due.length === 0) return;
  // Anchored on the NEWEST entry, so the whole queue moves by ONE amount — see this function's doc
  // for why re-stamping each entry to `now` instead would invert the delivery order. Never negative:
  // a queue whose newest entry is somehow ahead of the clock must not be aged by this.
  const shift = Math.max(0, Date.now() - Math.max(...due.map((e) => e.at)));
  // Copies, so nothing already handed to another holder is mutated underneath it.
  const moved = due.map((e) => ({ ...e }));
  for (const e of moved) e.at += shift;
  // NO `onCrowdedOut`/`onPruned` here, unlike `flushScreenHeldSends`' re-queue, and that is not an
  // omission: the take above emptied this agent's queue and nothing runs between the two calls (no
  // await, one thread), so there is no incumbent for `moved` to crowd out and nothing to prune.
  // Passing callbacks that cannot fire would read as a guarantee this function does not provide.
  reinstateScreenHeldSends(agentId, moved);
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
 * The screen-hold twin of `abandonPendingSends` — voids a dead pane's held sends with a reported
 * outcome, rather than leaving them to rot until useScreenHoldDrain's poll notices the pane's
 * viewport is gone and (eventually) their TTL lapses. Same promise, same reasoning; a SEPARATE
 * function because the two queues are separate (roborev 64238's Medium — the first cut of this
 * feature left this one queue with no abandon path at all, and `clearScreenHeldSends` no
 * production caller). Called from the same sites `abandonPendingSends` is.
 *
 * `abandonAllScreenHeldSends`, NOT `takeScreenHeldSends` (roborev 64289's Medium): the take alone
 * cannot be told apart from an ordinary flush's take, and `flushScreenHeldSends` needs the
 * generation bump to know this agent was torn down while its own write was in flight — see that
 * function's header and `screenHoldGeneration`'s doc.
 */
export function abandonScreenHeldSends(agentId: string): void {
  for (const entry of abandonAllScreenHeldSends(agentId)) {
    emitOutcome({
      ok: false,
      path: "abandoned",
      agentId,
      sent: entry.text,
      display: entry.display ?? entry.text,
      heldReason: "screen",
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
  /**
   * Set when the CALLER already wrote this prompt to the store (services/agentBrief `BriefRecord`).
   *
   * Then the four write-side effects below are already done, and re-running them is not a harmless
   * repeat: `appendPrompt` has no dedupe, so one mission becomes two `promptHistory` rows — and
   * since `markAgentPrompt` only ever ran against the second, the first one's "jump to this prompt"
   * pointed at nothing. It also double-counted the naming ladder's `promptCount`, debited a
   * free-trial prompt for a send the user never made, and taught the ghost-text corpus a generated
   * epic brief, which its own doc forbids.
   *
   * What is STILL owed is the terminal marker — the one side-effect the attaching caller could not
   * do, because no terminal existed yet when it wrote the row.
   */
  alreadyRecorded?: { promptId?: string },
): void {
  // ── TWO DIFFERENT QUESTIONS, DELIBERATELY ON TWO DIFFERENT AXES ─────────────────────────────
  //
  // A RECORD AT ALL is the attaching caller DECLARING this prompt is not a person's send. That
  // decides the AUTHORSHIP-flavoured effects below (`recordTrialSend`, the ghost-text corpus,
  // auto-naming), because those are about WHO COMPOSED THE TEXT.
  //
  // It is a DECLARATION, not an inference — the record's absence proves nothing on its own, and
  // reading it as proof is how this went wrong once already. Every attaching caller must therefore
  // answer it deliberately: `sendToBuild.seedDraft` always records (it wrote the row itself);
  // `buildAgentSpawn` records only for a `background` spawn — the timer-driven `/babysit-pr`
  // dispatch nobody is watching — and deliberately does NOT for a foreground one, because
  // `send_to_agent_terminal` already establishes that LLM prose dispatched on a person's behalf
  // bills. A future caller that attaches a machine brief without a record silently re-opens the
  // defect below, so give it a record.
  //
  // The record's promptId decides only WHETHER A ROW EXISTS, which is a different fact and governs
  // only the append-vs-mark choice further down.
  //
  // Keying both on the id was a live defect: one and the same machine-authored epic brief then
  // billed a free-trial prompt and taught the corpus a generated brief when the id happened to be
  // absent, and did neither when it was present — a user-visible charge decided by a field that
  // says nothing about who wrote the text. Keying both on the record's presence was the
  // other one: an id-less record skipped the row entirely, leaving the agent briefless to
  // `engine/newAgentAttention.isBriefless` with a jump-to-prompt resolving to nothing.
  //
  // NOT gated on `humanAuthored` instead, even though that reads like the natural axis: the
  // concierge's `send_to_agent_terminal` deliberately dispatches LLM-composed prose as
  // `userPrompt: true`, and it is meant to bill. Authorship alone would silently stop charging it.
  const booked = alreadyRecorded !== undefined;
  // Debit one free-trial prompt on the server. Self-gates: a no-op for entitled users, and it
  // never throws (see trialMeter). Never for a booked brief — nobody made that send.
  if (!booked) void recordTrialSend();
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
  // Global (not per-agent), and it self-ignores empties/over-long prompts. Skipped for a booked
  // brief: a generated epic brief is exactly the "unrepeatable" text this corpus excludes.
  if (!booked) usePromptHistoryStore.getState().record(basis);
  // THE ROW ALREADY EXISTS — so the only write still owed is the marker, against that row rather
  // than a duplicate. Below this point is the append path, for a prompt nothing has recorded yet.
  if (alreadyRecorded?.promptId) {
    markAgentPrompt(agentId, alreadyRecorded.promptId);
    return;
  }
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
  if (!booked && basis && aiFeatureNow("autoRename")) void maybeAutoName(project.id, agentId, basis);
}

