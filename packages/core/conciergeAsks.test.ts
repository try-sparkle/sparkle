import { describe, expect, it } from "vitest";

import {
  type AskBead,
  MAX_ASKS_PER_MESSAGE,
  MIN_ASK_WORDS,
  askBeadBody,
  askKey,
  askKeyOf,
  asksIn,
  isFollowUp,
  planAsks,
  seenLabel,
  timesAskedOf,
} from "./conciergeAsks";

const T = "turn-1";
const AT = 1_700_000_000_000;

/** The sentences that produced this feature — the four things he had to chase on 2026-08-09. */
describe("the asks that were actually dropped", () => {
  it("captures a build request that left no trace in any project", () => {
    const { asks } = asksIn("build me ten homepage designs for drodio.com", T, AT);
    expect(asks.map((a) => a.sentence)).toEqual([
      "build me ten homepage designs for drodio.com",
    ]);
  });

  it("captures a request framed as a want rather than an imperative", () => {
    const { asks } = asksIn("I want you to look at the Gary Tan ideas", T, AT);
    expect(asks).toHaveLength(1);
  });

  it("captures a capability request", () => {
    const { asks } = asksIn(
      "can you give the concierge research agents it can dispatch to",
      T,
      AT,
    );
    expect(asks).toHaveLength(1);
  });
});

describe("what is NOT an ask", () => {
  // The whole point of the queue is that he stops needing to type these. Filing one as an ask
  // would answer the question by adding to the pile the question was about.
  it.each([
    "what happened to the ten homepage designs?",
    "where is that research agent work?",
    "did you ever spawn that agent?",
    "any update on the Gary Tan ideas?",
    "why am I having to ask you so many questions about this?",
  ])("treats a lookup about existing work as a follow-up, not a new ask: %s", (text) => {
    expect(isFollowUp(text)).toBe(true);
    expect(asksIn(text, T, AT).asks).toEqual([]);
  });

  // These authorise an ask that already exists. A bead titled "do it" is unreadable a week later.
  it.each(["go", "do it", "yes please", "ship it"])(
    "does not turn a bare approval into a contentless bead: %s",
    (text) => {
      expect(asksIn(text, T, AT).asks).toEqual([]);
    },
  );

  it("ignores ordinary conversation that asks for nothing", () => {
    const { asks } = asksIn("that looks great, the seam is much better now", T, AT);
    expect(asks).toEqual([]);
  });

  // roborev 61845: these match a REQUEST FRAME ("can you", "please"), so they slipped past the
  // `^`-anchored lookup guard and minted a duplicate bead for something already in the queue.
  it.each([
    "can you tell me what happened to the homepage designs?",
    "could you remind me where is that research work?",
    "do you know did we ever spawn that agent?",
    "hey, so what happened to the Gary Tan ideas?",
    "please let me know what's the status of the homepage designs",
  ])("sees a lookup even behind a polite lead-in: %s", (text) => {
    expect(isFollowUp(text)).toBe(true);
    expect(asksIn(text, T, AT).asks).toEqual([]);
  });

  it("does NOT mistake a real request that merely mentions a place for a lookup", () => {
    // The lookup frames stay anchored precisely so this keeps working — an unanchored `where is`
    // would swallow it.
    expect(asksIn("check where the config is and fix it", T, AT).asks).toHaveLength(1);
  });

  // roborev 61845: six words, all of them filler — a bead titled this says nothing.
  it.each([
    "yes go ahead and do it",
    "ok please just do that now",
    "sure go ahead and do it",
  ])("rejects an approval that is long enough but says nothing: %s", (text) => {
    expect(asksIn(text, T, AT).asks).toEqual([]);
  });

  it("still captures a short ask that has real subject matter", () => {
    // The substantive floor is deliberately weak so it cannot start eating real asks.
    expect(asksIn("fix the login bug now", T, AT).asks).toHaveLength(1);
    expect(asksIn("go ahead and build the homepage", T, AT).asks).toHaveLength(1);
  });

  it(`requires at least ${MIN_ASK_WORDS} words of content`, () => {
    // Three words: an imperative, but nothing a reader could act on months later.
    expect(asksIn("build the thing", T, AT).asks).toEqual([]);
    // Four words: the shortest real ask observed.
    expect(asksIn("build ten homepage designs", T, AT).asks).toHaveLength(1);
  });
});

describe("multi-ask messages", () => {
  it("captures each ask in a bulleted list, in the order he said them", () => {
    const { asks } = asksIn(
      ["Couple of things:", "- build the homepage designs", "- research the Gary Tan ideas"].join(
        "\n",
      ),
      T,
      AT,
    );
    expect(asks.map((a) => a.sentence)).toEqual([
      "build the homepage designs",
      "research the Gary Tan ideas",
    ]);
  });

  it("collapses the same ask restated twice in one message", () => {
    const { asks } = asksIn(
      "Build ten homepage designs. Please build ten homepage designs!",
      T,
      AT,
    );
    expect(asks).toHaveLength(1);
  });

  it("caps the asks per message but RETURNS what it withheld, never silently", () => {
    const sentences = Array.from(
      { length: MAX_ASKS_PER_MESSAGE + 3 },
      (_, i) => `build the number ${i} widget`,
    );
    const { asks, dropped } = asksIn(sentences.join("\n"), T, AT);

    expect(asks.map((a) => a.sentence)).toEqual(sentences.slice(0, MAX_ASKS_PER_MESSAGE));
    // THE RECORDS, not a count. This is the assertion that proves the feature: a length check alone
    // would pass against a stub that returned three empty objects, and the whole point of the change
    // is that the caller can NAME to the founder what was held back rather than ask him to repeat it.
    expect(dropped.map((a) => a.sentence)).toEqual(sentences.slice(MAX_ASKS_PER_MESSAGE));
    // And they are real AskRecords, carrying the same identity the kept ones do.
    expect(dropped[0]?.key).toBe(askKey(sentences[MAX_ASKS_PER_MESSAGE]!));
    expect(dropped[0]?.turnId).toBe(T);
    expect(dropped[0]?.at).toBe(AT);
  });

  it("honours an explicit cap, so absorbed messages scale the bound with them", () => {
    // The caller passes `MAX_ASKS_PER_MESSAGE * runLength` when several of his messages were folded
    // into one turn. A cap of 2 stands in for that arithmetic.
    const sentences = Array.from({ length: 5 }, (_, i) => `build the number ${i} widget`);
    const { asks, dropped } = asksIn(sentences.join("\n"), T, AT, 2);
    expect(asks.map((a) => a.sentence)).toEqual(sentences.slice(0, 2));
    expect(dropped.map((a) => a.sentence)).toEqual(sentences.slice(2));
  });

  it("scales with the number of absorbed messages rather than shrinking to one message's worth", () => {
    const sentences = Array.from({ length: 12 }, (_, i) => `build the number ${i} widget`);
    // Two messages absorbed into one turn: the cap is per MESSAGE, so it doubles.
    const { asks, dropped } = asksIn(sentences.join("\n"), T, AT, MAX_ASKS_PER_MESSAGE * 2);
    expect(asks).toHaveLength(12);
    expect(dropped).toEqual([]);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])("falls back to the per-message cap for a %s cap rather than discarding asks", (_name, cap) => {
    // A caller's arithmetic slip must never silently throw work away: slice(0, NaN) keeps NOTHING and
    // slice(0, -1) drops the last one, both without an error.
    const sentences = Array.from({ length: 5 }, (_, i) => `build the number ${i} widget`);
    const { asks, dropped } = asksIn(sentences.join("\n"), T, AT, cap);
    expect(asks.map((a) => a.sentence)).toEqual(sentences);
    expect(dropped).toEqual([]);
  });

  it("returns an EMPTY ARRAY, never undefined, when nothing was withheld", () => {
    const out = asksIn("build ten homepage designs", T, AT);
    // A caller reading out.dropped.length must not throw on the ordinary path.
    expect(out.dropped).toEqual([]);
    expect(out.dropped.length).toBe(0);
  });

  it("caps at EIGHT asks per message", () => {
    // Asserted as a literal on purpose, unlike every other test here: the value was raised from 4
    // because batching several of his messages into one turn made the old bound bite, and a silent
    // re-lowering would restore the failure with the whole suite still green.
    expect(MAX_ASKS_PER_MESSAGE).toBe(8);
  });
});

describe("the dedupe key", () => {
  // This is what makes a re-ask escalate one bead instead of minting a second.
  it("is identical across punctuation, case and politeness", () => {
    expect(askKey("Build ten homepage designs")).toBe(
      askKey("please build ten homepage designs!"),
    );
  });

  it("is stable across turns, so a re-ask weeks later finds the same bead", () => {
    const first = asksIn("build ten homepage designs", "turn-a", AT).asks[0];
    const later = asksIn("Build ten homepage designs.", "turn-z", AT + 9e8).asks[0];
    expect(later?.key).toBe(first?.key);
  });

  it("differs for genuinely different requests", () => {
    expect(askKey("build ten homepage designs")).not.toBe(
      askKey("research the Gary Tan ideas"),
    );
  });
});

describe("the beads mapping", () => {
  const ask = (text: string) => asksIn(text, T, AT).asks[0]!;

  it("round-trips the dedupe key through a bead body", () => {
    const a = ask("build ten homepage designs");
    expect(askKeyOf(askBeadBody(a))).toBe(a.key);
  });

  it("keeps his verbatim words in the body a human will read", () => {
    expect(askBeadBody(ask("build ten homepage designs for drodio.com"))).toContain(
      "build ten homepage designs for drodio.com",
    );
  });

  it("returns null for a bead that is not an ask", () => {
    expect(askKeyOf("just an ordinary bead description")).toBeNull();
  });

  it("reads a first-time ask as asked once", () => {
    expect(timesAskedOf([])).toBe(1);
    expect(timesAskedOf(["concierge-ask"])).toBe(1);
  });

  it("reads the recurrence count off the label", () => {
    expect(timesAskedOf(["concierge-ask", seenLabel(4)])).toBe(4);
  });

  it("ignores an unparseable seen label rather than throwing", () => {
    expect(timesAskedOf(["ask-seen-banana"])).toBe(1);
  });
});

describe("planAsks — what a message implies for the board", () => {
  const ask = (text: string) => asksIn(text, T, AT).asks[0]!;
  const beadFor = (text: string, over: Partial<AskBead> = {}): AskBead => ({
    id: "sparkle-old1",
    body: askBeadBody(ask(text)),
    labels: ["concierge-ask"],
    open: true,
    ...over,
  });

  it("files a brand-new ask", () => {
    const plan = planAsks([ask("build ten homepage designs")], []);
    expect(plan.create).toHaveLength(1);
    expect(plan.bump).toEqual([]);
  });

  // The whole reason the key exists: a re-ask must land on ONE bead, so the evidence accumulates.
  it("bumps an existing OPEN ask instead of filing a duplicate", () => {
    const plan = planAsks(
      [ask("Please build ten homepage designs!")],
      [beadFor("build ten homepage designs")],
    );
    expect(plan.create).toEqual([]);
    expect(plan.bump).toHaveLength(1);
    expect(plan.bump[0]).toMatchObject({ beadId: "sparkle-old1", from: 1, to: 2 });
  });

  it("carries the recurrence forward from the label", () => {
    const plan = planAsks(
      [ask("build ten homepage designs")],
      [beadFor("build ten homepage designs", { labels: ["concierge-ask", seenLabel(3)] })],
    );
    expect(plan.bump[0]).toMatchObject({ from: 3, to: 4 });
  });

  // Asking again for something we already marked done is a disagreement a human should see — so it
  // is neither a silent re-open nor a duplicate hiding the closure.
  it("surfaces a re-ask of a CLOSED bead as its own outcome", () => {
    const plan = planAsks(
      [ask("build ten homepage designs")],
      [beadFor("build ten homepage designs", { open: false })],
    );
    expect(plan.create).toEqual([]);
    expect(plan.bump).toEqual([]);
    expect(plan.reasked).toHaveLength(1);
    expect(plan.reasked[0]?.closedBeadId).toBe("sparkle-old1");
  });

  it("prefers the OPEN bead when a key has both, so the live obligation is the one bumped", () => {
    const plan = planAsks(
      [ask("build ten homepage designs")],
      [
        beadFor("build ten homepage designs", { id: "sparkle-closed", open: false }),
        beadFor("build ten homepage designs", { id: "sparkle-open", open: true }),
      ],
    );
    expect(plan.bump[0]?.beadId).toBe("sparkle-open");
    expect(plan.reasked).toEqual([]);
  });

  it("ignores non-ask beads on the board entirely", () => {
    const plan = planAsks(
      [ask("build ten homepage designs")],
      [{ id: "sparkle-other", body: "unrelated engineering work", labels: [], open: true }],
    );
    expect(plan.create).toHaveLength(1);
  });
});

describe("the record", () => {
  it("keeps the founder's own words verbatim, never a paraphrase", () => {
    const text = "Please build me ten homepage designs for drodio.com, ASAP!";
    const { asks } = asksIn(text, T, AT);
    expect(asks[0]?.sentence).toBe(text);
  });

  it("carries the turn and the caller's clock", () => {
    const { asks } = asksIn("build ten homepage designs", "turn-42", 12345);
    expect(asks[0]).toMatchObject({ turnId: "turn-42", at: 12345 });
  });
});
