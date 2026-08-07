// @vitest-environment jsdom
//
// bead sparkle-d2ec — "can't type in ANY box while dictation is live". The founder's symptom was that
// the terminal and the composer both went dead to the keyboard while the mouse still worked, and only
// a restart (which stops dictation) recovered. The cause was a compose surface pulling the caret to
// itself on a BACKGROUND event, over and over, so every few seconds the keystrokes the user was
// typing somewhere else went to a box they were not looking at.
//
// That regression class was already pinned — on `components/Composer.tsx`, which the app has not
// mounted since the pane composer was retired and which has no non-test importer anywhere in the
// monorepo. So the pin was green against code that never runs. THIS file pins it on the surface the
// app actually ships: `Concierge/ComposeBox`.
//
// The seam is `composeFocusSeq`. `uiStore.requestComposeFocus()` documents itself as "the user asking
// for the caret", but that invariant is unenforced and already stretched — `ConciergeHost`'s
// capture-window handoff calls it from an inbound EVENT, not from a gesture in this window. So the
// box has to defend the caret itself rather than trust every caller.
//
// THE PREDICATE IS UNSENT TEXT, NOT FOCUS — and each surface is asked in the only way it can answer:
//   • an ordinary editable  → `isTypingInProgress`, i.e. `activeElement.value`;
//   • a TERMINAL            → `terminalOverlayStore.drafts[agentId]`, published per keystroke by
//     Terminal.tsx's `onData` scanner, because a terminal's half-typed command lives in the shell's
//     line buffer and never appears in the DOM at all.
//
// Both halves of that are load-bearing, and each was wrong once. Reading `.value` for a terminal
// vetoes nothing (roborev 59595). Vetoing on terminal FOCUS instead declines nearly every legitimate
// pull, since in a terminal-first shell the xterm key sink holds the caret whenever the user is not
// typing into something else — spawning an empty agent, the drop pill's "go to compose", and above
// all the capture-window handoff, which stages a draft and then cannot deliver the caret to it, so the
// user's next Enter goes to a shell that executes the pending line (roborev 59610).
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposeBox } from "./ComposeBox";
import { resetProgrammaticFocusForTest } from "../../services/programmaticFocus";
import { useUiStore } from "../../stores/uiStore";
import { useDictationStore } from "../../stores/dictationStore";
import { TERMINAL_AGENT_ATTR, TERMINAL_SURFACE_ATTR } from "../../voice/dictationFocus";
import { useTerminalOverlayStore } from "../../stores/terminalOverlayStore";

/** Nodes parked on `document.body` by the helpers below, torn down between tests. Left in place they
 *  would keep `document.activeElement` pointing at a detached tree and answer for the next test. */
let planted: HTMLElement[] = [];

beforeEach(() => useDictationStore.setState({ voiceSurface: "agent" }));

afterEach(() => {
  cleanup();
  resetProgrammaticFocusForTest(); // module state outlives a component tree
  planted.forEach((n) => n.remove());
  planted = [];
  useDictationStore.setState({ voiceSurface: "concierge" });
  useTerminalOverlayStore.setState({ drafts: {} }); // ditto: a store is not torn down with the tree
});

/** The agent whose terminal the fixtures below stand in for. */
const TERM_AGENT = "agent-with-a-terminal";

const setup = () => render(<ComposeBox onSend={vi.fn()} onAttach={vi.fn()} />);

// "Message", not "Message Sparkle": the box no longer knows where a send goes — the host routes it.
const box = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;

/** A stand-in for a focused terminal: xterm's key sink, inside the app's own terminal wrapper, with
 *  the wrapper carrying both attributes `Terminal.tsx` puts on it (surface + agent id).
 *
 *  ══ THE `value` IS EMPTY, AND THAT IS THE WHOLE POINT ══════════════════════════════════════════
 *  An earlier version of this file hand-set `value = "git comm"` to represent a half-typed command.
 *  That state CANNOT OCCUR: xterm cancels the keystroke and forwards it to the PTY, so the command
 *  lives in the shell's line buffer and `.xterm-helper-textarea` stays empty (xterm writes it only on
 *  blur and on CR/ETX). Faking the value made a guard resting on `isTypingInProgress` — which reads
 *  exactly that value — look correct while it did nothing in the app: a green test against a state the
 *  browser never produces, i.e. precisely the vacuity this suite exists to replace (roborev 59595).
 *
 *  So there is NO text anywhere in this fixture's DOM, ever. "The user is mid-command" is expressed
 *  the way the app expresses it — `terminalOverlayStore.drafts[agentId]`, written per keystroke by
 *  Terminal.tsx's `onData` scanner — which is a store fact, not a DOM fact. */
function terminalCaret(opts: { midCommand: boolean }): HTMLTextAreaElement {
  const host = document.createElement("div");
  host.setAttribute(TERMINAL_SURFACE_ATTR, "");
  host.setAttribute(TERMINAL_AGENT_ATTR, TERM_AGENT);
  const ta = document.createElement("textarea");
  ta.className = "xterm-helper-textarea";
  host.appendChild(ta);
  document.body.appendChild(host);
  planted.push(host);
  useTerminalOverlayStore.getState().setDraft(TERM_AGENT, opts.midCommand);
  ta.focus();
  if (document.activeElement !== ta) throw new Error("could not focus the terminal stand-in");
  // Stated as an assertion, not a comment: the fixture is only meaningful while it is genuinely
  // text-free, and a future edit that seeds it would silently restore the vacuity described above.
  if (ta.value !== "") throw new Error("the terminal stand-in must hold no text — see the docblock");
  return ta;
}

/** A focused terminal the app cannot NAME: xterm's own classes, no wrapper, so no agent id and no
 *  draft flag to look up. `classifyFocusOwner` still calls it a terminal (its selector matches
 *  xterm's classes as a belt-and-braces case), which is exactly the state the fail-safe is for. */
function unnamedTerminalCaret(): HTMLTextAreaElement {
  const ta = document.createElement("textarea");
  ta.className = "xterm-helper-textarea";
  document.body.appendChild(ta);
  planted.push(ta);
  ta.focus();
  if (document.activeElement !== ta) throw new Error("could not focus the terminal stand-in");
  return ta;
}

/** A focused editable that is NOT a terminal and DOES hold unsent text — a rename field, a search box.
 *  This is the case `isTypingInProgress` legitimately answers. */
function draftField(value: string): HTMLInputElement {
  const el = document.createElement("input");
  el.type = "text";
  el.value = value;
  document.body.appendChild(el);
  planted.push(el);
  el.focus();
  if (document.activeElement !== el) throw new Error("could not focus the draft-field stand-in");
  return el;
}

/** A focused NON-editable surface — the mic button, or anything else in the chrome. This is the case
 *  the focus pull exists for, so it must keep working. */
function chromeButton(): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = "mic";
  document.body.appendChild(b);
  planted.push(b);
  b.focus();
  if (document.activeElement !== b) throw new Error("could not focus the chrome stand-in");
  return b;
}

/** Fire the seam the way a non-gesture caller does: bump the sequence from outside React.
 *
 *  Only a change PAST the value captured at mount counts, so this has to run after `setup()`. */
function requestComposeFocus(): void {
  act(() => useUiStore.getState().requestComposeFocus());
}

describe("a compose-focus request must not yank the caret out of a half-typed box (sparkle-d2ec)", () => {
  it("leaves the caret in a TERMINAL whose CLI line holds unsent input", () => {
    setup();
    const term = terminalCaret({ midCommand: true });

    requestComposeFocus();

    // The founder's symptom in one line, on a fixture with no text in it anywhere: the terminal keeps
    // the keyboard. A guard that asks the DOM "does the focused element contain unsent text" fails
    // this, because the command is in the shell's line buffer.
    expect(document.activeElement).toBe(term);
    expect(document.activeElement).not.toBe(box());
  });

  it("STILL takes the caret from a terminal sitting at an EMPTY prompt", () => {
    // The regression the focus-only veto shipped (roborev 59610). In a terminal-first shell the xterm
    // key sink holds the caret whenever the user is not typing into something else, so "a terminal has
    // focus" is the RESTING state, not evidence of anything. Declining there deletes the pull for the
    // empty spawn, the drop pill — and for ConciergeHost's capture-window handoff, which is the worst
    // of the three: it stages the draft and the attachments and then cannot deliver the caret to
    // them, so the user's next Enter goes to the shell, WHICH RUNS WHATEVER IS ON THE LINE.
    setup();
    terminalCaret({ midCommand: false });

    requestComposeFocus();

    expect(document.activeElement).toBe(box());
  });

  it("claims the mic on that pull too — the staged draft is what dictation must aim at", () => {
    setup();
    terminalCaret({ midCommand: false });

    requestComposeFocus();

    expect(useDictationStore.getState().voiceSurface).toBe("concierge");
  });

  it("leaves the caret in a terminal it cannot NAME (fail-safe)", () => {
    // A terminal matched only by xterm's classes carries no agent id, so there is no draft flag to
    // read. Unknown must answer "mid-command": a declined pull costs a caret that did not move, a
    // taken one costs the user's keystrokes going somewhere they are not looking.
    setup();
    const term = unnamedTerminalCaret();

    requestComposeFocus();

    expect(document.activeElement).toBe(term);
  });

  it("leaves the caret in a non-terminal field that holds a draft", () => {
    // The other half of the veto, and the one `isTypingInProgress` really does answer: an ordinary
    // editable — a rename field, a search box — whose text IS in the DOM.
    setup();
    const field = draftField("renaming this");

    requestComposeFocus();

    expect(document.activeElement).toBe(field);
  });

  it("does not claim the mic either, when it declined the caret", () => {
    // The two go together or they contradict each other. Naming this box the voice surface while
    // leaving the caret in the terminal would aim dictation at a box the user is not in — the mirror
    // of the bug above, and just as invisible: they would type in one box and speak into another.
    setup();
    terminalCaret({ midCommand: true });

    requestComposeFocus();

    expect(useDictationStore.getState().voiceSurface).toBe("agent");
  });

  it("STILL takes the caret from an EMPTY non-terminal field", () => {
    // The anti-over-fix guard. Vetoing on "another editable element has focus" would pass the tests
    // above and break this one. A guard that declines here has deleted the feature rather than fixed
    // the bug — spawning an empty agent and the drop pill's "go to compose" both land right here.
    setup();
    draftField("");

    requestComposeFocus();

    expect(document.activeElement).toBe(box());
  });

  it("STILL takes the caret from a non-editable surface", () => {
    // The flow the pull was added for: the mic UI (or any chrome button) took focus, so bring the
    // caret back to the box the user is composing in.
    setup();
    chromeButton();

    requestComposeFocus();

    expect(document.activeElement).toBe(box());
  });

  it("STILL claims the mic on a pull it accepted", () => {
    // Pairs with "does not claim the mic either" above: that one is only meaningful if the claim
    // demonstrably happens on the accepted path.
    setup();
    chromeButton();

    requestComposeFocus();

    expect(useDictationStore.getState().voiceSurface).toBe("concierge");
  });

  it("ignores unsent text in the compose box ITSELF", () => {
    // Pins the `active !== el` half of `focusQuietlyUnless`. `isTypingInProgress` is a document-wide
    // question, so a box holding its own half-written message would veto its OWN refocus without that
    // clause.
    //
    // The caret stays IN THE BOX here — an earlier version focused a chrome button first, which made
    // the case vacuous: `isTypingInProgress` reads only `activeElement`, so with the button focused the
    // box's text was never consulted and deleting `active !== el` left the test green (roborev 59595).
    //
    // And it asserts through the VOICE CLAIM rather than through focus, because focus cannot see the
    // difference: `focusQuietly` no-ops on an already-focused element either way, so `activeElement`
    // is the box whether the veto fired or not. `voiceSurface` can — it only flips when `took` is
    // true, which requires the skip. `fireEvent.change`, not a hand-set `value` plus a manual `input`
    // event: React's value tracker sees no change on the latter, so `onChange` never runs and the
    // component's own state stays empty.
    setup();
    const ta = box();
    ta.focus();
    fireEvent.change(ta, { target: { value: "half a thought" } });
    expect(ta.value).toBe("half a thought");
    // The real `.focus()` above claims the surface itself, so reset AFTER it — otherwise the assertion
    // below passes on that claim rather than on the one the request makes.
    act(() => useDictationStore.setState({ voiceSurface: "agent" }));

    requestComposeFocus();

    expect(useDictationStore.getState().voiceSurface).toBe("concierge");
  });

  it("a render with no pending caret restore does NOT pull focus (the seam-2 gate)", () => {
    // `ComposeBox`'s `restoreCaret` layout effect has NO dependency array, so it runs after every
    // render. It is left UNGUARDED on purpose — it fires from a mention pick, an explicit gesture on
    // this box, and guarding it would break the case it exists for (see the comment at that call
    // site). What bounds it is the `restoreCaret.current === null` early-return, so THAT is the
    // invariant worth pinning: an ordinary re-render must not reach the focus call at all.
    //
    // Asserted from a focused terminal MID-COMMAND, which is where a per-render focus grab would be
    // worst — and which the seam-1 guard would also refuse, so a pass here is not evidence about seam
    // 2 unless the re-render is driven WITHOUT a compose-focus request. It is: `rerender` alone, no
    // seq bump.
    const view = setup();
    const term = terminalCaret({ midCommand: true });

    act(() => view.rerender(<ComposeBox onSend={vi.fn()} onAttach={vi.fn()} />));

    expect(document.activeElement).toBe(term);
  });
});
