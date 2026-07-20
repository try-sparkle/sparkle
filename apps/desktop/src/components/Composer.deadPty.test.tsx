// @vitest-environment jsdom
//
// Regression tests for the silent prompt drop: an agent whose PTY had died kept accepting
// prompts. submitPrompt resolved as success (writePty swallowed "no such pty"), and the
// composer had ALREADY written the prompt into both history stores — so the prompt showed up
// in the top breadcrumb bar and the agent never received it, with no error anywhere.
//
// Contract now: nothing is recorded until delivery actually succeeds, the draft comes back so
// the text is never lost, and a dead PTY asks the parent to restart the agent, with the prompt
// re-queued so the existing preparing→ready flush delivers it once the PTY is back.
import { createRef } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted above ordinary declarations, so the shared doubles have to be built in a
// vi.hoisted block for the factory to see them.
const { submitPrompt, PtyGoneError } = vi.hoisted(() => ({
  submitPrompt: vi.fn((_id: string, _text: string) => Promise.resolve()),
  PtyGoneError: class PtyGoneError extends Error {
    constructor(readonly id: string) {
      super(`no such pty: ${id}`);
      this.name = "PtyGoneError";
    }
  },
}));
vi.mock("../pty", () => ({
  submitPrompt,
  writePty: vi.fn(() => Promise.resolve()),
  PtyGoneError,
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

import { Composer, type ComposerApi } from "./Composer";
import { useDictationStore } from "../stores/dictationStore";
import { useUiStore } from "../stores/uiStore";
import { usePromptHistoryStore } from "../stores/promptHistoryStore";

beforeEach(() => {
  submitPrompt.mockReset();
  submitPrompt.mockResolvedValue(undefined);
  useDictationStore.setState({ insertTarget: null, enabled: true, status: "idle", interim: "" });
  useUiStore.getState().setComposerMinimized(false);
  usePromptHistoryStore.setState({ history: [] });
});
afterEach(() => cleanup());

function renderComposer(props: Record<string, unknown> = {}) {
  const apiRef = createRef<ComposerApi>();
  const onSubmitPrompt = vi.fn();
  const onRestartAgent = vi.fn();
  const view = render(
    <Composer
      agentId="a1"
      active
      disabled={false}
      apiRef={apiRef}
      onSubmitPrompt={onSubmitPrompt}
      onRestartAgent={onRestartAgent}
      {...props}
    />,
  );
  return { apiRef, onSubmitPrompt, onRestartAgent, view };
}

const textarea = () => screen.getByRole("textbox") as HTMLTextAreaElement;

async function typeAndSend(apiRef: React.RefObject<ComposerApi | null>, text: string) {
  await act(async () => {
    apiRef.current!.insertPrompt(text);
  });
  await act(async () => {
    screen.getByText("Send").click();
  });
}

describe("Composer — delivery to a dead PTY", () => {
  it("records prompt history when delivery succeeds", async () => {
    const { apiRef, onSubmitPrompt } = renderComposer();
    await typeAndSend(apiRef, "land it to main");
    expect(submitPrompt).toHaveBeenCalledWith("a1", "land it to main");
    expect(onSubmitPrompt).toHaveBeenCalledWith("land it to main", "land it to main");
    expect(usePromptHistoryStore.getState().history).toContain(
      "land it to main",
    );
  });

  it("does NOT record the prompt in the breadcrumb history when the PTY is dead", async () => {
    submitPrompt.mockRejectedValue(new PtyGoneError("a1"));
    const { apiRef, onSubmitPrompt } = renderComposer();
    await typeAndSend(apiRef, "land it to main");
    expect(onSubmitPrompt).not.toHaveBeenCalled();
  });

  it("does NOT record the prompt in the ghost-text history when the PTY is dead", async () => {
    submitPrompt.mockRejectedValue(new PtyGoneError("a1"));
    const { apiRef } = renderComposer();
    await typeAndSend(apiRef, "land it to main");
    expect(usePromptHistoryStore.getState().history).not.toContain(
      "land it to main",
    );
  });

  it("asks the parent to restart the agent when the PTY is dead", async () => {
    submitPrompt.mockRejectedValue(new PtyGoneError("a1"));
    const { apiRef, onRestartAgent } = renderComposer();
    await typeAndSend(apiRef, "land it to main");
    expect(onRestartAgent).toHaveBeenCalledTimes(1);
  });

  it("re-queues the prompt so the restarted agent receives it once its PTY is ready", async () => {
    submitPrompt.mockRejectedValue(new PtyGoneError("a1"));
    const { apiRef, view, onRestartAgent } = renderComposer({ preparing: false });
    await typeAndSend(apiRef, "land it to main");
    expect(onRestartAgent).toHaveBeenCalled();

    // The restart takes the agent through preparing → ready; the flush effect should deliver
    // the re-queued prompt exactly once, on the freshly spawned PTY.
    submitPrompt.mockResolvedValue(undefined);
    await act(async () => {
      view.rerender(
        <Composer
          agentId="a1"
          active
          disabled={false}
          apiRef={apiRef}
          onSubmitPrompt={vi.fn()}
          onRestartAgent={vi.fn()}
          preparing
        />,
      );
    });
    await act(async () => {
      view.rerender(
        <Composer
          agentId="a1"
          active
          disabled={false}
          apiRef={apiRef}
          onSubmitPrompt={vi.fn()}
          onRestartAgent={vi.fn()}
          preparing={false}
        />,
      );
    });
    await waitFor(() =>
      expect(submitPrompt.mock.calls.filter((c) => c[1] === "land it to main")).toHaveLength(2),
    );
  });

  it("surfaces an inline notice so the drop is never silent", async () => {
    submitPrompt.mockRejectedValue(new PtyGoneError("a1"));
    const { apiRef } = renderComposer();
    await typeAndSend(apiRef, "land it to main");
    expect(screen.getByRole("status").textContent ?? "").toMatch(/restart/i);
  });

  it("keeps the box clear while the re-queued prompt is in flight (no double send)", async () => {
    submitPrompt.mockRejectedValue(new PtyGoneError("a1"));
    const { apiRef } = renderComposer();
    await typeAndSend(apiRef, "land it to main");
    // The prompt lives in the pending queue, not the box — leaving it in both would send twice.
    expect(textarea().value).toBe("");
  });

  // Without a guard this loops forever: fail → queue + restart → flush → fail → queue + restart…
  // each cycle respawning the agent, while the notice keeps promising a delivery.
  it("gives up after one restart instead of respawning the agent forever", async () => {
    submitPrompt.mockRejectedValue(new PtyGoneError("a1"));
    const { apiRef, view, onRestartAgent } = renderComposer({ preparing: false });
    await typeAndSend(apiRef, "land it to main");
    expect(onRestartAgent).toHaveBeenCalledTimes(1);

    // Restart happens, PTY comes back "ready", the flush retries — and hits a dead PTY again.
    const rerenderWith = async (preparing: boolean) => {
      await act(async () => {
        view.rerender(
          <Composer
            agentId="a1"
            active
            disabled={false}
            apiRef={apiRef}
            onSubmitPrompt={vi.fn()}
            onRestartAgent={onRestartAgent}
            preparing={preparing}
          />,
        );
      });
    };
    await rerenderWith(true);
    await rerenderWith(false);

    // Exactly one restart attempt — the second failure must NOT trigger another respawn.
    await waitFor(() => expect(submitPrompt).toHaveBeenCalledTimes(2));
    expect(onRestartAgent).toHaveBeenCalledTimes(1);
    // And the text comes back to the user rather than sitting in a queue nobody will drain.
    await waitFor(() => expect(textarea().value).toBe("land it to main"));
    // …and the notice stops promising a delivery that is no longer coming.
    expect(screen.getByRole("status").textContent ?? "").not.toMatch(/sending your prompt/i);
  });

  // The latch must be scoped to a send, not to the component's lifetime: if a restart is requested
  // but the flush never fires, a stale latch would silently deny a later, unrelated prompt its own
  // restart attempt.
  it("gives a brand-new user send its own restart attempt", async () => {
    submitPrompt.mockRejectedValue(new PtyGoneError("a1"));
    const { apiRef, onRestartAgent } = renderComposer();
    await typeAndSend(apiRef, "first prompt");
    expect(onRestartAgent).toHaveBeenCalledTimes(1);
    // No flush happens (the agent never comes back ready), so the latch is still set. A fresh
    // user-initiated send must still get to try a restart.
    await typeAndSend(apiRef, "second prompt");
    expect(onRestartAgent).toHaveBeenCalledTimes(2);
  });

  // Every fresh user action gets its own attempt — the permission to restart belongs to the call,
  // not to a shared latch that a previous send could leave stale.
  it("gives repeated user sends their own restart attempt each time", async () => {
    submitPrompt.mockRejectedValue(new PtyGoneError("a1"));
    const { apiRef, onRestartAgent } = renderComposer();
    await typeAndSend(apiRef, "first prompt");
    await typeAndSend(apiRef, "second prompt");
    await typeAndSend(apiRef, "third prompt");
    expect(onRestartAgent).toHaveBeenCalledTimes(3);
  });

  it("restores the draft and does not restart when the failure is not a dead PTY", async () => {
    submitPrompt.mockRejectedValue(new Error("disk on fire"));
    const { apiRef, onRestartAgent, onSubmitPrompt } = renderComposer();
    await typeAndSend(apiRef, "land it to main");
    expect(onRestartAgent).not.toHaveBeenCalled();
    expect(onSubmitPrompt).not.toHaveBeenCalled();
    expect(textarea().value).toBe("land it to main");
  });
});
