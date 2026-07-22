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
// remainder. The judge is a PRECISION filter over the fast-path, not a gate that can silently fail
// open: when it can't run (no API key — the norm without a BYOK key —, offline, model hiccup) we
// FALL BACK to the fast-path's own verdict (→ `waiting`) rather than swallow a real ask to gray
// (sparkle-blpf). Only a judge that actually RAN and said DONE pulls an ambiguous turn back to gray.
import { invoke } from "@tauri-apps/api/core";

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

/**
 * Decide whether a finished turn is blocked on the user. Runs the local fast-path, then (only if it
 * might be an ask) the Haiku judge with the agent's task as context for "the work at hand".
 *
 * FAILS CLOSED (sparkle-blpf): the deterministic fast-path is the floor, not the judge. We reach the
 * judge only because `mightNeedFollowup` already matched — the tail had a '?' or a proposal/hand-back
 * phrase — so this turn *looks* blocked on the user. We must distinguish two outcomes the old code
 * conflated:
 *   - the judge RAN and said DONE  → trust it, return false (gray). A real verdict overrides the
 *     fast-path's bias-toward-ask.
 *   - the judge COULD NOT RUN (no API key — the case for every user without a BYOK key today —, or
 *     offline / model hiccup) → we have NO verdict, so we fall back to the fast-path's own answer
 *     (true → `waiting`) rather than swallowing a genuine "needs you" to gray. This is what makes the
 *     prose-question case go red WITHOUT a judge key. The previous behavior (catch → false) made the
 *     whole red-on-prose path silently dead for everyone but the one user with a key.
 *
 * @param task     What the agent was asked to do (its naming basis / name) — lets the judge tell a
 *                 closeout ask (land/verify THIS work → red) from an offer of new work (gray).
 * @param response The finished turn's last assistant message (already read for history capture).
 */
export async function judgeNeedsFollowup(args: {
  task: string;
  response: string;
}): Promise<boolean> {
  if (!mightNeedFollowup(args.response)) return false;
  // Scope the try to ONLY the judge call, so the catch strictly means "the judge could not run"
  // (never a genuine verdict re-interpreted as an availability failure).
  let raw: string;
  try {
    raw = await invoke<string>("judge_turn_followup", {
      task: args.task,
      response: args.response,
    });
  } catch (e) {
    // The judge could not run (no API key, offline, model hiccup). We can't distinguish done from
    // blocked, so fall back to the deterministic fast-path — but TIERED, not a blanket red. Only a
    // STRONG signal (a whole-message gate, or a concrete action-proposal like "want me to land it?")
    // fails CLOSED to `waiting`: a keyless "Want me to land it now?" must still go red (sparkle-blpf).
    // A WEAK signal — a bare trailing '?' with no proposal/gating phrase, the shape of an open-ended
    // "what would you like to pick up next?" recap — falls OPEN to gray rather than manufacturing a
    // false red on an idle status report the user isn't actually blocking. With a judge key present,
    // the judge itself grays these (see judge.rs); this floor only governs the keyless path.
    console.debug("followup judge unavailable; failing closed only on a strong fast-path signal:", e);
    return classifyFollowupSignal(args.response) === "strong";
  }
  // The judge RAN — trust its verdict. A real DONE pulls the ambiguous turn back to gray.
  return interpretVerdict(raw);
}
