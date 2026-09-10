// movementRetraction — A RED IS A CLAIM ABOUT NOW. An agent that has demonstrably MOVED since the
// red was raised is not blocked any more, and nobody should have to say so by hand.
//
// THE REPORT (founder, 2026-08-05, with a screenshot). The pill above the composer read
// "● BLOCKED: @<agent> in <project>" with a manual [x], while that agent was working. His words:
// "If you are showing me the blocked issue but then I go take care of it in the terminal, then the
// blocked pill should go away once the agent starts moving again. I shouldn't need to clear it
// manually."
//
// WHY THE PILL COULD NOT RETRACT ITSELF. The card is already derived from live state — it is
// rebuilt from the feed on every tick and `ConciergeHost.retraction.test.tsx` pins that a card
// disappears the moment its agent's status leaves red. The latch is one layer down, in the status
// the card derives FROM. `components/AgentPane.tsx` is the ONLY writer of `runtimeStore.status`
// (`(s) => setStatus(agent.id, s)`), so a status is live exactly while a pane is mounted for it —
// and panes are mounted LAZILY, per project, only once the user has visited that project this
// session (`Workspace.tsx`: "mounting every project's panes at BOOT spawned a PTY + `claude
// --resume` for every…"). For an agent this window is not hosting — another project's, another
// window's whose roster entry has gone quiet, a worker with no pane of its own — the red is a
// FROZEN LAST READING with no writer that can ever retract it. Deriving the card from it faithfully
// re-renders a fact that stopped being true minutes ago, and the [x] is the only thing that clears
// it. That is the founder's "latched, not live".
//
// THE SIGNAL, AND WHY IT IS NOT A NEW ONE. `fleet_digest` (src-tauri/src/fleet.rs) already reads
// every agent's hook log straight off disk, and `services/fleetWatch` already polls it on a timer
// over `openAgentIdSet()` — the population that INCLUDES agents this window does not host, which is
// exactly the set whose statuses freeze. It costs no agent turn, no network and no model call. So
// the retraction is a second READING of an artifact stream that is already being collected.
//
// ── THE THREE WAYS THIS COULD HAVE BEEN WRONG ────────────────────────────────────────────────────
//
// 1. A FRESHNESS TEST WOULD SILENCE REAL QUESTIONS. The tempting version is "artifacts say
//    `advancing` (something moved inside `fleetVerdict.QUIET_AFTER_MS`) → not blocked". That is
//    WRONG, and dangerously so: an agent that asks a question has, by definition, just been running
//    — its last tool call is seconds old — so for the first two minutes of every genuine ask the
//    freshness test reads `advancing` and would suppress the card. What licenses a retraction is
//    movement recorded AFTER the red was raised, so {@link movedSince} compares two instants.
//    Freshness never enters into it.
//
// 2. NOT EVERY HOOK EVENT IS MOVEMENT. `HookFacts.lastEventMs` is the timestamp of the last event of
//    ANY kind, and Claude fires a `Notification` idle ping roughly sixty seconds into a wait —
//    `engine/statusRouter` already had to learn this ("What deliberately does NOT count: a hook
//    `idle`. Claude fires a `Notification` idle ping ~60s into any wait, including this one, and
//    that is the picker being unanswered — not progress past it"). Keying on `lastEventMs` alone
//    would retract every genuine ask about a minute after it was raised. `HookFacts.lastEvent`
//    carries the event's NAME, so {@link WORK_EVENTS} keeps only the events that mean the agent
//    ACTED.
//
// 3. THE EVIDENCE IS A SNAPSHOT, SO IT MUST BE ACCUMULATED — NOT READ RAW. This one bit, and it is
//    the subtlest of the three. `fleet.rs` assigns `facts.last_event` LAST-WINS over every event
//    kind (`fleet.rs:284`, and its own test `reduces_a_stream_to_last_event_and_windowed_counts`
//    asserts the reduction ends at `"Stop"`). So a digest tick reports only the MOST RECENT event,
//    and the founder's own sequence walks straight off the end of it:
//
//        red raised at T                        → pill up
//        human answers      → UserPromptSubmit  → pill retracts        ✔
//        agent runs tools   → PostToolUse       → still retracted      ✔
//        agent finishes     → Stop              → NO work event in the snapshot … pill RETURNS  ✘
//
//    A `Notification` ping does the same once it overwrites a work event, and so does any tick where
//    the agent is simply absent from the digest (`setAgentMovement` replaces the map wholesale). The
//    net effect would be the reported bug restored the moment the agent's turn ends, plus a visible
//    flap — strictly worse than not fixing it. So movement is kept as a HIGH-WATER MARK per red
//    episode ({@link noteMovement}) rather than re-read from each snapshot: once an agent is seen to
//    have acted after its red, that fact cannot be un-seen by a later quiet tick. It is dropped only
//    at the episode boundary, where the red itself is dropped.
//
// 4. THE STREAM IS NOT SELF-ATTRIBUTING, AND ONE OF ITS EVENTS IS THE BLOCK ITSELF. Notes 1–3 are
//    about WHICH event to read and WHEN; this one is about whether the event is this agent ACTING
//    at all, and a raw name-only projection got it wrong twice. `engine/hookEvents` — the
//    authoritative status path over the SAME stream — already refuses both classes, and refusing
//    them here matters more than it does there: there the cost is a wrong colour, here it is a
//    silenced question.
//
//    a. A `PreToolUse` FOR A BLOCKING TOOL IS THE OPPOSITE OF MOVEMENT. `hookEvents`'s
//       `BLOCKING_TOOL_STATUS` maps `AskUserQuestion` → `waiting` and `ExitPlanMode` → `approval`
//       precisely because those tools fire their `PreToolUse` and then Claude SITS THERE waiting
//       for an answer — no Stop, and, unlike a permission request, no Notification. So the one
//       event that means "this agent is now blocked on you" was being read as it moving past a
//       block. Note 3 makes that concrete: a tick reports only the LAST event, so a burst of tool
//       calls ending on a picker reaches this module as a single `PreToolUse` — the blocking one —
//       and the pill retracted at the moment it was most needed.
//       FIXED BY SUBTRACTION: `PreToolUse` is simply not in {@link WORK_EVENTS} any more. Dropping
//       it costs latency and nothing else, and only for an agent whose sole evidence is a tool
//       STILL RUNNING — its `PostToolUse` retracts the pill a moment later. That is the direction
//       this module fails in everywhere else.
//       THE CONSTRAINT THIS NOTE USED TO CITE HAS BEEN LIFTED, and the note is kept rather than
//       deleted because the conclusion survived its own premise. It read: keeping `PreToolUse` and
//       excluding two tool names "would need `fleet.rs` to carry the last event's tool NAME (it
//       carries the name only for `PostToolUse`, in `recentTools`) and would restate `hookEvents`'s
//       list in a second place." `fleet.rs` now DOES carry it — `HookFacts.lastEventTool` and
//       `lastEventMessage`, added for {@link derivedStatus}, which restates nothing because it calls
//       `hookEventToStatus` itself. So the subtraction could now be undone precisely. It is not,
//       for a reason that has nothing to do with the old one and is written out on {@link
//       WORK_EVENTS}: `hookEventToStatus` defaults an UNRECOGNISED tool to `working`, which is right
//       for a pane and fail-OPEN here.
//    b. THE LOG IS KEYED BY WORKTREE, SO THE HOOK STREAM IS NOT ATTRIBUTABLE EITHER. This is the
//       claim the exclusion list below used to make and could not keep. A background one-shot
//       `claude` run in the same worktree writes its whole SessionStart→…→SessionEnd into the SAME
//       file — which is the entire reason `hookEvents.HookStatusEngine` carries a session lock.
//       Its `PostToolUse` is indistinguishable from the agent's own until you compare `session_id`,
//       and it would retract a genuinely unanswered red on work the agent never did. So an episode
//       ADOPTS the session it first sees evidence under and rejects every other, via
//       `hookEvents.isMainSessionId` — the same rule imported, not a second copy of it. The
//       adopting evidence does NOT also count as movement; see {@link noteMovement} for why
//       letting it authorize itself left the first tick of every episode ungated.
//
//    WHAT IS DELIBERATELY *NOT* GATED, having been considered: a tool event that lands after the
//    main turn CLOSED. `HookStatusEngine` ignores those so a finished tab cannot flip back to
//    green, but that reasoning does not transfer. A closed turn means the agent reached a `Stop`,
//    so it is not sitting on an unanswered question — and `idle`, where a retraction lands it, is
//    exactly where `hookEvents` settles a post-`Stop` agent anyway. The two paths differ in route,
//    not outcome. Gating it would need a `lastTurnStartMs` the digest does not carry (only
//    `lastTurnEndMs`), and without one every tool call of a long turn reads as post-`Stop` — which
//    would strand a red behind the very turn that proves the agent resumed.
//
// WHAT COUNTS AS THE AGENT ACTING — `WORK_EVENTS`, and only under this episode's own session:
//   • `PostToolUse` — a tool RAN, to completion. The founder's "starts moving again", and also how
//     an ANSWERED `AskUserQuestion` picker reports itself, so his gesture is covered twice over.
//   • `UserPromptSubmit` — a turn was started. Literally the founder's case: he answers in the
//     terminal, and the answer is a `UserPromptSubmit`.
// What is deliberately NOT movement:
//   • `PreToolUse` — see 4(a). A tool ANNOUNCED is not a tool run, and for a blocking tool it is
//     the block itself.
//   • `Notification` — see (2). The sound of an unanswered question, not of progress past one.
//   • `Stop` / `SessionEnd` — a turn ENDING is what puts an agent at a prompt in the first place, so
//     reading it as movement past a block gets the causality backwards.
//   • Anything under another `session_id` — see 4(b).
//   • `hookMtimeMs` and `newestWriteMs` — a foreign process sharing the worktree bumps both, and
//     `FleetVerdict.evidenceIncomplete` records that a truncated walk makes `newestWriteMs` depend
//     on traversal order.
//   • `GitFacts.lastCommitMs` — EXCLUDED FOR THE SAME REASON, though it took a review to see it. A
//     commit is the branch tip, which ANY process sharing that worktree advances: a rebase, a
//     background script, or the human themself — and the human committing in the agent's worktree is
//     the very scenario this module is written around ("I go take care of it in the terminal"). A
//     commit made while the agent is still parked on an unanswered question would silence that
//     question. It costs nothing to drop: an agent that commits ran `PreToolUse`/`PostToolUse` to do
//     it, so the hook stream already carries the same news, attributably.
// Every omission fails toward under-retracting. A lingering pill is the bug being fixed; a pill that
// never appears is a worse one, because nothing tells you it was hidden.
//
// PURE — data in, data out, the clock arrives as a parameter. No store, no React, no I/O, in the
// same family as `engine/alertDismissal`, `engine/unmergedAttention` and `engine/stallEscalation`,
// and composed onto the status map exactly like them.
import type { AgentTabStatus } from "@sparkle/ui";
import { deEscalatedStatus, type RedStatus } from "./alertDismissal";
import { hookEventToStatus, isMainSessionId } from "./hookEvents";
import { needsAttention } from "./attention";

/**
 * The hook events that mean THE AGENT ACTED, by name as `fleet.rs` records them.
 *
 * See the header for why this set is not "every event": `Notification` fires ~60s into an unanswered
 * wait and `Stop` is what creates the wait, so both would retract exactly the live asks this must
 * never touch — and `PreToolUse` (header 4a) is worse than either, because for `AskUserQuestion` and
 * `ExitPlanMode` it IS the block. A tool that has actually run reports a `PostToolUse`.
 */
export const WORK_EVENTS: ReadonlySet<string> = new Set(["PostToolUse", "UserPromptSubmit"]);

/**
 * WHY THIS STAYS A SET OF NAMES while {@link derivedStatus} replaced the other one.
 *
 * The two look like the same shape and are not. `BLOCK_SIGNALS` classified events whose meaning
 * DEPENDS on a discriminant it did not have — a `Notification` is an ask only if its message says
 * so, a `PreToolUse` only for two tool names — so classifying those by name was a guess, and it was
 * wrong for 79.5% of Notifications. These two events mean the same thing whatever tool or message
 * they carry: a tool RAN to completion, and a turn was STARTED. No discriminant exists that could
 * change either answer, so there is nothing here to get wrong.
 *
 * AND CONVERTING IT WOULD FAIL OPEN, which is the reason not to do it even though it would delete a
 * few lines. `hookEventToStatus` defaults an UNRECOGNISED `PreToolUse` tool to `working`
 * (`BLOCKING_TOOL_STATUS[ev.tool ?? ""] ?? "working"`), which is right for a pane — optimistic and
 * self-correcting on the next event — and wrong here, where "working" retracts a red and nothing
 * ever puts it back. A `PreToolUse` whose `tool` is absent (an older emitter, a line the hook wrote
 * without `tool_name`) would then count as movement and silence an ask that may well have been an
 * `AskUserQuestion`. Reading movement by name is the fail-CLOSED direction, which is the direction
 * every omission in this module is chosen to fall in.
 */

/**
 * THE STATUS A MOUNTED PANE WOULD HAVE WRITTEN for this agent's newest hook event — or `null` when
 * this evidence CANNOT SAY (roborev probe 5610179003#1).
 *
 * WHY THIS REPLACED A SET OF EVENT NAMES. The previous rule classified by event NAME alone
 * (`{Notification, PreToolUse}` meant "the agent is blocked on you"), because header note 4(a)
 * recorded that the digest did not carry the discriminant. It does now — `HookFacts.lastEventTool`
 * and `lastEventMessage` — and the name alone is WRONG, measured on this machine's real logs:
 *
 *   • a `Notification` is an approval prompt only when its message matches `PERMISSION_RE`. 2,890 of
 *     3,633 of them (79.5%) do NOT: they are Claude's idle ping, "Claude is waiting for your input",
 *     which `hookEvents` maps to `idle` — explicitly not a red.
 *   • a `PreToolUse` blocks only for `AskUserQuestion` / `ExitPlanMode`. Every other tool is the
 *     agent WORKING.
 *
 * On the three agents bead sparkle-xndaze is named after, the name-only rule was wrong on two of
 * three and accidentally right on the third — it read `d5d7056e`'s idle ping and `413ebe91`'s
 * `PreToolUse(Bash)` as asks, which is what would have kept both phantoms on screen forever.
 *
 * THERE IS EXACTLY ONE CLASSIFIER AND IT IS `hookEvents.hookEventToStatus`. This function does not
 * restate its rules — it feeds it the newest event and returns what it says. That is the whole
 * reason the discriminant is carried as the RAW tool and message rather than as a boolean computed
 * in `fleet.rs`: a verdict computed on the Rust side would be a second copy of `PERMISSION_RE` and
 * of `BLOCKING_TOOL_STATUS`, free to drift from the one the panes actually use.
 *
 * THE ONE PIECE OF HISTORY THE PURE CLASSIFIER CANNOT CARRY is `HookStatusEngine`'s `turnClosed`
 * rule: once the turn has closed, a trailing background-subagent `PreToolUse`/`PostToolUse` leaves
 * the status UNCHANGED rather than flipping it to `working`, and a trailing `SubagentStop` settles
 * to `idle`. `lastTurnOpenMs`/`lastTurnCloseMs` let that be replayed from the same stream. Without
 * it a post-`Stop` tool call would read as the agent working and retract a live ask.
 *
 * `null` MEANS "I CANNOT SEE WHETHER ANYTHING IS BEING ASKED", NEVER "NOTHING IS BEING ASKED" —
 * the distinction bead sparkle-gazo4a names and this module is required to hold. It is returned for
 * an empty log, for an event this build does not model (`PreCompact`), and for the turn-closed tool
 * events above. Every caller must fail CLOSED on it: the red stands.
 */
export function derivedStatus(evidence: MovementEvidence): AgentTabStatus | null {
  const event = evidence.lastEvent;
  if (event === null || event === "") return null;

  // `close > open` — and a close with NO open at all is still closed, which is the honest reading of
  // a tail that begins after the turn started. A non-finite stamp is not a boundary.
  const close = evidence.lastTurnCloseMs;
  const open = evidence.lastTurnOpenMs;
  const closeOk = close !== null && Number.isFinite(close);
  const openOk = open !== null && Number.isFinite(open);
  const turnClosed = closeOk && (!openOk || (close as number) > (open as number));

  if (turnClosed) {
    // `HookStatusEngine.ingest`: these leave the status untouched after the turn closed, so this
    // evidence says nothing about whether the agent is asking.
    if (event === "PreToolUse" || event === "PostToolUse") return null;
    // ...and a trailing subagent settles to gray. (The engine holds a terminal `done`; `done` and
    // `idle` are both outside the attention set, so every caller here treats them alike.)
    if (event === "SubagentStop") return "idle";
  }

  // A MISSING DISCRIMINANT IS "I CANNOT TELL", NEVER "NOT ASKING" (roborev job 82345).
  //
  // This is the module's own trap, reached at the WIRE boundary rather than at the screen. For the
  // two events whose meaning DEPENDS on a discriminant, `hookEventToStatus` resolves an absent one
  // to the NOT-asking side — `PERMISSION_RE.test(undefined ?? "")` is false, so a `Notification`
  // reads as the idle ping, and `BLOCKING_TOOL_STATUS[undefined ?? ""] ?? "working"` reads a
  // `PreToolUse` as work. That default is correct for a PANE, which is optimistic and self-corrects
  // on the next event. Here it retracts a red and nothing ever puts it back.
  //
  // AND ABSENT IS THE NORMAL CASE FOR AN OLDER BACKEND. `HookFacts.lastEventTool` /
  // `lastEventMessage` did not exist before 2026-09-09, so a frontend talking to a digest that
  // predates them receives null for every event — and without this gate EVERY genuine permission
  // prompt in the fleet would classify as an idle ping and every live ask would be silenced at
  // once. The same holds for any single line the emitter wrote without a `tool_name`.
  if (event === "Notification" && evidence.lastEventMessage === null) return null;
  if (event === "PreToolUse" && evidence.lastEventTool === null) return null;

  const status = hookEventToStatus({
    event,
    tool: evidence.lastEventTool ?? undefined,
    message: evidence.lastEventMessage ?? undefined,
  });

  // AN IDLE PING BEFORE THE TURN HAS CLOSED IS THE SOUND OF A WAIT, NOT THE END OF ONE
  // (roborev job 82349).
  //
  // Claude fires a non-permission `Notification` — "Claude is waiting for your input" — when the
  // prompt has sat idle, and `hookEvents` maps it to `idle`. That is right when the turn is OVER:
  // the agent finished and it is the human's move. It is NOT right mid-turn, because a turn that
  // has not closed and is nonetheless idle means the agent is stuck on something this stream
  // cannot name — and letting that retract a red would erase a genuine ask ON A TIMER, on the
  // weakest evidence there is: an event that fires because nobody answered.
  //
  // MEASURED on this machine's 151 hook logs, which is what makes this a split rather than a
  // guess: of 2,906 idle pings, 2,544 fired with the turn CLOSED (a `Stop`/`SessionEnd` is the
  // newest boundary) and 362 fired with it still OPEN. Both populations are real, so neither
  // blanket answer is safe — trusting all of them silences the 362, and refusing all of them makes
  // this axis inert for `d5d7056e`, whose ping follows a `Stop` and is one of the two phantoms the
  // bead exists to clear.
  //
  // Keyed on the STATUS rather than on the message, so `PERMISSION_RE` is not restated here: a
  // permission `Notification` resolves to `approval` and is untouched by this gate.
  if (status === "idle" && event === "Notification" && !turnClosed) return null;

  return status;
}

/**
 * The instant this evidence speaks to, or `null` when it carries no TRUSTWORTHY one.
 *
 * DELIBERATELY NOT {@link episodeStart}, and the difference is a fail-open (roborev job 82345).
 * `episodeStart` CLAMPS a missing, non-finite or future timestamp to `now`, which is right for a
 * RAISE — a baseline at `now` sits above every fact that could retract it, so a broken clock costs
 * a lingering pill. It is exactly wrong for a RETRACTING fact: `now` is always greater than the
 * baseline, so the clamp turns "this evidence has no usable timestamp" into "this evidence is newer
 * than the red", and a null or future `lastEventMs` would silence a live ask permanently.
 *
 * So a retracting axis must be able to say it does not know WHEN. This returns null instead of
 * guessing, and its caller fails closed on that.
 */
function evidenceInstant(eventMs: number | null, now: number): number | null {
  return eventMs !== null && Number.isFinite(eventMs) && eventMs > 0 && eventMs <= now
    ? eventMs
    : null;
}

/**
 * Is the agent, ON ITS NEWEST EVENT, still asking for the human?
 *
 * `needsAttention` DELIBERATELY, NOT the caller's `isRed`. They are different sets and the
 * difference is load-bearing: `questions` (a pending `AskUserQuestion` picker) is NOT red — it is
 * BLUE — but it is every bit as much "the agent cannot proceed without you", and it IS in the
 * attention set. Testing the derived status with the red predicate would read a live question as
 * "not asking" and retract the row out from under it, which is the under-alerting this module calls
 * the worse bug. Every status `hookEventToStatus` can return that is red (`approval`) is also in the
 * attention set, so this is the strictly safer of the two — pinned by a test.
 */
function stillAsking(derived: AgentTabStatus | null): boolean {
  return derived !== null && needsAttention(derived);
}

/**
 * WHEN a sub-episode's red began — on the EVENT clock, never the render clock (roborev job 82234).
 *
 * THE TWO CLOCKS ARE NOT CLOSE TOGETHER HERE. `conciergeFeed` calls `noteMovement(…, Date.now())` on
 * EVERY RENDER, while the evidence is republished only by `fleetWatch`'s 30-second poll — so the
 * event this baseline is stamped for can be most of a poll interval old by the time a render stamps
 * it. A baseline taken from `now` then sits ABOVE evidence that genuinely postdates the ask, and
 * every fact that could retract it is judged on the event clock: `seen <= raisedAt` silently drops
 * the answer's work event, and `endedAt > raisedAt` silently drops the asking session's own
 * `SessionEnd`.
 *
 * That second one is permanent and is the bead's own population: B blocks on a plan prompt, the human
 * QUITS rather than answering, `SessionEnd`'s event time predates the stamping render, the mark is
 * never recorded — and a dead session emits nothing further, so "Needs you" stands forever over a
 * latch with no writer.
 *
 * The event IS the instant the episode began, so anything postdating the ask necessarily beats it.
 * Falls back to `now` when the timestamp is missing, non-finite, or FROM THE FUTURE — the same
 * refusal the capture below makes, and for the same reason: a broken clock that beats every later
 * fact would silence this agent permanently.
 */
function episodeStart(eventMs: number | null, now: number): number {
  return eventMs !== null && Number.isFinite(eventMs) && eventMs > 0 && eventMs <= now
    ? eventMs
    : now;
}

/** The artifact facts this module needs — the subset of `engine/fleetVerdict.FleetAgentFacts` that
 *  bears on "did this agent act", named structurally so the feed can be fed from a test without
 *  building a whole digest.
 *
 *  `lastCommitMs` is deliberately absent; see the header for why a commit is not attributable. */
export interface MovementEvidence {
  /** Name of the most recent hook event (`HookFacts.lastEvent`), or null when the log is empty. */
  lastEvent: string | null;
  /** When that event fired (`HookFacts.lastEventMs`). */
  lastEventMs: number | null;
  /**
   * That event's OWN tool and message (`HookFacts.lastEventTool` / `lastEventMessage`) — the
   * discriminant {@link derivedStatus} feeds to `hookEventToStatus`. `null` is "the event carried
   * none", which for a `Notification` means it is NOT a permission prompt.
   *
   * REQUIRED, like `sessionId` and `toolsRecent` below and for the identical reason: a projection
   * that forgets to carry them compiles fine and silently drops this module back to classifying by
   * event NAME, which is wrong for 79.5% of Notifications. As required fields, forgetting them is a
   * compile error rather than a phantom nobody can explain.
   */
  lastEventTool: string | null;
  /** See {@link MovementEvidence.lastEventTool}. */
  lastEventMessage: string | null;
  /**
   * The turn boundary (`HookFacts.lastTurnOpenMs` / `lastTurnCloseMs`), for the `turnClosed` rule
   * {@link derivedStatus} replays. Required for the same reason as the two above: dropping them
   * silently reads every post-`Stop` tool call as the agent working.
   *
   * SESSION-SCOPED AT THE SOURCE, and this axis depends on that (roborev job 82352). The hook log
   * is keyed by WORKTREE, so folding the boundary last-wins over every line would let any other
   * `claude` process sharing it move the boundary — and a background one-shot emits `SessionEnd` BY
   * CONSTRUCTION, so it would routinely stamp a newer "close" over a main session whose turn is
   * genuinely still open. `turnClosed` then reads true off a foreign boundary, the mid-turn gate in
   * {@link derivedStatus} does not fire, and an idle ping retracts a live picker. `parse_hook_tail`
   * therefore tracks the boundary PER SESSION and publishes only the one belonging to the same
   * session as `lastEvent` — pinned by `the_turn_boundary_is_scoped_to_the_last_events_session`.
   *
   * An older digest carries neither, which reads as turn-OPEN and so refuses every idle ping. That
   * is the fail-closed direction: a lingering pill, not a silenced ask.
   */
  lastTurnOpenMs: number | null;
  /** See {@link MovementEvidence.lastTurnOpenMs}. */
  lastTurnCloseMs: number | null;
  /**
   * The Claude Code session that event belongs to (`HookFacts.sessionId`), or null for a log that
   * carries none (an older emitter).
   *
   * REQUIRED, not optional, for the reason `FleetWatchDeps.publishMovement` is: the whole point of
   * header 4(b) is that a projection which forgets to carry it silently retracts live reds on a
   * background `claude`'s work, with every test still green. As a required field, forgetting it is
   * a compile error.
   */
  sessionId: string | null;
  /**
   * `HookFacts.toolsRecent` — how many tool events this agent's hook log holds inside the digest's
   * window (15 minutes; `fleet.rs` DEFAULT_WINDOW_MS).
   *
   * NOT READ BY THIS MODULE. Retraction asks "did the agent act AFTER the red was raised", which is
   * a question about an INSTANT, and a windowed count carries no instant — see header note 1 on why
   * a freshness test is the wrong shape here. It rides along because
   * `engine/goalContinuation.progressMark` asks a different question over the same stream ("did
   * anything happen between two restarts"), and a count is the right shape for THAT one precisely
   * because `lastEvent` is last-wins and reads `Stop` at the moment a continuation is decided
   * (header note 3, in its other consequence).
   *
   * REQUIRED, like `sessionId` and for the identical reason: a projection that forgets it compiles
   * fine and silently starves the escalation predicate back to the three self-report signals that
   * produced the false-positive flood. `null` is a log this build could not count, never zero.
   */
  toolsRecent: number | null;
}

/**
 * WHAT THIS WINDOW REMEMBERS ACROSS TICKS — one entry per agent currently in a red episode.
 *
 * Two facts, kept together because they share ONE lifetime: the episode. `redSince` is when the red
 * was first observed; `movedAt` is the high-water mark of the agent acting since. Both are dropped
 * the moment the agent leaves red, which is what makes a recurring red a NEW episode rather than one
 * that inherits a raise time old movement could instantly beat.
 */
export interface RetractionLedger {
  /** agentId → when its CURRENT red episode was first observed. */
  redSince: Map<string, number>;
  /** agentId → the latest instant this agent was SEEN to act during that episode. */
  movedAt: Map<string, number>;
  /**
   * agentId → the `session_id` this episode's evidence is attributed to, adopted from the first
   * evidence seen, never re-adopted, and never counted as movement by the evidence that set it
   * (header 4b).
   *
   * Third map rather than a field on a record, only because the other two are already shaped this
   * way; it shares their ONE lifetime and is dropped with them at the episode boundary. That drop
   * is what lets an agent restarted in the terminal — a new session — be believed again on its next
   * red, instead of being locked out by the id its previous episode adopted.
   */
  session: Map<string, string>;
  /**
   * agentId → the instant this episode's ADOPTED session was observed to END (bead sparkle-xndaze).
   *
   * WHY A SECOND RETRACTION AXIS WAS NEEDED AT ALL. Movement answers "the agent carried on past the
   * red", which is the founder's original gesture and covers every case where the agent is still
   * alive. It cannot cover an agent whose session was REPLACED: that agent never acts again under
   * the session that raised the ask, so `noteMovement`'s session gate discards every later
   * observation and the red stands forever. Measured (sparkle-xndaze): three agents carried
   * "Needs you" for over 24 hours, two of them restarted, with `read_picker_options` answering
   * `no-menu` — the documented "nothing on screen resolves to a menu" — on six separate checks.
   * The guard that protects a LIVE red from a background `claude` is the same guard that freezes a
   * DEAD one, and nothing else could ever write to that latch.
   *
   * A SESSION THAT HAS ENDED CANNOT STILL BE ASKING. That is the whole licence here, and it is
   * positive evidence of absence rather than absence of evidence — the distinction bead
   * sparkle-gazo4a names and this module is required to hold. "No menu on screen" must NEVER reach
   * this map; only the adopted session's own `SessionEnd` does.
   *
   * Shares the episode's ONE lifetime with the other three and is dropped with them, so a later ask
   * from a later session is judged entirely on its own evidence.
   */
  endedAt: Map<string, number>;
  /**
   * agentId → the instant this agent's newest ATTRIBUTED hook event was seen to say it is NOT
   * asking for anyone (bead sparkle-xndaze, probe 5610179003#1).
   *
   * THE THIRD AXIS, AND THE ONLY DERIVED ONE. `movedAt` and `endedAt` are high-water marks of
   * PERMANENT facts — an agent acted; a session ended — so they latch and never lower. This one is
   * a statement about the CURRENT tick and is recomputed from scratch on every one: set when
   * {@link derivedStatus} says the newest event is not an ask, DELETED the moment it says it is, or
   * says it cannot tell. Latching it would rebuild the very defect this module exists to fix — the
   * bead's own first question was whether the flag is "LATCHED when an agent asks and never cleared"
   * or "DERIVED each poll from state that is itself stale", and the answer was a derived flag over a
   * LATCHED status. So the retraction is derived, over evidence that is not.
   *
   * WHY A DISAGREEMENT IS PROOF. `runtimeStore.status` is written by `AgentPane` from
   * `HookStatusEngine`, which is `hookEventToStatus` plus a session lock and the turn-closed rule —
   * and {@link derivedStatus} replays all three over the SAME log. So when the latch says red and
   * this says otherwise, the two cannot be looking at the same event: the pane stopped updating
   * before this one arrived. That is positive evidence the latch is stale, not an absence of
   * evidence, and it needs no timestamp comparison to establish.
   *
   * Shares the episode's ONE lifetime with the other three — `ledgerMaps` is derived from the
   * object, so this map joined every lifetime site the moment it was declared.
   *
   * DELIBERATELY NOT READ BY THE CAPTURE-RELATIVE SITES, and the next person to find them will want
   * to wire it in. Two live callers ask the movement question for a different purpose:
   * `conciergeTools/terminal.ts` (is a captured picker reading still current?) and
   * `suggestions/approvalScreen.ts` (same, for an approval screen). Both use
   * {@link movedSinceStamp} against the CAPTURE'S own write time, because judging a capture against
   * the EPISODE's raise time discards the freshest evidence there is — that is bead sparkle-5wbhn,
   * and it ends with `mayHaveMenu` permitting a blind `enter` into a live picker.
   *
   * This mark is stamped against the EPISODE baseline, so handing it to those sites would compare
   * two different baselines — the very confusion sparkle-5wbhn is about. And the direction of danger
   * there is the opposite one: this axis exists to RETRACT a red (fail-closed = a lingering pill),
   * while those gates decide whether to ACT on a capture (fail-closed = do not press enter). One
   * more "the agent moved on" signal WIDENS them. If a capture-relative variant is ever wanted, the
   * stored value is the contradicting event's instant precisely so it can be compared to a capture
   * time — but that is a new predicate with its own paired tests, not a reuse of this one.
   *
   * WHY THIS DOES NOT SUBSUME `endedAt`, since it is the axis that fixes the bead and `endedAt` is
   * the axis that cost six review rounds. The two differ exactly where this one is deliberately
   * weak, and both cases are reachable:
   *   • THIS AXIS FAILS CLOSED ON "CANNOT TELL". An unmodelled event, a tool event after the turn
   *     closed, a missing discriminant or an unusable timestamp all DELETE the mark. `endedAt`
   *     records a fact ambiguity cannot revoke — a session cannot un-end — so it survives a later
   *     tick that can say nothing at all.
   *     PRECISELY: `endedAt` is monotone WITHIN A SUB-EPISODE, not for all time. The block-signal
   *     path below does delete it, and that is not this claim being violated — a new ask opens a
   *     NEW sub-episode, which is a different statement from the old session having un-ended. The
   *     distinction is spelled out because "monotone" alone reads as contradicted by that delete.
   *   • THIS AXIS REQUIRES THE EVIDENCE TO POSTDATE THE BASELINE. `endedAt` is already recorded by
   *     then and keeps retracting; this one goes quiet.
   * So `endedAt` is the memory of a permanent fact and this is a reading of the present. Deleting
   * either would lose reds the other cannot reach.
   */
  contradicted: Map<string, number>;
}

/**
 * EVERY map in the ledger, derived from the OBJECT rather than a hand-written list (roborev job
 * 82226).
 *
 * The episode's maps share one lifetime, and that invariant is enforced at THREE sites: the
 * green-tick branch, the fleet-pruning branch, and the shared-ledger test reset. `endedAt` was added
 * to the first and forgotten at the other two, and both omissions fail OPEN — a stale mark retracts a
 * red with no evidence about the episode it is judging, silencing a live ask. Listing the maps by
 * hand is what made forgetting possible, so nothing lists them by hand any more: every field of
 * `RetractionLedger` IS a map, so `Object.values` is total by construction and a map added later is
 * included without anyone remembering to include it.
 */
function ledgerMaps(ledger: RetractionLedger): ReadonlyArray<Map<string, string | number>> {
  return Object.values(ledger) as ReadonlyArray<Map<string, string | number>>;
}

/** Forget everything this window remembers about ONE agent's episode. */
function forgetEpisode(ledger: RetractionLedger, id: string): void {
  for (const m of ledgerMaps(ledger)) m.delete(id);
}

/** An empty ledger. */
export function emptyLedger(): RetractionLedger {
  return {
    redSince: new Map(),
    movedAt: new Map(),
    session: new Map(),
    endedAt: new Map(),
    contradicted: new Map(),
  };
}

/**
 * The instant this agent acted according to ONE snapshot, or null when that snapshot shows nothing.
 *
 * A hook timestamp is only read when `lastEvent` NAMES a work event: the digest reports the last
 * event and its time as a pair, so a `Notification` at T says nothing happened at T and its
 * timestamp must not be borrowed by an older `PostToolUse` that is no longer the last event.
 *
 * Callers must not compare this to a raise time directly — see {@link noteMovement}. A snapshot that
 * shows nothing means "this tick saw nothing", never "the agent has not acted".
 */
export function lastMovementAt(evidence: MovementEvidence | undefined): number | null {
  if (evidence === undefined) return null;
  if (evidence.lastEvent === null || !WORK_EVENTS.has(evidence.lastEvent)) return null;
  const ts = evidence.lastEventMs;
  return ts !== null && Number.isFinite(ts) && ts > 0 ? ts : null;
}

/**
 * Fold this tick's evidence into the ledger's HIGH-WATER MARK. Mutates and returns the ledger.
 *
 * MONOTONIC WITHIN AN EPISODE, and that is the whole point (header note 3). `fleet.rs` reports only
 * the LAST event of any kind, so the work event that proves an agent resumed is overwritten by the
 * `Stop` that ends its turn, by a `Notification` ping, or by the agent simply dropping out of a
 * tick. Re-reading the snapshot each render would therefore un-retract a correctly retracted pill
 * seconds later. Taking the max means a quiet tick is silence, not a retraction of the evidence.
 *
 * Only agents ALREADY IN A RED EPISODE are tracked. Accumulating for everyone would grow unbounded
 * over a long session, and would also carry pre-red movement into a red that starts later — exactly
 * the ordering the retraction rule exists to enforce.
 *
 * SESSION-SCOPED (header 4b). The hook log is per-WORKTREE, so a background one-shot `claude`
 * sharing it writes tool events that look exactly like the agent resuming. The episode adopts the
 * first session it sees and rejects the rest, on `hookEvents.isMainSessionId` — the same rule the
 * watcher path gates on, imported rather than restated.
 */
export function noteMovement(
  ledger: RetractionLedger,
  evidenceOf: (id: string) => MovementEvidence | undefined,
  now: number,
): RetractionLedger {
  for (const [id, raisedAt] of ledger.redSince) {
    const evidence = evidenceOf(id);
    if (evidence === undefined) continue;
    // GATE, THEN ADOPT — AND NEVER ON THE SAME EVIDENCE. The lock starts null and
    // `isMainSessionId(null, …)` is permissive by design, so evidence that ADOPTS is measured
    // against a lock it just set: it authorizes itself. That left the episode's FIRST evidence
    // ungated — a background one-shot's `PostToolUse`, arriving before the agent's own, both took
    // the lock and retracted the red, which is precisely the substitution 4(b) refuses on every
    // later tick. It is reachable because a red can be stamped while this agent has no evidence at
    // all: `fleetWatch` publishes movement on its own poll and republishes `{}` after a failed
    // digest, so the raise tick's snapshot — the one whose newest line IS the agent's own blocking
    // event — can simply be missing. So the adopting evidence only adopts. It is still adopted from
    // ANY first event rather than only from a work event: waiting for a work event would leave the
    // lock open past the `Stop` that ends the resumed turn, and an agent that has gone quiet again
    // would never retract at all.
    // THE COST IS ONE TICK, and only for an episode whose first evidence is a work event: `fleet.rs`
    // re-reports the same `lastEvent` until a newer one replaces it, so the next poll reads that
    // same work event under a lock it did not set. Where it costs more, it costs a LINGERING pill —
    // the direction every other omission in this module also fails toward.
    const adopted = ledger.session.get(id) ?? null;

    // ── THE DERIVED MARK IS DROPPED HERE, ABOVE EVERY BRANCH ────────────────────────────────────
    //
    // `contradicted` is a reading of the PRESENT (see its field doc), so the one place it can be
    // cleared from is the one place every tick with evidence passes through. Clearing it inside the
    // branches instead left it alive across the two `continue`s below, and a mark that outlives the
    // session it was derived from is a LATCH — the exact thing this axis exists not to be.
    //
    // THE FAILURE THAT FOUND IT: session A raises a red, goes idle, and its ping correctly retracts.
    // The agent restarts as B. B blocks on an approval. B's events carry a foreign id, and the
    // re-adoption below is gated on `endedAt` — which is UNSET, because A was never observed to end
    // — so every later tick takes that `continue` and A's stale mark keeps retracting B's live ask,
    // permanently. A frozen latch never leaves red, so `forgetEpisode` never runs either. It is one
    // argument away in the suite's own terms: the "comes back the moment the agent asks again" case
    // with the second ask under a new session id fails without this line.
    //
    // Note what is NOT cleared: the `evidence === undefined` path returns ABOVE this, so a tick that
    // simply saw nothing keeps the mark. Silence is not a retraction of the evidence — the same rule
    // the movement high-water mark keeps.
    ledger.contradicted.delete(id);

    if (!isMainSessionId(adopted, evidence.sessionId)) {
      // RE-ADOPTION, AND ONLY ONCE THE ADOPTED SESSION HAS PROVABLY ENDED (roborev job 82226).
      //
      // The episode-scoped mark cannot expire for exactly the agents this axis targets: a frozen
      // latch has NO writer, so `noteRedEpochs` never sees it leave red and the episode never ends.
      // Session A ends, session B genuinely blocks on an approval, B's events take this `continue`,
      // and B's ask is silenced FOREVER — under-alerting, which the header calls the worse bug
      // because nothing tells you it was hidden. So the mark is scoped to the SESSION, not the
      // episode: once the adopted session is gone, the next session's evidence re-adopts and starts
      // a fresh sub-episode.
      //
      // GATED ON `endedAt` FOR THE REASON HEADER 4(b) GIVES. Re-adopting on ANY foreign id would
      // hand a background one-shot the lock while the agent's own session is still alive and still
      // asking — the exact substitution that gate exists to refuse. Only a session we have SEEN end
      // may be replaced, and re-adopting evidence only adopts: it never also counts as movement.
      if (ledger.endedAt.has(id) && evidence.sessionId) {
        ledger.session.set(id, evidence.sessionId);
        ledger.redSince.set(id, episodeStart(evidence.lastEventMs, now));
        ledger.movedAt.delete(id);
        // `endedAt` is deliberately KEPT — see the withdrawal below for why dropping it here made
        // this axis inert for two of the three agents the bead measured.
      }
      continue;
    }
    if (adopted === null && evidence.sessionId) {
      ledger.session.set(id, evidence.sessionId);
      continue;
    }

    // ────────────────────────────────────────────────────────────────────────────────────────────
    // ONE ADMISSIBILITY DECISION, ONE BASELINE, ONE CLASSIFICATION — read by every consumer below.
    //
    // THIS SHAPE IS THE FIX FOR A CLASS, not for a line (roborev jobs 82226, 82229, 82231, 82232,
    // 82234, 82238, 82275 — seven rounds, one sentence: a rule was established in one place and
    // applied at some of its sites). The loop body used to derive each of these where it was needed:
    // `attributed` was computed beside the `endedAt` capture and consulted by that capture ALONE,
    // while the movement capture and the block-signal withdrawal read the same `evidence` one line
    // away without it; and the episode baseline was stamped at three sites, two on the event clock
    // and one on the render clock. Deriving them ONCE, above the branches, is what makes "some of
    // its sites" unrepresentable rather than merely fixed.
    // ────────────────────────────────────────────────────────────────────────────────────────────

    // ADMISSIBILITY (roborev job 82275). `isMainSessionId` above is deliberately PERMISSIVE on a
    // falsy `sessionId` — an un-attributable event must not be mistaken for a FOREIGN one — but
    // permissive-for-passage is not proof-of-ownership. Nothing downstream of here may act on
    // evidence that does not POSITIVELY NAME the session this episode adopted: an emitter that
    // omitted `session_id` would otherwise have its `SessionEnd` recorded as the adopted session's
    // end, its work counted as this agent's movement, and its events used to withdraw a mark.
    // Refusing it costs a lingering pill; accepting it silences a live ask.
    if (adopted === null || evidence.sessionId !== adopted) continue;

    // THE BASELINE, on the EVENT clock (roborev jobs 82234, 82238). `raisedAt` is the episode's
    // raise time as the ledger currently holds it; a sub-episode below may move it, and everything
    // after that point must be judged against the NEW value rather than the captured one.
    let baseline = raisedAt;

    // WHAT THE NEWEST EVENT ITSELF SAYS. `null` = this evidence cannot tell, and every branch below
    // fails closed on it.
    const derived = derivedStatus(evidence);
    // WHEN it says it, on the event clock — UNCLAMPED, so "no usable timestamp" stays sayable.
    const evidenceAt = evidenceInstant(evidence.lastEventMs, now);

    if (stillAsking(derived)) {
      // A NEW ASK WITHDRAWS THE PROOF OF ABSENCE — and only an ask does (roborev job 82229).
      //
      // `SessionEnd(A)` is PERMANENT evidence that the ask which raised this red is gone; it is the
      // only proof that axis has. Dropping it on the new session's first event of ANY kind says
      // nothing about A's ask, and for a restarted-then-idle agent nothing could ever restore it,
      // because a live session emits no `SessionEnd` and an idle one emits no work. That made the
      // axis inert for exactly this bead's measured population.
      //
      // A WITHDRAWN MARK STARTS A NEW SUB-EPISODE (roborev job 82232). Withdrawing is not enough on
      // its own: the retraction is a disjunction, so `movedAt` alone still retracts, and it is a
      // high-water mark nothing can lower while a frozen latch never leaves red. So a restarted
      // session that did any work BEFORE it blocked stayed silenced by its own earlier
      // `PostToolUse`. A new ask is a NEW RED — it re-stamps the baseline and drops the movement
      // recorded before it, exactly as re-adoption does.
      //
      // GATED ON THE TRANSITION. `Map.delete` returns true only the first time, and `fleet.rs`
      // re-reports the same `lastEvent` until a newer one replaces it — so without that the baseline
      // would be re-stamped on every tick for as long as the block persists, which would in turn
      // keep discarding real movement. This also reaches the same-session resume path
      // (`claude --resume` reuses its `session_id`, so it never enters re-adoption above).
      if (ledger.endedAt.delete(id)) {
        baseline = episodeStart(evidence.lastEventMs, now);
        ledger.redSince.set(id, baseline);
        ledger.movedAt.delete(id);
      }
      // The agent IS asking on its newest event, so the latch and the evidence agree — and the
      // mark was already dropped above, before any branch could be taken.
    } else if (derived !== null && evidenceAt !== null && evidenceAt > baseline) {
      // THE LATCH AND THE EVIDENCE DISAGREE, AND THE EVIDENCE IS NEWER. Both are produced by the
      // same classifier over the same log, so a disagreement means the two are not looking at the
      // same event — see `RetractionLedger.contradicted`.
      //
      // `evidenceAt > baseline` IS THE CONJUNCT THAT SAYS WHICH WAY. A disagreement alone does not
      // establish that the LATCH is the stale one: the digest polls every 30s while a mounted pane
      // writes the latch live, so the digest can equally be the one that is behind — and retracting
      // then would silence an ask that is genuinely on screen right now. An event that postdates the
      // moment we first saw this red cannot be one the latch was built from, so it is evidence
      // about a state the latch never saw. Anything at or before the baseline is refused, which is
      // the same conjunct the other two axes already apply (`seen <= baseline`, `endedAt > baseline`)
      // — one rule, three sites, no exceptions.
      ledger.contradicted.set(id, evidenceAt);
    } else {
      // CANNOT TELL — an empty log, an unmodelled event, a mid-turn idle ping, a tool event after
      // the turn closed, an event whose discriminant the digest did not carry, or a timestamp that
      // is missing, broken or from the future. FAILS CLOSED: every one of those is "I cannot see
      // whether anything is being asked", which must never retract anything (bead sparkle-gazo4a).
      // The mark is already gone — dropped above, before any branch.
    }

    // DATED BY THE SHARED INSTANT, not by a second copy of the trust rule. This capture used to
    // read `evidence.lastEventMs` raw and re-derive its own validity from `endedAt <= now`, which
    // is the same question `evidenceInstant` already answers — and it answered it with LESS: no
    // finite test and no positive test, so it leaned on `endedAt > baseline` further down to reject
    // a zero or negative stamp. Same outcomes today, two rules to keep in step, and this file's
    // whole review history is a rule updated at some of its sites.
    const endedAt = evidence.lastEvent === "SessionEnd" ? evidenceAt : null;
    // FOUR CONJUNCTS, and every one fails CLOSED (red stands) when it cannot be satisfied:
    //   • the evidence names the adopted session — established once, above;
    //   • the end is TRUSTWORTHILY TIMESTAMPED — `evidenceInstant` refuses a missing, zero,
    //     non-finite or FUTURE stamp, the last because a broken clock beats every raise time and
    //     would silence this agent's reds permanently;
    //   • and it postdates the raise — a session that had already finished when the red went up
    //     cannot be the thing that raised it, and borrowing its end would retract an ask it never
    //     made.
    if (endedAt !== null && endedAt > baseline && !ledger.endedAt.has(id)) {
      ledger.endedAt.set(id, endedAt);
    }

    const seen = lastMovementAt(evidence);
    if (seen === null) continue;
    // A timestamp from the FUTURE is not evidence, it is a broken clock — and here it is the
    // dangerous direction, because it beats every raise time and would silence that agent's reds
    // permanently. `fleetVerdict.freshestEvidence` refuses future timestamps for the mirror-image
    // reason (they would mask a dead agent); this refuses them so they cannot mask a live ask.
    if (seen > now) continue;
    // Movement from BEFORE the red is not movement past it. Dropped here rather than at compare
    // time, so the high-water mark can never hold a value that predates the episode it belongs to.
    if (seen <= baseline) continue;
    const prev = ledger.movedAt.get(id);
    if (prev === undefined || seen > prev) ledger.movedAt.set(id, seen);
  }
  return ledger;
}

/**
 * Has this agent moved since its red was raised? Read off the accumulated ledger, never off a raw
 * snapshot.
 *
 * A missing entry means we have never SEEN this agent act during this episode, which is the honest
 * default: evidence, not inference — the rule `agentStall`, `fleetVerdict` and `stallEscalation` all
 * take, and it matters more here than usual, because the thing being guessed away is a request for
 * the human's attention.
 */
/**
 * Has anything moved since `at` (epoch ms)?
 *
 * THE CAPTURE-RELATIVE TWIN of {@link movedSince}, and the difference is the whole of bead
 * sparkle-5wbhn. `movedSince` compares movement against the RED EPISODE'S RAISE TIME, and
 * `noteRedEpochs` treats `waiting → approval` as ONE episode — so an agent that asks, is answered,
 * and asks again inside that episode has a `movedAt` newer than `redSince` but OLDER than the
 * capture its second ask wrote. Judging that capture with `movedSince` discards the freshest
 * evidence there is, and `mayHaveMenu` then permits a blind `enter` into a live picker.
 *
 * A caller holding a write time must therefore ask THIS, not that.
 */
export function movedSinceStamp(ledger: RetractionLedger, id: string, at: number): boolean {
  const moved = ledger.movedAt.get(id);
  return moved !== undefined && moved > at;
}

/**
 * Did the session that raised this red END during the episode? (bead sparkle-xndaze)
 *
 * Read off the accumulated ledger, never a raw snapshot — the same discipline {@link movedSince}
 * takes, and for the same reason: a snapshot that shows nothing means "this tick saw nothing", never
 * "the asker is gone". A missing entry is the honest default and leaves the red standing.
 */
export function sessionEnded(ledger: RetractionLedger, id: string): boolean {
  return ledger.endedAt.has(id);
}

/**
 * Does this agent's own newest event say it is NOT asking, while its latch says red?
 *
 * DERIVED, NOT LATCHED — see {@link RetractionLedger.contradicted}. A `false` here is "the evidence
 * agrees with the red, or could not say", and both of those must leave the red standing.
 */
export function contradicted(ledger: RetractionLedger, id: string): boolean {
  return ledger.contradicted.has(id);
}

export function movedSince(ledger: RetractionLedger, id: string): boolean {
  const raisedAt = ledger.redSince.get(id);
  if (raisedAt === undefined) return false;
  const moved = ledger.movedAt.get(id);
  return moved !== undefined && moved > raisedAt;
}

/**
 * Track when each agent's CURRENT red episode began. Mutates and returns the ledger.
 *
 * ASSIGN-ONCE while the red persists, and BOTH maps dropped the moment the agent leaves red — so a
 * later red is a NEW episode with a NEW raise time and NO inherited movement. That is the same
 * episode discipline `alertDismissal.advanceAlertRecord` keeps for dismissals, and for the same
 * reason: a red that recurs must be able to raise itself again.
 *
 * `knownIds` IS THE PRUNING BASIS, AND IT IS DELIBERATELY NOT THE STATUS MAP. Pruning "every id
 * absent from `statusMap`" looks equivalent and is not: the status map a consumer sees is PARTIAL
 * until its cross-window roster arrives (`useConciergeFeed` seeds `roster` with `null` and fills it
 * asynchronously), so a freshly-mounted consumer would delete precisely the unhosted, frozen reds
 * that only the roster knows about — and with the window-shared ledger below, those deletions reach
 * the long-lived consumer that never unmounts, re-stamping epochs no earlier movement can beat. That
 * is the resurrection path this design exists to close, re-opened through the pruning loop. So the
 * caller passes the FLEET (`projects.flatMap(p => p.agents)`), which does not depend on the roster:
 * an agent whose status is merely unknown this render keeps its episode, and only an agent that has
 * left the fleet loses it. Omit `knownIds` to skip pruning entirely.
 */
export function noteRedEpochs(
  ledger: RetractionLedger,
  statusMap: Record<string, AgentTabStatus>,
  isRed: (status: AgentTabStatus) => boolean,
  now: number,
  knownIds?: Iterable<string>,
): RetractionLedger {
  for (const [id, status] of Object.entries(statusMap)) {
    if (isRed(status)) {
      // THE INITIAL RAISE STAYS ON THE RENDER CLOCK — and this is deliberately NOT the treatment
      // the other two stamp sites get (roborev job 82238, answered rather than applied).
      //
      // `redSince` ANSWERS TWO DIFFERENT QUESTIONS, AND THAT IS WHY ONE RULE CANNOT COVER ALL THREE
      // SITES. Say it plainly, because a reviewer who does not see it re-files 82238:
      //   • at re-adoption and at the new-ask withdrawal it is a RAISE TIME — the event IS the
      //     trigger, so the event clock is DEFINITIONAL there, not an estimate;
      //   • HERE it is an OBSERVATION TIME. The trigger is the latch turning red, which is an
      //     independent signal the digest does not carry at all. The newest digest event is not
      //     evidence about when the ask happened; it is just the newest thing in another stream.
      // Two quantities sharing one variable name is the exact shape that produced the other six
      // rounds on this module — a rule established for one meaning and applied to the sites
      // carrying the other.
      //
      // Given that, the two clocks fail in OPPOSITE directions, and only one of them is survivable:
      //   • `now` is always >= every event the digest holds, so it can only ever DELAY a retraction
      //     by a poll — a lingering pill, which is the direction every omission in this module is
      //     chosen to fall in.
      //   • `evidence.lastEventMs` is an upper bound on the raise only while the digest is level
      //     with the pane. `fleet.rs` polls every 30s while a MOUNTED pane writes the latch live, so
      //     a red raised at T+30 against a digest whose newest event is T+5 would be baselined at
      //     T+5 — and the agent's own work from before the ask then counts as movement past it,
      //     silencing a live question. That is the under-alerting the header calls the worse bug.
      //
      // The phantom this bead is about is NOT fixed by lowering this baseline; it is fixed by
      // `RetractionLedger.contradicted`, which needs no estimate of the raise time at all.
      if (!ledger.redSince.has(id)) ledger.redSince.set(id, now);
    } else {
      // The episode is over: drop the raise time AND everything accumulated under it.
      forgetEpisode(ledger, id);
    }
  }
  if (knownIds !== undefined) {
    const known = knownIds instanceof Set ? knownIds : new Set(knownIds);
    for (const id of [...ledger.redSince.keys()]) {
      if (!known.has(id)) {
        // THE SAME DROP AS THE GREEN BRANCH, and it must stay that way. An agent pruned by a roster
        // refresh can return ALREADY RED — the frozen-latch case this module exists for — so a mark
        // left behind here is judged against an episode it knows nothing about.
        forgetEpisode(ledger, id);
      }
    }
  }
  return ledger;
}

/**
 * THE WINDOW'S ONE LEDGER, for the React callers.
 *
 * The doc on {@link noteRedEpochs} argues for a caller-owned ledger, and that still holds for the
 * ENGINE — `buildConciergeFeed` takes it as a parameter, so every test supplies its own and nothing
 * here reaches for shared state. What does NOT work is each React caller owning one, which is what a
 * `useRef` gives you:
 *
 *   • THE LEDGER IS LOST ON UNMOUNT, and it is the only record of when a red began. `Workspace`
 *     lives inside `ReadinessGate`/`AuthGate`/`Suspense`, so an auth lapse, a readiness overlay or a
 *     chunk re-suspend unmounts it. On remount every still-FROZEN red is stamped with a brand-new
 *     epoch, which no earlier movement can beat — so a pill that had correctly retracted comes back,
 *     and for an agent that has since gone quiet it comes back FOREVER. That is the bug resurrected
 *     by the fix for it.
 *   • TWO CALLERS, TWO ANSWERS. `Workspace` and `useHelperVitalsPublisher` (mounted in `App.tsx`,
 *     OUTSIDE those gates, so it never unmounts) both build the feed. Per-instance ledgers stamp
 *     their epochs at different mount times, so the helper island's `counts.needs_you` and the
 *     concierge column's cards can disagree about the same agent indefinitely.
 *
 * A module-level ledger is per-WINDOW (each webview is its own JS context), which is the right
 * scope: both callers describe the same fleet and must agree about it, and it outlives any one
 * component. Sharing it is only safe because {@link noteRedEpochs} prunes against the FLEET rather
 * than against one consumer's partial status view — see the note there.
 * {@link resetRetractionLedgerForTests} keeps it from leaking between test cases.
 */
const WINDOW_LEDGER: RetractionLedger = emptyLedger();

/** The window's shared ledger. React callers only — the engine takes its ledger as a parameter. */
export function windowRetractionLedger(): RetractionLedger {
  return WINDOW_LEDGER;
}

/** Clear the shared ledger. Tests only: module state that survives a case is how one test's frozen
 *  red silently decides the next one's retraction. */
export function resetRetractionLedgerForTests(): void {
  for (const m of ledgerMaps(WINDOW_LEDGER)) m.clear();
}

/**
 * De-escalate every red whose agent has demonstrably moved since that red was raised.
 *
 * Composed onto the status map like its siblings: returns the SAME reference when nothing is
 * retracted (no render churn) and never mutates the input.
 *
 * COMPOSE EARLY — against the agents' OWN statuses, BEFORE the worker-attention bubbles and the
 * rollups. A stale red that is allowed to bubble first has already been copied onto an orchestrator,
 * and retracting only the worker afterwards would leave the parent wearing a red whose owner has
 * been cleared — a card naming an agent that is not red, which is the very shape
 * `ConciergeAgent.redIsInherited` exists to prevent.
 *
 * It de-escalates rather than deletes, via `alertDismissal.deEscalatedStatus`, so a retracted row
 * lands in the same calm tier a dismissed one does (`errored` → `stopped`, everything else →
 * `idle`) instead of vanishing from a map every downstream band and sort reads.
 *
 * THE [x] IS UNAFFECTED. This removes the OBLIGATION to dismiss, not the ability: a red with no
 * movement behind it still stands, still carries its dismiss control, and is still cleared by hand
 * the moment the human wants it gone. The two paths are independent and neither consumes the other.
 */
export function withMovementRetraction<T extends { id: string }>(
  agents: readonly T[],
  statusMap: Record<string, AgentTabStatus>,
  isRed: (status: AgentTabStatus) => status is RedStatus,
  ledger: RetractionLedger,
): Record<string, AgentTabStatus> {
  let out: Record<string, AgentTabStatus> | null = null;
  const ensure = (): Record<string, AgentTabStatus> => (out ??= { ...statusMap });
  for (const a of agents) {
    const st = statusMap[a.id];
    if (st === undefined || !isRed(st)) continue;
    // THREE AXES, EITHER SUFFICIENT, and they answer different questions. Movement: the agent
    // carried on past the red, so it is not blocked any more. Session end: the agent never will,
    // because the session holding the ask is gone. Contradiction: the agent's own newest event,
    // through the SAME classifier that wrote this latch, says it is not asking — so the latch
    // predates that event and stopped being true. None of them is "we cannot see a menu" — that is
    // not evidence and must never retract anything (bead sparkle-gazo4a).
    if (!movedSince(ledger, a.id) && !sessionEnded(ledger, a.id) && !contradicted(ledger, a.id))
      continue;
    ensure()[a.id] = deEscalatedStatus(st);
  }
  return out ?? statusMap;
}
