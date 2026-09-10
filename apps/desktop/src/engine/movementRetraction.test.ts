// A red retracts on EVIDENCE OF MOVEMENT, and on nothing weaker — and once retracted it STAYS
// retracted.
//
// The two failure directions are not symmetric, and these cases are weighted accordingly. A red that
// lingers is the bug being fixed; a red that is wrongly retracted SILENCES A LIVE QUESTION, which is
// worse. But there is a third direction that only shows up over TIME, and it is the one that nearly
// shipped: a retraction that un-does itself on the next tick, restoring the reported bug the moment
// the agent's turn ends. Every case below is one of those three.
import { describe, expect, it } from "vitest";
import type { AgentTabStatus } from "@sparkle/ui";
import {
  WORK_EVENTS,
  contradicted,
  derivedStatus,
  emptyLedger,
  lastMovementAt,
  movedSince,
  noteMovement,
  noteRedEpochs,
  withMovementRetraction,
  sessionEnded,
  resetRetractionLedgerForTests,
  windowRetractionLedger,
  type MovementEvidence,
  type RetractionLedger,
} from "./movementRetraction";
import { isDismissibleRed } from "./alertDismissal";
import { needsAttention } from "./attention";

const RED: ReadonlySet<AgentTabStatus> = new Set<AgentTabStatus>([
  "waiting",
  "approval",
  "errored",
  "blocked",
]);
const isRed = (s: AgentTabStatus): s is "waiting" | "approval" | "errored" | "blocked" => RED.has(s);

const MAIN = "sess-main";

const ev = (
  lastEvent: string | null,
  lastEventMs: number | null,
  sessionId: string | null = MAIN,
  // `toolsRecent` is carried on the evidence for engine/goalContinuation, never read here — see
  // the field's note on MovementEvidence.
  over: Partial<MovementEvidence> = {},
): MovementEvidence => ({
  lastEvent,
  lastEventMs,
  sessionId,
  toolsRecent: null,
  // THE DISCRIMINANT DEFAULTS TO ABSENT, which is the honest default and NOT a neutral one: a
  // `Notification` with no message is Claude's idle ping (79.5% of real ones), and a `PreToolUse`
  // with no tool is a tool this build cannot name. Fixtures that mean "the agent is ASKING" must
  // say so — that is what `asking` and `picker` below are for.
  lastEventTool: null,
  lastEventMessage: null,
  // A turn left OPEN, so the turn-closed rule does not silently apply to every case that does not
  // mention it. The cases that DO care set these explicitly.
  lastTurnOpenMs: lastEventMs,
  lastTurnCloseMs: null,
  ...over,
});

/** A permission `Notification` — the agent is genuinely blocked on the human, and
 *  `hookEventToStatus` reads it as `approval`. This is `b2e57a0c`'s real shape. */
const asking = (ms: number | null, sessionId: string | null = MAIN): MovementEvidence =>
  ev("Notification", ms, sessionId, { lastEventMessage: "Claude needs your permission" });

/** Claude's IDLE PING AFTER THE TURN CLOSED — 2,544 of the 2,906 real ones on this machine, and
 *  `d5d7056e`'s actual shape (its ping follows a `Stop`). The turn boundary is set explicitly
 *  because it is load-bearing: the same message before the turn closes means something else. */
const idlePing = (ms: number | null, sessionId: string | null = MAIN): MovementEvidence =>
  ev("Notification", ms, sessionId, {
    lastEventMessage: "Claude is waiting for your input",
    lastTurnOpenMs: ms === null ? null : ms - 10_000,
    lastTurnCloseMs: ms === null ? -1 : ms - 5_000,
  });

/** THE SAME MESSAGE, MID-TURN — 362 of the 2,906. The turn never closed, so an idle prompt means
 *  the agent is stuck on something this stream cannot name, not that it finished. */
const idlePingMidTurn = (ms: number | null, sessionId: string | null = MAIN): MovementEvidence =>
  ev("Notification", ms, sessionId, {
    lastEventMessage: "Claude is waiting for your input",
    lastTurnOpenMs: ms === null ? null : ms - 10_000,
    lastTurnCloseMs: null,
  });

/** A blocking picker: `PreToolUse` for a tool that stops and waits for an answer. */
const picker = (ms: number | null, sessionId: string | null = MAIN): MovementEvidence =>
  ev("PreToolUse", ms, sessionId, { lastEventTool: "AskUserQuestion" });

/** A NON-blocking tool call — the agent working. This is `413ebe91`'s real shape. */
const toolCall = (ms: number | null, sessionId: string | null = MAIN): MovementEvidence =>
  ev("PreToolUse", ms, sessionId, { lastEventTool: "Bash" });

const T = 1_000_000;

/** One feed tick: stamp epochs, then fold in this tick's evidence — the exact order the builder
 *  uses, so a sequence of these is a timeline rather than a set of unrelated calls.
 *
 *  RAISE TICKS CARRY THE AGENT'S OWN BLOCKING EVENT, because that is what the log holds at the
 *  instant a red goes up and because the episode's session lock is taken from it. A raise tick with
 *  no evidence is a real state (`fleetWatch` publishes on its own poll) and has its own cases under
 *  "scoped to ONE session"; using it everywhere would have hidden them. */
const tick = (
  ledger: RetractionLedger,
  statusMap: Record<string, AgentTabStatus>,
  now: number,
  evidence: Record<string, MovementEvidence> = {},
): RetractionLedger => {
  noteRedEpochs(ledger, statusMap, isRed, now, Object.keys(statusMap));
  return noteMovement(ledger, (id) => evidence[id], now);
};

describe("lastMovementAt — which artifacts count as the agent ACTING", () => {
  it("reads a tool event as movement", () => {
    expect(lastMovementAt(ev("PostToolUse", T))).toBe(T);
  });

  // The founder's own gesture: he answers in the terminal, and the answer IS a UserPromptSubmit.
  it("reads the founder answering in the terminal as movement", () => {
    expect(lastMovementAt(ev("UserPromptSubmit", T))).toBe(T);
  });

  // THE CASE THAT WOULD HAVE SILENCED REAL QUESTIONS. Claude fires a `Notification` idle ping ~60s
  // into any unanswered wait (engine/statusRouter had to learn the same thing). Keying on
  // `lastEventMs` alone would read every genuine ask as "moved" a minute after it was raised.
  it("does NOT read the idle Notification ping as movement", () => {
    expect(lastMovementAt(asking(T))).toBeNull();
  });

  // A turn ENDING is what parks an agent at a prompt. Reading it as progress past a block inverts
  // the causality.
  it("does NOT read a turn ending as movement", () => {
    expect(lastMovementAt(ev("Stop", T))).toBeNull();
  });

  // ── THE EVENT THAT IS THE BLOCK ITSELF ────────────────────────────────────────────────────────
  //
  // `hookEvents.BLOCKING_TOOL_STATUS` maps an `AskUserQuestion` PreToolUse to `waiting` and an
  // `ExitPlanMode` one to `approval`: those tools announce themselves and then Claude SITS THERE,
  // with no Stop and no Notification to follow. `fleet.rs` carries only the event NAME here (the
  // tool name it keeps is `recentTools`, PostToolUse-only), so this module cannot tell that
  // PreToolUse from any other — and reading it as movement retracted the pill on the very event
  // that raised the need for it. A tool that actually RAN reports a PostToolUse; that is the signal.
  it("does NOT read a tool being announced as movement — it may BE the block", () => {
    expect(lastMovementAt(picker(T))).toBeNull();
  });

  it("has no movement to report when there is no evidence at all", () => {
    expect(lastMovementAt(undefined)).toBeNull();
    expect(lastMovementAt(ev(null, null))).toBeNull();
  });

  // fleetVerdict drops non-positive and non-finite timestamps rather than trusting them; so does
  // this, or a zeroed clock reads as "moved in 1970" and beats every raise time.
  it("ignores a zero or non-finite timestamp instead of trusting it", () => {
    expect(lastMovementAt(ev("PostToolUse", 0))).toBeNull();
    expect(lastMovementAt(ev("PostToolUse", Number.NaN))).toBeNull();
  });
});

describe("noteMovement — the high-water mark", () => {
  // ── THE REGRESSION THAT NEARLY SHIPPED ────────────────────────────────────────────────────────
  //
  // `fleet.rs` assigns `last_event` LAST-WINS over every event kind (fleet.rs:284; its own test
  // `reduces_a_stream_to_last_event_and_windowed_counts` asserts the reduction ends at "Stop"). So a
  // snapshot read would lose the work event the instant the agent's turn ended, and the pill would
  // come back — with the status frozen, forever. This is the founder's exact sequence.
  it("keeps a red retracted after the agent's turn ENDS and Stop overwrites the work event", () => {
    const l = emptyLedger();
    tick(l, { a: "blocked" }, T, { a: asking(T - 1_000) }); // red raised
    tick(l, { a: "blocked" }, T + 10, { a: ev("UserPromptSubmit", T + 5) }); // he answers
    expect(movedSince(l, "a")).toBe(true);

    tick(l, { a: "blocked" }, T + 20, { a: ev("PostToolUse", T + 15) }); // it works
    expect(movedSince(l, "a")).toBe(true);

    tick(l, { a: "blocked" }, T + 30, { a: ev("Stop", T + 25) }); // the turn ends
    expect(movedSince(l, "a")).toBe(true); // and it STAYS retracted
  });

  // The same shape via the idle ping, which overwrites a work event just as readily.
  it("keeps a red retracted when a Notification ping overwrites the work event", () => {
    const l = emptyLedger();
    tick(l, { a: "blocked" }, T, { a: asking(T - 1_000) });
    tick(l, { a: "blocked" }, T + 10, { a: ev("PostToolUse", T + 5) });
    tick(l, { a: "blocked" }, T + 70, { a: asking(T + 65) });
    expect(movedSince(l, "a")).toBe(true);
  });

  // `setAgentMovement` replaces the map WHOLESALE, so an agent missing from one digest tick has no
  // evidence that tick. Silence is not a retraction of what was already seen.
  it("keeps a red retracted through a tick with no evidence at all", () => {
    const l = emptyLedger();
    tick(l, { a: "blocked" }, T, { a: asking(T - 1_000) });
    tick(l, { a: "blocked" }, T + 10, { a: ev("PostToolUse", T + 5) });
    tick(l, { a: "blocked" }, T + 20); // agent absent from the digest
    expect(movedSince(l, "a")).toBe(true);
  });

  it("advances the mark when newer movement arrives", () => {
    const l = emptyLedger();
    tick(l, { a: "blocked" }, T, { a: asking(T - 1_000) });
    tick(l, { a: "blocked" }, T + 10, { a: ev("PostToolUse", T + 5) });
    tick(l, { a: "blocked" }, T + 20, { a: ev("PostToolUse", T + 15) });
    expect(l.movedAt.get("a")).toBe(T + 15);
  });

  it("never moves the mark backwards", () => {
    const l = emptyLedger();
    tick(l, { a: "blocked" }, T, { a: asking(T - 1_000) });
    tick(l, { a: "blocked" }, T + 20, { a: ev("PostToolUse", T + 15) });
    tick(l, { a: "blocked" }, T + 30, { a: ev("PostToolUse", T + 5) });
    expect(l.movedAt.get("a")).toBe(T + 15);
  });

  // THE DEFECT THE WHOLE DESIGN AVOIDS. An agent that asks a question has just been running, so its
  // last tool call is seconds OLD — a freshness test would read that as movement and suppress a live
  // ask. Ordering against the raise is what makes the difference.
  it("does not record the agent's last act from BEFORE it went red", () => {
    const l = emptyLedger();
    tick(l, { a: "waiting" }, T, { a: ev("PostToolUse", T - 5) });
    tick(l, { a: "waiting" }, T + 10, { a: ev("PostToolUse", T - 5) }); // still the log's last event
    expect(l.movedAt.has("a")).toBe(false);
    expect(movedSince(l, "a")).toBe(false);
  });

  it("does not record movement at the exact instant of the raise — strictly later is required", () => {
    const l = emptyLedger();
    tick(l, { a: "waiting" }, T, { a: ev("PostToolUse", T) });
    tick(l, { a: "waiting" }, T + 10, { a: ev("PostToolUse", T) });
    expect(movedSince(l, "a")).toBe(false);
  });

  // A future timestamp is a broken clock, not evidence — and it is the DANGEROUS direction: it beats
  // every raise time and would silence that agent's reds permanently. fleetVerdict refuses future
  // timestamps for the mirror-image reason.
  it("refuses a timestamp from the future", () => {
    const l = emptyLedger();
    tick(l, { a: "blocked" }, T, { a: ev("PostToolUse", T + 10_000) });
    tick(l, { a: "blocked" }, T + 10, { a: ev("PostToolUse", T + 10_000) });
    expect(movedSince(l, "a")).toBe(false);
  });

  // Tracking every agent would grow unbounded over a session, and would carry pre-red movement into
  // a red that starts later.
  it("tracks only agents that are currently in a red episode", () => {
    const l = emptyLedger();
    tick(l, { a: "working" }, T, { a: ev("PostToolUse", T + 5) });
    expect(l.movedAt.has("a")).toBe(false);
  });
});

// ── WHOSE WORK WAS IT ────────────────────────────────────────────────────────────────────────────
//
// The hook log is keyed by WORKTREE, not by session — which is the entire reason
// `hookEvents.HookStatusEngine` carries a session lock. A background one-shot `claude` in the same
// worktree writes a full SessionStart→…→SessionEnd into the same file, and its `PostToolUse` is
// indistinguishable from the agent's own by name. Believing it retracts a red the agent never moved
// past, which is the failure this module weighs heaviest.
describe("noteMovement — the episode is scoped to ONE session", () => {
  it("refuses a background session's tool call in the agent's worktree", () => {
    const l = emptyLedger();
    // The raise tick already shows the agent's own session — the newest line at the moment it went
    // red is its own blocking event, not somebody else's.
    tick(l, { a: "waiting" }, T, { a: asking(T - 1_000, MAIN) });
    tick(l, { a: "waiting" }, T + 10_000, { a: ev("PostToolUse", T + 8_000, "sess-oneshot") });
    expect(movedSince(l, "a")).toBe(false);
  });

  it("accepts the agent's OWN work after refusing a foreign session's", () => {
    const l = emptyLedger();
    tick(l, { a: "waiting" }, T, { a: asking(T - 1_000, MAIN) });
    tick(l, { a: "waiting" }, T + 10_000, { a: ev("PostToolUse", T + 8_000, "sess-oneshot") });
    tick(l, { a: "waiting" }, T + 20_000, { a: ev("PostToolUse", T + 18_000, MAIN) });
    expect(movedSince(l, "a")).toBe(true);
  });

  // ── PERMISSIVE FOR PASSAGE IS NOT PROOF OF OWNERSHIP (roborev job 82275) ──────────────────────
  //
  // `isMainSessionId` accepts an event carrying no `session_id` — it must, because an
  // UNATTRIBUTABLE event must not be mistaken for a FOREIGN one and send the episode blind. But
  // being let past the session gate is not the same fact as belonging to this episode's session,
  // and the loop body used to read them as one: `attributed` was computed beside the `endedAt`
  // capture and consulted by that capture ALONE, while the movement capture and the block-signal
  // withdrawal read the same evidence one line away without it.
  //
  // THIS TEST USED TO ASSERT THE OPPOSITE, AND IT WAS VACUOUS EITHER WAY: its raise tick was ALSO
  // null-id, so no session was ever adopted and `adopted !== null` was what answered — the conjunct
  // under test was never reached. It now adopts a real session first, which is the only arrangement
  // in which the question can be asked at all.
  it("does NOT move on evidence that cannot name the session it belongs to", () => {
    const l = emptyLedger();
    tick(l, { a: "blocked" }, T, { a: asking(T - 1_000) });
    tick(l, { a: "blocked" }, T + 10, { a: ev("PostToolUse", T + 5, null) });
    expect(
      movedSince(l, "a"),
      "an un-attributable work event is not this agent's movement",
    ).toBe(false);
    expect(
      withMovementRetraction([{ id: "a" }], { a: "blocked" }, isRed, l).a,
      "and it must not retract the red either",
    ).toBe("blocked");
  });

  // THE PAIRED POSITIVE, so the test above cannot be satisfied by refusing everything: the SAME
  // work event, carrying the adopted session's id, does move.
  it("…and DOES move on the identical event once it names the adopted session", () => {
    const l = emptyLedger();
    tick(l, { a: "blocked" }, T, { a: asking(T - 1_000) });
    tick(l, { a: "blocked" }, T + 10, { a: ev("PostToolUse", T + 5, MAIN) });
    expect(movedSince(l, "a")).toBe(true);
  });

  // ── THE ADOPTING EVIDENCE MUST NOT AUTHORIZE ITSELF ───────────────────────────────
  //
  // The two cases above hand the raise tick the agent's own event, so the lock is already set by the
  // time the background session shows up. The hole is the tick where it is NOT: `fleetWatch`
  // publishes movement on its own poll (and republishes `{}` after a failed digest), so a red can be
  // stamped during a window where this agent has no evidence at all. The FIRST evidence to arrive
  // then took the lock AND was measured against it in the same pass — and `isMainSessionId(null, …)`
  // is permissive by design, so a background one-shot's `PostToolUse` retracted a live ask on work
  // the agent never did. That is exactly the substitution the session lock exists to refuse,
  // arriving one tick too early to be refused.
  //
  // Asserted on the STATUS the card is built from, not on the ledger's internals: the failure being
  // pinned is a pill that disappears while the question is still unanswered.
  it("refuses a foreign session's work when it is the FIRST evidence of the episode", () => {
    const l = emptyLedger();
    tick(l, { a: "waiting" }, T); // red stamped before any digest tick has landed
    tick(l, { a: "waiting" }, T + 10_000, { a: ev("PostToolUse", T + 8_000, "sess-oneshot") });
    expect(withMovementRetraction([{ id: "a" }], { a: "waiting" }, isRed, l).a).toBe("waiting");
  });

  // The cost of the rule above, stated so it cannot be widened by accident: the agent's OWN first
  // work event is not lost, only deferred. `fleet.rs` re-reports the same `lastEvent` on every poll
  // until a newer one replaces it, so the next tick reads it under a lock it did not set.
  it("still retracts on the agent's own work, one tick after that work took the lock", () => {
    const l = emptyLedger();
    tick(l, { a: "waiting" }, T);
    tick(l, { a: "waiting" }, T + 10_000, { a: ev("PostToolUse", T + 8_000, MAIN) }); // takes the lock
    tick(l, { a: "waiting" }, T + 20_000, { a: ev("PostToolUse", T + 8_000, MAIN) }); // same event
    expect(withMovementRetraction([{ id: "a" }], { a: "waiting" }, isRed, l).a).toBe("idle");
  });

  // Adopt-once must not become lock-forever. An agent RESTARTED in the terminal comes back under a
  // new session id, and it must be believed again — the episode boundary is where that is granted,
  // exactly as it is for the raise time and the movement mark.
  it("drops the adopted session when the episode ends, so a restarted agent is believed again", () => {
    const l = emptyLedger();
    tick(l, { a: "blocked" }, T, { a: asking(T - 1_000, MAIN) });
    expect(l.session.get("a")).toBe(MAIN);

    tick(l, { a: "working" }, T + 20_000);
    expect(l.session.has("a")).toBe(false);

    tick(l, { a: "blocked" }, T + 30_000, { a: ev("Stop", T + 29_000, "sess-after-restart") });
    tick(l, { a: "blocked" }, T + 40_000, { a: ev("PostToolUse", T + 38_000, "sess-after-restart") });
    expect(movedSince(l, "a")).toBe(true);
  });
});

describe("noteRedEpochs — one raise time per red EPISODE", () => {
  it("stamps a red on first sight and does not re-stamp it while it persists", () => {
    const l = emptyLedger();
    tick(l, { a: "blocked" }, T);
    tick(l, { a: "blocked" }, T + 5_000);
    expect(l.redSince.get("a")).toBe(T);
  });

  // Assign-once must not become latch-forever: a red that clears and returns is a NEW episode, and
  // the movement that ended the OLD one must not retract it on sight.
  it("drops the epoch AND the movement when the agent leaves red", () => {
    const l = emptyLedger();
    tick(l, { a: "blocked" }, T, { a: asking(T - 1_000) });
    tick(l, { a: "blocked" }, T + 10, { a: ev("PostToolUse", T + 5) });
    expect(movedSince(l, "a")).toBe(true);

    tick(l, { a: "working" }, T + 20);
    expect(l.redSince.has("a")).toBe(false);
    expect(l.movedAt.has("a")).toBe(false);

    // Second block, with the SAME (now stale) movement still on record in the digest.
    tick(l, { a: "blocked" }, T + 30, { a: ev("PostToolUse", T + 5) });
    tick(l, { a: "blocked" }, T + 40, { a: ev("PostToolUse", T + 5) });
    expect(l.redSince.get("a")).toBe(T + 30);
    expect(movedSince(l, "a")).toBe(false);
  });

  // ── THE PRUNE THAT MUST NOT USE THE STATUS MAP ────────────────────────────────────────────────
  //
  // A consumer's status view is PARTIAL until its cross-window roster arrives, and the ledger is
  // shared between consumers. Pruning "absent from statusMap" therefore let a just-mounted consumer
  // wipe exactly the unhosted frozen reds only the roster knows about — for every consumer at once,
  // including the one that never unmounts. Pruning against the FLEET cannot do that.
  it("keeps an episode whose agent is missing from a PARTIAL status view", () => {
    const l = emptyLedger();
    tick(l, { a: "blocked" }, T, { a: asking(T - 1_000) });
    tick(l, { a: "blocked" }, T + 10, { a: ev("PostToolUse", T + 5) });

    // A render where the roster has not arrived: `a` is simply not in the status map, but it IS
    // still in the fleet.
    noteRedEpochs(l, {}, isRed, T + 20, ["a"]);
    expect(l.redSince.get("a")).toBe(T);
    expect(movedSince(l, "a")).toBe(true);
  });

  it("drops an agent that has left the fleet", () => {
    const l = emptyLedger();
    tick(l, { a: "blocked" }, T);
    noteRedEpochs(l, {}, isRed, T + 10, []);
    expect(l.redSince.has("a")).toBe(false);
    expect(l.movedAt.has("a")).toBe(false);
  });

  it("prunes nothing when the caller supplies no fleet", () => {
    const l = emptyLedger();
    tick(l, { a: "blocked" }, T);
    noteRedEpochs(l, {}, isRed, T + 10);
    expect(l.redSince.get("a")).toBe(T);
  });

  it("keeps each agent's episode separate", () => {
    const l = emptyLedger();
    tick(l, { a: "blocked" }, T);
    tick(l, { a: "blocked", b: "waiting" }, T + 3_000);
    expect(l.redSince.get("a")).toBe(T);
    expect(l.redSince.get("b")).toBe(T + 3_000);
  });
});

describe("withMovementRetraction — the overlay", () => {
  const agents = [{ id: "a" }, { id: "b" }];

  /** A ledger where `a` is blocked and has moved since. */
  const movedLedger = (): RetractionLedger => {
    const l = emptyLedger();
    tick(l, { a: "blocked", b: "working" }, T, { a: asking(T - 1_000) });
    tick(l, { a: "blocked", b: "working" }, T + 10, { a: ev("PostToolUse", T + 5) });
    return l;
  };

  it("de-escalates a blocked agent that has moved since the block", () => {
    const out = withMovementRetraction(agents, { a: "blocked", b: "working" }, isRed, movedLedger());
    expect(out.a).toBe("idle");
  });

  // `errored` de-escalates to `stopped`, not `idle` — the same split alertDismissal uses, so a
  // retracted row lands in the tier a dismissed one would.
  it("de-escalates errored to stopped, matching the dismissal path", () => {
    const l = emptyLedger();
    tick(l, { a: "errored" }, T, { a: asking(T - 1_000) });
    tick(l, { a: "errored" }, T + 10, { a: ev("PostToolUse", T + 5) });
    expect(withMovementRetraction(agents, { a: "errored" }, isRed, l).a).toBe("stopped");
  });

  it("leaves a red with no movement behind it exactly as it was", () => {
    const l = emptyLedger();
    tick(l, { a: "blocked" }, T);
    expect(withMovementRetraction(agents, { a: "blocked" }, isRed, l).a).toBe("blocked");
  });

  // The no-op contract every sibling overlay keeps (unmergedAttention, alertDismissal,
  // stallEscalation): same reference when nothing changed, so this cannot churn renders.
  it("returns the SAME reference when nothing is retracted", () => {
    const l = emptyLedger();
    const map: Record<string, AgentTabStatus> = { a: "blocked", b: "working" };
    tick(l, map, T);
    expect(withMovementRetraction(agents, map, isRed, l)).toBe(map);
  });

  it("never mutates the input map", () => {
    const map: Record<string, AgentTabStatus> = { a: "blocked", b: "working" };
    withMovementRetraction(agents, map, isRed, movedLedger());
    expect(map.a).toBe("blocked");
  });

  it("leaves a non-red status alone even when the agent is moving", () => {
    expect(withMovementRetraction(agents, { b: "working" }, isRed, movedLedger()).b).toBe("working");
  });

  it("retracts only the agent that moved, leaving its still-blocked sibling red", () => {
    const l = emptyLedger();
    tick(l, { a: "blocked", b: "blocked" }, T, { a: asking(T - 1_000) });
    tick(l, { a: "blocked", b: "blocked" }, T + 10, { a: ev("PostToolUse", T + 5) });
    expect(withMovementRetraction(agents, { a: "blocked", b: "blocked" }, isRed, l)).toEqual({
      a: "idle",
      b: "blocked",
    });
  });

  // Evidence, not inference: a red whose beginning was never observed is not retractable on a guess.
  it("does not retract a red it never saw begin", () => {
    const l = emptyLedger();
    l.movedAt.set("a", T + 5_000); // movement on record, but no episode
    expect(withMovementRetraction(agents, { a: "blocked" }, isRed, l).a).toBe("blocked");
  });
});

describe("the WORK_EVENTS vocabulary matches what the hook actually writes", () => {
  // The names are produced by src-tauri/src/fleet.rs's parser, which matches on these exact strings.
  // A rename there with no change here would silently stop every retraction, so this states the
  // coupling rather than leaving it to be rediscovered.
  //
  // `PreToolUse` IS NOT ONE OF THEM, and that absence is load-bearing rather than an oversight: for
  // `AskUserQuestion` and `ExitPlanMode` it is the block, not progress past it. Anything added here
  // must be an event the agent can only emit by having ACTED.
  it("names the two events that mean the agent acted", () => {
    expect([...WORK_EVENTS].sort()).toEqual(["PostToolUse", "UserPromptSubmit"]);
  });
});

// ── THE ASK WHOSE SESSION IS GONE (bead sparkle-xndaze) ──────────────────────────────────────────
//
// THE MEASURED DEFECT. Three agents carried "Needs you" / "Approve?" CONTINUOUSLY for over 24 hours
// while `read_picker_options` answered `{present: false, blind: "no-menu"}` on six separate checks —
// and `no-menu` is not blindness, it is the documented "nothing on screen resolves to a menu"
// (services/conciergeTools/terminal.ts). Two of the three had their sessions replaced by a restart.
//
// WHY NOTHING COULD CLEAR IT, and it is this module. A red is derived from `runtimeStore.status`,
// which is a LATCH written only by a mounted pane — this module's own header calls it "a FROZEN LAST
// READING with no writer that can ever retract it". The one retraction path is MOVEMENT, and
// movement requires the agent to ACT. An agent whose session was replaced never acts again under the
// session that raised the ask, so `noteMovement`'s session gate discards every later observation and
// the red stands forever. The guard that protects a live red from a background `claude` is the same
// guard that freezes a dead one.
//
// THE EVIDENCE USED, and why it is free: `SessionEnd` is already emitted by `sparkle-hook.mjs` into
// the worktree log the digest already reads, and `MovementEvidence` already carries `sessionId`. A
// session that has ENDED cannot still be asking anything, so its ask may be retracted — not because
// nothing is visible, but because the asker is provably gone.
//
// THE TRAP THIS MUST NOT FALL INTO (bead sparkle-gazo4a, and the whole reason the cases below come
// in pairs): "I cannot see a menu" must NEVER clear a red on its own. A genuinely blocked agent
// whose pane is simply unmounted still needs the human. Only positive evidence that the ASKING
// SESSION ENDED may retract, and every unknown fails CLOSED — red stands.
describe("session-end retraction — the ask whose session is gone", () => {
  it("retracts a red once the session that raised it has ENDED", () => {
    const l = emptyLedger();
    // The raise tick carries the agent's own blocking event, so the episode locks onto its session.
    tick(l, { a: "approval" }, T, { a: asking(T) });
    // The agent is restarted: its session emits SessionEnd. Nothing has "moved" — it never acts
    // again — so movement alone can never retract this.
    tick(l, { a: "approval" }, T + 30_000, { a: ev("SessionEnd", T + 25_000) });

    expect(movedSince(l, "a"), "the agent never acted, so this axis stays false").toBe(false);
    expect(sessionEnded(l, "a"), "but its asking session is provably gone").toBe(true);
    expect(
      withMovementRetraction([{ id: "a" }], { a: "approval" }, isRed, l).a,
      "so the row must stop claiming it needs the human",
    ).not.toBe("approval");
  });

  // ── THE PAIRED NEGATIVES. Each is a state that LOOKS like the case above from one angle and must
  //    still leave the red standing. Without these the fix above is satisfied by "always retract".
  it("does NOT retract when the pane is merely unmounted — no evidence is not evidence", () => {
    const l = emptyLedger();
    tick(l, { a: "approval" }, T, { a: asking(T) });
    // The pane closes. `fleetWatch` still polls, and publishes nothing for this agent.
    tick(l, { a: "approval" }, T + 30_000, {});
    tick(l, { a: "approval" }, T + 60_000, {});

    expect(sessionEnded(l, "a"), "silence is not a SessionEnd").toBe(false);
    expect(withMovementRetraction([{ id: "a" }], { a: "approval" }, isRed, l).a).toBe("approval");
  });

  it("does NOT retract on a SessionEnd belonging to a DIFFERENT session", () => {
    const l = emptyLedger();
    tick(l, { a: "approval" }, T, { a: asking(T) });
    // A background one-shot `claude` in the same worktree finishes. Its SessionEnd is the newest
    // line in the log, and it says nothing about the agent's own ask — the substitution this
    // module's header 4(b) already refuses for movement, refused here for the same reason.
    tick(l, { a: "approval" }, T + 30_000, { a: ev("SessionEnd", T + 25_000, "sess-oneshot") });

    expect(sessionEnded(l, "a"), "another session ending is not this ask ending").toBe(false);
    expect(withMovementRetraction([{ id: "a" }], { a: "approval" }, isRed, l).a).toBe("approval");
  });

  it("does NOT retract when the log carries NO session id — unknown fails closed", () => {
    const l = emptyLedger();
    tick(l, { a: "approval" }, T, { a: asking(T, null) });
    // An older emitter: a SessionEnd we cannot attribute to anyone. "I do not know whose this is"
    // is not "the asker is gone".
    tick(l, { a: "approval" }, T + 30_000, { a: ev("SessionEnd", T + 25_000, null) });

    expect(sessionEnded(l, "a"), "an unattributable end proves nothing").toBe(false);
    expect(withMovementRetraction([{ id: "a" }], { a: "approval" }, isRed, l).a).toBe("approval");
  });

  // THE CASE THE ONE ABOVE CANNOT REACH, and the fail-open it was hiding. Above, the RAISE tick is
  // also null-id, so nothing is ever adopted and `adopted !== null` is what refuses — the conjunct
  // is never asked the question it exists for. With a session ADOPTED, an unattributable `SessionEnd`
  // passes `isMainSessionId`'s deliberately-permissive falsy arm, reaches the capture with
  // `adopted !== null` TRUE, and would be recorded as THAT session's end. "I cannot tell whose this
  // is" must not become "the asker is gone".
  it("does NOT record an unattributable SessionEnd against the session it DID adopt", () => {
    const l = emptyLedger();
    tick(l, { a: "approval" }, T, { a: asking(T) }); // adopts MAIN
    tick(l, { a: "approval" }, T + 30_000, { a: ev("SessionEnd", T + 25_000, null) });

    expect(sessionEnded(l, "a"), "an end nobody owns is not MAIN's end").toBe(false);
    expect(withMovementRetraction([{ id: "a" }], { a: "approval" }, isRed, l).a).toBe("approval");
  });

  it("does NOT retract on a SessionEnd that PREDATES the red — the ask outlived it", () => {
    const l = emptyLedger();
    // A session ended, and only afterwards did a red go up. Whatever raised it, it was not the ask
    // of a session that had already finished.
    tick(l, { a: "approval" }, T, { a: ev("SessionEnd", T - 60_000) });
    tick(l, { a: "approval" }, T + 30_000, { a: ev("SessionEnd", T - 60_000) });

    expect(sessionEnded(l, "a")).toBe(false);
    expect(withMovementRetraction([{ id: "a" }], { a: "approval" }, isRed, l).a).toBe("approval");
  });

  it("drops the ended mark with the episode, so a LATER red is judged on its own evidence", () => {
    const l = emptyLedger();
    tick(l, { a: "approval" }, T, { a: asking(T) });
    tick(l, { a: "approval" }, T + 30_000, { a: ev("SessionEnd", T + 25_000) });
    expect(sessionEnded(l, "a")).toBe(true);

    // The agent comes back and goes green — the episode is over.
    tick(l, { a: "working" }, T + 60_000, { a: ev("SessionStart", T + 55_000, "sess-two") });
    // …then raises a NEW ask under the new session. That ask is live and nobody has ended it.
    tick(l, { a: "approval" }, T + 90_000, { a: asking(T + 85_000, "sess-two") });

    expect(sessionEnded(l, "a"), "the new episode inherits nothing from the old one").toBe(false);
    expect(withMovementRetraction([{ id: "a" }], { a: "approval" }, isRed, l).a).toBe("approval");
  });
});

// ── THE THREE LIFETIME HOLES IN THE SESSION-END MARK (roborev job 82226) ─────────────────────────
//
// All three are the same shape and all three FAIL OPEN — they silence a live ask, which this
// module's header calls the worse bug "because nothing tells you it was hidden". The mark was added
// to the episode-end branch and to nothing else.
describe("session-end retraction — the mark's lifetime", () => {
  // (1) The fleet-pruning branch dropped three maps and not the fourth. An agent that transiently
  //     leaves the roster keeps its mark, and comes back already red — the frozen-latch case this
  //     module exists for — so the very first tick retracts with no evidence about the new episode.
  it("drops the mark when the agent is pruned from the fleet, not just when it goes green", () => {
    const l = emptyLedger();
    tick(l, { a: "approval" }, T, { a: asking(T) });
    tick(l, { a: "approval" }, T + 30_000, { a: ev("SessionEnd", T + 25_000) });
    expect(sessionEnded(l, "a")).toBe(true);

    // `a` leaves the known fleet — a roster refresh, not a status change.
    noteRedEpochs(l, {}, isRed, T + 60_000, []);
    // …and comes back ALREADY RED, which is the whole point: no green tick ever happens.
    noteRedEpochs(l, { a: "approval" }, isRed, T + 90_000, ["a"]);

    expect(sessionEnded(l, "a"), "a pruned episode must take its mark with it").toBe(false);
    expect(withMovementRetraction([{ id: "a" }], { a: "approval" }, isRed, l).a).toBe("approval");
  });

  // (2) The window-shared ledger's test reset forgot the map, so one case's SessionEnd decides the
  //     next case's retraction — a false green in the direction this module must fail closed.
  it("clears the mark on the shared-ledger reset, so one case cannot decide the next", () => {
    const w = windowRetractionLedger();
    noteRedEpochs(w, { a: "approval" }, isRed, T, ["a"]);
    noteMovement(w, () => asking(T), T);
    noteMovement(w, () => ev("SessionEnd", T + 25_000), T + 30_000);
    expect(sessionEnded(w, "a"), "precondition: the mark is set").toBe(true);

    resetRetractionLedgerForTests();
    expect(sessionEnded(windowRetractionLedger(), "a"), "the reset must forget it").toBe(false);
  });

  // (3) THE ONE THAT MATTERS, and the reason the fix was under-alerting. For the agents this whole
  //     change targets — a frozen latch with NO writer — the episode can NEVER end, so an
  //     episode-scoped mark is a PERMANENT retraction. Session A ends; session B genuinely blocks on
  //     an approval; B's events take the `isMainSessionId` continue, nothing clears the mark, and B's
  //     ask is silenced forever. Note there is deliberately no non-red tick anywhere below: driving
  //     status to "working" first is exactly the transition an unmounted pane cannot produce, and it
  //     is what made the earlier SessionStart case pass over this hole.
  it("lets a LATER session's ask stand, with no green tick to end the episode", () => {
    const l = emptyLedger();
    tick(l, { a: "approval" }, T, { a: asking(T) });
    tick(l, { a: "approval" }, T + 30_000, { a: ev("SessionEnd", T + 25_000) });
    expect(sessionEnded(l, "a"), "session A is gone").toBe(true);

    // A new session starts and raises its OWN ask. The status latch never moved — it has no writer.
    tick(l, { a: "approval" }, T + 60_000, { a: ev("SessionStart", T + 55_000, "sess-two") });
    tick(l, { a: "approval" }, T + 90_000, { a: asking(T + 85_000, "sess-two") });

    expect(sessionEnded(l, "a"), "B's ask is live and nothing has ended B").toBe(false);
    expect(
      withMovementRetraction([{ id: "a" }], { a: "approval" }, isRed, l).a,
      "silencing a live ask is worse than the phantom this fix removes",
    ).toBe("approval");
  });

  // …and the PAIRED half of (3): re-adoption must not hand a background one-shot the power to
  // retract a live red. It may only happen once the adopted session has PROVABLY ended.
  it("does not re-adopt a foreign session while the adopted one is still alive", () => {
    const l = emptyLedger();
    tick(l, { a: "approval" }, T, { a: asking(T) });
    // A one-shot runs and does work. Session A has NOT ended, so this must neither re-adopt nor count.
    tick(l, { a: "approval" }, T + 30_000, { a: ev("PostToolUse", T + 25_000, "sess-oneshot") });

    expect(movedSince(l, "a"), "a foreign session's work is not this agent moving").toBe(false);
    expect(withMovementRetraction([{ id: "a" }], { a: "approval" }, isRed, l).a).toBe("approval");
  });
});

// ── THE RESTARTED-AND-IDLE AGENT, which is TWO OF THE BEAD'S THREE (roborev job 82229) ───────────
//
// `sparkle-xndaze` measured three agents holding "Needs you" for over 24 hours, **two of them
// restarted**. The previous commit dropped `endedAt` the moment ANY event arrived under a new
// session — which withdraws the only proof of absence this axis has, on evidence that says nothing
// about the ask that raised the red. For a restarted-then-idle agent nothing can ever restore it: the
// new session is alive so it emits no `SessionEnd`, and idle so it emits no work event. The axis was
// therefore INERT for exactly the population it was written for, and the previous suite pinned that
// outcome as correct.
//
// So the mark now SURVIVES re-adoption and is cleared only by a RED-RAISING signal from the new
// session — a `Notification`, which is Claude's own "waiting on the human" ping (the event this
// module's header already singles out as the picker being unanswered rather than progress past it).
// Absence of an ask keeps the retraction; a new ask reinstates the red.
describe("session-end retraction — a restarted agent that then sits idle", () => {
  it("stays retracted when the new session is IDLE — the bead's measured population", () => {
    const l = emptyLedger();
    tick(l, { a: "approval" }, T, { a: asking(T) });
    tick(l, { a: "approval" }, T + 30_000, { a: ev("SessionEnd", T + 25_000) });
    // The agent restarts. Its new session announces itself and then does nothing at all.
    tick(l, { a: "approval" }, T + 60_000, { a: ev("SessionStart", T + 55_000, "sess-two") });
    tick(l, { a: "approval" }, T + 90_000, { a: ev("SessionStart", T + 55_000, "sess-two") });
    tick(l, { a: "approval" }, T + 120_000, { a: ev("SessionStart", T + 55_000, "sess-two") });

    expect(sessionEnded(l, "a"), "nothing has asked since A ended").toBe(true);
    expect(
      withMovementRetraction([{ id: "a" }], { a: "approval" }, isRed, l).a,
      "this is the 24-hour phantom the bead reported",
    ).not.toBe("approval");
  });

  it("reinstates the red when the NEW session raises its own ask", () => {
    const l = emptyLedger();
    tick(l, { a: "approval" }, T, { a: asking(T) });
    tick(l, { a: "approval" }, T + 30_000, { a: ev("SessionEnd", T + 25_000) });
    // The new session waits on the human. `fleet.rs` re-reports the same lastEvent until a newer one
    // replaces it, so the re-adopting tick and the tick that READS it are separate — the adopting
    // evidence only adopts, exactly as it does for movement.
    tick(l, { a: "approval" }, T + 60_000, { a: asking(T + 55_000, "sess-two") });
    tick(l, { a: "approval" }, T + 90_000, { a: asking(T + 55_000, "sess-two") });

    expect(sessionEnded(l, "a"), "a live ask withdraws the proof of absence").toBe(false);
    expect(withMovementRetraction([{ id: "a" }], { a: "approval" }, isRed, l).a).toBe("approval");
  });

  it("does not let the OLD session's raise time license a retraction of the new one", () => {
    const l = emptyLedger();
    tick(l, { a: "approval" }, T, { a: asking(T) });
    tick(l, { a: "approval" }, T + 30_000, { a: ev("SessionEnd", T + 25_000) });
    // B does work. Re-adoption must re-stamp the sub-episode's baseline, or this event — older than
    // the new episode but NEWER than A's raise time — reads as movement past a red it predates.
    tick(l, { a: "approval" }, T + 60_000, { a: ev("PostToolUse", T + 55_000, "sess-two") });
    tick(l, { a: "approval" }, T + 90_000, { a: ev("PostToolUse", T + 55_000, "sess-two") });
    // …and then B genuinely blocks. A high-water `movedAt` inherited from A's baseline would silence
    // this permanently, because nothing can lower it while the latch never leaves red.
    tick(l, { a: "approval" }, T + 120_000, { a: asking(T + 115_000, "sess-two") });
    tick(l, { a: "approval" }, T + 150_000, { a: asking(T + 115_000, "sess-two") });

    expect(movedSince(l, "a"), "B's work predates B's own episode baseline").toBe(false);
    expect(
      withMovementRetraction([{ id: "a" }], { a: "approval" }, isRed, l).a,
      "B's live ask must survive B's own earlier work",
    ).toBe("approval");
  });
});

// ── THE OTHER BLOCK SHAPE, which fires NO Notification (roborev job 82231) ────────────────────────
//
// Header 4(a) of the module is explicit: `AskUserQuestion` → `waiting` and `ExitPlanMode` → `approval`
// "fire their `PreToolUse` and then Claude SITS THERE waiting for an answer — no Stop, and, unlike a
// permission request, no Notification." So `PreToolUse` IS the event meaning "this agent is now
// blocked on you" for those tools — which is exactly why it was subtracted from WORK_EVENTS.
//
// A clear-predicate recognising only `Notification` therefore silences a restarted session that
// blocks via one of those tools PERMANENTLY: the last event stays `PreToolUse` forever, which clears
// nothing and counts as no movement, so the previous session's mark can never be withdrawn. Same
// fail-open as job 82229's finding 2, reintroduced for the other half of the block taxonomy.
describe("session-end retraction — a restart that blocks with no Notification", () => {
  it("reinstates the red when the new session blocks via PreToolUse", () => {
    const l = emptyLedger();
    tick(l, { a: "approval" }, T, { a: asking(T) });
    tick(l, { a: "approval" }, T + 30_000, { a: ev("SessionEnd", T + 25_000) });
    // The agent restarts and blocks on a plan approval. Note there is no `Notification` ANYWHERE
    // after the restart — that is the whole point of this shape.
    tick(l, { a: "approval" }, T + 60_000, { a: picker(T + 55_000, "sess-two") });
    tick(l, { a: "approval" }, T + 90_000, { a: picker(T + 55_000, "sess-two") });
    tick(l, { a: "approval" }, T + 120_000, { a: picker(T + 55_000, "sess-two") });

    expect(sessionEnded(l, "a"), "the new session is itself blocked").toBe(false);
    expect(movedSince(l, "a"), "and PreToolUse is not movement past a block").toBe(false);
    expect(
      withMovementRetraction([{ id: "a" }], { a: "approval" }, isRed, l).a,
      "a plan-approval block must not be silenced by the previous session's mark",
    ).toBe("approval");
  });
});

// ── A WITHDRAWN MARK IS A NEW SUB-EPISODE, not merely one axis lost (roborev job 82232) ───────────
//
// `withMovementRetraction` is `!movedSince && !sessionEnded` — EITHER axis alone retracts. So
// clearing `endedAt` cannot reinstate a red while `movedAt` still holds, and `movedAt` is a
// high-water mark nothing can lower while a frozen latch never leaves red and nothing re-stamps the
// baseline a second time. A restarted session that does any work BEFORE it blocks was therefore
// still silenced permanently — the same fail-open, for the same population, one axis over.
//
// This also covers the same-session resume path: `claude --resume` reuses its `session_id`, so it
// never reaches the re-adoption block at all and never got a re-stamp from there.
describe("session-end retraction — work before the new block", () => {
  it("reinstates the red when the new session works and THEN blocks", () => {
    const l = emptyLedger();
    tick(l, { a: "approval" }, T, { a: asking(T) });
    tick(l, { a: "approval" }, T + 30_000, { a: ev("SessionEnd", T + 25_000) });
    // B's first event re-adopts and re-stamps the baseline.
    tick(l, { a: "approval" }, T + 60_000, { a: ev("PostToolUse", T + 55_000, "sess-two") });
    // B does work AFTER re-adoption, so the movement axis goes true on its own.
    tick(l, { a: "approval" }, T + 90_000, { a: ev("PostToolUse", T + 70_000, "sess-two") });
    expect(movedSince(l, "a"), "precondition: B's work registered as movement").toBe(true);

    // …and only then does B block. Withdrawing the mark is not enough on its own.
    tick(l, { a: "approval" }, T + 120_000, { a: picker(T + 100_000, "sess-two") });
    tick(l, { a: "approval" }, T + 150_000, { a: picker(T + 100_000, "sess-two") });

    expect(movedSince(l, "a"), "B's earlier work is not movement past B's own ask").toBe(false);
    expect(sessionEnded(l, "a")).toBe(false);
    expect(
      withMovementRetraction([{ id: "a" }], { a: "approval" }, isRed, l).a,
      "a new ask is a new red — neither axis may retract it",
    ).toBe("approval");
  });

  // …AND THE TRANSITION GATE, which is what keeps the re-stamp from eating real movement.
  //
  // `fleet.rs` re-reports the same `lastEvent` until a newer one replaces it, so an UNGATED re-stamp
  // advances the baseline on every tick for as long as the block persists. The baseline is stamped
  // from the TICK clock while movement is judged on the EVENT clock, and an event is always older
  // than the tick that reports it — so a work event arriving after the human answers can land BEFORE
  // a baseline that kept moving, and be discarded as predating its own episode. The red would then
  // never retract even though the agent has demonstrably moved on.
  it("still retracts once the answered session moves past its own block", () => {
    const l = emptyLedger();
    tick(l, { a: "approval" }, T, { a: asking(T) });
    tick(l, { a: "approval" }, T + 30_000, { a: ev("SessionEnd", T + 25_000) });
    tick(l, { a: "approval" }, T + 60_000, { a: picker(T + 55_000, "sess-two") });
    // The block is re-reported for a while — the baseline must be stamped ONCE, on the transition.
    tick(l, { a: "approval" }, T + 90_000, { a: picker(T + 55_000, "sess-two") });
    tick(l, { a: "approval" }, T + 120_000, { a: picker(T + 55_000, "sess-two") });
    expect(withMovementRetraction([{ id: "a" }], { a: "approval" }, isRed, l).a).toBe("approval");

    // The human answers and B carries on. That IS movement past B's own ask.
    tick(l, { a: "approval" }, T + 150_000, { a: ev("PostToolUse", T + 100_000, "sess-two") });

    expect(movedSince(l, "a"), "the answer and the work that followed it count").toBe(true);
    expect(
      withMovementRetraction([{ id: "a" }], { a: "approval" }, isRed, l).a,
      "nobody should have to clear this by hand once the agent is moving again",
    ).not.toBe("approval");
  });
});

// ── THE TWO CLOCKS: the baseline must be stamped on the EVENT clock (roborev job 82234) ──────────
//
// `conciergeFeed` calls `noteMovement(..., Date.now())` on EVERY RENDER, while the evidence itself is
// republished only by `fleetWatch`'s 30-second poll. So the block event this branch fires on can be
// most of a poll interval old by the time the baseline is stamped — and a baseline stamped from the
// RENDER clock sits above evidence that genuinely postdates the ask.
//
// The guaranteed-permanent case is the session-end axis, the one axis holding permanent proof of
// absence, and it is exactly the `sparkle-xndaze` population: B blocks on a plan prompt; the human
// sees it and QUITS the agent rather than answering; `SessionEnd`'s event time predates the
// render-clock baseline, so `endedAt > raisedAt` is false, the mark is never recorded, and the dead
// session emits nothing further. "Needs you" then stands forever over a latch with no writer.
//
// The block event IS the instant the new ask began, so anything postdating the ask necessarily beats
// it. Note the previous cases could not see this: they put every post-block event comfortably above
// the tick clock, which is not the ordering the production clocks produce.
describe("session-end retraction — the baseline is stamped on the event clock", () => {
  it("records a SessionEnd that postdates the BLOCK but predates the stamping render", () => {
    const l = emptyLedger();
    tick(l, { a: "approval" }, T, { a: asking(T) });
    tick(l, { a: "approval" }, T + 30_000, { a: ev("SessionEnd", T + 25_000) });
    tick(l, { a: "approval" }, T + 60_000, { a: picker(T + 55_000, "sess-two") });
    // The stamping render runs well after the block event the poll reported.
    tick(l, { a: "approval" }, T + 90_000, { a: picker(T + 55_000, "sess-two") });
    expect(withMovementRetraction([{ id: "a" }], { a: "approval" }, isRed, l).a).toBe("approval");

    // The human quits instead of answering. This postdates the BLOCK (T+55s) but predates the
    // render that stamped the baseline (T+90s).
    tick(l, { a: "approval" }, T + 120_000, { a: ev("SessionEnd", T + 60_000, "sess-two") });

    expect(sessionEnded(l, "a"), "the asking session is provably gone").toBe(true);
    expect(
      withMovementRetraction([{ id: "a" }], { a: "approval" }, isRed, l).a,
      "a dead session emits nothing further — this is the 24-hour phantom",
    ).not.toBe("approval");
  });

  // …and the FUTURE-TIMESTAMP refusal, which is the dangerous direction of the same stamp. A block
  // event whose clock is ahead would set a baseline no later fact can beat, silencing this agent's
  // reds permanently — the mirror of the refusal the capture below already makes for `endedAt`, and
  // the reason `episodeStart` falls back to `now` rather than trusting what it is given.
  it("falls back to the render clock when the block event's timestamp is in the FUTURE", () => {
    const l = emptyLedger();
    const FUTURE = T + 999_999_999;
    tick(l, { a: "approval" }, T, { a: asking(T) });
    tick(l, { a: "approval" }, T + 30_000, { a: ev("SessionEnd", T + 25_000) });
    tick(l, { a: "approval" }, T + 60_000, { a: picker(FUTURE, "sess-two") });
    tick(l, { a: "approval" }, T + 90_000, { a: picker(FUTURE, "sess-two") });

    // A perfectly ordinary SessionEnd. A baseline that had trusted the future timestamp would sit
    // above it forever.
    tick(l, { a: "approval" }, T + 120_000, { a: ev("SessionEnd", T + 100_000, "sess-two") });

    expect(sessionEnded(l, "a"), "a broken clock must not outrank every later fact").toBe(true);
  });
});

// ── THE CONTRADICTION AXIS — the agent's own newest event disagrees with its latch ─────────────
//
// EVERY CASE HERE IS KEYED ON A REAL MEASUREMENT, taken 2026-09-09 from the three agents bead
// sparkle-xndaze is named after, by reading their hook-events logs directly:
//
//   b2e57a0c  Notification "Claude needs your permission"     -> approval  RED, and HONEST
//   413ebe91  PreToolUse tool=Bash                            -> working   phantom
//   d5d7056e  Notification "Claude is waiting for your input"  -> idle      phantom
//
// ONE OF THE THREE IS A GENUINE ASK. "All three stop showing Needs you" is therefore the WRONG
// success criterion — it is satisfied by silencing a live question. b2e57a0c is the paired NEGATIVE
// throughout this block, and the rule the previous `BLOCK_SIGNALS` guess got wrong is that it read
// two of these three backwards: it classified by event NAME, so d5d7056e's idle ping and
// 413ebe91's Bash call both counted as "the agent is blocked on you".
describe("the contradiction axis — a latch its own evidence disagrees with", () => {
  const raiseThen = (evidence: MovementEvidence) => {
    const l = emptyLedger();
    tick(l, { a: "waiting" }, T, { a: asking(T - 1_000) });
    tick(l, { a: "waiting" }, T + 60_000, { a: evidence });
    return l;
  };
  const shown = (l: RetractionLedger) =>
    withMovementRetraction([{ id: "a" }], { a: "waiting" }, isRed, l).a;

  it("retracts on d5d7056e's shape — a Notification that is Claude's IDLE PING, not a request", () => {
    const l = raiseThen(idlePing(T + 30_000));
    expect(contradicted(l, "a")).toBe(true);
    expect(shown(l), "an idle ping is not an ask, so the red stopped being true").not.toBe("waiting");
  });

  it("retracts on 413ebe91's shape — a PreToolUse for a NON-blocking tool", () => {
    const l = raiseThen(toolCall(T + 30_000));
    expect(contradicted(l, "a")).toBe(true);
    expect(shown(l)).not.toBe("waiting");
  });

  // ── THE PAIRED NEGATIVE, and the one that decides whether this feature is safe to ship ────────
  it("does NOT retract on b2e57a0c's shape — a Notification that IS a permission request", () => {
    const l = raiseThen(asking(T + 30_000));
    expect(contradicted(l, "a")).toBe(false);
    expect(shown(l), "a genuinely blocked agent whose pane is unmounted still needs you").toBe(
      "waiting",
    );
  });

  // `questions` is NOT in the red tier — it is BLUE — but it IS in the attention set. Testing the
  // derived status with the caller's `isRed` instead of `needsAttention` would read a live picker
  // as "not asking" and retract the row out from under it. This is the test that fails if the two
  // predicates are ever conflated.
  it("does NOT retract while a QUESTION picker is open, though `questions` is not red", () => {
    const l = raiseThen(picker(T + 30_000));
    expect(contradicted(l, "a")).toBe(false);
    expect(shown(l)).toBe("waiting");
  });

  // ── "I CANNOT SEE" IS NOT "NOTHING IS BEING ASKED" (bead sparkle-gazo4a) ──────────────────────
  it("does NOT retract on an event this build does not model", () => {
    const l = raiseThen(ev("PreCompact", T + 30_000));
    expect(contradicted(l, "a")).toBe(false);
    expect(shown(l)).toBe("waiting");
  });

  it("does NOT retract on an empty log", () => {
    const l = raiseThen(ev(null, null));
    expect(contradicted(l, "a")).toBe(false);
    expect(shown(l)).toBe("waiting");
  });

  it("does NOT retract on evidence that cannot name the session it belongs to", () => {
    const l = raiseThen(idlePing(T + 30_000, null));
    expect(contradicted(l, "a")).toBe(false);
    expect(shown(l)).toBe("waiting");
  });

  it("does NOT retract on a FOREIGN session's idle ping", () => {
    const l = raiseThen(idlePing(T + 30_000, "background-one-shot"));
    expect(contradicted(l, "a")).toBe(false);
    expect(shown(l)).toBe("waiting");
  });

  // ── WHICH SIDE IS STALE — the conjunct that says the digest is ahead of the latch ─────────────
  //
  // A disagreement alone does not establish that the LATCH is the stale one. `fleet.rs` polls every
  // 30s while a mounted pane writes the latch live, so the DIGEST can equally be the one behind —
  // and retracting then silences an ask that is on screen right now.
  it("does NOT retract on an event that PREDATES the moment the red was first seen", () => {
    const l = emptyLedger();
    tick(l, { a: "waiting" }, T, { a: asking(T - 1_000) });
    tick(l, { a: "waiting" }, T + 60_000, { a: idlePing(T - 30_000) });
    expect(contradicted(l, "a"), "the digest is behind the pane, not the other way round").toBe(
      false,
    );
    expect(shown(l)).toBe("waiting");
  });

  // ── DERIVED, NOT LATCHED — the bead's own first question ──────────────────────────────────────
  //
  // sparkle-xndaze asks whether the flag is "LATCHED when an agent asks and never cleared" or
  // "DERIVED each poll from state that is itself stale". The answer was a derived flag over a
  // LATCHED status, so this axis is recomputed from scratch every tick: an agent that goes quiet
  // and then asks again must come BACK, on evidence alone, with nobody clearing anything by hand.
  it("comes back the moment the agent asks again — the mark is recomputed, never latched", () => {
    const l = emptyLedger();
    tick(l, { a: "waiting" }, T, { a: asking(T - 1_000) });
    tick(l, { a: "waiting" }, T + 60_000, { a: idlePing(T + 30_000) });
    expect(contradicted(l, "a")).toBe(true);
    expect(shown(l)).not.toBe("waiting");

    // The human never answered; the agent asked again.
    tick(l, { a: "waiting" }, T + 120_000, { a: asking(T + 90_000) });
    expect(contradicted(l, "a"), "a fresh ask is not contradicted by a stale idle ping").toBe(false);
    expect(shown(l), "and the row must be back").toBe("waiting");
  });

  // ── THE SAME CLAIM, ACROSS A SESSION BOUNDARY ────────────────────────────────────────────────
  //
  // The case above and this one differ by ONE ARGUMENT — the second ask's session id — and only
  // this one could ever have failed. The review that found it noted the structural reason both it
  // and the vacuous ConciergeHost guard were green: no contradiction test crossed a session
  // boundary at all, while eleven cases used a second session, every one of them in the `endedAt`
  // blocks.
  //
  // THE FAILURE: A raises a red, goes idle, and its ping correctly retracts. The agent is restarted
  // in the terminal, so it comes back as B. B blocks on an approval. B's evidence carries a foreign
  // id and `endedAt` is UNSET — A was never observed to end — so the re-adoption path is closed and
  // every later tick returns early. A's stale mark then keeps retracting B's live ask forever,
  // because a frozen latch never leaves red and nothing else drops the mark.
  it("comes back when the RESTARTED session asks under a NEW id", () => {
    const l = emptyLedger();
    tick(l, { a: "waiting" }, T, { a: asking(T - 1_000) });
    tick(l, { a: "waiting" }, T + 60_000, { a: idlePing(T + 30_000) });
    expect(contradicted(l, "a")).toBe(true);

    // Restarted. A never emitted a SessionEnd, so nothing re-adopts — and the mark must still go.
    tick(l, { a: "waiting" }, T + 120_000, { a: asking(T + 90_000, "sess-two") });
    expect(
      contradicted(l, "a"),
      "session A's reading cannot speak for session B's ask",
    ).toBe(false);
    expect(shown(l), "the restarted agent's question must be back").toBe("waiting");
  });

  // ...and it is not enough to drop the mark only when the foreign session is ASKING: any foreign
  // evidence means this axis has nothing to say about the adopted session.
  it("drops the mark on a foreign session's WORK too, not only on its ask", () => {
    const l = emptyLedger();
    tick(l, { a: "waiting" }, T, { a: asking(T - 1_000) });
    tick(l, { a: "waiting" }, T + 60_000, { a: idlePing(T + 30_000) });
    expect(contradicted(l, "a")).toBe(true);

    tick(l, { a: "waiting" }, T + 120_000, { a: ev("PostToolUse", T + 90_000, "sess-two") });
    expect(contradicted(l, "a")).toBe(false);
    expect(shown(l)).toBe("waiting");
  });

  // THE PAIRED NEGATIVE for the drop above, and the reason it is placed before the branches rather
  // than at the top of the loop: a tick that saw NOTHING is silence, not a retraction of the
  // evidence — the same rule the movement high-water mark keeps.
  it("keeps the mark across a tick that carries no evidence at all", () => {
    const l = emptyLedger();
    tick(l, { a: "waiting" }, T, { a: asking(T - 1_000) });
    tick(l, { a: "waiting" }, T + 60_000, { a: idlePing(T + 30_000) });
    expect(contradicted(l, "a")).toBe(true);

    tick(l, { a: "waiting" }, T + 90_000);
    expect(contradicted(l, "a"), "a quiet poll is not new information").toBe(true);
  });
});

// ── derivedStatus — replaying what a MOUNTED pane would have written ──────────────────────────
describe("derivedStatus — the one classifier, replayed over the digest", () => {
  it("reads the discriminant, not the event name", () => {
    expect(derivedStatus(asking(T))).toBe("approval");
    expect(derivedStatus(idlePing(T))).toBe("idle");
    expect(derivedStatus(picker(T))).toBe("questions");
    expect(derivedStatus(toolCall(T))).toBe("working");
  });

  it("is null — never a verdict — when it cannot tell", () => {
    expect(derivedStatus(ev(null, null))).toBeNull();
    expect(derivedStatus(ev("", T))).toBeNull();
    expect(derivedStatus(ev("PreCompact", T))).toBeNull();
  });

  // `HookStatusEngine` ignores a trailing background-subagent tool event once the turn has closed,
  // so the status simply does not change. A consumer that read it as `working` would retract a live
  // ask on a background subagent's work — header 4(b)'s substitution, arriving by a different door.
  it("refuses to read a tool event that arrived AFTER the turn closed", () => {
    const closed = { lastTurnOpenMs: T - 10_000, lastTurnCloseMs: T - 5_000 };
    expect(derivedStatus(ev("PreToolUse", T, MAIN, { ...closed, lastEventTool: "Bash" }))).toBeNull();
    expect(derivedStatus(ev("PostToolUse", T, MAIN, closed))).toBeNull();
    // ...and settles a trailing subagent to gray, exactly as the engine does.
    expect(derivedStatus(ev("SubagentStop", T, MAIN, closed))).toBe("idle");
  });

  it("reads the same tool event as work while the turn is still OPEN", () => {
    const open = { lastTurnOpenMs: T - 1_000, lastTurnCloseMs: T - 5_000 };
    expect(derivedStatus(ev("PreToolUse", T, MAIN, { ...open, lastEventTool: "Bash" }))).toBe(
      "working",
    );
  });

  // A close with no opener at all is still closed — the honest reading of a tail that begins after
  // the turn started.
  it("treats a close with no opener as closed", () => {
    expect(
      derivedStatus(ev("PostToolUse", T, MAIN, { lastTurnOpenMs: null, lastTurnCloseMs: T - 1 })),
    ).toBeNull();
  });
});

// ── THE RATCHET UNDER THE PREDICATE CHOICE ────────────────────────────────────────────────────
//
// The axis tests the DERIVED status with `needsAttention` while the caller selects rows with
// `isRed`. That is only safe while every status this classifier can produce that is RED is also in
// the attention set — otherwise a red derived status would read as "not asking" and retract. It
// holds today (`approval` is the only one) and nothing enforced it, so this does.
describe("needsAttention covers every RED status the hook classifier can produce", () => {
  it("has no red output that falls outside the attention set", () => {
    const outputs = [
      derivedStatus(asking(T)),
      derivedStatus(idlePing(T)),
      derivedStatus(picker(T)),
      derivedStatus(toolCall(T)),
      derivedStatus(ev("Stop", T)),
      derivedStatus(ev("SessionEnd", T)),
      derivedStatus(ev("SessionStart", T)),
      derivedStatus(ev("UserPromptSubmit", T)),
      derivedStatus(ev("PostToolUse", T)),
    ].filter((s): s is AgentTabStatus => s !== null);
    expect(outputs.length, "the fixtures must actually produce statuses").toBeGreaterThan(5);
    for (const s of outputs) {
      if (isDismissibleRed(s)) {
        expect(needsAttention(s), `${s} is red but outside the attention set`).toBe(true);
      }
    }
  });
});

// ── A MISSING DISCRIMINANT, AND A TIMESTAMP THAT IS NOT ONE (roborev job 82345) ───────────────
//
// Both were fail-OPENs in the first cut of this axis, and both are the module's own trap reached at
// the WIRE boundary instead of at the screen:
//
//   • `hookEventToStatus` resolves an ABSENT discriminant to the not-asking side — a `Notification`
//     with no message tests false against PERMISSION_RE and reads `idle`, a `PreToolUse` with no
//     tool reads `working`. Optimistic is right for a PANE, which self-corrects on the next event.
//     Here it retracts a red and nothing ever puts it back. And absent is the NORMAL case for a
//     digest built before these fields existed, so every live picker in the fleet would go at once.
//   • `episodeStart` CLAMPS a missing / non-finite / future timestamp to `now`, which is right for a
//     RAISE (the baseline rises, so a broken clock costs a lingering pill) and exactly wrong for a
//     RETRACTING fact: `now` always beats the baseline, so the clamp turns "no usable timestamp"
//     into "newer than the red".
//
// Each case is PAIRED with the identical evidence carrying the missing part, so neither can be
// satisfied by refusing everything.
describe("the contradiction axis fails closed on evidence that cannot speak", () => {
  const raiseThen = (evidence: MovementEvidence) => {
    const l = emptyLedger();
    tick(l, { a: "waiting" }, T, { a: asking(T - 1_000) });
    tick(l, { a: "waiting" }, T + 60_000, { a: evidence });
    return l;
  };
  const shown = (l: RetractionLedger) =>
    withMovementRetraction([{ id: "a" }], { a: "waiting" }, isRed, l).a;

  it("does NOT retract on a Notification whose MESSAGE the digest did not carry", () => {
    const l = raiseThen(ev("Notification", T + 30_000));
    expect(contradicted(l, "a"), "it may have been a permission prompt").toBe(false);
    expect(shown(l)).toBe("waiting");
  });

  it("…and DOES retract on the identical event once the message is there", () => {
    const l = raiseThen(idlePing(T + 30_000));
    expect(contradicted(l, "a")).toBe(true);
    expect(shown(l)).not.toBe("waiting");
  });

  it("does NOT retract on a PreToolUse whose TOOL the digest did not carry", () => {
    const l = raiseThen(ev("PreToolUse", T + 30_000));
    expect(contradicted(l, "a"), "it may have been AskUserQuestion or ExitPlanMode").toBe(false);
    expect(shown(l)).toBe("waiting");
  });

  it("…and DOES retract on the identical event once the tool is there", () => {
    const l = raiseThen(toolCall(T + 30_000));
    expect(contradicted(l, "a")).toBe(true);
    expect(shown(l)).not.toBe("waiting");
  });

  it("does NOT retract on an event whose timestamp is FROM THE FUTURE", () => {
    const l = raiseThen(idlePing(T + 999_999_999));
    expect(contradicted(l, "a"), "a broken clock is not evidence").toBe(false);
    expect(shown(l)).toBe("waiting");
  });

  it("does NOT retract on an event carrying NO timestamp", () => {
    const l = raiseThen(ev("Stop", null));
    expect(contradicted(l, "a")).toBe(false);
    expect(shown(l)).toBe("waiting");
  });

  it("…and DOES retract on the identical Stop once it is timestamped", () => {
    const l = raiseThen(ev("Stop", T + 30_000));
    expect(contradicted(l, "a")).toBe(true);
    expect(shown(l)).not.toBe("waiting");
  });

  it("does NOT retract on a non-finite timestamp", () => {
    expect(contradicted(raiseThen(idlePing(Number.NaN)), "a")).toBe(false);
    expect(contradicted(raiseThen(idlePing(0)), "a")).toBe(false);
  });
});

describe("derivedStatus refuses to guess a missing discriminant", () => {
  it("is null for the two events whose meaning DEPENDS on one", () => {
    expect(derivedStatus(ev("Notification", T))).toBeNull();
    expect(derivedStatus(ev("PreToolUse", T))).toBeNull();
  });

  it("…and is a verdict for the same two once it is carried", () => {
    expect(derivedStatus(asking(T))).toBe("approval");
    expect(derivedStatus(idlePing(T))).toBe("idle");
    expect(derivedStatus(picker(T))).toBe("questions");
    expect(derivedStatus(toolCall(T))).toBe("working");
  });

  // Events that mean ONE thing whatever they carry are unaffected — the gate is scoped to the two
  // that are ambiguous, not applied to every event with a null field.
  it("still classifies the events that carry no discriminant by nature", () => {
    expect(derivedStatus(ev("Stop", T))).toBe("idle");
    expect(derivedStatus(ev("SessionEnd", T))).toBe("done");
    expect(derivedStatus(ev("PostToolUse", T))).toBe("working");
    expect(derivedStatus(ev("UserPromptSubmit", T))).toBe("working");
  });
});

// ── THE IDLE PING'S TWO POPULATIONS (roborev job 82349) ───────────────────────────────────────
//
// Claude's non-permission `Notification` maps to `idle`, and whether that is EVIDENCE depends on
// something the message cannot tell you. Measured over 151 hook logs: of 2,906 idle pings, 2,544
// fired with the turn CLOSED and 362 with it still OPEN. Both populations are real, so neither
// blanket answer is safe — trust them all and a live picker erases itself on a timer; refuse them
// all and this axis goes inert for `d5d7056e`, whose ping follows a `Stop`.
describe("an idle ping is evidence only once the turn has closed", () => {
  const raiseThen = (evidence: MovementEvidence) => {
    const l = emptyLedger();
    tick(l, { a: "waiting" }, T, { a: picker(T - 1_000) });
    tick(l, { a: "waiting" }, T + 60_000, { a: evidence });
    return l;
  };
  const shown = (l: RetractionLedger) =>
    withMovementRetraction([{ id: "a" }], { a: "waiting" }, isRed, l).a;

  it("does NOT retract on a MID-TURN ping — the sound of the question going unanswered", () => {
    const l = raiseThen(idlePingMidTurn(T + 30_000));
    expect(contradicted(l, "a"), "a turn that has not closed and is idle is STUCK").toBe(false);
    expect(shown(l), "a genuine ask must not erase itself on a timer").toBe("waiting");
  });

  it("DOES retract on the identical ping once the turn has closed", () => {
    const l = raiseThen(idlePing(T + 30_000));
    expect(contradicted(l, "a")).toBe(true);
    expect(shown(l)).not.toBe("waiting");
  });

  // A PERMISSION Notification is untouched by the gate either way — it resolves to `approval`, not
  // `idle`, so keying the rule on the STATUS rather than on the message costs nothing here.
  it("leaves a permission Notification asking, whatever the turn state", () => {
    expect(derivedStatus(asking(T))).toBe("approval");
    expect(
      derivedStatus(
        ev("Notification", T, MAIN, {
          lastEventMessage: "Claude needs your permission",
          lastTurnOpenMs: T - 10_000,
          lastTurnCloseMs: null,
        }),
      ),
    ).toBe("approval");
  });

  it("classifies the two ping shapes differently at the classifier", () => {
    expect(derivedStatus(idlePing(T))).toBe("idle");
    expect(derivedStatus(idlePingMidTurn(T))).toBeNull();
  });
});

// ── ONE TRUST RULE FOR A TIMESTAMP, SHARED BY BOTH RETRACTING AXES ────────────────────────────
//
// The `SessionEnd` capture used to date itself from the raw `lastEventMs` and re-derive validity
// from `endedAt <= now` — the question `evidenceInstant` already answers, answered with LESS (no
// finite test, no positive test). It leaned on `endedAt > baseline` to reject a zero stamp, which
// is true only while the baseline happens to be positive. These pin the shared rule at BOTH axes so
// the two cannot drift apart again.
describe("a SessionEnd is dated by the same rule the contradiction axis uses", () => {
  const endWith = (ms: number | null) => {
    const l = emptyLedger();
    tick(l, { a: "approval" }, T, { a: asking(T - 1_000) });
    tick(l, { a: "approval" }, T + 60_000, { a: ev("SessionEnd", ms) });
    return l;
  };
  const shown = (l: RetractionLedger) =>
    withMovementRetraction([{ id: "a" }], { a: "approval" }, isRed, l).a;

  it("records an end that is trustworthily timestamped", () => {
    const l = endWith(T + 30_000);
    expect(sessionEnded(l, "a")).toBe(true);
    expect(shown(l)).not.toBe("approval");
  });

  it("refuses an end with NO timestamp", () => {
    expect(sessionEnded(endWith(null), "a")).toBe(false);
    expect(shown(endWith(null))).toBe("approval");
  });

  it("refuses an end timestamped in the FUTURE — a broken clock beats every raise time", () => {
    expect(sessionEnded(endWith(T + 999_999_999), "a")).toBe(false);
    expect(shown(endWith(T + 999_999_999))).toBe("approval");
  });

  it("refuses a zero or non-finite end stamp without leaning on the baseline being positive", () => {
    expect(sessionEnded(endWith(0), "a")).toBe(false);
    expect(sessionEnded(endWith(Number.NaN), "a")).toBe(false);
    expect(sessionEnded(endWith(-1), "a")).toBe(false);
  });
});
