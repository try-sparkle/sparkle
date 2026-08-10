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
 * The opening of the GOAL-EXPIRY banner — the other end of the goal lifecycle from the resume above.
 *
 * UNLIKE `RESUME_PROMPT_MARKER`, NOTHING IN THIS REPO BUILDS THIS STRING. `continuePrompt` is the
 * only resume prose Sparkle authors; this banner is written outside the tree (grep finds it nowhere,
 * including `origin/main`) and arrives on the hook stream all the same. So there is no round trip to
 * pin it with, and the literal here IS the contract — which is why its test uses a real measured
 * record rather than a paraphrase. If the authoring side rewords, this goes blind and the only
 * symptom is the false positive coming back; that is a known, stated cost of a marker we do not own.
 *
 * Prefix only, stopping before the variable tail, for the same reason as the resume marker.
 */
export const GOAL_EXPIRY_PROMPT_MARKER =
  "Your goal expired unmet and you are resting with work unfinished";

/**
 * A background-task event, injected as a user turn by the harness when a task the agent spawned
 * finishes. Twelve of these were measured across twenty sessions — the second-largest class of
 * non-human `type:"user"` record after injected agent prompts.
 *
 * The opening tag is the whole marker because the payload is entirely variable (task id, summary,
 * status). No human opens a prompt with this tag; an agent QUOTING one still does not, because the
 * match is anchored at the start.
 */
export const TASK_NOTIFICATION_MARKER = "<task-notification>";

/**
 * The opening of a NUDGE — the Rust nudge ladder's automated ping (`nudge_ladder.rs::nudge_text`).
 *
 * ⚠️ THE ONE THAT WAS MISSING, and it cost the founder a fleet-wide loss of trust in the red dot
 * (bead sparkle-hpbkw, 2026-08-09). Agent 6d644864 had submitted this line FOUR times in a row and
 * was badged `repeating-command` for it — a verdict about the agent, earned entirely by Sparkle's
 * own prose. The row then read as blocked-on-human and went into his needs-you list. Nothing was
 * waiting on him; the nudger was arguing with itself and billing him for it.
 *
 * This marker is the WORST case of the three for the thrash tally, worse than the resume banner
 * that motivated this module. The nudge text is a pure function of a counter and a duration, so
 * consecutive pings are byte-identical BY CONSTRUCTION — and the ladder's whole job is to emit them
 * repeatedly while the agent is not moving. `REPEAT_LIMIT` is 3. The detector was therefore
 * GUARANTEED to condemn any agent the nudger worked on for more than two rungs, and the quieter the
 * agent, the more certain the false verdict.
 *
 * PREFIX ONLY, stopping before the counter — everything after `#` varies per ping. Note the marker
 * ends mid-token (`"[sparkle-nudge #"`), which is deliberate: it is the exact string Rust anchors
 * its own `parse_reply` search on, so the two sides match on one literal rather than two renderings
 * of one idea.
 *
 * ── THIS MARKER IS NOT ROUND-TRIPPABLE, SO IT IS PINNED INSTEAD ──────────────────────────────────
 * `RESUME_PROMPT_MARKER` is safe because `continuePrompt` builds FROM it — one string, one language.
 * The nudge is authored in Rust, so its literal and this one live in different languages and
 * different test suites that cannot see each other. That is the seam AGENTS.md warns about at
 * length: both suites green, the merge clean, the feature inert. `agentOriginated.test.ts` therefore
 * READS `nudge_ladder.rs` and asserts the two literals are character-for-character identical, and
 * separately that the fixed prefix of the real `nudge_text` format string still matches here. A
 * reword on EITHER side fails a test instead of silently blinding the detector again.
 */
export const NUDGE_PROMPT_MARKER = "[sparkle-nudge #";

/**
 * Every opening that means "Sparkle or the harness wrote this, not a person and not the agent".
 *
 * A LIST RATHER THAN A CHAIN OF `||`, so adding a class is a one-line change next to its constant
 * and its rationale, and so the test that walks every marker for the prefix and whitespace
 * disciplines cannot be left behind when one is added.
 *
 * WHAT IS DELIBERATELY ABSENT MATTERS AS MUCH AS WHAT IS HERE — see `agentOriginated.test.ts`'s
 * "deliberate exclusions", each measured in the same transcripts:
 *
 *   • `<command-name>` / `<command-message>` — a slash command the HUMAN ran. The gesture is the
 *     origination, exactly as `dispatchAuthority` rules for `nudge-approve`, and the suite already
 *     asserts a bare `/compact` stays countable. Suppressing the expanded form would blind the loop
 *     detector to the very case it was built for.
 *   • injected agent prompts ("You are a code reviewer…") — the largest non-human class, and NOT
 *     this agent's: they belong to a different `claude` process sharing the worktree (the residual
 *     race in `services/conciergeTools/terminal.ts`), so they never reach this predicate. Filtering
 *     belongs in the transcript reader, which can tell them apart by session id. "You are a…" is
 *     also far too broad an opening to match safely here.
 *   • `isMeta` / `isSidechain` — record FIELDS, not prompt text. This predicate takes a string and
 *     structurally cannot see them; they are the transcript reader's to honour.
 */
const SYSTEM_AUTHORED_MARKERS: readonly string[] = [
  RESUME_PROMPT_MARKER,
  GOAL_EXPIRY_PROMPT_MARKER,
  TASK_NOTIFICATION_MARKER,
  NUDGE_PROMPT_MARKER,
];

/**
 * Did SPARKLE (or the harness) write this prompt, rather than a human or an agent?
 *
 * `true` means the text carries NO information about whether the agent is progressing, so callers
 * must exclude it from both thrash tallies and progress tallies. See the module header for why
 * those are the same rule.
 *
 * Leading whitespace is tolerated because the PTY write path and the hook payload do not agree
 * about it; nothing else is normalised, because a looser match trades away the one property that
 * makes suppression safe. The match stays anchored at the START for every marker: a prompt that
 * merely CONTAINS one is an agent quoting it, which is an agent action carrying real information.
 */
export function isSystemAuthoredPrompt(text: string): boolean {
  const start = text.trimStart();
  return SYSTEM_AUTHORED_MARKERS.some((marker) => start.startsWith(marker));
}

/**
 * Is this specifically a NUDGE — Sparkle's automated ping — rather than any system-authored prompt?
 *
 * A NARROWER QUESTION THAN {@link isSystemAuthoredPrompt}, AND A DIFFERENT ONE. That predicate
 * answers "must this be excluded from the tallies" and the answer is yes for all four markers. This
 * one answers "is our own RECOVERY MECHANISM the thing that opened this turn", which only the nudge
 * satisfies, and it is what lets `agentThrash` count a nudge loop as OUR failure instead of merely
 * declining to blame the agent for it.
 *
 * Excluding the ping from the command tally was necessary but not sufficient: on its own it trades a
 * false positive (`repeating-command`, the agent's fault) for a false NEGATIVE (silence about an
 * agent that genuinely is not moving). The founder asked for neither — he asked that the loop be
 * "detected and reported as a NUDGE FAILURE". Detecting it needs this predicate; the resume banner
 * must NOT be folded in here, because auto-continue going around several times while an agent works
 * is the healthy path, not a wedge.
 */
export function isNudgePrompt(text: string): boolean {
  return text.trimStart().startsWith(NUDGE_PROMPT_MARKER);
}
