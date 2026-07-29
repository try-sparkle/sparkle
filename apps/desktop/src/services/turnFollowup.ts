// Followup judge (tune-coloring): decide whether a FINISHED Claude turn is actually blocked on the
// user — an end-of-turn ask like "Want me to land it now?" or "is this ready for you to review?" —
// versus genuinely done (a plain completion report) or merely offering optional/new work. A turn
// that's blocked on the user should read RED ("needs you"), not gray.
//
// Background: the hook migration (hookEvents.ts) deliberately killed PROSE-based red, because the
// naive heuristic ("the message has a question mark → red") fired constantly on rhetorical asides
// and optional follow-on offers (false red). We re-introduce prose-based red here, but gated by a
// cheap model JUDGE that reads the actual turn + the task, so only a genuine "blocked on you to
// finish THIS work" goes red. That's the whole difference from the old false-red bug.
//
// Hybrid, to keep it ~free: a pure LOCAL fast-path first skips the obvious "Done." turns with no
// question/proposal at all (no model call), and the Haiku judge runs only on the ambiguous
// remainder. The judge is a PRECISION filter over the fast-path.
//
// Provider health is recorded here too — `noteAiProviderFailure`/`noteAiProviderHealthy`, the same
// chokepoint helpers `chatOnce` uses — so ProviderUnavailableBanner can NAME the outage. That is a
// separate question from this function's verdict, and deliberately so: the banner says "Sparkle's AI
// provider is down", while the return value says what this turn means. Letting the second borrow the
// first's certainty is exactly the bug below.
//
// WHEN THE JUDGE CANNOT RUN, THIS MODULE RETURNS `unknown` — it does not answer anyway. That is the
// whole contract, and it is worth stating twice because the code has been wrong in BOTH directions:
// failing open to gray silently killed red-on-prose for every keyless user (sparkle-blpf), and the
// fix for that — failing closed to red on a strong local phrase — turned a dead AI backend into a
// fleet-wide false-alarm storm on 2026-07-28. Neither guess is defensible: a status is a claim about
// the agent, and an unavailable judge has no claim to make. Callers decide what to do with `unknown`;
// what they must not do is paint it red. See `FollowupOutcome`.
import { invoke } from "@tauri-apps/api/core";
// The picker detector, NOT a second copy of one. This is the same `detectTerminalPrompts` behind
// `conciergeDispatch.liveOptionsFor`, whose `options.length > 0` is exactly the condition that
// refuses a terminal write with `ambiguous-picker` ("the agent has a prompt on screen"). One
// subsystem already knowing a picker is up while the status system says green is the bug below;
// two detectors that could disagree later would be the same bug with extra steps.
import { detectTerminalPrompts } from "./suggestions/heuristics";
import {
  noteAiProviderFailure,
  noteAiProviderHealthy,
  noteAiServiceFailure,
  noteAiServiceHealthy,
} from "./anthropic";
import { log } from "../logger";

// Only the TAIL of a turn carries the ask — agents put "Want me to…?" in the last line(s), after a
// long body of what they did. Scanning the tail keeps a '?' buried in the middle of a report (a
// rhetorical aside, a quoted question) from forcing a judge call on every turn. Generous enough to
// catch a multi-line closing ("Two heads-ups… Say the word and I'll land it.").
const TAIL_CHARS = 600;

// Proposal/hand-back phrases that signal an ask even without a '?'. Lowercased substring match on
// the tail. Deliberately small and HIGH-SIGNAL — the judge makes the real call; this only decides
// whether it's worth asking. We intentionally EXCLUDE generic courtesies that pepper plain
// completion reports ("let me know if you'd like anything else", "your call", "up to you", "lmk"):
// they overwhelmingly appear in DONE turns, so including them would bill a judge call on a large
// fraction of finished work and undercut the local fast-path's "~free" purpose. A real ask that
// uses only such a courtesy and no '?' simply skips to gray (the prior behavior) — never a false
// red. The phrases kept here are the ones that specifically request action on THIS work.
const PROPOSAL_PHRASES = [
  "want me to",
  "should i ",
  "shall i ",
  "do you want",
  "would you like me",
  "ready for you",
  "say the word",
  "if you'd rather",
  "go-ahead",
  "go ahead and tell me",
];

// "I'm waiting on you to run the test" is a genuine ask too — but the bare substring ALSO matches
// the OPPOSITE, benign phrasing that closes an idle status recap: "nothing is waiting on you",
// "no findings waiting on you" (the real screenshot-1 tail). Matching that as an ask is exactly the
// false-red the user reported. So the waiting-family counts as a real ask only when it is a genuine,
// un-negated hand-back. We judge the SENTENCE that contains the CLOSING waiting phrase (the ask, if
// any, is the last one) rather than the whole message, so a genuine "I'm waiting…" earlier in the
// turn can't rescue a benign "nothing is waiting on you" that actually closes it, and vice-versa
// (roborev jobs 44337, 44374).
//   - WAITING_RE / WAITING_GLOBAL_RE — locate the phrase (the last occurrence is the closeout).
//   - GENUINE_WAITING_RE — a first-person subject IMMEDIATELY governs "waiting" ("I'm waiting on
//     you", "we are waiting on you", "I'm still waiting on you"): a real ask. Immediate governance
//     is the point — "I'm glad nothing is waiting on you" must NOT match, because there "I'm" heads
//     "glad", not "waiting". Only an optional copula and a few adverbs may sit between subject and
//     verb.
//   - NEGATED_WAITING_RE — a negator governs "waiting" within the sentence ("nothing is waiting on
//     you", "no findings waiting on you", "nothing still waiting on you"): the benign recap close.
const WAITING_RE = /waiting (?:on|for) (?:you|your)\b/;
const WAITING_GLOBAL_RE = /waiting (?:on|for) (?:you|your)\b/g;
const GENUINE_WAITING_RE =
  /\b(?:i|im|we)\b(?:['’]m|['’]re|['’]ve| am| are)?(?: (?:just|still|currently|now|already|been))* waiting (?:on|for) (?:you|your)\b/;
const NEGATED_WAITING_RE =
  /\b(?:no|nothing|none|nobody|not|never|\w+n['’]t)\b[^.?!\n]*?waiting (?:on|for) (?:you|your)\b/;

/**
 * The sentence (bounded by . ? ! newline, or the string ends) that contains the LAST "waiting on/for
 * you" phrase, lowercased input. Null when the phrase is absent. Only the closing occurrence matters:
 * it's the hand-back, and judging just its sentence keeps a genuine earlier "I'm waiting…" from
 * bleeding onto a benign closeout (and vice-versa).
 */
function lastWaitingSentence(whole: string): string | null {
  let last = -1;
  for (let m = WAITING_GLOBAL_RE.exec(whole); m; m = WAITING_GLOBAL_RE.exec(whole)) last = m.index;
  WAITING_GLOBAL_RE.lastIndex = 0;
  if (last < 0) return null;
  const start = Math.max(
    whole.lastIndexOf(".", last),
    whole.lastIndexOf("?", last),
    whole.lastIndexOf("!", last),
    whole.lastIndexOf("\n", last),
  );
  const ends = [
    whole.indexOf(".", last),
    whole.indexOf("?", last),
    whole.indexOf("!", last),
    whole.indexOf("\n", last),
  ].filter((i) => i >= 0);
  const end = ends.length ? Math.min(...ends) : whole.length;
  return whole.slice(start + 1, end);
}

/**
 * True when the turn carries a concrete request to act on THIS work (a STRONG signal). `tail` is the
 * closeout window; `whole` is the full lowercased message. The waiting phrase must close the turn (be
 * in the tail), but its subject is judged on the sentence that actually contains the closing phrase.
 */
function hasStrongProposal(tail: string, whole: string): boolean {
  if (PROPOSAL_PHRASES.some((p) => tail.includes(p))) return true;
  if (!WAITING_RE.test(tail)) return false;
  const sentence = lastWaitingSentence(whole);
  if (sentence === null) return false;
  // A first-person subject immediately governing "waiting" is a genuine ask; otherwise a negated
  // "nothing/no … waiting on you" is the benign recap close.
  if (GENUINE_WAITING_RE.test(sentence)) return true;
  return !NEGATED_WAITING_RE.test(sentence);
}

// High-signal "the next step is GATED on you" phrases — the agent has explicitly parked the work
// behind your sign-off, confirmation, or approval. Unlike PROPOSAL_PHRASES these are scanned over
// the WHOLE message, not just the tail (tune-coloring): a long, genuinely-blocked turn routinely
// buries the ask ("…present it in sections for your sign-off." / "Once you confirm, I'll lay out
// the rest…") ABOVE a forward-looking tail that enumerates the work still to come — pushing both
// the ask and its '?' out of the TAIL_CHARS window, so the tail scan misses it and the turn wrongly
// stays gray. (Real screenshot: a design handed back "for your sign-off" with the question above a
// ~450-char "Once you confirm…" tail read gray instead of red.) These phrases carry almost no
// false-positive risk in a plain completion report — a DONE turn doesn't say "for your sign-off" —
// so a whole-message match is safe even on the keyless fail-closed-to-red path.
const GATING_PHRASES = [
  "your sign-off",
  "your signoff",
  "for sign-off",
  "for signoff",
  "for your approval",
  "pending your",
  "once you confirm",
  "once you've confirmed",
  "once you sign off",
  "once you've signed off",
  "once you approve",
  "once you've approved",
];

/**
 * Strength of the local fast-path signal that a finished turn is blocked on the user. This is the
 * FLOOR the judge escalates from — and, when the judge can't run, the verdict we fall back to.
 *   - "strong": a concrete gate on the user — either a whole-message GATING phrase (your sign-off /
 *     confirm / approve) or a PROPOSAL/hand-back phrase in the tail ("want me to land it?"). A real
 *     staged ask; it must stay RED even keyless (sparkle-blpf).
 *   - "weak": the ONLY signal is a bare trailing '?' with NO proposal/gating phrase. This is the
 *     shape of an open-ended "what would you like to pick up next?" status-recap close — plausibly an
 *     ask (worth a judge call), but NOT strong enough to FORCE red on its own. Without a judge it
 *     falls OPEN to gray, killing the false-red the user saw on idle recap turns.
 *   - "none": a plain completion report — no ask at all, no judge call.
 * Pure + exported for testing.
 */
export type FollowupSignal = "none" | "weak" | "strong";

export function classifyFollowupSignal(response: string): FollowupSignal {
  const text = response.trim();
  if (!text) return "none";
  const lower = text.toLowerCase();
  // Whole-message scan first: a high-signal "gated on your sign-off/confirm/approve" phrase can
  // sit far above the tail in a long, blocked turn, so it must NOT be limited to TAIL_CHARS.
  if (GATING_PHRASES.some((p) => lower.includes(p))) return "strong";
  const tail = lower.slice(-TAIL_CHARS);
  // A concrete action-proposal / hand-back in the tail is a strong ask — checked BEFORE the bare '?'
  // so "want me to land it?" reads strong, not weak, even though it also ends in a question mark.
  if (hasStrongProposal(tail, lower)) return "strong";
  // A closing '?' with no proposal/gating phrase: weak. Worth a judge call, but on its own (keyless)
  // it must not manufacture a red on an open-ended "what next?" recap.
  if (tail.includes("?")) return "weak";
  return "none";
}

/**
 * LOCAL fast-path: could this finished turn plausibly be blocked on the user — i.e. is it worth a
 * judge call? True when the tail contains a question mark OR a proposal/hand-back phrase (any
 * non-"none" signal). False for a plain completion report (no model call, definitely gray). Pure +
 * exported for testing.
 *
 * Bias is intentionally toward TRUE (consult the judge) on anything question-like: a false TRUE
 * only costs one cheap Haiku call that then returns DONE; a false FALSE would silently miss a real
 * ask. The judge is the precise gate; this is just the cheap pre-filter.
 */
export function mightNeedFollowup(response: string): boolean {
  return classifyFollowupSignal(response) !== "none";
}

/**
 * Interpret the judge's raw verdict text into a boolean "needs followup". The prompt asks for
 * exactly FOLLOWUP or DONE (and FOLLOWUP when unsure), but we match leniently so a chatty reply
 * still resolves. DONE takes PRECEDENCE: an explicit DONE wins even if the word "followup" also
 * appears ("Not a followup — DONE"), so an incidental mention can't manufacture a false red. Only a
 * reply that mentions FOLLOWUP and does NOT mention DONE is a followup; everything else (an explicit
 * DONE, or an empty/garbled reply) is treated as done. Pure + exported for testing.
 */
export function interpretVerdict(raw: string): boolean {
  const v = raw.trim().toUpperCase();
  if (!v) return false;
  if (v.includes("DONE")) return false; // explicit DONE always wins — never a false red
  return v.includes("FOLLOWUP");
}

/** What a followup judgement can conclude. Three states, not two, because "the judge said this turn
 *  is done" and "the judge never ran" are different facts and only one of them may drive a status.
 *
 *  - `followup` — a judge RAN and said the turn is blocked on the user. The only outcome that reds.
 *  - `done`     — a real decision that nothing is blocked: either the local fast-path found no ask at
 *                 all, or a judge ran and said DONE. Both are conclusions, which is what matters.
 *  - `unknown`  — the judge could not run. NO conclusion exists. Callers must not colour a row from
 *                 it; `signal` carries how ask-like the text looked, for explanation and logging only.
 *
 *  There is deliberately no "did the model run" boolean alongside this. The only question any caller
 *  has is "is there a conclusion, and what is it", and a second flag that answers something subtly
 *  different is how `blocked` came to mean two things at once. */
export type FollowupOutcome =
  | { verdict: "followup" }
  | { verdict: "done" }
  | { verdict: "unknown"; signal: FollowupSignal };

/**
 * Is a picker/menu live on `screen` right now — a numbered option list, a Claude Code permission or
 * AskUserQuestion dialog, a shell `(y/n)`?
 *
 * This exists because everything else in this module reads turn-end ENGLISH, and English is only
 * available once a turn has FINISHED. An on-screen picker is not a finished turn: the agent is
 * mid-turn, rendering a menu into the PTY and waiting. So `mightNeedFollowup` never fired,
 * `judgeNeedsFollowup` never ran, and the agent kept whatever running state it had — GREEN, for as
 * long as the user left the menu unanswered. Reported live against agent "Kill BYOK Anthropic Key".
 *
 * A menu on screen is not a judgment call. There is no prose to weigh, no "is this rhetorical?",
 * no model: the terminal is literally blocked until someone picks an option, so this short-circuits
 * the whole prose pipeline to RED. That also means it does not inherit the judge's failure modes —
 * with no API key (the norm) the judge cannot run at all, and a picker must go red regardless.
 *
 * Undefined/blank screen → false. Nothing on screen is not evidence of a question; the callers that
 * have no live terminal (an unmounted pane) must fall through to the prose path, not to red.
 */
/* NOTE (roborev 54774): NO PRODUCTION CALLER SUPPLIES `screen` TODAY. The one that did — AgentPane's
 * Stop-hook path — was unwired because it fed scrollback HISTORY, which reads an already-answered
 * dialog as a live picker and pins the row red for the whole idle period. This predicate itself is
 * correct and tested; it is kept, rather than deleted and re-added, because the tracked fix
 * (escalate mid-turn inside statusRouter.resolve, sourced from the VIEWPORT reader) re-uses exactly
 * this function. Until then `args.screen` is always undefined and the short-circuit below is inert —
 * which is safe by construction, since a blank/undefined screen returns false. */
export function screenShowsPicker(screen: string | undefined): boolean {
  if (!screen?.trim()) return false;
  return detectTerminalPrompts(screen).length > 0;
}

/**
 * Decide whether a finished turn is blocked on the user. Runs the local fast-path, then (only if it
 * might be an ask) the Haiku judge with the agent's task as context for "the work at hand".
 *
 * A live picker on `screen` pre-empts all of that (see screenShowsPicker) — it is terminal STATE, an
 * unambiguous "blocked on you", so it short-circuits to `followup` with no prose heuristic, no judge
 * call, no model. (No production caller supplies `screen` today — see screenShowsPicker's roborev-54774
 * note — but the capability is kept and tested for the tracked viewport-based fix.)
 *
 * DEGRADES HONESTLY. Otherwise we reach the judge only because `mightNeedFollowup` already matched —
 * the tail had a '?' or a proposal/hand-back phrase — so this turn *looks* blocked on the user. Three
 * outcomes, deliberately distinct:
 *   - the judge RAN and said DONE  → `done`. A real verdict overrides the fast-path's bias-toward-ask.
 *   - the judge RAN and said FOLLOWUP → `followup`. The one path that may paint a row red.
 *   - the judge COULD NOT RUN (backend down, out of credits, signed out, offline) → `unknown`. We
 *     have no verdict, so we assert none. Guessing here is what turned a dead AI backend into a
 *     fleet-wide false-alarm storm; see the catch block for the incident.
 *
 * @param task     What the agent was asked to do (its naming basis / name) — lets the judge tell a
 *                 closeout ask (land/verify THIS work → red) from an offer of new work (gray).
 * @param response The finished turn's last assistant message (already read for history capture).
 * @param project  Metering-only: the project this agent belongs to, so the judge's credit debit is
 *                 attributable in the Credits history. Omitted → the row carries no project.
 * @param screen   The agent's CURRENT terminal text, if the caller can read one. A picker on it is
 *                 an unambiguous "blocked on you" and short-circuits to `followup`.
 */
export async function judgeNeedsFollowup(args: {
  task: string;
  response: string;
  project?: string;
  screen?: string;
}): Promise<FollowupOutcome> {
  // A menu on screen outranks everything below it — including the judge, which never gets asked.
  // See screenShowsPicker: this is terminal STATE, not turn-end English, so there is nothing for a
  // model to weigh and nothing to fall back to when it can't run. A picker is an unambiguous
  // "blocked on you", so it resolves straight to `followup`.
  if (screenShowsPicker(args.screen)) return { verdict: "followup" };
  if (!mightNeedFollowup(args.response)) return { verdict: "done" };
  // Scope the try to ONLY the judge call, so the catch strictly means "the judge could not run"
  // (never a genuine verdict re-interpreted as an availability failure).
  let raw: string;
  try {
    raw = await invoke<string>("judge_turn_followup", {
      task: args.task,
      response: args.response,
      project: args.project,
    });
  // Every proxied AI wrapper reports what it learned about Sparkle's provider account — there is
  // no single JS chokepoint (each command has its own wrapper), so a wrapper that skips this both
  // hides a live outage and, worse, leaves a false one on screen after recovery (roborev 54761).
    noteAiProviderHealthy();
    noteAiServiceHealthy();
  } catch (e) {
    // Record the provider-health observation FIRST (stores/aiProviderStore, via the shared
    // chokepoint helper) so ProviderUnavailableBanner can name the cause, then answer honestly
    // below. Two different questions: "is Sparkle's AI provider usable" and "what is this turn's
    // verdict". The banner owns the first; this function must not let it colour the second.
    noteAiProviderFailure(e);
    noteAiServiceFailure(e);
    // THE JUDGE COULD NOT RUN — no verdict exists, so we report exactly that and let the caller
    // decide. What we must NOT do is answer the question anyway.
    //
    // This used to return `classifyFollowupSignal(...) === "strong"`, i.e. a confident RED whenever
    // the tail carried a phrase like "want me to", "should i", "ready for you" or "once you confirm"
    // (sparkle-blpf, which was reasoning about a user who had simply never configured a key). The
    // failure mode that reasoning missed is a backend that dies UNDER A WHOLE FLEET: from 2026-07-28
    // 16:48 the AI proxy returned 502 for 99.3% of calls, so the judge stopped running everywhere at
    // once and that fallback became the ONLY verdict any agent got. Agents end turns with "Want me
    // to open the PR?" constantly, so effectively every finished turn was paged to the human as red
    // — and it oscillated, because statusRouter drops the verdict on the next screen `working` or
    // non-idle hook and the next Stop re-asserts it (red → clear → red with no user action).
    //
    // The local phrase match is a PRE-FILTER for "is this worth a model call", not a verdict. Its
    // strength is retained on the outcome so a caller can surface "there may be an ask here, and it
    // could not be judged" — but as UNKNOWN, never as a confident alarm. This holds whichever
    // backend the judge is pointed at, which is the property the coming BYOK→subscription move needs.
    // Feed the app-wide degraded indicator. The judge is often the FIRST AI call to fail after a
    // backend dies (it runs on every finished turn), so it is the earliest honest witness there is.
    log.warn("turn-followup", "judge unavailable — reporting UNKNOWN, not a red", {
      signal: classifyFollowupSignal(args.response),
      error: e instanceof Error ? e.message : String(e),
    });
    return { verdict: "unknown", signal: classifyFollowupSignal(args.response) };
  }
  // The judge RAN — trust its verdict. A real DONE pulls the ambiguous turn back to gray.
  return { verdict: interpretVerdict(raw) ? "followup" : "done" };
}
