// THE APP'S OWN DISPATCH DECISION — the enforcement that replaces asking the concierge to remember.
//
// Every rule here is the founder's, stated on 2026-08-13, and each one has a PAIRED test: the case
// that must fire and the neighbouring case that must not. A one-sided suite on a mechanism that
// SPENDS MONEY when it fires is the wrong shape — "it dispatched" proves nothing on its own, since
// a decider that dispatches unconditionally passes every positive assertion in the file.
//
// ══ AND SINCE THE LATCH CAME OUT (bead `sparkle-zx9knz`), THE PAIRING MATTERS MORE ═════════════
// The original decider could not spend twice on one message, so the whole suite could lean on that.
// It can now, and the three guards that bound it — liveness, {@link MAX_DISPATCH_PASSES_PER_MESSAGE}
// and {@link AUTO_REDISPATCH_COOLDOWN_MS} — are each pinned from BOTH sides here: the state that
// re-dispatches and the neighbouring state that must not. A guard asserted only on its refusing side
// is satisfied by a decider that never dispatches at all.
import { describe, expect, it } from "vitest";
import { MAX_CONCURRENT_RESEARCH } from "@sparkle/core";

import {
  AUTO_DISPATCH_MAX_PER_TICK,
  AUTO_DISPATCH_MIN_WAIT_MS,
  AUTO_DISPATCH_TICK_MS,
  AUTO_REDISPATCH_COOLDOWN_MS,
  DISPATCH_SETTLE_MS,
  MAX_DISPATCH_PASSES_PER_MESSAGE,
  MIN_DISPATCHABLE_CHARS,
  autoDispatchNotice,
  decideAutoDispatch,
  dispatchStateFor,
  type AutoDispatchObservation,
  type BubbleDispatchState,
  type ResearchPassRecord,
} from "./conciergeAutoDispatch";
import type { QueuedTurn } from "./conciergeTurnQueue";

const T0 = 1_700_000_000_000;

/** A message long enough to clear {@link MIN_DISPATCHABLE_CHARS}, waiting `agedMs` already. */
const waiter = (id: string, agedMs: number, text = `why is the ${id} build failing on main?`): QueuedTurn => ({
  bubbleId: id,
  text,
  enqueuedAt: T0 - agedMs,
});

const OLD = AUTO_DISPATCH_MIN_WAIT_MS + 30_000;

/** No dispatch state at all — every waiter is fresh. The first tick of any queue. */
const NONE: ReadonlyMap<string, BubbleDispatchState> = new Map();

/** One waiter's state, spelled out rather than derived, for the rules that are about the state itself. */
const state = (over: Partial<BubbleDispatchState> = {}): BubbleDispatchState => ({
  passes: 1,
  livePass: false,
  lastFinishedAt: T0 - AUTO_REDISPATCH_COOLDOWN_MS,
  ...over,
});

function obs(over: Partial<AutoDispatchObservation> = {}): AutoDispatchObservation {
  return {
    waiting: [waiter("w1", OLD)],
    liveResearch: 0,
    researchHydrated: true,
    dispatched: NONE,
    now: T0,
    ...over,
  };
}

/** The bubble ids a decision chose, or `null` when it chose nothing — the shape most rows assert. */
function chosen(d: ReturnType<typeof decideAutoDispatch>): string[] | null {
  return d.action === "dispatch" ? d.entries.map((e) => e.bubbleId) : null;
}

describe("the founder's rule: fire when agents are FEWER than waiting messages", () => {
  it("dispatches when nothing is running and a message has been waiting", () => {
    expect(chosen(decideAutoDispatch(obs()))).toEqual(["w1"]);
  });

  // ══ THE CASE THE OLD RULE CALLED HEALTHY ═══════════════════════════════════════════════════════
  // *"let's not make it if live research is zero. Let's just make it if live research is lower than
  // the queue depth."* A zero-test passes every OTHER test in this file, so this is the one that
  // separates the founder's rule from the one it replaced.
  it("dispatches when SOME agents are running but fewer than the queue", () => {
    const waiting = [waiter("w1", OLD), waiter("w2", OLD), waiter("w3", OLD)];
    expect(decideAutoDispatch(obs({ waiting, liveResearch: 1 })).action).toBe("dispatch");
    expect(decideAutoDispatch(obs({ waiting, liveResearch: 2 })).action).toBe("dispatch");
  });

  it("stops at parity — an agent for every waiting message is a queue being served", () => {
    const waiting = [waiter("w1", OLD), waiter("w2", OLD), waiter("w3", OLD)];
    expect(decideAutoDispatch(obs({ waiting, liveResearch: 3 }))).toEqual({
      action: "none",
      reason: "served",
    });
    // More agents than messages is the same all-clear, not an underflow into dispatching again.
    expect(decideAutoDispatch(obs({ waiting, liveResearch: 9 })).action).toBe("none");
  });

  it("says nothing at all when the queue is empty", () => {
    expect(decideAutoDispatch(obs({ waiting: [] }))).toEqual({
      action: "none",
      reason: "queue-empty",
    });
  });
});

describe("the wait floor is the founder's one minute, and it is a real boundary", () => {
  it("fires exactly AT the floor and not one millisecond before", () => {
    const at = decideAutoDispatch(obs({ waiting: [waiter("w1", AUTO_DISPATCH_MIN_WAIT_MS)] }));
    expect(at.action).toBe("dispatch");
    const under = decideAutoDispatch(obs({ waiting: [waiter("w1", AUTO_DISPATCH_MIN_WAIT_MS - 1)] }));
    expect(under).toEqual({ action: "none", reason: "too-young" });
  });

  // THE VALUE, not just the boundary. Every other assertion is written against the symbol, so all
  // of them would hold if it silently went back to three minutes — which is the number the founder
  // explicitly rejected. This is the one test that reads the literal.
  it("is one minute, which is the number he chose over three", () => {
    expect(AUTO_DISPATCH_MIN_WAIT_MS).toBe(60_000);
  });

  // FAIL CLOSED. A missing or corrupt stamp makes the age unknowable, and unknowable must not read
  // as old — `NaN < floor` is false, so a naive comparison DISPATCHES on corrupt input, which is
  // the fail-open direction on a mechanism that spends money.
  it("refuses when the age cannot be established", () => {
    const broken = { bubbleId: "w1", text: "a perfectly ordinary long question here", enqueuedAt: NaN };
    expect(decideAutoDispatch(obs({ waiting: [broken] }))).toEqual({
      action: "none",
      reason: "too-young",
    });
  });
});

describe("ordering — oldest first, and the log names the rule that actually held", () => {
  it("takes the OLDEST waiting message first", () => {
    // Send order, so index 0 has waited longest. Asserted with three entries because with two,
    // "first" and "oldest" and "not the last" are the same answer and cannot be told apart.
    const waiting = [waiter("w1", OLD + 120_000), waiter("w2", OLD + 60_000), waiter("w3", OLD)];
    const d = decideAutoDispatch(obs({ waiting, liveResearch: 2 }));
    expect(chosen(d)).toEqual(["w1"]);
    expect(d.action === "dispatch" && d.waitedMs).toBe(OLD + 120_000);
  });

  it("moves past a waiter that already has a live pass rather than stopping at it", () => {
    const waiting = [waiter("w1", OLD), waiter("w2", OLD)];
    const dispatched = new Map([["w1", state({ livePass: true })]]);
    expect(chosen(decideAutoDispatch(obs({ waiting, dispatched, liveResearch: 1 })))).toEqual(["w2"]);
  });

  // THE REASON IS THE OLDEST EXCLUDED WAITER'S, not the last one iterated. Reporting the last makes
  // the log a function of iteration order: here the newest waiter is merely too young, which says
  // nothing about why the founder's oldest question is going unserved.
  it("reports the OLDEST excluded waiter's reason, not the newest one's", () => {
    const waiting = [waiter("w1", OLD), waiter("w2", 0)];
    const dispatched = new Map([["w1", state({ passes: MAX_DISPATCH_PASSES_PER_MESSAGE })]]);
    expect(decideAutoDispatch(obs({ waiting, dispatched }))).toEqual({
      action: "none",
      reason: "spent",
    });
    // The paired inversion: swap which waiter is held by which rule and the reported reason follows
    // the OLDEST, so this is the ordering being asserted and not one rule outranking another.
    const flipped = new Map([["w2", state({ passes: MAX_DISPATCH_PASSES_PER_MESSAGE })]]);
    expect(
      decideAutoDispatch(obs({ waiting: [waiter("w1", 0), waiter("w2", OLD)], dispatched: flipped })),
    ).toEqual({ action: "none", reason: "too-young" });
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// THE BEAD: the latch, and why removing it is not simply "dispatch again"
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("de-latching — a still-waiting message whose pass FINISHED is eligible again", () => {
  // ══ THE ROW THAT DEFINES DONE (bead `sparkle-zx9knz`) ═══════════════════════════════════════════
  // Ten messages queued; the app dispatches a batch; those passes finish while all ten are STILL
  // waiting (research dequeues nothing — only `turnFinished` advances the turn queue). The old
  // decider answered `all-dispatched` here and never fired again for the rest of the mount, which is
  // exactly what the founder watched: the badge decaying toward zero with the queue still deep.
  //
  // VERIFIED AGAINST THE PRE-CHANGE RULE, not assumed: with `excludeReason` reverted to "present in
  // the map ⇒ all-dispatched" (the `Set` semantics, transliterated to the new type), this row fails
  // at the second decision with `{action:"none", reason:"all-dispatched"}`.
  it("dispatches AGAIN for messages still in line after the first pass completed", () => {
    const waiting = Array.from({ length: 10 }, (_, i) => waiter(`w${i + 1}`, OLD + i));
    const pending = new Map<string, number>();

    // ── TICK 1: nothing live, ten waiting. A batch goes out.
    const first = decideAutoDispatch(
      obs({ waiting, liveResearch: 0, dispatched: dispatchStateFor(waiting, [], pending, T0) }),
    );
    expect(first.action).toBe("dispatch");
    const sent = first.action === "dispatch" ? first.entries : [];
    expect(sent.length).toBeGreaterThan(0);

    // ── THOSE PASSES RUN AND FINISH, and the ten messages are still exactly where they were.
    const finishedAt = T0 + 30_000;
    const passes: ResearchPassRecord[] = sent.map((e) => ({
      question: e.text,
      live: false,
      finishedAt,
    }));
    // Comfortably past the cooldown, so this row is about the LATCH and not about the pacing.
    const later = finishedAt + AUTO_REDISPATCH_COOLDOWN_MS + 1;

    const second = decideAutoDispatch(
      obs({
        waiting,
        liveResearch: 0,
        now: later,
        dispatched: dispatchStateFor(waiting, passes, pending, later),
      }),
    );

    // THE ASSERTION. More than one dispatch has now occurred for this queue, and the messages whose
    // pass came back with nobody following it up are dispatchable again.
    expect(second.action).toBe("dispatch");
    expect(second.action === "dispatch" && second.entries.length).toBeGreaterThan(0);
    const twice = chosen(second)!.filter((id) => sent.some((e) => e.bubbleId === id));
    expect(twice.length).toBeGreaterThan(0);
  });

  // THE NEIGHBOUR THAT MUST NOT FIRE. A pass still queued or running IS somebody coming for that
  // message; re-dispatching would buy a second child for a question already in flight. This is the
  // one part of the latch that was right, kept.
  it("does NOT re-dispatch while the earlier pass is still live", () => {
    const waiting = [waiter("w1", OLD)];
    const dispatched = new Map([["w1", state({ livePass: true })]]);
    expect(decideAutoDispatch(obs({ waiting, dispatched }))).toEqual({
      action: "none",
      reason: "all-dispatched",
    });
  });

  it("holds a finished pass inside the cooldown, and dispatches it one millisecond outside", () => {
    const waiting = [waiter("w1", OLD)];
    const inside = new Map([["w1", state({ lastFinishedAt: T0 - AUTO_REDISPATCH_COOLDOWN_MS + 1 })]]);
    expect(decideAutoDispatch(obs({ waiting, dispatched: inside }))).toEqual({
      action: "none",
      reason: "cooling",
    });
    const at = new Map([["w1", state({ lastFinishedAt: T0 - AUTO_REDISPATCH_COOLDOWN_MS })]]);
    expect(chosen(decideAutoDispatch(obs({ waiting, dispatched: at })))).toEqual(["w1"]);
  });

  it("is spent at the pass cap, and dispatches one below it", () => {
    const waiting = [waiter("w1", OLD)];
    const spent = new Map([["w1", state({ passes: MAX_DISPATCH_PASSES_PER_MESSAGE })]]);
    expect(decideAutoDispatch(obs({ waiting, dispatched: spent }))).toEqual({
      action: "none",
      reason: "spent",
    });
    const under = new Map([["w1", state({ passes: MAX_DISPATCH_PASSES_PER_MESSAGE - 1 })]]);
    expect(chosen(decideAutoDispatch(obs({ waiting, dispatched: under })))).toEqual(["w1"]);
  });

  // FAIL CLOSED, and note the direction: `now - NaN >= cooldown` is FALSE, so the naive comparison
  // already declines — but an inverted test (`< cooldown` returning early) would read "we cannot
  // establish when it finished" as "it finished long ago" and spend money on it.
  it("refuses when a completed pass's finish time cannot be established", () => {
    const waiting = [waiter("w1", OLD)];
    for (const lastFinishedAt of [null, NaN, Infinity]) {
      expect(
        decideAutoDispatch(obs({ waiting, dispatched: new Map([["w1", state({ lastFinishedAt })]]) })),
      ).toEqual({ action: "none", reason: "cooling" });
    }
  });

  // Guards are per-waiter, so a queue where every waiter trips a DIFFERENT one must still be quiet.
  // Without this, a decider that applied the guards only to `waiting[0]` would pass every row above.
  it("applies the guards to every waiter, not just the first", () => {
    const waiting = [waiter("w1", OLD), waiter("w2", OLD), waiter("w3", OLD)];
    const dispatched = new Map([
      ["w1", state({ livePass: true })],
      ["w2", state({ passes: MAX_DISPATCH_PASSES_PER_MESSAGE })],
      ["w3", state({ lastFinishedAt: T0 })],
    ]);
    expect(decideAutoDispatch(obs({ waiting, dispatched, liveResearch: 1 })).action).toBe("none");
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// The batch, and the three things that bound it
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("the ramp dispatches a batch, bounded by whichever constraint is smallest", () => {
  // ASSERTED AT EACH BINDING CONSTRAINT IN TURN, and each row also asserts the other two arms are
  // LARGER. Without that, a decider that always returned (say) `AUTO_DISPATCH_MAX_PER_TICK` entries
  // would pass whichever row happened to have the cap as its minimum, and the test would be
  // measuring a coincidence rather than the formula.
  it("is bounded by the DEFICIT when the queue is shallower than the cap and the pool", () => {
    const waiting = [waiter("w1", OLD), waiter("w2", OLD), waiter("w3", OLD)];
    const deficit = 3;
    expect(deficit).toBeLessThan(AUTO_DISPATCH_MAX_PER_TICK);
    expect(deficit).toBeLessThan(MAX_CONCURRENT_RESEARCH);
    expect(chosen(decideAutoDispatch(obs({ waiting, liveResearch: 0 })))).toEqual(["w1", "w2", "w3"]);
  });

  it("is bounded by the POOL HEADROOM when the pool is nearly full", () => {
    const live = MAX_CONCURRENT_RESEARCH - 2; // headroom 2
    const waiting = Array.from({ length: live + 6 }, (_, i) => waiter(`w${i + 1}`, OLD));
    // The other two arms are strictly larger, so 2 can only come from the headroom.
    expect(waiting.length - live).toBeGreaterThan(AUTO_DISPATCH_MAX_PER_TICK);
    expect(AUTO_DISPATCH_MAX_PER_TICK).toBeGreaterThan(2);
    expect(chosen(decideAutoDispatch(obs({ waiting, liveResearch: live })))).toEqual(["w1", "w2"]);
  });

  it("is bounded by the PER-TICK CAP when both the queue and the pool are deeper than it", () => {
    const waiting = Array.from({ length: 10 }, (_, i) => waiter(`w${i + 1}`, OLD));
    expect(waiting.length).toBeGreaterThan(AUTO_DISPATCH_MAX_PER_TICK);
    expect(MAX_CONCURRENT_RESEARCH).toBeGreaterThan(AUTO_DISPATCH_MAX_PER_TICK);
    const d = decideAutoDispatch(obs({ waiting, liveResearch: 0 }));
    expect(d.action === "dispatch" && d.entries.length).toBe(AUTO_DISPATCH_MAX_PER_TICK);
    expect(chosen(d)).toEqual(["w1", "w2", "w3", "w4"]);
  });

  // A FULL POOL IS ITS OWN REASON, reported before any per-waiter rule is consulted — the refusal
  // has nothing to do with any one message, and naming a per-waiter rule here would send the reader
  // to the wrong place.
  it("reports at-cap when the pool has no headroom at all", () => {
    const waiting = Array.from({ length: MAX_CONCURRENT_RESEARCH + 4 }, (_, i) => waiter(`w${i + 1}`, OLD));
    expect(decideAutoDispatch(obs({ waiting, liveResearch: MAX_CONCURRENT_RESEARCH }))).toEqual({
      action: "none",
      reason: "at-cap",
    });
    // Paired: one slot of headroom and the same queue dispatches exactly that one.
    expect(
      chosen(decideAutoDispatch(obs({ waiting, liveResearch: MAX_CONCURRENT_RESEARCH - 1 }))),
    ).toEqual(["w1"]);
  });

  it("never dispatches more than the deficit, so a covered queue is never over-served", () => {
    const waiting = Array.from({ length: 6 }, (_, i) => waiter(`w${i + 1}`, OLD));
    // Five live against six waiting: exactly one message has nobody coming for it.
    const d = decideAutoDispatch(obs({ waiting, liveResearch: 5 }));
    expect(d.action === "dispatch" && d.entries.length).toBe(1);
  });

  // ══ THE RAMP, END TO END ═══════════════════════════════════════════════════════════════════════
  // The founder's actual situation: sixteen messages, nothing running. The old decider took sixteen
  // ticks (four minutes) to cover it and, because of the latch, never got there at all once the
  // early passes finished. This is the whole loop — measure, dispatch a bounded batch, re-measure.
  it("covers 16 waiting messages in 4 ticks and then reports served", () => {
    const waiting = Array.from({ length: 16 }, (_, i) => waiter(`w${i + 1}`, OLD + i));
    const pending = new Map<string, number>();
    const passes: ResearchPassRecord[] = [];
    let now = T0;
    const sizes: number[] = [];

    for (let tick = 0; tick < 4; tick++) {
      const d = decideAutoDispatch(
        obs({
          waiting,
          // THE RAMP'S OWN MEASUREMENT: a task is live from the instant it is queued, so every
          // dispatch made so far is already counted here. This is the feedback the control loop runs
          // on, and modelling it is what makes the row a ramp rather than four independent decisions.
          liveResearch: passes.filter((p) => p.live).length,
          now,
          dispatched: dispatchStateFor(waiting, passes, pending, now),
        }),
      );
      expect(d.action).toBe("dispatch");
      if (d.action !== "dispatch") return;
      sizes.push(d.entries.length);
      for (const e of d.entries) passes.push({ question: e.text, live: true, finishedAt: null });
      now += AUTO_DISPATCH_TICK_MS;
    }

    expect(sizes).toEqual([4, 4, 4, 4]);
    expect(passes.filter((p) => p.live).length).toBe(16);
    // …and the fifth tick is quiet, because the queue is now genuinely covered.
    expect(
      decideAutoDispatch(
        obs({ waiting, liveResearch: 16, now, dispatched: dispatchStateFor(waiting, passes, pending, now) }),
      ),
    ).toEqual({ action: "none", reason: "served" });
    // FOUR TICKS IS ~60 SECONDS — the number the change exists to produce, asserted rather than
    // described, so a later tuning of either constant has to come back and restate the claim.
    expect(4 * AUTO_DISPATCH_TICK_MS).toBe(60_000);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// `dispatchStateFor` — the derivation that replaced the ledger
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("dispatchStateFor derives what has been spent, from the store rather than from memory", () => {
  const w = waiter("w1", OLD);

  it("leaves a never-dispatched message out of the map entirely", () => {
    expect(dispatchStateFor([w], [], new Map(), T0).size).toBe(0);
    // The paired positive: an unrelated pass in the store does not attach itself to this waiter.
    const other: ResearchPassRecord = { question: "something else entirely", live: true, finishedAt: null };
    expect(dispatchStateFor([w], [other], new Map(), T0).size).toBe(0);
  });

  // FOUND BY THE HOST SUITE, not by review: a `ResearchTask` is parsed off JSON on disk and reaches
  // this function through the store, so `tsc` proves nothing about the shape that actually arrives.
  // A record with no `question` threw here and took the whole tick down as an unhandled rejection —
  // which in production is the auto-dispatcher silently dead for the life of the mount.
  it("skips a pass whose question is unreadable rather than throwing", () => {
    const broken = [{ live: true, finishedAt: null }, { question: null, live: false, finishedAt: T0 }];
    expect(() => dispatchStateFor([w], broken as unknown as ResearchPassRecord[], new Map(), T0)).not.toThrow();
    expect(dispatchStateFor([w], broken as unknown as ResearchPassRecord[], new Map(), T0).size).toBe(0);
    // Paired: a readable pass BESIDE the broken ones is still matched, so the guard skips the record
    // rather than abandoning the scan.
    const ok: ResearchPassRecord = { question: w.text, live: true, finishedAt: null };
    const mixed = [...broken, ok] as unknown as ResearchPassRecord[];
    expect(dispatchStateFor([w], mixed, new Map(), T0).get("w1")?.livePass).toBe(true);
  });

  it("matches a pass to a waiter by EXACT trimmed text, which is what the runner stores", () => {
    // `dispatchResearchTask` does `input.question.trim()`, so a waiter with surrounding whitespace
    // matches the trimmed question the runner recorded. That is the entire basis of the derivation.
    const padded: QueuedTurn = { ...w, text: `  ${w.text}\n` };
    const pass: ResearchPassRecord = { question: w.text, live: true, finishedAt: null };
    expect(dispatchStateFor([padded], [pass], new Map(), T0).get("w1")).toEqual({
      passes: 1,
      livePass: true,
      lastFinishedAt: null,
    });
  });

  it("reports a finished pass with its finish time, and counts repeats", () => {
    const earlier: ResearchPassRecord = { question: w.text, live: false, finishedAt: T0 - 500_000 };
    const later: ResearchPassRecord = { question: w.text, live: false, finishedAt: T0 - 100_000 };
    expect(dispatchStateFor([w], [earlier, later], new Map(), T0).get("w1")).toEqual({
      passes: 2,
      livePass: false,
      lastFinishedAt: T0 - 100_000, // the MOST RECENT, not the first seen
    });
  });

  // ── THE WINDOW BETWEEN OUR DISPATCH AND THE STORE'S NEXT POLL ─────────────────────────────────
  it("counts a dispatch we just made that the store has not listed yet", () => {
    const pending = new Map([["w1", T0 - 1_000]]);
    expect(dispatchStateFor([w], [], pending, T0).get("w1")).toEqual({
      passes: 1,
      livePass: true,
      lastFinishedAt: null,
    });
  });

  it("does not double-count a pending dispatch the store has since shown as live", () => {
    const pending = new Map([["w1", T0 - 1_000]]);
    const pass: ResearchPassRecord = { question: w.text, live: true, finishedAt: null };
    expect(dispatchStateFor([w], [pass], pending, T0).get("w1")?.passes).toBe(1);
  });

  // ══ A GRACE WINDOW, NOT A LATCH — THE DISTINCTION THE WHOLE BEAD TURNS ON ══════════════════════
  // The stamp stops holding the message back, which is what the `Set` never did. But it does not
  // simply vanish: an unacknowledged dispatch has very probably STARTED (`dispatchResearchTask`'s
  // header), so it is counted as a pass that finished when the window closed — the cooldown and the
  // pass cap both still apply to it.
  it("expires — and an unconfirmed dispatch becomes a FINISHED pass, not a forgotten one", () => {
    const firedAt = T0 - DISPATCH_SETTLE_MS;
    const pending = new Map([["w1", firedAt]]);
    expect(dispatchStateFor([w], [], pending, T0).get("w1")).toEqual({
      passes: 1,
      livePass: false,
      lastFinishedAt: firedAt + DISPATCH_SETTLE_MS,
    });
    // One millisecond earlier it is still inside the window and still live — the paired boundary.
    expect(dispatchStateFor([w], [], pending, T0 - 1).get("w1")?.livePass).toBe(true);
  });

  it("an unacknowledged dispatch is cooling, not immediately re-dispatchable", () => {
    // The end-to-end consequence of the row above, through the decider: we fired, the store never
    // showed it, the window closed. A decider that dropped the stamp here would re-dispatch on this
    // very tick — the money loop the pass cap and cooldown exist to prevent.
    const pending = new Map([["w1", T0 - DISPATCH_SETTLE_MS]]);
    expect(
      decideAutoDispatch(obs({ waiting: [w], dispatched: dispatchStateFor([w], [], pending, T0) })),
    ).toEqual({ action: "none", reason: "cooling" });
    // …and it IS re-dispatchable once the cooldown behind that window has also elapsed.
    const then = T0 + AUTO_REDISPATCH_COOLDOWN_MS;
    expect(
      chosen(
        decideAutoDispatch(
          obs({ waiting: [w], now: then, dispatched: dispatchStateFor([w], [], pending, then) }),
        ),
      ),
    ).toEqual(["w1"]);
  });

  // A remount is the case the `Set` got exactly backwards: it forgot everything and re-dispatched
  // the whole queue. Derivation has no memory to lose — an empty `pendingSince` still sees the store.
  it("survives a remount: an empty pendingSince still finds the live pass in the store", () => {
    const pass: ResearchPassRecord = { question: w.text, live: true, finishedAt: null };
    expect(dispatchStateFor([w], [pass], new Map(), T0).get("w1")?.livePass).toBe(true);
    expect(decideAutoDispatch(obs({ waiting: [w], dispatched: dispatchStateFor([w], [pass], new Map(), T0) }))).toEqual(
      { action: "none", reason: "all-dispatched" },
    );
  });
});

describe("fail-closed guards", () => {
  // The most acute-looking version of the condition — "nothing is running!" — is exactly what an
  // unread store reports. Reading it as evidence would license dispatching the whole queue on the
  // strength of never having looked.
  it("refuses while the research store has not been read", () => {
    expect(decideAutoDispatch(obs({ researchHydrated: false }))).toEqual({
      action: "none",
      reason: "not-looked",
    });
  });

  // Paired with the above so the guard is shown to be the thing that changed the answer, rather
  // than the case being unreachable for some other reason.
  it("…and dispatches the same observation once the store HAS been read", () => {
    expect(decideAutoDispatch(obs({ researchHydrated: true })).action).toBe("dispatch");
  });

  it("refuses a bare acknowledgement that carries no question", () => {
    for (const text of ["yes", "go ahead", "do it", "ship it", "ok thanks"]) {
      expect(decideAutoDispatch(obs({ waiting: [{ ...waiter("w1", OLD), text }] }))).toEqual({
        action: "none",
        reason: "too-short",
      });
    }
  });

  it("…but dispatches a genuine short question", () => {
    const short = "why is the DMG build red?";
    expect(short.length).toBeGreaterThanOrEqual(MIN_DISPATCHABLE_CHARS);
    expect(decideAutoDispatch(obs({ waiting: [{ ...waiter("w1", OLD), text: short }] })).action).toBe(
      "dispatch",
    );
  });
});

describe("what the concierge is told", () => {
  // THE ONE LOAD-BEARING SENTENCE. Without it the app buys a research child and the concierge
  // starts reading files to answer the same question anyway — the dispatch changes nothing and
  // costs money. Pinned rather than left to prose review.
  it("tells the concierge not to duplicate the work", () => {
    const text = autoDispatchNotice([waiter("w1", OLD)], 6, 0);
    expect(text).toContain("Do NOT start reading files");
    // It names the question, so the model can match it against the queue it can see.
    expect(text).toContain("why is the w1 build failing on main?");
    // And both numbers, so the report is checkable rather than an assertion about itself.
    expect(text).toContain("6 messages");
    expect(text).toContain("0 concierge agents");
  });

  it("points at the tool it should have used, so the notice is not purely retrospective", () => {
    expect(autoDispatchNotice([waiter("w1", OLD)], 2, 1)).toContain("sparkle_research");
  });

  it("gets its plurals right at one", () => {
    const one = autoDispatchNotice([waiter("w1", OLD)], 1, 1);
    expect(one).toContain("1 message ");
    expect(one).not.toContain("1 messages");
    expect(one).toContain("1 concierge agent ");
    expect(one).not.toContain("1 concierge agents");
  });

  // ── THE BATCH (bead `sparkle-zx9knz`) ─────────────────────────────────────────────────────────
  // One notice covers the whole tick, so it must name EVERY question it dispatched. Naming only the
  // first would leave the concierge free to go and re-research the other three — the exact
  // duplication the notice exists to prevent, reintroduced by the batching that made it necessary.
  it("names every question in the batch, not just the first", () => {
    const batch = [waiter("w1", OLD), waiter("w2", OLD), waiter("w3", OLD)];
    const text = autoDispatchNotice(batch, 9, 1);
    for (const e of batch) expect(text).toContain(e.text);
    expect(text).toContain("3 research agents");
    expect(text).toContain("Do NOT start reading files");
  });

  it("truncates a very long question rather than pasting it whole into the preamble", () => {
    const long = "why ".repeat(200);
    const text = autoDispatchNotice([{ ...waiter("w1", OLD), text: long }], 2, 0);
    expect(text).not.toContain(long.trim());
    expect(text.length).toBeLessThan(600);
  });
});
