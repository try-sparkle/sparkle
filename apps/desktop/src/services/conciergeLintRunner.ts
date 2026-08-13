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
export function toLintToolCalls(calls: readonly ConciergeToolCall[] | undefined): LintToolCall[] {
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
  /** The user message(s) this reply is answering, oldest first — each one already reduced to the
   *  same one-line excerpt the reply's anchor stub shows (`ReplyAnchor.quote`). Omitted or `[]`
   *  means the reply answers nothing, which is the honest state for a proactive push and the state
   *  `reply-without-quote` stands down on.
   *
   *  MAPPED AT THE BOUNDARY, deliberately: `LintContext` is a leaf contract with no dependency on
   *  `components/`, so `ConciergeHost` hands over `ReplyAnchor[]` reduced to their quotes and this
   *  module is the only place that knows both shapes. */
  founderMessages?: readonly string[];
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
 * ══ A BLOCKED RESULT IS NOT REPORTED HERE ═══════════════════════════════════════════════════════
 * Every check hardcodes `action: "warned"`, because only a component that actually performs a
 * revision may honestly claim one (roborev 55981). The mount is now that component — but at the
 * moment this function returns, NOBODY yet knows how the block path ended: the correction turn has
 * not run, so "revised" and "rendered_marked" are both still live. Counting `warned` now and the
 * real action later would report the same violation twice, and the counter is the one number this
 * whole feature exists to make trustworthy.
 *
 * So a blocked result's violations are returned UNREPORTED and the caller MUST finish them with
 * {@link reportLintOutcome} once the outcome is known. `ConciergeHost`'s block path is the only
 * caller, and its every exit — corrected, retry-also-blocked, correction failed, correction never
 * arrived — passes through that call.
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
      // `[]` when the caller said nothing, and that is the SAFE default here rather than merely the
      // tidy one: an empty answer set makes `reply-without-quote` stand down, so a caller that has
      // not been taught to supply this loses a finding instead of manufacturing one.
      founderMessages: Array.isArray(input?.founderMessages)
        ? input.founderMessages.filter((m): m is string => typeof m === "string")
        : [],
      policy: input.policy,
    });
    // Counters are session-scoped and in-memory; `log = false` governs the DISK sink ONLY, so the
    // readout still works for a user who merely opted out of persistence. Passed as an explicit flag
    // rather than by withholding the sink: `sinks.log ?? defaultLog` would fall straight THROUGH an
    // omitted sink to the real one, writing the very file the user switched off.
    //
    // BLOCKED RESULTS ARE HELD BACK — see this function's header. The caller reports them through
    // `reportLintOutcome` with the action that actually happened.
    if (!result.blocked) reportViolations(result.violations, input.turnId, sinks, input.policy?.log !== false);
    return result;
  } catch (err) {
    // `lintReply` does not throw, so reaching here means the wrapper itself broke. Render the
    // original text: the reply survives every failure in this file.
    console.warn("conciergeLint: runReplyLint failed; rendering the reply unlinted", err);
    return fallback;
  }
}

/** Count each violation and append it to the JSONL. Each sink is guarded separately so a broken
 *  counter cannot cost the disk record, or vice versa.
 *
 *  READS `v.action` AND NOTHING ELSE. An earlier cut took an `action` override parameter here as
 *  well, which was dead the moment {@link reportLintOutcome} started re-stamping the violations it
 *  passes: two ways to say the same thing, one of them unreachable and therefore untestable. The
 *  stamp happens at exactly one place, in the caller. */
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

/** What {@link reportLintOutcome} needs: the held violations, the turn they were found in, the
 *  policy that governs the disk sink, and what the mount ACTUALLY did about them. */
export interface LintOutcomeInput {
  violations: readonly Violation[];
  turnId: string;
  /** `"revised"` only when a correction reply actually replaced the held one on screen;
   *  `"rendered_marked"` on every give-up path. Never `"warned"` — a blocked reply that merely
   *  warned is a contradiction the block path does not produce. */
  action: LintAction;
  policy: LintPolicy;
}

/**
 * Finish a HELD (blocked) reply's violations, stamping each with the action that actually happened.
 *
 * This is the other half of {@link runReplyLint}'s deferral, and it is what makes `"revised"` an
 * honest number rather than an aspiration: it is written by the one component that performs a
 * revision, at the moment the revision has already landed. A reply that was never corrected reaches
 * here with `"rendered_marked"`, so the rollup cannot be inflated by counting an intention.
 *
 * Returns the violations as stamped, so a caller rendering them does not have to re-derive the
 * action, and so a test can assert the stamp rather than only the sink.
 *
 * Never throws — same posture as everything else in this file. The reply is the product.
 */
export function reportLintOutcome(input: LintOutcomeInput, sinks: LintSinks = {}): Violation[] {
  const violations = Array.isArray(input?.violations) ? input.violations : [];
  const stamped = violations.filter((v) => !!v).map((v) => ({ ...v, action: input.action }));
  try {
    reportViolations(stamped, input?.turnId ?? "", sinks, input?.policy?.log !== false);
  } catch (err) {
    console.warn("conciergeLint: reporting the block outcome failed", err);
  }
  return stamped;
}

/**
 * WHAT THE CONCIERGE IS TOLD WHEN ITS REPLY IS HELD — one instruction per check that fired.
 *
 * ══ METADATA ONLY, LIKE EVERYTHING ELSE THAT LEAVES THIS SUBSYSTEM ══════════════════════════════
 * Keyed by CHECK ID and nothing else. `Violation.span` is a character COUNT and never the text
 * (services/conciergeLint/types.ts), `detail` is under the same rule, and the correction prompt is
 * the one place where quoting the offending sentence back would have been the obvious thing to do.
 * It would also be the place where reply prose starts travelling — so the prompt is assembled from
 * fixed sentences the way `Concierge/lintMarks` assembles the reader-facing ones, and carries not
 * one character of the reply it is about. The model still has its own last message in session
 * context, which is where the prose belongs.
 *
 * Each row says the COMPLIANT FORM, not the complaint. "Said it would do it" tells a reader what
 * went wrong; it does not tell the model what to write instead, and a re-prompt that only names the
 * fault invites an apology rather than a corrected reply.
 */
const CHECK_CORRECTIONS: Record<string, string> = {
  "ask-without-action":
    "You offered to do something instead of doing it. Carry it out with the tools you have and report what happened, or say plainly what is stopping you — do not ask permission for something you can just do.",
  "unbacked-claim":
    "You said you had already done something, but this turn made no call that would have done it. Either do it now and report the result, or drop the claim.",
  "reply-without-quote":
    "You did not open by quoting what I said. Start your reply with a short blockquote (`> ...`) of my own words — one for each message you are answering — and put it before anything else.",
  "hedge-words": "You hedged. Say what happened, or what you are about to do, in plain words.",
  "restated-state": "You repeated something you had already said. Cut it and lead with what is new.",
  "naked-file-ref":
    "You named a file without saying anything about it. Say what in it matters, or leave it out.",
  "relay-paste": "You pasted my own words back at me. Cut them and answer instead.",
  "actions-first": "You buried what you did under the explanation. Lead with what you did.",
  "unreported-refusal":
    "Something refused you this turn and your reply did not mention it. Say what was refused and what it means.",
  "bare-agent-name": "You named an agent as plain text. Use the pill form so it can be clicked.",
  "bare-pr-number": "You named a PR as plain text. Use the pill form so it can be clicked.",
  "fat-pill-label": "You put a whole sentence inside a pill. A pill carries a name, not a sentence.",
  "unresolved-agent-pill":
    "You linked an agent that is not there. Drop the pill or name the agent that actually exists.",
};

/** How many instructions one correction prompt may carry. The registry is open and `hedge-words`
 *  reports one violation PER WORD, so an unbounded list is a prompt that grows with how bad the
 *  reply was — and a model handed twenty instructions follows none of them. Deduped by check id
 *  first, so this only ever bites a reply that broke six distinct rules. */
export const MAX_CORRECTION_INSTRUCTIONS = 6;

/** The instruction for one check id. Names the id when there is no row, exactly as
 *  `lintCheckSentence` does and for the same reason: a missing row is a gap in this file, and copy
 *  that reads deliberate would hide it. */
function correctionFor(check: string): string {
  return CHECK_CORRECTIONS[check] ?? `Your reply was flagged by the "${check}" check. Fix it.`;
}

/**
 * The one re-prompt a blocked reply gets.
 *
 * Deduped by check id and capped, in registry order — `lintReply` pushes violations in the order
 * the checks ran, so the head of this list is stable for a given reply rather than a race.
 *
 * Returns `""` when nothing usable was passed, and the mount reads that as "do not dispatch":
 * spending a paid turn on a prompt with no instructions in it is strictly worse than rendering the
 * reply marked.
 */
export function buildLintCorrectionPrompt(violations: readonly Violation[] | undefined): string {
  if (!Array.isArray(violations)) return "";
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const v of violations) {
    const check = typeof v?.check === "string" ? v.check : "";
    if (!check || seen.has(check)) continue;
    seen.add(check);
    lines.push(`- ${correctionFor(check)}`);
    if (lines.length === MAX_CORRECTION_INSTRUCTIONS) break;
  }
  if (lines.length === 0) return "";
  return [
    "Your last reply was held back before it reached me — the reply linter blocked it. Write that reply again, corrected.",
    "",
    "What has to change:",
    ...lines,
    "",
    "Reply with the corrected message only. Do not apologise, do not mention the linter, and do not explain what you changed.",
  ].join("\n");
}
