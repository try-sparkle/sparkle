// Rule test for no-cross-target-event-dispatch. RuleTester drives the rule directly so the behaviour
// is pinned: a test that fires an event at one global target (window|document) while only registering
// a listener on the OTHER is flagged (the event is never heard -> vacuous test); an ALIGNED
// dispatch, or one with no in-file listener at all, passes. Placed beside svgPaintLint.test.ts (the
// repo's other RuleTester suite) so both eslint-rule tests share one home; the rule itself is
// test-file scoped, so this is its natural coverage. Not theme-specific, but the depth to
// ../../../../eslint-rules matches the sibling test.
import { RuleTester } from "eslint";
import { describe, it } from "vitest";
import rule from "../../../../eslint-rules/no-cross-target-event-dispatch.mjs";

const rt = new RuleTester({
  languageOptions: { ecmaVersion: "latest", sourceType: "module" },
});

// Full rendered diagnostic for each direction, written out by hand as an independent check on the
// rule's message template. If an edit reintroduces the placeholder-flip bug (claiming a window
// dispatch is rescued by bubbling), the rendered text diverges from these and the test fails.
const MESSAGE_WINDOW_DISPATCH =
  "Event dispatched at `window` but this file only registers a listener on `document` -- `window` and `document` are different EventTargets, so in the common non-bubbling, bubble-phase case the handler never fires and the test proves nothing. (Exception: a `document` dispatch IS heard by a `window` listener when the event has `bubbles: true` or that listener is capture-phase -- if that is this pair, it is correctly wired. The reverse never holds: a `window` dispatch is NEVER heard on `document`. See docs/jsdom-test-caveats.md.) Otherwise align them: dispatch at `document` (e.g. fireEvent on `document`, or `document.dispatchEvent`), or move the listener to `window`.";
const MESSAGE_DOCUMENT_DISPATCH =
  "Event dispatched at `document` but this file only registers a listener on `window` -- `window` and `document` are different EventTargets, so in the common non-bubbling, bubble-phase case the handler never fires and the test proves nothing. (Exception: a `document` dispatch IS heard by a `window` listener when the event has `bubbles: true` or that listener is capture-phase -- if that is this pair, it is correctly wired. The reverse never holds: a `window` dispatch is NEVER heard on `document`. See docs/jsdom-test-caveats.md.) Otherwise align them: dispatch at `window` (e.g. fireEvent on `window`, or `window.dispatchEvent`), or move the listener to `document`.";

describe("no-cross-target-event-dispatch rule", () => {
  it("flags cross-target dispatch and passes aligned / listener-less dispatch", () => {
    rt.run("no-cross-target-event-dispatch", rule, {
      valid: [
        // Aligned: listener and dispatch on the SAME target (document).
        `document.addEventListener("keydown", spy); document.dispatchEvent(new Event("keydown"));`,
        // Aligned via testing-library on window.
        `window.addEventListener("resize", spy); fireEvent(window, new Event("resize"));`,
        `window.addEventListener("resize", spy); fireEvent.resize(window);`,
        // No in-file listener at all: the real listener may be in the imported component, which this
        // per-file rule cannot see -- staying silent avoids a false positive.
        `fireEvent.keyDown(window, { key: "a" });`,
        `document.dispatchEvent(new Event("x"));`,
        // Listener on BOTH targets: the dispatched target IS covered, so no mismatch.
        `window.addEventListener("x", a); document.addEventListener("x", b); fireEvent(window, new Event("x"));`,
        // Dispatch at a non-global target is out of scope.
        `document.addEventListener("x", spy); el.dispatchEvent(new Event("x"));`,
      ],
      invalid: [
        // Listener on document, dispatch at window -- the reported bug shape. Pin the FULL rendered
        // message: in this window->document direction the isolation is absolute, so the message must
        // state "A `window` dispatch is NEVER heard on `document`" and must NOT claim bubbles:true
        // rescues it. The expected text is transcribed by hand (not re-rendered from the rule's own
        // template) so a directional regression in the template fails here instead of shipping.
        {
          code: `document.addEventListener("keydown", spy); fireEvent.keyDown(window, { key: "Escape" });`,
          errors: [{ message: MESSAGE_WINDOW_DISPATCH }],
        },
        // Raw DOM form, mirrored: listener on window, dispatch at document -- the direction where a
        // bubbles:true / capture-phase pair CAN be correct. The message's exception clause must name
        // exactly this document->window direction; pin its full rendered text too.
        {
          code: `window.addEventListener("resize", spy); document.dispatchEvent(new Event("resize"));`,
          errors: [{ message: MESSAGE_DOCUMENT_DISPATCH }],
        },
        // Generic fireEvent(target, event) with the mismatch.
        {
          code: `document.addEventListener("click", spy); fireEvent(window, new Event("click"));`,
          errors: [{ messageId: "mismatch" }],
        },
      ],
    });
  });
});
