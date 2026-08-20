// DISPATCH-AND-CONTINUE — a queued prompt handed to a worker stops blocking the concierge's serial
// turn, WITHOUT being dropped, and comes back to be answered when its worker finishes (beads
// sparkle-3c83a, sparkle-8lwi8).
//
// ══ WHY THIS SUITE DRIVES THE REAL PATH, NOT A MOCK THAT ALREADY PARALLELIZES ══════════════════
// The founder's defect: because `turnFinished` was the ONLY thing that advanced the queue, 24–36
// prompts stacked behind one serial Claude session and were answered one-at-a-time. The fix hands the
// heavy lifting of each WAITING prompt to a separate research worker and MOVES it out of `waiting`
// (into `delegated`) so the concierge reads the next prompt at once — then `redeliverDelegated` brings
// it back to `waiting` the moment its worker terminates so the concierge always delivers an answer.
// Every row composes the REAL decision (`decideAutoDispatch`) with the REAL queue reducers (`enqueue`
// → `dequeueDispatched` → `redeliverDelegated`) over a REAL queue built by real sends.
//
// ══ THE TWO PROPERTIES THAT MATTER, PINNED FROM BOTH SIDES ═════════════════════════════════════
//   1. THE CONCIERGE IS UNBLOCKED: dispatch drops `waiting` immediately (before any worker finishes).
//   2. NOTHING IS LOST: the obligation is preserved — `outstanding` (waiting + delegated) is
//      unchanged by the hand-off, and `redeliverDelegated` returns the prompt so it is answered.
// MUTATION GUARD (the task's requirement): making `dequeueDispatched` a no-op — "advance only on
// turnFinished" — reds the property-1 assertions (`waiting` stays 2). Making `redeliverDelegated` a
// no-op reds the delivery-guarantee row (the prompt never returns to `waiting`).
import { describe, expect, it } from "vitest";

import {
  EMPTY_TURN_QUEUE,
  enqueue,
  dequeueDispatched,
  redeliverDelegated,
  redeliverReadyIds,
  REDELIVER_GRACE_MS,
  turnFinished,
  waitingCount,
  delegatedCount,
  outstandingCount,
  statusOf,
  type DelegatedPassView,
  type QueuedTurn,
  type TurnQueueState,
} from "./conciergeTurnQueue";
import {
  decideAutoDispatch,
  AUTO_DISPATCH_MIN_WAIT_MS,
  type AutoDispatchObservation,
} from "./conciergeAutoDispatch";
import { MAX_CONCURRENT_RESEARCH } from "@sparkle/core";

const T0 = 1_700_000_000_000;
const OLD = AUTO_DISPATCH_MIN_WAIT_MS + 30_000;

const q = (id: string, agedMs = OLD): QueuedTurn => ({
  bubbleId: id,
  text: `why is the ${id} build failing on origin main right now?`,
  enqueuedAt: T0 - agedMs,
});

/** Build the queue the way the host does — by sending. `run` takes the slot; the rest wait. */
function queueOf(runningId: string, ...waitingIds: string[]): TurnQueueState {
  let s = enqueue(EMPTY_TURN_QUEUE, q(runningId)).next;
  for (const id of waitingIds) s = enqueue(s, q(id)).next;
  return s;
}

function obs(s: TurnQueueState, over: Partial<AutoDispatchObservation> = {}): AutoDispatchObservation {
  return {
    waiting: s.waiting,
    liveResearch: 0,
    researchHydrated: true,
    // Required since the credential-health work landed (#2178). This literal predates it and the two
    // branches merged CLEANLY without it — git had no conflict to raise, so the gap surfaced only at
    // typecheck. Defaulting to healthy keeps every existing row asserting what it already said.
    credentialExpired: false,
    dispatched: new Map(),
    now: T0,
    ...over,
  };
}

/** The production tick's core: decide, then advance for exactly what was dispatched. */
function dispatchAndContinue(s: TurnQueueState, o: AutoDispatchObservation): {
  chosen: string[];
  advanced: TurnQueueState;
} {
  const decision = decideAutoDispatch(o);
  if (decision.action !== "dispatch") return { chosen: [], advanced: s };
  const chosen = decision.entries.map((e) => e.bubbleId);
  return { chosen, advanced: dequeueDispatched(s, chosen, o.now) };
}

describe("dequeueDispatched — hand off to a worker WITHOUT dropping the obligation", () => {
  it("MOVES the handed-off waiters to `delegated` — waiting drops, but nothing is lost", () => {
    const s = queueOf("run", "w1", "w2");
    expect([waitingCount(s), delegatedCount(s), outstandingCount(s)]).toEqual([2, 0, 2]);
    const advanced = dequeueDispatched(s, ["w1", "w2"], T0);
    // waiting dropped to 0 (concierge unblocked) …
    expect(waitingCount(advanced)).toBe(0);
    // … but the prompts are DELEGATED, not gone — outstanding is unchanged.
    expect(delegatedCount(advanced)).toBe(2);
    expect(outstandingCount(advanced)).toBe(2);
    expect(advanced.delegated.map((e) => e.bubbleId)).toEqual(["w1", "w2"]);
  });

  it("gives a delegated bubble a distinct status (not `waiting`, not null)", () => {
    const advanced = dequeueDispatched(queueOf("run", "w1"), ["w1"], T0);
    expect(statusOf(advanced, "w1")).toBe("delegated");
    expect(statusOf(advanced, "run")).toBe("working");
  });

  it("NEVER moves the running turn — only waiting is handed off", () => {
    const advanced = dequeueDispatched(queueOf("run", "w1"), ["run", "w1"], T0);
    // `.entries[0]` rather than `.bubbleId`: a turn answers a RUN of messages now, and reading a
    // bubble id straight off the run is exactly the silently-wrong access RunningRun was made a
    // typed wrapper to catch. The assertion is unchanged in meaning — the head must not move.
    expect(advanced.running?.entries[0]?.bubbleId).toBe("run");
    expect(advanced.delegated.map((e) => e.bubbleId)).toEqual(["w1"]);
  });

  it("returns the SAME state object when nothing matched (no needless re-render)", () => {
    const s = queueOf("run", "w1");
    expect(dequeueDispatched(s, ["nope"], T0)).toBe(s);
    expect(dequeueDispatched(s, [], T0)).toBe(s);
  });
});

describe("redeliverReadyIds — FAIL-SAFE: which delegated prompts come back", () => {
  // A queue with w1 delegated at T0 (dequeueDispatched stamps delegatedAt).
  const delegatedAtT0 = () => dequeueDispatched(queueOf("run", "w1"), ["w1"], T0);
  const liveW1: DelegatedPassView[] = [{ question: q("w1").text, live: true }];
  const doneW1: DelegatedPassView[] = [{ question: q("w1").text, live: false }];

  it("does NOT redeliver inside the grace window — the store may not show the worker yet", () => {
    const s = delegatedAtT0();
    // No live pass in the store yet, but only 10s since hand-off: must NOT redeliver (the race the
    // grace window exists for — otherwise the hand-off is undone before the worker appears).
    expect(redeliverReadyIds(s, [], T0 + 10_000)).toEqual([]);
  });

  it("redeliver once past grace when NO LIVE pass matches — covers finished, reaped AND vanished", () => {
    const s = delegatedAtT0();
    const past = T0 + REDELIVER_GRACE_MS + 1;
    // Terminal pass present …
    expect(redeliverReadyIds(s, doneW1, past)).toEqual(["w1"]);
    // … and the harder cases the terminal-keyed version stranded: the task VANISHED from the store …
    expect(redeliverReadyIds(s, [], past)).toEqual(["w1"]);
    // … or only OTHER tasks are live (this one was reaped).
    expect(redeliverReadyIds(s, [{ question: "unrelated", live: true }], past)).toEqual(["w1"]);
  });

  it("does NOT redeliver while a LIVE pass matches — the re-dispatch race is closed", () => {
    const s = delegatedAtT0();
    // Past grace, but a fresh worker for this exact text is running (the re-dispatch case): leave it
    // delegated. Keying on "some terminal pass" would have redelivered it while its worker just started.
    expect(redeliverReadyIds(s, liveW1, T0 + REDELIVER_GRACE_MS + 1)).toEqual([]);
    // Even with BOTH a stale terminal and a fresh live pass present (exactly the re-dispatch store):
    expect(redeliverReadyIds(s, [...doneW1, ...liveW1], T0 + REDELIVER_GRACE_MS + 1)).toEqual([]);
  });

  it("does NOT pull back a still-LIVE prompt on the clock — no wall-clock backstop (roborev 65704)", () => {
    const s = delegatedAtT0();
    // The founder had research's time limits removed ("it takes as long as it takes"). A prompt whose
    // worker is genuinely still live is NEVER redelivered on elapsed time alone — pulling it back would
    // answer with no findings. Even an hour later, a live pass keeps it delegated.
    expect(redeliverReadyIds(s, liveW1, T0 + 60 * 60_000)).toEqual([]);
  });

  it("a negative age (clock step-back) HOLDS, then RECOVERS once the clock passes the grace window", () => {
    const s = delegatedAtT0(); // delegatedAt = T0
    // Clock stepped back 30 min: `now` is BEFORE delegatedAt → hold (redelivering would undo a fresh
    // hand-off). This half was already true pre-change; the recovery half is what pins the new guard.
    expect(redeliverReadyIds(s, [], T0 - 30 * 60_000)).toEqual([]);
    // …and once the clock recovers past delegatedAt + grace, with no live pass, it comes back.
    expect(redeliverReadyIds(s, [], T0 + REDELIVER_GRACE_MS + 1)).toEqual(["w1"]);
  });

  it("a NON-FINITE age (corrupt/NaN delegatedAt) FAILS SAFE toward answering — the branch round 3 inverted", () => {
    // A NaN `delegatedAt` never recovers, so holding it would be a permanent strand. It must redeliver
    // exactly like an ordinary elapsed one (only when nothing live is coming). MUTATION: deleting the
    // `!Number.isFinite(age)` term reds this — the prompt would be held forever.
    const nanDelegated: TurnQueueState = {
      running: null,
      waiting: [],
      delegated: [{ bubbleId: "w1", text: q("w1").text, enqueuedAt: T0, delegatedAt: NaN }],
    };
    expect(redeliverReadyIds(nanDelegated, [], T0 + REDELIVER_GRACE_MS + 1)).toEqual(["w1"]);
    // …but still absence-keyed: a live pass keeps even a corrupt-stamp prompt delegated.
    expect(redeliverReadyIds(nanDelegated, liveW1, T0 + REDELIVER_GRACE_MS + 1)).toEqual([]);
  });

  it("nothing delegated → nothing ready", () => {
    expect(redeliverReadyIds(queueOf("run", "w1"), doneW1, T0 + REDELIVER_GRACE_MS + 1)).toEqual([]);
  });
});

describe("redeliverDelegated — the delivery guarantee", () => {
  it("brings a delegated prompt back to `waiting` when its worker terminates", () => {
    const delegated = dequeueDispatched(queueOf("run", "w1"), ["w1"], T0);
    expect(delegatedCount(delegated)).toBe(1);
    const back = redeliverDelegated(delegated, ["w1"]);
    // Answerable again: it is a waiting entry, no longer delegated. Nothing lost end to end.
    expect(waitingCount(back)).toBe(1);
    expect(delegatedCount(back)).toBe(0);
    expect(back.waiting.map((e) => e.bubbleId)).toEqual(["w1"]);
    expect(outstandingCount(back)).toBe(1);
  });

  it("appends behind existing waiters (researched already → cheap, but fresh input still leads)", () => {
    let s = dequeueDispatched(queueOf("run", "w1"), ["w1"], T0); // w1 delegated
    s = enqueue(s, q("fresh")).next; // a new live question arrives behind the running turn
    const back = redeliverDelegated(s, ["w1"]);
    expect(back.waiting.map((e) => e.bubbleId)).toEqual(["fresh", "w1"]);
  });

  it("is idempotent / same-identity when the bubble is not delegated", () => {
    const s = queueOf("run", "w1");
    expect(redeliverDelegated(s, ["w1"])).toBe(s); // w1 is waiting, not delegated
    expect(redeliverDelegated(s, [])).toBe(s);
  });
});

describe("dispatch-and-continue over the REAL decider + queue", () => {
  it("reads the SECOND prompt while the first is still in flight: both waiters go to workers in ONE tick, waiting drops to 0 immediately, obligation preserved", () => {
    const s = queueOf("run", "w1", "w2");
    const { chosen, advanced } = dispatchAndContinue(s, obs(s));

    // BOTH waiters handed off in one tick → two workers in flight concurrently.
    expect(chosen).toEqual(["w1", "w2"]);

    // PROPERTY 1 (concierge unblocked): waiting is 0 NOW, on dispatch — before either worker produced
    // anything. MUTATION GUARD: a no-op `dequeueDispatched` leaves this at 2 and reds the row.
    expect(waitingCount(advanced)).toBe(0);
    // PROPERTY 2 (nothing lost): the hand-off did not reduce what is owed — it moved to delegated.
    expect(outstandingCount(advanced)).toBe(2);
    expect(delegatedCount(advanced)).toBe(2);
    // The orchestrator's own turn is untouched — serial-but-fast, parallelism only in the workers.
    // `.entries[0]` rather than `.bubbleId`: a turn answers a RUN of messages now, and reading a
    // bubble id straight off the run is exactly the silently-wrong access RunningRun was made a
    // typed wrapper to catch. The assertion is unchanged in meaning — the head must not move.
    expect(advanced.running?.entries[0]?.bubbleId).toBe("run");
  });

  it("end to end: dispatch then a worker finishing DELIVERS the prompt back for the concierge to answer", () => {
    const s = queueOf("run", "w1", "w2");
    const { advanced } = dispatchAndContinue(s, obs(s)); // both delegated
    // w1's worker terminates (success or failure — the reducer does not care): it returns to waiting.
    const delivered = redeliverDelegated(advanced, ["w1"]);
    expect(delivered.waiting.map((e) => e.bubbleId)).toEqual(["w1"]);
    expect(delegatedCount(delivered)).toBe(1); // w2 still being worked
    expect(outstandingCount(delivered)).toBe(2); // still nothing lost
  });

  it("PAIRED NEGATIVE: when the queue is already served, nothing dispatches and nothing moves", () => {
    const s = queueOf("run", "w1", "w2");
    const { chosen, advanced } = dispatchAndContinue(s, obs(s, { liveResearch: 2 }));
    expect(chosen).toEqual([]);
    expect(waitingCount(advanced)).toBe(2);
    expect(delegatedCount(advanced)).toBe(0);
    expect(advanced).toBe(s); // untouched
  });

  it("bounds concurrent hand-offs by the research pool cap (MAX_CONCURRENT_RESEARCH)", () => {
    const nearCap = MAX_CONCURRENT_RESEARCH - 1; // headroom 1
    const waiters = Array.from({ length: nearCap + 2 }, (_, i) => `w${i}`); // deeper than live → not "served"
    const s = queueOf("run", ...waiters);
    const { chosen, advanced } = dispatchAndContinue(s, obs(s, { liveResearch: nearCap }));
    expect(chosen).toHaveLength(1);
    expect(waitingCount(advanced)).toBe(waiters.length - 1);
    expect(delegatedCount(advanced)).toBe(1);
  });

  it("a running turn finishing still carries delegated across (turnFinished does not drop it)", () => {
    const advanced = dispatchAndContinue(queueOf("run", "w1", "w2"), obs(queueOf("run", "w1", "w2"))).advanced;
    // With w1/w2 delegated and `run` still running, the running turn ends: delegated must survive.
    const s = { ...advanced }; // running=run, waiting=[], delegated=[w1,w2]
    const after = turnFinished(s).next;
    expect(after.running).toBeNull();
    expect(delegatedCount(after)).toBe(2);
  });
});
