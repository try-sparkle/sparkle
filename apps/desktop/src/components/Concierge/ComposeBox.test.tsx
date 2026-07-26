// @vitest-environment jsdom
//
// The compose box's contract: Send and ⌘/Ctrl+Enter both submit trimmed text and clear the
// box (empty text never submits), the mic reports onMicToggle, and each attach button
// reports its kind.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposeBox } from "./ComposeBox";
import { useUiStore } from "../../stores/uiStore";
import type { ConciergeSendState } from "./types";

afterEach(() => cleanup());

function setup(
  over: {
    micLive?: boolean;
    send?: ConciergeSendState;
    onToggleSendTarget?: () => void;
    onSend?: (text: string) => void | Promise<boolean>;
  } = {},
) {
  const onSend = vi.fn(over.onSend);
  const onMicToggle = vi.fn();
  const onAttach = vi.fn();
  const { onSend: _drop, ...rest } = over;
  render(
    <ComposeBox onSend={onSend} onMicToggle={onMicToggle} onAttach={onAttach} {...rest} />,
  );
  return { onSend, onMicToggle, onAttach };
}

const box = () => screen.getByRole("textbox", { name: "Message Sparkle" }) as HTMLTextAreaElement;

describe("ComposeBox — submit", () => {
  it("Send click submits the trimmed text and clears the box", () => {
    const { onSend } = setup();
    fireEvent.change(box(), { target: { value: "  approve the deploy  " } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("approve the deploy");
    expect(box().value).toBe("");
  });

  it("⌘Enter submits (and clears) too", () => {
    const { onSend } = setup();
    fireEvent.change(box(), { target: { value: "ship it" } });
    fireEvent.keyDown(box(), { key: "Enter", metaKey: true });
    expect(onSend).toHaveBeenCalledWith("ship it");
    expect(box().value).toBe("");
  });

  it("Ctrl+Enter submits on non-mac keyboards", () => {
    const { onSend } = setup();
    fireEvent.change(box(), { target: { value: "ship it" } });
    fireEvent.keyDown(box(), { key: "Enter", ctrlKey: true });
    expect(onSend).toHaveBeenCalledWith("ship it");
  });

  it("plain Enter does NOT submit (multiline stays possible)", () => {
    const { onSend } = setup();
    fireEvent.change(box(), { target: { value: "line one" } });
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("empty / whitespace-only text never submits", () => {
    const { onSend } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.change(box(), { target: { value: "   " } });
    fireEvent.keyDown(box(), { key: "Enter", metaKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe("ComposeBox — mic + attachments", () => {
  it("the mic button reports onMicToggle and reflects micLive as aria-pressed", () => {
    const { onMicToggle } = setup({ micLive: true });
    const mic = screen.getByRole("button", { name: "Talk to Sparkle" });
    expect(mic.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(mic);
    expect(onMicToggle).toHaveBeenCalledTimes(1);
  });

  it("each attach button reports its kind", () => {
    const { onAttach } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Screenshot" }));
    fireEvent.click(screen.getByRole("button", { name: "Image" }));
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    expect(onAttach.mock.calls).toEqual([["screenshot"], ["image"], ["files"]]);
  });
});

// The box is the app's only composer, so it has to be able to aim at the selected agent as well
// as at Sparkle (CM-U7 — the removed AgentPane composer's job).
describe("ComposeBox — send target", () => {
  it("renders no target affordance when the host supplies no send state", () => {
    setup();
    expect(screen.queryByTestId("send-target-toggle")).toBeNull();
  });

  it("shows Sparkle as the target and reports a toggle click", () => {
    const onToggleSendTarget = vi.fn();
    setup({ send: { target: "sparkle", agentName: "CI Hardening" }, onToggleSendTarget });
    const toggle = screen.getByTestId("send-target-toggle") as HTMLButtonElement;
    expect(toggle.textContent).toContain("Sparkle");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(onToggleSendTarget).toHaveBeenCalledTimes(1);
  });

  it("names the agent (and relabels the textarea) while aimed at it", () => {
    setup({ send: { target: "agent", agentName: "CI Hardening" }, onToggleSendTarget: vi.fn() });
    const toggle = screen.getByTestId("send-target-toggle");
    expect(toggle.textContent).toContain("CI Hardening");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("textbox", { name: "Message CI Hardening" })).toBeTruthy();
  });

  it("is disabled with no agent to aim at (rather than offering a dead target)", () => {
    const onToggleSendTarget = vi.fn();
    setup({ send: { target: "sparkle" }, onToggleSendTarget });
    const toggle = screen.getByTestId("send-target-toggle") as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    fireEvent.click(toggle);
    expect(onToggleSendTarget).not.toHaveBeenCalled();
  });

  it("an 'agent' target with no agent name still renders (and reads as) Sparkle", () => {
    setup({ send: { target: "agent" }, onToggleSendTarget: vi.fn() });
    expect(screen.getByTestId("send-target-toggle").textContent).toContain("Sparkle");
    expect(screen.getByRole("textbox", { name: "Message Sparkle" })).toBeTruthy();
  });
});

// A failed send must not cost the user their words — the removed AgentPane composer restored the
// draft, and having to retype a paragraph is the worst outcome of a delivery failure.
describe("ComposeBox — draft survival", () => {
  it("restores the draft when the host reports the send failed", async () => {
    setup({ onSend: () => Promise.resolve(false) });
    fireEvent.change(box(), { target: { value: "a long careful prompt" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    // Cleared optimistically…
    expect(box().value).toBe("");
    // …then put back once the failure is known.
    await waitFor(() => expect(box().value).toBe("a long careful prompt"));
  });

  it("leaves the box empty when the send succeeded", async () => {
    setup({ onSend: () => Promise.resolve(true) });
    fireEvent.change(box(), { target: { value: "landed" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await Promise.resolve();
    expect(box().value).toBe("");
  });

  it("never clobbers text the user started typing while the send was in flight", async () => {
    let settle: (ok: boolean) => void = () => {};
    setup({ onSend: () => new Promise<boolean>((r) => (settle = r)) });
    fireEvent.change(box(), { target: { value: "first" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.change(box(), { target: { value: "something new" } });
    settle(false);
    await Promise.resolve();
    expect(box().value).toBe("something new");
  });

  it("treats a void return as 'assume it landed' (the chat path)", () => {
    setup({ onSend: () => undefined });
    fireEvent.change(box(), { target: { value: "to sparkle" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(box().value).toBe("");
  });
});

describe("ComposeBox — focus-on-request seam (roborev 46485-M)", () => {
  it("takes the caret when something requests compose focus", async () => {
    setup();
    expect(document.activeElement).not.toBe(box());
    act(() => useUiStore.getState().requestComposeFocus());
    await waitFor(() => expect(document.activeElement).toBe(box()));
  });

  it("re-focuses on a REPEAT request (the seq is a token, not a flag)", async () => {
    setup();
    act(() => useUiStore.getState().requestComposeFocus());
    await waitFor(() => expect(document.activeElement).toBe(box()));
    box().blur();
    act(() => useUiStore.getState().requestComposeFocus());
    await waitFor(() => expect(document.activeElement).toBe(box()));
  });

  it("a REMOUNT alone never steals focus, however many requests came before it", () => {
    // The seq is monotonic for the session, so a mount-time `seq > 0` check would yank the caret
    // out of the terminal on every remount of the concierge column (HMR, key change, collapse).
    act(() => useUiStore.getState().requestComposeFocus());
    cleanup();
    setup();
    expect(document.activeElement).not.toBe(box());
  });
});
