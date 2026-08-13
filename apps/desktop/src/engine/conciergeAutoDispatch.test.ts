// THE APP'S OWN DISPATCH DECISION — the enforcement that replaces asking the concierge to remember.
//
// Every rule here is the founder's, stated on 2026-08-13, and each one has a PAIRED test: the case
// that must fire and the neighbouring case that must not. A one-sided suite on a mechanism that
// SPENDS MONEY when it fires is the wrong shape — "it dispatched" proves nothing on its own, since
// a decider that dispatches unconditionally passes every positive assertion in the file.
import { describe, expect, it } from "vitest";

import {
  AUTO_DISPATCH_MIN_WAIT_MS,
  MIN_DISPATCHABLE_CHARS,
  autoDispatchNotice,
  decideAutoDispatch,
  type AutoDispatchObservation,
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

function obs(over: Partial<AutoDispatchObservation> = {}): AutoDispatchObservation {
  return {
    waiting: [waiter("w1", OLD)],
    liveResearch: 0,
    researchHydrated: true,
    dispatched: new Set<string>(),
    now: T0,
    ...over,
  };
}

describe("the founder's rule: fire when agents are FEWER than waiting messages", () => {
  it("dispatches when nothing is running and a message has been waiting", () => {
    const d = decideAutoDispatch(obs());
    expect(d.action).toBe("dispatch");
    expect(d.action === "dispatch" && d.entry.bubbleId).toBe("w1");
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

describe("idempotence — a dispatched message keeps waiting, and must not be dispatched twice", () => {
  // THE FAILURE THIS PREVENTS IS NOT HYPOTHETICAL ARITHMETIC. Dispatching research does not dequeue
  // anything: the concierge still owes an answer, so the entry is in `waiting` on the next tick and
  // every tick after it. At a 15s tick, no memory means four metered children a minute for one
  // question, forever.
  it("skips a message it has already dispatched for", () => {
    const waiting = [waiter("w1", OLD)];
    expect(decideAutoDispatch(obs({ waiting, dispatched: new Set(["w1"]) }))).toEqual({
      action: "none",
      reason: "all-dispatched",
    });
  });

  it("moves on to the next un-dispatched message rather than stopping", () => {
    const waiting = [waiter("w1", OLD), waiter("w2", OLD)];
    const d = decideAutoDispatch(obs({ waiting, dispatched: new Set(["w1"]) }));
    expect(d.action === "dispatch" && d.entry.bubbleId).toBe("w2");
  });

  it("takes the OLDEST un-dispatched message, not the newest", () => {
    // Send order, so index 0 has waited longest. Asserted with three entries because with two,
    // "first" and "oldest" and "not the last" are the same answer and cannot be told apart.
    const waiting = [waiter("w1", OLD + 120_000), waiter("w2", OLD + 60_000), waiter("w3", OLD)];
    const d = decideAutoDispatch(obs({ waiting }));
    expect(d.action === "dispatch" && d.entry.bubbleId).toBe("w1");
    expect(d.action === "dispatch" && d.waitedMs).toBe(OLD + 120_000);
  });

  // ONE PER CALL. The decision returns a single entry however deep the queue is, so each dispatch
  // raises the live count and the next tick re-measures. A burst decided from one reading would
  // spend six children on a count that might already be stale.
  it("returns exactly one entry however deep the queue is", () => {
    const waiting = [1, 2, 3, 4, 5, 6].map((n) => waiter(`w${n}`, OLD));
    const d = decideAutoDispatch(obs({ waiting }));
    expect(d.action).toBe("dispatch");
    expect(d.action === "dispatch" && d.entry).toBeDefined();
    expect(d.action === "dispatch" && d.queued).toBe(6);
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
    const text = autoDispatchNotice(waiter("w1", OLD), 6, 0);
    expect(text).toContain("Do NOT start reading files");
    // It names the question, so the model can match it against the queue it can see.
    expect(text).toContain("why is the w1 build failing on main?");
    // And both numbers, so the report is checkable rather than an assertion about itself.
    expect(text).toContain("6 messages");
    expect(text).toContain("0 concierge agents");
  });

  it("points at the tool it should have used, so the notice is not purely retrospective", () => {
    expect(autoDispatchNotice(waiter("w1", OLD), 2, 1)).toContain("sparkle_research");
  });

  it("gets its plurals right at one", () => {
    const one = autoDispatchNotice(waiter("w1", OLD), 1, 1);
    expect(one).toContain("1 message ");
    expect(one).not.toContain("1 messages");
    expect(one).toContain("1 concierge agent ");
    expect(one).not.toContain("1 concierge agents");
  });
});
