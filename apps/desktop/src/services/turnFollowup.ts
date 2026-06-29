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
// remainder. Everything is best-effort — any failure (no API key, offline, model hiccup) degrades
// to "not a followup" (gray), exactly the pre-change behavior, never a spurious red.
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
  "waiting on you",
  "waiting for you",
  "waiting for your",
];

/**
 * LOCAL fast-path: could this finished turn plausibly be blocked on the user — i.e. is it worth a
 * judge call? True when the tail contains a question mark OR a proposal/hand-back phrase. False for
 * a plain completion report (no model call, definitely gray). Pure + exported for testing.
 *
 * Bias is intentionally toward TRUE (consult the judge) on anything question-like: a false TRUE
 * only costs one cheap Haiku call that then returns DONE; a false FALSE would silently miss a real
 * ask. The judge is the precise gate; this is just the cheap pre-filter.
 */
export function mightNeedFollowup(response: string): boolean {
  const text = response.trim();
  if (!text) return false;
  const tail = text.slice(-TAIL_CHARS).toLowerCase();
  if (tail.includes("?")) return true;
  return PROPOSAL_PHRASES.some((p) => tail.includes(p));
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
 * might be an ask) the Haiku judge with the agent's task as context for "the work at hand". Returns
 * true ONLY for a confident followup; every failure path returns false (degrade to gray).
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
  try {
    const raw = await invoke<string>("judge_turn_followup", {
      task: args.task,
      response: args.response,
    });
    return interpretVerdict(raw);
  } catch (e) {
    // No API key, offline, or model hiccup — stay gray (the pre-change behavior), never a false red.
    console.debug("followup judge skipped:", e);
    return false;
  }
}
