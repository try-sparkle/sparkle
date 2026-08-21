// @vitest-environment jsdom
//
// `releaseFollow` — the escape hatch a DELIBERATE jump needs (bead sparkle-1wqls, a pre-existing
// bug on main found by roborev 57412 and re-found while building the scrubber rail, sparkle-7m719).
//
// THE SHAPE OF THE BUG THESE TESTS PIN. A programmatic jump scrolls with `behavior: "smooth"`, so
// the browser dispatches its scroll event asynchronously, several eased frames later. Until one of
// those frames carries the position more than FOLLOW_THRESHOLD_PX (24) from the bottom, `followRef`
// is still armed — and any `contentKey` change in that window runs the follow effect, which writes
// `scrollTop = scrollHeight` and cancels the jump. `contentKey` folds in total text length, so a
// streaming reply changes it once per token.
//
// WHY THIS IS TESTED ON THE HOOK AND NOT THROUGH ConciergeThread. `ConciergeThread.anchors.test.tsx`
// stubs `scrollIntoView` and asserts only that it was CALLED — so a follow that immediately undoes
// the jump is invisible to it. That is precisely the vacuous shape AGENTS.md warns about: the
// assertion is true whether or not the thing works. Driving the hook directly lets the assertion be
// on the SIDE EFFECT that matters — where scrollTop actually ended up.
//
// jsdom lays nothing out (every element reports scrollHeight/clientHeight 0), so the geometry is
// installed by hand, exactly as ConciergeThread.autofollow.test.tsx does it.
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoFollow } from "./useAutoFollow";

afterEach(() => cleanup());

const SCROLL_HEIGHT = 1000;
const CLIENT_HEIGHT = 200;
/** The scrollTop of a container that is genuinely at the bottom. */
const BOTTOM = SCROLL_HEIGHT - CLIENT_HEIGHT;

/** A minimal scroller driven by the real hook — the production code path, with nothing stubbed. */
function Harness({ contentKey, rearmKey = "r" }: { contentKey: string; rearmKey?: string }) {
  const { scrollRef, onScroll, releaseFollow } = useAutoFollow({ contentKey, rearmKey });
  return (
    <div ref={scrollRef} data-testid="scroller" onScroll={onScroll}>
      <button data-testid="release" onClick={releaseFollow}>
        release
      </button>
      {contentKey}
    </div>
  );
}

function mount(contentKey: string, rearmKey?: string) {
  const view = render(<Harness contentKey={contentKey} rearmKey={rearmKey} />);
  const el = view.getByTestId("scroller");
  Object.defineProperty(el, "scrollHeight", { value: SCROLL_HEIGHT, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: CLIENT_HEIGHT, configurable: true });
  return { view, el };
}

/** What a smooth jump looks like at the instant it starts: scrollTop has been set toward the target,
 *  but the browser has NOT yet dispatched a scroll event. That gap is the entire bug. */
function jumpStartsTo(el: HTMLElement, top: number): void {
  el.scrollTop = top;
}

describe("releaseFollow", () => {
  // THE PRECONDITION, asserted so the two tests below cannot both pass vacuously. If new content did
  // not scroll the reader in the first place there would be nothing for `releaseFollow` to prevent,
  // and a green "it did not scroll" would prove nothing at all.
  it("WITHOUT it, a contentKey change during a jump slams the reader back to the bottom", () => {
    const { view, el } = mount("k1");
    jumpStartsTo(el, 120);

    // A streaming reply arrives mid-animation: the content key changes, the follow is still armed.
    view.rerender(<Harness contentKey="k2" />);

    expect(el.scrollTop).toBe(SCROLL_HEIGHT);
  });

  it("disarms the follow so a contentKey change during a jump leaves the reader where they jumped", () => {
    const { view, el } = mount("k1");
    fireEvent.click(view.getByTestId("release"));
    jumpStartsTo(el, 120);

    view.rerender(<Harness contentKey="k2" />);

    expect(el.scrollTop).toBe(120);
  });

  // Not a one-way door #1: the ordinary re-arm still works, or a reader who jumps once would never
  // follow a live reply again for the rest of the session.
  it("re-arms when the reader scrolls back to the bottom", () => {
    const { view, el } = mount("k1");
    fireEvent.click(view.getByTestId("release"));

    el.scrollTop = BOTTOM;
    fireEvent.scroll(el);

    view.rerender(<Harness contentKey="k2" />);
    expect(el.scrollTop).toBe(SCROLL_HEIGHT);
  });

  // Not a one-way door #2: the reader's own submit means "show me what happens next".
  it("re-arms on the reader's own submit even from a scrolled-up position", () => {
    const { view, el } = mount("k1", "sent-1");
    fireEvent.click(view.getByTestId("release"));
    jumpStartsTo(el, 120);

    view.rerender(<Harness contentKey="k2" rearmKey="sent-2" />);

    expect(el.scrollTop).toBe(SCROLL_HEIGHT);
  });

  // WHAT IS DELIBERATELY *NOT* HERE. An earlier draft of `releaseFollow` also resynced the hook's
  // last-position baseline, and this file carried a test claiming that stopped an eased frame from
  // silently re-arming the follow. `mutation-check --line 242,244` flagged it: line 244 could be
  // blanked with every test still green. That is cause #4 in its output — an INERT SOURCE LINE, one
  // no assertion can catch because it cannot change any outcome. Reading `onScroll` back confirms
  // it: `atBottom` re-arms unconditionally and is the ONLY writer of `true`, so the baseline cannot
  // influence the follow state in any branch. The line was deleted rather than covered, and the
  // claim with it. Left as a comment so the next reader does not "restore" it.
});
