// Rule test for no-themed-svg-paint (plan item 1c). RuleTester drives the rule directly so the
// behaviour is pinned: a JS-bound value or a var() string on an intrinsic SVG paint attribute is
// flagged; inert literals (hex, none, currentColor, transparent, a url template) and paint props
// on a custom component pass. Authored via node so the JSX fixtures can carry real angle brackets.
import { RuleTester } from "eslint";
import { describe, it } from "vitest";
import rule from "../../../../eslint-rules/no-themed-svg-paint.mjs";

const rt = new RuleTester({
  languageOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

describe("no-themed-svg-paint rule", () => {
  it("flags themed tokens and passes inert paint literals", () => {
    rt.run("no-themed-svg-paint", rule, {
      valid: [
        `const A = <path stroke="#fff" />;`,
        `const A = <path fill="currentColor" />;`,
        `const A = <path fill="none" />;`,
        `const A = <path fill="transparent" />;`,
        "const A = <path fill={`url(#g)`} />;",
        `const A = <SparkleWordmark fill={DANGER} />;`,
        `const A = <path strokeWidth={2} />;`,
      ],
      invalid: [
        { code: `const A = <path stroke={DANGER} />;`, errors: [{ messageId: "jsValue" }] },
        { code: `const A = <circle fill={C.danger} />;`, errors: [{ messageId: "jsValue" }] },
        { code: `const A = <line stroke={cond ? "#fff" : DANGER} />;`, errors: [{ messageId: "jsValue" }] },
        { code: `const A = <path stroke="var(--c-danger)" />;`, errors: [{ messageId: "varString" }] },
        { code: `const A = <stop stopColor={"var(--c-x)"} />;`, errors: [{ messageId: "varString" }] },
      ],
    });
  });
});
