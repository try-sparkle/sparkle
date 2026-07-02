// @vitest-environment jsdom
//
// "Instant composer" while an agent is starting: with `preparing` true the agent's PTY isn't up
// yet, so a send must be QUEUED (not written to a non-existent PTY, not dropped) and then delivered
// exactly once the moment `preparing` clears. This is what lets the user click New Build Agent and
// start typing immediately instead of waiting on the workspace spin-up. Boundary mocks mirror
// Composer.enterOverflow.test.tsx.
import { createRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const submitPrompt = vi.fn((..._a: unknown[]) => Promise.resolve());
vi.mock("../pty", () => ({
  submitPrompt: (...a: unknown[]) => submitPrompt(...a),
  writePty: vi.fn(() => Promise.resolve()),
}));
vi.mock("../screenshot", () => ({ captureScreenRegion: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
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

const textarea = () => screen.getByRole("textbox") as HTMLTextAreaElement;

function renderComposer(preparing: boolean) {
  const onSubmitPrompt = vi.fn();
  const inputRef = createRef<HTMLTextAreaElement>();
  const utils = render(
    <Composer
      agentId="a1"
      active
      preparing={preparing}
      inputRef={inputRef}
      onSubmitPrompt={onSubmitPrompt}
    />,
  );
  return { onSubmitPrompt, utils };
}

describe("Composer — instant composer while the agent is starting (preparing)", () => {
  it("lets the user type while preparing (textarea is not disabled)", () => {
    renderComposer(true);
    expect(textarea().disabled).toBe(false);
    fireEvent.change(textarea(), { target: { value: "draft while starting" } });
    expect(textarea().value).toBe("draft while starting");
  });

  it("QUEUES a send while preparing (does not touch the PTY) then flushes once ready", () => {
    const { onSubmitPrompt, utils } = renderComposer(true);
    fireEvent.change(textarea(), { target: { value: "first prompt" } });
    fireEvent.keyDown(textarea(), { key: "Enter" });

    // Queued, not delivered: nothing hit the PTY yet, and the box cleared (feels sent).
    expect(submitPrompt).not.toHaveBeenCalled();
    expect(onSubmitPrompt).not.toHaveBeenCalled();
    expect(textarea().value).toBe("");

    // PTY becomes ready → the queued prompt is delivered exactly once, carrying the typed text.
    utils.rerender(
      <Composer agentId="a1" active preparing={false} onSubmitPrompt={onSubmitPrompt} />,
    );
    expect(submitPrompt).toHaveBeenCalledTimes(1);
    expect(onSubmitPrompt).toHaveBeenCalledTimes(1);
    expect(onSubmitPrompt.mock.calls[0]?.[0]).toContain("first prompt");
  });

  it("does not deliver anything when preparing clears but nothing was queued", () => {
    const { onSubmitPrompt, utils } = renderComposer(true);
    utils.rerender(
      <Composer agentId="a1" active preparing={false} onSubmitPrompt={onSubmitPrompt} />,
    );
    expect(submitPrompt).not.toHaveBeenCalled();
    expect(onSubmitPrompt).not.toHaveBeenCalled();
  });

  it("delivers a normal send immediately when NOT preparing", () => {
    renderComposer(false);
    fireEvent.change(textarea(), { target: { value: "hello" } });
    fireEvent.keyDown(textarea(), { key: "Enter" });
    expect(submitPrompt).toHaveBeenCalledTimes(1);
  });

  it("merges two pre-ready sends so neither is lost, flushing once when ready", () => {
    const { onSubmitPrompt, utils } = renderComposer(true);
    fireEvent.change(textarea(), { target: { value: "one" } });
    fireEvent.keyDown(textarea(), { key: "Enter" });
    fireEvent.change(textarea(), { target: { value: "two" } });
    fireEvent.keyDown(textarea(), { key: "Enter" });
    expect(submitPrompt).not.toHaveBeenCalled();

    utils.rerender(
      <Composer agentId="a1" active preparing={false} onSubmitPrompt={onSubmitPrompt} />,
    );
    // One delivery carrying BOTH messages (merged), not two separate PTY writes.
    expect(submitPrompt).toHaveBeenCalledTimes(1);
    const display = onSubmitPrompt.mock.calls[0]?.[0] as string;
    expect(display).toContain("one");
    expect(display).toContain("two");
  });
});
