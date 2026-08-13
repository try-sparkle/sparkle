// A permission prompt the concierge is ABOUT TO ANSWER is not yet the founder's problem.
//
// THE BUG. Every `approval`/`waiting` red joins the needs-you band the instant the pane draws it —
// `conciergeFeed.conciergeBand` maps both into `needs_you`, and the count, the "● BLOCKED:" pill and
// the phone relay all read that band. But the overwhelming majority of those prompts are routine
// permission dialogs (`git status`, `ls`, `cargo check`, `gh pr view`) that an automated answerer
// disposes of within seconds. Measured over several hours the founder's needs-you list sat between
// 15 and 28 items almost continuously, nearly all of them prompts that were answered before he could
// have read them. A list that is mostly self-clearing noise is a list nobody reads, which costs the
// reds that DO need him.
//
// THE FIX. Hold such a prompt out of the band for a short window while the answerer works, and
// surface it the moment that window is not doing its job. Three things END the hold, and only three:
//
//   1. THE ANSWERER COULD NOT REACH THE PANE  (`unreachable`) — the write was refused or died:
//      alternate-screen, pty-gone, the pane gave up, the cloud relay is down. This is the case the
//      founder called out specifically, and it is COMMON. It must surface the prompt, not hide it:
//      an unreachable pane means nobody is going to answer this but him.
//   2. THE ANSWERER DECLINED  (`declined`) — it read the prompt and chose not to answer: no `always`
//      rule, a denied tool, auto-approve switched off, an ambiguous menu. Also surfaces immediately;
//      declining IS the statement that the human decides this one.
//   3. THE CEILING LAPSED — {@link BLOCKED_PROMPT_GRACE_MS}. A REAL ceiling, not a best-effort
//      timer: if the answerer is slow, wedged or dead it emits nothing at all, so nothing above can
//      fire, and the only thing standing between the founder and an invisible prompt is the clock.
//      `nextPromptGraceExpiry` exists so a UI caller can arm a wake-up for it — a deadline with no
//      other input change would otherwise never be re-evaluated (the defect hooks/useNewAgentCalm
//      documents at length).
//
// `handled` is deliberately NOT an end condition. A delivered answer makes the prompt disappear on
// its own a beat later; surfacing it in that beat would put a row in the list whose only content is
// "this is already resolved" — the exact flicker this module exists to remove.
//
// ── AND ONE THING THAT MOVES THE CEILING WITHOUT ENDING THE HOLD ─────────────────────────────────
//
//   • THE ANSWERER HANDED IT TO THE CONCIERGE  (`escalated`) — it read the prompt, could not answer
//     it itself, and passed it to a THIRD PARTY that is not the founder. None of the three arms
//     above can express that. `handled` is wrong: nothing was typed, so the red will NOT clear on
//     its own and the hold would run until the ceiling with no answer coming. `declined` is wrong:
//     it surfaces at once, which is exactly the founder interrupt the escalation exists to spend
//     instead. `unreachable` is wrong twice over — it is an accident report, and this is a decision.
//     So it keeps the hold, on a SEPARATE ceiling ({@link CONCIERGE_ESCALATION_GRACE_MS}) that is
//     longer, because the concierge answers on a proactive turn and that channel cannot fire inside
//     thirty seconds — and still FINITE, because rule 3 above is not weakened for it: a concierge
//     that is wedged, out of credits, or simply wrong emits nothing at all, and the founder still
//     has to get the question. An escalation buys time; it never buys silence.
//
// ── THE RULE THAT MATTERS MOST: NEVER SUPPRESS THE SAME PROMPT TWICE ─────────────────────────────
//
// A prompt the answerer failed on will be re-drawn, and if a hold could apply to it again the loop
// is invisible forever: hidden 30s, re-raised, hidden 30s, with the founder never seeing it and the
// agent never progressing. So a prompt's identity (agent + a hash of the question text) is burned
// the FIRST time it is held, and a burned identity is never held again — it goes straight to red.
//
// The burn is stamped when the episode is OPENED rather than when the hold actually renders. That is
// eagerly, on purpose: if the two disagree it is because the hold never happened (an already-lapsed
// ceiling), and the safe direction of that error is "show the founder", never "hide it again".
//
// ── SCOPE ────────────────────────────────────────────────────────────────────────────────────────
//
//   • ONLY `waiting` / `approval`, via `newAgentAttention.isDemonstratedAsk` — the two statuses that
//     are positive evidence a question is DRAWN ON SCREEN. `blocked` is deliberately excluded: it is
//     a quota limit or a stall timer, not a prompt anyone can auto-answer, so hiding it would be
//     swallowing a red with no answerer behind it.
//   • ONLY when a prompt screen was actually captured. No text → no identity → no hold. A rule that
//     cannot tell two prompts apart cannot honour "never twice", so it declines to run at all.
//   • De-escalates via `alertDismissal.deEscalatedStatus`, exactly as movement-retraction and the [x]
//     do, so a held row lands in the same calm tier instead of vanishing from a map every downstream
//     band and sort reads.
//
// Same overlay shape as its siblings (`withNewAgentCalm`, `withMovementRetraction`,
// `withDismissedAlerts`): returns the SAME reference when nothing is held, never mutates its input,
// and takes `now` as an argument so the time-dependent rule is tested with a clock rather than fake
// timers. All mutation lives in `notePromptEpisodes` / `notePromptAnswerOutcome`, never in the
// overlay — the split `movementRetraction` uses for the same reason.
import type { AgentTabStatus } from "../types";
import type { RedStatus } from "../services/windowStatus";
import { deEscalatedStatus } from "./alertDismissal";
import { isDemonstratedAsk } from "./newAgentAttention";
// THE SHARED definition of "same prompt, re-rendered" — the one `services/pickerFingerprint` uses.
// It lives in its own dependency-free module precisely so this one can import it (roborev 62838).
import { ANSI, steady } from "../services/promptTextNormalize";
// TYPE-ONLY, and it must stay type-only: `services/conciergeDispatch` imports the recorder below, so
// a value import here would close a runtime cycle. The union lives there because that module owns it.
import type { ConciergeDispatchPath } from "../services/conciergeDispatch";

/**
 * The ceiling on how long a prompt may be held back from the founder.
 *
 * Thirty seconds is the founder's stated number and it is the BACKSTOP, not the mechanism — an
 * answerer that works reports in under a second and the hold ends on the outcome, not on this. What
 * this bounds is the failure the outcome channel cannot report: an answerer that is wedged, crashed,
 * or was never invoked for this agent at all (nothing calls it for a pane this window does not host).
 * In every one of those cases nothing will ever arrive, so this clock is the only thing that surfaces
 * the prompt. Keep it short for that reason.
 */
export const BLOCKED_PROMPT_GRACE_MS = 30_000;

/**
 * The ceiling for a prompt that was handed to the CONCIERGE (`escalated`). Four minutes.
 *
 * WHY IT IS LONGER THAN THE THIRTY ABOVE. The concierge does not answer inline; it answers on a
 * PROACTIVE TURN, and that channel is rate-limited by design — `services/conciergeProactive`
 * enforces a two-minute floor between turns (`PROACTIVE_MIN_INTERVAL_MS`) behind a coalescing
 * window (`PROACTIVE_COALESCE_MS`), so the earliest an escalation can be answered is often minutes
 * after it is filed. Leaving these prompts on the thirty-second clock would surface EVERY escalated
 * prompt to the founder strictly BEFORE the concierge could possibly have answered it — which does
 * not merely weaken the escalation, it makes it pointless: he pays the interrupt anyway and the
 * concierge's answer arrives into a question he has already read. Four minutes clears the floor
 * with room for one coalesced turn to actually run.
 *
 * WHY IT IS STILL BOUNDED — AND THIS IS THE SAFETY PROPERTY, NOT A TUNING CHOICE. It is a CEILING,
 * exactly as {@link BLOCKED_PROMPT_GRACE_MS} is, and for exactly the same reason: an escalation
 * that is never answered must still reach the founder. A concierge that is wedged, out of credits,
 * throttled, or simply wrong emits NOTHING — no outcome, no status write, no event — so nothing
 * above can end the hold and this clock is the only thing standing between the founder and an
 * invisible prompt. Handing a question to a third party is a reason to wait longer; it is never a
 * reason to wait forever. {@link nextPromptGraceExpiry} must arm the wake-up at THIS number for an
 * escalated agent, or the sentence above is a promise with nothing behind it.
 */
export const CONCIERGE_ESCALATION_GRACE_MS = 240_000;

/** TWO ceilings on how many holds may begin for one agent in a rolling {@link HOLD_BUDGET_WINDOW_MS},
 *  chosen by how much evidence stands behind the re-open. Every hold is charged against the same
 *  count; only the ceiling differs. See {@link PromptGraceLedger.holds} for why a budget, rather than
 *  a rule that depends on the prompt's text, is the guarantee against an invisible loop.
 *
 *  {@link MAX_HOLDS_PER_WINDOW} — nothing was reported about the previous question, so the re-open
 *  is indistinguishable from the same question redrawn. TWO, because that is enough to be sure the
 *  founder sees a churning prompt for the great majority of any ask.
 *
 *  {@link MAX_ANSWERED_HOLDS_PER_WINDOW} — an answerer ENGAGED with the previous question (reported
 *  `handled` or `escalated`), so this is probably genuinely the next one. Six covers the burst the
 *  module exists for (the measured case is four routine prompts in two minutes) with room to spare,
 *  and those holds cost almost nothing in practice because an answered prompt's red clears in about
 *  a second rather than running the full ceiling. It is a CEILING and not a bypass on purpose:
 *  `handled` only means the bytes were written, so an unbounded allowance would let a retry loop
 *  hide behind a stream of them. */
const MAX_HOLDS_PER_WINDOW = 2;
const MAX_ANSWERED_HOLDS_PER_WINDOW = 6;
const HOLD_BUDGET_WINDOW_MS = 5 * 60_000;

/** How many burned identities are retained PER AGENT. Eviction is per-agent FIFO, so overflowing it
 *  can at worst re-arm a hold for an identity that agent has not drawn in dozens of episodes — and
 *  the budget above still bounds that. */
const BURN_PER_AGENT = 64;

/**
 * What became of an automated attempt to answer an agent's on-screen prompt.
 *
 * THE TWO FAILURE ARMS ARE SEPARATE BECAUSE THEY ARE DIFFERENT FACTS, even though today they have
 * the same effect here. `declined` is a DECISION — the answerer read the prompt and handed it to the
 * human. `unreachable` is an ACCIDENT — nobody decided anything; the keystroke could not land. Only
 * the second one indicts the machinery, so collapsing them would hide a broken write path inside a
 * number that reads like policy working as intended.
 *
 * `escalated` is the same distinction drawn one step further out: it is a DECISION like `declined`,
 * but about a DIFFERENT PARTY. Both say "I am not answering this"; only `declined` says "so the
 * founder must". Folding it into either neighbour loses the one fact the ceiling below turns on —
 * whether somebody else is still working on this question.
 */
export type PromptAnswerOutcome =
  /** Delivered, or held in a queue that will deliver it. The red clears on its own; keep holding. */
  | "handled"
  /** The answerer read it and chose not to answer. Surface immediately. */
  | "declined"
  /** The keystroke could not reach the pane. Surface immediately. */
  | "unreachable"
  /** The answerer read it and handed it to the CONCIERGE. Keep holding it back from the founder —
   *  someone else is on it — but on a SEPARATE, LONGER, STILL-FINITE ceiling
   *  ({@link CONCIERGE_ESCALATION_GRACE_MS}), because an escalation nobody answers must still land
   *  in front of him. */
  | "escalated";

/**
 * Did the answerer GIVE UP — i.e. say, in one word or another, that the founder is now the only one
 * left to answer this? True for exactly `declined` and `unreachable`.
 *
 * ONE PREDICATE, TWO CALL SITES, and that is the point: {@link isHeld}'s "surface immediately" test
 * and {@link notePromptEpisodes}'s `gaveUp` latch used to spell this as `outcome !== "handled"`
 * independently. Written that way, adding a fourth outcome silently joins BOTH arms — `escalated`
 * would have surfaced the prompt at once and latched the give-up for the rest of the ask, which is
 * the precise opposite of what it means (rule 2 of the header: a give-up is the statement that the
 * HUMAN decides this one; an escalation is the statement that somebody else is deciding it).
 */
function isGiveUp(outcome: PromptAnswerOutcome): boolean {
  return outcome === "declined" || outcome === "unreachable";
}

/**
 * Classify a dispatch path into the outcomes above. Exhaustive over {@link ConciergeDispatchPath}
 * with a `never` guard, so a new path cannot be added without a deliberate decision about which arm
 * it belongs to — the alternative is a default arm that silently files every future refusal as
 * `handled`, i.e. silently hides it from the founder.
 *
 * NO PATH MAPS TO `escalated`, and the exhaustiveness guard is over PATHS, not over outcomes, so
 * adding the arm does not oblige this function to use it. That is correct rather than an omission:
 * a dispatch path describes what the DISPATCHER did with a send, and an escalation is a decision
 * taken by whoever hands the question on — reported through {@link notePromptAnswerOutcome}
 * directly. If the dispatcher ever grows a path of its own that escalates, this switch is where it
 * gets named, and the `never` guard is what will force that decision.
 */
export function answerOutcomeForPath(path: ConciergeDispatchPath): PromptAnswerOutcome {
  switch (path) {
    // Delivered, or held for a pane that is coming up. `queued` is not a failure: the send is still
    // in flight, and if it never lands the ceiling is what surfaces the prompt.
    case "picker-option":
    case "free-text":
    case "queued":
      return "handled";
    // DECIDED against. Each of these is the dispatcher reading the situation and refusing on policy.
    case "ambiguous-picker": // read the menu, no option matched — the human must pick
    case "addressed-at-picker": // a composed message must not press a button nobody read
    case "unauthorized": // nobody declared why this may be sent
    case "trial-spent": // the server refused before delivery
    case "cloud-agent": // must be answered in its own pane, where the question is readable
    case "empty": // nothing to send
      return "declined";
    // COULD NOT REACH IT. No decision was made; the write had nowhere to go, or going there would
    // have been unsafe. This is the arm the founder called out — it is common, and it must never be
    // mistaken for a decline, because a decline at least means something read the prompt.
    case "pty-gone": // the terminal is dead
    case "alternate-screen": // a full-screen app owns the screen; a write would execute as commands
    case "blocked-prompt": // a credential/host-key field; a write would be submitted into it
    case "agent-failed": // the pane gave up (spawn error / Claude missing)
    case "cloud-offline": // no relay socket to emit on
    case "queue-full": // the pane is still starting and its hold queue is full
    case "expired": // held too long for a PTY that never came up
    case "abandoned": // the pane closed or errored while the send was held
      return "unreachable";
    default: {
      const exhaustive: never = path;
      return exhaustive;
    }
  }
}

/** One agent's currently-tracked prompt. */
export interface PromptEpisode {
  /** Identity of the question on screen — see {@link promptEpisodeKey}. */
  key: string;
  /** Epoch ms this QUESTION's window is measured from — the caller's capture time when it has one,
   *  so a prompt that predates this window's first render surfaces AT ONCE rather than earning a
   *  fresh 30 seconds.
   *
   *  PER-QUESTION, and the hold BUDGET below is what makes that safe. It was moved to a per-ask
   *  clock once, to stop a churning identity from resetting the ceiling forever — but that denied a
   *  genuinely new question its own window, and back-to-back approvals whose intermediate `working`
   *  is never sampled are the module's PRIMARY case, so only the first prompt of a burst was ever
   *  held (roborev 62847, Medium). A restart is now allowed and RATIONED instead of forbidden. */
  startedAt: number;
  /** Decided ONCE, when the episode opened: was this identity unburned AND was there budget left?
   *  A `false` episode is never held, however the clock or the outcomes move afterwards. */
  eligible: boolean;
}

/** The window's record of prompt episodes, burned identities and answer outcomes. */
export interface PromptGraceLedger {
  /** agentId → the prompt currently on its screen. Governs ELIGIBILITY only. */
  episode: Map<string, PromptEpisode>;
  /**
   * agentId → the epoch ms at which each HOLD was granted, most recent last. THE HARD GUARANTEE
   * against an invisible loop, and the thing that lets the per-question clock above be safe.
   *
   * WHY A BUDGET AND NOT A LONGER CHAIN OF SPECIAL CASES. Two separate defects both reduce to "how
   * many times may this agent's prompts be hidden?", and both were previously answered by mechanisms
   * that depend on the prompt's TEXT being stable:
   *
   *   • A churning identity re-opens the episode on every redraw. With a per-question clock and no
   *     budget, that resets the window forever (roborev 62838, High).
   *   • The exact-key burn set below cannot recognise a re-raised prompt whose surrounding chrome
   *     moved, so "never twice" silently lapses in precisely the case it exists for — and the churn
   *     also floods the burn set itself (roborev 62847, Medium).
   *
   * A budget needs no agreement about text at all: every hold is charged here, and the ceiling it is
   * charged against is {@link MAX_HOLDS_PER_WINDOW} when nothing was reported about the previous
   * question and {@link MAX_ANSWERED_HOLDS_PER_WINDOW} when it was reported `handled`. Both are
   * finite, so no stream of outcomes and no amount of key churn can produce an unbounded run of
   * holds. The key-exact burn stays as the PRECISE rule (this exact question, never twice); the
   * budget is the one that cannot be defeated by text.
   */
  holds: Map<string, number[]>;
  /**
   * Agents an answerer has GIVEN UP on — reported `declined` or `unreachable`, i.e. {@link isGiveUp}
   * — for the ask they are currently in. Cleared only when the agent actually leaves the ask.
   *
   * `escalated` IS NOT A GIVE-UP and must never land here. The latch's job is to keep a prompt the
   * founder has been made responsible for from sliding back into hiding on the next redraw; an
   * escalation says the opposite — a third party took responsibility — so latching it would surface
   * the question at the first churned repaint and undo the whole escalation, ~3.5 minutes before
   * its own ceiling was due to.
   *
   * ON THE LEDGER, NOT ON THE EPISODE, and the difference is the whole invariant. It was a field on
   * `PromptEpisode` first, documented as living "for the life of the ask … because the episode is
   * deleted the moment the agent leaves the ask". That is not the only thing that deletes an
   * episode: a capture that yields no readable question drops it too, and that is a SCREEN event
   * this module expects mid-ask (the whole no-identity branch exists for it). One blank repaint
   * therefore erased the give-up, and the next churned redraw hid the declined prompt again
   * (roborev 62894). Here it survives every screen event and is cleared by exactly the one agent
   * event that should clear it.
   */
  gaveUp: Set<string>;
  /** agentId -> epoch ms the agent entered its CURRENT ask, stamped on the first tick that sees one
   *  and cleared when it leaves. Its only job is to date a give-up: recording one used to require an
   *  OPEN EPISODE, and an unreadable capture deletes the episode — so the ordering `blank repaint,
   *  then decline` lost the give-up entirely. That is the MORE likely ordering for `unreachable`,
   *  because the screen states that make a capture unreadable (alternate-screen, pty-gone, a
   *  full-screen app owning the grid) are the same ones that produce it (roborev 62897). */
  askSince: Map<string, number>;
  /** agentId -> every prompt identity that has already opened an eligible episode for it. The
   *  never-twice rule, in its precise form.
   *
   *  KEYED BY AGENT, not one flat set behind a global FIFO. An agent under a churning identity mints
   *  a new burn per redraw, and a global eviction order let that one agent flush OTHER agents'
   *  legitimately-burned identities out of the budget — re-arming the hold for a prompt that had
   *  already failed once, on an agent that had done nothing wrong (roborev 62847, Medium). Capping
   *  per agent contains the blast radius to the agent that caused it. */
  burned: Map<string, Set<string>>;
  /** agentId → the most recent outcome an answerer reported, and when. */
  outcome: Map<string, { outcome: PromptAnswerOutcome; at: number }>;
}

export function emptyPromptGraceLedger(): PromptGraceLedger {
  return {
    episode: new Map(),
    holds: new Map(),
    gaveUp: new Set(),
    askSince: new Map(),
    burned: new Map(),
    outcome: new Map(),
  };
}

/**
 * The window's shared ledger.
 *
 * MODULE-LEVEL FOR THE REASON `movementRetraction.windowRetractionLedger` SPELLS OUT, which applies
 * here with one addition. Both feed builders (`Workspace`, which unmounts inside the readiness/auth
 * gates, and `useHelperVitalsPublisher`, which never does) must agree about which prompts are held,
 * or the island's count and the column's rows contradict each other. And the burn set is the ONLY
 * record that a prompt was already hidden once: losing it on an unmount re-arms the invisible loop
 * this module's headline rule exists to prevent.
 *
 * The other reason it cannot be per-component: the OUTCOMES are written from services
 * (`conciergeDispatch`, `suggestions/approvalsRuntime`) that hold no React context at all.
 *
 * The engine functions all take their ledger as a parameter; only React/service callers reach here.
 */
const WINDOW_LEDGER: PromptGraceLedger = emptyPromptGraceLedger();

export function windowPromptGraceLedger(): PromptGraceLedger {
  return WINDOW_LEDGER;
}

/** Clear the shared ledger. Tests only — a burn that survives a case silently decides the next one. */
export function resetPromptGraceLedgerForTests(): void {
  WINDOW_LEDGER.episode.clear();
  WINDOW_LEDGER.holds.clear();
  WINDOW_LEDGER.gaveUp.clear();
  WINDOW_LEDGER.askSince.clear();
  WINDOW_LEDGER.burned.clear();
  WINDOW_LEDGER.outcome.clear();
}

/**
 * Record what an automated answerer just did about `agentId`'s on-screen prompt.
 *
 * PER-AGENT, NOT PER-PROMPT-KEY, and that is deliberate. The answering paths hold an agent id and a
 * live screen; they do NOT hold the captured `attentionScreen` snapshot this module hashes, and
 * re-deriving the key at write time would let a one-line redraw between capture and answer file the
 * outcome under a key nothing is looking for — an outcome silently dropped, which reads as "the
 * answerer never reported" and costs the founder the full ceiling. The overlay instead compares the
 * outcome's timestamp against the episode's start, which needs no agreement about text.
 *
 * Defaulted `at` and `ledger` so a call site adds one argument, not four.
 */
export function notePromptAnswerOutcome(
  agentId: string,
  outcome: PromptAnswerOutcome,
  at: number = Date.now(),
  ledger: PromptGraceLedger = WINDOW_LEDGER,
): void {
  ledger.outcome.set(agentId, { outcome, at });
  // AND TELL SOMEONE. `declined` and `unreachable` are documented as surfacing IMMEDIATELY, but this
  // writes a plain Map that no React consumer can observe — so without this the prompt would stay
  // hidden until some unrelated input churned, or until the ceiling fired, which is the very
  // backstop these two outcomes exist to pre-empt (roborev 62851). Safe to fire synchronously
  // because every caller is a service — a promise arm or an event handler — never a render.
  if (ledger === WINDOW_LEDGER) notifyPromptGraceChanged();
}

type PromptGraceListener = () => void;
const graceListeners = new Set<PromptGraceListener>();

/**
 * Subscribe to outcome writes on the WINDOW ledger. Returns an unsubscribe.
 *
 * Deliberately NOT fired by {@link notePromptEpisodes}: that runs inside `buildConciergeFeed`, i.e.
 * inside a `useMemo` during render, and calling back into React state from there is the setState-
 * during-render hazard. Episode changes are already observable — they are caused by the status and
 * ask-screen maps a consumer re-renders on — so the only mutation that needs a channel of its own is
 * the one with no React input behind it.
 */
export function onPromptGraceChanged(cb: PromptGraceListener): () => void {
  graceListeners.add(cb);
  return () => {
    graceListeners.delete(cb);
  };
}

function notifyPromptGraceChanged(): void {
  // Copied before iterating: a listener that unsubscribes itself must not mutate the set mid-loop.
  for (const cb of [...graceListeners]) {
    try {
      cb();
    } catch {
      // A broken subscriber must not stop the others from learning that a prompt needs surfacing.
    }
  }
}

/** ADDITIONAL normalisation this module needs and `services/pickerFingerprint` does not.
 *
 *  The shared {@link steady} rule was written for a BOUNDED question block — `pickerFingerprint`
 *  locates the dialog first (`pickerBlockBounds`, `QUESTION_BLOCK_MAX_LINES`) precisely because "a
 *  fingerprint over hundreds of lines of live log output changes constantly". What arrives here is
 *  `runtimeStore.attentionScreen`, i.e. the WHOLE terminal grid — the dialog plus whatever Claude
 *  Code is rendering around it. So the same regexes are being applied to a much noisier input, and
 *  the spans that tick in that surrounding chrome are exactly the ones the picker's bounded block
 *  never had to care about: a bare elapsed-seconds readout (`esc to interrupt · 12s`) and token
 *  counters (`↑ 1.2k tokens`).
 *
 *  This is deliberate divergence, and only in the ADDITIVE direction: everything the shared rule
 *  neutralises is still neutralised, and this widens the set. Narrowing it would be the drift the
 *  shared module exists to prevent (roborev 62838, finding 3). */
const GRACE_EXTRA_VOLATILE = /\b\d+(?:\.\d+)?\s*s\b|\b\d+(?:\.\d+)?[kKmM]?\s*tokens?\b/g;

/** Hard cap on the material hashed, counted from the END of the grid. The question sits at the
 *  bottom; everything far above it is scrollback that moves on its own. A cap does NOT make the key
 *  stable on its own — that is what the hold BUDGET is for (see {@link PromptGraceLedger.holds}) —
 *  it just keeps the common case from churning on output the founder is not being asked about. */
const KEY_TAIL_LINES = 40;

/**
 * A stable identity for the question on screen.
 *
 * `""` means NO IDENTITY — an empty or whitespace-only capture. Returned as the sentinel rather than
 * a hash of nothing, because a hash of nothing is a global constant: every unreadable screen would
 * collide, one agent's burn would suppress another's, and "never twice" would silently mean "never
 * again, for anybody". Callers treat `""` as "not eligible", which errs toward showing the founder.
 *
 * A CHURNING KEY IS SURVIVABLE, and that is a deliberate property of the design rather than an
 * assumption that it cannot happen. A changed key re-opens the episode and restarts this question's
 * 30 seconds — which, on its own, means an unnormalised ticking span holds the prompt INDEFINITELY
 * (roborev 62838, High). What stops that is not a stabler hash: it is {@link
 * PromptGraceLedger.holds}, a per-agent budget of finitely many holds per {@link
 * HOLD_BUDGET_WINDOW_MS}, which no amount of churn can spend more than once. Forbidding the
 * restart instead was tried and was worse — it denied a genuinely NEW question its own window, and
 * back-to-back approvals are this module's primary case (roborev 62847, Medium).
 *
 * Not cryptographic. This distinguishes one question from another; nothing here is adversarial.
 */
export function promptEpisodeKey(screen: string): string {
  const lines = screen
    .replace(ANSI, "")
    .split("\n")
    .map((l) => steady(l).replace(GRACE_EXTRA_VOLATILE, "#").trim())
    .filter((l) => l !== "");
  const material = lines.slice(Math.max(0, lines.length - KEY_TAIL_LINES)).join("\n");
  if (material === "") return "";
  let h = 5381;
  for (let i = 0; i < material.length; i++) h = ((h * 33) ^ material.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** What the caller knows about the prompt drawn on an agent's screen. */
export interface PromptAsk {
  /** The captured screen text (runtimeStore.attentionScreen). */
  text: string;
  /** When that capture was written (runtimeStore.attentionScreenAt), if known. */
  at?: number;
}

/**
 * Open, continue, and close prompt episodes for the whole fleet. THE ONLY MUTATOR of `episode`,
 * `holds`, `gaveUp`, `askSince` and `burned`; the overlay below is pure. Call once per rebuild, BEFORE the overlay, from
 * the one place that holds the merged status — exactly as `noteRedEpochs` is called before
 * `withMovementRetraction`.
 *
 * ELIGIBILITY IS DECIDED HERE, ONCE PER EPISODE, and it takes BOTH gates: the identity must be
 * unburned for this agent (the precise never-twice rule) AND the agent must have hold budget left
 * (the rule that still holds when the identity is unstable). Spending the budget at episode-open
 * rather than at render is the same eager choice the burn makes, for the same reason: the only way
 * the two can disagree is a hold that never rendered, and the safe direction of that error is
 * showing the founder.
 *
 * `fleetIds` prunes: an agent that has left the fleet drops its episode, its holds and its burns, so
 * none of the three grows for the life of the window.
 */
export function notePromptEpisodes(
  ledger: PromptGraceLedger,
  statusMap: Record<string, AgentTabStatus>,
  askOf: (id: string) => PromptAsk | undefined,
  now: number,
  fleetIds: readonly string[],
): void {
  const live = new Set(fleetIds);
  for (const id of fleetIds) {
    const st = statusMap[id];
    // NOT OBSERVED IS NOT "NO LONGER ASKING" (roborev 62838, Medium). A fleet agent this consumer has
    // no entry for is one whose status has not ARRIVED yet — `useConciergeFeed` seeds its
    // cross-window roster with `null`, so every unhosted agent is momentarily absent from the map.
    // Closing the episode on that reads a gap in the evidence as a fact about the agent, and under
    // the SHARED window ledger it is worse than one wasted tick: the roster-lagging caller closes the
    // other caller's episode, the next tick re-opens it against an already-burned identity, and the
    // hold is permanently disabled for that question. `noteRedEpochs` splits maintenance (over the
    // status map) from pruning (over the fleet) for exactly this reason.
    if (st === undefined) continue;
    // Not at a drawn question → whatever episode was open is over. Dropping it is what lets the SAME
    // prompt, re-raised later, be recognised as a NEW episode (and refused by the burn set).
    if (!isDemonstratedAsk(st)) {
      ledger.episode.delete(id);
      // THE ONE EVENT THAT CLEARS A GIVE-UP. Deliberately not done in the no-identity branch below:
      // that is a screen event, and an unreadable repaint is not evidence the question was resolved.
      ledger.gaveUp.delete(id);
      ledger.askSince.delete(id);
      continue;
    }
    const ask = askOf(id);
    // RECORD A GIVE-UP AS SOON AS IT IS OBSERVED, before any early return below and before the
    // "same question, nothing to re-stamp" short-circuit. Doing it only at an episode OPEN missed
    // the ordinary case entirely: the outcome usually lands while the key is unchanged, so the open
    // path is not reached, and a later blank repaint then deleted the episode and took the only
    // evidence with it.
    //
    // THE SCOPE IS THE ASK, NOT THE EPISODE, and the guarantee that buys is exactly this: an outcome
    // that predates the agent ENTERING THIS ASK records nothing, because `askSince` is cleared when
    // it leaves. It is deliberately NOT "predates the current question" — `askSince` is stamped once
    // and never re-stamped while the ask continues, so within one ask an outcome for an earlier
    // question does latch the give-up for a later one. That is the safe direction (an answerer that
    // gave up on this ask has said something about the founder's involvement in it) and it is the
    // whole reason the episode comparison was removed (roborev 62897/62903).
    if (!ledger.askSince.has(id)) ledger.askSince.set(id, ask?.at ?? now);
    const askedAt = ledger.askSince.get(id)!;
    const seen = ledger.outcome.get(id);
    // Dated against the ASK, not against an open episode. An episode is deleted by an unreadable
    // capture, so requiring one lost every give-up that arrived while the screen was unreadable —
    // which is exactly when `unreachable` happens (roborev 62897).
    // `isGiveUp`, NOT `!== "handled"`. Rule 2 of the header is about the answerer handing the
    // question to the FOUNDER, and only `declined`/`unreachable` say that. Spelled as the negation
    // of `handled`, this line swept `escalated` in as well — latching a give-up for the rest of the
    // ask on the one outcome that means somebody else is still working on it, so the next redraw
    // force-surfaced a prompt the concierge had not been given its window to answer.
    if (seen && seen.at >= askedAt && isGiveUp(seen.outcome)) ledger.gaveUp.add(id);
    const key = ask ? promptEpisodeKey(ask.text) : "";
    // No readable question, so no identity. "Never twice" cannot be honoured without one, so do not
    // hold at all — the direction of that error is showing the founder.
    if (key === "") {
      ledger.episode.delete(id);
      continue;
    }
    const prev = ledger.episode.get(id);
    if (prev && prev.key === key) continue; // same question, still open — nothing to re-stamp
    // A NEW QUESTION, or the same one re-rendered past the normalisers — and NOTHING IN THE TEXT CAN
    // TELL THOSE APART. What can is the OUTCOME of the episode this one is replacing:
    //
    //   • answered (`handled`) → the previous question is gone, so this is genuinely the next one.
    //     A burst of routine prompts (`git status` → `ls` → `cargo check` → `gh pr view`) is exactly
    //     this shape, and it is the shape the whole feature exists for.
    //   • escalated (`escalated`) → an answerer read it and passed it on. Counted WITH `handled`
    //     below, for the reason given at `engagedPrev`.
    //   • gave up (`declined` / `unreachable`) → the previous question is STILL ON SCREEN, unanswered.
    //     Anything appearing now is overwhelmingly that same question redrawn.
    //   • nothing reported → no evidence either way.
    //
    // Both comparisons are scoped to the previous episode's own window, so a stale outcome from an
    // earlier ask decides nothing. `prev === undefined` means the agent left the ask entirely, which
    // resets all of this — a genuinely re-raised prompt is refused by the burn set, not by these.
    const rec = ledger.outcome.get(id);
    const decided = prev !== undefined && rec !== undefined && rec.at >= prev.startedAt;
    // WHICH CAP AN `escalated` PREVIOUS QUESTION EARNS — the generous one, WITH `handled`. The cap
    // is chosen by how much evidence stands behind the re-open, and the two outcomes carry the same
    // evidence: an answerer looked at the previous question and disposed of it, so a different
    // question appearing now is probably genuinely the next one rather than the old one redrawn.
    // That is the whole distinction the tight cap exists to draw — it is `nothing was reported`
    // that makes a re-open indistinguishable from a redraw, and an escalation is a report.
    //
    // Reading it the other way was tempting (an escalated question is not GONE, so the next draw
    // could be it re-rendering) but it prices the same fact twice and gets the worse failure: the
    // agent whose prompts are being escalated is by construction the one whose prompts are hard,
    // so it would take the tight cap exactly when the concierge is doing the most work, and its
    // NEXT question — a genuinely new one — would go straight to the founder while the previous
    // escalation is still in flight. The safety property does not depend on this choice either
    // way: every hold is charged against the same count, and both caps are finite, so an escalated
    // agent can no more buy an unbounded run of holds than a `handled` one can (roborev 62886).
    //
    // SPELLED AS A POSITIVE LIST, not as `!isGiveUp(rec!.outcome)`, even though the two agree over
    // today's four arms: the negation hands the GENEROUS cap to any fifth outcome by default, and
    // the direction of that error is more hiding. Each member is covered by its own case in
    // `blockedPromptGrace.escalated.test.ts` — drop either arm and a test goes red — but note that
    // `mutation-check --line` cannot show that here: it swaps BOTH `===` at once, which yields
    // `!== "handled" || !== "escalated"`, a tautology, and a tautology is unobservable because the
    // only outcomes it newly admits (`declined`/`unreachable`) have already set the `gaveUp` latch
    // above, which makes `eligible` false whatever the cap says. It reports that line uncaught.
    const engagedPrev = decided && (rec!.outcome === "handled" || rec!.outcome === "escalated");
    // Sticky for the ask, recorded on the LEDGER so no screen event can erase it. See
    // `PromptGraceLedger.gaveUp`.
    const gaveUp = ledger.gaveUp.has(id);
    const burns = ledger.burned.get(id) ?? new Set<string>();
    const recent = (ledger.holds.get(id) ?? []).filter((t) => now - t < HOLD_BUDGET_WINDOW_MS);
    // GAVE UP → NEVER HOLD. Rule 2 of this module's header says declining surfaces the prompt
    // immediately, and without this that guarantee lasted only until the next redraw: the episode
    // re-opened, `startedAt` moved past the outcome, the decline was ignored and the question went
    // back into hiding for another window (roborev 62856). Erring toward showing the founder.
    // TWO CAPS, NOT A BYPASS. An open that follows a reported `handled` gets the generous ceiling
    // because it is probably a genuinely new question; an open with nothing behind it gets the tight
    // one. But `handled` is WEAKER EVIDENCE than "the question is gone" — `answerOutcomeForPath` maps
    // `queued` to it, and the auto-approver reports it when the write RESOLVES, i.e. the bytes were
    // sent, not that the picker accepted them. So an agent stuck in a retry loop, drawing a slightly
    // different prompt each cycle so the burn set never matches, must not be able to buy an unlimited
    // string of holds off a stream of `handled`s: that is the invisible loop the budget exists to
    // make impossible (roborev 62886). Every hold is charged; only the ceiling differs.
    const cap = engagedPrev ? MAX_ANSWERED_HOLDS_PER_WINDOW : MAX_HOLDS_PER_WINDOW;
    const eligible = !burns.has(key) && !gaveUp && recent.length < cap;
    ledger.episode.set(id, { key, startedAt: ask?.at ?? now, eligible });
    if (eligible) {
      recent.push(now);
      burns.add(key);
      // Per-agent FIFO. A Set preserves insertion order, so its first value IS the oldest burn.
      while (burns.size > BURN_PER_AGENT) {
        const oldest = burns.values().next();
        if (oldest.done) break;
        burns.delete(oldest.value);
      }
      ledger.burned.set(id, burns);
    }
    // Written back even when nothing was pushed, so the rolling window's expired entries are dropped
    // rather than accumulating for the life of the window.
    ledger.holds.set(id, recent);
  }
  for (const id of [...ledger.episode.keys()]) if (!live.has(id)) ledger.episode.delete(id);
  for (const id of [...ledger.holds.keys()]) if (!live.has(id)) ledger.holds.delete(id);
  for (const id of [...ledger.gaveUp]) if (!live.has(id)) ledger.gaveUp.delete(id);
  for (const id of [...ledger.askSince.keys()]) if (!live.has(id)) ledger.askSince.delete(id);
  for (const id of [...ledger.outcome.keys()]) if (!live.has(id)) ledger.outcome.delete(id);
  for (const id of [...ledger.burned.keys()]) if (!live.has(id)) ledger.burned.delete(id);
}

/**
 * How long THIS episode may be held — the per-agent ceiling, in ms from {@link PromptEpisode.startedAt}.
 *
 * THE SINGLE ANSWER BOTH CLOCKS READ, for the same reason {@link isHeld} is the single predicate
 * both the overlay and the expiry read: `isHeld` decides WHETHER the row is calm and
 * {@link nextPromptGraceExpiry} decides WHEN something will wake up and re-ask. If those two
 * disagree about the number, the disagreement is not a cosmetic drift — it is a hold with no ceiling
 * behind it. Hardcoding `BLOCKED_PROMPT_GRACE_MS` in the expiry while `isHeld` honoured four minutes
 * would arm the wake-up at thirty seconds, find the prompt still held when it fired, and then have
 * nothing left to arm: no status write, no outcome, no event ever follows a wedged concierge, so the
 * memo's inputs never change again and the question stays calm FOREVER. That is strictly worse than
 * having no escalation arm at all.
 *
 * TWO BOUNDS ON WHEN AN ESCALATION MAY EXTEND ANYTHING, and both err toward showing the founder:
 *
 *   • It must not PREDATE the episode — same scoping as `isHeld`'s outcome test, or an escalation
 *     filed about an earlier question would silently buy four minutes for a later one.
 *   • It must arrive while the prompt is still INSIDE the ordinary thirty, i.e. while it is still
 *     actually held. Past that the row is already in the founder's list and he may already be
 *     reading it, and extending the ceiling then does not delay a surfacing — it RETRACTS one that
 *     already happened, taking a red back out of the band he was looking at. This module exists to
 *     remove that flicker, not to add a four-minute version of it. An escalation that late has
 *     missed its window: the concierge is welcome to answer anyway, and the founder simply sees the
 *     question in the meantime, which is the safe half of the trade.
 */
function holdCeilingMs(ledger: PromptGraceLedger, id: string, ep: PromptEpisode): number {
  const rec = ledger.outcome.get(id);
  if (!rec || rec.outcome !== "escalated") return BLOCKED_PROMPT_GRACE_MS;
  const sinceDraw = rec.at - ep.startedAt;
  if (sinceDraw < 0 || sinceDraw >= BLOCKED_PROMPT_GRACE_MS) return BLOCKED_PROMPT_GRACE_MS;
  return CONCIERGE_ESCALATION_GRACE_MS;
}

/** Is this agent's drawn prompt currently held back from the founder? The single predicate both the
 *  overlay and the expiry clock read, so they cannot disagree about who is being held. */
function isHeld(ledger: PromptGraceLedger, id: string, now: number): boolean {
  const ep = ledger.episode.get(id);
  if (!ep || !ep.eligible) return false;
  // A GIVE-UP IS A LATCH, not a value that can be overwritten. `outcome` is keyed per agent and
  // latest-wins, and the dispatcher reports on EVERY send — an ordinary free-text message, a queued
  // send flushing, a recovery ping — all of which classify `handled`. So a later, unrelated
  // `handled` did not merely fail to end the hold: it erased a `declined`/`unreachable` that had
  // already ended it and put the row back into hiding until the ceiling, on an event that said
  // nothing about the prompt (roborev 62848). `flushPendingSends` makes that ordinary rather than
  // exotic — it emits `expired` first and delivered second, so one flush overwrites its own
  // `unreachable` with a `handled` for a different entry.
  if (ledger.gaveUp.has(id)) return false;
  const since = ep.startedAt;
  const rec = ledger.outcome.get(id);
  // An outcome from BEFORE this ask began describes a different prompt — ignore it, or one agent's
  // earlier failure would permanently disqualify every later prompt it draws.
  //
  // `isGiveUp`, NOT `!== "handled"`: only `declined`/`unreachable` end the hold. `escalated` keeps
  // it — nothing was typed, so the red will not clear on its own, and surfacing it now would spend
  // the founder interrupt the escalation exists to avoid — and pays for that by moving the CEILING
  // instead, which `holdCeilingMs` supplies below. Keeping the hold without moving the ceiling would
  // be the worst of both: the concierge cannot answer inside thirty seconds, so the prompt would
  // surface anyway, just fractionally later and having burned the escalation.
  if (rec && rec.at >= since && isGiveUp(rec.outcome)) return false;
  return now - since < holdCeilingMs(ledger, id, ep);
}

/**
 * De-escalate every drawn prompt that is still inside its grace window.
 *
 * COMPOSE EARLY, against the agents' OWN statuses and BEFORE the worker-attention bubbles — the same
 * placement, and the same reason, as `withMovementRetraction`. A held prompt that is allowed to
 * bubble first has already been copied onto its orchestrator, and de-escalating only the worker
 * afterwards leaves the parent wearing a red whose owner is calm: a needs-you row naming an agent
 * that is not asking, which is precisely what this is trying to remove.
 *
 * Returns the SAME reference when nothing is held; never mutates the input.
 */
export function withBlockedPromptGrace<T extends { id: string }>(
  agents: readonly T[],
  statusMap: Record<string, AgentTabStatus>,
  ledger: PromptGraceLedger,
  now: number = Date.now(),
): Record<string, AgentTabStatus> {
  let out: Record<string, AgentTabStatus> | null = null;
  for (const a of agents) {
    const st = statusMap[a.id];
    if (!isDemonstratedAsk(st)) continue;
    if (!isHeld(ledger, a.id, now)) continue;
    (out ??= { ...statusMap })[a.id] = deEscalatedStatus(st as RedStatus);
  }
  return out ?? statusMap;
}

/**
 * When the next held prompt is due to surface, or null if nothing is being held.
 *
 * THE CEILING NEEDS SOMETHING TO WAKE IT, and here that is not a nicety — it is the difference
 * between a ceiling and a promise. `now` arrives as an argument, so the overlay is only recomputed
 * when its caller re-renders; a prompt whose answerer died emits no status write, no outcome and no
 * further event, so nothing would ever change the memo's inputs again and the row would sit calm
 * forever. That is the exact failure `hooks/useNewAgentCalm` was written to fix for the `new`
 * window, and it is worse here, because the thing being hidden is a question waiting on the founder.
 */
export function nextPromptGraceExpiry<T extends { id: string }>(
  agents: readonly T[],
  ledger: PromptGraceLedger,
  now: number = Date.now(),
): number | null {
  let soonest: number | null = null;
  for (const a of agents) {
    // NO STATUS RE-TEST HERE (roborev 62851, Medium). The episodes were opened against the feed's
    // MERGED map — this window's own statuses plus the cross-window roster — and a caller that has
    // only the local map would silently skip every agent another window is running: held by the
    // feed, with no ceiling armed, which is the same "hidden indefinitely" end state. `isHeld` is
    // the shared predicate and an open episode is already proof of a demonstrated ask, since
    // `notePromptEpisodes` deletes the episode for anything that is not one. A second check could
    // therefore only ever DISAGREE with the first.
    if (!isHeld(ledger, a.id, now)) continue;
    // PER AGENT, via the SAME helper `isHeld` measures against — four minutes for an escalated
    // prompt, thirty seconds for everything else. A hardcoded `BLOCKED_PROMPT_GRACE_MS` here is not
    // a wake-up that fires early; it is a wake-up that fires, finds the prompt still held, and then
    // never fires again, because nothing else will ever change this memo's inputs. See
    // `holdCeilingMs` and the doc above.
    const ep = ledger.episode.get(a.id)!;
    const at = ep.startedAt + holdCeilingMs(ledger, a.id, ep);
    if (at > now && (soonest === null || at < soonest)) soonest = at;
  }
  return soonest;
}
