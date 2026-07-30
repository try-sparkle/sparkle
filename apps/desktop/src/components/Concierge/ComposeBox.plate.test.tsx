// @vitest-environment jsdom
//
// THE PLATE THE COMPOSER SITS ON — `.cmp` in rev4.html.
//
// This box used to be a full-bleed strip filled with COMPOSE_SCRIM: a 16% BLACK wash over the
// concierge column. In light mode that scrim dropped `conciergeMuted` to 4.23 — under AA — on the
// one box in the app you type into, and EVERY control in the row is read on it (the attach
// buttons, the presence slider, the interim transcript, the textarea's own text).
//
// The approved direction does not scrim the composer at all: `.cmp` is an inset box sitting on
// `--k-input` with a rule around it. `theme/amberInk.test.ts` already models the plate that way
// (`composerPlate = THEME_HEX[t].inputSurface`), so until this landed the palette suite and the
// component disagreed about what the ink is read on — the exact failure mode amberInk.test.ts was
// rewritten to end. This file holds the COMPONENT half of that agreement, so the scrim cannot come
// back on the quiet.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ComposeBox } from "./ComposeBox";
import type { SendTrayModel } from "./SendModeTray";
import { C, COMPOSE_SCRIM } from "../../theme/colors";
import { BLUEPRINT } from "../../theme/blueprintSpec";
import { useUiStore } from "../../stores/uiStore";

// The wired surface is looked up as `BLUEPRINT[mode]`, so a test that only ever runs in one theme
// pins half a contract — and the half it pins is the one jsdom hands out for free (no `matchMedia`
// ⇒ `systemPrefersDark()` ⇒ dark). Every test here starts from an explicit preference, and the
// light-wired case below drives the other branch.
beforeEach(() => useUiStore.setState({ themePref: "dark" } as never));
afterEach(() => {
  useUiStore.setState({ themePref: "auto" } as never);
  cleanup();
});

/** jsdom's CSSOM normalises a LITERAL hex to `rgb(r, g, b)` while leaving a `var(--…)` string
 *  verbatim — so the tokens with a CSS var (C.*) compare as written and the two spec values that
 *  have no var (the terminal plane and its edge, read straight off BLUEPRINT) have to be converted
 *  before comparing. Doing it here rather than hard-coding the triple keeps these rows honest if
 *  the spec value ever moves. */
const rgb = (hex: string) =>
  `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;

const box = () => screen.getByTestId("concierge-compose");
const field = () => screen.getByRole("textbox", { name: "Message" });

function mount(props: Partial<Parameters<typeof ComposeBox>[0]> = {}) {
  return render(<ComposeBox onSend={vi.fn()} onAttach={vi.fn()} {...props} />);
}

describe("the composer's plate", () => {
  it("is `--k-input`, and is NOT a scrim", () => {
    mount();
    expect(box().style.background).toBe(C.inputSurface);
    // Said twice on purpose. The first line pins what it IS; this pins what it must never be
    // again, because a future "restore the tint for depth" would satisfy neither AA nor the mock
    // and would read as a taste change rather than as the regression it is.
    expect(box().style.background).not.toContain(COMPOSE_SCRIM);
    expect(box().style.background).not.toContain("rgba(0, 0, 0");
  });

  it("carries an EDGE rule instead — the direction separates registers by line weight", () => {
    mount();
    expect(box().style.border).toBe(`1px solid ${C.hairline}`);
    // …and it is a BOX, not a full-bleed strip with a top rule. The inset is what makes the change
    // of surface read as "this is the field" rather than as a second plane in the column.
    expect(box().style.margin).toBe("0px 10px 10px");
    expect(box().style.borderRadius).toBe("4px");
    expect(box().style.borderTop).toBe("");
  });

  it("does not draw a SECOND filled, outlined field inside itself", () => {
    mount();
    // The textarea keeps a transparent 1px border — the rich-placeholder overlay is positioned
    // against it and the auto-grow measurement is taken off its box, so the pixel has to stay even
    // though nothing is painted in it.
    expect(field().style.background).toBe("transparent");
    expect(field().style.border).toBe("1px solid transparent");
    expect(field().style.background).not.toBe(C.barSurface);
  });

  it("keeps the drop affordance, composited over the plate rather than over a scrim", () => {
    mount({ dropActive: true });
    expect(box().style.background).toContain(C.inputSurface);
    expect(box().style.background).toContain(C.teal);
    expect(box().style.outline).toContain("dashed");
  });
});

// ── WIRED: the column floods, so the composer stops painting a plate of its own ────────────────
// `.shell[data-wired] .assist .cmp` in the mock. The concierge has taken the TERMINAL's colour, and
// a box still painting `--k-input` inside it would be a white rectangle punched through the flood.
describe("the composer while the cable is patched", () => {
  it("goes transparent over the flood, with the terminal's own edge token", () => {
    mount({ wired: true });
    expect(box().dataset.wired).toBe("yes");
    expect(box().style.background).toBe("transparent");
    // jsdom's default theme resolution is dark (systemPrefersDark returns true with no matchMedia),
    // which is what `useResolvedTheme` reports here. Reading the expectation from BLUEPRINT rather
    // than from a literal keeps this row honest if the terminal's edge ever moves.
    expect(box().style.border).toBe(`1px solid ${rgb(BLUEPRINT.dark.termHair)}`);
    expect(box().style.border).not.toContain(C.hairline);
  });

  it("…and unwired is the default, so nothing has to opt out of the flood", () => {
    mount();
    expect(box().dataset.wired).toBe("no");
    expect(box().style.background).toBe(C.inputSurface);
  });

  // THE OTHER BRANCH OF THE PER-THEME LOOKUP. Everything above runs in dark, which is what jsdom
  // hands out by default — so without this row the `BLUEPRINT[mode]` indexing is only ever
  // exercised in one direction, and a hard-coded `BLUEPRINT.dark` would pass the whole file. It
  // also matters more in light than in dark: light's terminal plane is a mid blue-grey against a
  // white input ground, so this is the end where getting the mode wrong is plainly visible.
  it("takes the LIGHT terminal's plane and edge when the app is in light mode", () => {
    useUiStore.setState({ themePref: "light" } as never);
    mount({ wired: true });
    expect(box().style.border).toBe(`1px solid ${rgb(BLUEPRINT.light.termHair)}`);
    expect(box().style.border).not.toBe(`1px solid ${rgb(BLUEPRINT.dark.termHair)}`);
  });

  it("…and the light UNWIRED plate is still the input ground, not the flood", () => {
    useUiStore.setState({ themePref: "light" } as never);
    mount();
    expect(box().style.background).toBe(C.inputSurface);
    expect(box().style.border).toBe(`1px solid ${C.hairline}`);
  });
});

// ── THE FLAG HAS TO REACH THE TRAY, not merely be owned by the box ─────────────────────────────
//
// THE HOLE THIS FILLS. `SendModeTray.test.tsx` renders `<SendModeTray … wired />` directly, which
// proves the branch INSIDE the tray works and says nothing about anyone passing the flag to it.
// `wired` defaults to `false` there, so deleting `wired={wired}` from this box's call site silently
// restores the original defect — the chrome hairline painted on the terminal flood, below the
// project's own visibility floor in wired + light (roborev 55244) — with the whole suite green.
//
// The rows ABOVE cannot catch it: they assert the box's own `data-wired` and border, which are a
// different element with a different token.
describe("the tray's edge inherits the composer's ground", () => {
  /** A COUNTING model, so the same rows also prove the sweep renders on this ground rather than
   *  only the resting frame. */
  const COUNTING: SendTrayModel = {
    phase: "counting",
    targetName: "Build 4",
    tier: "normal",
    remainingFraction: 0.6,
  };
  const track = () => screen.getByTestId("send-mode-tray");

  it("takes the TERMINAL edge token when the box is wired, never the chrome seam", () => {
    mount({ wired: true, autoSend: COUNTING, sendMode: "speak" });
    // `C.hairline` is the CHROME seam and theme/chromeContrast.test.ts deliberately does NOT pair it
    // with the terminal plane (light `hairline` on `forest` measures 1.195 against a 1.2 floor); it
    // floors `termHairline` there instead. On the flood a wired composer goes transparent over, the
    // chrome token would put the counting cue BELOW the project's own visibility floor.
    expect(track().style.borderColor).toBe(rgb(BLUEPRINT.dark.termHair));
    expect(track().style.borderColor).not.toContain(C.hairline);
  });

  it("…in LIGHT too, which is the end the contrast floor actually bites at", () => {
    useUiStore.setState({ themePref: "light" } as never);
    mount({ wired: true, autoSend: COUNTING, sendMode: "speak" });
    expect(track().style.borderColor).toBe(rgb(BLUEPRINT.light.termHair));
    expect(track().style.borderColor).not.toBe(rgb(BLUEPRINT.dark.termHair));
  });

  it("and the chrome seam when it is NOT wired — the box passes a branch, not a constant", () => {
    // The other half of the same forwarding. Hard-coding the terminal token in the rail would pass
    // the two rows above and fail here, so the pair pins that `wired` is what selects between them.
    mount({ autoSend: COUNTING, sendMode: "speak" });
    expect(track().style.borderColor).toBe(C.hairline);
  });
});
