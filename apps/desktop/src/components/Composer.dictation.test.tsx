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
  useDictationStore.setState({ insertTarget: null, enabled: true, interim: "" });
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

  it("shows the live cloud interim transcript as a muted preview, then clears it", () => {
    renderComposer();
    act(() => useDictationStore.getState().setInterim("hello wor"));
    // The in-progress phrase is rendered (in the ghost mirror) so the user sees words stream in.
    expect(screen.getByText("hello wor")).toBeTruthy();
    // When the segment finalizes the preview is cleared (the committed text lands in the box).
    act(() => useDictationStore.getState().setInterim(""));
    expect(screen.queryByText("hello wor")).toBeNull();
  });

  it("renders the interim preview ONLY in the active pane (no leak across mounted composers)", () => {
    // Two composers mounted at once (the real multi-agent layout). Like committed dictated text,
    // the live interim preview must appear only in the active/enabled pane.
    render(
      <>
        <Composer agentId="active" active disabled={false} onSubmitPrompt={vi.fn()} />
        <Composer agentId="hidden" active={false} disabled={false} onSubmitPrompt={vi.fn()} />
      </>,
    );
    act(() => useDictationStore.getState().setInterim("leaky words"));
    // Exactly one pane paints the preview — the active one.
    expect(screen.getAllByText("leaky words")).toHaveLength(1);
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

describe("Composer — placeholder reflects audio state", () => {
  it("invites the user to just start talking while the mic is hot", () => {
    act(() => useDictationStore.setState({ enabled: true }));
    renderComposer();
    const body = document.body.textContent ?? "";
    expect(body).toContain("I'm listening, so just start talking.");
    expect(body).toContain("Send it"); // the teal→cyan gradient stop cue
    expect(body).toContain("start typing here instead");
    expect(body).not.toContain("Hey Sparkle");
  });

  it("keeps the mic-hot copy on focus (it subsumes the typing hint)", () => {
    act(() => useDictationStore.setState({ enabled: true }));
    renderComposer();
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    // Actually focus the box (mouseDown flips `focused`, focus moves activeElement) so the test
    // exercises a real focus state change rather than passing tautologically.
    fireEvent.mouseDown(ta);
    fireEvent.focus(ta);
    expect(document.activeElement).toBe(ta);
    const body = document.body.textContent ?? "";
    // Mic-hot copy stays put on focus; the muted focused hint must NOT appear.
    expect(body).toContain("I'm listening, so just start talking.");
    expect(body).not.toContain("or type your command here");
  });

  it("falls back to the wake-word prompt when the mic is muted", () => {
    act(() => useDictationStore.setState({ enabled: false }));
    renderComposer();
    const body = document.body.textContent ?? "";
    expect(body).toContain("Hey Sparkle");
    expect(body).not.toContain("I'm listening, so just start talking.");
    expect(body).not.toContain("Send it"); // the gradient cue is mic-hot-only
  });

  it("shows the muted focused typing hint only when the mic is muted", () => {
    act(() => useDictationStore.setState({ enabled: false }));
    renderComposer();
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.mouseDown(ta);
    fireEvent.focus(ta);
    expect(document.activeElement).toBe(ta);
    const body = document.body.textContent ?? "";
    expect(body).toContain("or type your command here");
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
