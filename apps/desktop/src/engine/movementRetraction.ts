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
//       FIXED BY SUBTRACTION: `PreToolUse` is simply not in {@link WORK_EVENTS} any more. Keeping
//       it and excluding two tool names would need `fleet.rs` to carry the last event's tool NAME
//       (it carries the name only for `PostToolUse`, in `recentTools`) and would restate
//       `hookEvents`'s list in a second place. Dropping it costs latency and nothing else, and only
//       for an agent whose sole evidence is a tool STILL RUNNING — its `PostToolUse` retracts the
//       pill a moment later. That is the direction this module fails in everywhere else.
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
import { isMainSessionId } from "./hookEvents";

/**
 * The hook events that mean THE AGENT ACTED, by name as `fleet.rs` records them.
 *
 * See the header for why this set is not "every event": `Notification` fires ~60s into an unanswered
 * wait and `Stop` is what creates the wait, so both would retract exactly the live asks this must
 * never touch — and `PreToolUse` (header 4a) is worse than either, because for `AskUserQuestion` and
 * `ExitPlanMode` it IS the block. A tool that has actually run reports a `PostToolUse`.
 */
export const WORK_EVENTS: ReadonlySet<string> = new Set(["PostToolUse", "UserPromptSubmit"]);

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
   * The Claude Code session that event belongs to (`HookFacts.sessionId`), or null for a log that
   * carries none (an older emitter).
   *
   * REQUIRED, not optional, for the reason `FleetWatchDeps.publishMovement` is: the whole point of
   * header 4(b) is that a projection which forgets to carry it silently retracts live reds on a
   * background `claude`'s work, with every test still green. As a required field, forgetting it is
   * a compile error.
   */
  sessionId: string | null;
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
}

/** An empty ledger. */
export function emptyLedger(): RetractionLedger {
  return { redSince: new Map(), movedAt: new Map(), session: new Map() };
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
    if (!isMainSessionId(adopted, evidence.sessionId)) continue;
    if (adopted === null && evidence.sessionId) {
      ledger.session.set(id, evidence.sessionId);
      continue;
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
    if (seen <= raisedAt) continue;
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
      if (!ledger.redSince.has(id)) ledger.redSince.set(id, now);
    } else {
      // The episode is over: drop the raise time AND everything accumulated under it.
      ledger.redSince.delete(id);
      ledger.movedAt.delete(id);
      ledger.session.delete(id);
    }
  }
  if (knownIds !== undefined) {
    const known = knownIds instanceof Set ? knownIds : new Set(knownIds);
    for (const id of [...ledger.redSince.keys()]) {
      if (!known.has(id)) {
        ledger.redSince.delete(id);
        ledger.movedAt.delete(id);
        ledger.session.delete(id);
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
  WINDOW_LEDGER.redSince.clear();
  WINDOW_LEDGER.movedAt.clear();
  WINDOW_LEDGER.session.clear();
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
    if (!movedSince(ledger, a.id)) continue;
    ensure()[a.id] = deEscalatedStatus(st);
  }
  return out ?? statusMap;
}
