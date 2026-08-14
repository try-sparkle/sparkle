// THE FOLDING RULE, and the one thing it may never do.
//
// Every row here is about the same hazard: a folded line is a CLAIM about several actions at once,
// so it is the easiest place in the app to state something that is not true. The founder's wall of
// sixteen identical receipts is merely tiring; "Sent to 16 agents" over three silent refusals is
// false, and this file exists so that cannot ship.
import { describe, expect, it } from "vitest";

import {
  MIN_RUN,
  ANONYMOUS_SUBJECT,
  foldKeyOf,
  foldReceiptRuns,
  receiptRunLine,
  type ReceiptRun,
} from "./receiptRuns";
import {
  actionReceiptLine,
  receiptMark,
  type ResolveReceiptAgent,
} from "./actionReceiptLine";
import type { ConciergeActionReceipt } from "../../services/conciergeReceipts";
import type { ConciergeMessage, ConciergeReceiptMark } from "./types";

/** A successful terminal RELAY of the founder's words to `name`, as the thread would hold it.
 *
 *  `relayedFounderWords` is set because this fixture's own `text` reads "Sent to X's terminal" — the
 *  relay sentence. A mark that omitted it would be a row whose sentence and whose fold bucket
 *  disagreed about who wrote the message (bead `sparkle-p9s5q`). Concierge-composed runs have their
 *  own fixture and their own tests below. */
function sent(
  id: string,
  name: string,
  over: Partial<ConciergeReceiptMark> = {},
): ConciergeMessage {
  return {
    id,
    kind: "sparkle",
    text: `Sent to [@${name}](sparkle-agent:${id}-agent)'s terminal.`,
    actionReceipt: {
      kind: "sent",
      ok: true,
      channel: "terminal",
      relayedFounderWords: true,
      subjectId: `${id}-agent`,
      subjectName: name,
      ...over,
    },
  };
}

/** The same send, but the text was the CONCIERGE'S OWN — the population that used to be rendered as
 *  a forward of the founder's message. */
function composed(
  id: string,
  name: string,
  over: Partial<ConciergeReceiptMark> = {},
): ConciergeMessage {
  return sent(id, name, { relayedFounderWords: undefined, ...over });
}

/** A REFUSED send — the population that must never be swallowed. */
function refused(id: string, name: string): ConciergeMessage {
  return sent(id, name, { ok: false });
}

const prose = (id: string): ConciergeMessage => ({
  id,
  kind: "sparkle",
  text: "Here's what I found.",
});

const runOf = (messages: ConciergeMessage[]): ReceiptRun => {
  const rows = foldReceiptRuns(messages);
  const run = rows.find((r) => r.type === "receipt-run");
  if (!run || run.type !== "receipt-run")
    throw new Error("expected a folded run");
  return run;
};

describe("foldKeyOf — which receipts may fold at all", () => {
  it("REFUSES to fold a refusal the FOUNDER must read, whatever else matches", () => {
    // The rule the whole feature is subordinate to — now stated precisely. A refusal with no `gist`
    // is one `refusalAudience` judged the founder's: its verbatim words are the to-do item, and a
    // count cannot say them. (An INTERNAL gate carries a gist and does fold; see the block below.)
    expect(
      foldKeyOf({ kind: "sent", ok: false, channel: "terminal" }),
    ).toBeNull();
    expect(foldKeyOf({ kind: "spawned", ok: false })).toBeNull();
    expect(foldKeyOf({ kind: "closed", ok: false })).toBeNull();
    expect(foldKeyOf({ kind: "goal", ok: false })).toBeNull();
  });

  it("refuses a PARTIAL fan-out, which reports ok while carrying failures", () => {
    // `inboxBroadcast` answers ok with `{queued, failed}`. Keying on `ok` alone would roll the
    // failures into a success count — the exact misstatement, one layer up, that `actionReceiptLine`
    // was already fixed for.
    expect(
      foldKeyOf({ kind: "sent", ok: true, channel: "inbox", failed: 3 }),
    ).toBeNull();
    // …and a fan-out that genuinely lost nobody still does not fold, because it is already plural.
    expect(
      foldKeyOf({
        kind: "sent",
        ok: true,
        channel: "inbox",
        fanout: true,
        failed: 0,
      }),
    ).toBeNull();
  });

  it("keeps the three send CHANNELS in separate buckets — they are visible at different times", () => {
    const k = (channel: ConciergeReceiptMark["channel"]) =>
      foldKeyOf({ kind: "sent", ok: true, channel });
    expect(new Set([k("terminal"), k("inbox"), k("held")]).size).toBe(3);
  });

  it("keeps a picker press out of the message bucket", () => {
    expect(
      foldKeyOf({
        kind: "sent",
        ok: true,
        channel: "terminal",
        viaPicker: true,
      }),
    ).not.toBe(foldKeyOf({ kind: "sent", ok: true, channel: "terminal" }));
  });

  it("refuses a SUCCESS that carries a shortfall — ok is not 'nothing to read here'", () => {
    // A spawn whose agent came up but could NOT be briefed reports `ok: true` and renders the
    // failure as a second sentence ("its terminal didn't start … its opening brief hasn't gone in
    // yet"). The `ok` guard above says nothing about it, so without this one a fleet spawn folds to
    // "Spawned 5 agents." and the reader never learns that three of them are sitting there doing
    // nothing — a refusal in a success's clothes.
    expect(
      foldKeyOf({ kind: "spawned", ok: true, hasDetail: true }),
    ).toBeNull();
    // …and the ordinary spawn beside it is unaffected, so this is a guard and not a blanket refusal.
    expect(foldKeyOf({ kind: "spawned", ok: true })).toBe("spawned");
  });

  it("never folds `filed` or `merged` — each line carries an identifier the reader came for", () => {
    expect(foldKeyOf({ kind: "filed", ok: true })).toBeNull();
    expect(foldKeyOf({ kind: "merged", ok: true })).toBeNull();
  });

  it("folds the ordinary successes", () => {
    expect(
      foldKeyOf({ kind: "sent", ok: true, channel: "terminal", relayedFounderWords: true }),
    ).toBe("sent:terminal");
    expect(foldKeyOf({ kind: "spawned", ok: true })).toBe("spawned");
  });

  it("buckets a mark that does NOT claim the founder's words as the concierge's own", () => {
    // FAIL-CLOSED, and the direction matters (bead `sparkle-p9s5q`). A mark with no
    // `relayedFounderWords` has not shown that his words went anywhere, so it may not join the
    // bucket whose sentence says they did. That also covers a mark rehydrated from a thread
    // persisted before this field existed: such a row is re-bucketed as the concierge's, which
    // understates nothing and asserts nothing — the opposite default would keep asserting a forward
    // no one can now verify.
    expect(foldKeyOf({ kind: "sent", ok: true, channel: "terminal" })).toBe(
      "sent:terminal:concierge",
    );
  });

  it("returns null for a message carrying no mark at all", () => {
    expect(foldKeyOf(undefined)).toBeNull();
  });
});

describe("foldReceiptRuns — the founder's screenshot", () => {
  it("collapses sixteen identical terminal sends into ONE row", () => {
    const wall = Array.from({ length: 16 }, (_, i) =>
      sent(`s${i}`, `Agent ${i}`),
    );
    const rows = foldReceiptRuns(wall);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe("receipt-run");
    // The count is the members, and there is no second number that could disagree with it.
    expect(runOf(wall).members).toHaveLength(16);
  });

  it("leaves a LONE receipt as its own row — never a group of one", () => {
    const rows = foldReceiptRuns([sent("s0", "Only One")]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe("message");
  });

  it("folds at exactly MIN_RUN and not below it", () => {
    const below = Array.from({ length: MIN_RUN - 1 }, (_, i) =>
      sent(`s${i}`, `A${i}`),
    );
    const at = Array.from({ length: MIN_RUN }, (_, i) =>
      sent(`s${i}`, `A${i}`),
    );
    expect(foldReceiptRuns(below).every((r) => r.type === "message")).toBe(
      true,
    );
    expect(foldReceiptRuns(at).some((r) => r.type === "receipt-run")).toBe(
      true,
    );
  });

  it("STANDS A REFUSAL ON ITS OWN between two folded runs", () => {
    // This afternoon's shape: a burst of sends with rejections inside it. The refusal must not be
    // counted, must not be hidden, and must stay where it happened.
    const messages = [
      ...Array.from({ length: 3 }, (_, i) => sent(`a${i}`, `A${i}`)),
      refused("bad", "Broken One"),
      ...Array.from({ length: 4 }, (_, i) => sent(`b${i}`, `B${i}`)),
    ];
    const rows = foldReceiptRuns(messages);
    expect(rows.map((r) => r.type)).toEqual([
      "receipt-run",
      "message",
      "receipt-run",
    ]);
    // The refusal is present, in its own row, still itself.
    expect(rows[1]).toMatchObject({ type: "message", message: { id: "bad" } });
    // And NEITHER count includes it.
    const counts = rows
      .filter((r) => r.type === "receipt-run")
      .map((r) => (r as ReceiptRun).members.length);
    expect(counts).toEqual([3, 4]);
    expect(
      rows
        .filter((r): r is ReceiptRun => r.type === "receipt-run")
        .flatMap((r) => r.members.map((m) => m.id)),
    ).not.toContain("bad");
  });

  it("never folds ACROSS an unrelated message — order is the record", () => {
    const rows = foldReceiptRuns([
      sent("a", "A"),
      sent("b", "B"),
      prose("p"),
      sent("c", "C"),
      sent("d", "D"),
    ]);
    expect(rows.map((r) => r.type)).toEqual([
      "receipt-run",
      "message",
      "receipt-run",
    ]);
  });

  it("never folds two DIFFERENT channels together", () => {
    const rows = foldReceiptRuns([
      sent("a", "A"),
      sent("b", "B"),
      sent("c", "C", { channel: "inbox" }),
      sent("d", "D", { channel: "inbox" }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.type === "receipt-run")).toBe(true);
  });

  it("returns every message exactly once, folded or not", () => {
    // The structural guarantee behind "compressed, not deleted": folding is a regrouping, and a
    // regrouping that loses or duplicates a row is a bug no wording test would catch.
    const messages = [
      sent("a", "A"),
      sent("b", "B"),
      refused("r", "R"),
      prose("p"),
      sent("c", "C"),
    ];
    const seen = foldReceiptRuns(messages).flatMap((r) =>
      r.type === "message" ? [r.message.id] : r.members.map((m) => m.id),
    );
    expect(seen).toEqual(messages.map((m) => m.id));
  });
});

describe("receiptRunLine — the count has to be true", () => {
  it("counts the agents, and names every one of them as a clickable pill", () => {
    const run = runOf(
      Array.from({ length: 16 }, (_, i) => sent(`s${i}`, `Agent ${i}`)),
    );
    const l = receiptRunLine(run);
    expect(l.spoken).toContain("Sent to 16 agents' terminals.");
    // THE PILLS SURVIVE THE FOLD. They are how the founder reaches an agent, so a fold that
    // flattened them to text would cost him the navigation the wall of rows at least had.
    for (let i = 0; i < 16; i += 1) {
      expect(l.md).toContain(`[@Agent ${i}](sparkle-agent:s${i}-agent)`);
    }
  });

  it("says SENDS and AGENTS separately when one agent was sent to twice", () => {
    // Three receipts, two agents. "Sent to 3 agents' terminals" would be false, and it is the
    // easiest false thing for a count to say.
    const run = runOf([
      sent("a", "Alpha"),
      // The SAME agent, sent to a second time: a different message, one subject.
      sent("b", "Alpha", { subjectId: "a-agent" }),
      sent("c", "Gamma"),
    ]);
    expect(run.members).toHaveLength(3);
    const l = receiptRunLine(run);
    expect(l.spoken).toContain("Sent 3 messages to 2 agents' terminals.");
    // AND THE PILLS AGREE WITH THAT NUMBER. Two agents, two chips — not one per message. The
    // sentence and the residue are derived from one key (`subjectKey`) precisely so a reader who
    // counts chips cannot get a number the sentence contradicts.
    expect(l.md.match(/sparkle-agent:/g) ?? []).toHaveLength(2);
  });

  it("draws ONE pill per agent, not one per message — the residue cannot outrun the count", () => {
    // roborev 59145. The count was fixed to say "1 agent" while the pills still iterated MEMBERS, so
    // sixteen sends to one pinned agent read "Sent 16 messages to 1 agent's terminal." and then drew
    // SIXTEEN identical @Alpha chips: the identical-chip wall this fold exists to remove, rebuilt
    // inside the row that replaced it, under a sentence that contradicts it.
    const run = runOf(
      Array.from({ length: 16 }, (_, i) =>
        sent(`s${i}`, "Alpha", { subjectId: "one-agent" }),
      ),
    );
    const l = receiptRunLine(run);
    expect(run.members).toHaveLength(16);
    expect(l.spoken).toContain("Sent 16 messages to 1 agent's terminal.");
    expect(l.md.match(/sparkle-agent:/g) ?? []).toHaveLength(1);
  });

  it("never dedupes an UNIDENTIFIABLE member — it cannot be proven to be a repeat", () => {
    // The other half of the same rule: `subjectKey` returns null for a member with no id and no
    // name, and three of those are three agents, not one. Merging them would UNDER-report, which is
    // the same class of error as the over-reporting above.
    const run = runOf(
      Array.from({ length: 3 }, (_, i) =>
        sent(`s${i}`, "x", { subjectId: undefined, subjectName: undefined }),
      ),
    );
    const l = receiptRunLine(run);
    expect(l.spoken).toContain("Sent to 3 agents' terminals.");
    // COUNTED BY SPLITTING, NOT BY `new RegExp(ANONYMOUS_SUBJECT, "g")` (roborev 63529, then 63539
    // — raised twice before it was addressed). The whole premise of the shared symbol is that this
    // copy gets EDITED, and interpolating it into a pattern breaks the moment it contains a
    // metacharacter: an unbalanced `(` throws and takes the file down, while `.`, `?`, `+` or `|`
    // silently change what is counted. This is the one assertion holding the count-truth invariant
    // — three unidentifiable members must yield three fallback slots — so a quietly loose match is
    // a hole in exactly the rule it guards. `split` treats the constant as the literal text it is.
    expect(l.spoken.split(ANONYMOUS_SUBJECT).length - 1).toBe(3);
  });

  it("agrees with ONE agent — the count the repeats wording is easiest to get wrong", () => {
    // Two sends to the same pinned agent: `repeats` is true with ONE distinct subject, which is the
    // branch that read "Sent 2 messages to 1 agents' terminals." The apostrophe MOVES, the noun
    // follows the agent count and not the message count.
    const terminal = runOf([
      sent("a", "Alpha"),
      sent("b", "Alpha", { subjectId: "a-agent" }),
    ]);
    expect(receiptRunLine(terminal).spoken).toContain(
      "Sent 2 messages to 1 agent's terminal.",
    );

    // The same shape on every other repeats arm, because each spliced the same hard-coded plural.
    const inbox = runOf([
      sent("c", "Beta", { channel: "inbox" }),
      sent("d", "Beta", { channel: "inbox", subjectId: "c-agent" }),
    ]);
    expect(receiptRunLine(inbox).spoken).toContain(
      "Left 2 messages for 1 agent —",
    );

    const held = runOf([
      sent("e", "Gamma", { channel: "held" }),
      sent("f", "Gamma", { channel: "held", subjectId: "e-agent" }),
    ]);
    expect(receiptRunLine(held).spoken).toContain(
      "Holding 2 messages for 1 agent —",
    );

    const goals = runOf([
      sent("g", "Delta", { kind: "goal", channel: undefined }),
      sent("h", "Delta", {
        kind: "goal",
        channel: undefined,
        subjectId: "g-agent",
      }),
    ]);
    expect(receiptRunLine(goals).spoken).toContain("Set 2 goals on 1 agent.");

    const picker = runOf([
      sent("i", "Eps", { viaPicker: true }),
      sent("j", "Eps", { viaPicker: true, subjectId: "i-agent" }),
    ]);
    expect(receiptRunLine(picker).spoken).toContain(
      "Answered 2 prompts across 1 agent.",
    );

    const spawns = runOf([
      sent("k", "Zeta", { kind: "spawned", channel: undefined }),
      sent("l", "Zeta", {
        kind: "spawned",
        channel: undefined,
        subjectId: "k-agent",
      }),
    ]);
    expect(receiptRunLine(spawns).spoken).toContain(
      "Spawned 1 agent, in 2 calls.",
    );
  });

  it("keeps the inbox DELAY in the folded sentence", () => {
    // Rule 2 of actionReceiptLine does not get to lapse because the rows were folded: an inbox
    // message is invisible until the agent's next turn, and that is the whole claim.
    const run = runOf(
      Array.from({ length: 3 }, (_, i) =>
        sent(`s${i}`, `A${i}`, { channel: "inbox" }),
      ),
    );
    expect(receiptRunLine(run).spoken).toContain(
      "delivers at each one's next turn",
    );
  });

  it("does not upgrade HELD to delivered", () => {
    const run = runOf(
      Array.from({ length: 3 }, (_, i) =>
        sent(`s${i}`, `A${i}`, { channel: "held" }),
      ),
    );
    const spoken = receiptRunLine(run).spoken;
    expect(spoken).toContain("Holding");
    expect(spoken).not.toContain("Sent to");
  });

  it("degrades to words, never to an invented reference, when the agent did not resolve", () => {
    const run = runOf(
      Array.from({ length: 2 }, (_, i) =>
        sent(`s${i}`, `A${i}`, {
          subjectId: undefined,
          subjectName: `Ghost ${i}`,
        }),
      ),
    );
    const l = receiptRunLine(run);
    expect(l.md).not.toContain("sparkle-agent:");
    expect(l.spoken).toContain("Ghost 0");
  });

  it("counts an unresolvable subject as its own agent — a repeat cannot be assumed", () => {
    const run = runOf(
      Array.from({ length: 3 }, (_, i) =>
        sent(`s${i}`, "x", { subjectId: undefined, subjectName: undefined }),
      ),
    );
    // Three anonymous subjects are three, not one. Collapsing them would UNDER-report.
    expect(receiptRunLine(run).spoken).toContain(
      "Sent to 3 agents' terminals.",
    );
  });
});


// ── AN INTERNAL-GATE REFUSAL FOLDS ON `kind + gist` (roborev 63295, Medium) ────────────────────
//
// Keeping every refusal row is right — it is the only thing that can contradict a turn claiming the
// action succeeded — but these repeat BY CONSTRUCTION: a merge re-attempted while checks settle, a
// five-agent fan-out refusing per spawn at capacity. The founder's own report said he saw them
// "verbatim and repeatedly". Unfoldable, that trades N paragraphs for N identical rows, which is
// the same column-of-identical-rows this module exists to end.
describe("internal-gate refusals fold; founder-facing ones never do", () => {
  const gated = (
    id: string,
    over: Partial<ConciergeReceiptMark> = {},
  ): ConciergeMessage => ({
    id,
    kind: "sparkle",
    text: "Didn't merge — waiting on checks",
    actionReceipt: {
      kind: "merged",
      ok: false,
      gist: "waiting on checks",
      ...over,
    },
  });

  it("gives a gist-carrying refusal a key, and a bare one none", () => {
    expect(foldKeyOf({ kind: "merged", ok: false, gist: "waiting on checks" })).toBe(
      "refusal:merged:waiting on checks",
    );
    expect(foldKeyOf({ kind: "merged", ok: false })).toBeNull();
  });

  it("does NOT collapse two different reasons into one count", () => {
    // The reason is the whole content of the folded sentence; merging "waiting on checks" with
    // "no free agent slot right now" would state something neither row said.
    expect(foldKeyOf({ kind: "merged", ok: false, gist: "waiting on checks" })).not.toBe(
      foldKeyOf({ kind: "merged", ok: false, gist: "no free agent slot right now" }),
    );
    // …nor two different KINDS that happen to share a gist.
    expect(foldKeyOf({ kind: "merged", ok: false, gist: "waiting on checks" })).not.toBe(
      foldKeyOf({ kind: "spawned", ok: false, gist: "waiting on checks" }),
    );
  });

  it("collapses a run of identical gate refusals into ONE row that still says the reason", () => {
    const run = runOf([gated("a"), gated("b"), gated("c")]);
    expect(run.members).toHaveLength(3);
    const line = receiptRunLine(run);
    // THE WHOLE STRING, not a prefix plus `toContain` (roborev 63364). Those weaker assertions all
    // held while the line ended `— that agent, that agent, that agent`: `merged` carries no agent
    // subject, and `withSubjects` was appending a phantom chip per member. An assertion that cannot
    // see a residue is not guarding the sentence, it is guarding its opening words.
    expect(line.spoken).toBe("Didn't merge, 3 times — waiting on checks");
    expect(line.md).toBe("Didn't merge, 3 times — waiting on checks");
    expect(line.spoken).not.toMatch(/^Merged/);
  });

  it("suppresses the residue on a MIXED run — one named member must not revive it", () => {
    // roborev 63476. `land_agent_branch` also classifies to `kind: "merged"` and DOES carry an
    // agentId, so a run mixing one of those with two `merge_pr` refusals on the same gist folds
    // together. An all-or-nothing "did anyone resolve?" guard flips on that single member and
    // restores the residue for the other two:
    //     Didn't merge, 3 times — waiting on checks — @Alpha, that agent, that agent
    // Both earlier cases used FULLY anonymous runs, so neither could see it.
    const named = gated("a", {
      subjectId: "11111111-2222-3333-4444-555555555555",
      subjectName: "Alpha",
    });
    const l = receiptRunLine(runOf([named, gated("b"), gated("c")]));
    // THE INVENTED CHIPS GO; THE REAL ONE STAYS (roborev 63482 refined this). @Alpha's row really
    // did name @Alpha — `land_agent_branch` classifies to `merged` WITH an agentId — so dropping it
    // would lose navigation the unfolded row had, which is the same invariant pointed the other
    // way. What must never appear is a chip for a member that named nobody.
    expect(l.spoken).not.toContain(ANONYMOUS_SUBJECT);
    expect(l.md).not.toContain(ANONYMOUS_SUBJECT);
    expect(l.md).toContain("Alpha");
    // The count still speaks for all three, named or not — it counts `total`, not subjects.
    expect(l.spoken).toContain("Didn't merge, 3 times — waiting on checks");
  });

  it("KEEPS real pills on a `sent` fan-out — those rows DID name their agents", () => {
    // roborev 63482. `sent` is count-shaped ("Not sent, 3 times") but its marks carry REAL subjects:
    // `subjectOf` reads agentId/agentName off the args for every non-spawned kind, and a
    // per-recipient fan-out refusing on one shared gist folds under `refusal:sent:<gist>` — exactly
    // the shape this fold was built for. Blanket suppression threw away three genuine pills and
    // with them WHICH agents never got the message. Filtering is safe here because the sentence
    // counts `total`, not `distinctSubjects`.
    const who = (n: string, id: string) =>
      gated("m" + n, {
        kind: "sent",
        gist: "no free agent slot right now",
        subjectId: id,
        subjectName: n,
      });
    const l = receiptRunLine(
      runOf([
        who("Alpha", "11111111-2222-3333-4444-555555555555"),
        who("Beta", "22222222-2222-3333-4444-555555555555"),
        who("Gamma", "33333333-2222-3333-4444-555555555555"),
      ]),
    );
    expect(l.spoken).toContain("Not sent, 3 times");
    expect(l.spoken).toContain("no free agent slot right now");
    for (const n of ["Alpha", "Beta", "Gamma"]) expect(l.md, n).toContain(n);
    // …and still no invented chip alongside the real ones.
    expect(l.spoken).not.toContain(ANONYMOUS_SUBJECT);
  });

  it("drops ONLY the invented chips on a mixed `sent` run, keeping the real one", () => {
    const l = receiptRunLine(
      runOf([
        gated("a", {
          kind: "sent",
          subjectId: "11111111-2222-3333-4444-555555555555",
          subjectName: "Alpha",
        }),
        gated("b", { kind: "sent" }),
        gated("c", { kind: "sent" }),
      ]),
    );
    expect(l.md).toContain("Alpha");
    expect(l.spoken).not.toContain(ANONYMOUS_SUBJECT);
    // The COUNT still speaks for every member, named or not — it counts `total`, not subjects.
    expect(l.spoken).toContain("3 times");
  });

  it("drops an ID-WITHOUT-NAME member — it renders as 'that agent', not as a name", () => {
    // roborev 63506. The filter used to key on `subjectKey`, which is satisfied by an id alone —
    // but `subjectSlot` draws a pill only when the id AND a non-empty name are present, and falls
    // back to the literal words otherwise. So an id-without-name member passed the filter and
    // rendered exactly the invented chip the filter exists to drop; and because `subjectList`
    // dedupes by `subjectKey`, two of them with different ids produced "that agent, that agent".
    // Reachable in production: `receiptMark` writes subjectId alongside a possibly-empty name.
    for (const kind of ["merged", "sent"] as const) {
      const l = receiptRunLine(
        runOf([
          gated("a", { kind, subjectId: "11111111-2222-3333-4444-555555555555" }),
          gated("b", { kind, subjectId: "22222222-2222-3333-4444-555555555555" }),
          gated("c", { kind, subjectId: "33333333-2222-3333-4444-555555555555", subjectName: "   " }),
        ]),
      );
      expect(l.spoken, kind).not.toContain(ANONYMOUS_SUBJECT);
      expect(l.md, kind).not.toContain(ANONYMOUS_SUBJECT);
    }
  });

  it("still keeps a NAME-ONLY member, which the row really did show", () => {
    // The other side of the same predicate: no id means no pill, but the words are the words the
    // unfolded row used, so dropping them would lose something real.
    const l = receiptRunLine(
      runOf([
        gated("a", { kind: "sent", subjectName: "Alpha" }),
        gated("b", { kind: "sent" }),
      ]),
    );
    expect(l.md).toContain("Alpha");
    expect(l.spoken).not.toContain(ANONYMOUS_SUBJECT);
  });

  it("KEEPS the subject list on the who-shaped arms, where chips and count share a source", () => {
    // The other half, and the reason this is decided by sentence shape rather than by suppressing
    // chips everywhere: "Couldn't spawn 2 agents" counts via `distinctSubjects`, so dropping its
    // chips would leave a count with nothing behind it (the failure roborev 59145 fixed).
    const a = gated("a", {
      kind: "spawned",
      subjectId: "11111111-2222-3333-4444-555555555555",
      subjectName: "Alpha",
    });
    const b = gated("b", {
      kind: "spawned",
      subjectId: "22222222-2222-3333-4444-555555555555",
      subjectName: "Beta",
    });
    const l = receiptRunLine(runOf([a, b]));
    expect(l.spoken).toContain("Couldn't spawn 2 agents");
    expect(l.md).toContain("Alpha");
    expect(l.md).toContain("Beta");
  });

  it("names NOBODY when the kind carries no subject — no phantom 'that agent' chips", () => {
    // `merged` and `filed` get a prNumber/beadId, never an agentId, so a folded run of them has no
    // one to name. `subjectSlot` falls back to the words "that agent" for an anonymous member, which
    // is right for a COUNT and wrong here: it invents subjects the unfolded rows never showed, and
    // rebuilds the identical-chip wall roborev 59145 removed.
    for (const kind of ["merged", "filed"] as const) {
      const l = receiptRunLine(
        runOf([gated("a", { kind }), gated("b", { kind }), gated("c", { kind })]),
      );
      expect(l.spoken, kind).not.toContain(ANONYMOUS_SUBJECT);
      expect(l.md, kind).not.toContain(ANONYMOUS_SUBJECT);
    }
  });

  it("keeps founder-facing refusals as separate rows in the same feed", () => {
    // The mixed case: three gate refusals fold, and a refusal he must act on stands alone beside
    // them rather than being counted into the run.
    const rows = foldReceiptRuns([
      gated("a"),
      gated("b"),
      gated("c"),
      {
        id: "d",
        kind: "sparkle" as const,
        text: "Didn't merge — GraphQL: unauthorized",
        actionReceipt: { kind: "merged" as const, ok: false },
      },
    ]);
    const runs = rows.filter((r) => r.type === "receipt-run");
    expect(runs).toHaveLength(1);
    // The un-gisted one is still its own message row.
    expect(rows.some((r) => r.type !== "receipt-run")).toBe(true);
  });

  it("uses the right verb per kind — a fold never borrows another action's wording", () => {
    for (const [kind, pattern] of [
      ["merged", /^Didn't merge/],
      ["spawned", /^Couldn't spawn/],
      ["closed", /^Couldn't close/],
      ["goal", /^Couldn't set a goal/],
      ["filed", /^Couldn't file/],
    ] as const) {
      const run = runOf([
        gated("a", { kind }),
        gated("b", { kind }),
        gated("c", { kind }),
      ]);
      expect(receiptRunLine(run).spoken, kind).toMatch(pattern);
      expect(receiptRunLine(run).spoken, kind).toContain("waiting on checks");
      // NO INVENTED SUBJECTS ON THE COUNT-SHAPED ARMS. Scoped deliberately: `spawned`/`closed`/
      // `goal` say "N agents" from `distinctSubjects`, so an anonymous member there is counted AND
      // slotted, and the two agree — that is the pre-existing contract, not the residue bug. The
      // count-shaped arms name nobody, so any chip under them is invented.
      if (kind === "merged" || kind === "filed")
        expect(receiptRunLine(run).spoken, kind).not.toContain(ANONYMOUS_SUBJECT);
    }
  });
});


// ── THE GUARDS KEY ON THE SYMBOL, AND THE SYMBOL IS WHAT THE CODE EMITS ────────────────────────
//
// roborev 63515. Every residue guard above reads `ANONYMOUS_SUBJECT` rather than the literal
// "that agent", so a copy edit to the fallback moves the assertions with it instead of leaving
// them asserting the absence of a word nothing emits any more. That indirection is only worth
// anything if the symbol really is what an anonymous member renders as — which is what this pins.
describe("ANONYMOUS_SUBJECT is the fallback the renderer actually uses", () => {
  it("is what a member with no showable name renders as", () => {
    const anon: ConciergeMessage = {
      id: "x",
      kind: "sparkle",
      text: "Couldn't spawn that agent — no free agent slot right now",
      actionReceipt: { kind: "spawned", ok: false, gist: "no free agent slot right now" },
    };
    // `spawned` is who-shaped, so its residue is emitted whole — including the fallback slot.
    const l = receiptRunLine(runOf([anon, { ...anon, id: "y" }]));
    expect(l.spoken).toContain(ANONYMOUS_SUBJECT);
  });

  it("is a non-empty string, so the guards above cannot be trivially satisfied", () => {
    // A blank constant would make every `not.toContain(ANONYMOUS_SUBJECT)` assertion meaningless.
    expect(ANONYMOUS_SUBJECT.trim().length).toBeGreaterThan(0);
  });
});


// ── THE FOLDED ROW'S WORDS ARE THE UNFOLDED ROW'S WORDS (roborev 63525, fixed 63529) ──────────
//
// The fold's core invariant is that it never shows a reader something the rows it replaced did not.
// The anonymous fallback used to exist as FIVE separate literals — `ref()`, `actionReceiptLine`'s
// `who()`, its `spawned` refusal arm, this module's own constant, and `ConciergeHost`'s
// deferred-send outcome arm — so editing the wording where an individual row renders it left the
// fold saying the old words beside rows saying the new ones.
//
// EVERY EARLIER VERSION OF THIS SENTENCE UNDERCOUNTED, and that is the durable lesson rather than
// the number: it said "three", then "four", each time naming the copies someone had found so far,
// and each time a future reader took the enumeration as complete. Do not trust it — re-run the
// uncapped grep in `conciergeLine.ts`'s block comment, which must return exactly one producer.
//
// TWO VERSIONS OF THIS TEST FAILED TO SEE IT, and both failures are worth keeping.
//
// The first fed a `{kind: "spawned", ok: false}` receipt, whose refusal arm returned a HARD-CODED
// "Couldn't spawn that agent" and never called `who()` at all. So the one line the commit changed
// was not reached by the test written to cover it — revert `who()` and everything stayed green. An
// earlier branch short-circuiting the mechanism under test is the exact vacuous shape AGENTS.md
// names, and driving the real entry point was necessary but not sufficient.
//
// The second migrated that arm to `plain(ANONYMOUS_SUBJECT)` and asserted the row equalled
// `Couldn't spawn ${ANONYMOUS_SUBJECT}` — an expectation that is BYTE-IDENTICAL to what the literal
// produced, so it passed against the very code it existed to replace, and renaming the constant
// moved both sides together. An assertion that reads the same symbol the code reads cannot fail
// (roborev 63540). The arm now takes `subject` from `who()` like every other one, and the cases
// below compare the two modules' words AGAINST EACH OTHER instead of against a shared constant.
//
// `closed` carries the anonymous case because BOTH sides genuinely render the fallback: the unfolded
// arm is `Couldn't close ${subject}` with `subject` coming from `who()`, and the folded arm is
// who-shaped, so its residue emits `subjectSlot`. A count-shaped kind (`sent`, `merged`) would not
// work — those filter their residue away entirely, so the fold would have no words to compare.
// ONE RECEIPT, RENDERED TWICE — never two independently-constructed inputs (roborev 63540, Medium).
// The row half is `actionReceiptLine`, the fold half is `receiptMark` → `subjectSlot`, and both are
// derived from the SAME receipt object here. A hand-built mark can be given a `gist` no producer
// writes, and then the fold half is a shape production cannot reach: the first version of the case
// below set `reason: "a code review is still running"`, which is a gist OUTPUT rather than a gate's
// own phrasing, so `refusalGist` returns null, `receiptMark` writes no `gist`, `foldKeyOf` returns
// null at the refusal arm, and a run of those never folds at all. The reason strings here are the
// producers' sentences, so the gist is derived rather than asserted into place.
function bothWays(
  receipt: ConciergeActionReceipt,
  // ONE resolver for both halves, never two. `who()` and `receiptMark` each call it, and the whole
  // correspondence being tested is that they get the same answer — handing them different lookups
  // would let the test pass while production drew a pill on one side and words on the other.
  resolve: ResolveReceiptAgent = () => null,
): {
  row: string;
  md: string;
  folded: string;
  foldedMd: string;
} {
  const asMessage = (r: ConciergeActionReceipt): ConciergeMessage => ({
    id: r.id,
    kind: "sparkle",
    text: actionReceiptLine(r, resolve)?.md ?? "",
    actionReceipt: receiptMark(r, resolve),
  });
  const single = actionReceiptLine(receipt, resolve);
  // `runOf` THROWS when nothing folded, which is what makes the derived mark load-bearing: a
  // reason whose gist is null cannot reach the assertions below, it fails here instead.
  const fold = receiptRunLine(
    runOf([asMessage(receipt), asMessage({ ...receipt, id: `${receipt.id}b` })]),
  );
  // BOTH RENDERINGS, because `.spoken` cannot see a pill at all — it flattens one to the bare name,
  // so a row that minted a chip and a row that printed words read identically there. The pill case
  // below is only visible in `.md`, and a test asserting `.spoken` alone is how a residue bug got
  // past this file once before.
  return {
    row: single?.spoken ?? "",
    md: single?.md ?? "",
    folded: fold.spoken,
    foldedMd: fold.md,
  };
}

describe("the fold's anonymous wording is the same wording an individual row uses", () => {
  it("matches actionReceiptLine's own fallback, through who() on one side and subjectSlot on the other", () => {
    // A receipt naming nobody, so the row really does go through `who()`'s fallback.
    const { row, folded } = bothWays({
      id: "r1",
      kind: "closed",
      ok: false,
      at: 1,
      op: "fleet.close_agent",
      reason: "roborev has 2 review(s) in flight on this branch",
    });
    expect(row).toBe(
      `Couldn't close ${ANONYMOUS_SUBJECT} — a code review is still running`,
    );

    // THE WORDS ARE COMPARED AGAINST EACH OTHER, not against the constant a second time. Restating
    // `ANONYMOUS_SUBJECT` on both sides passes however far the two modules have drifted, as long as
    // each drifted to something containing it; taking the row's OWN subject phrase and requiring the
    // fold's residue to be made of it is what reds when `who()` is re-hardcoded.
    const subjectWords = row
      .replace(/^Couldn't close /, "")
      .replace(/ — .*$/, "");
    expect(folded).toBe(
      `Couldn't close 2 agents — a code review is still running — ${subjectWords}, ${subjectWords}`,
    );
  });

  // ══ THE REFUSED SPAWN THAT CARRIES A SUBJECT IS EXACTLY ONE SHAPE, AND IT FOLDS VERBATIM ════════
  //
  // `agentId` reaches a refused `spawned` receipt through ONE door: the classifier's fatal
  // `spawnShortfall` arm, which flips a transport-level ok to `ok: false` when the reply says
  // `agentExists === false`. That arm also OVERWRITES `reason` with its own words — `briefFailureCopy`'s
  // sentence, or the literal "that agent is already gone". Neither matches an `INTERNAL_GATES` entry,
  // so `refusalGist` is null and `receiptMark` writes no `gist`.
  //
  // THIS BLOCK USED TO SAY IT THEREFORE DOES NOT FOLD AT ALL, and that stopped being true at roborev
  // 63727: a gist-less refusal now folds on its VERBATIM reason, so this population is foldable — it
  // simply folds through the door that KEEPS its words rather than the one that replaces them. The
  // 63613 hazard the old note guarded against is unchanged and still guarded: what must never happen
  // is pairing an `agentId` with the CAPACITY reason, a combination no producer emits, and then
  // asserting a fold on it. The capacity sentence comes only from `refuse()`, which carries no `data`
  // and therefore no `agentId`. So the two doors stay distinct; only "unfoldable" was too strong.
  const shortfall = (): ConciergeActionReceipt => ({
    id: "r4",
    kind: "spawned",
    ok: false,
    at: 1,
    op: "fleet.spawn_build_agent",
    agentId: "atlas-1",
    reason: "that agent is already gone",
  });

  it("pins WHICH door it folds through — the verbatim one, never a gist", () => {
    // Stated as an assertion because everything below depends on it: if a future gate entry ever
    // matched the shortfall's words, the fold would start WITHHOLDING them and this reds.
    const mark = receiptMark(shortfall(), () => null);
    expect(mark.gist).toBeUndefined();
    expect(mark.reason).toBe("that agent is already gone");
    expect(foldKeyOf(mark)).toBe("verbatim:spawned:that agent is already gone");
  });

  it("names only the agents the rows named, when two of them fold together", () => {
    // `spawned` is a WHO-SHAPED arm — its sentence counts agents, so its residue goes out whole. The
    // invariant that matters is the one this file has broken twice: the fold must never name an
    // agent the rows it replaced did not. Both members here resolve, so both chips are earned.
    const resolve = (id: string) =>
      id === "atlas-1"
        ? { id: "atlas-1", name: "Atlas" }
        : id === "atlas-2"
          ? { id: "atlas-2", name: "Borealis" }
          : null;
    const mk = (id: string, agentId: string): ConciergeMessage => {
      const r = { ...shortfall(), id, agentId };
      return {
        id,
        kind: "sparkle",
        text: actionReceiptLine(r, resolve)?.md ?? "",
        actionReceipt: receiptMark(r, resolve),
      };
    };
    const fold = receiptRunLine(
      runOf([mk("a", "atlas-1"), mk("b", "atlas-2")]),
    );
    expect(fold.spoken).toBe(
      "Couldn't spawn 2 agents — that agent is already gone — Atlas, Borealis",
    );
    // THE RESIDUE ONLY, because this reason's own words happen to CONTAIN the anonymous wording
    // ("that agent is already gone") — a flat `not.toContain(ANONYMOUS_SUBJECT)` over the whole
    // sentence tests the tool's phrasing rather than the chips, and reds on a correct fold.
    const residue = fold.spoken.split(" — ").at(-1) ?? "";
    expect(residue).toBe("Atlas, Borealis");
    expect(residue).not.toContain(ANONYMOUS_SUBJECT);
  });

  it("draws a PILL on that refusal when its id resolves — the shape spawnShortfall really ships", () => {
    // NOT HYPOTHETICAL (roborev 63571). Routing this arm through `who()` makes its PILL branch
    // reachable for the first time; the hard-coded words could never draw one.
    //
    // Asserted on `.md`, because `.spoken` flattens a pill to the bare name and so cannot tell a chip
    // from plain text. The correspondence is asserted on `receiptMark`'s `subjectId` rather than on a
    // folded line because this case is about a SINGLE row — the folded twin is the case above — but
    // the two still read the SAME resolver, which is the property that matters: whatever the row
    // drew, the mark agrees with.
    const resolve = (id: string) =>
      id === "atlas-1" ? { id: "atlas-1", name: "Atlas" } : null;
    const r = shortfall();
    const rendered = actionReceiptLine(r, resolve);
    expect(rendered?.md).toBe(
      "Couldn't spawn [@Atlas](sparkle-agent:atlas-1) — that agent is already gone",
    );
    expect(receiptMark(r, resolve).subjectId).toBe("atlas-1");
  });

  it("…and falls back to the shared wording when that same id no longer resolves", () => {
    // THE COMMONER HALF: `agentExists === false` is precisely why this spawn was refused, so by the
    // time the row renders the lookup usually MISSES. One case proving the pill appears is half the
    // evidence — a `who()` that always minted a pill passes that one and fails this one. The mark
    // misses with it, so nothing downstream can mint a chip pointing at a row the store no longer has.
    const r = shortfall();
    const rendered = actionReceiptLine(r, () => null);
    expect(rendered?.spoken).toBe(
      `Couldn't spawn ${ANONYMOUS_SUBJECT} — that agent is already gone`,
    );
    expect(rendered?.md).not.toContain("sparkle-agent:");
    expect(receiptMark(r, () => null).subjectId).toBeUndefined();
  });

  it("…and the subject-less capacity refusal, which is the one that DOES fold", () => {
    // A capacity refusal comes from `refuse()`, so it carries no data and names nobody — and its
    // sentence DOES match a gate, so a run of them folds. This is the spawned refusal the founder
    // actually sees repeated (a fan-out refusing per spawn at capacity), and the only one where a row
    // and a fold of it both exist to be compared.
    const { row, md, folded, foldedMd } = bothWays({
      id: "r3",
      kind: "spawned",
      ok: false,
      at: 1,
      op: "fleet.spawn_build_agent",
      reason: "This machine has 90 of its 81 agent slots taken.",
    });
    expect(row).toBe(
      `Couldn't spawn ${ANONYMOUS_SUBJECT} — no free agent slot right now`,
    );
    const subjectWords = row
      .replace(/^Couldn't spawn /, "")
      .replace(/ — .*$/, "");
    expect(folded).toBe(
      `Couldn't spawn 2 agents — no free agent slot right now — ${subjectWords}, ${subjectWords}`,
    );
    // WHOLE STRINGS ON BOTH RENDERINGS, never a prefix or a `toContain` (`receiptRuns.ts` records
    // why: the residue bug shipped because the tests asserted a prefix and a `toContain`, and both
    // hold with stray residue attached). Neither side may mint a chip for a receipt that named nobody.
    expect(md).not.toContain("sparkle-agent:");
    expect(foldedMd).not.toContain("sparkle-agent:");
  });
});

// ══ THE FIVE-AGENT RELAY THAT HIT FIVE APPROVAL PROMPTS ══════════════════════════════════════════
//
// THE REPORT, for the fourth time: "Maybe you collapse them all or something." One relay to a fleet
// refuses ONCE PER AGENT, so five agents whose panes are in full-screen mode produced five
// full-width copies of one sentence — the wall this module exists to end, arriving through the one
// door still open to it.
//
// AND THE FIRST FIX WAS WRONG IN A WAY WORTH KEEPING ON THE PAGE (roborev 63727, Medium). It gave
// that refusal a GIST, which folds by WITHHOLDING the tool's words — and the population is not what
// the old sentence claimed. The guard fires on `alternateBuffer && !claudeCodeHoldsTheBuffer`, and
// Claude Code's own permission dialog takes it (the dialog replaces the composer box
// `isClaudeCodeScreen` requires). `goalContinuationRunner` measured it: "five agents frozen with
// this reason, every one of them a normal Claude Code pane stopped at `Do you want to proceed?`".
// Withholding that would hide the one thing only the founder can clear, behind a cause that is
// essentially never the real one.
//
// SO THESE ROWS FOLD ON THEIR VERBATIM REASON INSTEAD. The founder loses the four duplicates and
// nothing else: the sentence is repeated word for word, the count is stated, every agent is a pill,
// and the chevron expands in place.
//
// PRODUCER-BOUND AND MARK-DERIVED, per this file's header: the reason is `sendDetail`'s real
// sentence and the marks come from `receiptMark`, so a hand-written field cannot fake the fold.
import { sendDetail } from "../../services/conciergeTools/terminal";

describe("a fleet relay refused by five full-screen panes folds to ONE row", () => {
  const NAMES = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"];
  const REASON = sendDetail("alternate-screen", "agent-Alpha");
  /** What both the row and the fold actually splice — the producer's sentence minus its own verb. */
  const TAIL = REASON.replace(/^Not sent:\s*/, "");
  const resolve: ResolveReceiptAgent = (id) => {
    const name = NAMES.find((n) => id === `agent-${n}`);
    return name ? { id, name } : null;
  };
  const refusal = (
    name: string,
    reason: string = REASON,
  ): ConciergeActionReceipt => ({
    id: `r-${name}`,
    kind: "sent",
    ok: false,
    at: 1,
    op: "fleet.send_to_agent_terminal",
    agentId: `agent-${name}`,
    agentName: name,
    reason,
  });
  const asMessage = (r: ConciergeActionReceipt): ConciergeMessage => ({
    id: r.id,
    kind: "sparkle",
    text: actionReceiptLine(r, resolve)?.md ?? "",
    actionReceipt: receiptMark(r, resolve),
  });
  const messages = (): ConciergeMessage[] =>
    NAMES.map((name) => asMessage(refusal(name)));

  it("is a FOUNDER refusal — it carries the words, never a gist", () => {
    // Stated as an assertion because everything below depends on it: if a future INTERNAL_GATES
    // entry ever matches this sentence, the fold silently becomes a withholding one and this reds.
    const mark = receiptMark(refusal("Alpha"), resolve);
    expect(mark.gist).toBeUndefined();
    expect(mark.reason).toBe(TAIL);
  });

  // ══ NO STUTTER, AND NOTHING THAT COLLIDES WITH THE ROW'S OWN SEPARATOR (roborev 63747) ═════════
  it("does not repeat the verb the row is about to say itself", () => {
    // The producer's sentence opens with its own "Not sent: ", and every arm splices the reason
    // after a verb of ours. Spliced raw the founder read "Not sent to Alpha — Not sent: that
    // terminal…", and the fold stuttered identically. Both halves read one `why()`, so this pins
    // the row and the fold together.
    expect(REASON).toMatch(/^Not sent:/);
    expect(TAIL).not.toMatch(/^Not sent/);
    const row = actionReceiptLine(refusal("Alpha"), resolve)?.spoken ?? "";
    expect(row).toBe(`Not sent to Alpha — ${TAIL}`);
    expect(row).not.toContain("— Not sent:");
  });

  it("keeps the fold's own separator out of the reason it splices", () => {
    // ` — ` separates verb, reason and agent pills. A reason containing one leaves the reader unable
    // to see where the reason ends and the agent list begins, so the producer's copy must stay clear
    // of it — asserted on the PRODUCER, since that is the thing a copy edit changes.
    expect(REASON).not.toContain(" — ");
  });

  it("collapses five rows into one", () => {
    const rows = foldReceiptRuns(messages());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe("receipt-run");
    expect(runOf(messages()).members).toHaveLength(5);
  });

  it("repeats the reason VERBATIM — folding is not withholding", () => {
    const fold = receiptRunLine(runOf(messages()));
    // THE WHOLE STRING, not a prefix and not a `toContain` — the residue bugs this file has already
    // shipped twice were invisible to both (roborev 63364, 63482).
    expect(fold.spoken).toBe(
      `Not sent, 5 times — ${TAIL} — ${NAMES.join(", ")}`,
    );
    // Every word the five rows carried is still on screen, in one row instead of five.
    expect(fold.spoken).toContain(TAIL);
    // Five real pills, so the navigation the unfolded rows had survives the fold.
    for (const name of NAMES)
      expect(fold.md).toContain(`sparkle-agent:agent-${name}`);
    // …and it never claims the send happened.
    expect(fold.spoken).not.toMatch(/^Sent\b/);
  });

  it("keeps TWO DIFFERENT reasons apart — the key is the words, not the kind", () => {
    // The property that makes verbatim folding safe: only genuinely identical refusals merge. A
    // credential-field refusal beside a full-screen one is two facts and stays two rows.
    const other = sendDetail("blocked-prompt", "agent-Beta");
    expect(other).not.toBe(REASON);
    const rows = foldReceiptRuns([
      asMessage(refusal("Alpha")),
      asMessage(refusal("Beta")),
      asMessage(refusal("Gamma", other)),
      asMessage(refusal("Delta", other)),
    ]);
    expect(rows.map((r) => r.type)).toEqual(["receipt-run", "receipt-run"]);
    const [first, second] = rows as ReceiptRun[];
    expect(receiptRunLine(first!).spoken).toContain(TAIL);
    expect(receiptRunLine(second!).spoken).toContain(
      other.replace(/^Not sent:\s*/, ""),
    );
  });

  it("still stands a refusal with NO reason on its own", () => {
    // Absence is not evidence: nothing proves two of those say the same thing, so they never merge.
    const bare = (name: string): ConciergeMessage =>
      asMessage({ ...refusal(name), reason: undefined });
    expect(
      foldReceiptRuns([bare("Alpha"), bare("Beta")]).every(
        (r) => r.type === "message",
      ),
    ).toBe(true);
  });
});

// ══ THE TWO POPULATIONS THE VERBATIM DOOR MADE REACHABLE (roborev 63747, Medium ×2) ══════════════
//
// Both were unreachable-by-luck rather than handled: while a refusal needed a GIST to fold, no
// `INTERNAL_GATES` entry matched either shape, so neither could ever reach the fold. The verbatim
// door opened both at once, and each fails in a different direction.
describe("what the verbatim door newly reaches", () => {
  const resolve: ResolveReceiptAgent = (id) =>
    id === "a1"
      ? { id: "a1", name: "Alpha" }
      : id === "a2"
        ? { id: "a2", name: "Beta" }
        : null;
  const mk = (
    id: string,
    over: Partial<ConciergeActionReceipt>,
  ): ConciergeMessage => {
    const r: ConciergeActionReceipt = {
      id,
      kind: "retired",
      ok: false,
      at: 1,
      op: "fleet.retire_agent",
      reason: "that agent is mid-turn",
      ...over,
    } as ConciergeActionReceipt;
    return {
      id,
      kind: "sparkle",
      text: actionReceiptLine(r, resolve)?.md ?? "",
      actionReceipt: receiptMark(r, resolve),
    };
  };

  it("gives a folded RETIRED run its own verb, instead of '2 actions didn't go through'", () => {
    // `retire_agent` is a per-agent op the concierge issues in BATCHES on its own initiative, so a
    // run of them is ordinary. The kind whose own doc says the receipt is the only witness — the
    // founder was not present for the act — is the worst one to drop the verb on.
    const fold = receiptRunLine(
      runOf([mk("r1", { agentId: "a1" }), mk("r2", { agentId: "a2" })]),
    );
    expect(fold.spoken).toBe(
      "Couldn't retire 2 agents — that agent is mid-turn — Alpha, Beta",
    );
    expect(fold.spoken).not.toContain("actions didn't go through");
    // WHO-SHAPED like `closed`: the count is subject-derived, so the residue goes out whole and both
    // chips are earned by members that really resolved.
    expect(fold.md).toContain("sparkle-agent:a1");
    expect(fold.md).toContain("sparkle-agent:a2");
  });

  it("still refuses to fold an already-plural REFUSAL — the guard sits above the refusal arm", () => {
    // Two `inbox_broadcast` refusals sharing one reason. Folded, "Not sent, 2 times" would describe
    // two fan-outs of N recipients each as two sends — understating how many agents missed the
    // message, which is the one direction this module may not be wrong in. The guard's POSITION is
    // what holds this: under the refusal arm it would never be consulted.
    const bcast = (id: string): ConciergeMessage =>
      mk(id, { kind: "sent", fanout: true } as Partial<ConciergeActionReceipt>);
    const rows = foldReceiptRuns([bcast("b1"), bcast("b2")]);
    expect(rows.every((r) => r.type === "message")).toBe(true);
    // And the mark really did carry the reason, so this is the guard refusing rather than a missing
    // field quietly producing the same answer — the difference between a guard and an accident.
    const one = bcast("b1");
    expect(one.kind).toBe("sparkle");
    expect(one.kind === "sparkle" ? one.actionReceipt?.reason : undefined).toBe(
      "that agent is mid-turn",
    );
  });
});

// ══ A RELAY AND A COMPOSITION ARE TWO CLAIMS — bead `sparkle-p9s5q` ══════════════════════════════
//
// The fold's whole contract is that the folded sentence is TRUE of every row it stands for. Before
// this split there was one `sent:terminal` bucket, so a turn mixing a relay of the founder's words
// with the concierge's own briefs collapsed onto "Sent to N agents' terminals." — a sentence that is
// true of one of them and, for the rest, is exactly the false forward he reported.
describe("whose words went is a fold boundary", () => {
  /** Every folded run in `messages`, in order. Uses the module's own row type rather than a guess. */
  const runsOf = (messages: ConciergeMessage[]): ReceiptRun[] =>
    foldReceiptRuns(messages).flatMap((r) => (r.type === "receipt-run" ? [r] : []));

  const markOf = (m: ConciergeMessage) =>
    m.kind === "sparkle" ? m.actionReceipt : undefined;

  it("never folds a relay together with a concierge-composed send", () => {
    expect(markOf(sent("s1", "Alpha"))).toBeTruthy();
    expect(foldKeyOf(markOf(sent("s1", "Alpha")))).toBe("sent:terminal");
    expect(foldKeyOf(markOf(composed("s2", "Beta")))).toBe("sent:terminal:concierge");
    expect(foldKeyOf(markOf(composed("s2", "Beta")))).not.toBe(
      foldKeyOf(markOf(sent("s1", "Alpha"))),
    );
  });

  it("renders a mixed turn as TWO rows, each true of its own members", () => {
    // The reported turn's shape: one message he aimed, plus briefs the concierge wrote itself.
    const runs = runsOf([
      sent("s1", "Alpha"),
      sent("s2", "Beta"),
      composed("s3", "Gamma"),
      composed("s4", "Delta"),
    ]);
    expect(runs).toHaveLength(2);
    // `spoken` carries the subject residue after the sentence, so match on the sentence itself.
    const said = runs.map((r) => receiptRunLine(r).spoken);
    expect(said.some((s) => s.startsWith("Sent to 2 agents' terminals."))).toBe(true);
    expect(said.some((s) => s.startsWith("Concierge wrote to 2 agents."))).toBe(true);
  });

  it("attributes a folded run of the concierge's own briefs, and still names every agent", () => {
    // His correction: the row must not disappear. It keeps the count and the pills; only the author
    // changes. Sixteen composed briefs are the wall the fold exists for — attribution does not
    // reintroduce it.
    const runs = runsOf(Array.from({ length: 16 }, (_, i) => composed(`c${i}`, `Agent ${i}`)));
    expect(runs).toHaveLength(1);
    const l = receiptRunLine(runs[0]!);
    expect(l.spoken).toContain("Concierge wrote to 16 agents.");
    // Never the forward wording, so no reading of this row claims his message went out.
    expect(l.spoken).not.toContain("Sent to");
    // The navigation the unfolded rows had survives — one pill per agent.
    expect(l.md.match(/sparkle-agent:/g) ?? []).toHaveLength(16);
  });

  it("says MESSAGES and AGENTS separately for composed briefs too", () => {
    // Two briefs to ONE agent — the SAME subject id, which is what makes this the repeats case
    // rather than two agents that happen to share a name.
    const runs = runsOf([
      composed("c1", "Alpha", { subjectId: "same-agent" }),
      composed("c2", "Alpha", { subjectId: "same-agent" }),
    ]);
    // "Concierge wrote to 1 agent." would understate the traffic, exactly as "Sent to 1 agents'
    // terminals." would have — the agreement bug this module already fixed once, on the new arm.
    expect(receiptRunLine(runs[0]!).spoken).toContain("Concierge wrote 2 messages to 1 agent.");
  });

  it("leaves the inbox and held buckets un-split — their wording never claimed authorship", () => {
    const inbox = foldKeyOf({ kind: "sent", ok: true, channel: "inbox" });
    const held = foldKeyOf({ kind: "sent", ok: true, channel: "held" });
    expect(inbox).toBe("sent:inbox");
    expect(held).toBe("sent:held");
  });
});
