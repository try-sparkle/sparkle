// agentOriginated — the ONE definition of what counts as AGENT-ORIGINATED activity.
//
// WHY THIS MODULE EXISTS AT ALL. Two detectors read the same stream of prompts and turns and ask
// opposite questions about it:
//
//   • engine/agentThrash  — "is this agent going nowhere?" It counts REPEATED COMMANDS as evidence
//                           of a loop.
//   • engine/goalContinuation + services/goalContinuationRunner — "has restarting stopped working?"
//                           It counts a MOVED PROGRESS MARK as evidence of progress.
//
// Both are wrong in the same way if they treat Sparkle's own auto-resume banner as something the
// agent did, and they are wrong in OPPOSITE DIRECTIONS, which is what makes a single shared
// definition worth a module rather than a comment in each:
//
//   • Counted as a COMMAND, the banner is a false POSITIVE for thrash. The banner is a pure function
//     of the goal text, so consecutive resumes are byte-identical BY DESIGN — the system wrote the
//     same string three times because the system always writes the same string. On 2026-07-30 agent
//     0bf08c64 was badged `repeating-command` — detail "It is looping, not working" — through 46
//     minutes of continuous real work (writing retraction tests, running typecheck and vitest). The
//     human relayed that badge to the founder as fact. A status surface asserting a conclusion it
//     never observed is the bug; this is its second instance.
//
//   • Counted as PROGRESS, the banner is a false NEGATIVE for stall. `progressMark` is built partly
//     from `promptHistory.length`, so a resume that grew that list would move the mark on EVERY
//     auto-continue, `decideContinuation` would read its own send as the agent making headway, the
//     consecutive-retry streak would reset forever, and `MAX_CONTINUES_WITHOUT_PROGRESS` could never
//     fire. The bound that stops us restarting an agent that cannot progress would be vacuous.
//
// THE RULE, stated once so neither side has to restate it: **only text an agent or a human
// ORIGINATED carries information about whether the agent is making progress.** Text Sparkle
// authored on its own initiative is Sparkle talking to itself. It must not count as a command
// (thrash) and must not count as progress (stall). Neither direction is a judgement call — a
// system-authored string is evidence of nothing about the agent, so it belongs in NEITHER tally.
//
// THIS IS NOT A NEW DEFINITION — IT IS THE EXISTING ONE, RECOVERED. `services/dispatchAuthority`
// already draws exactly this line at SEND time, exhaustively and by construction: `isHumanAuthored`
// is a `Record` over every `DispatchAuthorityKind`, so a new arm cannot be added without someone
// deciding which side it sits on. It already answers our two cases correctly —
//
//   • `goal-continue`  → false. The auto-resume banner. A timer sent it; the prose is not a
//                        person's and not an agent's.
//   • `nudge-approve`  → true.  The nudge-card "approve", even though it also dispatches with
//                        `userPrompt: false`. A human CLICKED Approve — the gesture is the
//                        origination. (Which is why `userPrompt` is the wrong predicate to reach
//                        for: it means "meter this against the trial", a billing concern that
//                        merely overlaps this one today.)
//
// So there is one definition and this module does not compete with it. What this module adds is the
// half `dispatchAuthority` cannot reach.
//
// WHY A SECOND, TEXT-MATCHING FORM IS NEEDED AT ALL. The authority is known at send time and is
// LOST by the time the evidence comes back: `agentThrash` reads Claude Code's hook stream, which
// reports `UserPromptSubmit.prompt` for every submission and cannot know who originated it — from
// the hook's point of view Sparkle's write and a human's typing are the same keystrokes. The
// detector therefore has to recognise Sparkle's OWN send from the text alone, which is only safe if
// the sender and the recogniser cannot drift apart. That is what {@link RESUME_PROMPT_MARKER} is
// for: `continuePrompt` BUILDS from this constant and this module MATCHES on it, so there is one
// string rather than two copies of one string. `agentOriginated.test.ts` asserts both the round
// trip on real `continuePrompt` output AND that this module agrees with `isHumanAuthored` about
// `goal-continue` — so a reword on either side, or a reclassification of the authority, fails a
// test instead of silently blinding the detector.

/**
 * The opening of the auto-resume banner (`goalContinuation.continuePrompt`).
 *
 * DELIBERATELY THE PREFIX ONLY, stopping before the goal text is interpolated. Everything after
 * this point varies per agent and per goal, so a whole-string comparison would recognise nothing;
 * this is the invariant part. It is also long enough to be unmistakable — no human types this
 * sentence — which matters because a false match here would SUPPRESS a real loop rather than merely
 * fail to catch one.
 *
 * It stops before "automatically." so that a hook payload which truncates the prompt (older logs do)
 * still matches on what survives.
 */
export const RESUME_PROMPT_MARKER =
  "Your turn ended but your goal is not met yet, so you are being resumed";

/**
 * Did SPARKLE write this prompt, rather than a human or an agent?
 *
 * `true` means the text carries NO information about whether the agent is progressing, so callers
 * must exclude it from both thrash tallies and progress tallies. See the module header for why
 * those are the same rule.
 *
 * Leading whitespace is tolerated because the PTY write path and the hook payload do not agree
 * about it; nothing else is normalised, because a looser match trades away the one property that
 * makes suppression safe.
 */
export function isSystemAuthoredPrompt(text: string): boolean {
  return text.trimStart().startsWith(RESUME_PROMPT_MARKER);
}
