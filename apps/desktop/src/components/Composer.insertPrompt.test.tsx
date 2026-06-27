// @vitest-environment jsdom
//
// Wiring tests for the Composer imperative `insertPrompt` API used by the pinned-prompt
// "Send to Composer" action: replace-only-if-empty, append-on-a-new-line otherwise, and the
// un-minimize side effect. Mirrors the boundary mocks from Composer.dictation.test.tsx.
import { createRef } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../pty", () => ({ submitPrompt: vi.fn(() => Promise.resolve()) }));
vi.mock("../screenshot", () => ({ captureScreenRegion: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { Composer, type ComposerApi } from "./Composer";
import { useDictationStore } from "../stores/dictationStore";
import { useUiStore } from "../stores/uiStore";
import { usePromptHistoryStore } from "../stores/promptHistoryStore";

beforeEach(() => {
  useDictationStore.setState({ insertTarget: null, enabled: true, status: "idle", interim: "" });
  useUiStore.getState().setComposerMinimized(false);
  usePromptHistoryStore.setState({ history: [] });
});
afterEach(() => cleanup());

function renderComposer() {
  const apiRef = createRef<ComposerApi>();
  const inputRef = createRef<HTMLTextAreaElement>();
  render(
    <Composer
      agentId="a1"
      active
      disabled={false}
      inputRef={inputRef}
      apiRef={apiRef}
      onSubmitPrompt={vi.fn()}
    />,
  );
  return { apiRef };
}

const textarea = () => screen.getByRole("textbox") as HTMLTextAreaElement;

describe("Composer — insertPrompt", () => {
  it("replaces the box when it is empty", () => {
    const { apiRef } = renderComposer();
    act(() => apiRef.current!.insertPrompt("a fresh prompt"));
    expect(textarea().value).toBe("a fresh prompt");
  });

  it("appends on a new line when the box already has a draft", () => {
    const { apiRef } = renderComposer();
    act(() => apiRef.current!.insertPrompt("draft in progress"));
    act(() => apiRef.current!.insertPrompt("the reused prompt"));
    expect(textarea().value).toBe("draft in progress\nthe reused prompt");
  });

  it("does not double the newline when the draft already ends in one", () => {
    const { apiRef } = renderComposer();
    act(() => apiRef.current!.insertPrompt("draft\n"));
    act(() => apiRef.current!.insertPrompt("more"));
    expect(textarea().value).toBe("draft\nmore");
  });

  it("un-minimizes the composer so the inserted text is visible", () => {
    const { apiRef } = renderComposer();
    act(() => useUiStore.getState().setComposerMinimized(true));
    act(() => apiRef.current!.insertPrompt("x"));
    expect(useUiStore.getState().composerMinimized).toBe(false);
  });
});
