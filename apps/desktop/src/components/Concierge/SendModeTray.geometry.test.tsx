// @vitest-environment jsdom
//
// THE TRAY'S VERTICAL GEOMETRY AND THE CENTRING OF ITS LABELS — the founder's three asks, pinned.
//
// He has raised this tray's geometry three times. The two earlier attempts moved numbers around and
// left him unsatisfied, which is why the assertions here are about MECHANISM rather than about the
// numbers those attempts kept re-tuning:
//
//   1. "The tray should be the same height as the button. There shouldn't be space below the
//      button." — and, stated twice and in this direction specifically, fixed by making the BUTTONS
//      taller, not the tray shorter: "let's just make the buttons taller inside the container and
//      keep the container about the same size."
//   2. "Maybe let's call it 10 pixels above and 10 pixels below the word."
//   3. "Let's make it so that the word is centered in the button, and then … the keyboard shortcut
//      chiclet shows on the right side of the button. So it's justified right, and it only shows on
//      hover. So it's got some distance between the word and the keyboard shortcut chiclet."
//
// ── WHAT jsdom CAN AND CANNOT PROVE HERE, AND WHY THAT SHAPES EVERY ROW BELOW ──────────────────
// jsdom has no layout engine: `getBoundingClientRect()` is 0 on every node, so "the tray is exactly
// as tall as its buttons" and "the label's centre did not move" are NOT measurable here, and a test
// that appeared to measure them would read 0 === 0 and pass against any code at all. That is this
// repo's single most-reported test defect (see docs/jsdom-test-caveats.md, and trayGeometry's own
// three-times-wrong header), so the rows below assert the two things that ARE decidable without
// layout, and which together entail the founder's asks:
//
//   • THE STRUCTURE that makes each property hold — no element declaring a height, so nothing can be
//     taller than its content; the keycap out of flow, so nothing it does can move a sibling.
//   • THE ARITHMETIC, against the exported derivation rather than a copy of it re-typed here.
//
// The one thing deliberately NOT asserted is a rendered pixel height. That number depends on the
// font's line box, which jsdom does not compute and which no assertion here could honestly claim.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SendModeTray, type SendModeTrayProps } from "./SendModeTray";
import {
  TRAY_GEOMETRY,
  chicletClearancePx,
  fullLabelsFitAtPx,
  wordToKeycapGapPx,
} from "./trayGeometry";
import { TRAY_SHORT_LABEL_MAX_PX, SEND_MODES, type SendMode } from "../../voice/sendMode";
import { SPACE } from "../../theme/scale";

afterEach(cleanup);

function mount(over: Partial<SendModeTrayProps> = {}) {
  render(
    <SendModeTray
      mode="send"
      onModeChange={vi.fn()}
      onSend={vi.fn()}
      canSend
      chord="cmd-enter"
      {...over}
    />,
  );
}

const tray = () => screen.getByTestId("send-mode-tray");
const pill = (m: SendMode) =>
  tray().querySelector<HTMLElement>(`[data-mode-pill="${m}"]`)!;
const labelOf = (m: SendMode) => screen.getByTestId(`send-mode-label-${m}`);
/** The keycap box. Its testid is withheld at rest, so reach it by position — it is the last child. */
const keycap = (m: SendMode) => pill(m).lastElementChild as HTMLElement;

/** The children that PARTICIPATE IN LAYOUT — i.e. everything the centring of the label depends on.
 *  An absolutely-positioned child is not one of them, which is the whole point of the change. */
const inFlowChildren = (el: HTMLElement) =>
  Array.from(el.children).filter((c) => (c as HTMLElement).style.position !== "absolute");

describe("ask 1+2 — the tray is as tall as its buttons, and the buttons carry the padding", () => {
  it("gives the word ~10px above and below, from a scale token rather than a literal", () => {
    // The founder's number, and it is a token: `SPACE.nav` is the approved spec's `--sp-navitem`
    // padding (10px), which the scale had measured but never named until the tray needed it.
    expect(SPACE.nav).toBe(10);
    expect(TRAY_GEOMETRY.pillPadY).toBe(SPACE.nav);

    mount();
    for (const m of SEND_MODES) {
      expect(pill(m).style.paddingTop, `${m} pads above the word`).toBe(`${SPACE.nav}px`);
      expect(pill(m).style.paddingBottom, `${m} pads below the word`).toBe(`${SPACE.nav}px`);
    }
  });

  it("lets NOTHING declare a height — the only way there can be no space below the button", () => {
    // ── THE ACTUAL BUG, AND WHY THIS IS AN ABSENCE ────────────────────────────────────────────
    // The tray asked for `minHeight: 42` while the pills asked for `height: "100%"`. Two independent
    // claims about one measurement, and they disagreed — a percentage height against an AUTO-height
    // flex parent is not a stretch instruction, so the pills sized to their content while the tray
    // held itself open at 42. The leftover was the dead band the founder has now reported three
    // times.
    //
    // Asserting an absence is the honest form here. Any positive height assertion would have to name
    // a pixel value, and a pixel value is exactly what the two previous attempts kept re-tuning; it
    // would also be unverifiable, since the real height depends on a font line box jsdom never
    // computes. What IS decidable is that no element is holding a size open — and a flex container
    // whose height is auto is, by construction, the height of its content. Take that away and the
    // dead space can come back at any font size; keep it and it cannot come back at any.
    mount();
    expect(tray().style.height, "the tray must not state a height").toBe("");
    expect(tray().style.minHeight, "nor a minimum — that IS the dead space").toBe("");
    for (const m of SEND_MODES) {
      expect(pill(m).style.height, `${m} must not state a height either`).toBe("");
    }
    // And the pills level to one another rather than each sizing alone, so a wrapped row stays even.
    expect(tray().style.alignItems).toBe("stretch");
  });
});

describe("ask 3 — the WORD is centred; the keycap is justified right and hover-only", () => {
  it("centres the label ALONE — the keycap contributes nothing to the flow", () => {
    // The founder's own diagnosis: "I think you probably have it so that the words and the keyboard
    // shortcut chiclet is what is centering." Centring the pair puts the word left of centre by half
    // the keycap, and at rest — no hover, no keycap — the word is the only thing on the pill.
    mount();
    for (const m of SEND_MODES) {
      expect(pill(m).style.justifyContent).toBe("center");
      const flow = inFlowChildren(pill(m));
      expect(flow, `${m}: the label must be the only thing being centred`).toHaveLength(1);
      expect(flow[0]).toBe(labelOf(m));
    }
  });

  it("justifies the keycap RIGHT, inset by the pill's own padding", () => {
    mount();
    const cap = keycap("send");
    expect(cap.style.position, "out of flow, or it would shove the label").toBe("absolute");
    // ── THE PILL IS THE CONTAINING BLOCK, AND THAT IS NOT INCIDENTAL ────────────────────────────
    // `right` below is measured from the nearest POSITIONED ancestor's padding box. The tray root is
    // itself `position: relative` (it has to be — the countdown sweep is absolute within it), so if
    // the pill ever loses this declaration the keycap does not fall out of the layout in some
    // obvious way: it silently re-anchors to the TRAY, and all three keycaps stack at the tray's
    // right-hand edge on top of the Speak pill. Every other assertion in this file survives that
    // (still `absolute`, still `right: 8px`, still one in-flow child), which is exactly why the
    // precondition has to be asserted rather than assumed.
    for (const m of SEND_MODES) {
      expect(pill(m).style.position, `${m}: the keycap's inset is measured from THIS box`).toBe(
        "relative",
      );
    }
    expect(cap.style.right, "on the same right margin the label answers to").toBe(
      `${TRAY_GEOMETRY.pillPadX}px`,
    );
    expect(cap.style.justifyContent, "the pill sits at the far right of its slot").toBe("flex-end");
    // It overlays the button now, so it must not eat the pointer — a keycap that swallowed a
    // mouseleave would flicker the very hover state that summoned it.
    expect(cap.style.pointerEvents).toBe("none");
  });

  it("shows the keycap ONLY on hover (and on keyboard focus, for the user with no pointer)", () => {
    mount();
    expect(keycap("send").style.opacity, "nothing at rest").toBe("0");
    fireEvent.mouseEnter(pill("send"));
    expect(keycap("send").style.opacity).toBe("1");
    fireEvent.mouseLeave(pill("send"));
    expect(keycap("send").style.opacity).toBe("0");
    // A hover-only affordance is invisible to exactly the user who wants a keyboard shortcut.
    fireEvent.focus(pill("send"));
    expect(keycap("send").style.opacity).toBe("1");
    fireEvent.blur(pill("send"));
    expect(keycap("send").style.opacity).toBe("0");
  });

  // ── THE HARD PART, AND THE ROW MOST WORTH KEEPING ─────────────────────────────────────────────
  it("does not move the label between rest and hover", () => {
    // "A layout where hovering nudges the label is worse than what he has now." The keycap reveal
    // must change the label's box in NO respect.
    //
    // Note the second half of this test: it asserts the hover actually DID something. Without that,
    // "nothing moved" would also pass if the hover never registered, if the keycap were never
    // rendered, or if `mouseEnter` targeted the wrong node — the classic vacuous shape where the
    // assertion was already true before the change. Proving the reveal happened is what makes the
    // no-shift claim mean anything.
    mount();
    const label = labelOf("send");

    const boxAtRest = label.getAttribute("style");
    const flowAtRest = inFlowChildren(pill("send")).length;

    fireEvent.mouseEnter(pill("send"));

    expect(keycap("send").style.opacity, "the reveal must really have happened").toBe("1");
    expect(
      label.getAttribute("style"),
      "every declaration on the label's box is identical under hover",
    ).toBe(boxAtRest);
    expect(
      inFlowChildren(pill("send")).length,
      "and the hover added nothing to the flow the label is centred in",
    ).toBe(flowAtRest);
    // The label element itself must survive the hover — a remount would reset scroll/selection and
    // would also make the style comparison above compare a node with its replacement.
    expect(labelOf("send"), "same node, restyled — not a new one").toBe(label);
  });

  it("caps the label so a centred word cannot grow underneath the keycap", () => {
    // The keycap is out of flow, so nothing in the LAYOUT stops the label reaching it. This does.
    // Symmetric, because a symmetric cap is the only kind that does not move a centred box.
    mount();
    expect(labelOf("send").style.maxWidth).toBe(`calc(100% - ${2 * chicletClearancePx}px)`);
  });

  // ── AND THE CAP IS GATED ON THE TIER THAT DRAWS A KEYCAP ──────────────────────────────────────
  it("spends the clearance ONLY where a keycap exists — no cap at all one pixel lower", () => {
    // WHY THIS ROW EXISTS. The cap costs the label `2 * chicletClearancePx` = 72px, which is exactly
    // the width of the widest word. That is affordable in the `full` tier and NOWHERE else: at the
    // bottom of `fullTight` a pill's content box is 72px, so an ungated cap resolves to
    // `calc(100% - 72px)` ≈ 0 and the three words vanish entirely — one step worse than the "Se…"
    // this whole ladder exists to delete.
    //
    // Nothing else can catch that. The tier rows in ./SendModeTray.test.tsx assert `textContent`,
    // which a zero-width box does not change, and every other row in THIS file renders at
    // `trayWidth === 0` (the unmeasured first paint, which takes the `full` tier), so the gate is
    // never exercised. Dropping the ternary in the component would be an invisible mutation.
    //
    // jsdom has no ResizeObserver, so the narrow branch is unreachable without this stub — the same
    // reason ./SendModeTray.test.tsx carries one. It measures nothing; it only lets the component's
    // own tier decision run.
    const realRO = globalThis.ResizeObserver;
    let fire: ((w: number) => void) | null = null;
    class StubRO {
      constructor(private cb: ResizeObserverCallback) {
        fire = (w: number) =>
          this.cb([{ contentRect: { width: w } } as ResizeObserverEntry], this as never);
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    globalThis.ResizeObserver = StubRO as unknown as typeof ResizeObserver;
    try {
      mount();
      const capped = `calc(100% - ${2 * chicletClearancePx}px)`;

      // At the threshold: a keycap is drawn, so the label pays for it.
      act(() => fire!(TRAY_SHORT_LABEL_MAX_PX));
      for (const m of SEND_MODES) {
        expect(labelOf(m).style.maxWidth, `${m} pays the clearance where a keycap exists`).toBe(
          capped,
        );
      }
      expect(keycap("send").style.width, "…and one is really there to pay for").toBe(
        `${TRAY_GEOMETRY.chicletSlot}px`,
      );

      // One pixel lower — `fullTight`, the tier that gives the keycap up. The words stay WHOLE, and
      // they only can because the cap goes with it.
      act(() => fire!(TRAY_SHORT_LABEL_MAX_PX - 1));
      for (const m of SEND_MODES) {
        expect(labelOf(m).style.maxWidth, `${m} pays nothing once the keycap is gone`).toBe("");
      }
      expect(labelOf("ptt").textContent, "and the whole word survives the drop").toBe(
        "Push to talk",
      );
    } finally {
      globalThis.ResizeObserver = realRO;
    }
  });
});

describe("the clearance the founder asked for, as arithmetic", () => {
  it("leaves a real gap between word and keycap at the narrowest width that draws one", () => {
    // "So it's got some distance between the word and the keyboard shortcut chiclet." At the bottom
    // of the tier that draws a keycap, that distance comes out to exactly one `pillGap` — the same
    // separation the keycap had when it was still an in-flow sibling.
    expect(wordToKeycapGapPx(fullLabelsFitAtPx())).toBeCloseTo(TRAY_GEOMETRY.pillGap, 10);
    // The shipped threshold is at or above the derivation, so every width that draws a keycap has at
    // least that much room. This is the guard that fails loudly if someone lowers the threshold.
    expect(TRAY_SHORT_LABEL_MAX_PX).toBeGreaterThanOrEqual(fullLabelsFitAtPx());
    expect(wordToKeycapGapPx(TRAY_SHORT_LABEL_MAX_PX)).toBeGreaterThanOrEqual(
      TRAY_GEOMETRY.pillGap,
    );
  });

  it("shows why the threshold had to move: at the OLD 440 the word ran under the keycap", () => {
    // Not a historical note — it is the evidence that the new bound is doing work. Centring the
    // label changed which inequality binds (a centred label must be given the keycap's clearance on
    // BOTH sides), so the threshold that was correct for a left-of-centre label is not correct for
    // this one. At 440 the widest label overlaps the keycap by ~3.5px: a word touching the chip it
    // is supposed to sit clear of, in the exact state the founder is looking at when he hovers.
    expect(wordToKeycapGapPx(440)).toBeLessThan(0);
  });
});
