// The reply-anchoring RULE: which of the user's messages one concierge reply is answering.
//
// These cases are about the inference, not the pixels — ConciergeThread.anchors.test.tsx owns the
// stub, the jump and the marker, and ConciergeHost.replyAnchors.test.tsx owns the wiring that stamps a
// real streamed reply. What is pinned here is the thing that would silently over-claim: the walk's
// stopping condition, and the delivery test that keeps an agent-bound message out of a reply's claim.
import { describe, expect, it } from "vitest";
import {
  ANCHOR_MAX,
  ANCHOR_QUOTE_MAX,
  anchorQuote,
  answeredByIndex,
  pendingAnchors,
  reachedTheBrain,
  remapAnchors,
} from "./replyAnchors";
import { collapseText } from "../composer/attachments";
import type { ConciergeMessage, ConciergeReceipt } from "./types";

const you = (id: string, text: string, receipt?: ConciergeReceipt): ConciergeMessage => ({
  id,
  kind: "you",
  text,
  receipt,
});
/** A COMPLETED answer — the only thing that ends a burst. */
const sparkle = (id: string, text = "sure"): ConciergeMessage => ({
  id,
  kind: "sparkle",
  text,
  settled: true,
});
/** An APP-AUTHORED status line (`ConciergeHost.postSparkle`): same kind, never a turn, never `done`. */
const local = (id: string, text = "Sent to Kraken Auth."): ConciergeMessage => ({
  id,
  kind: "sparkle",
  text,
});
/** A turn the user's next send killed mid-stream — the fragment `askSparkle` leaves alone on purpose. */
const fragment = (id: string, text = "Let me ch"): ConciergeMessage => ({ id, kind: "sparkle", text });
const push = (id: string, text = "heads up"): ConciergeMessage => ({
  id,
  kind: "sparkle",
  text,
  proactive: true,
});
const toSparkle: ConciergeReceipt = { target: "sparkle" };
const toAgent: ConciergeReceipt = { target: "agent", agentName: "Kraken Auth" };

describe("anchorQuote", () => {
  it("collapses a multi-line paste onto ONE line", () => {
    // A stub that kept its newlines would grow into a wall above every reply, or be clipped by CSS
    // with the interesting part off screen.
    expect(anchorQuote("first\nsecond\n\n  third  ")).toBe("first second third");
  });

  it("caps the STRING, not just the rendering, so a long paste can't ride along on the reply", () => {
    const long = "x".repeat(4000);
    const q = anchorQuote(long);
    expect(q.length).toBeLessThanOrEqual(ANCHOR_QUOTE_MAX);
    expect(q.endsWith("…")).toBe(true);
  });

  it("leaves a short message exactly as it reads", () => {
    expect(anchorQuote("what about the retry?")).toBe("what about the retry?");
  });
});

describe("reachedTheBrain", () => {
  it("counts a message routed to Sparkle", () => {
    expect(reachedTheBrain({ id: "y1", kind: "you", text: "hi", receipt: toSparkle })).toBe(true);
  });

  it("counts a message with NO receipt yet — deliver() asks before it stamps", () => {
    expect(reachedTheBrain({ id: "y1", kind: "you", text: "hi" })).toBe(true);
  });

  it("REFUSES a message that went into an agent's terminal", () => {
    // The brain never saw it, so a reply claiming to answer it is the same class of false statement
    // as the "never answered" line this affordance replaces.
    expect(reachedTheBrain({ id: "y1", kind: "you", text: "hi", receipt: toAgent })).toBe(false);
  });

  it("counts an agent-bound message the user ALSO asked Sparkle about", () => {
    expect(
      reachedTheBrain({ id: "y1", kind: "you", text: "hi", receipt: { ...toAgent, alsoSentTo: "sparkle" } }),
    ).toBe(true);
  });
});

describe("pendingAnchors — what a reply appended right now would be answering", () => {
  it("claims the whole burst, in the order he SENT them", () => {
    // The founder's case: several messages fired while a turn was in flight, one reply covering them.
    const chat = [
      sparkle("s0"),
      you("y1", "one", toSparkle),
      you("y2", "two", toSparkle),
      you("y3", "three", toSparkle),
    ];
    expect(pendingAnchors(chat)).toEqual([
      { id: "y1", quote: "one" },
      { id: "y2", quote: "two" },
      { id: "y3", quote: "three" },
    ]);
  });

  it("stops at the previous REPLY — an answered message is not claimed twice", () => {
    const chat = [you("y1", "old", toSparkle), sparkle("s1"), you("y2", "new", toSparkle)];
    expect(pendingAnchors(chat).map((a) => a.id)).toEqual(["y2"]);
  });

  it("does NOT stop at an app-authored status line — a receipt is not an answer", () => {
    // The founder interleaves an agent-bound message into a burst; `deliver` posts "Sent to Kraken
    // Auth." as an ordinary `sparkle` bubble. Reading that as the previous reply truncates the
    // outstanding set and the brain's answer anchors NOTHING — the affordance reading as broken in
    // exactly the interleaved case it was built for. Note the asymmetry it would create:
    // `reachedTheBrain` skips the agent-bound `you` message, while the receipt posted FOR it would
    // have ended the burst.
    const chat = [
      you("y1", "how's CI", toSparkle),
      you("y2", "@Kraken run the tests", toAgent),
      local("s-local"),
    ];
    expect(pendingAnchors(chat).map((a) => a.id)).toEqual(["y1"]);
  });

  it("does NOT stop at a turn that died mid-stream — a fragment answered nothing", () => {
    // `askSparkle` leaves a bubble that streamed text alone, on purpose, so nine characters of a dead
    // answer live in the thread forever. Treating it as the previous reply hands the real answer only
    // the newest message of the burst.
    const chat = [you("y1", "one", toSparkle), fragment("brain-1"), you("y2", "two", toSparkle)];
    expect(pendingAnchors(chat).map((a) => a.id)).toEqual(["y1", "y2"]);
  });

  it("does NOT stop at a push — nobody asked for it, so it settles nothing", () => {
    const chat = [you("y1", "one", toSparkle), push("p1"), you("y2", "two", toSparkle)];
    expect(pendingAnchors(chat).map((a) => a.id)).toEqual(["y1", "y2"]);
  });

  it("does NOT stop at a failure — a turn that died leaves its question outstanding", () => {
    const chat: ConciergeMessage[] = [
      you("y1", "one", toSparkle),
      { id: "e1", kind: "failure", headline: "That turn failed.", evidence: "boom" },
      you("y2", "two", toSparkle),
    ];
    expect(pendingAnchors(chat).map((a) => a.id)).toEqual(["y1", "y2"]);
  });

  it("skips a message that went to an agent, keeping the ones that reached the brain", () => {
    const chat = [
      you("y1", "ask sparkle", toSparkle),
      you("y2", "run the tests", toAgent),
      you("y3", "and this", toSparkle),
    ];
    expect(pendingAnchors(chat).map((a) => a.id)).toEqual(["y1", "y3"]);
  });

  it("names an attachments-only send rather than quoting nothing", () => {
    const chat: ConciergeMessage[] = [
      {
        id: "y1",
        kind: "you",
        text: "",
        receipt: toSparkle,
        attachments: [
          { id: "a1", kind: "image", path: "/tmp/a.png", name: "a.png" },
          { id: "a2", kind: "image", path: "/tmp/b.png", name: "b.png" },
        ],
      },
    ];
    expect(pendingAnchors(chat)).toEqual([{ id: "y1", quote: "2 attachments" }]);
  });

  it("returns nothing when the last word was already the concierge's", () => {
    expect(pendingAnchors([you("y1", "one", toSparkle), sparkle("s1")])).toEqual([]);
  });

  it("keeps the NEWEST when a burst runs past the cap", () => {
    // Clipping the newest would leave the messages he is staring at looking unanswered — the exact
    // complaint. Order is still oldest-first within what survives.
    const chat = Array.from({ length: ANCHOR_MAX + 5 }, (_, i) => you(`y${i}`, `m${i}`, toSparkle));
    const got = pendingAnchors(chat);
    expect(got).toHaveLength(ANCHOR_MAX);
    expect(got[0]!.id).toBe("y5");
    expect(got.at(-1)!.id).toBe(`y${ANCHOR_MAX + 4}`);
  });
});

describe("answeredByIndex — the marker under the user's own message", () => {
  it("points each anchored message at the reply that answers it", () => {
    const chat: ConciergeMessage[] = [
      you("y1", "one", toSparkle),
      you("y2", "two", toSparkle),
      {
        id: "brain-7",
        kind: "sparkle",
        text: "both, then",
        settled: true,
        answers: [
          { id: "y1", quote: "one" },
          { id: "y2", quote: "two" },
        ],
      },
    ];
    const idx = answeredByIndex(chat);
    expect(idx.get("y1")).toBe("brain-7");
    expect(idx.get("y2")).toBe("brain-7");
  });

  it("leaves a message no reply named out of the index", () => {
    const chat: ConciergeMessage[] = [
      you("y1", "one", toSparkle),
      {
        id: "brain-7",
        kind: "sparkle",
        text: "hm",
        settled: true,
        answers: [{ id: "y0", quote: "older" }],
      },
    ];
    expect(answeredByIndex(chat).has("y1")).toBe(false);
  });

  it("points at the NEWEST of two settled replies that name one message", () => {
    // THE DEFENSIVE ORDERING, measured rather than merely documented. Both replies are `settled` on
    // purpose: with one of them unsettled the filter above removes it, leaving a single writer, and
    // the assertion would pass identically under a first-wins implementation — a test named for an
    // ordering it does not exercise.
    //
    // The state itself should be unreachable: the walk stops at a settled reply, so a settled reply
    // ends the burst and the next one cannot name the same message. That is exactly why the ordering
    // needs a test — an invariant nothing enforces is one a later change can quietly break, and the
    // newest claimant is the freshest thing said about a message if it ever does.
    const chat: ConciergeMessage[] = [
      you("y1", "one", toSparkle),
      {
        id: "brain-7",
        kind: "sparkle",
        text: "First pass.",
        settled: true,
        answers: [{ id: "y1", quote: "one" }],
      },
      {
        id: "brain-9",
        kind: "sparkle",
        text: "Checked — it's fine.",
        settled: true,
        answers: [{ id: "y1", quote: "one" }],
      },
    ];
    expect(answeredByIndex(chat).get("y1")).toBe("brain-9");
  });

  it("refuses to mark a message answered by a turn that has not finished", () => {
    // A bubble is stamped with its anchors on its FIRST DELTA, so an unsettled one is a claim in
    // progress, not a delivery. The marker appears when the reply FINISHES — which is what the word
    // "Answered" means.
    const chat: ConciergeMessage[] = [
      you("y1", "one", toSparkle),
      { id: "brain-7", kind: "sparkle", text: "Let me ch", answers: [{ id: "y1", quote: "one" }] },
    ];
    expect(answeredByIndex(chat).has("y1")).toBe(false);
  });

  it("marks it the moment that same turn settles", () => {
    const chat: ConciergeMessage[] = [
      you("y1", "one", toSparkle),
      {
        id: "brain-7",
        kind: "sparkle",
        text: "It's fine.",
        settled: true,
        answers: [{ id: "y1", quote: "one" }],
      },
    ];
    expect(answeredByIndex(chat).get("y1")).toBe("brain-7");
  });

  it("ignores an anchor whose target didn't survive restore", () => {
    // `settled` MATTERS TO THIS CASE even though it is not what it is about: without it the reply is
    // filtered out before the loop reaches the empty-id guard, and the assertion would hold with that
    // guard deleted outright — a test measuring nothing. The guard is a real rule (every
    // restore-orphaned reply would otherwise be mapped under one bogus "" key), so it has to be what
    // the assertion actually reaches.
    const chat: ConciergeMessage[] = [
      { id: "brain-7", kind: "sparkle", text: "a", settled: true, answers: [{ id: "", quote: "gone" }] },
    ];
    expect(answeredByIndex(chat).has("")).toBe(false);
  });
});

describe("remapAnchors — surviving the persisted thread's reindex", () => {
  it("rewrites the ids so a restored stub still jumps", () => {
    const map = new Map([
      ["you-1", "restored:0"],
      ["you-2", "restored:1"],
    ]);
    expect(remapAnchors([{ id: "you-1", quote: "one" }, { id: "you-2", quote: "two" }], map)).toEqual([
      { id: "restored:0", quote: "one" },
      { id: "restored:1", quote: "two" },
    ]);
  });

  it("keeps the QUOTE and drops only the jump when the target was trimmed away", () => {
    // A reply that answered a message old enough to fall off the front still truthfully says what it
    // answered; what it can't do any more is scroll there.
    expect(remapAnchors([{ id: "you-1", quote: "one" }], new Map())).toEqual([{ id: "", quote: "one" }]);
  });

  it("leaves a reply with no anchors without an empty array to persist", () => {
    expect(remapAnchors(undefined, new Map())).toBeUndefined();
    expect(remapAnchors([], new Map())).toBeUndefined();
  });
});

// ── A MESSAGE WHOSE WORDS ARE ALL INSIDE A PILL ────────────────────────────────────────────────
// A `you` message's `text` is only what was typed AROUND its pastes (ConciergeUserMessage.collapsed),
// so a send that is nothing but a paste has `text === ""` — and the compose box allows exactly that.
// Before the fallback, the chain fell through to `attachmentQuote(0)` and a forty-row message was
// quoted, above the reply answering it, as "0 attachments".
describe("pendingAnchors — quoting a message whose words are all in a pill", () => {
  const PASTE = `Ship the reply linter behind a flag\n${Array.from(
    { length: 8 },
    (_, i) => `step ${i}`,
  ).join("\n")}\n`;
  const pasted = (id: string, typed: string): ConciergeMessage => ({
    id,
    kind: "you",
    text: typed,
    collapsed: [collapseText("blk-1", PASTE)],
  });

  it("quotes the paste's own first words when nothing was typed", () => {
    const [anchor] = pendingAnchors([pasted("you-1", "")]);
    expect(anchor!.quote).toBe("Ship the reply linter behind a flag");
    // Explicitly NOT the fallback below it, which is what this used to read.
    expect(anchor!.quote).not.toContain("attachment");
  });

  it("still prefers the TYPED words when there are any", () => {
    // The paste is context; the sentence is the question. The stub should say the question.
    const [anchor] = pendingAnchors([pasted("you-1", "what is wrong here?")]);
    expect(anchor!.quote).toBe("what is wrong here?");
  });

  it("caps a pill quote like every other quote", () => {
    const long = `${"z".repeat(400)}\nb\nc\nd\ne\nf\n`;
    const [anchor] = pendingAnchors([
      { id: "you-1", kind: "you", text: "", collapsed: [collapseText("blk-1", long)] },
    ]);
    expect(anchor!.quote.length).toBeLessThanOrEqual(ANCHOR_QUOTE_MAX);
  });

  it("falls all the way through to the attachment count when there is no paste either", () => {
    // The pre-existing behaviour, restated so the new rung cannot have displaced it.
    const [anchor] = pendingAnchors([
      { id: "you-1", kind: "you", text: "", attachments: [] as never[] },
    ]);
    expect(anchor!.quote).toBe("0 attachments");
  });
});
