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
  emptyLedger,
  lastMovementAt,
  movedSince,
  noteMovement,
  noteRedEpochs,
  withMovementRetraction,
  type MovementEvidence,
  type RetractionLedger,
} from "./movementRetraction";

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
): MovementEvidence => ({ lastEvent, lastEventMs, sessionId, toolsRecent: null });

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
    expect(lastMovementAt(ev("Notification", T))).toBeNull();
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
    expect(lastMovementAt(ev("PreToolUse", T))).toBeNull();
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
    tick(l, { a: "blocked" }, T, { a: ev("Notification", T - 1_000) }); // red raised
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
    tick(l, { a: "blocked" }, T, { a: ev("Notification", T - 1_000) });
    tick(l, { a: "blocked" }, T + 10, { a: ev("PostToolUse", T + 5) });
    tick(l, { a: "blocked" }, T + 70, { a: ev("Notification", T + 65) });
    expect(movedSince(l, "a")).toBe(true);
  });

  // `setAgentMovement` replaces the map WHOLESALE, so an agent missing from one digest tick has no
  // evidence that tick. Silence is not a retraction of what was already seen.
  it("keeps a red retracted through a tick with no evidence at all", () => {
    const l = emptyLedger();
    tick(l, { a: "blocked" }, T, { a: ev("Notification", T - 1_000) });
    tick(l, { a: "blocked" }, T + 10, { a: ev("PostToolUse", T + 5) });
    tick(l, { a: "blocked" }, T + 20); // agent absent from the digest
    expect(movedSince(l, "a")).toBe(true);
  });

  it("advances the mark when newer movement arrives", () => {
    const l = emptyLedger();
    tick(l, { a: "blocked" }, T, { a: ev("Notification", T - 1_000) });
    tick(l, { a: "blocked" }, T + 10, { a: ev("PostToolUse", T + 5) });
    tick(l, { a: "blocked" }, T + 20, { a: ev("PostToolUse", T + 15) });
    expect(l.movedAt.get("a")).toBe(T + 15);
  });

  it("never moves the mark backwards", () => {
    const l = emptyLedger();
    tick(l, { a: "blocked" }, T, { a: ev("Notification", T - 1_000) });
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
    tick(l, { a: "waiting" }, T, { a: ev("Notification", T - 1_000, MAIN) });
    tick(l, { a: "waiting" }, T + 10_000, { a: ev("PostToolUse", T + 8_000, "sess-oneshot") });
    expect(movedSince(l, "a")).toBe(false);
  });

  it("accepts the agent's OWN work after refusing a foreign session's", () => {
    const l = emptyLedger();
    tick(l, { a: "waiting" }, T, { a: ev("Notification", T - 1_000, MAIN) });
    tick(l, { a: "waiting" }, T + 10_000, { a: ev("PostToolUse", T + 8_000, "sess-oneshot") });
    tick(l, { a: "waiting" }, T + 20_000, { a: ev("PostToolUse", T + 18_000, MAIN) });
    expect(movedSince(l, "a")).toBe(true);
  });

  // Permissive where it must be: an older emitter writes no session_id, and `isMainSessionId`
  // accepts an unattributed event rather than going blind. The same call hookEvents makes.
  it("accepts an event that carries no session at all", () => {
    const l = emptyLedger();
    tick(l, { a: "blocked" }, T, { a: ev("Notification", T - 1_000, null) });
    tick(l, { a: "blocked" }, T + 10, { a: ev("PostToolUse", T + 5, null) });
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
    tick(l, { a: "blocked" }, T, { a: ev("Notification", T - 1_000, MAIN) });
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
    tick(l, { a: "blocked" }, T, { a: ev("Notification", T - 1_000) });
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
    tick(l, { a: "blocked" }, T, { a: ev("Notification", T - 1_000) });
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
    tick(l, { a: "blocked", b: "working" }, T, { a: ev("Notification", T - 1_000) });
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
    tick(l, { a: "errored" }, T, { a: ev("Notification", T - 1_000) });
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
    tick(l, { a: "blocked", b: "blocked" }, T, { a: ev("Notification", T - 1_000) });
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
