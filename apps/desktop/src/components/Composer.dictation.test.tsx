// @vitest-environment jsdom
//
// Component-wiring tests for the Composer (). The pure policies
// (drag math, toggle keys, ghost-text, persistence) are unit-tested elsewhere;
// this covers the stateful React glue that those can't reach — specifically the
// dictation active-effect wiring (where the dictation bug actually lived) and the
// send path. Runs under jsdom (the rest of the desktop suite stays on node).
import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Tauri / native boundaries the Composer touches at mount or on send.
const submitPrompt = vi.fn((_id: string, _text: string) => Promise.resolve());
vi.mock("../pty", () => ({
  submitPrompt: (id: string, text: string) => submitPrompt(id, text),
}));
vi.mock("../screenshot", () => ({ captureScreenRegion: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { Composer } from "./Composer";
import { useDictationStore } from "../stores/dictationStore";
import { useUiStore } from "../stores/uiStore";
import { usePromptHistoryStore } from "../stores/promptHistoryStore";

beforeEach(() => {
  submitPrompt.mockClear();
  useDictationStore.setState({ insertTarget: null });
  useUiStore.getState().setComposerMinimized(false);
  usePromptHistoryStore.setState({ history: [] });
});
afterEach(() => cleanup());

function renderComposer(props: Partial<Parameters<typeof Composer>[0]> = {}) {
  const onSubmitPrompt = vi.fn();
  const inputRef = createRef<HTMLTextAreaElement>();
  render(
    <Composer
      agentId="a1"
      active
      disabled={false}
      inputRef={inputRef}
      onSubmitPrompt={onSubmitPrompt}
      {...props}
    />,
  );
  return { onSubmitPrompt, inputRef };
}

describe("Composer — dictation wiring", () => {
  it("registers the active pane as the dictation insert target", () => {
    renderComposer();
    expect(typeof useDictationStore.getState().insertTarget).toBe("function");
  });

  it("does NOT register when the pane is inactive", () => {
    renderComposer({ active: false });
    expect(useDictationStore.getState().insertTarget).toBeNull();
  });

  it("does NOT register when disabled (PTY not spawned yet)", () => {
    renderComposer({ disabled: true });
    expect(useDictationStore.getState().insertTarget).toBeNull();
  });

  it("appends dictated text into the box and restores it from minimized", () => {
    renderComposer();
    act(() => useUiStore.getState().setComposerMinimized(true));

    act(() => useDictationStore.getState().insert("hello world"));
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(ta.value).toBe("hello world");
    // Dictated text must be visible — a minimized composer pops back open.
    expect(useUiStore.getState().composerMinimized).toBe(false);

    // A second utterance appends with a separating space (not a clobber).
    act(() => useDictationStore.getState().insert("again"));
    expect(ta.value).toBe("hello world again");
  });

  it("clears its insert registration on unmount (no clobber of a newer pane)", () => {
    const { unmount } = render(
      <Composer agentId="a1" active disabled={false} onSubmitPrompt={vi.fn()} />,
    );
    expect(typeof useDictationStore.getState().insertTarget).toBe("function");
    act(() => unmount());
    expect(useDictationStore.getState().insertTarget).toBeNull();
  });
});

describe("Composer — send wiring", () => {
  it("Enter sends the typed text, forwards to the PTY, clears, and records history", async () => {
    const { onSubmitPrompt } = renderComposer();
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;

    fireEvent.change(ta, { target: { value: "do the thing" } });
    fireEvent.keyDown(ta, { key: "Enter" });

    await waitFor(() => expect(onSubmitPrompt).toHaveBeenCalledWith("do the thing"));
    expect(submitPrompt).toHaveBeenCalledWith("a1", "do the thing");
    expect(ta.value).toBe("");
    expect(usePromptHistoryStore.getState().history).toContain("do the thing");
  });

  it("Shift+Enter does NOT send (newline insert)", () => {
    const { onSubmitPrompt } = renderComposer();
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;

    fireEvent.change(ta, { target: { value: "line one" } });
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: true });

    expect(onSubmitPrompt).not.toHaveBeenCalled();
    expect(submitPrompt).not.toHaveBeenCalled();
    expect(ta.value).toBe("line one");
  });

  it("does not send an empty/whitespace-only prompt", () => {
    const { onSubmitPrompt } = renderComposer();
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;

    fireEvent.change(ta, { target: { value: "   " } });
    fireEvent.keyDown(ta, { key: "Enter" });

    expect(onSubmitPrompt).not.toHaveBeenCalled();
    expect(submitPrompt).not.toHaveBeenCalled();
  });
});
