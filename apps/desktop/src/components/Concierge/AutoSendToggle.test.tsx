// @vitest-environment jsdom
//
// The Auto-send switch (sparkle-aew8t): it appears only in Speak, sits BELOW the tray at the RIGHT,
// reports and sets the persisted setting, and remembers its position across mode changes and
// relaunches.
//
// ── WHAT IS AND IS NOT PROVABLE HERE ────────────────────────────────────────────────────────────
// jsdom has no layout engine, so "to the right side" cannot be asserted by measuring: every
// `getBoundingClientRect` reads 0 and a test that measured would pass vacuously
// (docs/jsdom-test-caveats.md). Two things ARE decidable and are what these rows use:
//
//   • BELOW  — document order. In a column layout the later sibling is the lower one, and it is
//              also the accessible reading order. The same idiom PresenceSlider.test.tsx uses for
//              "the slider sits above Send".
//   • RIGHT  — the style EXPRESSION (`marginLeft: auto` inside a flex row), which is the mechanism
//              that produces the alignment. Asserting the declaration is honest; asserting a
//              computed x-offset would not be.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AutoSendToggle, AUTO_SEND_LABEL, autoSendToggleTitle } from "./AutoSendToggle";
import { ComposeBox } from "./ComposeBox";
import { useUiStore } from "../../stores/uiStore";

beforeEach(() => {
  localStorage.clear();
  useUiStore.setState({ conciergeSendMode: "send", conciergeSpeakAutoSend: true });
});
afterEach(cleanup);

const toggle = () => screen.getByRole("switch", { name: AUTO_SEND_LABEL });
const queryToggle = () => screen.queryByRole("switch", { name: AUTO_SEND_LABEL });

describe("the switch itself", () => {
  it("reports its state on aria-checked, with a name that does not change", () => {
    // A toggle whose accessible NAME changes ("Turn on"/"Turn off") reads to a screen reader as a
    // different control appearing each time — so the state rides `aria-checked` and the name is the
    // constant label. Same rule PresenceSlider's pin follows.
    const { rerender } = render(<AutoSendToggle checked onChange={vi.fn()} />);
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    rerender(<AutoSendToggle checked={false} onChange={vi.fn()} />);
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(toggle().getAttribute("aria-label")).toBe(AUTO_SEND_LABEL);
  });

  it("flips to the OPPOSITE of what it currently shows", () => {
    const onChange = vi.fn();
    const { rerender } = render(<AutoSendToggle checked={false} onChange={onChange} />);
    fireEvent.click(toggle());
    expect(onChange).toHaveBeenLastCalledWith(true);

    rerender(<AutoSendToggle checked onChange={onChange} />);
    fireEvent.click(toggle());
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it("does not fire while disabled — an inert tray must not be settable", () => {
    const onChange = vi.fn();
    render(<AutoSendToggle checked onChange={onChange} disabled />);
    fireEvent.click(toggle());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows the word 'Auto-send', which is what the founder asked it to say", () => {
    render(<AutoSendToggle checked onChange={vi.fn()} />);
    expect(screen.getByText(AUTO_SEND_LABEL)).toBeTruthy();
  });

  it("is right-aligned by the mechanism that produces it, not by a measurement", () => {
    // See the header: jsdom cannot measure. `marginLeft: auto` in a flex row IS the alignment.
    render(<AutoSendToggle checked onChange={vi.fn()} />);
    expect(screen.getByTestId("auto-send-toggle").style.marginLeft).toBe("auto");
    expect(screen.getByTestId("auto-send-row").style.display).toBe("flex");
  });
});

describe("the tooltip states what OFF actually does", () => {
  it("names where the WORDS go, in both positions", () => {
    // THE DISTINCTION THE WHOLE FEATURE RESTS ON, and the one place it is stated to the user.
    // "Auto-send is off" alone would leave someone reasonably assuming Speak had stopped ending
    // their sentences too — it has not; only the dispatch is withheld.
    expect(autoSendToggleTitle(true)).toMatch(/sends on its own/i);
    expect(autoSendToggleTitle(false)).toMatch(/wait|composer/i);
    expect(autoSendToggleTitle(false)).toMatch(/press Send/i);
  });

  it("never promises that the countdown stops", () => {
    // A remedy string is an instruction the user will follow (AGENTS.md). Copy claiming the
    // countdown is disabled would describe a different feature from the one that shipped.
    expect(autoSendToggleTitle(false)).not.toMatch(/countdown|stops? listening|disabled/i);
  });
});

describe("where it appears — Speak only, below the tray", () => {
  const box = (extra: Record<string, unknown> = {}) =>
    render(
      <ComposeBox onSend={vi.fn()} onAttach={vi.fn()} onAutoSendChange={vi.fn()} {...extra} />,
    );

  it("is absent under Send and Push to talk — it is an affordance of the countdown", () => {
    box({ sendMode: "send" });
    expect(queryToggle()).toBeNull();
    cleanup();
    box({ sendMode: "ptt" });
    expect(queryToggle()).toBeNull();
  });

  it("appears under Speak", () => {
    box({ sendMode: "speak" });
    expect(queryToggle()).not.toBeNull();
  });

  it("sits BELOW the tray — document order is the column's reading order", () => {
    box({ sendMode: "speak" });
    const send = screen.getByRole("button", { name: "Send" });
    const row = screen.getByTestId("auto-send-row");
    // The tray's Send pill precedes the toggle row, i.e. the toggle follows the tray.
    expect(send.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("is HIDDEN, not broken, when the host wires no listener", () => {
    // A switch the engine ignores is worse than no switch: the user could move it and nothing would
    // change. Same posture `onSendModeChange` takes for the tray's own positions.
    render(<ComposeBox onSend={vi.fn()} onAttach={vi.fn()} sendMode="speak" />);
    expect(queryToggle()).toBeNull();
  });

  it("greys with an inert tray but keeps showing its value", () => {
    // Inert means a live PTY owns the keyboard — the setting was not lost, and a control that
    // vanished on a focus move would read as a bug.
    box({ sendMode: "speak", trayInert: true, autoSendOn: true });
    expect((toggle() as HTMLButtonElement).disabled).toBe(true);
    expect(toggle().getAttribute("aria-checked")).toBe("true");
  });
});

describe("it remembers the last position — the founder's actual ask", () => {
  // "And it remembers the last position I set it to. So if I set it to on, every time I go to the
  // speak slider, then it stays on. If I set it to off, every time it's off."
  it("survives leaving Speak and coming back", () => {
    const onAutoSendChange = (v: boolean) => useUiStore.getState().setConciergeSpeakAutoSend(v);
    const { rerender } = render(
      <ComposeBox
        onSend={vi.fn()}
        onAttach={vi.fn()}
        sendMode="speak"
        autoSendOn={useUiStore.getState().conciergeSpeakAutoSend}
        onAutoSendChange={onAutoSendChange}
      />,
    );
    fireEvent.click(toggle()); // set it OFF
    expect(useUiStore.getState().conciergeSpeakAutoSend).toBe(false);

    // Leave Speak — the toggle unmounts entirely...
    rerender(
      <ComposeBox
        onSend={vi.fn()}
        onAttach={vi.fn()}
        sendMode="send"
        autoSendOn={useUiStore.getState().conciergeSpeakAutoSend}
        onAutoSendChange={onAutoSendChange}
      />,
    );
    expect(queryToggle()).toBeNull();

    // ...and come back. It is still off, because the value never lived in the subtree.
    rerender(
      <ComposeBox
        onSend={vi.fn()}
        onAttach={vi.fn()}
        sendMode="speak"
        autoSendOn={useUiStore.getState().conciergeSpeakAutoSend}
        onAutoSendChange={onAutoSendChange}
      />,
    );
    expect(toggle().getAttribute("aria-checked")).toBe("false");
  });

  it("is PERSISTED, so it survives a relaunch — not merely a mode change", () => {
    // The store is `persist`-wrapped with a partialize that drops only TRANSIENT_UI_KEYS, so the
    // real assertion is that this key is NOT transient: it has to reach the written blob.
    useUiStore.getState().setConciergeSpeakAutoSend(false);
    const blob = localStorage.getItem("sparkle-ui");
    expect(blob, "the store must have written something").toBeTruthy();
    expect(JSON.parse(blob!).state.conciergeSpeakAutoSend).toBe(false);
  });

  it("defaults ON, because Speak has auto-sent since it shipped", () => {
    // NOT symmetric with `conciergeSendMode`'s default-off, deliberately: reaching this setting at
    // all requires having deliberately chosen Speak, which is the once-and-deliberately consent
    // that argument is about. Defaulting off would silently change what an existing user's chosen
    // mode does, with nothing on screen to explain why dictation stopped going out.
    localStorage.clear();
    expect(useUiStore.getInitialState().conciergeSpeakAutoSend).toBe(true);
  });
});
