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
    // A RELAY OF THE FOUNDER'S WORDS — stated, because the sentence now depends on it. Every test
    // below that pins "Sent to X's terminal." is testing the RELAY wording (pill degradation, the
    // singular terminal noun, the "that agent" fallback), so the fixture has to be the shape those
    // sentences belong to. A composed send is a different sentence with its own tests, at the bottom
    // of this file (bead `sparkle-p9s5q`).
    relayedFounderWords: true,
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
    expect(inbox?.spoken).toBe(
      "The concierge left Left Pair a message — it delivers at their next turn.",
    );

    // The positive control: the terminal arm must NOT carry the delay clause, or the distinction
    // this test exists for is cosmetic.
    const terminal = actionReceiptLine(receipt({ channel: "terminal" }), resolve);
    expect(terminal?.spoken).toBe(
      "The concierge sent the founder's words to Left Pair's terminal.",
    );
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
    expect(l?.spoken).toBe(
      "The concierge sent the founder's words to Left Pair's terminal.",
    );
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
      expect(l?.spoken).toBe(
        "The concierge left a message for 5 agents — it delivers at each one's next turn.",
      );
    });

    // roborev 57888: `inboxBroadcast` reports a PARTIAL failure as an OK reply carrying
    // {queued, failed}. Keying only on `ok` claimed a delivery the tool never reported.
    it("states a PARTIAL failure instead of claiming delivery", () => {
      const l = actionReceiptLine(
        receipt({ channel: "inbox", agentId: undefined, agentName: undefined, fanout: true, queued: 3, failed: 2 }),
        noneResolve,
      );
      expect(l?.spoken).toBe("The concierge left a message for 3 agents — 2 couldn't be reached.");
      expect(l?.spoken).not.toContain("delivers at each");
    });

    it("says a bare SEVERAL when there are no counts — the refusal shape", () => {
      const l = actionReceiptLine(broadcast("inbox"), noneResolve);
      expect(l?.spoken).toBe(
        "The concierge left a message for several agents — it delivers at each one's next turn.",
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
        "Refused the concierge's message to those agents — Name at least one agentId to broadcast to.",
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
      expect(l?.spoken).toBe(
        "Refused the concierge's message to that agent — agentId is required.",
      );
      expect(l?.spoken).not.toContain("those agents");
    });

    it("the positive control: a receipt that DOES name one agent stays singular", () => {
      // Without this, the assertions above would pass against a module that had simply stopped
      // naming anyone at all.
      expect(actionReceiptLine(receipt({ channel: "inbox" }), resolve)?.spoken).toBe(
        "The concierge left Left Pair a message — it delivers at their next turn.",
      );
    });
  });

  it("falls back to 'that agent' when there is no name either", () => {
    const l = actionReceiptLine(receipt({ agentName: undefined }), noneResolve);
    expect(l?.spoken).toBe(
      "The concierge sent the founder's words to that agent's terminal.",
    );
  });

  describe("each kind reads as what happened", () => {
    it("spawned", () => {
      expect(actionReceiptLine(receipt({ kind: "spawned" }), resolve)?.spoken).toBe(
        "The concierge spawned Left Pair.",
      );
    });
    it("closed", () => {
      expect(actionReceiptLine(receipt({ kind: "closed" }), resolve)?.spoken).toBe(
        "The concierge closed Left Pair.",
      );
    });
    it("goal", () => {
      expect(actionReceiptLine(receipt({ kind: "goal" }), resolve)?.spoken).toBe(
        "The concierge set a goal on Left Pair.",
      );
    });
    it("filed, with the bead as a pill", () => {
      const l = actionReceiptLine(
        receipt({ kind: "filed", beadId: "sparkle-kr2jz", agentId: undefined }),
        resolve,
      );
      expect(l?.spoken).toBe("The concierge filed sparkle-kr2jz.");
      expect(l?.md).toContain("sparkle-bead:sparkle-kr2jz");
    });
    it("filed with an unusable bead id keeps the line and loses only the pill", () => {
      const l = actionReceiptLine(receipt({ kind: "filed", beadId: "  " }), resolve);
      expect(l?.spoken).toBe("The concierge filed a task.");
    });
    it("merged, with the PR number", () => {
      // The `#` moved out of the STATIC text and into the pill's label, so the announcement drops
      // it — the same sigil rule that makes `ref()` speak "Left Pair" for a pill drawing "@Left
      // Pair". A live region read the old form aloud as "Merged PR hash 1175".
      expect(
        actionReceiptLine(receipt({ kind: "merged", prNumber: 1175 }), resolve)?.spoken,
      ).toBe("The concierge merged PR 1175.");
    });

    // ══ THE NUMBER IS A PILL — bead `sparkle-e9ziie` ════════════════════════════════════════════
    // "You said it's up. But I can't actually click on it." This module's own header quotes that
    // complaint and its rule 3 answers it for agents and beads; the merge line went out through
    // `plain()`, the explicitly NON-clickable slot, so it kept reproducing it.

    it("renders the PR number as a REFERENCE, not as plain text", () => {
      const l = actionReceiptLine(receipt({ kind: "merged", prNumber: 1175 }), resolve);
      expect(l?.md).toContain("[#1175](sparkle-pr:1175)");
    });

    it("QUALIFIES the reference with the repo the tool actually merged", () => {
      // The url comes from `mergePrTool`'s own reply. Without it the pill would resolve against
      // whichever project is selected when the line is READ, which for a cross-project thread is a
      // chance to open a different repository's PR of the same number.
      const l = actionReceiptLine(
        receipt({
          kind: "merged",
          prNumber: 1175,
          prUrl: "https://github.com/drodio/sparkle/pull/1175",
        }),
        resolve,
      );
      expect(l?.md).toContain("[#1175](sparkle-pr:drodio/sparkle#1175)");
      // The sentence a listener hears is unaffected by which form the eye gets.
      expect(l?.spoken).toBe("The concierge merged PR 1175.");
    });

    it("degrades to the plain sentence when a url names no repository we recognise", () => {
      // An unusable slug costs the QUALIFICATION, never the pill — `prRefHref` drops it and the
      // reference falls back to the unqualified form rather than to dead text.
      const l = actionReceiptLine(
        receipt({
          kind: "merged",
          prNumber: 1175,
          prUrl: "https://gitlab.example.com/o/r/merge_requests/1175",
        }),
        resolve,
      );
      expect(l?.md).toContain("[#1175](sparkle-pr:1175)");
    });

    it("still says plain 'Merged.' when there is no number to name", () => {
      const l = actionReceiptLine(receipt({ kind: "merged" }), resolve);
      expect(l?.spoken).toBe("The concierge merged.");
      expect(l?.md).not.toContain("sparkle-pr:");
    });
  });

  // ══ THE REFUSAL ARM ═══════════════════════════════════════════════════════════════════════════
  describe("a refused action still posts a line, and never borrows the success wording", () => {
    it("a refused send says NOT sent", () => {
      const l = actionReceiptLine(
        receipt({ ok: false, reason: "its terminal is showing a full-screen app" }),
        resolve,
      );
      expect(l?.spoken).toBe(
        "Refused the concierge's message to Left Pair — its terminal is showing a full-screen app",
      );
      // The regression this guards: a settle that assumed success once reported a REFUSED merge as
      // "Merged PR #753". A refusal must not read like the thing having happened — and the success
      // wording it must not borrow is now "The concierge sent the founder's words to X's terminal."
      expect(l?.spoken).not.toMatch(/^The concierge sent/);
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
        "Refused the concierge's merge of PR 753 — you do not have permission to merge in this repository",
      );
      expect(l?.spoken).not.toMatch(/^The concierge merged/);
    });

    it("a refusal with no stated reason still posts, just without the tail", () => {
      const l = actionReceiptLine(receipt({ kind: "closed", ok: false, reason: "  " }), resolve);
      expect(l?.spoken).toBe("Refused the concierge's close of Left Pair");
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
          "Refused the concierge's merge — the review gate has records to repair",
        ],
        [
          "Refused: Checks running (2): Node — shell and Node — coverage — merging now is merging blind.",
          "Refused the concierge's merge — waiting on checks",
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
      expect(l?.spoken).toMatch(/^Refused the concierge's merge/);
      expect(l?.spoken).not.toMatch(/^The concierge merged/);
    });

    it("a refused merge NAMES the PR, and names it as a reference", () => {
      // `prNumberOf` falls back to the ARGUMENT precisely for this arm, whose own comment says
      // "'Couldn't merge the PR' is a poorer answer than naming it" — and the line said exactly
      // that poorer thing, discarding the number the classifier preserved. A refusal is the receipt
      // the founder most needs to act on, and "which PR" is its first question.
      const l = actionReceiptLine(
        receipt({ kind: "merged", ok: false, prNumber: 753, reason: "GraphQL: unauthorized" }),
        resolve,
      );
      expect(l?.spoken).toBe(
        "Refused the concierge's merge of PR 753 — GraphQL: unauthorized",
      );
      expect(l?.md).toContain("[#753](sparkle-pr:753)");
    });

    it("STILL posts one the founder alone can clear — this is not a mute button", () => {
      // The regression that would make this change a silent-failure bug of its own.
      const l = actionReceiptLine(
        receipt({ kind: "merged", ok: false, reason: "GraphQL: unauthorized" }),
        resolve,
      );
      expect(l?.spoken).toBe("Refused the concierge's merge — GraphQL: unauthorized");
    });

    it("still posts a refusal that stated no reason", () => {
      // Absence is not evidence of an internal gate, and the existing line is already quiet.
      expect(
        actionReceiptLine(receipt({ kind: "closed", ok: false, reason: "  " }), resolve)?.spoken,
      ).toBe("Refused the concierge's close of Left Pair");
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
    expect(l?.spoken).toBe(`The concierge spawned Left Pair. ${LAUNCH_FAILED}`);
    // The specific regression: "— but I created the agent, but its terminal didn't start" is not a
    // sentence, and it is the shape the previous template produced.
    expect(l?.spoken).not.toContain("— but I created");
  });

  it("a clean spawn is still one short sentence — the positive control", () => {
    expect(actionReceiptLine(receipt({ kind: "spawned" }), resolve)?.spoken).toBe(
      "The concierge spawned Left Pair.",
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
    expect(l?.spoken).toBe("The concierge answered Left Pair's prompt.");
    // NOT the terminal-relay wording: a picker press moved a button the founder never read, so a
    // sentence claiming his words went to that terminal would be the rule-1 overstatement.
    expect(l?.spoken).not.toMatch(/sent the founder's words/i);
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
    expect(l?.spoken).toBe(
      "The concierge sent the founder's words to Left Pair's terminal.",
    );
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
    expect(l?.spoken).toMatch(/\bretired\b/);
    expect(l?.spoken).toContain("Left Pair");
    // NOT a gist. A shortened reason leaves him unable to check a decision nobody watched.
    expect(l?.spoken).toContain("its PR merged four hours ago");
  });

  it("is NOT worded as a close — he has to be able to tell the two apart", () => {
    // "Closed X" reads as something he asked for and might have forgotten; a retirement is the app
    // deciding on its own. That ambiguity is the whole reason `retired` is a separate kind.
    const l = actionReceiptLine(retired({ reason: "idle with a met goal" }), resolve);
    expect(l?.spoken).not.toMatch(/^The concierge closed /);
    // Positive control: the `closed` kind still produces exactly that wording.
    const closed = actionReceiptLine(receipt({ kind: "closed", channel: undefined }), resolve);
    expect(closed?.spoken).toBe("The concierge closed Left Pair.");
  });

  it("still names the agent when no reason came through", () => {
    const l = actionReceiptLine(retired(), resolve);
    expect(l?.spoken).toMatch(/\bretired\b/);
    expect(l?.spoken).toContain("Left Pair");
  });

  it("reports a refusal as a refusal, never as a retirement that happened", () => {
    const l = actionReceiptLine(retired({ ok: false, reason: "it has uncommitted changes" }), resolve);
    expect(l?.spoken).toMatch(/refused the concierge's retirement/i);
    expect(l?.spoken).not.toMatch(/^The concierge retired /);
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

// ══ WHOSE WORDS WENT — bead `sparkle-p9s5q` ══════════════════════════════════════════════════════
//
// The founder asked the concierge a question, the concierge wrote its OWN brief to two agents in
// that same turn, and the column rendered his message as though he had forwarded it to them. The
// badge on his bubble is gated elsewhere (ConciergeHost); this file owns the SENTENCE, which used to
// be silent about authorship and so could be read either way.
describe("a concierge-composed send says so", () => {
  /** A terminal send the concierge wrote itself: everything the relay fixture has, minus the one
   *  field that licenses a claim about the founder's words. */
  const composed = (over: Partial<ConciergeActionReceipt> = {}) =>
    receipt({ relayedFounderWords: undefined, ...over });

  it("attributes the concierge's own brief to the concierge", () => {
    expect(actionReceiptLine(composed(), resolve)?.spoken).toBe(
      "The concierge wrote to Left Pair.",
    );
  });

  it("does NOT claim the founder's message was sent anywhere", () => {
    // The exact wording the founder read as a forward. It must not appear over text he never wrote.
    const spoken = actionReceiptLine(composed(), resolve)!.spoken;
    // Asserted on the AUTHORSHIP CLAUSE, not on the verb: both arms now open "The concierge …", so a
    // `not.toContain("Sent to")` would pass against a module that had stopped drawing the
    // distinction at all. The relay arm is the only one that names whose words went.
    expect(spoken).not.toContain("the founder's words");
  });

  it("still RENDERS — his visibility into the fleet is not what was wrong", () => {
    // His explicit correction when offered "show nothing at all": "He needs to keep seeing what I
    // send to his fleet." So the row exists, names the agent, and keeps its clickable pill.
    const l = actionReceiptLine(composed(), resolve)!;
    expect(l.md).toContain(`sparkle-agent:${AGENT.id}`);
    expect(l.spoken).toContain("Left Pair");
  });

  it("keeps the RELAY wording when the send really did carry his words", () => {
    // The positive control, and the reason this pair is not vacuous: the same fixture with the flag
    // set takes the other arm, so these tests pin the FLAG rather than the fixture.
    expect(actionReceiptLine(receipt(), resolve)?.spoken).toBe(
      "The concierge sent the founder's words to Left Pair's terminal.",
    );
  });

  it("folds in its OWN bucket, so a count can never span both claims", () => {
    const relayKey = foldKeyOf(receiptMark(receipt(), resolve));
    const composedKey = foldKeyOf(receiptMark(composed(), resolve));
    // Both still fold — this is a split, not a refusal to fold.
    expect(relayKey).toBeTruthy();
    expect(composedKey).toBeTruthy();
    // …but never onto each other. One count over a mixture would land on the stronger claim.
    expect(composedKey).not.toBe(relayKey);
  });

  it("leaves the inbox and held channels alone — their wording never claimed authorship", () => {
    expect(actionReceiptLine(composed({ channel: "inbox" }), resolve)?.spoken).toBe(
      "The concierge left Left Pair a message — it delivers at their next turn.",
    );
    expect(actionReceiptLine(composed({ channel: "held" }), resolve)?.spoken).toBe(
      "The concierge is holding a message for Left Pair — it goes in when its terminal is ready.",
    );
  });

  it("leaves a REFUSED send alone — nothing was written, by anyone", () => {
    const l = actionReceiptLine(composed({ ok: false, reason: "that agent is mid-turn" }), resolve);
    expect(l?.spoken).not.toMatch(/concierge's wrote|concierge wrote to/i);
  });
});

// ══ THIRD PERSON, ABOUT THE CONCIERGE — bead `sparkle-4kgpb3` ═══════════════════════════════════
//
// The founder read these rows as the concierge talking to HIM. They are not: they are the app
// reporting to the CONCIERGE about a call the concierge made, and he is reading over its shoulder.
// The bug was grammatical before it was visual — "Not sent to @X — that text carries the founder's
// own words, and he did not name this agent" pairs an implied-"you" verb with a third-person "he",
// so the only reading left is the concierge addressing him. Greying the row (./noticeRecipient)
// cannot repair a sentence whose grammar says otherwise.
//
// EVERY ARM IS DRIVEN, not a sample. A wording rule that holds for the arms someone remembered to
// list is the shape this file already had — "Spawned Left Pair." passed a suite of exact-string
// assertions for months, because nothing ever asked the question these three tests ask.
describe("every sentence is third person about the concierge", () => {
  /** A stand-in for the TOOL's own verbatim words, and the reason it says "you".
   *
   *  Two arms cannot be reached without a reason at all — a spawn shortfall and a retirement's
   *  judgement — so those cases carry this, and the pronoun assertion below SLICES IT OUT before
   *  looking. The audit tail is addressed to the concierge and may legitimately be second person
   *  (rule 4 in the module header); rewriting it would destroy the record. Only the verb layer this
   *  module authors is under the rule, so only that is what gets asserted on. It is deliberately
   *  full of the exact pronouns being banned: if the slice ever stopped working, these tests would
   *  go red rather than quietly widening what they permit. */
  const TOOL_WORDS = "your gate is closed and you know it";

  type Arm = { readonly label: string; readonly receipt: ConciergeActionReceipt };

  /** Every SUCCESS return in the module, in source order. */
  const SUCCESS_ARMS: readonly Arm[] = [
    { label: "spawned, with a shortfall", receipt: receipt({ kind: "spawned", reason: TOOL_WORDS }) },
    { label: "spawned", receipt: receipt({ kind: "spawned" }) },
    {
      label: "broadcast with a partial failure",
      receipt: receipt({ channel: "inbox", agentId: undefined, agentName: undefined, fanout: true, queued: 3, failed: 2 }),
    },
    {
      label: "broadcast, all delivered",
      receipt: receipt({ channel: "inbox", agentId: undefined, agentName: undefined, fanout: true, queued: 5, failed: 0 }),
    },
    { label: "picker press", receipt: receipt({ channel: "terminal", viaPicker: true }) },
    { label: "held", receipt: receipt({ channel: "held" }) },
    {
      label: "inbox broadcast with no counts",
      receipt: receipt({ channel: "inbox", agentId: undefined, agentName: undefined, fanout: true }),
    },
    { label: "inbox, singular", receipt: receipt({ channel: "inbox" }) },
    { label: "terminal, concierge-composed", receipt: receipt({ relayedFounderWords: undefined }) },
    { label: "terminal, relaying his words", receipt: receipt({ relayedFounderWords: true }) },
    { label: "closed", receipt: receipt({ kind: "closed" }) },
    { label: "retired, with its reason", receipt: receipt({ kind: "retired", reason: TOOL_WORDS }) },
    { label: "retired", receipt: receipt({ kind: "retired" }) },
    { label: "goal", receipt: receipt({ kind: "goal" }) },
    { label: "filed, with a bead", receipt: receipt({ kind: "filed", beadId: "sparkle-kr2jz" }) },
    { label: "filed", receipt: receipt({ kind: "filed" }) },
    { label: "merged, with a PR", receipt: receipt({ kind: "merged", prNumber: 1175 }) },
    { label: "merged", receipt: receipt({ kind: "merged" }) },
  ];

  /** Every REFUSAL return in the module, in source order. None carries a reason: a refusal renders
   *  its tail only when one is present, so this is the shape in which the sentence is OURS alone. */
  const REFUSAL_ARMS: readonly Arm[] = [
    { label: "spawn", receipt: receipt({ kind: "spawned", ok: false }) },
    {
      label: "message to several agents",
      receipt: receipt({ kind: "sent", ok: false, agentId: undefined, agentName: undefined, fanout: true }),
    },
    { label: "message to one agent", receipt: receipt({ kind: "sent", ok: false }) },
    { label: "close", receipt: receipt({ kind: "closed", ok: false }) },
    { label: "retirement", receipt: receipt({ kind: "retired", ok: false }) },
    { label: "goal", receipt: receipt({ kind: "goal", ok: false }) },
    { label: "filing", receipt: receipt({ kind: "filed", ok: false }) },
    { label: "merge of a named PR", receipt: receipt({ kind: "merged", ok: false, prNumber: 753 }) },
    { label: "merge", receipt: receipt({ kind: "merged", ok: false }) },
  ];

  // ── THE ONE THAT PINS THE VOICE ───────────────────────────────────────────────────────────────
  // "Spawned Left Pair." names no actor, so the reader supplies one — and the only speaker on the
  // screen is the concierge. Naming it is what makes the sentence a REPORT rather than a claim in
  // the concierge's own voice. Asserted at the START of the sentence, because an actor buried mid-
  // clause is one the eye scanning a column never reaches.
  it("every SUCCESS arm names the concierge as the actor", () => {
    for (const { label, receipt: r } of SUCCESS_ARMS) {
      const l = actionReceiptLine(r, resolve);
      expect(l, `${label} must produce a line`).not.toBeNull();
      expect(l!.spoken, label).toMatch(/^the concierge /i);
    }
    // NOT A SAMPLE, and the count alone would not prove that — eighteen receipts that all landed on
    // the same arm would satisfy it. Distinctness is what makes the list a COVER: the module has
    // exactly 18 success returns, and 18 different sentences means each one was reached.
    const spoken = SUCCESS_ARMS.map((a) => actionReceiptLine(a.receipt, resolve)!.spoken);
    expect(new Set(spoken).size).toBe(18);
  });

  it("every REFUSAL arm names the concierge as the actor", () => {
    for (const { label, receipt: r } of REFUSAL_ARMS) {
      const l = actionReceiptLine(r, resolve);
      expect(l, `${label} must produce a line`).not.toBeNull();
      // POSSESSIVE, not "the concierge refused": the app is the refuser and the concierge is the one
      // refused, which is the whole direction the header "Sparkle → Concierge" states.
      expect(l!.spoken, label).toMatch(/the concierge's/i);
    }
    // Same cover argument as above: 9 distinct sentences from 9 receipts, against the module's 9
    // refusal returns. The `default` arm is deliberately absent — it returns null, which the
    // "posts NOTHING for an unrecognized kind" test owns.
    const spoken = REFUSAL_ARMS.map((a) => actionReceiptLine(a.receipt, resolve)!.spoken);
    expect(new Set(spoken).size).toBe(9);
  });

  // ── AND NO SECOND PERSON, IN EITHER RENDERING ─────────────────────────────────────────────────
  // The reader of this column is a third party to the exchange, so a "you" in OUR words is always
  // addressed to somebody who is not looking at it. Run over `md` as well as `spoken` because the
  // two are built from the same slots but not from the same static chunks — a pill's label is not
  // the word the live region hears, and only asserting on one of them leaves the other unguarded.
  it("no arm speaks to the reader in the second person", () => {
    for (const { label, receipt: r } of [...SUCCESS_ARMS, ...REFUSAL_ARMS]) {
      const l = actionReceiptLine(r, resolve);
      expect(l, `${label} must produce a line`).not.toBeNull();
      for (const [field, text] of [["spoken", l!.spoken], ["md", l!.md]] as const) {
        // THE TOOL'S WORDS ARE NOT OURS. Sliced, not permitted: the rest of the sentence is still
        // held to the rule, so an arm cannot escape it by growing a tail.
        const ours = text.split(TOOL_WORDS).join("");
        expect(ours, `${label} (${field})`).not.toMatch(/\byou\b/i);
        expect(ours, `${label} (${field})`).not.toMatch(/\byour\b/i);
        // The first person is the same failure wearing the other hat: "I couldn't spawn X" is the
        // concierge's voice, which is exactly what these rows must not be read as.
        expect(ours, `${label} (${field})`).not.toMatch(/\bI\b/);
        expect(ours, `${label} (${field})`).not.toMatch(/\bmy\b/i);
      }
    }
  });

  // ── THE NEGATIVE CONTROL FOR THE SLICE ────────────────────────────────────────────────────────
  // Without this, the test above would also pass if `TOOL_WORDS` never reached the sentence at all —
  // and then it would be asserting that a tail we simply dropped contains no pronouns. The tail is
  // the audit record (rule 1) and it must arrive verbatim, second person and all.
  it("the tool's own words REACH the line unedited, pronouns included", () => {
    const spawned = actionReceiptLine(receipt({ kind: "spawned", reason: TOOL_WORDS }), resolve);
    expect(spawned?.spoken).toBe(`The concierge spawned Left Pair. ${TOOL_WORDS}`);

    const refused = actionReceiptLine(
      receipt({ kind: "closed", ok: false, reason: TOOL_WORDS }),
      resolve,
    );
    expect(refused?.spoken).toBe(`Refused the concierge's close of Left Pair — ${TOOL_WORDS}`);
  });
});
