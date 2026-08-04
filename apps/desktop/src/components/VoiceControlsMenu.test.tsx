// @vitest-environment jsdom
//
// The "Voice controls" settings pane, AFTER the wake word was retired.
//
// The founder, with a screenshot of this pane: "We're no longer doing the wake word. This section
// should be removed. We now have push to talk or speak buttons; SPEAK SHOULD BE ALWAYS ON."
//
// This file used to drive five controls — the always-listening mic toggle, the wake-word and
// stop-word fields, the Keep|Pause segment, and Reset. All five are gone, so the assertions here
// are mostly about ABSENCE, and that shape needs care: a test that only checks things are missing
// passes just as well against a component that renders nothing or fails to mount. Every negative
// below is therefore paired with a POSITIVE anchor (the replacement copy is on screen), and the
// removals assert on the things that used to be CONTROLS (by role), not merely on strings.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { VoiceControlsMenu } from "./VoiceControlsMenu";
import { SEND_MODE_LABEL, TALK_KEY_GLYPH } from "../voice/sendMode";

afterEach(() => cleanup());

const bodyText = () => document.body.textContent ?? "";

describe("VoiceControlsMenu — the wake-word section is gone", () => {
  it("mounts and explains the tray (the positive anchor every absence below leans on)", () => {
    render(<VoiceControlsMenu />);
    expect(screen.getByText("How Sparkle listens")).toBeTruthy();
    // Each tray position is named, from the SHARED label table rather than retyped here — the pane
    // describes a control it does not own, so it must not be able to call it something else.
    for (const label of Object.values(SEND_MODE_LABEL)) {
      expect(bodyText()).toContain(label);
    }
  });

  it("offers no wake-word or stop-word field", () => {
    render(<VoiceControlsMenu />);
    // As CONTROLS, not just as text: the fields were `<input>`s with these accessible names.
    expect(screen.queryByLabelText("Wake word")).toBeNull();
    expect(screen.queryByLabelText("Stop word")).toBeNull();
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
  });

  it("offers no always-listening checkbox, submit-mode segment, or reset button", () => {
    render(<VoiceControlsMenu />);
    // The pane is now pure explanation and has no controls at all, which is the strongest available
    // form of "the checkbox, the segment and the reset button are gone". SettingCheckbox and the
    // Keep|Pause segments all rendered as <button>s, so this covers every one of them.
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryAllByRole("group")).toHaveLength(0);
    expect(bodyText()).not.toContain("always-listening");
    expect(bodyText()).not.toContain("Keep listening");
    expect(bodyText()).not.toContain("Pause listening");
  });

  it("never names a wake word or a stop word", () => {
    render(<VoiceControlsMenu />);
    expect(bodyText()).not.toMatch(/wake/i);
    expect(bodyText()).not.toMatch(/Hey Sparkle/i);
    expect(bodyText()).not.toMatch(/Sparkle,\s*(pause|stop)/i);
  });

  it("says Speak is continuous — the founder's actual requirement", () => {
    render(<VoiceControlsMenu />);
    expect(bodyText()).toMatch(/on continuously/i);
    // …and that push-to-talk is a HOLD, named through the shared glyph rather than a literal, so
    // this copy and the tray's own keycap chiclet cannot name different keys.
    expect(bodyText()).toContain(`Hold ${TALK_KEY_GLYPH}`);
  });
});
