// @vitest-environment jsdom
//
// The compose box's contract: Send and ⌘/Ctrl+Enter both submit trimmed text and clear the
// box (empty text never submits), the mic reports onMicToggle, and each attach button
// reports its kind.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { C, ON_GOLD_FILL } from "../../theme/colors";
import { ComposeBox } from "./ComposeBox";
import { useUiStore } from "../../stores/uiStore";

afterEach(() => cleanup());

function setup(
  over: {
    micLive?: boolean;
    onSend?: (text: string) => void | Promise<boolean>;
  } = {},
) {
  const onSend = vi.fn(over.onSend);
  const onMicToggle = vi.fn();
  const onAttach = vi.fn();
  const { onSend: _drop, ...rest } = over;
  const view = render(
    <ComposeBox onSend={onSend} onMicToggle={onMicToggle} onAttach={onAttach} {...rest} />,
  );
  return { onSend, onMicToggle, onAttach, container: view.container };
}

// "Message", not "Message Sparkle": the box no longer knows where a send goes — the host routes it.
const box = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;


// THE OPAQUE-GOLD PAIR, pinned at the loudest gold in the shell. Two ways this regresses and
// neither fails anything else: the Send button falls back to the amber STATUS token (which is what
// it painted before the gold token existed), or the fill goes to the LITERAL BRAND.gold — a
// cross-theme constant that has no visible edge on light mode's near-white column, and this button
// has no border, so that contrast IS its edge. The fill's floor lives in
// theme/chromeContrast.test.ts; this pins that the button actually reaches for it.
//
// `expect(send.style.background).toBe(C.goldFill)` is the WHOLE guard, and it is enough: the themed
// token serializes as the `var()` string and BOTH fallbacks serialize as rgb() triples, so an
// equality against the token already excludes them.
//
// This used to carry two extra `not.toBe(rgb(...))` lines naming the fallbacks. They were dead —
// once the equality above has constrained the value, a following negative on the same value cannot
// fail under any code change. (Routing them through `rgb()` fixed their comparison FORM, which is
// why the earlier round's fix looked like it worked; it did not make them able to fail.) A dead
// assertion dressed as a guard is worse than no assertion: it makes the case look broader than it
// is, so the next reader stops looking. The value the token resolves TO is pinned separately, in
// theme/chromeContrast.test.ts ("dark keeps the prototype's own gold") and by the index.css mirror.
describe("ComposeBox — the Send button carries the concierge gold", () => {
  it("uses the THEMED goldFill + its paired ink, never amber and never the literal gold", () => {
    setup();
    const send = screen.getByRole("button", { name: "Send" });
    expect(send.style.background).toBe(C.goldFill);
    expect(send.style.color).toBe(ON_GOLD_FILL);
  });

  it("the LIVE mic borders in the same themed gold, with the gold-hot glyph", () => {
    setup({ micLive: true });
    const mic = screen.getByRole("button", { name: "Talk to Sparkle" });
    expect(mic.style.borderColor).toBe(C.goldFill);
    expect(mic.style.color).toBe(C.goldHotInk);
  });
});

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

// THE BOX IS EMPTY (PRD/sparkle/concierge-auto-routing.md §1). The placeholder used to name the
// destination ("Talk to Sparkle…" / "Prompt <agent>…"), which the send-target toggle made true.
// Routing removed both the toggle and the destination-before-you-type, so these guard the reversal:
// nothing in the box may name a target, and the shortcut the placeholder never carried has to stay
// reachable — including to a screen reader, which a hover-only tooltip is not.
describe("ComposeBox — the empty box", () => {
  it("shows no placeholder text at all", () => {
    setup();
    expect(box().getAttribute("placeholder")).toBe("");
  });

  it("carries no send-target toggle", () => {
    setup();
    expect(screen.queryByTestId("send-target-toggle")).toBeNull();
  });

  it("names no destination anywhere in the box", () => {
    const { container } = setup();
    expect(container.textContent).not.toMatch(/talk to sparkle|prompt /i);
  });

  it("keeps the \u2318\u21a9 hint on Send now that the placeholder is gone", () => {
    setup();
    expect(screen.getByRole("button", { name: "Send" }).getAttribute("title")).toContain("\u2318\u21a9");
  });

  // A tooltip alone hides the shortcut from keyboard and touch users (roborev 53016).
  it("declares the send shortcut to assistive tech, not just on hover", () => {
    setup();
    const keys = screen.getByRole("button", { name: "Send" }).getAttribute("aria-keyshortcuts");
    expect(keys).toContain("Meta+Enter");
    expect(keys).toContain("Control+Enter");
  });

  it("dropping the hint did NOT drop the shortcut — \u2318Enter still sends", () => {
    const { onSend } = setup();
    fireEvent.change(box(), { target: { value: "still works" } });
    fireEvent.keyDown(box(), { key: "Enter", metaKey: true });
    expect(onSend).toHaveBeenCalledWith("still works");
  });

  // Empty to look at, not empty to a screen reader.
  it("stays screen-reader usable: the textarea and the mic keep non-visible labels", () => {
    setup();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Talk to Sparkle" })).toBeTruthy();
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
