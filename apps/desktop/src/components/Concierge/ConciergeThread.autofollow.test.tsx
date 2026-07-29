// @vitest-environment jsdom
//
// Auto-follow behavior of the concierge thread (bead sparkle-y4ft). The reported bug: "every time I
// click on an item, it scrolls me to the bottom of the first column." Two causes, both covered here —
// the effect fired on every re-render regardless of where the user had scrolled to, and ConciergeHost
// hands this component a fresh `messages` array on every concierge-feed tick, so "re-render" meant
// "several times a second while you are reading".
//
// jsdom gives every element scrollHeight/clientHeight of 0, so the geometry has to be installed by
// hand; defineProperty on the instance is what makes "the user is scrolled up" representable at all.
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ConciergeThread } from "./ConciergeThread";
import type { ConciergeMessage } from "./types";

afterEach(() => cleanup());

const noop = () => {};

function msgs(n: number): ConciergeMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    kind: "sparkle" as const,
    text: `message ${i}`,
  }));
}

/** Give the scroller a real scrollable geometry: 1000px of content in a 200px viewport. */
function makeScrollable(el: HTMLElement, scrollHeight = 1000, clientHeight = 200): void {
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true });
}

/** Scroll the way a READER does: move scrollTop and let the scroll event fire. The component
 *  tracks follow-state from that event (not by re-measuring after layout), so a test that only
 *  assigns scrollTop is describing something no user can do. */
function readerScrollsTo(el: HTMLElement, top: number): void {
  el.scrollTop = top;
  fireEvent.scroll(el);
}

function thread(): HTMLElement {
  const el = document.querySelector('[data-testid="concierge-thread"]');
  if (!el) throw new Error("thread not rendered");
  return el as HTMLElement;
}

describe("ConciergeThread — auto-follow", () => {
  it("follows the newest message when the user is already pinned to the bottom", () => {
    const { rerender } = render(
      <ConciergeThread messages={msgs(3)} onNudgeClick={noop} onNudgeAction={noop} />,
    );
    const el = thread();
    makeScrollable(el);
    readerScrollsTo(el, 800); // scrollHeight - clientHeight === bottom

    rerender(<ConciergeThread messages={msgs(4)} onNudgeClick={noop} onNudgeAction={noop} />);

    expect(el.scrollTop).toBe(el.scrollHeight);
  });

  it("leaves a scrolled-up reader where they are when a new message arrives", () => {
    const { rerender } = render(
      <ConciergeThread messages={msgs(3)} onNudgeClick={noop} onNudgeAction={noop} />,
    );
    const el = thread();
    makeScrollable(el);
    // A real wheel gesture emits a SEQUENCE of scroll events, and the component only demotes on an
    // event that actually moved — so drag through an intermediate position rather than teleporting
    // to a value the mount may already have recorded.
    readerScrollsTo(el, 400);
    readerScrollsTo(el, 0); // reading the top of the thread

    rerender(<ConciergeThread messages={msgs(4)} onNudgeClick={noop} onNudgeAction={noop} />);

    expect(el.scrollTop).toBe(0);
  });

  // The actual founder-visible bug. ConciergeHost rebuilds `messages` as [...chat, ...nudges] in a
  // useMemo keyed on the feed, so clicking an item — which mutates selection, which ticks the feed —
  // handed this component a NEW ARRAY with IDENTICAL CONTENTS. Keying the effect on array identity
  // meant every such tick slammed the column to the bottom.
  it("does not move on a re-render whose message list is contentwise unchanged", () => {
    const first = msgs(3);
    const { rerender } = render(
      <ConciergeThread messages={first} onNudgeClick={noop} onNudgeAction={noop} />,
    );
    const el = thread();
    makeScrollable(el);
    readerScrollsTo(el, 120); // parked mid-thread, reading

    // Same messages, brand-new array identity — exactly what a feed tick produces.
    rerender(
      <ConciergeThread messages={[...first]} onNudgeClick={noop} onNudgeAction={noop} />,
    );

    expect(el.scrollTop).toBe(120);
  });

  it("does not move when only the typing indicator toggles while the reader is scrolled up", () => {
    const list = msgs(3);
    const { rerender } = render(
      <ConciergeThread messages={list} onNudgeClick={noop} onNudgeAction={noop} />,
    );
    const el = thread();
    makeScrollable(el);
    readerScrollsTo(el, 40);

    rerender(
      <ConciergeThread messages={list} typing onNudgeClick={noop} onNudgeAction={noop} />,
    );

    expect(el.scrollTop).toBe(40);
  });

  // The mount case. A thread that opens with content sits at scrollTop 0 against a full
  // scrollHeight, so a post-layout distance check judged the reader "scrolled up" — on the very
  // first paint, before they had done anything — and never followed again for the rest of the
  // session. Follow-state starts true instead.
  it("follows on first paint, when the thread opens with a backlog", () => {
    const { rerender } = render(
      <ConciergeThread messages={msgs(20)} onNudgeClick={noop} onNudgeAction={noop} />,
    );
    const el = thread();
    makeScrollable(el); // 1000px of backlog in a 200px viewport, parked at scrollTop 0

    // A feed tick appends one more message. The reader has not scrolled at all, so the column must
    // still be following — under the old post-layout check it never would again.
    rerender(<ConciergeThread messages={msgs(21)} onNudgeClick={noop} onNudgeAction={noop} />);

    expect(el.scrollTop).toBe(el.scrollHeight);
  });

  // The brain streams by UPSERTING the same bubble with more text: message count and last id both
  // stay fixed while the reply grows below the fold. Keyed only on those, the thread stopped
  // following mid-answer — and by the time `typing` flipped off, the accumulated reply had pushed
  // the reader far enough that the catch-up scroll was suppressed too.
  it("follows a reply that grows in place while it streams", () => {
    const growing = (text: string): ConciergeMessage[] => [
      ...msgs(2),
      { id: "brain-1", kind: "sparkle" as const, text },
    ];
    const { rerender } = render(
      <ConciergeThread messages={growing("Look")} onNudgeClick={noop} onNudgeAction={noop} />,
    );
    const el = thread();
    makeScrollable(el);
    readerScrollsTo(el, 800); // pinned to the bottom, watching it type

    el.scrollTop = 0; // the browser has NOT scrolled for us; the new text is below the fold
    rerender(
      <ConciergeThread messages={growing("Looking at it now")} onNudgeClick={noop} onNudgeAction={noop} />,
    );

    expect(el.scrollTop).toBe(el.scrollHeight);
  });

  // The shape the column actually lives in: nudges are appended AFTER the chat, so the streaming
  // bubble is not the last message. Keyed on the last message's length, the growing reply was
  // invisible to the effect and the mid-answer stall persisted whenever any agent was surfaced.
  it("follows a streaming reply even when nudges sit below it", () => {
    const nudge = {
      id: "n1",
      kind: "nudge" as const,
      band: "needs_you" as const,
      projectName: "sparkle",
      agentName: "Some Agent",
      text: "static nudge text",
      actions: [],
    };
    const withReply = (text: string): ConciergeMessage[] => [
      ...msgs(2),
      { id: "brain-1", kind: "sparkle" as const, text },
      nudge,
    ];

    const { rerender } = render(
      <ConciergeThread messages={withReply("Look")} onNudgeClick={noop} onNudgeAction={noop} />,
    );
    const el = thread();
    makeScrollable(el);
    readerScrollsTo(el, 800); // pinned to the bottom

    el.scrollTop = 0; // the new text is below the fold; the browser hasn't scrolled for us
    rerender(
      <ConciergeThread
        messages={withReply("Looking at it now")}
        onNudgeClick={noop}
        onNudgeAction={noop}
      />,
    );

    expect(el.scrollTop).toBe(el.scrollHeight);
  });

  // The browser fires `scroll` when the viewport shrinks, with scrollTop unchanged. Reading that as
  // "the reader scrolled away" would stop the follow for something the reader never did.
  it("keeps following when a resize grows the distance without the reader moving", () => {
    const { rerender } = render(
      <ConciergeThread messages={msgs(3)} onNudgeClick={noop} onNudgeAction={noop} />,
    );
    const el = thread();
    makeScrollable(el);
    readerScrollsTo(el, 800); // at the bottom

    // The column gets shorter: same scrollTop, but now far from the bottom.
    Object.defineProperty(el, "clientHeight", { value: 100, configurable: true });
    Object.defineProperty(el, "scrollHeight", { value: 1400, configurable: true });
    fireEvent.scroll(el);

    rerender(<ConciergeThread messages={msgs(4)} onNudgeClick={noop} onNudgeAction={noop} />);
    expect(el.scrollTop).toBe(1400);
  });

  // The threshold is the only knob deciding "is this reader following?", so both sides of it are
  // pinned. Inside the slack is rounding (rubber-band settling, fractional zoom heights); outside
  // it is a deliberate scroll away.
  it("treats a few pixels off the bottom as still following, and a real scroll-up as not", () => {
    const { rerender } = render(
      <ConciergeThread messages={msgs(3)} onNudgeClick={noop} onNudgeAction={noop} />,
    );
    const el = thread();
    makeScrollable(el); // bottom is scrollTop 800

    readerScrollsTo(el, 796); // 4px off — rounding, not intent
    rerender(<ConciergeThread messages={msgs(4)} onNudgeClick={noop} onNudgeAction={noop} />);
    expect(el.scrollTop).toBe(el.scrollHeight);

    readerScrollsTo(el, 760); // 40px up — the reader meant it
    rerender(<ConciergeThread messages={msgs(5)} onNudgeClick={noop} onNudgeAction={noop} />);
    expect(el.scrollTop).toBe(760);
  });

  // The gate is asymmetric ON PURPOSE: reaching the bottom re-arms whatever caused it, while only a
  // scroll that MOVED can demote. Pinned so the asymmetry reads as a decision, not an oversight.
  it("re-arms the follow when anything puts the reader back at the bottom", () => {
    const { rerender } = render(
      <ConciergeThread messages={msgs(3)} onNudgeClick={noop} onNudgeAction={noop} />,
    );
    const el = thread();
    makeScrollable(el);
    readerScrollsTo(el, 200); // scrolled away: not following
    rerender(<ConciergeThread messages={msgs(4)} onNudgeClick={noop} onNudgeAction={noop} />);
    expect(el.scrollTop).toBe(200);

    readerScrollsTo(el, 800); // back at the bottom
    rerender(<ConciergeThread messages={msgs(5)} onNudgeClick={noop} onNudgeAction={noop} />);
    expect(el.scrollTop).toBe(el.scrollHeight);
  });

  // A scroll event that moves nothing is not the reader scrolling away: horizontal scrolls,
  // scroll-anchoring adjustments that net zero, and synthetic events all arrive that way. Reaching
  // the demote branch at all needs follow ARMED and the reader NOT at the bottom, which only a
  // geometry change can produce without a scroll — hence the two-step.
  it("ignores a scroll event that moved nothing", () => {
    const { rerender } = render(
      <ConciergeThread messages={msgs(3)} onNudgeClick={noop} onNudgeAction={noop} />,
    );
    const el = thread();
    makeScrollable(el);
    readerScrollsTo(el, 800); // at the bottom, following

    // The content grows: same scrollTop, but now 1000px from the bottom. A re-fit, not a reader.
    makeScrollable(el, 2000, 200);
    fireEvent.scroll(el);

    // NOW the no-op event: follow is still armed, the reader is nowhere near the bottom, and
    // nothing moved or changed. This is the branch under test.
    fireEvent.scroll(el);

    rerender(<ConciergeThread messages={msgs(4)} onNudgeClick={noop} onNudgeAction={noop} />);
    expect(el.scrollTop).toBe(el.scrollHeight);
  });

  // The discriminating case for the clamp guard: the reader scrolls away AFTER the column has
  // grown. Growth is the normal state while a reply streams, so a guard that treats "geometry
  // differs" as a clamp swallows this gesture and yanks the reader back on the next delta — the
  // founder's original complaint, restored.
  it("demotes on a real scroll-up even when the column just grew", () => {
    const { rerender } = render(
      <ConciergeThread messages={msgs(3)} onNudgeClick={noop} onNudgeAction={noop} />,
    );
    const el = thread();
    makeScrollable(el);
    readerScrollsTo(el, 800); // at the bottom, following

    makeScrollable(el, 2000, 200); // the reply streamed in: the column GREW
    readerScrollsTo(el, 400); // and now the reader deliberately scrolls up

    rerender(<ConciergeThread messages={msgs(4)} onNudgeClick={noop} onNudgeAction={noop} />);
    expect(el.scrollTop).toBe(400);
  });

  // The other re-fit shape: content removed below the fold. The browser clamps scrollTop to the new
  // maximum — which is the bottom — so the follow re-arms on `atBottom` without needing a guard.
  it("keeps following when content is removed and the browser clamps to the new bottom", () => {
    const { rerender } = render(
      <ConciergeThread messages={msgs(3)} onNudgeClick={noop} onNudgeAction={noop} />,
    );
    const el = thread();
    makeScrollable(el, 2000, 200);
    readerScrollsTo(el, 1800); // at the bottom of the tall version

    makeScrollable(el, 900, 200);
    readerScrollsTo(el, 700); // clamped to the new maximum

    rerender(<ConciergeThread messages={msgs(4)} onNudgeClick={noop} onNudgeAction={noop} />);
    expect(el.scrollTop).toBe(el.scrollHeight);
  });

  // THE USER'S OWN SUBMIT. Every other case here is about protecting a reader from content they did
  // not ask for; a message THEY sent is the opposite — it is an unambiguous "show me what happens
  // next", and the founder reported it not happening ("when I submit a chat it doesn't scroll me
  // down to the bottom of the thread"). Follow, once disarmed, was disarmed for good until the
  // reader personally scrolled back to the bottom — and a trackpad flick that settles 30px short of
  // the bottom disarms it silently, so this is the normal state of a column that has been read.
  it("scrolls to the bottom on the user's own submit, even after they scrolled up", () => {
    const { rerender } = render(
      <ConciergeThread messages={msgs(3)} onNudgeClick={noop} onNudgeAction={noop} />,
    );
    const el = thread();
    makeScrollable(el);
    readerScrollsTo(el, 400);
    readerScrollsTo(el, 0); // reading the top of the thread: follow is off

    // A sparkle reply must still leave them alone — that is the behaviour this must not break.
    rerender(<ConciergeThread messages={msgs(4)} onNudgeClick={noop} onNudgeAction={noop} />);
    expect(el.scrollTop).toBe(0);

    // Now THEY send. The host appends a `you` bubble in the same tick the send leaves.
    rerender(
      <ConciergeThread
        messages={[...msgs(4), { id: "you-1", kind: "you", text: "what's blocking the PR?" }]}
        onNudgeClick={noop}
        onNudgeAction={noop}
      />,
    );
    expect(el.scrollTop).toBe(el.scrollHeight);
  });

  // The re-arm has to be keyed on a NEW user message, not on the presence of one. ConciergeHost
  // hands this component a fresh array on every feed tick, and a thread the user has ever typed in
  // contains a `you` bubble forever — so a re-arm that fired on "there is a you message" would slam
  // a reading user to the bottom several times a second, which is bead sparkle-y4ft all over again.
  it("does not re-arm on a feed tick that repeats the same user message", () => {
    const sent: ConciergeMessage[] = [
      ...msgs(2),
      { id: "you-1", kind: "you", text: "what's blocking the PR?" },
    ];
    const { rerender } = render(
      <ConciergeThread messages={sent} onNudgeClick={noop} onNudgeAction={noop} />,
    );
    const el = thread();
    makeScrollable(el);
    readerScrollsTo(el, 400);
    readerScrollsTo(el, 120); // parked mid-thread, reading

    rerender(
      <ConciergeThread messages={[...sent]} onNudgeClick={noop} onNudgeAction={noop} />,
    );
    expect(el.scrollTop).toBe(120);

    // And a reply to that message is still content they did not ask to be shown.
    rerender(
      <ConciergeThread
        messages={[...sent, { id: "b1", kind: "sparkle", text: "checks are red" }]}
        onNudgeClick={noop}
        onNudgeAction={noop}
      />,
    );
    expect(el.scrollTop).toBe(120);
  });

  // The shape the column actually lives in: nudges are appended AFTER the chat, so the message the
  // user just sent is not the last one in the array. A re-arm that only looked at `messages.at(-1)`
  // would miss every submit made while any agent is surfaced — which is most of them.
  it("re-arms on a submit even when nudges sit below the new bubble", () => {
    const nudge = {
      id: "n1",
      kind: "nudge" as const,
      band: "needs_you" as const,
      projectName: "sparkle",
      agentName: "Some Agent",
      text: "static nudge text",
      actions: [],
    };
    const { rerender } = render(
      <ConciergeThread messages={[...msgs(2), nudge]} onNudgeClick={noop} onNudgeAction={noop} />,
    );
    const el = thread();
    makeScrollable(el);
    readerScrollsTo(el, 400);
    readerScrollsTo(el, 0);

    rerender(
      <ConciergeThread
        messages={[...msgs(2), { id: "you-1", kind: "you", text: "ship it" }, nudge]}
        onNudgeClick={noop}
        onNudgeAction={noop}
      />,
    );
    expect(el.scrollTop).toBe(el.scrollHeight);
  });

  // A single NudgeCard (badge + text + up to three buttons) can be taller than the slack. Measured
  // after layout, that one message was enough to decide the reader had scrolled away.
  it("keeps following when one appended message is taller than the follow threshold", () => {
    const { rerender } = render(
      <ConciergeThread messages={msgs(3)} onNudgeClick={noop} onNudgeAction={noop} />,
    );
    const el = thread();
    makeScrollable(el);
    readerScrollsTo(el, 800); // at the bottom

    // The new child is 400px tall — well past FOLLOW_THRESHOLD_PX — so a post-layout distance
    // check would read 400 and bail.
    Object.defineProperty(el, "scrollHeight", { value: 1400, configurable: true });
    rerender(<ConciergeThread messages={msgs(4)} onNudgeClick={noop} onNudgeAction={noop} />);

    expect(el.scrollTop).toBe(1400);
  });
});
