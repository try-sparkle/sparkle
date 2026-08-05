import { describe, expect, it } from "vitest";
import {
  advanceLedger,
  overduePromises,
  promisesIn,
  PROMISE_GRACE_TURNS,
  FUTURE_FAMILIES,
  promiseVerbPhrase,
  type PromiseRecord,
} from "./conciergePromiseLedger";
import { CLAIM_FAMILIES } from "./conciergeLint/checks/unbackedClaim";
import type { LintToolCall } from "./conciergeLint";

/** A tool call shaped as the concierge really emits it: the MCP dispatcher name plus an `op`. */
function call(op: string, input: Record<string, unknown> = {}): LintToolCall {
  const domain =
    op.startsWith("spawn") || op.startsWith("close") ? "sparkle_lifecycle" : "sparkle_terminal";
  return { name: `mcp__sparkle-control__${domain}`, input: { op, args: input } };
}

const SEND = call("send_to_agent_terminal", { agentId: "a1", text: "go" });
const SPAWN = call("spawn_build_agent", { projectId: "p1", task: "x" });

describe("promisesIn — the future-tense undertaking", () => {
  // VERBATIM from the corpus. These are the shapes that were actually dropped.
  it("catches the dominant dropped shape: an offer conditioned on the founder", () => {
    // "say go and I'll spawn it" is the single most frequent form among the 35 dropped promises.
    // Excluding conditionals — as the same-turn check does — would blind this to its own subject.
    const p = promisesIn("**Next action:** say go and I'll spawn that batch.", "t1", 1);
    expect(p.map((x) => x.family)).toEqual(["spawn"]);
    expect(p[0]!.sentence).toContain("say go and I'll spawn");
  });

  it("catches the plain undertaking", () => {
    expect(promisesIn("I'll send the brief once it's up.", "t1", 1)[0]?.family).toBe("send");
    expect(promisesIn("I will close it unless you tell me otherwise.", "t1", 1)[0]?.family).toBe(
      "close",
    );
    expect(promisesIn("I'm going to merge it after checks.", "t1", 1)[0]?.family).toBe("merged");
  });

  it("does NOT count past or progressive tense — that is the other check's job", () => {
    // The two must not double-report one sentence; `unbacked-claim` owns these.
    expect(promisesIn("I sent it to Left Pair.", "t1", 1)).toEqual([]);
    expect(promisesIn("I'm sending it now.", "t1", 1)).toEqual([]);
  });

  it("does NOT count conditional MOOD — 'I'd send' is an opinion, not an undertaking", () => {
    // Verbatim from the corpus: "I'd send immediately on release and keep the countdown exclusive
    // to Speak". Counting these would inflate the number the ledger exists to make trustworthy.
    expect(promisesIn("I'd send immediately on release.", "t1", 1)).toEqual([]);
  });

  it("records one promise per family, not one per sentence", () => {
    const p = promisesIn("I'll send it. Then I'll send the follow-up too.", "t1", 1);
    expect(p).toHaveLength(1);
  });

  it("quotes the sentence, bounded", () => {
    const p = promisesIn(`Fine. ${"x".repeat(400)} I'll send it.`, "t1", 1);
    expect(p[0]!.sentence.length).toBeLessThanOrEqual(240);
  });
});

describe("advanceLedger — a promise is kept by a later turn doing it", () => {
  const promise = (over: Partial<PromiseRecord> = {}): PromiseRecord => ({
    family: "send",
    label: "send",
    sentence: "I'll send it.",
    turnId: "t1",
    at: 1,
    turnsSince: 0,
    ...over,
  });

  it("closes a promise when a later turn makes the backing call", () => {
    const { open, kept } = advanceLedger([promise()], {
      id: "t2",
      text: "Done.",
      toolCalls: [SEND],
      at: 2,
    });
    expect(kept.map((p) => p.family)).toEqual(["send"]);
    expect(open).toEqual([]);
  });

  it("ages a promise the later turn did NOT act on — the positive control", () => {
    // Without this the row above would pass against a ledger that closes everything.
    const { open, kept } = advanceLedger([promise()], {
      id: "t2",
      text: "Still looking.",
      toolCalls: [],
      at: 2,
    });
    expect(kept).toEqual([]);
    expect(open[0]!.turnsSince).toBe(1);
  });

  it("is not closed by an UNRELATED action", () => {
    // Spawning something is not sending the thing you said you'd send.
    const { open, kept } = advanceLedger([promise()], {
      id: "t2",
      text: "Spawned one.",
      toolCalls: [SPAWN],
      at: 2,
    });
    expect(kept).toEqual([]);
    expect(open[0]!.turnsSince).toBe(1);
  });

  it("does not age a promise on the very turn that made it", () => {
    // It is owed from the NEXT turn. Otherwise a turn that promises and immediately acts would be
    // recorded as kept and open at once.
    const { open, kept } = advanceLedger([], {
      id: "t1",
      text: "I'll send it.",
      toolCalls: [],
      at: 1,
    });
    expect(kept).toEqual([]);
    expect(open).toHaveLength(1);
    expect(open[0]!.turnsSince).toBe(0);
  });

  it("keeps one obligation per family when the promise is repeated", () => {
    let open = advanceLedger([], { id: "t1", text: "I'll send it.", toolCalls: [], at: 1 }).open;
    open = advanceLedger(open, { id: "t2", text: "I'll send it.", toolCalls: [], at: 2 }).open;
    open = advanceLedger(open, { id: "t3", text: "I'll send it.", toolCalls: [], at: 3 }).open;
    expect(open).toHaveLength(1);
    // …and it keeps ageing from the FIRST time it was said, which is the honest count.
    expect(open[0]!.turnsSince).toBe(2);
  });
});

describe("overduePromises — when the ledger speaks", () => {
  const aged = (turnsSince: number): PromiseRecord => ({
    family: "send",
    label: "send",
    sentence: "I'll send it.",
    turnId: "t1",
    at: 1,
    turnsSince,
  });

  it("stays quiet inside the grace window", () => {
    // 9 of 45 promises were kept in the very next turn, so reporting at one would fire on the
    // honest path.
    expect(overduePromises([aged(0)])).toEqual([]);
    expect(overduePromises([aged(PROMISE_GRACE_TURNS - 1)])).toEqual([]);
  });

  it("reports once the grace window is past", () => {
    expect(overduePromises([aged(PROMISE_GRACE_TURNS)])).toHaveLength(1);
  });

  it("the end-to-end shape: promise, two silent turns, then it is reported", () => {
    let open = advanceLedger([], {
      id: "t1",
      text: "Say go and I'll spawn it.",
      toolCalls: [],
      at: 1,
    }).open;
    expect(overduePromises(open)).toEqual([]);

    open = advanceLedger(open, { id: "t2", text: "…", toolCalls: [], at: 2 }).open;
    open = advanceLedger(open, { id: "t3", text: "…", toolCalls: [], at: 3 }).open;

    const overdue = overduePromises(open);
    expect(overdue).toHaveLength(1);
    // The sentence is quoted back, which is what makes the report checkable rather than abstract.
    expect(overdue[0]!.sentence).toContain("I'll spawn it");
  });

  it("…and acting in time means it is never reported", () => {
    const open = advanceLedger([], {
      id: "t1",
      text: "Say go and I'll spawn it.",
      toolCalls: [],
      at: 1,
    }).open;
    const second = advanceLedger(open, { id: "t2", text: "Done.", toolCalls: [SPAWN], at: 2 });
    expect(second.kept).toHaveLength(1);
    expect(overduePromises(second.open)).toEqual([]);
  });
});

// ══ THE DRIFT PIN ══════════════════════════════════════════════════════════════════════════════
// The first version derived these forms by stemming `unbacked-claim`'s past-tense verbs, so the two
// lists could not drift. That derivation was wrong on every irregular verb English has, so the
// forms are declared — and this is what replaces the guarantee it was bought for. Without it, a
// family added to CLAIM_FAMILIES would silently never produce a promise.
describe("the future forms cover every claim family", () => {
  it("has a future form for each family the same-turn check knows", () => {
    const families = CLAIM_FAMILIES.map((s) => s.family).sort();
    expect([...FUTURE_FAMILIES].sort()).toEqual(families);
  });

  it("and every family can actually match something — not just have a key", () => {
    // A key mapped to an empty list would satisfy the row above and match nothing.
    const sample: Record<string, string> = {
      send: "I'll send it.",
      spawn: "I'll spawn it.",
      close: "I'll close it.",
      goal: "I'll set a goal on it.",
      filed: "I'll file it.",
      merged: "I'll merge it.",
    };
    for (const { family } of CLAIM_FAMILIES) {
      const text = sample[family];
      expect(text, `no sample sentence for family ${family}`).toBeTruthy();
      expect(
        promisesIn(text!, "t1", 1).map((p) => p.family),
        `family ${family} has a key but matches nothing`,
      ).toContain(family);
    }
  });
});

// ══ THE SENTENCE READS AS ENGLISH (roborev 58101) ══════════════════════════════════════════════
// The first version reused CLAIM_FAMILIES' `label`, which is a NOUN phrase written for the
// same-turn check's detail string. Dropped into "You said you'd ___" it produced "You said you'd
// goal update" and "You said you'd bead filing".
describe("promiseVerbPhrase", () => {
  it('completes "You said you\'d ___" for every family', () => {
    for (const { family } of CLAIM_FAMILIES) {
      const phrase = promiseVerbPhrase(family);
      expect(phrase, `family ${family} has no verb phrase`).toBeTruthy();
      // The tell for a noun phrase slipping back in: the two that broke.
      expect(phrase).not.toBe("goal update");
      expect(phrase).not.toBe("bead filing");
      // A verb phrase starts with a bare verb, so the sentence reads.
      expect(`You said you'd ${phrase}`).toMatch(/^You said you'd [a-z]+( |$)/);
    }
  });

  it("falls back rather than producing an empty sentence for an unknown family", () => {
    expect(promiseVerbPhrase("teleport" as never)).toBe("do that");
  });
});
