// THE ANCHOR RULE, EXERCISED DIRECTLY — bead sparkle-75fbot.
//
// `ConciergeColumn.previewAnchorTime.test.tsx` is the other half and the one that proves the WIRING:
// it mounts the real column, drives the real surfacing path, and asserts DOM order. This file is the
// rule itself — no React, no jsdom, no stores — and exists because a decision about data that can
// only be exercised by mounting a column is a decision nobody exercises. Neither replaces the other:
// a green rule with no caller is a write-only function, and a green column with an untested rule
// hides every edge that does not happen to occur in a fixture transcript.
import { describe, expect, it } from "vitest";
import { anchorableIdAt } from "./threadArtifactAnchor";
import type { ConciergeMessage } from "./types";

const you = (id: string, arrivedAt?: number): ConciergeMessage => ({
  id,
  kind: "you",
  text: "…",
  ...(arrivedAt === undefined ? {} : { arrivedAt }),
});

const nudge = (id: string): ConciergeMessage => ({
  id,
  kind: "nudge",
  band: "needs_you",
  projectName: "sparkle",
  agentName: "Kraken Auth",
  text: "Approve?",
  actions: [],
});

const digest = (id: string): ConciergeMessage => ({
  id,
  kind: "digest",
  band: "needs_you",
  variant: "rows",
  text: "3 Need you in drodio-website",
  leadAgentId: "ag-1",
});

describe("an artifact anchors to what had already arrived", () => {
  it("picks the newest message at or before the instant, not the newest message", () => {
    expect(anchorableIdAt([you("a", 10), you("b", 20), you("c", 30)], 25)).toBe("b");
  });

  it("includes a message that arrived at the very same instant", () => {
    // AT or before. A preview surfaced by the same turn that posted the receipt belongs under it,
    // not above it — an exclusive comparison would silently drop the most common real pairing.
    expect(anchorableIdAt([you("a", 10), you("b", 20)], 20)).toBe("b");
  });

  it("returns null when everything in the thread arrived later", () => {
    // Nothing for it to be under, so it draws at the top — the same answer an empty conversation
    // gets, reached by comparing times rather than by counting entries.
    expect(anchorableIdAt([you("a", 30), you("b", 40)], 20)).toBeNull();
  });

  it("returns null for an empty thread", () => {
    expect(anchorableIdAt([], 20)).toBeNull();
  });
});

describe("a projection can never hold an anchor", () => {
  it("skips a nudge and a digest even when they are the newest entries", () => {
    // They RETIRE. An anchor pointing at one resolves to nothing the moment the agents behind it
    // stand down, and the card jumps to the top of the transcript for a reason nobody can see.
    const messages = [you("a", 10), nudge("n1"), digest("d1")];
    expect(anchorableIdAt(messages, 999)).toBe("a");
  });

  it("skips them BEFORE reading a stamp, so a stamped projection is still refused", () => {
    // Today nothing stamps a nudge — they never reach the store. The refusal must not DEPEND on
    // that: this is the assertion that stays true if something ever does.
    const stampedNudge = { ...nudge("n1"), arrivedAt: 5 } as ConciergeMessage;
    expect(anchorableIdAt([you("a", 10), stampedNudge], 999)).toBe("a");
  });

  it("returns null when the thread is nothing but projections", () => {
    expect(anchorableIdAt([nudge("n1"), digest("d1")], 999)).toBeNull();
  });
});

describe("an unstamped message reads as older — the fallback for a thread from an older build", () => {
  it("collapses to the pre-existing rule when NOTHING carries a stamp", () => {
    // The whole restored-legacy population. Whatever the instant, the answer is the newest
    // anchorable message — byte for byte the behaviour before `arrivedAt` existed.
    const legacy = [you("a"), you("b"), you("c")];
    expect(anchorableIdAt(legacy, 0)).toBe("c");
    expect(anchorableIdAt(legacy, Number.MAX_SAFE_INTEGER)).toBe("c");
  });

  it("picks the newest unstamped message when the stamped ones all arrived later", () => {
    // The mixed thread a first send after a restore produces: restored turns at the front with no
    // stamps, this session's turns behind them with stamps. A preview that surfaced in between
    // belongs under the restored ones.
    expect(anchorableIdAt([you("old-1"), you("old-2"), you("new", 500)], 100)).toBe("old-2");
  });

  it("still prefers a stamped message that genuinely arrived before it", () => {
    // The unstamped-reads-as-older rule must not become "unstamped always wins": here the stamped
    // message is newer AND eligible, so it is the honest anchor.
    expect(anchorableIdAt([you("old"), you("recent", 50)], 100)).toBe("recent");
  });
});
