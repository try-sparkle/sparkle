// @vitest-environment jsdom
//
// Telling the app's own focus() calls apart from the user's. The compose boxes use this to decide
// whether a focus event should re-aim the microphone (dictationStore.voiceSurface), so both
// directions are a real bug: answer "programmatic" for a genuine focus and a keyboard user's caret
// and their voice end up in different columns; answer "user" for an app-driven one and revealing a
// pane silently redirects the mic with no gesture at all.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  focusQuietly,
  focusQuietlyUnlessTypingElsewhere,
  isEditableTarget,
  isProgrammaticFocus,
  resetProgrammaticFocusForTest,
} from "./programmaticFocus";

function input(): HTMLInputElement {
  const el = document.createElement("input");
  document.body.appendChild(el);
  return el;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  init?: (e: HTMLElementTagNameMap[K]) => void,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  init?.(node);
  document.body.appendChild(node);
  return node;
}

beforeEach(() => resetProgrammaticFocusForTest());
afterEach(() => {
  document.body.innerHTML = "";
  resetProgrammaticFocusForTest();
});

describe("programmaticFocus", () => {
  it("reads as programmatic for the element focusQuietly just focused", () => {
    const a = input();
    let seen: boolean | null = null;
    a.addEventListener("focus", () => {
      seen = isProgrammaticFocus(a);
    });

    focusQuietly(a);

    expect(seen).toBe(true);
  });

  it("reads as the USER for a focus nobody announced", () => {
    const a = input();
    a.focus();
    expect(isProgrammaticFocus(a)).toBe(false);
  });

  it("answers for exactly ONE event — a second focus of the same element is the user's", () => {
    // The tag is consumed on delivery. Without that, one app-driven focus would permanently mark an
    // element, and every later genuine focus of it would be attributed to the app.
    const a = input();
    const answers: boolean[] = [];
    a.addEventListener("focus", () => answers.push(isProgrammaticFocus(a)));

    focusQuietly(a); // the app
    a.blur();
    a.focus(); // the user, on the same element

    expect(answers).toEqual([true, false]);
  });

  it("does not tag an element that is ALREADY focused (no event will come to clear it)", () => {
    // .focus() on the focused element dispatches nothing, so a tag minted here would sit forever
    // and swallow the user's next real focus of this box.
    const a = input();
    a.focus();
    focusQuietly(a);
    expect(isProgrammaticFocus(a)).toBe(false);
  });

  it("drops a tag whose event never arrives, once focus lands somewhere else", () => {
    // The deferred-dispatch case this exists for: per the HTML focusing steps, .focus() in a
    // document whose traversable lacks SYSTEM focus only sets the focused area and defers the
    // event to window activation. If the app moves focus again before that, the first event never
    // comes — and the stale tag would eat the user's next genuine focus of that element.
    const a = input();
    const b = input();

    // jsdom always dispatches synchronously, so the deferral is modelled the only way it can be:
    // nothing consumes `a`'s tag (no onFocus handler is listening), which is indistinguishable from
    // the event not having arrived yet.
    focusQuietly(a);
    b.focus(); // focus moves on — the tagged move has been superseded

    // The late event finally arrives, and must NOT be attributed to the app.
    expect(isProgrammaticFocus(a)).toBe(false);
  });

  it("nested quiet focuses do not leave the flag stuck on", () => {
    const a = input();
    focusQuietly(a);
    // Depth is back to zero, so an unrelated question answers honestly.
    expect(isProgrammaticFocus()).toBe(false);
  });

  it("is safe on null", () => {
    expect(() => focusQuietly(null)).not.toThrow();
    expect(() => focusQuietly(undefined)).not.toThrow();
  });
});

// The dictation caret-return guard (roborev 54718/54719). Both directions matter and only ONE of
// them fails loudly: if the guard wrongly SKIPS, the caret silently stops coming back — which is
// exactly how the original freeze went unpinned — so the "must refocus" branch is pinned first.
describe("focusQuietlyUnlessTypingElsewhere", () => {
  it("REFOCUSES when the caret sits on a non-editable element (the mic button)", () => {
    const composer = el("textarea");
    const mic = el("button");
    mic.focus();

    expect(focusQuietlyUnlessTypingElsewhere(composer)).toBe(true);
    expect(document.activeElement).toBe(composer);
  });

  it("REFOCUSES when nothing but the body holds focus", () => {
    const composer = el("textarea");
    (document.activeElement as HTMLElement | null)?.blur();

    expect(focusQuietlyUnlessTypingElsewhere(composer)).toBe(true);
    expect(document.activeElement).toBe(composer);
  });

  it("does NOT steal the caret from a different editable element", () => {
    const composer = el("textarea");
    const other = el("textarea");
    other.focus();

    expect(focusQuietlyUnlessTypingElsewhere(composer)).toBe(false);
    expect(document.activeElement).toBe(other);
  });

  it("does NOT steal the caret from a contentEditable host", () => {
    const composer = el("textarea");
    const host = el("div");
    Object.defineProperty(host, "isContentEditable", { value: true });
    host.tabIndex = 0;
    host.focus();

    expect(focusQuietlyUnlessTypingElsewhere(composer)).toBe(false);
    expect(document.activeElement).toBe(host);
  });

  it("is a no-op-but-true when the element already holds the caret", () => {
    const composer = el("textarea");
    composer.focus();

    expect(focusQuietlyUnlessTypingElsewhere(composer)).toBe(true);
    expect(document.activeElement).toBe(composer);
  });

  it("is safe on null", () => {
    expect(focusQuietlyUnlessTypingElsewhere(null)).toBe(false);
    expect(focusQuietlyUnlessTypingElsewhere(undefined)).toBe(false);
  });

  // The caret-less controls. A checkbox/radio/button-ish <input> owns no caret, so parking focus
  // there must NOT suppress the pull — otherwise a user who clicks a settings checkbox mid-dictation
  // never gets the caret back, and their next Enter toggles the checkbox instead of sending.
  it.each([
    ["checkbox", (e: HTMLInputElement) => (e.type = "checkbox")],
    ["radio", (e: HTMLInputElement) => (e.type = "radio")],
    ["range", (e: HTMLInputElement) => (e.type = "range")],
    ["button", (e: HTMLInputElement) => (e.type = "button")],
  ])("REFOCUSES past a caret-less input[type=%s]", (_label, init) => {
    const composer = el("textarea");
    const control = el("input", init as (e: HTMLInputElement) => void);
    control.focus();

    expect(focusQuietlyUnlessTypingElsewhere(composer)).toBe(true);
    expect(document.activeElement).toBe(composer);
  });

  // `disabled` is asserted on the PREDICATE, not through the guard: a disabled control cannot take
  // focus in a real DOM, so any test that drove the guard with one would be asserting against an
  // unreachable state (and faking `document.activeElement` to get there leaks into the next test).
  it("does not count a disabled or readOnly field as editable", () => {
    const disabled = el("input", (e) => {
      e.type = "text";
      e.disabled = true;
    });
    const readOnly = el("input", (e) => {
      e.type = "text";
      e.readOnly = true;
    });

    expect(isEditableTarget(disabled)).toBe(false);
    expect(isEditableTarget(readOnly)).toBe(false);
    expect(isEditableTarget(el("input", (e) => (e.type = "text")))).toBe(true);
  });

  it("REFOCUSES past a readOnly text input", () => {
    const composer = el("textarea");
    const control = el("input", (e) => {
      e.type = "text";
      e.readOnly = true;
    });
    control.focus();

    expect(focusQuietlyUnlessTypingElsewhere(composer)).toBe(true);
    expect(document.activeElement).toBe(composer);
  });
});
