// The bounded history behind the redirect button.
//
// Two maps ride on this: the plain text (what a Sparkle redirect replays) and the agent payload
// (the same text with attachment paths prefixed). They MUST evict together — a desynced pair fails
// silently rather than loudly, because redirect falls back to `?? text` and would send the agent
// the path-less string. That lockstep is structural: both go through this one helper, and the bug
// was one of them using a bare `map.set()` and growing for the whole session (roborev 53286).
import { describe, expect, it } from "vitest";
// Imported from its own module rather than through ConciergeHost's re-export, so this suite does not
// pull the whole host in to test two pure functions.
import { rememberSentText, SENT_TEXT_LIMIT } from "./Concierge/sentTextLedger";

describe("rememberSentText", () => {
  it("keeps entries under the cap", () => {
    const m = new Map<string, string>();
    for (let i = 0; i < SENT_TEXT_LIMIT; i++) rememberSentText(m, `id${i}`, `text ${i}`);
    expect(m.size).toBe(SENT_TEXT_LIMIT);
    expect(m.get("id0")).toBe("text 0");
  });

  it("evicts oldest-first past the cap", () => {
    const m = new Map<string, string>();
    for (let i = 0; i < SENT_TEXT_LIMIT + 5; i++) rememberSentText(m, `id${i}`, `text ${i}`);
    expect(m.size).toBe(SENT_TEXT_LIMIT);
    expect(m.has("id0")).toBe(false); // the oldest five are gone
    expect(m.has("id4")).toBe(false);
    expect(m.has("id5")).toBe(true);
    expect(m.get(`id${SENT_TEXT_LIMIT + 4}`)).toBe(`text ${SENT_TEXT_LIMIT + 4}`);
  });

  // Both maps are fed the same ids in the same order, so identical inputs must leave them holding
  // exactly the same key set — the property redirect relies on.
  it("leaves two maps fed the same ids holding the same keys", () => {
    const text = new Map<string, string>();
    const payload = new Map<string, string>();
    for (let i = 0; i < SENT_TEXT_LIMIT + 12; i++) {
      rememberSentText(text, `id${i}`, `t${i}`);
      rememberSentText(payload, `id${i}`, `/tmp/a.png t${i}`);
    }
    expect([...payload.keys()]).toEqual([...text.keys()]);
  });
});
