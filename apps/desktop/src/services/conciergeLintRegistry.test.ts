// The drift guard between the SHIPPED CHECK POLICY (config.rs) and the CHECKS THAT EXIST
// (services/conciergeLint/).
//
// ══ WHY THIS FILE EXISTS ════════════════════════════════════════════════════════════════════════
// The linter shipped with eleven configured check ids and four implementations. Seven ids — four of
// them at `severity = "block"` — had no code behind them at all. Nothing failed: `lintReply`
// iterates the IMPLEMENTED registry and looks each check's policy up by id, so a policy row with no
// implementation is a silent no-op. The suite stayed green while `config.toml` told the user that a
// relayed paste could not reach them.
//
// That is the same failure the linter was built to end — a spec with nothing checking it — one level
// up, so it gets the same treatment: a test outside the thing being trusted.
//
// The rule enforced here is narrow and deliberately one-directional:
//
//     every configured id whose severity is NOT "off" MUST have an implementation
//
// Not the converse. An implemented check with no policy row is already safe (`lintReply` skips a
// check with no row), and requiring a row would block landing a check and its policy in separate
// commits. The dangerous direction is the one that PROMISES enforcement — and that is the one that
// fails here.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHECKS } from "./conciergeLint";
import { LINT_CHECK_IDS } from "../stores/conciergeLintMetrics";

/** Read the Rust default policy table. Source-scraping across a language boundary is fragile, so the
 *  extractor asserts its own preconditions below rather than silently matching nothing — a regex
 *  that quietly finds zero rows would make this whole file vacuously green, which is precisely the
 *  failure mode it exists to catch. */
function configRs(): string {
  return readFileSync(new URL("../../src-tauri/src/config.rs", import.meta.url), "utf8");
}

interface DefaultRow {
  id: string;
  severity: string;
}

function defaultChecks(): DefaultRow[] {
  const src = configRs();
  const start = src.indexOf("const DEFAULT_CONCIERGE_CHECKS");
  expect(start, "DEFAULT_CONCIERGE_CHECKS not found in config.rs — did it get renamed?").toBeGreaterThan(-1);
  const end = src.indexOf("\n];", start);
  expect(end, "DEFAULT_CONCIERGE_CHECKS has no terminator").toBeGreaterThan(start);
  const block = src.slice(start, end);

  const rows: DefaultRow[] = [];
  for (const chunk of block.split("DefaultCheck {").slice(1)) {
    // Strip `//` comment lines FIRST. The table's prose names severities in English ("intended
    // block"), and a naive scan would read those as values.
    const code = chunk
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    const id = /\bid:\s*"([^"]+)"/.exec(code)?.[1];
    const severity = /\bseverity:\s*"([^"]+)"/.exec(code)?.[1];
    if (id && severity) rows.push({ id, severity });
  }
  return rows;
}

describe("concierge lint registry ↔ config policy", () => {
  it("extracts the shipped policy table at all (guards the scraper itself)", () => {
    const rows = defaultChecks();
    // A floor, not the exact count: this must not need editing every time a check is added. But it
    // must be high enough that a broken regex returning [] or [one row] fails here rather than
    // making every assertion below pass on an empty set.
    expect(rows.length).toBeGreaterThanOrEqual(8);
    expect(rows.map((r) => r.id)).toContain("ask-without-action");
    for (const r of rows) expect(["block", "warn", "off"]).toContain(r.severity);
  });

  it("never ships a check configured to RUN that nothing implements", () => {
    const implemented = new Set(CHECKS.map((c) => c.id));
    const promised = defaultChecks().filter((r) => r.severity !== "off");
    const unimplemented = promised.filter((r) => !implemented.has(r.id));

    expect(
      unimplemented.map((r) => `${r.id} (severity=${r.severity})`),
      "config.rs configures these checks to RUN, but services/conciergeLint/ implements nothing " +
        "for them. A policy row with no implementation is a silent no-op that reads to the user as " +
        "an enforced rule. Either implement the check, or set its severity to \"off\" in " +
        "DEFAULT_CONCIERGE_CHECKS *and* in the DEFAULT_TEMPLATE block.",
    ).toEqual([]);
  });

  it("counts every implemented check — an id the counter lacks is a permanent zero", () => {
    // `runReplyLint` skips an uncountable id rather than corrupting a neighbouring column, so this
    // drift does not crash: it makes the check's count read 0 forever, which is indistinguishable
    // from "it never fires" on the readout the whole feature exists to produce. This is exactly how
    // `ask-without-action` — the only blocking check — had nowhere to be counted.
    const countable = new Set<string>(LINT_CHECK_IDS);
    const missing = CHECKS.map((c) => c.id).filter((id) => !countable.has(id));
    expect(
      missing,
      "these checks run but LINT_CHECK_IDS in stores/conciergeLintMetrics.ts has no column for " +
        "them, so their violations are never counted",
    ).toEqual([]);
  });

  it("the seven designed-but-unbuilt checks are all shipped off", () => {
    // Pins the specific decision rather than only the general rule, so re-enabling one of these
    // without implementing it fails HERE too, naming it — a clearer failure than the generic
    // assertion above.
    const rows = new Map(defaultChecks().map((r) => [r.id, r.severity]));
    for (const id of [
      "relay-paste",
      "bare-agent-name",
      "bare-pr-number",
      "unresolved-agent-pill",
      "fat-pill-label",
      "actions-first",
      "unreported-refusal",
    ]) {
      expect(rows.get(id), `${id} is configured but not implemented; it must ship "off"`).toBe("off");
    }
  });

  // ══ THE "NOTHING IMPLEMENTS BLOCKING" TEST USED TO LIVE HERE, AND IT IS GONE ON PURPOSE ════════
  // It asserted that no check could ship at `severity = "block"`, because `lintReply` computed
  // `LintResult.blocked` and the mount read `.text` and DISCARDED the flag — so `"block"` behaved
  // exactly like `"warn"` while `config.rs` documented it as "re-prompts the concierge once for a
  // corrected reply". That test said, in its own body, to delete it in the change that implements
  // the re-prompt. This is that change (bead sparkle-ugohl).
  //
  // `ConciergeHost` now HOLDS a blocked reply, dispatches exactly one correction turn, and renders
  // the correction — or the held original, marked, on every failure path. What replaces the pin is
  // behaviour, not another list assertion:
  //   • components/ConciergeHost.lintBlock.test.tsx — the mount's block path, end to end.
  //   • services/conciergeLintRunner.test.ts — the deferred report and the correction prompt.
  // The row ABOVE this one still holds the real invariant: a check with a non-"off" severity must
  // have an implementation behind it. Blocking is now an implemented effect, so it no longer needs
  // its own exception.

  it("the DEFAULT_TEMPLATE block agrees with the table on every severity", () => {
    // Two hand-maintained copies of the same policy. Rust's own test asserts they PARSE to the same
    // config; this asserts the human-readable template a user opens does not say "block" where the
    // table says "off" — the template is what someone reads to decide whether a rule is enforced.
    const src = configRs();
    for (const { id, severity } of defaultChecks()) {
      const header = `[concierge.checks.${id}]`;
      const at = src.indexOf(header);
      expect(at, `${header} missing from DEFAULT_TEMPLATE`).toBeGreaterThan(-1);
      const section = src.slice(at, at + 400);
      const shown = /severity\s*=\s*"([^"]+)"/.exec(section)?.[1];
      expect(shown, `${header} severity in DEFAULT_TEMPLATE`).toBe(severity);
    }
  });
});
