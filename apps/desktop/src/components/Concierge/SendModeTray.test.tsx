// @vitest-environment jsdom
//
// The tray itself — three positions, one press target, one sweep.
//
// WHAT WAS HERE BEFORE. `SendRail.test.tsx`, covering a Send button with a boolean arming switch
// beside it. Every row below asserts something that control could not do: park at one of three
// positions, refuse a press in the mode that sends on release, draw a keycap that follows the
// setting, or go flat grey while still showing which mode is selected.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ACTING_FLASH_MS,
  SendModeTray,
  DEFAULT_SPEAK_LEFT_FRAC,
  TRAY_GEOMETRY,
  speakLeftFraction,
  type SendModeTrayProps,
  type SendTrayModel,
} from "./SendModeTray";
import {
  TRAY_SHORT_LABEL_MAX_PX,
  TRAY_SHORT_NO_CHICLET_MIN_PX,
  TRAY_SHORT_TIGHT_MIN_PX,
} from "../../voice/sendMode";
import { C } from "../../theme/colors";
import {
  TRAY_SELECTED_FILL_PCT,
  TRAY_STRIP_TINT_PCT,
  TRAY_SWEEP_TINT_PCT,
} from "./trayInk";

afterEach(cleanup);

const COUNTING: SendTrayModel = {
  phase: "counting",
  targetName: "Build 4",
  tier: "normal",
  remainingFraction: 0.6,
};

function mount(over: Partial<SendModeTrayProps> = {}) {
  const onModeChange = vi.fn();
  const onSend = vi.fn();
  render(
    <SendModeTray
      mode="send"
      onModeChange={onModeChange}
      onSend={onSend}
      canSend
      chord="cmd-enter"
      {...over}
    />,
  );
  return { onModeChange, onSend };
}

/** Like `mount`, but keeps the handle so a row can push a NEW model in — which is the only way to
 *  simulate an event that arrives between renders. */
function mountR(over: Partial<SendModeTrayProps> = {}) {
  const onModeChange = vi.fn();
  const onSend = vi.fn();
  const props = (o: Partial<SendModeTrayProps>) => (
    <SendModeTray mode="send" onModeChange={onModeChange} onSend={onSend} canSend chord="cmd-enter" {...o} />
  );
  const view = render(props(over));
  return {
    onModeChange,
    onSend,
    rerender: (next: Partial<SendModeTrayProps>) => act(() => view.rerender(props(next))),
  };
}

const tray = () => screen.getByTestId("send-mode-tray");
const pill = (m: string) => screen.getByTestId(`send-mode-tray`).querySelector<HTMLButtonElement>(
  `[data-mode-pill="${m}"]`,
)!;

describe("the tray is the only press target", () => {
  it("offers exactly the three positions, and marks the selected one", () => {
    mount({ mode: "ptt" });
    expect(tray().querySelectorAll("[data-mode-pill]")).toHaveLength(3);
    expect(pill("ptt").getAttribute("aria-pressed")).toBe("true");
    expect(pill("send").getAttribute("aria-pressed")).toBe("false");
    expect(pill("speak").getAttribute("aria-pressed")).toBe("false");
  });

  it("pressing an UNSELECTED position moves the tray and sends nothing", () => {
    const { onModeChange, onSend } = mount({ mode: "send" });
    fireEvent.click(pill("speak"));
    expect(onModeChange).toHaveBeenCalledWith("speak");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("pressing the SELECTED Send position sends", () => {
    const { onSend, onModeChange } = mount({ mode: "send" });
    fireEvent.click(pill("send"));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onModeChange).not.toHaveBeenCalled();
  });

  it("pressing the SELECTED Speak position sends too — you can always beat the countdown", () => {
    const { onSend } = mount({ mode: "speak", model: COUNTING });
    fireEvent.click(pill("speak"));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("pressing the SELECTED Push to talk position sends NOTHING — the release is what sends", () => {
    // A press here would be a second, competing way to do the same thing, in the one mode whose
    // whole gesture is "let go when you are done".
    const { onSend, onModeChange } = mount({ mode: "ptt" });
    fireEvent.click(pill("ptt"));
    expect(onSend).not.toHaveBeenCalled();
    expect(onModeChange).not.toHaveBeenCalled();
  });

  it("keeps the accessible name 'Send' on that position in EVERY mode", () => {
    // It is the name every keybinding, every voice-control user and every existing test reaches
    // for. A control that renames itself as the surface changes state is one nobody can address
    // twice the same way.
    mount({ mode: "speak", model: COUNTING });
    expect(screen.getByRole("button", { name: "Send" })).toBe(pill("send"));
  });

  it("declines the press when there is nothing to send, without disabling the OTHER positions", () => {
    // The old rail could only grey one button. Here a nothing-to-send state must not also take
    // away the user's ability to change mode — that would be a control that traps you.
    const { onModeChange, onSend } = mount({ mode: "send", canSend: false });
    expect(pill("send").getAttribute("aria-disabled")).toBe("true");
    expect(pill("speak").getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(pill("send"));
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.click(pill("speak"));
    expect(onModeChange).toHaveBeenCalledWith("speak");
  });

  it("stays REACHABLE by keyboard with nothing to send — the default launch state", () => {
    // THE REGRESSION THE ROVING TABINDEX INTRODUCED. A `disabled` button is neither focusable nor a
    // keydown target, and the tray's only tab stop is the selected pill — which on launch is Send,
    // over an empty composer. The tray had ZERO tab stops: a keyboard-only user could not reach the
    // composer's sole send/voice control, nor the arrows this component calls the only way to reach
    // Push to talk without a pointer (WCAG 2.1.1, roborev 56087).
    const { onModeChange } = mount({ mode: "send", canSend: false });
    expect(pill("send").hasAttribute("disabled")).toBe(false);
    expect(pill("send").tabIndex).toBe(0);
    // …and the arrows still work from it, which is the thing the tab stop exists to enable.
    act(() => pill("send").focus());
    fireEvent.keyDown(pill("send"), { key: "ArrowRight" });
    expect(onModeChange).toHaveBeenCalledWith("ptt");
  });
});

describe("← / → step the tray, clamped", () => {
  it("steps one position per press while a pill has keyboard focus", () => {
    const { onModeChange } = mount({ mode: "send" });
    fireEvent.keyDown(pill("send"), { key: "ArrowRight" });
    expect(onModeChange).toHaveBeenCalledWith("ptt");
  });

  it("steps back the other way", () => {
    const { onModeChange } = mount({ mode: "speak" });
    fireEvent.keyDown(pill("speak"), { key: "ArrowLeft" });
    expect(onModeChange).toHaveBeenCalledWith("ptt");
  });

  it("CLAMPS at the ends — the tray never wraps Send round to Speak", () => {
    // Wrapping would put "microphone off, nothing listening" one keypress from "microphone live,
    // auto-sending", with the overshoot that produced it invisible.
    const { onModeChange } = mount({ mode: "send" });
    act(() => pill("send").focus());
    fireEvent.keyDown(pill("send"), { key: "ArrowLeft" });
    expect(onModeChange).not.toHaveBeenCalled();
    cleanup();
    const b = mount({ mode: "speak" });
    fireEvent.keyDown(pill("speak"), { key: "ArrowRight" });
    expect(b.onModeChange).not.toHaveBeenCalled();
  });

  it("steps from the FOCUSED pill, not the selected one, and focus follows the move", () => {
    // The incoherent-and-unsafe case: Send selected, focus ring on Speak. Stepping from `mode` made
    // `←` a no-op (clamped at Send) while `→` armed the microphone at a position two pills from what
    // the user was looking at — and a screen reader announced nothing, because `aria-pressed`
    // changed on an unfocused element (roborev 56071).
    const { onModeChange } = mount({ mode: "send" });
    act(() => pill("speak").focus());
    fireEvent.keyDown(pill("speak"), { key: "ArrowLeft" });
    // Stepping from SPEAK, so ← lands on ptt — not swallowed by Send's clamp.
    expect(onModeChange).toHaveBeenCalledWith("ptt");
  });

  it("keeps the tray to ONE tab stop, on the selected position", () => {
    // Roving tabindex: Tab moves THROUGH this control rather than into three separate stops, and the
    // pill the arrows start from is the one Tab lands on.
    mount({ mode: "ptt" });
    expect(pill("ptt").tabIndex).toBe(0);
    expect(pill("send").tabIndex).toBe(-1);
    expect(pill("speak").tabIndex).toBe(-1);
  });

  it("leaves every other key to the surface it came from", () => {
    // The textarea's own arrows are untouched (there, `→` already accepts a ghost completion), and
    // nothing here swallows Tab, Escape or typing.
    const { onModeChange } = mount({ mode: "send" });
    for (const key of ["ArrowUp", "ArrowDown", "Tab", "Escape", "a"]) {
      fireEvent.keyDown(pill("send"), { key });
    }
    expect(onModeChange).not.toHaveBeenCalled();
  });
});

describe("the keycap chiclet", () => {
  it("is hidden at rest and revealed on hover", () => {
    mount({ mode: "send" });
    expect(screen.queryByTestId("send-chiclet-send")).toBeNull();
    fireEvent.mouseEnter(pill("send"));
    expect(screen.getByTestId("send-chiclet-send").textContent).toBe("⌘↩");
    fireEvent.mouseLeave(pill("send"));
    expect(screen.queryByTestId("send-chiclet-send")).toBeNull();
  });

  it("is revealed by KEYBOARD FOCUS too, not only by a pointer", () => {
    // A control only reachable by mouse hover is one a keyboard user is told nothing about.
    mount({ mode: "send" });
    fireEvent.focus(pill("speak"));
    expect(screen.getByTestId("send-chiclet-speak").textContent).toBe("⌘↩");
  });

  it("shows ⌘ on Push to talk, because ⌘ means TALK there and ⌘↩ sends nothing", () => {
    mount({ mode: "ptt" });
    fireEvent.mouseEnter(pill("ptt"));
    expect(screen.getByTestId("send-chiclet-ptt").textContent).toBe("⌘");
  });

  it("FOLLOWS the setting — a chip that lies about the keystroke is worse than no chip", () => {
    mount({ mode: "send", chord: "enter" });
    fireEvent.mouseEnter(pill("send"));
    expect(screen.getByTestId("send-chiclet-send").textContent).toBe("↩");
  });
});

describe("the tray sweep", () => {
  it("runs in Speak, anchored RIGHT so the mass converges on the position that is counting", () => {
    mount({ mode: "speak", model: COUNTING });
    const sweep = screen.getByTestId("send-tray-sweep");
    // Anchored right with no left: shrinking the width walks its leading edge rightward, INTO
    // Speak. Draining toward Send would point at a position that never counts.
    expect(sweep.style.right).toBe("0px");
    expect(sweep.style.left).toBe("");
    // 0.6 remaining, and the sweep now stops at Speak's LEFT EDGE rather than draining to zero:
    // width = 100 - speakLeftFrac x 100 x (1 - remaining) = 100 - 66.67 x 0.4 ~= 73%.
    expect(sweep.style.width).toBe("73%");
    expect(tray().getAttribute("data-counting")).toBe("true");
  });

  it("does NOT run in Send or Push to talk, even when the host hands over a counting model", () => {
    // The host's timer and the tray's position are separate facts, and the tray is the one that
    // decides whether a sweep is legitimate. Without this the countdown would paint over a mode
    // that sends on a press or on a release, promising a deadline neither of them has.
    mount({ mode: "send", model: COUNTING });
    expect(screen.queryByTestId("send-tray-sweep")).toBeNull();
    cleanup();
    mount({ mode: "ptt", model: COUNTING });
    expect(screen.queryByTestId("send-tray-sweep")).toBeNull();
  });

  it("draws no sweep while the clock is not running", () => {
    mount({ mode: "speak", model: { ...COUNTING, phase: "listening" } });
    expect(screen.queryByTestId("send-tray-sweep")).toBeNull();
    expect(tray().getAttribute("data-counting")).toBeNull();
  });

  it("shows the position's name and NOTHING else, whether or not a clock is running", () => {
    // The founder's ask, verbatim: the pill must read exactly "Speak" — no arrow, no destination,
    // no ellipsis. The composed "Speak → Build 4" label is what truncated the whole `flex: 1` tray
    // to "S… P… S…" in a narrow concierge column, taking all three position names down with it.
    mount({ mode: "speak", model: { ...COUNTING, phase: "listening" } });
    expect(screen.getByTestId("send-mode-label-speak").textContent).toBe("Speak");
    cleanup();
    mount({ mode: "speak", model: COUNTING });
    expect(screen.getByTestId("send-mode-label-speak").textContent).toBe("Speak");
  });

  it("keeps the destination in the ACCESSIBLE name after taking it out of the visible one", () => {
    // Unpinned from the visible text, not deleted: the tooltip and a screen reader still name the
    // target. This is also what keeps WCAG 2.5.3 (Label in Name) satisfied — the accessible name
    // must CONTAIN the visible string, and "Speak → Build 4" contains "Speak". The failing
    // direction is the reverse, which is why the visible label may shrink but the name may not.
    mount({ mode: "speak", model: { ...COUNTING, phase: "listening" } });
    expect(pill("speak").getAttribute("aria-label")).toBe("Speak → Build 4");
    expect(pill("speak").getAttribute("title")).toContain("Speak → Build 4");
    expect(pill("speak").getAttribute("aria-label")).toContain(
      screen.getByTestId("send-mode-label-speak").textContent!,
    );
  });

  it("keeps the ACCESSIBLE NAME at the full label when the tray narrows the visible one", () => {
    // ── THE REGRESSION THIS PINS (roborev 56198) ────────────────────────────────────────────────
    // `spokenLabel` was derived from the width-dependent `label`, so a narrow tray silently renamed
    // the Push-to-talk pill to "Push": the control renamed itself as the surface resized, and
    // "click Push to talk" hit in a wide column and missed in a narrow one.
    //
    // jsdom has no ResizeObserver, so the narrow branch was UNREACHABLE by any earlier test — which
    // is exactly how the defect shipped. Stubbing it is what makes this row able to fail at all.
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
      mount({ mode: "ptt", model: COUNTING });
      // Wide first: the full word is both visible and spoken.
      act(() => fire!(TRAY_SHORT_LABEL_MAX_PX + 100));
      expect(screen.getByTestId("send-mode-label-ptt").textContent).toBe("Push to talk");
      expect(pill("ptt").getAttribute("aria-label")).toBe("Push to talk");

      // Now narrow it — into the SHORT tier, not past it. 300 used to be that tier and is now the
      // narrowest tier, where the pills wrap but the words stay whole; that tier has its own case
      // icon tier gets its own case below.
      // Into the SHORT tier. This used to be `-20` off the full threshold, which landed at ~420 and
      // was short back when there were three tiers. The ladder now inserts `fullTight` between them
      // — the full wording survives 160px further down, which is the improvement — so the short
      // wording starts below `TRAY_SHORT_NO_CHICLET_MIN_PX`.
      act(() => fire!(TRAY_SHORT_NO_CHICLET_MIN_PX));
      expect(screen.getByTestId("send-mode-label-ptt").textContent).toBe("Push");
      // …and the ACCESSIBLE NAME does not move. This is the assertion that fails against the
      // pre-fix code, where it read "Push".
      expect(pill("ptt").getAttribute("aria-label")).toBe("Push to talk");
      expect(pill("ptt").getAttribute("title")).toContain("Push to talk");
      // WCAG 2.5.3 containment still holds in the NARROW state, which is the state that broke it.
      expect(pill("ptt").getAttribute("aria-label")).toContain(
        screen.getByTestId("send-mode-label-ptt").textContent!,
      );
    } finally {
      globalThis.ResizeObserver = realRO;
    }
  });

  // ── THE ICON TIER ──────────────────────────────────────────────────────────────────────────
  //
  // The founder's narrow-column screenshot showed the tray reading "S… P… S…" — all three positions
  // ellipsised to one letter, so the control that decides what happens when you stop talking could
  // not be read. The short-label tier moved the width at which that happens; it did not remove it.
  //
  // Reachable here ONLY because this file stubs ResizeObserver — jsdom has none, which is exactly
  // how the original defect shipped unnoticed.
  // ── THE FLOOR TIER KEEPS THE WORDS ───────────────────────────────────────────────────────────
  //
  // This case used to assert the tray dropped to ICONS below the tight tier. The founder overrode
  // that: "I want to see the entire words Send, Push, Speak." Measurement showed icons were never
  // necessary — three whole words fit at every column down to the 50px floor, because the tray WRAPS
  // them onto two rows and then three rather than squeezing them onto one.
  //
  // Reachable only because this file stubs ResizeObserver; jsdom has none, which is how the original
  // truncation shipped unnoticed.
  it("keeps WHOLE WORDS at the narrowest tier — no icons, no ellipsis", () => {
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
      mount({ mode: "ptt", model: COUNTING });
      act(() => fire!(TRAY_SHORT_TIGHT_MIN_PX - 1));

      for (const m of ["send", "ptt", "speak"] as const) {
        const label = screen.getByTestId(`send-mode-label-${m}`).textContent ?? "";
        expect(label).toBeTruthy();
        expect(label).not.toContain("…");
        // …and no glyph substituted for it.
        expect(screen.queryByTestId(`send-mode-icon-${m}`)).toBeNull();
      }

      // The accessible name is untouched, as in every tier.
      expect(pill("ptt").getAttribute("aria-label")).toBe("Push to talk");
    } finally {
      globalThis.ResizeObserver = realRO;
    }
  });

  it("draws EVERY tier as the same solid fill — no hatch the user has to decode", () => {
    // ── THE FOUNDER'S "SHADED CANDY CANE" ──────────────────────────────────────────────────────
    // `verylow` used to paint a 135° repeating-linear-gradient. He hit it repeatedly and could not
    // read it: "I don't know why, I don't know when it does that, but I don't want that." The state
    // it encoded is real ("that sounded unfinished" — 12s instead of 3.6s) and is still carried, by
    // the SPEED of the sweep, which needs no legend.
    for (const tier of ["high", "normal", "low", "verylow"] as const) {
      cleanup();
      mount({ mode: "speak", model: { ...COUNTING, tier, targetName: "Concierge" } });
      const sweep = screen.getByTestId("send-tray-sweep");
      expect(sweep.style.background).not.toContain("repeating-linear-gradient");
      expect(sweep.style.background).not.toContain("gradient");
    }
    // A digits readout is still refused outright: it invites the user to race the clock, and the
    // number was never the information. The target name is deliberately digit-free here — an agent
    // literally NAMED "Build 4" of course keeps its numeral, so the ban is on a READOUT, not a name.
    expect(tray().textContent).not.toMatch(/\d/);
  });

  it("keeps textOverflow: ellipsis as the LAST-RESORT backstop", () => {
    // ── roborev 56213 ───────────────────────────────────────────────────────────────────────────
    // This property was DELETED one commit ago on this branch and produced the "Push to tal" defect
    // — a word clipped mid-stroke with nothing signalling it — which human review caught and the
    // suite did not. The old row asserted `textOverflow === ""`, so REMOVING the ellipsis was
    // pinned; restoring it was not, and a reader of sendMode.ts's "an ellipsis is a character the
    // user has to decode" comment can delete it again with everything green.
    //
    // TO BE CLEAR ABOUT WHAT THIS ENDORSES: the ellipsis is NOT the mechanism. Narrow widths are
    // handled by choosing a shorter WORD (voice/sendMode `trayLabelFor`), and with the threshold at
    // its pessimistic value this should never paint. It is here because the threshold is an estimate
    // of text metrics, and if that estimate is ever wrong an ellipsis beats a truncated word.
    mount({ mode: "speak", model: COUNTING });
    for (const m of ["send", "ptt", "speak"] as const) {
      expect(screen.getByTestId(`send-mode-label-${m}`).style.textOverflow).toBe("ellipsis");
    }
  });

  it("measures Speak's edge in ONE coordinate system — padding box, not content box", () => {
    // ── roborev 56219 ───────────────────────────────────────────────────────────────────────────
    // The fraction used to be `offsetLeft / contentRect.width`. Those are different boxes:
    // contentRect EXCLUDES the tray's padding, `offsetLeft` is measured FROM the padding edge, and
    // an absolutely-positioned child's `width: X%` resolves against the padding box. The result was
    // inflated by (w + 2*pad)/w — a constant ~4px of Speak left unfilled at the moment of send.
    //
    // The measuring branch is unreachable in jsdom (offsetLeft is always 0), so the pure helper is
    // the only thing a test can pin — which is exactly why it was extracted.
    const pad = TRAY_GEOMETRY.trayPad;
    const contentW = 600;
    const paddingBoxW = contentW + 2 * pad;
    const offsetLeft = 400; // Speak's left edge, measured from the padding edge

    // Correct: both terms against the padding box.
    expect(speakLeftFraction(offsetLeft, paddingBoxW)).toBeCloseTo(offsetLeft / paddingBoxW, 10);
    // The OLD (wrong) denominator produces a strictly larger fraction — the inflation itself.
    expect(offsetLeft / contentW).toBeGreaterThan(speakLeftFraction(offsetLeft, paddingBoxW));

    // Unmeasurable inputs fall back to the geometric default rather than collapsing the sweep.
    expect(speakLeftFraction(0, paddingBoxW)).toBe(DEFAULT_SPEAK_LEFT_FRAC);
    expect(speakLeftFraction(offsetLeft, 0)).toBe(DEFAULT_SPEAK_LEFT_FRAC);
  });

  it("stops the sweep at Speak's LEFT EDGE, not through it", () => {
    // The founder: "it shouldn't drain all the way through the speak button. Once it hits the left
    // side of the speak button, then it sends." Anchored right, so the leading edge is `100 - width`
    // and must land exactly on Speak's left edge when the clock reaches zero — the same instant the
    // send fires, because both read the one `remaining` value.
    // From the component's own default, not a hand-spelled 3 (roborev 56219).
    const speakLeftPct = DEFAULT_SPEAK_LEFT_FRAC * 100;

    cleanup();
    mount({ mode: "speak", model: { ...COUNTING, remainingFraction: 1 } });
    // Full: the leading edge starts at the tray's left edge.
    expect(parseFloat(screen.getByTestId("send-tray-sweep").style.width)).toBeCloseTo(100, 0);

    cleanup();
    mount({ mode: "speak", model: { ...COUNTING, remainingFraction: 0 } });
    // Spent: the fill covers exactly the Speak pill and no more — it did NOT drain to 0%.
    const spent = parseFloat(screen.getByTestId("send-tray-sweep").style.width);
    expect(spent).toBeCloseTo(100 - speakLeftPct, 0);
    expect(spent).toBeGreaterThan(0);
  });
});

describe("inert — not addressed, not disabled", () => {
  it("goes flat grey by DESATURATION, never by fading out", () => {
    // The PlanBuildToggle precedent. Opacity would read as the control fading out of the interface,
    // i.e. as failing. Grayscale keeps every edge and label at full strength and removes only the
    // channel that was carrying "this mode is live".
    mount({ mode: "speak", model: COUNTING, inert: true });
    expect(tray().style.filter).toBe("grayscale(1)");
    expect(tray().style.opacity).toBe("");
    expect(tray().getAttribute("data-inert")).toBe("true");
  });

  it("KEEPS showing which mode is selected — the mode was not reset, it is not receiving you", () => {
    mount({ mode: "speak", model: COUNTING, inert: true });
    expect(pill("speak").getAttribute("aria-pressed")).toBe("true");
    expect(tray().getAttribute("data-mode")).toBe("speak");
  });

  it("is not disabled: every position still takes a press", () => {
    // Grey here means "your keystrokes are going somewhere else", not "this is broken". Disabling
    // the tray would trap a user in whatever mode they were in when they clicked into a terminal.
    const { onModeChange } = mount({ mode: "speak", inert: true });
    expect(pill("send").disabled).toBe(false);
    fireEvent.click(pill("send"));
    expect(onModeChange).toHaveBeenCalledWith("send");
  });

  it("carries no filter when it IS being addressed", () => {
    mount({ mode: "speak", model: COUNTING });
    expect(tray().style.filter).toBe("");
    expect(tray().getAttribute("data-inert")).toBeNull();
  });
});

describe("Send is an off state for the MICROPHONE, never for the control", () => {
  it("draws the selected Send position OUTLINED at rest, like the other two", () => {
    // ── THIS EXPECTATION WAS INVERTED BY THE FOUNDER, DELIBERATELY ──────────────────────────────
    // It used to assert Send wore the solid primary fill AT REST. Under the unified rule — fill
    // matches stroke = acting right now — that made Send the one position permanently claiming to
    // be sending. His words: "the send button should also be a lighter color than the stroke until I
    // hit the send button to send it". Send now fills only on the click, which the
    // fill-matches-stroke rows below pin.
    mount({ mode: "send" });
    expect(pill("send").style.background).toContain("color-mix");
    expect(pill("send").style.background).not.toBe(pill("send").style.borderColor);
  });

  it("draws the voice positions as a TINT, not a second hot button beside a live mic", () => {
    mount({ mode: "speak", model: COUNTING });
    expect(pill("speak").style.background).toContain("color-mix");
    expect(pill("speak").style.background).not.toBe(C.successInk);
  });
});

// ── SELECTION MUST NOT COST LEGIBILITY ─────────────────────────────────────────────────────────
//
// THE FOUNDER'S REPORT, with a screenshot of the three buttons: Send and Push to talk (unselected)
// are crisp, and Speak (selected, nothing running) is the hardest of the three to read. His words:
// "the text should be above the button … which is shaded behind … basically the same font color …
// as when it's not an active button". The cause was `color: ink` — the label drawn in the SAME hue
// as its own fill and border, so the word read as part of the wash instead of sitting on it.
//
// THESE ROWS ARE WHAT MAKE THE PALETTE GUARD MEAN ANYTHING. theme/sendModeTrayContrast.test.ts
// measures the WCAG ratios, but it reads ./trayInk — so on its own it would stay green if this
// component were reverted to `color: ink` without anyone touching that module. These rows bind the
// rendered pill to the token, which is the half that can actually regress.
describe("the selected-but-idle label is as legible as an unselected one", () => {
  it("paints the selected label in the plane's primary ink, NOT the position's own colour", () => {
    mount({ mode: "speak", model: COUNTING });
    // The exact defect: the label must not be the same colour as the fill and border it sits on.
    expect(pill("speak").style.color).not.toBe(C.successInk);
    expect(pill("speak").style.color).not.toBe(pill("speak").style.borderColor);
    expect(pill("speak").style.color).toBe(C.cream);
  });

  it("holds for every position, so no one mode is the illegible one", () => {
    for (const m of ["send", "ptt", "speak"] as const) {
      cleanup();
      mount({ mode: m });
      expect(pill(m).style.color, `${m} selected-but-idle`).toBe(C.cream);
    }
  });

  it("still says WHICH position is selected — via the fill and the border, not the text", () => {
    mount({ mode: "speak", model: COUNTING });
    // Selection is carried entirely by the two surfaces...
    expect(pill("speak").style.background).toContain("color-mix");
    expect(pill("speak").style.borderColor).toBe(C.successInk);
    // ...while the unselected pills stay transparent-on-baseline-ink.
    expect(pill("send").style.background).toBe("transparent");
    expect(pill("send").style.color).toBe(C.conciergeMuted);
  });

  // ── THE WASHES ARE BOUND TOO, NOT JUST THE INK ────────────────────────────────────────────────
  // The rows above bind the component's LABEL COLOUR to ./trayInk. The percentages were left
  // unbound, which is the same drift hole one level down: re-inlining a literal in SendModeTray
  // (`${ink} 40%`) would leave every suite green while theme/sendModeTrayContrast.test.ts went on
  // measuring a fill the component no longer paints — exactly the roborev-56213 failure trayInk's
  // header claims to have closed (roborev 59015). Read the number back off the node instead.
  it("paints the washes the contrast guard measures — read back off the rendered node", () => {
    // `toContain("8%")` WOULD BE SATISFIED BY "18%" — the sweep's own constant, sitting right next
    // to this one. That is not hypothetical: it was the bug in the first cut of this test (roborev
    // 59042). Anchoring on the leading space and trailing comma makes each percentage match only
    // itself, because " 8%," does not occur inside " 18%,".
    const wash = (pct: number) => ` ${pct}%,`;
    mount({ mode: "speak", model: COUNTING });
    expect(pill("speak").style.background).toContain(wash(TRAY_SELECTED_FILL_PCT));
    expect(tray().style.background).toContain(wash(TRAY_STRIP_TINT_PCT));
    expect(screen.getByTestId("send-tray-sweep").style.background).toContain(
      wash(TRAY_SWEEP_TINT_PCT),
    );
    // ...and prove the anchoring actually discriminates, so this test cannot rot back into the
    // substring bug it was written to fix.
    expect(tray().style.background).not.toContain(wash(TRAY_SWEEP_TINT_PCT));
  });

  it("leaves the ACTING state alone — it still inverts onto the solid fill", () => {
    // The founder was explicit that the held/firing treatment is fine as it is, so the fix must not
    // reach it: acting keeps the solid identity fill with the inverted ink.
    mount({ mode: "ptt", pttHeld: true });
    // Stated as the founder's own rule — fill MATCHES stroke = acting — rather than against a
    // colour literal. `C.amber` is brand-constant hex (not a `var()`), so jsdom normalises it to
    // `rgb(…)` on read; comparing the two properties sidesteps that and says the actual invariant.
    expect(pill("ptt").style.background).toBe(pill("ptt").style.borderColor);
    expect(pill("ptt").style.background).not.toContain("color-mix");
    expect(pill("ptt").style.color).toBe(C.onGoldFill);
    expect(pill("ptt").style.color).not.toBe(C.cream);
  });
});

// ── THE THIRD STATE: HELD ─────────────────────────────────────────────────────────────────────
//
// THE FOUNDER'S REPORT, raised twice: "When I hit the command key to use the push to talk, it should
// show as a fully pressed button, but it doesn't … It doesn't look any different than it does when
// it's in standby mode."
//
// There are three states and the tray drew two:
//   1. not selected            — inert
//   2. selected, key NOT held  — armed, waiting   ← what the amber outline meant
//   3. selected, key HELD      — capturing        ← indistinguishable from 2
//
// These pin that 2 and 3 now differ, and — the part that matters most — that 3 CLEARS. A tray still
// painting "held" over a microphone that has been stood down is the same desync in the other
// direction, and worse: it invites the user to keep talking into nothing.
describe("push to talk shows that the key is actually down", () => {
  const heldPill = () => pill("ptt");

  it("ARMED and HELD are visually different, not the same amber outline", () => {
    mount({ mode: "ptt", model: COUNTING });
    const armedBg = heldPill().style.background;
    expect(heldPill().getAttribute("data-held")).toBeNull();

    cleanup();
    mount({ mode: "ptt", model: COUNTING, pttHeld: true });
    expect(heldPill().getAttribute("data-held")).toBe("true");
    // A change of KIND — hollow to solid — not a brighter outline. The two states were previously
    // identical here, which is exactly what "it doesn't look any different" meant.
    //
    // The inset shadow this used to also assert is GONE: the founder's spec is the border colour
    // moved to the background and nothing else ("no glow, no animation"), so the distinguishing
    // fact is now the fill/stroke relationship alone.
    expect(heldPill().style.background).not.toBe(armedBg);
    expect(heldPill().style.background).toBe(heldPill().style.borderColor);
  });

  it("marks ONLY the Push-to-talk pill, never Send or Speak", () => {
    // Send fires on a click and Speak on a countdown; neither has a held gesture, so neither has a
    // capturing state to draw. A `pttHeld` that leaked onto them would be decoration, not a signal.
    mount({ mode: "ptt", model: COUNTING, pttHeld: true });
    expect(pill("send").getAttribute("data-held")).toBeNull();
    expect(pill("speak").getAttribute("data-held")).toBeNull();
  });

  it("does NOT paint held while the tray is INERT — the mic is not being heard", () => {
    // An inert tray means a live PTY owns the keyboard. Painting a pressed button there would claim
    // a capture that is not happening, which is the same lie the fix exists to remove.
    mount({ mode: "ptt", model: COUNTING, pttHeld: true, inert: true });
    expect(heldPill().getAttribute("data-held")).toBeNull();
  });

  it("does not paint held when Push to talk is not the selected mode", () => {
    mount({ mode: "speak", model: COUNTING, pttHeld: true });
    expect(heldPill().getAttribute("data-held")).toBeNull();
  });
});

describe("FILL MATCHES STROKE = acting right now — the one rule, all three pills", () => {
  // ── THE FOUNDER'S SPEC ────────────────────────────────────────────────────────────────────────
  // "When the background of the button is a different color than the stroke, I would consider that
  // to be inactive status. But when I'm actually pushing on the button … then the button should be
  // the same color as the stroke."
  //
  // Asserted as the RELATIONSHIP between two computed values — background vs borderColor — never as
  // a class name or a colour literal. That is the spec's own wording, and it means a theme change to
  // any of the three inks cannot make these rows stale or vacuous.
  const styleOf = (m: string) => pill(m).style;
  /** The rule, read off the DOM exactly as the founder states it. */
  const fillMatchesStroke = (m: string) => {
    const st = styleOf(m);
    return st.background !== "" && st.background === st.borderColor;
  };

  it("PUSH fills amber while held, and not before", () => {
    mount({ mode: "ptt" });
    expect(fillMatchesStroke("ptt"), "idle: fill must DIFFER from stroke").toBe(false);
    cleanup();
    mount({ mode: "ptt", pttHeld: true });
    expect(fillMatchesStroke("ptt"), "held: fill must MATCH stroke").toBe(true);
  });

  it("SPEAK fills green on the FIRE EVENT, not on a rendered remainingFraction", () => {
    // ── roborev 57314 (High) ──────────────────────────────────────────────────────────────────────
    // The first version of this row hand-built `{ remainingFraction: 0 }` and fed it in as a prop —
    // a model shape the production pipeline never emits. `useAutoSend`'s fire branch applies its
    // state and returns WITHOUT scheduling a repaint, so every render during a countdown comes from
    // a tick that just measured remaining > 0, and the render that would show 0 is the one where
    // counting has already stopped. Deriving the fill from it was a sub-millisecond race: a random
    // flicker, not a state. So the trigger is the fire EVENT, and this row drives that event.
    const { rerender } = mountR({ mode: "speak", model: { ...COUNTING, firedSeq: 0 } });
    expect(fillMatchesStroke("speak"), "mid-countdown: not acting yet").toBe(false);

    // The send fires. ONE clock: this is the same bump the dispatch itself produces.
    rerender({ mode: "speak", model: { ...COUNTING, firedSeq: 1 } });
    expect(fillMatchesStroke("speak"), "fired: fill must MATCH stroke").toBe(true);
  });

  it("SEND is OUTLINED at rest and fills only on the click that sends", () => {
    // This is a change to Send's DEFAULT look, not just an added state: it used to ship pre-filled,
    // which under the unified rule read as "sending" permanently.
    const { onSend } = mount({ mode: "send" });
    expect(fillMatchesStroke("send"), "at rest: fill must DIFFER from stroke").toBe(false);
    fireEvent.click(pill("send"));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(fillMatchesStroke("send"), "clicked: fill must MATCH stroke").toBe(true);
  });

  it("SPEAK also fills on the click that beats its own countdown", () => {
    // The founder's second Speak trigger: "I can click the button in order to send it before the
    // countdown is done, and when I click the button it becomes the same colour as the stroke".
    const { onSend } = mount({ mode: "speak", model: { ...COUNTING, remainingFraction: 0.6 } });
    expect(fillMatchesStroke("speak")).toBe(false);
    fireEvent.click(pill("speak"));
    expect(onSend, "the early click must actually SEND, not only paint").toHaveBeenCalledTimes(1);
    expect(fillMatchesStroke("speak")).toBe(true);
  });

  it("the fill CLEARS once the acknowledgement is over", () => {
    // "The fill must clear when the action ends." A click has no duration of its own, so the state
    // is time-bounded; it must not latch.
    vi.useFakeTimers();
    try {
      mount({ mode: "send" });
      fireEvent.click(pill("send"));
      expect(fillMatchesStroke("send")).toBe(true);
      act(() => void vi.advanceTimersByTime(ACTING_FLASH_MS + 20));
      expect(fillMatchesStroke("send"), "must not latch on").toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the shortcut pill — one treatment, revealed not resident (sparkle-bis16)", () => {
  const slot = (m: string) =>
    pill(m).querySelector<HTMLElement>(`[data-testid="send-chiclet-${m}"]`) ??
    // At rest the testid is withheld, so reach the slot positionally — it is the last child.
    (pill(m).lastElementChild as HTMLElement);

  it("draws the SAME <kbd> element Search does, not a bare glyph", () => {
    // The founder's ask is literally sameness: "I want the keyboard shortcuts for the send, push
    // and speak to also look that same way as they do in search." Asserted as the shared COMPONENT's
    // output — a real <kbd> — rather than by re-listing its colours here, because two copies of a
    // style is the exact defect KeyPill was extracted to fix (the palette's own two copies had
    // already drifted on padding).
    mount({ mode: "send" });
    act(() => fireEvent.mouseEnter(pill("send")));
    const kbd = pill("send").querySelector("kbd");
    expect(kbd, "the tray must render the shared KeyPill, which is a real <kbd>").toBeTruthy();
    expect(kbd!.textContent).toBe("⌘↩");
  });

  it("keeps the slot the same size at REST and on hover, so the reveal changes no geometry", () => {
    // Requirement 4, and the reason it exists: the founder has an open complaint about
    // Send/Push/Speak truncating to "Se…" at narrow widths. A pill that materialises on hover would
    // widen the row and cause exactly that. The slot is a fixed-width box in BOTH states — only its
    // contents fade.
    //
    // THE SLOT IS NO LONGER IN FLOW, so "reserves" is the wrong verb now: it is absolutely
    // positioned and justified right, which is what lets the LABEL be centred alone (the founder's
    // third ask — see ./SendModeTray.geometry.test.tsx, which owns the centring and no-shift
    // properties). What this row still pins is narrower and still worth pinning: the box does not
    // change size between the two states. The width also remains an input to the tier threshold,
    // now via `chicletClearancePx` rather than by occupying flow.
    mount({ mode: "send" });
    const restWidth = slot("send").style.width;
    expect(restWidth, "the slot has a width before any hover").toBe(
      `${TRAY_GEOMETRY.chicletSlot}px`,
    );
    act(() => fireEvent.mouseEnter(pill("send")));
    expect(slot("send").style.width, "and the SAME width after").toBe(restWidth);
  });

  it("hides the pill at rest and shows it on hover", () => {
    mount({ mode: "send" });
    expect(slot("send").style.opacity, "resting state shows no pill").toBe("0");
    act(() => fireEvent.mouseEnter(pill("send")));
    expect(slot("send").style.opacity).toBe("1");
    act(() => fireEvent.mouseLeave(pill("send")));
    expect(slot("send").style.opacity).toBe("0");
  });

  it("also reveals on keyboard FOCUS — the person who wants a shortcut has no pointer", () => {
    // A hover-only affordance is invisible to exactly the user it is for.
    mount({ mode: "send" });
    act(() => fireEvent.focus(pill("send")));
    expect(slot("send").style.opacity).toBe("1");
    act(() => fireEvent.blur(pill("send")));
    expect(slot("send").style.opacity).toBe("0");
  });
});
