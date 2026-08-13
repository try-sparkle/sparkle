import { describe, expect, it } from "vitest";
import { actionReceiptLine, receiptMark } from "./actionReceiptLine";
import { foldKeyOf } from "./receiptRuns";
import type { ConciergeActionReceipt } from "../../services/conciergeReceipts";

const AGENT = { id: "11111111-2222-3333-4444-555555555555", name: "Left Pair" };
const resolve = (id: string) => (id === AGENT.id ? AGENT : null);
const noneResolve = () => null;

function receipt(over: Partial<ConciergeActionReceipt> = {}): ConciergeActionReceipt {
  return {
    id: "receipt-1",
    kind: "sent",
    ok: true,
    agentId: AGENT.id,
    agentName: AGENT.name,
    channel: "terminal",
    at: 1_769_649_600_123,
    op: "terminal.send_to_agent_terminal",
    ...over,
  };
}

describe("actionReceiptLine", () => {
  // ══ THE ONE THAT CLOSES sparkle-zm0c8 ═════════════════════════════════════════════════════════
  // The founder was told a message was in the inbox and could find no trace of it. Both facts were
  // true: an inbox message is queued and invisible until the agent's next turn boundary. The line
  // has to carry that, or it reproduces the complaint.
  it("says an inbox message is DELAYED, and a terminal send is not", () => {
    const inbox = actionReceiptLine(receipt({ channel: "inbox" }), resolve);
    expect(inbox?.spoken).toBe("Left Left Pair a message — it delivers at their next turn.");

    // The positive control: the terminal arm must NOT carry the delay clause, or the distinction
    // this test exists for is cosmetic.
    const terminal = actionReceiptLine(receipt({ channel: "terminal" }), resolve);
    expect(terminal?.spoken).toBe("Sent to Left Pair's terminal.");
    expect(terminal?.spoken).not.toContain("next turn");
  });

  it("names the agent as a clickable pill when the id resolves", () => {
    const l = actionReceiptLine(receipt(), resolve);
    expect(l?.md).toContain(`sparkle-agent:${AGENT.id}`);
  });

  it("degrades to words rather than inventing a reference when the agent is gone", () => {
    // A pill carrying a guessed id opens the WRONG agent and the reader cannot tell — strictly
    // worse than no pill. The name still shows because the tool call reported it.
    const l = actionReceiptLine(receipt(), noneResolve);
    expect(l?.md).not.toContain("sparkle-agent:");
    expect(l?.spoken).toBe("Sent to Left Pair's terminal.");
  });

  // ══ THE BROADCAST ARM (roborev 57866) ═════════════════════════════════════════════════════════
  // `fleet.inbox_broadcast` classifies to {kind:"sent", channel:"inbox"} and carries `agentIds`,
  // not `agentId` — so the singular arm rendered a message sent to N agents as "Left that agent a
  // message". Understating a fan-out is as untrue as overstating a single send, in the one module
  // whose contract is never to claim more than the tool reported.
  describe("a broadcast is never described as a single recipient", () => {
    // Shaped as the CLASSIFIER now builds it: `fanout` comes from the op, and the counts only when
    // the reply carried them. conciergeReceiptClassifier.test.ts pins that this is what it produces.
    const broadcast = (channel: "inbox" | "terminal") =>
      receipt({ channel, agentId: undefined, agentName: undefined, fanout: true });

    it("counts the recipients when the classifier carried them", () => {
      const l = actionReceiptLine(
        receipt({ channel: "inbox", agentId: undefined, agentName: undefined, fanout: true, queued: 5, failed: 0 }),
        noneResolve,
      );
      expect(l?.spoken).toBe("Left a message for 5 agents — it delivers at each one's next turn.");
    });

    // roborev 57888: `inboxBroadcast` reports a PARTIAL failure as an OK reply carrying
    // {queued, failed}. Keying only on `ok` claimed a delivery the tool never reported.
    it("states a PARTIAL failure instead of claiming delivery", () => {
      const l = actionReceiptLine(
        receipt({ channel: "inbox", agentId: undefined, agentName: undefined, fanout: true, queued: 3, failed: 2 }),
        noneResolve,
      );
      expect(l?.spoken).toBe("Left a message for 3 agents — 2 couldn't be reached.");
      expect(l?.spoken).not.toContain("delivers at each");
    });

    it("says a bare SEVERAL when there are no counts — the refusal shape", () => {
      const l = actionReceiptLine(broadcast("inbox"), noneResolve);
      expect(l?.spoken).toBe(
        "Left a message for several agents — it delivers at each one's next turn.",
      );
      expect(l?.spoken).not.toContain("that agent");
    });

    // roborev 57888: the refusal arm was left singular, so a refused broadcast still said
    // "Not sent to that agent" — the same misstatement, on the path where nothing went out.
    it("a REFUSED broadcast is plural too", () => {
      const l = actionReceiptLine(
        receipt({
          channel: "inbox",
          agentId: undefined,
          agentName: undefined,
          fanout: true,
          ok: false,
          reason: "Name at least one agentId to broadcast to.",
        }),
        noneResolve,
      );
      expect(l?.spoken).toBe(
        "Not sent to those agents — Name at least one agentId to broadcast to.",
      );
    });

    // A subject-less TERMINAL send is NOT a fan-out: send_to_agent_terminal is its only producer and
    // always carries an agentId, so the only way to get here is a single send whose id failed to
    // parse. Calling that "several agents" would OVERSTATE — the failure rule 1 exists to prevent.
    // THE ROW roborev 57905 ASKED FOR: `channel:"inbox"` has TWO producers, so a subject-less inbox
    // receipt is just as likely a single `inbox_send` whose args were refused. Without the carried
    // flag it must stay SINGULAR — pluralising it is the same rule-1 inversion removed from terminal.
    it("keeps a subject-less inbox send SINGULAR when it is not a fan-out", () => {
      const l = actionReceiptLine(
        receipt({
          channel: "inbox",
          agentId: undefined,
          agentName: undefined,
          ok: false,
          reason: "agentId is required.",
        }),
        noneResolve,
      );
      expect(l?.spoken).toBe("Not sent to that agent — agentId is required.");
      expect(l?.spoken).not.toContain("those agents");
    });

    it("the positive control: a receipt that DOES name one agent stays singular", () => {
      // Without this, the assertions above would pass against a module that had simply stopped
      // naming anyone at all.
      expect(actionReceiptLine(receipt({ channel: "inbox" }), resolve)?.spoken).toBe(
        "Left Left Pair a message — it delivers at their next turn.",
      );
    });
  });

  it("falls back to 'that agent' when there is no name either", () => {
    const l = actionReceiptLine(receipt({ agentName: undefined }), noneResolve);
    expect(l?.spoken).toBe("Sent to that agent's terminal.");
  });

  describe("each kind reads as what happened", () => {
    it("spawned", () => {
      expect(actionReceiptLine(receipt({ kind: "spawned" }), resolve)?.spoken).toBe(
        "Spawned Left Pair.",
      );
    });
    it("closed", () => {
      expect(actionReceiptLine(receipt({ kind: "closed" }), resolve)?.spoken).toBe(
        "Closed Left Pair.",
      );
    });
    it("goal", () => {
      expect(actionReceiptLine(receipt({ kind: "goal" }), resolve)?.spoken).toBe(
        "Set a goal on Left Pair.",
      );
    });
    it("filed, with the bead as a pill", () => {
      const l = actionReceiptLine(
        receipt({ kind: "filed", beadId: "sparkle-kr2jz", agentId: undefined }),
        resolve,
      );
      expect(l?.spoken).toBe("Filed sparkle-kr2jz.");
      expect(l?.md).toContain("sparkle-bead:sparkle-kr2jz");
    });
    it("filed with an unusable bead id keeps the line and loses only the pill", () => {
      const l = actionReceiptLine(receipt({ kind: "filed", beadId: "  " }), resolve);
      expect(l?.spoken).toBe("Filed a task.");
    });
    it("merged, with the PR number", () => {
      expect(
        actionReceiptLine(receipt({ kind: "merged", prNumber: 1175 }), resolve)?.spoken,
      ).toBe("Merged PR #1175.");
    });
  });

  // ══ THE REFUSAL ARM ═══════════════════════════════════════════════════════════════════════════
  describe("a refused action still posts a line, and never borrows the success wording", () => {
    it("a refused send says NOT sent", () => {
      const l = actionReceiptLine(
        receipt({ ok: false, reason: "its terminal is showing a full-screen app" }),
        resolve,
      );
      expect(l?.spoken).toBe("Not sent to Left Pair — its terminal is showing a full-screen app");
      // The regression this guards: a settle that assumed success once reported a REFUSED merge as
      // "Merged PR #753". A refusal must not read like the thing having happened.
      expect(l?.spoken).not.toMatch(/^Sent to/);
    });

    it("a refused merge does not say 'Merged'", () => {
      // The reason is a FOUNDER-ACTIONABLE one so this stays a test about the WORDING. It used to
      // read "checks are still pending", which `refusalAudience` now withholds as an internal gate
      // — see the block below, which covers that half.
      const l = actionReceiptLine(
        receipt({
          kind: "merged",
          ok: false,
          prNumber: 753,
          reason: "you do not have permission to merge in this repository",
        }),
        resolve,
      );
      expect(l?.spoken).toBe(
        "Didn't merge — you do not have permission to merge in this repository",
      );
      expect(l?.spoken).not.toMatch(/^Merged/);
    });

    it("a refusal with no stated reason still posts, just without the tail", () => {
      const l = actionReceiptLine(receipt({ kind: "closed", ok: false, reason: "  " }), resolve);
      expect(l?.spoken).toBe("Couldn't close Left Pair");
    });

    it("covers every kind, so no refusal can fall through to silence", () => {
      // "nope" is unclassified, and `refusalAudience` defaults those to the founder — so this still
      // asserts what it always did: no KIND may fall through to silence.
      for (const kind of ["spawned", "sent", "closed", "goal", "filed", "merged"] as const) {
        const l = actionReceiptLine(receipt({ kind, ok: false, reason: "nope" }), resolve);
        expect(l, `${kind} must produce a refusal line`).not.toBeNull();
        expect(l?.spoken).toContain("nope");
      }
    });
  });

  // ══ AN INTERNAL GATE IS NOT THREAD MATERIAL (the founder's 2026-08-12 question) ═══════════════
  // "This didn't merge refuse stuff is about, and why am I seeing it? Do I need to be seeing that?"
  // The classification lives in ./refusalAudience and is tested exhaustively there; these assert
  // that the RECEIPT LINE actually honours it, in both directions.
  describe("a refusal aimed at the concierge shows a gist, never the paragraph", () => {
    it("replaces the gate paragraphs the founder was shown with one short phrase", () => {
      // The row SURVIVES — roborev 63249. It is the only thing in the thread that can contradict a
      // turn claiming "Merged PR #753", and deleting it reopened the silence the receipts feature
      // was built to end. What goes is the wall of text he actually complained about.
      const cases: [string, string][] = [
        [
          'Refused: roborev is the review gate on this machine and its state for sparkle/x could not be read. That is "I could not find out", not "it is clean". roborev row(s) 59204, 59203, 59177 carry no branch.',
          "Didn't merge — the review gate has records to repair",
        ],
        [
          "Refused: Checks running (2): Node — shell and Node — coverage — merging now is merging blind.",
          "Didn't merge — waiting on checks",
        ],
      ];
      for (const [reason, expected] of cases) {
        const l = actionReceiptLine(receipt({ kind: "merged", ok: false, reason }), resolve);
        expect(l, reason).not.toBeNull();
        expect(l?.spoken).toBe(expected);
        // None of the machinery reaches the thread.
        expect(l?.spoken).not.toMatch(/59204|roborev|Node —/);
      }
    });

    it("keeps the refusal visible for every KIND — no kind falls through to silence", () => {
      for (const kind of ["spawned", "sent", "closed", "goal", "filed", "merged"] as const) {
        const l = actionReceiptLine(
          receipt({ kind, ok: false, reason: "checks are still running" }),
          resolve,
        );
        expect(l, `${kind} must still produce a refusal line`).not.toBeNull();
        expect(l?.spoken, kind).toContain("waiting on checks");
      }
    });

    it("a refused merge STILL contradicts a turn that claims it merged", () => {
      // The property roborev 63249 said nothing pinned. `conciergeReceipts.ts` measured 32 of 145
      // past-tense claims with no matching tool call; this row is the counter-evidence.
      const l = actionReceiptLine(
        receipt({
          kind: "merged",
          ok: false,
          prNumber: 753,
          reason: "Refused: Checks running (2) — merging now is merging blind.",
        }),
        resolve,
      );
      expect(l?.spoken).toMatch(/^Didn't merge/);
      expect(l?.spoken).not.toMatch(/^Merged/);
    });

    it("STILL posts one the founder alone can clear — this is not a mute button", () => {
      // The regression that would make this change a silent-failure bug of its own.
      const l = actionReceiptLine(
        receipt({ kind: "merged", ok: false, reason: "GraphQL: unauthorized" }),
        resolve,
      );
      expect(l?.spoken).toBe("Didn't merge — GraphQL: unauthorized");
    });

    it("still posts a refusal that stated no reason", () => {
      // Absence is not evidence of an internal gate, and the existing line is already quiet.
      expect(
        actionReceiptLine(receipt({ kind: "closed", ok: false, reason: "  " }), resolve)?.spoken,
      ).toBe("Couldn't close Left Pair");
    });

    it("leaves SUCCESS receipts alone, whatever their reason says", () => {
      // `reason` on an ok receipt is the spawn shortfall, not a refusal — it must never be routed
      // through the audience rule. This one names an internal gate and still has to be rendered.
      const l = actionReceiptLine(
        receipt({ kind: "spawned", ok: true, reason: "Its checks are still running." }),
        resolve,
      );
      expect(l?.spoken).toContain("Its checks are still running.");
    });
  });

  it("posts NOTHING for an unrecognized kind — a line means the thing happened", () => {
    const l = actionReceiptLine(
      receipt({ kind: "teleported" as ConciergeActionReceipt["kind"] }),
      resolve,
    );
    expect(l).toBeNull();
  });

  it("survives a malformed receipt instead of throwing into the render path", () => {
    expect(actionReceiptLine(undefined as never, resolve)).toBeNull();
    expect(actionReceiptLine({} as ConciergeActionReceipt, resolve)).toBeNull();
  });
});

// ══ COPY THAT HAS TO SURVIVE THE REAL STRINGS (roborev 57951) ══════════════════════════════════
describe("the spawn shortfall reads as prose, not a spliced clause", () => {
  // VERBATIM from lifecycle.ts. The synthetic short clause the first test used ("its terminal never
  // came up") is exactly the fixture-divergence this branch was opened to fix, reintroduced in the
  // fix for it.
  const LAUNCH_FAILED = 'I created the agent, but its terminal didn\'t start — the pty never came up — so its opening brief hasn\'t gone in yet. Its brief is still attached, so "Start again" on that agent will send it; nothing needs re-typing.';

  it("renders a multi-sentence briefFailure as its own sentence", () => {
    const l = actionReceiptLine(
      receipt({ kind: "spawned", ok: true, reason: LAUNCH_FAILED }),
      resolve,
    );
    expect(l?.spoken).toBe(`Spawned Left Pair. ${LAUNCH_FAILED}`);
    // The specific regression: "— but I created the agent, but its terminal didn't start" is not a
    // sentence, and it is the shape the previous template produced.
    expect(l?.spoken).not.toContain("— but I created");
  });

  it("a clean spawn is still one short sentence — the positive control", () => {
    expect(actionReceiptLine(receipt({ kind: "spawned" }), resolve)?.spoken).toBe(
      "Spawned Left Pair.",
    );
  });

  // ══ AND THE FOLD MUST NOT BE ABLE TO DELETE IT ════════════════════════════════════════════════
  // The sentence above is the ONLY place the reader learns an agent came up unbriefed, and a folded
  // run replaces the sentence with a count. `hasDetail` is what makes `foldKeyOf` refuse the row;
  // asserted HERE, at the stamp, because the fold rule's own test can only prove what it does with
  // the flag — not that the flag is ever set on the receipt that needs it.
  it("MARKS the shortfall on the mark, so a run of spawns cannot fold it away", () => {
    const mark = receiptMark(
      receipt({ kind: "spawned", ok: true, reason: LAUNCH_FAILED }),
      resolve,
    );
    expect(mark.hasDetail).toBe(true);
    expect(foldKeyOf(mark)).toBeNull();

    // The positive control, on the same path: an ordinary spawn is unmarked and still folds, so the
    // guard is a guard and not a blanket refusal to fold spawns.
    const clean = receiptMark(receipt({ kind: "spawned" }), resolve);
    expect(clean.hasDetail).toBeUndefined();
    expect(foldKeyOf(clean)).toBe("spawned");

    // A REFUSAL's `reason` must NOT be read as a shortfall: it is already refused by `ok`, and
    // marking it too would say the two guards were one.
    expect(
      receiptMark(receipt({ kind: "spawned", ok: false, reason: "nope" }), resolve)
        .hasDetail,
    ).toBeUndefined();
  });
});

describe("a picker press is not described as a message", () => {
  it("says it answered the prompt", () => {
    const l = actionReceiptLine(
      receipt({ channel: "terminal", viaPicker: true }),
      resolve,
    );
    expect(l?.spoken).toBe("Answered Left Pair's prompt.");
    expect(l?.spoken).not.toContain("Sent to");
  });
});

// ══ THE TERMINAL FAN-OUT GUARD, RESTORED (roborev 57926) ═══════════════════════════════════════
// The row asserting a terminal send is never pluralised was DELETED rather than moved when the
// inbox-singular row replaced it in place. The count arm is channel-agnostic and runs first, so
// nothing guarded the terminal channel against it.
describe("the terminal channel is never pluralised", () => {
  it("ignores counts on a terminal receipt", () => {
    const l = actionReceiptLine(
      receipt({ channel: "terminal", queued: 5, failed: 0 }),
      resolve,
    );
    expect(l?.spoken).toBe("Sent to Left Pair's terminal.");
    expect(l?.spoken).not.toContain("agents");
  });
});

// ══ THE UNATTENDED VERB'S LINE ═════════════════════════════════════════════════════════════════
// A retirement is the ONE act in this vocabulary the founder was not present for. Nobody watched it
// happen and nobody will remember asking for it, so this line is the only account of why an agent
// is gone — which is why it is the only success arm that carries a reason.
describe("a retirement is reported as its own act, with its reason", () => {
  const retired = (over: Partial<ConciergeActionReceipt> = {}): ConciergeActionReceipt =>
    receipt({ kind: "retired", op: "lifecycle.retire_agent", channel: undefined, ...over });

  it("says WHY, verbatim", () => {
    const l = actionReceiptLine(retired({ reason: "its PR merged four hours ago" }), resolve);
    expect(l?.spoken).toContain("Retired");
    expect(l?.spoken).toContain("Left Pair");
    // NOT a gist. A shortened reason leaves him unable to check a decision nobody watched.
    expect(l?.spoken).toContain("its PR merged four hours ago");
  });

  it("is NOT worded as a close — he has to be able to tell the two apart", () => {
    // "Closed X" reads as something he asked for and might have forgotten; a retirement is the app
    // deciding on its own. That ambiguity is the whole reason `retired` is a separate kind.
    const l = actionReceiptLine(retired({ reason: "idle with a met goal" }), resolve);
    expect(l?.spoken).not.toMatch(/^Closed /);
    // Positive control: the `closed` kind still produces exactly that wording.
    const closed = actionReceiptLine(receipt({ kind: "closed", channel: undefined }), resolve);
    expect(closed?.spoken).toBe("Closed Left Pair.");
  });

  it("still names the agent when no reason came through", () => {
    const l = actionReceiptLine(retired(), resolve);
    expect(l?.spoken).toContain("Retired");
    expect(l?.spoken).toContain("Left Pair");
  });

  it("reports a refusal as a refusal, never as a retirement that happened", () => {
    const l = actionReceiptLine(retired({ ok: false, reason: "it has uncommitted changes" }), resolve);
    expect(l?.spoken).toMatch(/couldn't retire/i);
    expect(l?.spoken).not.toMatch(/^Retired /);
  });

  it("NEVER FOLDS into a count, however many there are", () => {
    // "Retired 6 agents." is exactly the sentence that would make an unattended verb unauditable —
    // it deletes the six judgements the reason field exists to expose.
    const mark = receiptMark(retired({ reason: "landed and idle" }), resolve);
    expect(foldKeyOf(mark)).toBeNull();
    // Positive control: a foldable kind still folds, so this is a property of `retired` and not of
    // the mark-building in this test.
    expect(foldKeyOf(receiptMark(receipt({ kind: "closed", channel: undefined }), resolve))).toBe(
      "closed",
    );
  });
});
