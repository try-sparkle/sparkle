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
