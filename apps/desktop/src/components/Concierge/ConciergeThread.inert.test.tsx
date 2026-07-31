// @vitest-environment jsdom
//
// A SETTLED TRANSCRIPT ENTRY IS INERT.
//
// The host hands ConciergeThread a fresh `messages` array several times a second — the view model is
// rebuilt on every concierge-feed tick, on every keystroke in the compose box, and on every token of
// a streaming reply. Before ./ConciergeMessageRow existed, each of those re-created and re-diffed
// every bubble in the thread, including the hundred that had not changed since they were written.
//
// That is the cost this file pins down. It matters for the founder's copy complaint because the work
// lands on the main thread exactly while a drag is in flight: a click-drag selection is a stream of
// `mousemove`s the browser can only extend the highlight from if it is free to process them.
//
// The probe is `<Markdown>`: it is rendered once per answer, so counting its calls counts the
// answers that re-rendered. Mocked rather than measured, because "did this component re-render" has
// no DOM signature — a re-render that produces identical output is invisible to a DOM assertion,
// which is precisely the thing being asserted against.
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConciergeMessage } from "./types";

const rendered: string[] = [];

vi.mock("../Markdown", () => ({
  Markdown: ({ text }: { text: string }) => {
    rendered.push(text);
    return <div data-testid="md">{text}</div>;
  },
}));

// Imported AFTER the mock is registered.
const { ConciergeThread } = await import("./ConciergeThread");

beforeEach(() => {
  rendered.length = 0;
});
afterEach(() => cleanup());

/** A settled answer. The SAME object across both renders — which is what the store really does:
 *  `setChat` slices the array and replaces only the bubble being streamed into. */
const settled: ConciergeMessage = { id: "settled", kind: "sparkle", text: "the settled answer" };

/** A fresh ARRAY every call — the feed tick — holding whichever message objects it is given. */
function threadOf(messages: ConciergeMessage[]) {
  return (
    <ConciergeThread
      messages={[...messages]}
      // Inline handlers ON PURPOSE — this is how the host passes several of them, so the memo has to
      // hold in spite of a caller whose callback identity changes every render.
      onNudgeClick={() => {}}
      onNudgeAction={() => {}}
      onRevealAgent={() => {}}
      onRedirect={() => {}}
      onDigestClick={() => {}}
      // `onCopied` belongs in this list too. It reaches every row as `onAnswerCopied`, and it was the
      // one handler not ref-stabilised at first — stable only by accident of how the host happens to
      // build it. Passed inline here so that accident cannot be what keeps this test green.
      onCopied={() => {}}
    />
  );
}

/** The streaming bubble, as the store rebuilds it: a NEW object holding the grown text. */
const streamed = (text: string): ConciergeMessage => ({ id: "streaming", kind: "sparkle", text });

describe("ConciergeThread — settled entries are inert", () => {
  it("does not re-render a settled answer while another one streams", () => {
    const { rerender } = render(threadOf([settled, streamed("a")]));
    expect(rendered).toEqual(["the settled answer", "a"]);

    // Three more tokens arrive in the OTHER bubble.
    rerender(threadOf([settled, streamed("ab")]));
    rerender(threadOf([settled, streamed("abc")]));
    rerender(threadOf([settled, streamed("abcd")]));

    // The settled answer rendered exactly once, at mount. The streaming one rendered every time,
    // which it must — asserting only the first half would pass against a thread that renders nothing
    // at all.
    expect(rendered.filter((t) => t === "the settled answer")).toHaveLength(1);
    expect(rendered.filter((t) => t.startsWith("a"))).toEqual(["a", "ab", "abc", "abcd"]);
  });

  it("does not re-render ANY entry when the array is rebuilt with identical contents", () => {
    // The feed tick: a new ARRAY, the same message OBJECTS. Clicking an agent in another column, or
    // typing a character in the compose box, does exactly this.
    const stable = [settled, streamed("a")];
    const { rerender } = render(threadOf(stable));
    rendered.length = 0;

    rerender(threadOf(stable));
    rerender(threadOf(stable));

    expect(rendered).toEqual([]);
  });
});
