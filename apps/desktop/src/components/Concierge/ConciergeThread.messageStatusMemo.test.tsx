// @vitest-environment jsdom
//
// THE STATUS MAP MUST NOT UN-MEMOISE THE TRANSCRIPT.
//
// This is the assertion that actually protects the founder's drag-selection behaviour, and it is the
// one a careless wiring of this feature would break silently. `ConciergeMessageRow` is memoised
// because the host hands the thread a fresh array several times a second, and a transcript-wide
// re-diff on every tick lands on the main thread exactly while a click-drag is in flight (see the
// row's header, and ConciergeThread.inert.test.tsx for the same claim about message objects).
//
// A per-message status arrives as a MAP that is rebuilt every tick, so there are two obvious wirings
// and both are wrong: pass the map down, or pass a `statusFor` callback. Either changes identity on
// every render and re-renders all hundred rows for a fact about one of them — the exact mistake the
// row's header warns about, and the reason `shownBlockIds` is a string rather than the thread's Set.
// The thread therefore RESOLVES `statuses?.[m.id]` and hands each row the entry.
//
// THE PROBE is `CopyAnswerButton`, mocked: every row renders exactly one, so counting its calls
// counts the rows that re-rendered. Mocked rather than measured because "did this component
// re-render" has no DOM signature — a re-render producing identical output is invisible to a DOM
// assertion, which is precisely what is being asserted against.
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConciergeMessageStatusText } from "./MessageStatus";
import type { ConciergeMessage } from "./types";

const rendered: string[] = [];

vi.mock("./CopyAnswerButton", () => ({
  CopyAnswerButton: ({ text, kind = "answer" }: { text: string; kind?: string }) => {
    rendered.push(`${kind}:${text}`);
    return <button type="button" data-testid={`copy-${kind}`} />;
  },
}));

// Imported AFTER the mock is registered.
const { ConciergeThread } = await import("./ConciergeThread");

beforeEach(() => {
  rendered.length = 0;
});
afterEach(() => cleanup());

/** The SAME message objects across every render — which is what the store really does: it upserts
 *  in place, so only the bubble being streamed into is a new object. */
const u1: ConciergeMessage = { id: "u1", kind: "you", text: "what needs me?" };
const u2: ConciergeMessage = { id: "u2", kind: "you", text: "and the other project?" };

/** A settled status OBJECT, held across renders — a producer that recomputes the map every tick but
 *  leaves an unchanged entry alone hands down exactly this. */
const checking: ConciergeMessageStatusText = { text: "Checking git" };

function threadWith(statuses?: Record<string, ConciergeMessageStatusText>) {
  return (
    <ConciergeThread
      // A fresh ARRAY every call — the feed tick.
      messages={[u1, u2]}
      statuses={statuses}
      // Inline handlers ON PURPOSE: this is how the host passes several of them, so the memo has to
      // hold in spite of a caller whose callback identity changes on every render.
      onNudgeClick={() => {}}
      onNudgeAction={() => {}}
      onRevealAgent={() => {}}
      onRedirect={() => {}}
      onDigestClick={() => {}}
      onCopied={() => {}}
    />
  );
}

const MESSAGES = ["message:what needs me?", "message:and the other project?"];

describe("ConciergeThread — a rebuilt statuses map leaves settled rows inert", () => {
  it("does not re-render ANY row when the map is rebuilt with the same entries", () => {
    // A NEW object literal each time, holding the SAME status object for u1 — the tick where
    // nothing about any message actually changed.
    const { rerender } = render(threadWith({ u1: checking }));
    expect(rendered).toEqual(MESSAGES);
    rendered.length = 0;

    rerender(threadWith({ u1: checking }));
    rerender(threadWith({ u1: checking }));

    // Zero. Passing the map (or a `statusFor` closure) to the row would put four entries here.
    expect(rendered).toEqual([]);
  });

  it("re-renders ONLY the message whose status changed", () => {
    const { rerender } = render(threadWith({ u1: checking }));
    rendered.length = 0;

    // u1's phrase moves on; u2 still has no status at all. THE PHRASE, because that is now the only
    // thing that travels down — the ink is read by the leaf (roborev 57889-M2), so an escalation
    // from waiting to slow no longer reaches this row at all, which is the point of moving it.
    rerender(threadWith({ u1: { text: "Composing" } }));

    // The live bubble re-rendered — asserting only that u2 held still would pass against a thread
    // that renders nothing, which is the vacuous half of this pair.
    expect(rendered).toEqual(["message:what needs me?"]);
  });

  it("does not re-render a settled row when a status appears on a DIFFERENT message", () => {
    const { rerender } = render(threadWith({ u1: checking }));
    rendered.length = 0;

    rerender(threadWith({ u1: checking, u2: { text: "Composing" } }));

    expect(rendered).toEqual(["message:and the other project?"]);
  });

  it("holds every row inert across ticks when no statuses are given at all", () => {
    // The state every existing caller is in: the prop is absent, so `statuses?.[m.id]` is
    // `undefined` on both renders and the memo bites exactly as it did before this feature.
    const { rerender } = render(threadWith());
    rendered.length = 0;

    rerender(threadWith());
    rerender(threadWith());

    expect(rendered).toEqual([]);
  });
});
