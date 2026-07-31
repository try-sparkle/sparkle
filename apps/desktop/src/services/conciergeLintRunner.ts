// conciergeLintRunner — the seam that MOUNTS the linter.
//
// `services/conciergeLint/` was complete, tested, and called by nothing. A linter that never runs is
// indistinguishable from no linter, and worse than one: the tests stay green while the guarantee is
// absent, which is the exact "spec with no test" failure the linter was built to end, one level up.
// This module is the only caller, and `ConciergeHost` is the only caller of this module.
//
// It lives OUTSIDE the component on purpose. Everything here is a pure function of its arguments
// plus two injected sinks, so the mount can be tested without rendering `ConciergeHost` — a
// component whose test file already mounts a Tauri-shaped world. The React side is then two lines
// with no logic in them, which is the amount of untested surface this design can afford.
//
// ══ NEVER THROWS, AND THE SINKS ARE FIRE-AND-FORGET ═════════════════════════════════════════════
// `lintReply` already refuses to throw; this wrapper extends the same posture over the sinks. A
// failed metrics increment or a rejected `invoke` must not cost the user their reply, so both are
// swallowed with a console warning. The reply is the product; the telemetry is the byproduct, and
// the byproduct never gets to break the product.
import { invoke } from "@tauri-apps/api/core";
import { lintReply } from "./conciergeLint";
import type { LintPolicy, LintResult, LintToolCall, Violation } from "./conciergeLint";
import type { ConciergeToolCall } from "./concierge";
import {
  LINT_CHECK_IDS,
  useConciergeLintMetrics,
  type LintAction,
  type LintCheckId,
} from "../stores/conciergeLintMetrics";

/** The Tauri command that appends one metadata-only record to `<app_data>/concierge-lint.jsonl`.
 *  Named once so the string is not retyped at the call site and in the test that pins it. */
export const LINT_LOG_COMMAND = "concierge_lint_log";

/** Runtime membership test for the counter's key space. `LintCheckId` is a compile-time union and
 *  the linter's registry is open (`registerCheck`), so a check id CAN arrive that this build's
 *  counter has no column for. Silently `??`-ing it into an existing key would corrupt a number the
 *  whole feature exists to make trustworthy — so an unknown id is logged to disk (where it is just
 *  a string) and skipped by the counter. */
function isCountableCheck(id: string): id is LintCheckId {
  return (LINT_CHECK_IDS as readonly string[]).includes(id);
}

/** `ConciergeDoneEvent` carries each tool call's `input` as the RAW JSON STRING claude emitted;
 *  `LintToolCall.input` is `unknown` because the shape is per-tool. Parsing here rather than in each
 *  check means one parse per call instead of one per check, and — more importantly — one place where
 *  an unparseable input is decided. It stays as the raw string in that case rather than becoming
 *  `null`: a check scanning for pasted relay text wants the characters, and a string that failed to
 *  parse is still the characters. */
function toLintToolCalls(calls: readonly ConciergeToolCall[] | undefined): LintToolCall[] {
  if (!Array.isArray(calls)) return [];
  return calls.map((c) => {
    let input: unknown = c?.input;
    if (typeof c?.input === "string") {
      try {
        input = JSON.parse(c.input);
      } catch {
        input = c.input;
      }
    }
    return { name: typeof c?.name === "string" ? c.name : "", input };
  });
}

/** What `runReplyLint` needs. Deliberately NOT `LintContext`: the caller supplies turn facts and
 *  this module builds the context, so `ConciergeHost` never has to know the linter's shape. */
export interface ReplyLintInput {
  text: string;
  /** The concierge turn id, recorded on each log line so "the same violation 40 times in one turn"
   *  is distinguishable from "40 turns each violating once". Not identifying: it is a counter. */
  turnId: string;
  toolCalls?: readonly ConciergeToolCall[];
  /** The previous concierge reply in this thread, or null when this is the first. */
  prevReply?: string | null;
  policy: LintPolicy;
}

/** Injected so tests never touch Tauri or the real store. Production defaults are the real sinks. */
export interface LintSinks {
  record?: (check: LintCheckId, action: LintAction, count?: number) => void;
  log?: (violation: Record<string, unknown>) => void;
}

function defaultRecord(check: LintCheckId, action: LintAction, count = 1): void {
  useConciergeLintMetrics.getState().recordViolation(check, action, count);
}

function defaultLog(violation: Record<string, unknown>): void {
  // Fire-and-forget. `invoke` returns a promise that rejects when the command is missing (an older
  // backend) — unhandled, that becomes an unhandled rejection, so the `.catch` is load-bearing and
  // not decoration.
  void invoke(LINT_LOG_COMMAND, { violation }).catch((err) => {
    console.warn("conciergeLint: violation log failed", err);
  });
}

/**
 * Lint one finished concierge reply, count what fired, and record it to disk.
 *
 * Returns the `LintResult` — `text` is what the caller must render (rewritten if a check autofixed,
 * byte-identical otherwise), and `blocked` says a blocking check fired.
 *
 * Never throws.
 */
export function runReplyLint(input: ReplyLintInput, sinks: LintSinks = {}): LintResult {
  const text = typeof input?.text === "string" ? input.text : "";
  const fallback: LintResult = { text, violations: [], blocked: false };
  try {
    const result = lintReply(text, {
      // The roster and refusal checks are not implemented in this build, so these are empty rather
      // than absent — every implemented check reads only `policy`, `toolCalls` and `prevReply`. The
      // drift test in conciergeLintRegistry.test.ts is what keeps that statement true: a check
      // configured to run with no implementation fails there, rather than reading an empty roster
      // here and quietly finding nothing.
      roster: [],
      toolCalls: toLintToolCalls(input?.toolCalls),
      refusals: [],
      prevReply: typeof input?.prevReply === "string" ? input.prevReply : null,
      policy: input.policy,
    });
    // Counters are session-scoped and in-memory; `log = false` governs the DISK sink ONLY, so the
    // readout still works for a user who merely opted out of persistence. Passed as an explicit flag
    // rather than by withholding the sink: `sinks.log ?? defaultLog` would fall straight THROUGH an
    // omitted sink to the real one, writing the very file the user switched off.
    reportViolations(result.violations, input.turnId, sinks, input.policy?.log !== false);
    return result;
  } catch (err) {
    // `lintReply` does not throw, so reaching here means the wrapper itself broke. Render the
    // original text: the reply survives every failure in this file.
    console.warn("conciergeLint: runReplyLint failed; rendering the reply unlinted", err);
    return fallback;
  }
}

/** Count each violation and append it to the JSONL. Each sink is guarded separately so a broken
 *  counter cannot cost the disk record, or vice versa. */
function reportViolations(
  violations: readonly Violation[],
  turnId: string,
  sinks: LintSinks,
  logToDisk: boolean,
): void {
  if (!Array.isArray(violations) || violations.length === 0) return;
  const record = sinks.record ?? defaultRecord;
  const log = sinks.log ?? defaultLog;
  for (const v of violations) {
    if (!v || typeof v.check !== "string") continue;
    try {
      if (isCountableCheck(v.check)) record(v.check, v.action, 1);
    } catch (err) {
      console.warn("conciergeLint: metrics increment failed", err);
    }
    if (!logToDisk) continue;
    try {
      // `ts` is stamped here rather than in Rust so the record carries the moment the violation was
      // DECIDED, not the moment a queued command happened to run.
      log({
        ts: Date.now(),
        turn: String(turnId ?? ""),
        check: v.check,
        severity: v.severity,
        action: v.action,
        count: 1,
        span: Number.isFinite(v.span) ? v.span : 0,
      });
    } catch (err) {
      console.warn("conciergeLint: violation log failed", err);
    }
  }
}
