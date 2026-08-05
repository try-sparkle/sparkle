import { describe, expect, it, vi } from "vitest";
import {
  MAX_CORRECTION_INSTRUCTIONS,
  buildLintCorrectionPrompt,
  reportLintOutcome,
  runReplyLint,
  type LintSinks,
} from "./conciergeLintRunner";
import { toLintPolicy } from "./conciergeLintPolicy";
import type { ConciergeChecksConfigPayload } from "./config";
import type { Violation } from "./conciergeLint";
import type { LintCheckId } from "../stores/conciergeLintMetrics";

/** A live policy with the implemented checks on, built through the REAL mapper rather than by
 *  hand-writing a `LintPolicy`. A hand-built policy would let this file pass while the config→policy
 *  path — the half that actually runs in the app — was broken. */
function livePolicy(over: Partial<ConciergeChecksConfigPayload> = {}) {
  const wire: ConciergeChecksConfigPayload = {
    enabled: true,
    log: true,
    log_matches: false,
    checks: {
      "hedge-words": {
        enabled: true,
        severity: "warn",
        autofix: false,
        words: "should, deserves to",
      },
      "ask-without-action": { enabled: true, severity: "block", autofix: false },
    },
    ...over,
  };
  return toLintPolicy(wire);
}

function spies(): LintSinks & {
  recorded: { check: LintCheckId; action: string }[];
  logged: Record<string, unknown>[];
} {
  const recorded: { check: LintCheckId; action: string }[] = [];
  const logged: Record<string, unknown>[] = [];
  return {
    recorded,
    logged,
    record: (check, action) => recorded.push({ check, action }),
    log: (v) => logged.push(v),
  };
}

describe("runReplyLint — the mount", () => {
  it("RUNS the checks: a hedging reply produces a violation", () => {
    // The side effect that proves the linter is wired, not that a precondition holds. Before the
    // mount existed this reply reached the user with nothing looking at it.
    const s = spies();
    const r = runReplyLint(
      {
        text: "The retry path should be narrowed before the next release.",
        turnId: "42",
        toolCalls: [{ name: "sparkle_fleet", input: "{}" }],
        policy: livePolicy(),
      },
      s,
    );
    expect(r.violations.map((v) => v.check)).toContain("hedge-words");
  });

  it("counts each violation AND writes it to the log sink", () => {
    const s = spies();
    runReplyLint(
      {
        text: "That should be fine and it deserves to land.",
        turnId: "7",
        toolCalls: [{ name: "sparkle_fleet", input: "{}" }],
        policy: livePolicy(),
      },
      s,
    );
    expect(s.recorded.length).toBeGreaterThan(0);
    expect(s.recorded.every((r) => r.check === "hedge-words")).toBe(true);
    expect(s.logged.length).toBe(s.recorded.length);
    // The record is metadata only — the reply text must never reach the sink.
    for (const line of s.logged) {
      expect(line).toMatchObject({ check: "hedge-words", turn: "7", count: 1 });
      expect(Object.keys(line).sort()).toEqual(
        ["action", "check", "count", "severity", "span", "ts", "turn"].sort(),
      );
      expect(JSON.stringify(line)).not.toContain("deserves to land");
    }
  });

  it("blocks when a blocking check fires", () => {
    const s = spies();
    const r = runReplyLint(
      {
        text: "The obvious next step is a rebase. Should I do it?",
        turnId: "9",
        // No tool call at all: the reply offered to act while the turn did nothing.
        toolCalls: [],
        policy: livePolicy(),
      },
      s,
    );
    expect(r.violations.map((v) => v.check)).toContain("ask-without-action");
    expect(r.blocked).toBe(true);
  });

  it("DEFERS a blocked result's report — the outcome is not known yet", () => {
    // The half of the block path that lives here. Every check hardcodes `action: "warned"` because
    // only a component that performs a revision may claim one (roborev 55981) — and at the moment
    // this returns, nobody knows whether the mount will revise or give up. Counting `warned` now and
    // the real action later would report one violation twice, in the counter the whole feature
    // exists to make trustworthy. So the caller owes `reportLintOutcome`.
    const s = spies();
    const r = runReplyLint(
      {
        text: "The obvious next step is a rebase. Should I do it?",
        turnId: "9",
        toolCalls: [],
        policy: livePolicy(),
      },
      s,
    );
    expect(r.blocked, "the fixture has to actually block or this row proves nothing").toBe(true);
    expect(r.violations.length).toBeGreaterThan(0);
    expect(s.recorded, "a blocked reply is counted by the mount, not here").toEqual([]);
    expect(s.logged).toEqual([]);
  });

  it("log = false silences the DISK sink but keeps counting", () => {
    // The two sinks are governed separately: `log` is about persistence, and a user who opted out of
    // the file still gets the session readout. Written as a real assertion because the natural
    // implementation (`sinks.log ?? defaultLog`) falls THROUGH an omitted sink to the real one and
    // writes the very file that was switched off.
    const s = spies();
    runReplyLint(
      {
        text: "That should be fine.",
        turnId: "3",
        toolCalls: [{ name: "sparkle_fleet", input: "{}" }],
        policy: livePolicy({ log: false }),
      },
      s,
    );
    expect(s.recorded.length).toBeGreaterThan(0);
    expect(s.logged).toEqual([]);
  });

  it("does nothing at all under the disabled policy, and returns the text untouched", () => {
    const s = spies();
    const text = "That should be fine. Should I do it?";
    const r = runReplyLint({ text, turnId: "1", toolCalls: [], policy: toLintPolicy(undefined) }, s);
    expect(r.text).toBe(text);
    expect(r.violations).toEqual([]);
    expect(r.blocked).toBe(false);
    expect(s.recorded).toEqual([]);
    expect(s.logged).toEqual([]);
  });

  it("parses a tool call's JSON input, and keeps unparseable input as the raw string", () => {
    // `ConciergeDoneEvent` carries `input` as the raw JSON string; the checks expect a value. Proven
    // through the exemption path: `ask-without-action` reads the tool NAME, so a turn that called a
    // real tool must not be flagged even when the input is malformed.
    const s = spies();
    const r = runReplyLint(
      {
        text: "Kicked off the rebase. Should I also narrow its task?",
        turnId: "5",
        toolCalls: [{ name: "sparkle_fleet", input: "{not json" }],
        policy: livePolicy(),
      },
      s,
    );
    expect(r.violations.map((v) => v.check)).not.toContain("ask-without-action");
  });

  it("survives a throwing sink — the reply is never lost to telemetry", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const text = "That should be fine.";
    const r = runReplyLint(
      {
        text,
        turnId: "2",
        toolCalls: [{ name: "sparkle_fleet", input: "{}" }],
        policy: livePolicy(),
      },
      {
        record: () => {
          throw new Error("counter exploded");
        },
        log: () => {
          throw new Error("disk exploded");
        },
      },
    );
    expect(r.text).toBe(text);
    expect(r.violations.length).toBeGreaterThan(0);
    warn.mockRestore();
  });

  it("reportLintOutcome stamps the action the mount ACTUALLY took into both sinks", () => {
    // The other half of the deferral. `"revised"` is the word that was previously unwritable —
    // nothing in the app could honestly produce it — so this asserts the stamp reaches the counter
    // AND the disk record, not merely that the function returned.
    const s = spies();
    const held: Violation[] = [
      { check: "hedge-words", severity: "block", action: "warned", span: 6, detail: "should" },
    ];
    const stamped = reportLintOutcome(
      { violations: held, turnId: "11", action: "revised", policy: livePolicy() },
      s,
    );
    expect(stamped).toEqual([{ ...held[0]!, action: "revised" }]);
    expect(held[0]!.action, "the caller's array must not be mutated").toBe("warned");
    expect(s.recorded).toEqual([{ check: "hedge-words", action: "revised" }]);
    expect(s.logged).toHaveLength(1);
    expect(s.logged[0]).toMatchObject({ check: "hedge-words", action: "revised", turn: "11" });
  });

  it("reportLintOutcome honours log = false and survives a throwing sink", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = spies();
    const held: Violation[] = [
      { check: "hedge-words", severity: "block", action: "warned", span: 6, detail: "should" },
    ];
    reportLintOutcome(
      { violations: held, turnId: "12", action: "rendered_marked", policy: livePolicy({ log: false }) },
      s,
    );
    expect(s.recorded).toEqual([{ check: "hedge-words", action: "rendered_marked" }]);
    expect(s.logged, "the disk sink stays off; the session counter does not").toEqual([]);

    // And a counter that explodes must not throw into the mount, which is mid-render of a reply.
    expect(() =>
      reportLintOutcome(
        { violations: held, turnId: "13", action: "rendered_marked", policy: livePolicy() },
        {
          record: () => {
            throw new Error("counter exploded");
          },
        },
      ),
    ).not.toThrow();
    warn.mockRestore();
  });

  it("skips a check id the counter has no column for instead of miscounting it", () => {
    // The linter's registry is open (`registerCheck`), so an id can arrive that this build cannot
    // count. It must not be folded into a neighbouring key — the counts are the whole point.
    const s = spies();
    runReplyLint(
      {
        text: "That should be fine.",
        turnId: "4",
        toolCalls: [{ name: "sparkle_fleet", input: "{}" }],
        policy: livePolicy(),
      },
      s,
    );
    for (const r of s.recorded) expect(r.check).toBe("hedge-words");
  });
});

describe("buildLintCorrectionPrompt — the one re-prompt a blocked reply gets", () => {
  const v = (check: string): Violation => ({
    check,
    severity: "block",
    action: "warned",
    span: 12,
    // A `detail` that would be unmistakable if it ever leaked into the prompt.
    detail: "SPAN-DETAIL-LEAK-CANARY",
  });

  it("names each check's COMPLIANT FORM, not the complaint", () => {
    // A re-prompt that only names the fault invites an apology; the model needs to be told what to
    // write instead. The mark's wording ("Said it would do it") is the reader's sentence, not this.
    const prompt = buildLintCorrectionPrompt([v("ask-without-action"), v("unbacked-claim")]);
    expect(prompt).toContain("do not ask permission for something you can just do");
    expect(prompt).toContain("Either do it now and report the result, or drop the claim");
    expect(prompt).toContain("Reply with the corrected message only");
  });

  it("carries NO reply prose — not the text, not the span, not the detail", () => {
    // The standing decision `Violation.span` is a character COUNT for. The correction prompt is the
    // one place quoting the offending sentence back would have been the obvious thing to do.
    const prompt = buildLintCorrectionPrompt([v("hedge-words")]);
    expect(prompt).not.toContain("SPAN-DETAIL-LEAK-CANARY");
    expect(prompt).not.toContain("12");
  });

  it("dedupes by check id — `hedge-words` reports one violation per hedging word", () => {
    const prompt = buildLintCorrectionPrompt([v("hedge-words"), v("hedge-words"), v("hedge-words")]);
    expect(prompt.split("You hedged")).toHaveLength(2);
  });

  it("caps the instruction list so a bad reply cannot produce an unfollowable prompt", () => {
    const many = [
      "ask-without-action",
      "unbacked-claim",
      "hedge-words",
      "restated-state",
      "naked-file-ref",
      "relay-paste",
      "actions-first",
      "unreported-refusal",
    ].map(v);
    expect(many.length).toBeGreaterThan(MAX_CORRECTION_INSTRUCTIONS);
    const lines = buildLintCorrectionPrompt(many)
      .split("\n")
      .filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(MAX_CORRECTION_INSTRUCTIONS);
  });

  it("names an unknown check id rather than inventing generic copy for it", () => {
    // Same posture as `lintCheckSentence`'s fallback: the registry is open, and copy that reads
    // deliberate would hide the missing row. An id on screen is self-reporting.
    expect(buildLintCorrectionPrompt([v("some-future-check")])).toContain('"some-future-check"');
  });

  it("returns \"\" when there is nothing to instruct, so no paid turn is spent", () => {
    expect(buildLintCorrectionPrompt([])).toBe("");
    expect(buildLintCorrectionPrompt(undefined)).toBe("");
    expect(buildLintCorrectionPrompt([{ check: "" } as unknown as Violation])).toBe("");
  });
});
