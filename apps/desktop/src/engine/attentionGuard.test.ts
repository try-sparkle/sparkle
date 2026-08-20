// @vitest-environment jsdom
//
// The predicate behind "don't take me out of my terminal". Every case is asserted in BOTH
// directions, because a guard that holds on everything is indistinguishable from a correct one when
// you only ever assert the holds — and it would silently end focus-on-spawn, which the founder
// explicitly did NOT ask for ("when he is NOT in a terminal, jumping to the new agent is useful").
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { attentionHold, mayTakeAttention } from "./attentionGuard";
import { TERMINAL_SURFACE_ATTR } from "../voice/dictationFocus";

function mount(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("attentionHold", () => {
  it("holds when the caret is inside a terminal surface", () => {
    // The real DOM shape: `Terminal.tsx` puts the marker on the wrapper and xterm's hidden textarea
    // is what actually holds the caret, several levels down.
    const host = mount(
      `<div ${TERMINAL_SURFACE_ATTR}><div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div></div>`,
    );
    host.querySelector<HTMLTextAreaElement>("textarea")!.focus();

    expect(attentionHold()).toBe("terminal");
    expect(mayTakeAttention()).toBe(false);
  });

  it("holds on xterm's own classes even without our wrapper", () => {
    // Belt and braces, matching `TERMINAL_SELECTOR`: a terminal mounted before its wrapper resolves
    // still owns the keyboard, and answering "nothing is held" for it is the bug.
    const host = mount(`<textarea class="xterm-helper-textarea"></textarea>`);
    host.querySelector<HTMLTextAreaElement>("textarea")!.focus();

    expect(attentionHold()).toBe("terminal");
  });

  it("holds on a compose box that is HALF-TYPED — the mounted concierge's box is a textarea", () => {
    const host = mount(`<textarea></textarea>`);
    const ta = host.querySelector<HTMLTextAreaElement>("textarea")!;
    ta.value = "half a message";
    ta.focus();

    expect(attentionHold()).toBe("unsent-text");
  });

  // THE PAIRED DIRECTION, and the one that keeps the guard honest. A focused-but-empty compose box
  // is the app's steady state; holding on it would mean a spawn asked for from the concierge — the
  // overwhelmingly common case — never lands the founder anywhere again.
  it("does NOT hold on a focused but EMPTY compose box", () => {
    const host = mount(`<textarea></textarea>`);
    host.querySelector<HTMLTextAreaElement>("textarea")!.focus();

    expect(attentionHold()).toBeNull();
    expect(mayTakeAttention()).toBe(true);
  });

  it("does not hold on whitespace-only text either", () => {
    const host = mount(`<textarea></textarea>`);
    const ta = host.querySelector<HTMLTextAreaElement>("textarea")!;
    ta.value = "   \n  ";
    ta.focus();

    expect(attentionHold()).toBeNull();
  });

  it("does not hold when nothing is focused (the caret is on <body>)", () => {
    mount(`<button>press me</button>`);
    expect(attentionHold()).toBeNull();
  });

  it("does not hold on a focused BUTTON — clicking chrome is not typing", () => {
    const host = mount(`<button>press me</button>`);
    host.querySelector("button")!.focus();
    expect(attentionHold()).toBeNull();
  });

  // ORDER IS LOAD-BEARING. A focused xterm IS a textarea, and its value is ALWAYS empty (xterm
  // forwards keystrokes to the PTY; the half-typed command lives in the shell's line buffer). Read
  // the text clause first and this whole file's subject answers "nothing is held".
  it("reports `terminal`, not `unsent-text`, for a terminal's own helper textarea", () => {
    const host = mount(
      `<div ${TERMINAL_SURFACE_ATTR}><textarea class="xterm-helper-textarea"></textarea></div>`,
    );
    const ta = host.querySelector<HTMLTextAreaElement>("textarea")!;
    ta.value = "leftover";
    ta.focus();

    expect(attentionHold()).toBe("terminal");
  });

  // ══ OS FOCUS IS NOT PART OF THE ANSWER ═══════════════════════════════════════════════════════
  // Table-driven over BOTH axes at once, because that is the only shape with power here. Asserting
  // "an inactive window with the caret nowhere holds nothing" on its own is VACUOUS: it is equally
  // true of the implementation that DID consult `hasFocus()`, so it cannot distinguish them and
  // merely restates the `<body>` case above (roborev 65385 caught exactly that).
  //
  // The discriminating cell is `blurred × terminal`. A re-added `hasFocus()` clause fails only
  // there — which is the founder's own complaint deferred by one window activation: leave the caret
  // in a terminal, cmd-tab away mid-turn, and the spawn lands unhindered. While the window is
  // inactive `activeElement` is not stale state; it is where the keyboard returns.
  describe.each([
    { osFocus: true, label: "focused" },
    { osFocus: false, label: "in the background" },
  ])("with the window $label", ({ osFocus }) => {
    let spy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      spy = vi.spyOn(document, "hasFocus").mockReturnValue(osFocus);
    });
    afterEach(() => spy.mockRestore());

    it("HOLDS when the caret is in a terminal", () => {
      const host = mount(
        `<div ${TERMINAL_SURFACE_ATTR}><textarea class="xterm-helper-textarea"></textarea></div>`,
      );
      host.querySelector<HTMLTextAreaElement>("textarea")!.focus();
      expect(attentionHold()).toBe("terminal");
      expect(mayTakeAttention()).toBe(false);
    });

    it("holds NOTHING when the caret is nowhere", () => {
      mount(`<button>press me</button>`);
      expect(attentionHold()).toBeNull();
      expect(mayTakeAttention()).toBe(true);
    });
  });

  // The injected-`doc` parameter, which `mayTakeAttention(doc)` also exposes — covered here so it is
  // not left resting on the `undefined` case alone.
  it("answers about an INJECTED document rather than the live one", () => {
    const el = document.createElement("div");
    el.setAttribute(TERMINAL_SURFACE_ATTR, "");
    const shim = { activeElement: el } as unknown as Document;
    expect(attentionHold(shim)).toBe("terminal");
    expect(mayTakeAttention(shim)).toBe(false);

    // …and the same shim with an ordinary element holds nothing, so the assertion above is about
    // the element it was handed rather than about anything ambient.
    const plain = { activeElement: document.createElement("div") } as unknown as Document;
    expect(attentionHold(plain)).toBeNull();
  });

  it("is safe with no document at all — a non-DOM caller may ask", () => {
    expect(attentionHold(undefined)).toBeNull();
  });
});
