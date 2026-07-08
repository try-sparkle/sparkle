// @vitest-environment jsdom
//
// Interaction tests for the "Voice controls" settings pane: the mic toggle mirrors the dictation
// store; the wake/stop word fields persist to settings (empty falls back to the default on blur);
// the Keep|Pause segmented control sets pauseOnSubmit; Reset restores the three voice defaults.
// Like AiFeaturesMenu.test, the real configActions run — the Tauri write rejects under jsdom but is
// caught, and the optimistic store update is what we assert on.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VoiceControlsMenu } from "./VoiceControlsMenu";
import { useSettingsStore } from "../stores/settingsStore";
import { useDictationStore } from "../stores/dictationStore";
import {
  DEFAULT_WAKE_WORD,
  DEFAULT_STOP_WORD,
  DEFAULT_PAUSE_ON_SUBMIT,
} from "../voice/voiceDefaults";

beforeEach(() => {
  useSettingsStore.setState({
    wakeWord: DEFAULT_WAKE_WORD,
    stopWord: DEFAULT_STOP_WORD,
    pauseOnSubmit: DEFAULT_PAUSE_ON_SUBMIT,
  });
  useDictationStore.setState({ enabled: false });
});
afterEach(() => cleanup());

describe("VoiceControlsMenu", () => {
  it("renders all five controls seeded from the stores", () => {
    render(<VoiceControlsMenu />);
    expect(screen.getByRole("checkbox", { name: /voice dictation/i })).toBeTruthy();
    expect((screen.getByLabelText("Wake word") as HTMLInputElement).value).toBe(DEFAULT_WAKE_WORD);
    expect((screen.getByLabelText("Stop word") as HTMLInputElement).value).toBe(DEFAULT_STOP_WORD);
    expect(screen.getByRole("button", { name: "Pause listening" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep listening" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /reset voice settings/i })).toBeTruthy();
  });

  it("the mic toggle reflects and flips dictationStore.enabled", () => {
    render(<VoiceControlsMenu />);
    const box = screen.getByRole("checkbox", { name: /voice dictation/i });
    expect(box.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(box);
    expect(useDictationStore.getState().enabled).toBe(true);
  });

  it("editing the wake word field persists it on blur", () => {
    render(<VoiceControlsMenu />);
    const input = screen.getByLabelText("Wake word") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Hey Jarvis" } });
    fireEvent.blur(input);
    expect(useSettingsStore.getState().wakeWord).toBe("Hey Jarvis");
  });

  it("a blank wake word falls back to the default on blur", () => {
    render(<VoiceControlsMenu />);
    const input = screen.getByLabelText("Wake word") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.blur(input);
    expect(useSettingsStore.getState().wakeWord).toBe(DEFAULT_WAKE_WORD);
    expect(input.value).toBe(DEFAULT_WAKE_WORD); // the field snaps back to the resolved value
  });

  it("the Keep|Pause segmented control sets pauseOnSubmit", () => {
    render(<VoiceControlsMenu />);
    fireEvent.click(screen.getByRole("button", { name: "Keep listening" }));
    expect(useSettingsStore.getState().pauseOnSubmit).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Pause listening" }));
    expect(useSettingsStore.getState().pauseOnSubmit).toBe(true);
  });

  it("the active submit-mode segment is marked pressed", () => {
    useSettingsStore.setState({ pauseOnSubmit: true });
    render(<VoiceControlsMenu />);
    expect(screen.getByRole("button", { name: "Pause listening" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "Keep listening" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("Reset restores wake/stop/pause to defaults (but not the mic toggle)", () => {
    useSettingsStore.setState({
      wakeWord: "Hey Jarvis",
      stopWord: "Jarvis, halt",
      pauseOnSubmit: false,
    });
    useDictationStore.setState({ enabled: true });
    render(<VoiceControlsMenu />);
    fireEvent.click(screen.getByRole("button", { name: /reset voice settings/i }));
    const s = useSettingsStore.getState();
    expect(s.wakeWord).toBe(DEFAULT_WAKE_WORD);
    expect(s.stopWord).toBe(DEFAULT_STOP_WORD);
    expect(s.pauseOnSubmit).toBe(DEFAULT_PAUSE_ON_SUBMIT);
    expect(useDictationStore.getState().enabled).toBe(true); // mic untouched by reset
  });
});
