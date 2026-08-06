// @vitest-environment jsdom
//
// THE CARD IS A DISCLOSURE, NOT A SCROLLER (bead `sparkle-o37mn`).
//
// The founder saw the recap render as a box roughly one line tall whose internal scrollbar was
// useless, and asked for the opposite shape: first line + `…`, a chevron that says "this opens",
// and a FIXED expanded height that scrolls only once it is full.
//
// ── WHAT THESE TESTS ARE GUARDING AGAINST, STATED SO THEY CANNOT GO VACUOUS ──────────────────────
// Two separate defects live on this card and only one of them is the founder's design ask:
//
//   1. THE COLLAPSE BUG. `overflow-y: auto` makes this card a scroll container, and per Flexbox
//      §4.5 a scroll container's automatic minimum size is ZERO while every non-scrolling sibling
//      in the thread stays at its content height. So the card became the only item the transcript
//      could shrink and collapsed toward 0px. `flexShrink: 0` is the fix, and it is load-bearing in
//      EVERY state that sets `overflow-y` — which is why it is asserted twice below rather than
//      once. Deleting it reproduces the exact bug this bead reported.
//
//   2. THE DISCLOSURE ITSELF. Collapsed renders no rows; expanded renders them and bounds itself at
//      the bead card's `DESC_MAX_H` instead of a viewport fraction.
//
// Every assertion below is on a SIDE EFFECT — rows appearing, a style declaration changing — never
// on a precondition that was already true before the change. jsdom does not lay out, so height is
// asserted as the DECLARATION (`style.maxHeight`), never as a measured rect; a `getBoundingClientRect`
// assertion here would read 0 and prove nothing (docs/jsdom-test-caveats.md).
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RecapCard } from "./RecapCard";
import { DESC_MAX_H } from "./BeadPill";
import type { ConciergeRecapMessage } from "../../services/conciergeRecap";

afterEach(() => cleanup());

const change = (over: Partial<ConciergeRecapMessage["needsYou"][number]> = {}) => ({
  agentId: "a",
  agentName: "Kraken Auth",
  projectName: "sparkle",
  status: "waiting" as const,
  statusLabel: "Needs you",
  ...over,
});

const recap = (over: Partial<ConciergeRecapMessage> = {}): ConciergeRecapMessage => ({
  id: "recap-1",
  kind: "recap",
  awayMs: 12 * 60_000,
  needsYou: [],
  finished: [],
  decisions: [],
  ...over,
});

/** A recap whose every row is SETTLED (`status: "done"`, finished and landed), so the
 *  never-hide-an-actionable-row rule does not force it open. This is the only shape that is
 *  allowed to default to collapsed. */
const settledRecap = () =>
  recap({
    finished: [
      change({ agentId: "b", agentName: "OG Images", status: "done", statusLabel: "Done" }),
    ],
  });

const card = () => screen.getByTestId("concierge-recap");
const toggle = () => screen.getByTestId("recap-disclosure");

describe("RecapCard disclosure", () => {
  it("collapses a settled recap to its summary line, with no rows rendered", () => {
    render(<RecapCard recap={settledRecap()} />);
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    // The SIDE EFFECT: the rows are genuinely not in the DOM, not merely short.
    expect(screen.queryAllByTestId("recap-change")).toHaveLength(0);
    // The summary survives collapse — the count is what the reader keeps.
    expect(screen.getByTestId("recap-summary").textContent).toContain("While you were away");
  });

  it("clips the collapsed summary to ONE line so the `…` can appear", () => {
    render(<RecapCard recap={settledRecap()} />);
    const summary = screen.getByTestId("recap-summary");
    expect(summary.style.whiteSpace).toBe("nowrap");
    expect(summary.style.overflow).toBe("hidden");
    expect(summary.style.textOverflow).toBe("ellipsis");
  });

  it("reveals the rows on click, and says so to a screen reader", () => {
    render(<RecapCard recap={settledRecap()} />);
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByTestId("recap-change")).toHaveLength(1);
  });

  it("stops clipping the summary once expanded", () => {
    render(<RecapCard recap={settledRecap()} />);
    fireEvent.click(toggle());
    expect(screen.getByTestId("recap-summary").style.whiteSpace).not.toBe("nowrap");
  });

  it("bounds the EXPANDED card at the bead card's height and scrolls there", () => {
    render(<RecapCard recap={settledRecap()} />);
    fireEvent.click(toggle());
    // Bound to the imported constant, never the literal 180 — a second literal is a second thing
    // that can drift away from the bead card this height is supposed to match.
    expect(card().style.maxHeight).toBe(`${DESC_MAX_H}px`);
    expect(card().style.overflowY).toBe("auto");
  });

  it("does NOT scroll while collapsed — one line has nothing to scroll", () => {
    render(<RecapCard recap={settledRecap()} />);
    expect(card().style.overflowY).not.toBe("auto");
  });

  it("toggles back closed", () => {
    render(<RecapCard recap={settledRecap()} />);
    fireEvent.click(toggle());
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryAllByTestId("recap-change")).toHaveLength(0);
  });

  // ── THE FOUNDER'S STANDING RULE OUTRANKS THE DEFAULT ───────────────────────────────────────────
  // "We should never hide a row that needs action from me." A collapsed card hides every row behind
  // a click, so a recap carrying an actionable row may not start collapsed. `waiting` (Wants you),
  // `idle` ("Done — your turn") and `unmerged` ("Needs merge") all ask the reader for something;
  // only `done` is settled.
  it("starts EXPANDED when an agent wants you", () => {
    render(<RecapCard recap={recap({ needsYou: [change()] })} />);
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByTestId("recap-change")).toHaveLength(1);
  });

  it.each([
    ["idle", "Done — your turn"],
    ["unmerged", "Needs merge"],
  ])("starts EXPANDED when a finished row is actionable (%s)", (status, label) => {
    render(
      <RecapCard
        recap={recap({
          finished: [change({ agentId: "c", status: status as never, statusLabel: label })],
        })}
      />,
    );
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
  });

  // ── REGRESSION PIN FOR THE BUG THE BEAD ACTUALLY REPORTED ──────────────────────────────────────
  // Nothing else in the suite guards this, and it is invisible in jsdom (no layout) — so it can
  // only be caught as a declaration. See the header for why zero-minimum-size collapses the card.
  it("keeps flexShrink:0 in BOTH states, so the thread can never shrink this card to one line", () => {
    render(<RecapCard recap={settledRecap()} />);
    expect(card().style.flexShrink).toBe("0");
    fireEvent.click(toggle());
    expect(card().style.flexShrink).toBe("0");
  });
});
