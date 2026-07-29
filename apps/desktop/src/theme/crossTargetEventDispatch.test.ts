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
        // Listener on document, dispatch at window -- the reported bug shape.
        {
          code: `document.addEventListener("keydown", spy); fireEvent.keyDown(window, { key: "Escape" });`,
          errors: [{ messageId: "mismatch" }],
        },
        // Raw DOM form, mirrored: listener on window, dispatch at document.
        {
          code: `window.addEventListener("resize", spy); document.dispatchEvent(new Event("resize"));`,
          errors: [{ messageId: "mismatch" }],
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
