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
import { actionReceiptLine } from "./actionReceiptLine";
import type { ConciergeMessage, ConciergeReceiptMark } from "./types";

/** A successful terminal send to `name`, as the thread would hold it. */
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
      subjectId: `${id}-agent`,
      subjectName: name,
      ...over,
    },
  };
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
    expect(foldKeyOf({ kind: "sent", ok: true, channel: "terminal" })).toBe(
      "sent:terminal",
    );
    expect(foldKeyOf({ kind: "spawned", ok: true })).toBe("spawned");
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
    expect(l.spoken.match(new RegExp(ANONYMOUS_SUBJECT, "g")) ?? []).toHaveLength(3);
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
// The anonymous fallback used to exist as FOUR separate literals — `ref()`, `actionReceiptLine`'s
// `who()`, its `spawned` refusal arm, and this module's own constant — so editing the wording where
// an individual row renders it left the fold saying the old words beside rows saying the new ones.
//
// THE FIRST VERSION OF THIS TEST COULD NOT SEE THAT, and the way it failed is worth keeping: it fed
// a `{kind: "spawned", ok: false}` receipt, whose refusal arm returned a HARD-CODED
// "Couldn't spawn that agent" and never called `who()` at all. So the one line the commit changed
// was not reached by the test written to cover it — revert `who()` and everything stayed green. An
// earlier branch short-circuiting the mechanism under test is the exact vacuous shape AGENTS.md
// names, and driving the real entry point was necessary but not sufficient.
//
// `closed` is used instead because BOTH sides genuinely render the fallback: the unfolded arm is
// `Couldn't close ${subject}` with `subject` coming from `who()`, and the folded arm is who-shaped,
// so its residue emits `subjectSlot`. A count-shaped kind (`sent`, `merged`) would not work — those
// filter their residue away entirely, so the fold would have no words to compare.
describe("the fold's anonymous wording is the same wording an individual row uses", () => {
  it("matches actionReceiptLine's own fallback, through who() on one side and subjectSlot on the other", () => {
    // ONE row, for a receipt naming nobody — this really does go through `who()`.
    const single = actionReceiptLine(
      {
        id: "r1",
        kind: "closed",
        ok: false,
        at: 1,
        op: "fleet.close_agent",
        reason: "a code review is still running",
      },
      () => null,
    );
    expect(single?.spoken).toBe(`Couldn't close ${ANONYMOUS_SUBJECT} — a code review is still running`);

    // …and the FOLD of a run of them. Same words, by construction now.
    const anon: ConciergeMessage = {
      id: "x",
      kind: "sparkle",
      text: single?.md ?? "",
      actionReceipt: { kind: "closed", ok: false, gist: "a code review is still running" },
    };
    const folded = receiptRunLine(runOf([anon, { ...anon, id: "y" }]));
    expect(folded.spoken).toContain(ANONYMOUS_SUBJECT);
  });

  it("covers the spawned refusal arm too, which had its own literal", () => {
    // roborev 63529: this arm bypassed `who()` and hard-coded the words. It is subject-less by
    // design, so the assertion is that it uses the CONSTANT rather than a copy of it.
    const l = actionReceiptLine(
      {
        id: "r2",
        kind: "spawned",
        ok: false,
        at: 1,
        op: "fleet.spawn_agent",
        reason: "no free agent slot right now",
      },
      () => null,
    );
    expect(l?.spoken).toBe(`Couldn't spawn ${ANONYMOUS_SUBJECT} — no free agent slot right now`);
  });
});
