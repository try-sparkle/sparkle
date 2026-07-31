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

import { SendModeTray, type SendModeTrayProps, type SendTrayModel } from "./SendModeTray";
import { C } from "../../theme/colors";

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
    expect(sweep.style.width).toBe("60%");
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

  it("keeps the destination on Speak whether or not a clock is running", () => {
    // THE MIS-ROUTE SAFETY NET. The old rail dropped the target the moment counting began, so users
    // read it as the destination having vanished at exactly the moment it mattered most. And the
    // visible text stays INSIDE the accessible name (WCAG 2.5.3) so "click Build 4" still hits it.
    mount({ mode: "speak", model: { ...COUNTING, phase: "listening" } });
    expect(screen.getByTestId("send-mode-label-speak").textContent).toBe("Speak → Build 4");
    expect(pill("speak").getAttribute("aria-label")).toBe("Speak → Build 4");
    cleanup();
    mount({ mode: "speak", model: COUNTING });
    expect(screen.getByTestId("send-mode-label-speak").textContent).toBe("Speak → Build 4");
  });

  it("hatches the very-low tier so a STILL frame can show it, and never prints a number", () => {
    // Ten seconds of sweep is imperceptible frame to frame, so motion alone cannot carry the tier.
    // A digits readout is refused outright: it invites the user to race the clock, and the number
    // was never the information.
    mount({ mode: "speak", model: { ...COUNTING, tier: "verylow", targetName: "Concierge" } });
    const sweep = screen.getByTestId("send-tray-sweep");
    expect(sweep.style.background).toContain("repeating-linear-gradient");
    // The target name is deliberately digit-free here: an agent literally NAMED "Build 4" of course
    // keeps its numeral, so the ban is on a READOUT, not on a name.
    expect(tray().textContent).not.toMatch(/\d/);
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
  it("draws the selected Send position as the app's primary FILL", () => {
    // Two objects, opposite treatments, one frame: mic dead, button hot. A Send position drawn as
    // quietly as the voice ones would say "nothing here is the action" at the one moment the button
    // IS the only way to send.
    mount({ mode: "send" });
    expect(pill("send").style.background).toBe(C.goldFill);
  });

  it("draws the voice positions as a TINT, not a second hot button beside a live mic", () => {
    mount({ mode: "speak", model: COUNTING });
    expect(pill("speak").style.background).toContain("color-mix");
    expect(pill("speak").style.background).not.toBe(C.successInk);
  });
});
