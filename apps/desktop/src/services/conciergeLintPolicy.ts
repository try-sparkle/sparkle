// conciergeLintPolicy — the ONE place `[concierge.checks]` becomes a `LintPolicy`.
//
// config.rs keeps every check row VERBATIM, including a `severity` it does not recognize, and says
// so deliberately: "the raw string is what makes the warning nameable and fixable". That leaves the
// narrowing to exactly one consumer, and this is it. Doing it here rather than in each check means
// a hand-edited typo resolves identically for all of them.
//
// ══ THE TWO DIRECTIONS ARE NOT SYMMETRIC, AND THAT IS THE WHOLE DESIGN ══════════════════════════
// An ABSENT or unusable section resolves to the DISABLED policy — `enabled: false`, no rows. An
// unrecognized SEVERITY on a row that does exist resolves to `"warn"`, never `"off"`.
//
// They point opposite ways on purpose:
//
//   • Absent section → off. A backend predating `[concierge.checks]` sends no key. Defaulting that
//     to the shipped policy would switch a BLOCKING gate on underneath a user who never configured
//     one, from a payload that cannot express disagreement. `lintReply` already refuses to run a
//     check with no policy row for the same reason; this is that rule one level up.
//   • Bad severity on a present row → warn. The user was editing that line. A typo in a line
//     written to TIGHTEN a check must not silently switch the check off — that turns a fat-fingered
//     keystroke into a disabled gate nobody notices. `CONCIERGE_CHECK_SEVERITY_FALLBACK` in
//     config.rs picks `"warn"` for this exact reason and `[concierge.tools]` resolves an
//     unrecognized decision to the stricter `"ask"` on the same principle.
//
// Getting either backwards fails silently, which is why both are pinned by tests.
import type { ConciergeChecksConfigPayload } from "./config";
import type { CheckPolicy, LintPolicy, Severity } from "./conciergeLint";
import { LINT_SEVERITIES } from "./conciergeLint/types";

/** The severity an unreadable value resolves to. Mirrors `CONCIERGE_CHECK_SEVERITY_FALLBACK` in
 *  config.rs; the sibling test pins the two together so a change on either side fails somewhere. */
export const SEVERITY_FALLBACK: Severity = "warn";

/** The policy an absent, malformed, or backend-predating `[concierge.checks]` resolves to: the
 *  linter does not run and the reply is returned untouched. Exported so tests and callers assert
 *  against the value rather than re-describing it. */
export const DISABLED_POLICY: LintPolicy = {
  enabled: false,
  log: false,
  logMatches: false,
  checks: {},
};

function isSeverity(v: unknown): v is Severity {
  return typeof v === "string" && (LINT_SEVERITIES as readonly string[]).includes(v);
}

/** A row survives only if it is an object. A non-object row (a bare `true`, a string, null from a
 *  hand-edited file that lost its table header) yields no policy at all rather than a row of
 *  defaults — a fabricated row would be this module inventing a policy the file never stated. */
function toCheckPolicy(raw: unknown): CheckPolicy | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  return {
    // Only an explicit `false` disables. An absent key means the row exists but did not say, and
    // Rust's own `Default` for an unknown id is `enabled: true` — matching it keeps a row written by
    // a newer Sparkle from reading as off here.
    enabled: r.enabled !== false,
    severity: isSeverity(r.severity) ? r.severity : SEVERITY_FALLBACK,
    autofix: r.autofix === true,
    // `null` is how Rust's `Option::None` arrives. Distinct from `0`, which is a real threshold a
    // user can mean, so this narrows on finiteness rather than on truthiness.
    ...(typeof r.threshold === "number" && Number.isFinite(r.threshold)
      ? { threshold: r.threshold }
      : {}),
    ...(typeof r.words === "string" ? { words: r.words } : {}),
  };
}

/**
 * Build the linter's policy from the `[concierge.checks]` payload.
 *
 * Never throws and never returns a policy that runs a check the config did not describe. See this
 * module's header for why absent resolves to OFF while a bad severity resolves to WARN.
 */
export function toLintPolicy(payload: ConciergeChecksConfigPayload | undefined | null): LintPolicy {
  if (!payload || typeof payload !== "object") return DISABLED_POLICY;
  // The master switch is checked here AND in `lintReply`. Not redundant: this one stops the rows
  // being built at all, so a disabled linter cannot leak a policy object that some future caller
  // reads past the switch.
  if (payload.enabled !== true) return DISABLED_POLICY;

  const checks: Record<string, CheckPolicy> = {};
  const rows = payload.checks;
  if (rows && typeof rows === "object" && !Array.isArray(rows)) {
    for (const [id, raw] of Object.entries(rows)) {
      const policy = toCheckPolicy(raw);
      if (policy) checks[id] = policy;
    }
  }

  return {
    enabled: true,
    log: payload.log !== false,
    // snake_case on the wire (`rename_all = "snake_case"`), camelCase in the linter. The ONLY place
    // that rename happens — a second site would be a second chance to get it silently wrong, and a
    // wrong read here fails OPEN into logging span hashes the user opted out of.
    logMatches: payload.log_matches === true,
    checks,
  };
}
