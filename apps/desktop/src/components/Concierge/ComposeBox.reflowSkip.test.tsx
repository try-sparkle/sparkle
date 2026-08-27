// @vitest-environment jsdom
//
// The compose box measures its own height in a useLayoutEffect that runs on EVERY keystroke. The
// measurement COLLAPSES the textarea to `height:auto` and reads `scrollHeight`, which forces a
// synchronous layout reflow over the deeply nested concierge flex tree — a measured renderer wedge
// (bead sparkle-vkdca, the keystroke -> forced-layout path). A fast-path guard skips that reflow
// when nothing that could move the height changed: the typed text only grew, and a single naked
// `scrollHeight` read (no collapse, no reflow) still equals the last measured content height.
//
// jsdom has no layout, so `scrollHeight` is always 0 and must be stubbed. We stub it to stand in for
// real content AND to COUNT the reflow: a `scrollHeight` read taken while the textarea is collapsed
// to `height:auto` IS the forced-layout measurement the guard exists to skip. Counting those reads
// is the side effect under test — not the height arithmetic, which is covered DOM-free elsewhere.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposeBox } from "./ComposeBox";
import { useUiStore } from "../../stores/uiStore";

afterEach(() => cleanup());

// The one reflow-forcing measurement: a scrollHeight read while collapsed to height:auto.
let collapseReads = 0;
// Stand-in for laid-out content height; jsdom reports 0. The guard compares a naked read of this
// against the cached value, so changing it between keystrokes models the height moving.
let contentH = 0;

beforeEach(() => {
  collapseReads = 0;
  contentH = 0;
  Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      if (this.style.height === "auto") collapseReads++;
      return contentH;
    },
  });
  useUiStore.getState().setConciergeComposeH(null);
});

const box = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
const px = (v: string) => parseFloat(v);
const setup = () => render(<ComposeBox onSend={vi.fn()} onAttach={vi.fn()} />);

describe("ComposeBox — per-keystroke reflow skip", () => {
  it("does NOT force a layout reflow on a keystroke that cannot change the height", () => {
    contentH = 40;
    setup();
    // Leave the EMPTY state first: `text === ""` drives the rich-placeholder overlay, so the very
    // first keystroke legitimately changes a non-text input to the height and must measure. This
    // change caches the measurement with the placeholder hidden.
    fireEvent.change(box(), { target: { value: "a" } });
    collapseReads = 0; // measure only the pure within-content keystrokes that follow

    // Typing within the same content height: the box is still hugging the same content and no
    // non-text input moved, so the height cannot move. The guard proves this with a single naked
    // read and skips the collapse — no forced reflow.
    fireEvent.change(box(), { target: { value: "ab" } });
    expect(collapseReads).toBe(0);

    fireEvent.change(box(), { target: { value: "abc" } });
    expect(collapseReads).toBe(0);

    fireEvent.change(box(), { target: { value: "abcd" } });
    expect(collapseReads).toBe(0);
  });

  it("still measures — and grows the box — when the content height DOES change", () => {
    contentH = 40;
    setup();
    collapseReads = 0;
    const before = px(box().style.height);

    // A taller draft: the naked read no longer matches the cached height, so the guard falls through
    // to the full collapse-and-measure and the box grows. Proves the cache never freezes the box.
    contentH = 300;
    fireEvent.change(box(), { target: { value: "a\nb\nc\nd\ne\nf\ng" } });

    expect(collapseReads).toBeGreaterThan(0);
    expect(px(box().style.height)).toBeGreaterThan(before);
  });

  it("still measures — and shrinks the box — when text is DELETED", () => {
    contentH = 300;
    setup();
    fireEvent.change(box(), { target: { value: "a\nb\nc\nd\ne\nf" } });
    const tall = px(box().style.height);
    collapseReads = 0;

    // A naked read cannot see the box getting shorter (it clamps up), so the shrink guard forces the
    // full measurement whenever the text got shorter — here the line count dropped.
    contentH = 30;
    fireEvent.change(box(), { target: { value: "a" } });

    expect(collapseReads).toBeGreaterThan(0);
    expect(px(box().style.height)).toBeLessThan(tall);
  });
});
