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
  isProgrammaticFocus,
  resetProgrammaticFocusForTest,
} from "./programmaticFocus";

function input(): HTMLInputElement {
  const el = document.createElement("input");
  document.body.appendChild(el);
  return el;
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
