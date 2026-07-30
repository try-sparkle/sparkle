// @vitest-environment jsdom
// The pure half of "dictation follows focus": who owns the caret, and what that means for routing.
// No React, no Tauri — jsdom only for the DOM shapes, which is the point of keeping this module
// pure. The pragma above must stay on line 1: vitest reads the environment out of the FIRST comment
// block, and this suite builds real elements to run `closest` against.
import { describe, it, expect, afterEach } from "vitest";
import {
  classifyFocusOwner,
  dictationPauseReason,
  focusedTerminalAgentId,
  TERMINAL_AGENT_ATTR,
  TERMINAL_SURFACE_ATTR,
  type FocusOwner,
  type PauseReason,
} from "./dictationFocus";

/** Build a detached-but-attached DOM fragment and return the element to classify. */
function mount(html: string, selector: string): Element {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  const el = host.querySelector(selector);
  if (!el) throw new Error(`test fixture has no ${selector}`);
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("classifyFocusOwner", () => {
  it("nothing focused is NOT a terminal — the hands-free wake-word case must keep routing", () => {
    // The flagship flow is saying "Hey Sparkle …" with the caret nowhere. If a null activeElement
    // classified as anything pause-worthy, wake-word dictation would never route at all.
    expect(classifyFocusOwner(null)).toBe<FocusOwner>("other");
    expect(classifyFocusOwner(undefined)).toBe<FocusOwner>("other");
  });

  it("xterm's hidden helper textarea IS the terminal (this is what the field trace recorded)", () => {
    // ~/Library/Logs/…: `focus-trace: activeElement=textarea .xterm-helper-textarea` — the element
    // that actually holds the caret while a terminal has focus.
    const el = mount(`<textarea class="xterm-helper-textarea"></textarea>`, "textarea");
    expect(classifyFocusOwner(el)).toBe<FocusOwner>("terminal");
  });

  it("anything INSIDE an xterm surface is the terminal", () => {
    const el = mount(
      `<div class="xterm"><div class="xterm-screen"><span id="cell">$</span></div></div>`,
      "#cell",
    );
    expect(classifyFocusOwner(el)).toBe<FocusOwner>("terminal");
  });

  it("the app's own wrapper marks the terminal even with no xterm class present", () => {
    // The app-owned half of the match: xterm's class names are a vendor detail, this attribute is
    // ours. A major xterm bump that renames its classes must not silently un-pause dictation.
    const el = mount(
      `<div ${TERMINAL_SURFACE_ATTR}=""><div><input id="inner" /></div></div>`,
      "#inner",
    );
    expect(classifyFocusOwner(el)).toBe<FocusOwner>("terminal");
  });

  it("the composer, a dialog, a menu item and a plain button are all NOT terminals", () => {
    // SCOPE GUARD. These are exactly the targets the field trace also recorded (role=menuitem,
    // role=dialog, body). Pausing on them would kill wake-word dictation, which routes while the
    // caret is on none of them.
    const cases = [
      [`<textarea data-testid="compose-input"></textarea>`, "textarea"],
      [`<div role="dialog"><button id="x">OK</button></div>`, "#x"],
      [`<button role="menuitem" id="m">Item</button>`, "#m"],
      [`<button id="b">Send</button>`, "#b"],
      [`<div id="plain">text</div>`, "#plain"],
    ] as const;
    for (const [html, sel] of cases) {
      expect(classifyFocusOwner(mount(html, sel))).toBe<FocusOwner>("other");
    }
    expect(classifyFocusOwner(document.body)).toBe<FocusOwner>("other");
  });

  it("degrades to 'other' (routing stays ON) when the node can't be matched", () => {
    // A stale/foreign node without `closest`, or one whose closest throws, must not throw inside a
    // focus handler — and must not silently pause dictation forever either.
    expect(classifyFocusOwner({} as unknown as Element)).toBe<FocusOwner>("other");
    const hostile = {
      closest() {
        throw new Error("detached");
      },
    } as unknown as Element;
    expect(classifyFocusOwner(hostile)).toBe<FocusOwner>("other");
  });
});

describe("dictationPauseReason — the single precedence decision", () => {
  const base = (o: Partial<Parameters<typeof dictationPauseReason>[0]> = {}) => ({
    windowFocused: true,
    focusOwner: "other" as FocusOwner,
    enabled: true,
    ...o,
  });

  it("armed, focused window, caret outside a terminal → routable (null)", () => {
    expect(dictationPauseReason(base())).toBeNull();
  });

  it("the caret in a terminal pauses with the terminal reason", () => {
    expect(dictationPauseReason(base({ focusOwner: "terminal" }))).toBe<PauseReason>("terminal");
  });

  it("losing the window pauses with the window reason", () => {
    expect(dictationPauseReason(base({ windowFocused: false }))).toBe<PauseReason>("window");
  });

  it("WINDOW OUTRANKS TERMINAL — the caret stays in the terminal while the user is away", () => {
    // The precedence that decides which sentence the user reads. Clicking into a terminal and then
    // tabbing to another app leaves activeElement on the terminal; "you're in another window" is
    // the true and useful thing to say then, not "you're in a terminal".
    expect(dictationPauseReason(base({ windowFocused: false, focusOwner: "terminal" }))).toBe<PauseReason>(
      "window",
    );
  });

  it("a DISARMED mic is never 'paused' — not even in a terminal or an unfocused window", () => {
    // Two contradictory stories about one mic is the bug this whole module exists to kill: a mic
    // the user switched off must read as OFF, never as "paused, will resume".
    for (const windowFocused of [true, false]) {
      for (const focusOwner of ["terminal", "other"] as FocusOwner[]) {
        expect(dictationPauseReason({ enabled: false, windowFocused, focusOwner })).toBeNull();
      }
    }
  });

  it("is total and deterministic over every input combination", () => {
    for (const enabled of [true, false]) {
      for (const windowFocused of [true, false]) {
        for (const focusOwner of ["terminal", "other"] as FocusOwner[]) {
          const input = { enabled, windowFocused, focusOwner };
          const out = dictationPauseReason(input);
          expect(out === null || out === "window" || out === "terminal").toBe(true);
          expect(dictationPauseReason(input)).toBe(out);
        }
      }
    }
  });
});

describe("focusedTerminalAgentId", () => {
  // The resolver that aims a dictated phrase. Its failure mode is SILENT: returning null makes every
  // send refuse with "no terminal", which looks identical to dictation simply not working — so the
  // hidden-textarea case below is the one that has to be pinned, not the easy one.
  it("resolves through xterm's hidden helper textarea, which is what actually holds the caret", () => {
    const el = mount(
      `<div ${TERMINAL_SURFACE_ATTR}="" ${TERMINAL_AGENT_ATTR}="agent-7">
         <div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>
       </div>`,
      "textarea",
    ) as HTMLTextAreaElement;
    el.focus();
    // Guard the fixture itself: if focus() didn't take, a null result below would prove nothing.
    expect(document.activeElement).toBe(el);
    expect(focusedTerminalAgentId()).toBe("agent-7");
  });

  it("picks the terminal the caret is IN when two agents' panes are both mounted", () => {
    // Every agent pane stays mounted and stacked, so "some terminal exists" is always true. The
    // answer must come from the caret, not from whichever pane the query happens to hit first.
    const host = document.createElement("div");
    host.innerHTML =
      `<div ${TERMINAL_SURFACE_ATTR}="" ${TERMINAL_AGENT_ATTR}="agent-a"><textarea id="a"></textarea></div>` +
      `<div ${TERMINAL_SURFACE_ATTR}="" ${TERMINAL_AGENT_ATTR}="agent-b"><textarea id="b"></textarea></div>`;
    document.body.appendChild(host);
    (host.querySelector("#b") as HTMLTextAreaElement).focus();
    expect(focusedTerminalAgentId()).toBe("agent-b");
  });

  it("is null when the caret is outside any terminal — never a default agent", () => {
    const el = mount(
      `<div ${TERMINAL_SURFACE_ATTR}="" ${TERMINAL_AGENT_ATTR}="agent-7"></div><input id="composer" />`,
      "#composer",
    ) as HTMLInputElement;
    el.focus();
    expect(focusedTerminalAgentId()).toBeNull();
  });

  it("is null for a terminal surface carrying no agent id, rather than an empty-string id", () => {
    // An empty id would be passed straight to pasteIntoPty as an agent name.
    const el = mount(
      `<div ${TERMINAL_SURFACE_ATTR}="" ${TERMINAL_AGENT_ATTR}=""><textarea></textarea></div>`,
      "textarea",
    ) as HTMLTextAreaElement;
    el.focus();
    expect(focusedTerminalAgentId()).toBeNull();
  });
});
