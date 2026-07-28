// @vitest-environment jsdom
//
// The compose box's contract: Send and ⌘/Ctrl+Enter both submit trimmed text and clear the
// box (empty text never submits), and each attach button reports its kind.
//
// There is no mic here any more. The box used to own one, beside Send, and this file used to pin
// its gold live-border and its onMicToggle callback. The column's single mic is now the ring in the
// header — see ConciergeColumn.oneMic.test.tsx, which counts them so nothing puts a second one back.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { C, ON_GOLD_FILL } from "../../theme/colors";
import { ComposeBox } from "./ComposeBox";
import { useUiStore } from "../../stores/uiStore";

afterEach(() => cleanup());

function setup(
  over: {
    onSend?: (text: string) => void | Promise<boolean>;
  } = {},
) {
  const onSend = vi.fn(over.onSend);
  const onAttach = vi.fn();
  const { onSend: _drop, ...rest } = over;
  const view = render(
    <ComposeBox onSend={onSend} onAttach={onAttach} {...rest} />,
  );
  return { onSend, onAttach, container: view.container };
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

  // The gold pair used to be pinned twice here, once on Send and once on the live mic beside it.
  // Only Send is left to carry it; the header ring paints from its own tokens (LogoWaveform).
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

// THE BOX NAMES NO DESTINATION (PRD/sparkle/concierge-auto-routing.md §1). The placeholder used to
// name one ("Talk to Sparkle…" / "Prompt <agent>…"), which the send-target toggle made true.
// Routing removed both the toggle and the destination-before-you-type, so these guard the reversal:
// nothing in the box may name a target, and the shortcut the placeholder never carried has to stay
// reachable — including to a screen reader, which a hover-only tooltip is not.
//
// NOTE the box is no longer VISUALLY empty. It now paints a rich placeholder overlay (the user was
// shown both renderings and chose that one) — but the native `placeholder` attribute stays "", and
// that is what the first test below still pins: the overlay and a native placeholder would
// otherwise double-render the same slot. What the overlay actually says, and that it still names no
// destination, is covered in ComposeBox.placeholder.test.tsx.
describe("ComposeBox — the box names no destination", () => {
  it("leaves the NATIVE placeholder empty (the styled overlay owns that slot)", () => {
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

  // Still on Send, NOT in the placeholder. The rich overlay gave the slot room for a "(\u2318\u21a9 to send)"
  // tail again; it was removed deliberately in PR #631 and must stay removed.
  it("keeps the \u2318\u21a9 hint on Send rather than in the placeholder copy", () => {
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
  it("stays screen-reader usable: the textarea keeps a non-visible label", () => {
    setup();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeTruthy();
  });
});

describe("ComposeBox — attachments", () => {
  it("each revealed attach action reports its kind", () => {
    const { onAttach } = setup();
    fireEvent.mouseEnter(screen.getByTestId("concierge-attach"));
    fireEvent.click(screen.getByRole("button", { name: "Screenshot" }));
    fireEvent.mouseEnter(screen.getByTestId("concierge-attach"));
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    expect(onAttach.mock.calls).toEqual([["screenshot"], ["files"]]);
  });
});

// THE ATTACH AFFORDANCE IS ONE ICON THAT EXPANDS, and every assertion here is about a way that can
// go wrong rather than about the happy path alone.
//
// The row was three permanently-visible labelled buttons (Screenshot / Image / Files) over a
// compose box designed to look empty. The founder asked for the single paperclip to stay single at
// rest and to REVEAL its two actions on hover — not a click-then-menu, which makes you commit a
// click before it will say what is behind the icon.
//
// Hover alone would be unusable by keyboard and by touch, so the group opens on `hovered ||
// pinned` (focus/click), and the two inputs are independent on purpose: neither may close what the
// other holds open. The collapsed actions carry `hidden`, which drops them from the accessibility
// tree and the tab order TOGETHER — the failure mode being guarded against is an invisible button
// that is still focusable, or an announced one that isn't reachable.
describe("ComposeBox — the attach affordance expands from one icon", () => {
  const clip = () => screen.getByRole("button", { name: "Attach" });
  const group = () => screen.getByTestId("concierge-attach");
  const actions = () => document.getElementById("concierge-attach-actions") as HTMLElement;

  it("rests as a SINGLE paperclip — neither action is shown, announced or focusable", () => {
    setup();
    expect(clip().getAttribute("aria-expanded")).toBe("false");
    expect(actions().hidden).toBe(true);
    expect(actions().style.display).toBe("none");
    // `hidden` is what testing-library reads for accessibility, so these two are the announced-
    // and-reachable check, not a repeat of the style assertion above.
    expect(screen.queryByRole("button", { name: "Screenshot" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Upload" })).toBeNull();
  });

  it("hovering reveals BOTH actions — a screenshot and a file upload", () => {
    setup();
    fireEvent.mouseEnter(group());
    expect(clip().getAttribute("aria-expanded")).toBe("true");
    expect(actions().hidden).toBe(false);
    expect(screen.getByRole("button", { name: "Screenshot" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Upload" })).toBeTruthy();
    fireEvent.mouseLeave(group());
    expect(actions().hidden).toBe(true);
  });

  it("is reachable by KEYBOARD — focus alone opens it, with no pointer involved", () => {
    const { onAttach } = setup();
    fireEvent.focus(clip());
    expect(clip().getAttribute("aria-expanded")).toBe("true");
    const upload = screen.getByRole("button", { name: "Upload" });
    // Tabbing BETWEEN the paperclip and an action blurs the clip; that must not collapse the group
    // out from under the very keystroke that is walking into it.
    fireEvent.blur(clip(), { relatedTarget: upload });
    fireEvent.focus(upload);
    expect(actions().hidden).toBe(false);
    fireEvent.click(upload);
    expect(onAttach).toHaveBeenCalledWith("files");
  });

  it("closes on Escape and hands focus back to the paperclip", () => {
    setup();
    // REAL focus, not fireEvent.focus: the handback is guarded on where focus actually IS (it must
    // not yank the caret out of the textarea — see close() in ComposeBox), and fireEvent.focus
    // dispatches the event without moving document.activeElement, so it cannot model that.
    act(() => clip().focus());
    // Tab on into an action, so Escape has somewhere real to reclaim focus FROM — this is the path
    // where the handback matters, since closing takes that button out of the tree under it.
    act(() => screen.getByRole("button", { name: "Screenshot" }).focus());
    fireEvent.keyDown(group(), { key: "Escape" });
    expect(clip().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(clip());
  });

  it("does NOT grab focus that was never inside the group (roborev 54233)", () => {
    // WebKit on macOS does not focus a <button> on click, so the ordinary path is "caret in the
    // textarea, user clicks Screenshot". Reclaiming focus unconditionally would drag the caret out
    // of the app's only composer to attach a file.
    const { onAttach } = setup();
    act(() => box().focus());
    fireEvent.mouseEnter(group());
    fireEvent.click(screen.getByRole("button", { name: "Screenshot" }));
    expect(onAttach).toHaveBeenCalledWith("screenshot");
    expect(actions().hidden).toBe(true);
    expect(document.activeElement).toBe(box());
  });

  it("Escape closes it with the POINTER still over the group (roborev 54158)", () => {
    // The real Escape path, and the one the keyboard-only test above cannot see. `open = hovered ||
    // pinned`, so clearing `pinned` alone leaves hover holding the group open — and the pointer IS
    // still over it, because the focus almost always arrived by clicking the paperclip. Escape then
    // appears to do nothing, and the group is un-closable by keyboard until the mouse physically
    // leaves.
    setup();
    fireEvent.mouseEnter(group());
    act(() => clip().focus());
    fireEvent.keyDown(group(), { key: "Escape" });
    expect(actions().hidden).toBe(true);
    expect(clip().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(clip());
  });

  it("a dismissed group re-arms on the next real mouseenter, not on a stale hover", () => {
    // Escape clears hover, which is what "I dismissed this" has to mean — but it must not disarm
    // hover for good, or the paperclip would be mouse-dead for the rest of the session.
    setup();
    fireEvent.mouseEnter(group());
    fireEvent.keyDown(group(), { key: "Escape" });
    expect(actions().hidden).toBe(true);
    fireEvent.mouseLeave(group());
    fireEvent.mouseEnter(group());
    expect(actions().hidden).toBe(false);
  });

  it("tabbing OUT closes it, but the mouse cannot close what focus is holding open", () => {
    setup();
    fireEvent.mouseEnter(group());
    fireEvent.focus(screen.getByRole("button", { name: "Screenshot" }));
    // Pointer leaves while focus is still inside → stays open (the keyboard user is mid-choice).
    fireEvent.mouseLeave(group());
    expect(actions().hidden).toBe(false);
    // Focus leaves for something outside the group → now it closes.
    fireEvent.blur(screen.getByRole("button", { name: "Screenshot" }), {
      relatedTarget: screen.getByRole("textbox", { name: "Message" }),
    });
    expect(actions().hidden).toBe(true);
  });

  it("clicking the paperclip OPENS and never collapses it under the cursor", () => {
    setup();
    // The touch/click path: no hover, one tap opens.
    fireEvent.click(clip());
    expect(actions().hidden).toBe(false);
    // And a second click — the case a toggle would get wrong, since hover has already opened it by
    // the time the pointer can click and mouseenter cannot re-fire without leaving first.
    fireEvent.mouseEnter(group());
    fireEvent.click(clip());
    expect(actions().hidden).toBe(false);
  });

  it("collapses back to one icon once an action is chosen", () => {
    const { onAttach } = setup();
    fireEvent.focus(clip());
    fireEvent.click(screen.getByRole("button", { name: "Screenshot" }));
    expect(onAttach).toHaveBeenCalledWith("screenshot");
    expect(actions().hidden).toBe(true);
  });

  it("hands focus back to the paperclip when an action is chosen (roborev 54233)", () => {
    // The consequence of closing BOTH inputs on the action path: a mouse click focuses the button
    // (mousedown focus), so the actions container gets `hidden` + display:none WHILE focus is
    // inside it. Focus falls to <body> — the user loses their place in the compose box, and for a
    // moment a focused element sits in a hidden subtree. Hover used to keep the group mounted on
    // this path, so the button stayed valid; clearing `hovered` is what exposed it.
    const { onAttach } = setup();
    fireEvent.mouseEnter(group());
    const upload = screen.getByRole("button", { name: "Upload" });
    act(() => upload.focus()); // what a click does anywhere mousedown-focus is in effect
    fireEvent.click(upload);
    expect(onAttach).toHaveBeenCalledWith("files");
    expect(actions().hidden).toBe(true);
    expect(document.activeElement).toBe(clip());
    // …and the handback must not RE-PIN what the click just closed — the same trap the Escape path
    // needs `reclaimingFocus` for, since this refocus also lands inside the group.
    expect(clip().getAttribute("aria-expanded")).toBe("false");
  });

  it("collapses on the MOUSE path too — the one that can get stuck (roborev 54158)", () => {
    // The primary path, and the worst one to leave open: choosing an action hands the OS a picker,
    // which takes the pointer away without necessarily delivering a mouseleave to the webview. With
    // `hovered` still latched true the row stays expanded after the picker dismisses, with no
    // gesture left that would close it.
    const { onAttach } = setup();
    fireEvent.mouseEnter(group());
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    expect(onAttach).toHaveBeenCalledWith("files");
    expect(actions().hidden).toBe(true);
    expect(clip().getAttribute("aria-expanded")).toBe("false");
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

// ── The initial-text report (roborev 53836) ────────────────────────────────────────────────────
//
// The box tells the host what it STARTS WITH, once, on mount. That report is the only signal that
// distinguishes A NEW BOX from a re-registration of the insert callback, and ConciergeHost needs
// the difference: it holds latches that aim the NEXT send (the capture window's Chat ❯ forces the
// message to Sparkle, skipping the auto-router), and a latch belongs to the words that set it. A
// remount resets `text` — those words are gone — so the latch has to go with them, or the next
// thing the user types is aimed somewhere they never chose.
//
// `registerInsert(null)` cannot carry that signal: the registration effect re-runs on any identity
// change of `registerInsert` and its cleanup fires first, so a LIVE re-registration is also a null.
// Clearing the aim there silently broke capture-Chat outright.
describe("ComposeBox — the initial-text report", () => {
  it("reports its starting text on mount, so a fresh box reads as empty", () => {
    const onTextEdit = vi.fn();
    render(
      <ComposeBox
        onSend={vi.fn()}
        onAttach={vi.fn()}
        onTextEdit={onTextEdit}
      />,
    );
    expect(onTextEdit).toHaveBeenCalledWith("");
  });

  it("reports once per mount, not on every edit or re-render", () => {
    const onTextEdit = vi.fn();
    const { rerender } = render(
      <ComposeBox
        onSend={vi.fn()}
        onAttach={vi.fn()}
        onTextEdit={onTextEdit}
      />,
    );
    expect(onTextEdit).toHaveBeenCalledTimes(1);
    // A re-render is not a new box — the words in it are still the user's.
    rerender(
      <ComposeBox
        onSend={vi.fn()}
        onAttach={vi.fn()}
        onTextEdit={onTextEdit}
      />,
    );
    expect(onTextEdit).toHaveBeenCalledTimes(1);
    // A hand edit still reports, through the textarea's own onChange.
    fireEvent.change(box(), { target: { value: "typed" } });
    expect(onTextEdit).toHaveBeenLastCalledWith("typed");
  });

  it("a REMOUNT reports again — that is the signal a stale aim is retired by", () => {
    const onTextEdit = vi.fn();
    const props = {
      onSend: vi.fn(),
      onAttach: vi.fn(),
      onTextEdit,
    };
    render(<ComposeBox {...props} />);
    fireEvent.change(box(), { target: { value: "a draft" } });
    onTextEdit.mockClear();
    cleanup();
    render(<ComposeBox {...props} />);
    // The new box is empty, and says so — which is what retires the latch aimed at the old words.
    expect(onTextEdit).toHaveBeenCalledWith("");
  });
});
