import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHECKS, lintReply, registerCheck } from "./index";
import type { Check, CheckPolicy, LintContext, LintPolicy } from "./types";

const HEDGE: CheckPolicy = { enabled: true, severity: "warn", autofix: false };
const ALL_ON: Record<string, CheckPolicy> = {
  "hedge-words": HEDGE,
  "naked-file-ref": { enabled: true, severity: "warn", autofix: false },
  "restated-state": {
    enabled: true,
    severity: "warn",
    autofix: false,
    threshold: 200,
  },
};

const policy = (over: Partial<LintPolicy> = {}): LintPolicy => ({
  enabled: true,
  log: false,
  logMatches: false,
  checks: { ...ALL_ON },
  ...over,
});

const ctx = (over: Partial<LintContext> = {}): LintContext => ({
  roster: [],
  toolCalls: [],
  refusals: [],
  prevReply: null,
  policy: policy(),
  ...over,
});

/** A reply that trips `hedge-words` once and nothing else. */
const HEDGING = "The migration should finish shortly.";

let builtIn: Check[];
beforeEach(() => {
  builtIn = [...CHECKS];
});
afterEach(() => {
  CHECKS.splice(0, CHECKS.length, ...builtIn);
  vi.restoreAllMocks();
});

describe("lintReply — the registry", () => {
  it("ships exactly the built-in checks, with the blocking one first", () => {
    // `ask-without-action` leads deliberately: it is the only check here that BLOCKS, and when a
    // reply both offers to act and hedges, the offer is the finding worth surfacing.
    // `unbacked-claim` sits second because it is the other half of the same pair — took no action
    // and said so, versus took no action and said it did.
    expect(CHECKS.map((c) => c.id)).toEqual([
      "ask-without-action",
      "unbacked-claim",
      "hedge-words",
      "naked-file-ref",
      "restated-state",
    ]);
  });

  it("runs every enabled check over the same reply", () => {
    const reply = "The migration should finish shortly.\n\nSee src/retry.ts:88";
    const result = lintReply(reply, ctx());
    expect(result.violations.map((v) => v.check).sort()).toEqual(["hedge-words", "naked-file-ref"]);
  });
});

describe("lintReply — the master switch", () => {
  it("returns the reply untouched with zero violations when the linter is disabled", () => {
    const disabled = lintReply(HEDGING, ctx({ policy: policy({ enabled: false }) }));
    expect(disabled).toEqual({ text: HEDGING, violations: [], blocked: false });
    // The same reply DOES fire when the switch is on — otherwise this proves nothing.
    expect(lintReply(HEDGING, ctx()).violations).toHaveLength(1);
  });

  it("does not block on a block-severity check while disabled", () => {
    const checks = {
      ...ALL_ON,
      "hedge-words": { ...HEDGE, severity: "block" as const },
    };
    const on = lintReply(HEDGING, ctx({ policy: policy({ checks }) }));
    expect(on.blocked).toBe(true);
    const off = lintReply(HEDGING, ctx({ policy: policy({ enabled: false, checks }) }));
    expect(off.blocked).toBe(false);
  });
});

describe("lintReply — per-check policy gating", () => {
  it("skips a check whose policy row is missing", () => {
    const withoutHedge = { ...ALL_ON };
    delete withoutHedge["hedge-words"];
    expect(
      lintReply(HEDGING, ctx({ policy: policy({ checks: withoutHedge }) })).violations,
    ).toEqual([]);
  });

  it("skips a check that is disabled", () => {
    const checks = { ...ALL_ON, "hedge-words": { ...HEDGE, enabled: false } };
    expect(lintReply(HEDGING, ctx({ policy: policy({ checks }) })).violations).toEqual([]);
  });

  it("skips a check whose severity is off, even though it is enabled", () => {
    const checks = {
      ...ALL_ON,
      "hedge-words": { ...HEDGE, enabled: true, severity: "off" as const },
    };
    expect(lintReply(HEDGING, ctx({ policy: policy({ checks }) })).violations).toEqual([]);
  });

  it("gates each check independently", () => {
    const checks = { ...ALL_ON, "hedge-words": { ...HEDGE, enabled: false } };
    const reply = "The migration should finish shortly.\n\nSee src/retry.ts:88";
    expect(lintReply(reply, ctx({ policy: policy({ checks }) })).violations.map((v) => v.check)) //
      .toEqual(["naked-file-ref"]);
  });
});

describe("lintReply — blocked", () => {
  it("is true when any fired violation is block severity", () => {
    const checks = {
      ...ALL_ON,
      "hedge-words": { ...HEDGE, severity: "block" as const },
    };
    expect(lintReply(HEDGING, ctx({ policy: policy({ checks }) })).blocked) //
      .toBe(true);
  });

  it("is false when every fired violation is a warn", () => {
    const result = lintReply(HEDGING, ctx());
    expect(result.violations).toHaveLength(1);
    expect(result.blocked).toBe(false);
  });
});

describe("lintReply — a rewriting check", () => {
  it("returns the rewritten text and feeds it to the checks after it", () => {
    let sawText = "";
    registerCheck({
      id: "aa-rewrite",
      run: (text) => ({ text: text.replace("should", "will"), violations: [] }),
    });
    registerCheck({
      id: "zz-observe",
      run: (text) => {
        sawText = text;
        return { text, violations: [] };
      },
    });
    // Put the rewriter first so ordering is what the test claims.
    CHECKS.sort((a, b) => a.id.localeCompare(b.id));
    const checks = {
      ...ALL_ON,
      "aa-rewrite": { enabled: true, severity: "warn" as const, autofix: true },
      "zz-observe": {
        enabled: true,
        severity: "warn" as const,
        autofix: false,
      },
    };
    const result = lintReply(HEDGING, ctx({ policy: policy({ checks }) }));
    expect(result.text).toBe("The migration will finish shortly.");
    expect(sawText).toBe("The migration will finish shortly.");
    // And the rewrite silenced the hedge check that ran between them.
    expect(result.violations).toEqual([]);
  });
});

describe("lintReply — a check that throws", () => {
  const boom: Check = {
    id: "boom",
    run: () => {
      throw new Error("check exploded");
    },
  };
  const withBoom = {
    ...ALL_ON,
    boom: { enabled: true, severity: "block" as const, autofix: false },
  };

  it("does not throw, does not lose the reply, and does not block", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerCheck(boom);
    const result = lintReply(HEDGING, ctx({ policy: policy({ checks: withBoom }) }));
    expect(result.text).toBe(HEDGING);
    expect(result.blocked).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it("still runs the other checks", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    registerCheck(boom);
    const result = lintReply(HEDGING, ctx({ policy: policy({ checks: withBoom }) }));
    expect(result.violations.map((v) => v.check)).toEqual(["hedge-words"]);
  });
});

describe("registerCheck", () => {
  it("appends a new check", () => {
    const extra: Check = {
      id: "extra",
      run: (text) => ({ text, violations: [] }),
    };
    registerCheck(extra);
    expect(CHECKS.filter((c) => c.id === "extra")).toEqual([extra]);
  });

  it("replaces an existing check rather than running it twice", () => {
    const first: Check = {
      id: "dup",
      run: (text) => ({ text, violations: [] }),
    };
    const second: Check = {
      id: "dup",
      run: (text) => ({ text, violations: [] }),
    };
    registerCheck(first);
    registerCheck(second);
    expect(CHECKS.filter((c) => c.id === "dup")).toEqual([second]);
  });
});

// ══ THE FALSE-POSITIVE CORPUS ══════════════════════════════════════════════════════════════════
// Replies that are CORRECT and must trip nothing. This is the corpus that decides whether the
// linter is usable: a warn on a compliant reply trains the reader to ignore the badge, and a block
// on one costs a wasted revision turn.
describe("lintReply — the false-positive corpus", () => {
  const clean = (reply: string, over: Partial<LintContext> = {}) =>
    lintReply(reply, ctx(over)).violations;

  it("a hedge word inside a fenced code block", () => {
    expect(
      clean("Landed the guard.\n\n```ts\nif (!ready) return should(retry);\n```\n\nCI is green."),
    ).toEqual([]);
  });

  it("a file:line reference inside a fenced code block", () => {
    expect(
      clean("Here is the stack:\n\n```\n  at src/retry.ts:88\n  at src/queue.ts:12\n```"),
    ).toEqual([]);
  });

  it("a hedge word inside a blockquote quoting the user", () => {
    expect(clean("You asked:\n\n> should I merge it before the release?\n\nI merged it.")).toEqual(
      [],
    );
  });

  it("a long reply sharing boilerplate with the previous one, below threshold", () => {
    const boilerplate = "Here is where the fleet stands.";
    const prev = `${boilerplate} Kraken Auth opened a PR and Left Pair is rebasing onto main.`;
    const next =
      `${boilerplate} Kraken Auth merged, and I spawned a worker to drain the review queue. ` +
      "The theme-token conflict is resolved and the desktop build is notarizing now.";
    expect(next.length).toBeGreaterThan(150);
    expect(clean(next, { prevReply: prev })).toEqual([]);
  });

  // The corpus's first version was all plain unformatted sentences, and a review pointed out that
  // real concierge replies are backticks, bold, links and tables — the shapes that actually broke
  // the per-text-node word count. These are those shapes.
  it("a file:line reference on a line whose explanation is inside inline code", () => {
    expect(clean("The `retryBackoff` helper resets at src/retry.ts:88 on each attempt.")).toEqual(
      [],
    );
  });

  it("a file:line reference on a line whose explanation is bolded", () => {
    expect(clean("The **retry backoff** resets at src/retry.ts:88")).toEqual([]);
  });

  it("a fleet-status table with a path column and an explanation column", () => {
    const reply = [
      "| file | what it does |",
      "| --- | --- |",
      "| src/retry.ts:88 | resets the backoff |",
      "| src/queue.ts:12 | drains the queue |",
    ].join("\n");
    expect(clean(reply)).toEqual([]);
  });

  it("a bare URL carrying both a hedge word and a path:line in its path", () => {
    expect(clean("Details at https://github.test/o/r/blob/main/src/should-retry.ts:88")).toEqual(
      [],
    );
  });

  it("a file:line reference that the sentence already explains", () => {
    expect(clean("The retry backoff resets on every fresh attempt at src/retry.ts:88.")).toEqual(
      [],
    );
  });

  it("an ordinary reply with none of the patterns at all", () => {
    expect(
      clean("I spawned two workers on the theme tokens and merged the dictation fix. CI is green."),
    ).toEqual([]);
  });
});
