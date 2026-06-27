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
  useDictationStore.setState({ insertTarget: null, enabled: true, status: "idle", interim: "" });
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

describe("Composer — auto-grow sizing baseline", () => {
  // Regression guard for the composer-height bug (dictation crept the box taller on every
  // utterance and a send never shrank it). Root cause was the height measurement reading the
  // textarea's flex-stretched height instead of its content; the fix measures with
  // align-self:flex-start + a 1-row textarea so an empty/single-line draft resolves to the snap
  // rest height. jsdom has no layout engine (offsetHeight/scrollHeight are 0), so the measurement
  // math itself is verified against a real engine; here we just pin the 1-row baseline that makes
  // a fresh/just-sent composer collapse to its default rather than the textarea's 2-row default.
  it("renders the textarea with a single-row auto-grow baseline", () => {
    renderComposer();
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(ta.rows).toBe(1);
  });
});

describe("Composer — placeholder reflects audio state", () => {
  // The mic-hot copy keys off ACTUAL capture (status === "listening"), not the armed/mute
  // intent (`enabled`) — see the audioActive regression test below.
  it("invites the user to just start talking while capture is actually live", () => {
    act(() => useDictationStore.setState({ enabled: true, status: "listening" }));
    renderComposer();
    const body = document.body.textContent ?? "";
    expect(body).toContain("I'm listening, so just start talking.");
    expect(body).toContain("Send it"); // the teal→cyan gradient stop cue
    expect(body).toContain("start typing here instead");
    expect(body).not.toContain("Hey Sparkle");
  });

  it("keeps the mic-hot copy on focus (it subsumes the typing hint)", () => {
    act(() => useDictationStore.setState({ enabled: true, status: "listening" }));
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
    act(() => useDictationStore.setState({ enabled: false, status: "idle" }));
    renderComposer();
    const body = document.body.textContent ?? "";
    expect(body).toContain("Hey Sparkle");
    expect(body).not.toContain("I'm listening, so just start talking.");
    expect(body).not.toContain("Send it"); // the gradient cue is mic-hot-only
  });

  // Regression (issue 2): armed but not actually capturing (focus-paused) keeps `enabled` true
  // while `status` is "idle". The composer must NOT claim "I'm listening" then — it falls back to
  // the wake-word copy, since nothing is actually being captured.
  it("does NOT claim it's listening when armed but capture is paused (enabled, status idle)", () => {
    act(() => useDictationStore.setState({ enabled: true, status: "idle" }));
    renderComposer();
    const body = document.body.textContent ?? "";
    expect(body).toContain("Hey Sparkle");
    expect(body).not.toContain("I'm listening, so just start talking.");
  });

  it("shows the muted focused typing hint only when the mic is muted", () => {
    act(() => useDictationStore.setState({ enabled: false, status: "idle" }));
    renderComposer();
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.mouseDown(ta);
    fireEvent.focus(ta);
    expect(document.activeElement).toBe(ta);
    const body = document.body.textContent ?? "";
    expect(body).toContain("or type your command here");
  });

  // Regression (issue 1): a live cloud interim preview paints into the same top-left slot as the
  // rich placeholder while `value` is still empty. The placeholder must be suppressed so the two
  // never overlap into garbled, double-painted text.
  it("hides the placeholder while a live interim preview is streaming", () => {
    act(() => useDictationStore.setState({ enabled: true, status: "listening", interim: "" }));
    renderComposer();
    act(() => useDictationStore.getState().setInterim("hello world"));
    const body = document.body.textContent ?? "";
    // The streaming words show (in the ghost mirror)…
    expect(screen.getByText("hello world")).toBeTruthy();
    // …but neither placeholder co-renders on top of them.
    expect(body).not.toContain("I'm listening, so just start talking.");
    expect(body).not.toContain("Hey Sparkle");
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
