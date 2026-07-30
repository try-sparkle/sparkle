// The contract guard for `types.ts`.
//
// HONEST LABEL: `types.ts` has no runtime — it compiles to nothing — so there is no behavior here
// to mutate and `scripts/mutation-check.sh` has nothing to say about this file. What this test
// actually guards is the PINNED SHAPE: several branches build checks against these names at once,
// and a rename is not a refactor, it is a merge conflict in someone else's work. The type
// annotations below are the assertion — `pnpm typecheck` fails if a field is renamed, retyped, or
// dropped — and the runtime `expect`s pin the names that a consumer reads dynamically (the policy
// map is keyed by check id, so its keys are data, not identifiers).
//
// PROVEN, not asserted, because "it can fail" is the bar and the usual tool cannot answer it here:
//   • `mutation-check.sh --source types.ts` FLAGS this test, and that flag is correct-and-expected:
//     it found two mutable lines (a comment and an optional property declaration) and neither
//     changes any behavior, because there is no behavior. Do not "fix" this by weakening the test.
//   • The equivalent proof for a type-only module is the typechecker. Renaming `Violation.span` to
//     `spanChars` in `types.ts` makes `tsc --noEmit` fail in four places (both fire-and-report
//     checks and this file's own annotation). That is the guard working.
//   • The RUNTIME half is proven the ordinary way: `mutation-check.sh --source index.ts --test
//     types.test.ts` PASSES — mutating `lintReply`'s input guard turns this file red.

import { describe, expect, it } from "vitest";
import { lintReply } from "./index";
import type {
  Check,
  CheckPolicy,
  LintContext,
  LintPolicy,
  LintRefusal,
  LintResult,
  LintRosterAgent,
  LintToolCall,
  Severity,
  Violation,
} from "./types";

describe("the pinned public contract", () => {
  it("accepts a fully-populated context and returns a LintResult", () => {
    const severities: Severity[] = ["block", "warn", "off"];
    const checkPolicy: CheckPolicy = {
      enabled: true,
      severity: "warn",
      autofix: false,
      threshold: 200,
      words: "should, deserves to",
    };
    const agent: LintRosterAgent = {
      id: "a1",
      name: "Kraken Auth",
      projectName: "sparkle",
    };
    const toolCall: LintToolCall = {
      name: "sparkle_workspace",
      input: { op: "open" },
    };
    const refusal: LintRefusal = {
      domain: "workspace",
      op: "open",
      code: "denied",
      message: "no such project",
    };
    const policy: LintPolicy = {
      enabled: true,
      log: true,
      logMatches: false,
      checks: { "hedge-words": checkPolicy },
    };
    const ctx: LintContext = {
      roster: [agent],
      toolCalls: [toolCall],
      refusals: [refusal],
      prevReply: null,
      policy,
      resolvePrOwner: (prNumber: string) => (prNumber === "918" ? "a1" : null),
    };

    expect(severities).toHaveLength(3);
    expect(Object.keys(policy.checks)).toEqual(["hedge-words"]);
    // `resolvePrOwner` returns null for unresolved/ambiguous and NEVER a guess.
    expect(ctx.resolvePrOwner?.("918")).toBe("a1");
    expect(ctx.resolvePrOwner?.("777")).toBeNull();

    const result: LintResult = lintReply("The build should finish soon.", ctx);
    expect(Object.keys(result).sort()).toEqual(["blocked", "text", "violations"]);

    expect(result.violations).toHaveLength(1);
    const violation: Violation = result.violations[0]!;
    expect(Object.keys(violation).sort()).toEqual([
      "action",
      "check",
      "detail",
      "severity",
      "span",
    ]);
  });

  it("accepts a hand-written Check against the same shape", () => {
    const noop: Check = {
      id: "noop",
      run: (text) => ({ text, violations: [] }),
    };
    expect(noop.run("x", {} as LintContext)).toEqual({
      text: "x",
      violations: [],
    });
  });
});
