import { describe, expect, it } from "vitest";

import {
  NOTICE_SENDER_LABEL,
  isConciergeAddressed,
  noticeRecipient,
} from "./noticeRecipient";
import { foldKeyOf } from "./receiptRuns";
import type { ConciergeMessage, ConciergeReceiptMark } from "./types";

const MARK: ConciergeReceiptMark = { kind: "sent", ok: false, reason: "nope" };

function sparkle(over: Partial<ConciergeMessage> = {}): ConciergeMessage {
  return { id: "m1", kind: "sparkle", text: "hello", ...over } as ConciergeMessage;
}

describe("the recipient split", () => {
  // ── THE CONCIERGE-ADDRESSED HALF ──────────────────────────────────────────────────────────────
  it("reads a receipt-marked line as addressed to the concierge", () => {
    expect(noticeRecipient(sparkle({ actionReceipt: MARK }))).toBe("concierge");
    expect(isConciergeAddressed(sparkle({ actionReceipt: MARK }))).toBe(true);
  });

  it("reads a SUCCESS receipt as concierge-addressed too, not just a refusal", () => {
    // The recipient axis is about WHO IS BEING TOLD, which is the concierge either way. Keying it
    // on `ok` would leave every "Filed " and "Spawned @X" rendering as concierge prose —
    // half the population, and the half that is most often mistaken for the concierge reporting in.
    const ok: ConciergeReceiptMark = { kind: "filed", ok: true };
    expect(noticeRecipient(sparkle({ actionReceipt: ok }))).toBe("concierge");
  });

  // ── THE FOUNDER-ADDRESSED HALF, WHICH IS THE ONE THAT MUST NOT REGRESS ────────────────────────
  it("leaves an ordinary brain reply addressed to the founder", () => {
    expect(noticeRecipient(sparkle({ settled: true }))).toBe("founder");
    expect(isConciergeAddressed(sparkle({ settled: true }))).toBe(false);
  });

  it("leaves APP-AUTHORED lines that speak to the founder at full weight", () => {
    // These are the ones a sender-based split would have wrongly greyed. Every one is app-authored
    // via `postSparkle`, carries no receipt mark, and is addressed to him — several end in an
    // instruction only he can carry out. Real strings, from ConciergeHost / refusalCopy / the
    // promise ledger.
    const founderAddressed = [
      "That message had more asks than I file at once, so 2 of them didn't make the list — say them again and I'll pick them up.",
      "Not sent — Alpha has a full-screen app open, so the keys would have run as commands. Your message is back in the box.",
      "You said you'd land the retry PR — and that hasn't happened.",
      "Sparkle isn't reachable from this window right now, so I didn't send that — your words are back in the box.",
    ];
    for (const text of founderAddressed) {
      expect(noticeRecipient(sparkle({ text }))).toBe("founder");
      expect(isConciergeAddressed(sparkle({ text }))).toBe(false);
    }
  });

  it("leaves every other message kind addressed to the founder", () => {
    const kinds: ConciergeMessage[] = [
      { id: "u", kind: "you", text: "hi" } as ConciergeMessage,
      { id: "f", kind: "failure", headline: "One queued message was dropped" } as ConciergeMessage,
      { id: "b", kind: "batch", text: "— 3 more —" } as ConciergeMessage,
      { id: "d", kind: "digest", band: "needs_you", variant: "unmerged", text: "2 waiting", leadAgentId: "a" } as ConciergeMessage,
      { id: "n", kind: "nudge", band: "needs_you", projectName: "p", agentName: "a", text: "t", actions: [] } as ConciergeMessage,
    ];
    for (const m of kinds) expect(noticeRecipient(m)).toBe("founder");
  });

  // ── THE FAIL-SAFE DIRECTION ──────────────────────────────────────────────────────────────────
  it("falls to the founder when the mark is ABSENT", () => {
    expect(noticeRecipient(sparkle({ actionReceipt: undefined }))).toBe("founder");
    expect(
      noticeRecipient(sparkle({ actionReceipt: null as unknown as ConciergeReceiptMark })),
    ).toBe("founder");
  });

  it("falls to the founder when the mark is present but UNUSABLE (roborev 65813)", () => {
    // The half a truthiness test silently got wrong. The thread is persisted to localStorage, so a
    // truncated, hand-edited or wrong-typed mark is a shape that really arrives — and every one of
    // these is truthy, so each would have taken the "concierge" branch and re-attributed a line
    // away from the founder on no evidence at all.
    const unusable: unknown[] = [
      {}, // nothing survived
      { kind: "sent" }, // `ok` lost
      { ok: false }, // `kind` lost
      { kind: 7, ok: false }, // deserialized as the wrong type
      { kind: "sent", ok: "false" }, // `ok` as a string — truthy, and NOT a boolean
      "sent", // not an object at all
      [],
    ];
    for (const mark of unusable) {
      expect(
        noticeRecipient(sparkle({ actionReceipt: mark as ConciergeReceiptMark })),
      ).toBe("founder");
    }
  });

  it("still accepts a SPARSE but well-formed mark", () => {
    // The other direction, so the validation above cannot quietly harden into rejecting real marks:
    // most carry only `kind` and `ok`, and rejecting those would un-attribute genuine receipts.
    expect(
      noticeRecipient(sparkle({ actionReceipt: { kind: "closed", ok: true } })),
    ).toBe("concierge");
  });
});

describe("the attribution label", () => {
  it("names a sender AND a recipient, so it is a routing statement not a caption", () => {
    expect(NOTICE_SENDER_LABEL.sparkle).toBe("Sparkle → Concierge");
  });

  it("survives the thread's no-authorship-captions rule", () => {
    // The two patterns `ConciergeThread.roleLabels.test` actually enforces, asserted here directly
    // so a future edit to this label is caught in THIS file rather than as a puzzling failure two
    // suites away. The all-caps sweep is case-SENSITIVE; the caption sweep is shape-based.
    const label = NOTICE_SENDER_LABEL.sparkle;
    expect(/\bSPARKLE\b/.test(label)).toBe(false);
    expect(/\bYOU\b/.test(label)).toBe(false);
    expect(/^(sparkle|you)[\s:·—-]*$/i.test(label.trim())).toBe(false);
  });
});

// ══ THE TWO MODULES MUST AGREE ABOUT THE SAME MARK (roborev 65819, Medium) ══════════════════════
//
// This is the test that would have caught the real defect, and it exists because NEITHER module's
// own suite could: `noticeRecipient.test` never crossed into `receiptRuns`, and `ReceiptRunRow` has
// no member-level assertion because its comment declared a mixed run impossible.
//
// THE DEFECT. `isUsableMark` requires `ok` to be a BOOLEAN; `receiptBucketOf`'s refusal arm tested
// `mark.ok !== true`, which `undefined` satisfies. So a truncated `{ kind, gist }` — the exact shape
// the validation was written for — was FOLDABLE but NOT ATTRIBUTABLE. A folded run is drawn
// concierge-addressed unconditionally, so two consecutive such messages went grey with an
// attribution header while ONE alone rendered founder-addressed at full weight, and expanding the
// run painted ungreyed members inside a grey container.
describe("foldability implies attributability", () => {
  it("never folds a mark it would refuse to attribute", () => {
    // The property, stated over the population that broke it. A mark that cannot be attributed to
    // the concierge must not be able to enter a run that is drawn as the concierge's.
    const unattributable: unknown[] = [
      { kind: "sent", gist: "waiting on checks" }, // `ok` lost in truncation — the measured shape
      { kind: "sent", reason: "some paragraph" },
      { kind: "merged", ok: "false", gist: "waiting on checks" },
      { kind: 7, ok: false, gist: "x" },
      {},
    ];
    for (const mark of unattributable) {
      const m = sparkle({ actionReceipt: mark as ConciergeReceiptMark });
      expect(noticeRecipient(m)).toBe("founder");
      expect(
        foldKeyOf(mark as ConciergeReceiptMark),
        `a mark noticeRecipient calls founder-addressed still folded: ${JSON.stringify(mark)}`,
      ).toBeNull();
    }
  });

  it("still folds a WELL-FORMED refusal — the gate did not just disable folding", () => {
    // The other direction. Without this the fix above passes by making nothing fold at all, which
    // would silently revert the founder's own "collapse them all" ruling (roborev 63727).
    const good: ConciergeReceiptMark = { kind: "sent", ok: false, gist: "waiting on checks" };
    expect(noticeRecipient(sparkle({ actionReceipt: good }))).toBe("concierge");
    expect(foldKeyOf(good)).not.toBeNull();
  });
});
