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
import { C } from "../../theme/colors";
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
  it("uses the THEMED goldFill as its STROKE, never amber and never the literal gold", () => {
    // ── THE ASSERTION MOVED FROM FILL TO STROKE, BY THE FOUNDER'S SPEC ──────────────────────────
    // Send used to be pinned as `background === C.goldFill` — solid at REST. Under the unified tray
    // rule (fill matches stroke = acting right now) that made Send the one position permanently
    // claiming to be mid-send. His words: "the send button should also be a lighter color than the
    // stroke until I hit the send button to send it."
    //
    // What this row was really guarding is unchanged and still guarded: the THEMED token, not amber
    // and not a literal — it just lives on the border now, with the fill a tint of it. The
    // click-fills-it half is pinned in SendModeTray.test.tsx, which can drive the click.
    setup();
    const send = screen.getByRole("button", { name: "Send" });
    expect(send.style.borderColor).toBe(C.goldFill);
    expect(send.style.background).toContain("color-mix");
    expect(send.style.background).toContain(C.goldFill);
    expect(send.style.background).not.toBe(send.style.borderColor);
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

  // ── THE SEND CHORD IS DECIDED BY voice/sendMode, AND THIS BOX ASKS IT ────────────────────────
  //
  // The tray PAINTS a keycap chip from `chicletFor` and this textarea HANDLES the keystroke, in two
  // different files. `chordSends` exists so they cannot disagree — but it shipped exported, unit
  // tested, and wired to NOTHING, while this handler still spelled out `Enter && (metaKey ||
  // ctrlKey)` with no knowledge of the mode. The rows below are the wiring, not the rule.
  it("sends on ⌘↩ and ⌃↩, and not on a bare ↩", () => {
    const { onSend } = setup();
    fireEvent.change(box(), { target: { value: "ship it" } });
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box(), { key: "Enter", metaKey: true });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("sends ⌘↩ in Push to talk too — EXACTLY ONCE, not once per path", () => {
    // REVERSED by the founder (sparkle-u81cz): "I can tap the command key to have what I typed
    // send, but I could also type command enter, and that would also send it." This row used to
    // assert the refusal.
    //
    // THIS BOX ONLY OWNS HALF THE GESTURE. `usePushToTalk` and `useSendMode` live in ConciergeHost,
    // which `setup()` does not mount, so no hold machinery exists here and this row can only prove
    // that the COMPOSER submits once. The other half — that releasing ⌘ does not then fire the
    // hold's own send, which is the stacking the old refusal existed to prevent — is only
    // observable where both paths are live, and is asserted in ConciergeHost.pushToTalk.test.tsx
    // ("⌘↩ sends ONCE"). An earlier version of this row fired a `Meta` keyup here and claimed it
    // caught the guard being removed; it could not, because there was nothing listening for it.
    const { onSend } = setup({ sendMode: "ptt" } as never);
    fireEvent.change(box(), { target: { value: "ship it" } });
    fireEvent.keyDown(box(), { key: "Enter", metaKey: true });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("…and still sends on ⌘↩ in Speak, so the chord works in every position", () => {
    // The other half. A change that stopped honouring ⌘↩ anywhere would break the shortcut for
    // everyone, and the row above (which now expects a send) could not tell the difference on its
    // own between "push-to-talk gained the chord" and "the chord is unconditional and untested".
    const { onSend } = setup({ sendMode: "speak" } as never);
    fireEvent.change(box(), { target: { value: "ship it" } });
    fireEvent.keyDown(box(), { key: "Enter", metaKey: true });
    expect(onSend).toHaveBeenCalledTimes(1);
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
  it("each attach action reports its kind, with no reveal step in front of it", () => {
    const { onAttach } = setup();
    // THE MISSING SETUP LINES ARE THE ASSERTION. This used to need a `mouseEnter` on the group
    // before EITHER `getByRole` could resolve — the buttons did not exist until something revealed
    // them. Both are queried straight off the first render now.
    fireEvent.click(screen.getByRole("button", { name: "Screenshot" }));
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    expect(onAttach.mock.calls).toEqual([["screenshot"], ["files"]]);
  });
});

// TWO ALWAYS-VISIBLE BUTTONS, SIDE BY SIDE (bead sparkle-f8bjx).
//
// The history of this row in three steps: three permanently-visible LABELLED buttons (Screenshot /
// Image / Files) → ONE paperclip that expanded into two of them on hover or focus → these two,
// permanently visible, drawn as icons with no word.
//
// WHY THE DISCLOSURE WENT. Screenshot is the founder's highest-frequency composer action, and the
// expansion made it cost two interactions (reveal, then choose) where it had cost one. The chrome
// it was saving turns out not to be spent: the resting row is 2 controls where the EXPANDED row
// was 3.
//
// EVERY ASSERTION BELOW IS CHOSEN TO FAIL AGAINST THE PAPERCLIP. That matters more than usual
// here, because the happy-path "clicking Screenshot calls onAttach('screenshot')" passed perfectly
// well against the old form too — it just needed a `mouseEnter` first. A test that keeps the
// reveal step and asserts the outcome would go green on both designs and pin neither.
describe("ComposeBox — the attach row is two permanent buttons", () => {
  const group = () => screen.getByTestId("concierge-attach");
  const shot = () => screen.getByRole("button", { name: "Screenshot" });
  const upload = () => screen.getByRole("button", { name: "Upload" });

  it("shows BOTH actions at rest — nothing hovered, focused or clicked", () => {
    setup();
    // `getByRole` reads the accessibility tree, so this is the announced-and-reachable check, not
    // merely a painted one. Against the paperclip both of these threw: the actions carried
    // `hidden`, which took them out of the a11y tree and the tab order together.
    expect(shot()).toBeTruthy();
    expect(upload()).toBeTruthy();
  });

  it("has no expanding trigger left in front of them", () => {
    setup();
    // The paperclip itself. Its removal is the founder's actual ask, so it gets its own assertion
    // rather than being implied by the two above.
    expect(screen.queryByRole("button", { name: "Attach" })).toBeNull();
    // …and the disclosure container it controlled, whose `hidden` attribute was the old form's
    // whole state model. A leftover empty container would mean the expansion was only styled away.
    expect(document.getElementById("concierge-attach-actions")).toBeNull();
    // Nothing announces an expanded/collapsed state any more, because there is none to report.
    expect(group().querySelector("[aria-expanded]")).toBeNull();
  });

  it("names each button WITHOUT drawing a word — tooltip and accessible name agree", () => {
    setup();
    // The founder's line: "it doesn't have to say screenshot, it could say screenshot on a mouse
    // over." So the word exists only as `title` (what a pointer user gets) and `aria-label` (what a
    // screen-reader user gets), and the two must be the same string or the two users are being told
    // about different controls.
    for (const [el, name] of [[shot(), "Screenshot"], [upload(), "Upload"]] as const) {
      expect(el.textContent).toBe("");
      expect(el.getAttribute("title")).toBe(name);
      expect(el.getAttribute("aria-label")).toBe(name);
    }
  });

  it("draws a glyph in each, so a wordless button is not just an empty box", () => {
    setup();
    // Pairs with the assertion above: `textContent === ""` is satisfied by a button that renders
    // nothing at all, which would be a strictly worse control than the one it replaced.
    expect(shot().querySelector("svg")).toBeTruthy();
    expect(upload().querySelector("svg")).toBeTruthy();
  });

  it("leaves the caret in the draft — pressing one is not a focus move", () => {
    // WebKit does not focus a <button> on click without Full Keyboard Access, so the ordinary path
    // is "caret in the textarea, user clicks Screenshot". The old form had elaborate machinery to
    // avoid stealing that caret while collapsing itself; the new one must simply never take it.
    const { onAttach } = setup();
    act(() => box().focus());
    fireEvent.click(shot());
    expect(onAttach).toHaveBeenCalledWith("screenshot");
    expect(document.activeElement).toBe(box());
  });

  it("both stay pressable after one is used — nothing collapses behind the picker", () => {
    // The old row closed itself on choose, which is why "click Screenshot, then click Upload"
    // needed a second reveal between them. It must not now.
    const { onAttach } = setup();
    fireEvent.click(shot());
    fireEvent.click(upload());
    fireEvent.click(shot());
    expect(onAttach.mock.calls).toEqual([["screenshot"], ["files"], ["screenshot"]]);
  });

  it("the row may SHRINK AND WRAP — the founder's actual narrow-column clipping", () => {
    // ── roborev 57278, carried forward ──────────────────────────────────────────────────────────
    // Assertable in jsdom despite the no-layout-engine limit, because these are inline styles — the
    // declarations ARE the behaviour. The group is a flex item of the toolbar, so its own default
    // `min-width: auto` refuses to go below its min-content and the toolbar's `flex-wrap` cannot
    // break INSIDE it; that is how the row ran past the column's right edge.
    setup();
    expect(group().style.minWidth).toBe("0");
    expect(group().style.flexWrap).toBe("wrap");
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
