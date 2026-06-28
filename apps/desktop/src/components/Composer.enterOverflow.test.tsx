// @vitest-environment jsdom
//
// Enter-key hand-off to the terminal: pressing Enter in an EMPTY composer should forward Enter to
// the terminal (onEnterOverflow) so the user can confirm the highlighted menu choice — while Enter
// with text still sends, and Shift+Enter still inserts a newline. Mirrors the boundary mocks from
// Composer.insertPrompt.test.tsx.
import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const submitPrompt = vi.fn((..._a: unknown[]) => Promise.resolve());
vi.mock("../pty", () => ({ submitPrompt: (...a: unknown[]) => submitPrompt(...a) }));
vi.mock("../screenshot", () => ({ captureScreenRegion: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// Trial meter: always allow sends so the send() path isn't gated in tests.
vi.mock("../services/trialMeter", () => ({
  trialSendAllowed: () => true,
  recordTrialSend: vi.fn(() => Promise.resolve()),
}));

import { Composer } from "./Composer";
import { useDictationStore } from "../stores/dictationStore";
import { useUiStore } from "../stores/uiStore";
import { usePromptHistoryStore } from "../stores/promptHistoryStore";

beforeEach(() => {
  submitPrompt.mockClear();
  useDictationStore.setState({ insertTarget: null, enabled: true, status: "idle", interim: "" });
  useUiStore.getState().setComposerMinimized(false);
  usePromptHistoryStore.setState({ history: [] });
});
afterEach(() => cleanup());

function renderComposer() {
  const onEnterOverflow = vi.fn();
  const onSubmitPrompt = vi.fn();
  const inputRef = createRef<HTMLTextAreaElement>();
  render(
    <Composer
      agentId="a1"
      active
      disabled={false}
      inputRef={inputRef}
      onSubmitPrompt={onSubmitPrompt}
      onEnterOverflow={onEnterOverflow}
    />,
  );
  return { onEnterOverflow, onSubmitPrompt };
}

const textarea = () => screen.getByRole("textbox") as HTMLTextAreaElement;

describe("Composer — Enter hand-off to the terminal", () => {
  it("forwards Enter to the terminal when the composer is empty (and does not send)", () => {
    const { onEnterOverflow, onSubmitPrompt } = renderComposer();
    fireEvent.keyDown(textarea(), { key: "Enter" });
    expect(onEnterOverflow).toHaveBeenCalledTimes(1);
    expect(onSubmitPrompt).not.toHaveBeenCalled();
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  it("sends (does not forward) when the composer has text", () => {
    const { onEnterOverflow } = renderComposer();
    fireEvent.change(textarea(), { target: { value: "hello" } });
    fireEvent.keyDown(textarea(), { key: "Enter" });
    expect(onEnterOverflow).not.toHaveBeenCalled();
    expect(submitPrompt).toHaveBeenCalledTimes(1);
  });

  it("does not forward NOR send while an IME composition is active (full no-op)", () => {
    const { onEnterOverflow, onSubmitPrompt } = renderComposer();
    fireEvent.keyDown(textarea(), { key: "Enter", isComposing: true });
    expect(onEnterOverflow).not.toHaveBeenCalled();
    expect(onSubmitPrompt).not.toHaveBeenCalled();
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  it("Shift+Enter neither sends nor forwards (native newline)", () => {
    const { onEnterOverflow } = renderComposer();
    fireEvent.keyDown(textarea(), { key: "Enter", shiftKey: true });
    expect(onEnterOverflow).not.toHaveBeenCalled();
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  it("with no handler wired, empty Enter is a no-op (legacy behavior)", () => {
    const onSubmitPrompt = vi.fn();
    render(<Composer agentId="a2" active disabled={false} onSubmitPrompt={onSubmitPrompt} />);
    fireEvent.keyDown(textarea(), { key: "Enter" });
    expect(submitPrompt).not.toHaveBeenCalled();
  });
});

// Quiet the unused-import lint for `act` in case future cases need it.
void act;
