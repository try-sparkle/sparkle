// A sparkle line's COLLAPSED PAYLOAD across save → restore.
//
// Two facts worth pinning, because a pill is a promise that the text is still there:
//
//   1. THE FIELD SURVIVES. `persistableThread` and `rehydrateThread` rebuild every message by SPREAD,
//      so a new field rides along for free — but "for free" is exactly the kind of thing a later
//      field-by-field refactor breaks silently, and the failure is a pill that opens onto nothing.
//   2. ITS TEXT IS CAPPED — per block AND in aggregate. It is a second text axis that
//      `CONCIERGE_MSG_MAX_LEN`'s clip cannot see, the same shape as the base64 `dataUrl` problem, and an
//      over-quota persist write makes zustand stop persisting the WHOLE store, silently. Either cap
//      alone leaves that reachable: one enormous paste, or two hundred merely-large ones.
import { describe, expect, it } from "vitest";
import {
  CONCIERGE_COLLAPSED_MAX_LEN,
  CONCIERGE_COLLAPSED_FLOOR_TOTAL,
  CONCIERGE_COLLAPSED_MIN_LEN,
  CONCIERGE_COLLAPSED_TOTAL_CHARS,
  CONCIERGE_TRUNCATION_SUFFIX,
  persistableThread,
  rehydrateThread,
} from "./conciergeThreadStore";
import { collapseText, countLines } from "../components/composer/attachments";
import type { ConciergeMessage, ConciergeSparkleMessage } from "../components/Concierge/types";

const BRIEF = `Ship the reply linter\n${Array.from({ length: 20 }, (_, i) => `step ${i}`).join("\n")}\n`;

function sparkleWith(text: string, id = "s1"): ConciergeMessage {
  return {
    id,
    kind: "sparkle",
    text: "CI Hardening is up — I sent your message.",
    collapsed: collapseText(`blk-${id}`, text),
  };
}

/** The collapsed payload of each sparkle line in a persisted thread, oldest first. */
function blocks(chat: ConciergeMessage[]): string[] {
  return chat.map((m) => (m.kind === "sparkle" ? (m.collapsed?.text ?? "") : ""));
}

/** The one sparkle line out of a persisted thread, typed. */
function only(chat: ConciergeMessage[]): ConciergeSparkleMessage {
  const m = chat[0]!;
  if (m.kind !== "sparkle") throw new Error(`expected a sparkle message, got ${m.kind}`);
  return m;
}

describe("persistableThread — a collapsed payload survives the trip to disk", () => {
  it("keeps the block, byte for byte, on a persisted sparkle line", () => {
    const saved = persistableThread([sparkleWith(BRIEF)]);
    // Through the restore hook as well: this is the pair the app actually runs.
    const restored = rehydrateThread(saved);
    expect(only(restored).collapsed?.text).toBe(BRIEF);
    expect(only(restored).collapsed?.lineCount).toBe(countLines(BRIEF));
    // The receipt sentence is untouched — the two are separate fields precisely so neither eats the
    // other.
    expect(only(restored).text).toBe("CI Hardening is up — I sent your message.");
  });

  it("keeps the CANONICAL ~40-row brief whole — the case the whole feature is about", () => {
    // THE REALISTIC CASE, pinned separately from the pathological one below (roborev 55760). The
    // founder's screenshot is a ~2400-character brief, which is past `PILL_MIN_CHARS` by construction:
    // a per-block ceiling anywhere near that threshold would clip essentially every char-triggered pill
    // on the first persist write, with the aggregate budget almost entirely unspent — and the
    // `expired`/`abandoned` arms would then be telling the user to re-send text the app had clipped.
    const brief = Array.from({ length: 40 }, (_, i) => `row ${i}: ${"detail ".repeat(7)}`).join("\n");
    expect(brief.length).toBeGreaterThan(2000);
    const block = only(persistableThread([sparkleWith(brief)])).collapsed!;
    expect(block.text).toBe(brief);
    expect(block.text).not.toContain(CONCIERGE_TRUNCATION_SUFFIX);
  });

  it("truncates an over-long payload rather than blowing the localStorage quota", () => {
    const huge = "x".repeat(CONCIERGE_COLLAPSED_MAX_LEN * 6);
    const block = only(persistableThread([sparkleWith(huge)])).collapsed!;
    expect(block.text.length).toBe(CONCIERGE_COLLAPSED_MAX_LEN + CONCIERGE_TRUNCATION_SUFFIX.length);
    // ADMITTED, not silently shortened: a restored pill must not present a clipped brief as whole.
    expect(block.text.endsWith(CONCIERGE_TRUNCATION_SUFFIX)).toBe(true);
  });

  it("bounds the payloads in AGGREGATE too, spending the budget newest-first", () => {
    // The per-block cap alone leaves the quota reachable along the other axis: a long session that
    // relays many briefs writes hundreds of merely-large blocks (roborev 55746). The budget is spent on
    // the payloads the reader is nearest to, so the newest keep their text and the oldest degrade.
    const per = CONCIERGE_COLLAPSED_MAX_LEN;
    const fits = Math.floor(CONCIERGE_COLLAPSED_TOTAL_CHARS / per);
    const n = fits + 6;
    const chat = Array.from({ length: n }, (_, i) => sparkleWith("y".repeat(per), `s${i}`));

    const got = blocks(persistableThread(chat));
    // NEWEST kept whole…
    expect(got[n - 1]!.length).toBe(per);
    expect(got[n - 1]!.endsWith(CONCIERGE_TRUNCATION_SUFFIX)).toBe(false);
    // …OLDEST degraded to an identifying stub rather than dropped: a pill with nothing behind it is a
    // button that lies, so it keeps its first words and admits the truncation.
    expect(got[0]!.length).toBe(CONCIERGE_COLLAPSED_MIN_LEN + CONCIERGE_TRUNCATION_SUFFIX.length);
    expect(got[0]!.endsWith(CONCIERGE_TRUNCATION_SUFFIX)).toBe(true);
    // And the whole axis is bounded — the number this exists to hold.
    const total = got.reduce((sum, t) => sum + t.length, 0);
    expect(total).toBeLessThanOrEqual(
      CONCIERGE_COLLAPSED_TOTAL_CHARS + n * CONCIERGE_TRUNCATION_SUFFIX.length + n * CONCIERGE_COLLAPSED_MIN_LEN,
    );
    expect(total).toBeLessThan(n * per);
  });

  it("recounts the lines of a truncated payload, so the pill's subtitle stays true", () => {
    // The subtitle is `lineCount` ("41 lines"). Carrying the pre-clip count forward would make a
    // restored pill describe text that is no longer behind it — a small lie, told by the app.
    const huge = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
    const block = only(persistableThread([sparkleWith(huge)])).collapsed!;
    expect(block.lineCount).toBeLessThan(countLines(huge));
    expect(block.lineCount).toBe(countLines(block.text));
  });

  it("leaves a payload that already fits completely alone", () => {
    const chat = [sparkleWith(BRIEF)];
    // Identity, not equality: the common path must not rebuild the block (bubbles are memoized on it).
    expect(only(persistableThread(chat)).collapsed).toBe(
      (chat[0] as ConciergeSparkleMessage).collapsed,
    );
  });
});

// ── THE USER'S OWN PASTES, ON THE SAME AXIS ────────────────────────────────────────────────────
// A `you` message carries an ARRAY of blocks (ConciergeUserMessage.collapsed) — one per paste — and
// they are the same persistence hazard as the sparkle side's single block: `clip` bounds `text` and
// cannot see them at all, so an unbounded array is a quota-blowing write by another door. Bounded on
// ONE budget shared with the sparkle side, because a reader with a long paste and the brief it was
// relayed as would otherwise be charged the cap twice over.
describe("boundCollapsedPayloads — a user message's pastes", () => {
  const youWith = (...texts: string[]): ConciergeMessage => ({
    id: "u1",
    kind: "you",
    text: "what is wrong here?",
    collapsed: texts.map((t, i) => collapseText(`blk-${i}`, t)),
  });
  const blocksOf = (chat: ConciergeMessage[]) => {
    const m = chat[0]!;
    if (m.kind !== "you") throw new Error("expected a you message");
    return m.collapsed!;
  };

  it("survives save → restore, so a restored pill still has its text", () => {
    const round = rehydrateThread(persistableThread([youWith(BRIEF)]));
    expect(blocksOf(round)[0]!.text).toBe(BRIEF);
  });

  it("keeps the typed half and the pastes as separate fields", () => {
    // The split IS the feature: collapsing `text` itself would hide the question.
    const round = rehydrateThread(persistableThread([youWith(BRIEF)]));
    expect(round[0]!.kind === "you" && round[0]!.text).toBe("what is wrong here?");
  });

  it("truncates an over-cap paste rather than dropping it, and recounts its lines", () => {
    const huge = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join("\n");
    const block = blocksOf(persistableThread([youWith(huge)]))[0]!;
    expect(block.text.length).toBeLessThanOrEqual(
      CONCIERGE_COLLAPSED_MAX_LEN + CONCIERGE_TRUNCATION_SUFFIX.length,
    );
    // Never dropped: a pill with no text behind it is a button that lies.
    expect(block.text.length).toBeGreaterThan(0);
    expect(block.text.endsWith(CONCIERGE_TRUNCATION_SUFFIX)).toBe(true);
    expect(block.lineCount).toBe(countLines(block.text));
  });

  it("bounds EVERY paste on one message, not just the first", () => {
    const huge = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join("\n");
    const got = blocksOf(persistableThread([youWith(huge, huge)]));
    expect(got).toHaveLength(2);
    for (const b of got) {
      expect(b.text.length).toBeLessThanOrEqual(
        CONCIERGE_COLLAPSED_MAX_LEN + CONCIERGE_TRUNCATION_SUFFIX.length,
      );
    }
    const total = got.reduce((n, b) => n + b.text.length, 0);
    expect(total).toBeLessThanOrEqual(
      CONCIERGE_COLLAPSED_TOTAL_CHARS +
        2 * CONCIERGE_TRUNCATION_SUFFIX.length +
        2 * CONCIERGE_COLLAPSED_MIN_LEN,
    );
  });

  it("leaves pastes that already fit completely alone", () => {
    // Identity, not equality: bubbles are memoized on it.
    const chat = [youWith(BRIEF)];
    const before = blocksOf(chat);
    expect(persistableThread(chat)[0]).toBe(chat[0]);
    expect(blocksOf(persistableThread(chat))[0]).toBe(before[0]);
  });
});

// ── THE FLOOR'S OWN BUDGET ─────────────────────────────────────────────────────────────────────
// The MIN_LEN floor overdraws the aggregate budget by design. That overdraw used to be bounded by
// the SHAPE of the data — one payload per sparkle message — and a `you` message's array removed that
// bound without anyone noticing (roborev 58639): nothing caps how many pastes go into one message,
// so the overdraw became O(total blocks) with the count under the user's hand. These rows assert the
// HARD ceiling, not a per-block one, which is the only form of the claim that can catch this.
/** One message, one paste that comfortably fits. */
const youWithOne = (text: string): ConciergeMessage => ({
  id: "u1",
  kind: "you",
  text: "have a look",
  collapsed: [collapseText("blk-0", text)],
});

describe("boundCollapsedPayloads — the floor is itself budgeted", () => {
  /** A block big enough that every one of them is over the per-block cap, so every one hits the
   *  budget and then the floor. */
  const big = (n: number) => `paste ${n}\n`.repeat(4000);
  const paster = (i: number, blocks: number): ConciergeMessage => ({
    id: `u${i}`,
    kind: "you",
    text: "have a look",
    collapsed: Array.from({ length: blocks }, (_, j) => collapseText(`blk-${j}`, big(j))),
  });

  const totalCollapsed = (chat: ConciergeMessage[]) =>
    chat.reduce((n, m) => {
      if (m.kind === "you") return n + (m.collapsed ?? []).reduce((k, b) => k + b.text.length, 0);
      if (m.kind === "sparkle" && m.collapsed) return n + m.collapsed.text.length;
      return n;
    }, 0);

  /**
   * The ceiling, and why it is a CONSTANT rather than a function of the block count.
   *
   * Two budgets bound the text itself. The `…truncated` suffix rides on top of each clipped block,
   * so it looks like a third, unbounded term — it is not: a clipped block always consumes at least
   * `CONCIERGE_COLLAPSED_MIN_LEN` from one budget or the other, so the NUMBER of suffixes is capped
   * by the budgets too. That is the whole claim this row exists to make, which is why it is written
   * as an expression in the constants rather than as a magic number.
   */
  const CEILING =
    CONCIERGE_COLLAPSED_TOTAL_CHARS +
    CONCIERGE_COLLAPSED_FLOOR_TOTAL +
    ((CONCIERGE_COLLAPSED_TOTAL_CHARS + CONCIERGE_COLLAPSED_FLOOR_TOTAL) /
      CONCIERGE_COLLAPSED_MIN_LEN) *
      CONCIERGE_TRUNCATION_SUFFIX.length;

  it("holds a HARD total ceiling no matter how many blocks are spread across the thread", () => {
    // 60 messages × 20 pastes = 1200 blocks. Under a per-block floor with no allowance this is
    // ~240k characters of guaranteed overdraw on top of the 60k budget.
    const chat = Array.from({ length: 60 }, (_, i) => paster(i, 20));
    expect(totalCollapsed(persistableThread(chat))).toBeLessThanOrEqual(CEILING);
  });

  it("holds the SAME ceiling when the blocks are piled onto ONE message", () => {
    // The axis that actually became user-controlled: nothing caps pastes per message. A bound that
    // only held when blocks were spread thin would miss exactly the shape that broke it.
    expect(totalCollapsed(persistableThread([paster(0, 1200)]))).toBeLessThanOrEqual(CEILING);
  });

  it("keeps the NEWEST payloads and drops the oldest, never a pill with nothing behind it", () => {
    const chat = Array.from({ length: 60 }, (_, i) => paster(i, 20));
    const got = persistableThread(chat);
    // The last message is nearest the reader, so its pastes are the ones that survived…
    const last = got[got.length - 1]!;
    expect(last.kind === "you" && (last.collapsed?.length ?? 0)).toBeGreaterThan(0);
    // …and every block that survived ANYWHERE has real text behind it. A pill with an empty block is
    // the "button that lies" the degrade-never-vanish rule is about; dropping it outright is not.
    for (const m of got) {
      if (m.kind !== "you") continue;
      for (const b of m.collapsed ?? []) expect(b.text.length).toBeGreaterThan(0);
    }
  });

  it("still leaves a thread that fits entirely alone", () => {
    // The common case must not have acquired a drop: identity all the way through.
    const chat = [youWithOne(BRIEF)];
    expect(persistableThread(chat)[0]).toBe(chat[0]);
  });
});
