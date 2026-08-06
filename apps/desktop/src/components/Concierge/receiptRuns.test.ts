// THE FOLDING RULE, and the one thing it may never do.
//
// Every row here is about the same hazard: a folded line is a CLAIM about several actions at once,
// so it is the easiest place in the app to state something that is not true. The founder's wall of
// sixteen identical receipts is merely tiring; "Sent to 16 agents" over three silent refusals is
// false, and this file exists so that cannot ship.
import { describe, expect, it } from "vitest";

import {
  MIN_RUN,
  foldKeyOf,
  foldReceiptRuns,
  receiptRunLine,
  type ReceiptRun,
} from "./receiptRuns";
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
  it("REFUSES to fold a refusal, whatever else matches", () => {
    // The rule the whole feature is subordinate to. `ok: false` is the reader's to-do item.
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
    expect(l.spoken.match(/that agent/g) ?? []).toHaveLength(3);
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
