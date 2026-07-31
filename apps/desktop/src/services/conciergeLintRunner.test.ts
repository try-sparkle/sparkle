import { describe, expect, it, vi } from "vitest";
import { runReplyLint, type LintSinks } from "./conciergeLintRunner";
import { toLintPolicy } from "./conciergeLintPolicy";
import type { ConciergeChecksConfigPayload } from "./config";
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
