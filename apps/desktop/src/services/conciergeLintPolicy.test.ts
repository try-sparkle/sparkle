import { describe, expect, it } from "vitest";
import { DISABLED_POLICY, SEVERITY_FALLBACK, toLintPolicy } from "./conciergeLintPolicy";
import type { ConciergeChecksConfigPayload } from "./config";

const payload = (over: Partial<ConciergeChecksConfigPayload> = {}): ConciergeChecksConfigPayload => ({
  enabled: true,
  log: true,
  log_matches: false,
  checks: {},
  ...over,
});

describe("toLintPolicy", () => {
  it("resolves an ABSENT section to the disabled policy, not to the shipped defaults", () => {
    // The direction that matters: a backend predating [concierge.checks] sends no key, and
    // defaulting that to "lint with the shipped policy" would switch a gate on from a payload that
    // cannot express disagreement.
    expect(toLintPolicy(undefined)).toEqual(DISABLED_POLICY);
    expect(toLintPolicy(null)).toEqual(DISABLED_POLICY);
    expect(toLintPolicy(undefined).enabled).toBe(false);
  });

  it("resolves the master switch OFF to a policy with no rows at all", () => {
    const p = toLintPolicy(payload({ enabled: false, checks: { "hedge-words": { enabled: true, severity: "block", autofix: false } } }));
    expect(p.enabled).toBe(false);
    expect(p.checks).toEqual({});
  });

  it("resolves an UNRECOGNIZED severity to warn — never to off", () => {
    // The opposite direction from the absent case, and deliberately so: the user was editing that
    // line. A typo in a line written to TIGHTEN a check must not silently disable it.
    const p = toLintPolicy(
      payload({ checks: { "hedge-words": { enabled: true, severity: "blokc", autofix: false } } }),
    );
    expect(p.checks["hedge-words"]!.severity).toBe(SEVERITY_FALLBACK);
    expect(p.checks["hedge-words"]!.severity).toBe("warn");
    expect(p.checks["hedge-words"]!.severity).not.toBe("off");
  });

  it("keeps a recognized severity verbatim, including off", () => {
    const p = toLintPolicy(
      payload({
        checks: {
          a: { enabled: true, severity: "block", autofix: false },
          b: { enabled: true, severity: "warn", autofix: false },
          c: { enabled: true, severity: "off", autofix: false },
        },
      }),
    );
    expect([p.checks.a!.severity, p.checks.b!.severity, p.checks.c!.severity]).toEqual([
      "block",
      "warn",
      "off",
    ]);
  });

  it("renames log_matches to logMatches, and defaults it OFF", () => {
    // A wrong read here fails OPEN — into writing span hashes to disk that the user opted out of —
    // so both directions are pinned.
    expect(toLintPolicy(payload({ log_matches: true })).logMatches).toBe(true);
    expect(toLintPolicy(payload({ log_matches: false })).logMatches).toBe(false);
    expect(toLintPolicy(payload({} as never)).logMatches).toBe(false);
    // The snake_case key must not survive onto the policy object.
    expect(toLintPolicy(payload({ log_matches: true }))).not.toHaveProperty("log_matches");
  });

  it("drops a non-object row rather than fabricating a default policy for it", () => {
    const p = toLintPolicy(
      payload({ checks: { good: { enabled: true, severity: "warn", autofix: false }, bad: true as never, worse: null as never } }),
    );
    expect(Object.keys(p.checks)).toEqual(["good"]);
  });

  it("treats threshold 0 as a real value and a missing threshold as absent", () => {
    const p = toLintPolicy(
      payload({
        checks: {
          zero: { enabled: true, severity: "warn", autofix: false, threshold: 0 },
          none: { enabled: true, severity: "warn", autofix: false, threshold: null },
        },
      }),
    );
    expect(p.checks.zero!.threshold).toBe(0);
    expect(p.checks.none).not.toHaveProperty("threshold");
  });

  it("disables a row only on an explicit false", () => {
    const p = toLintPolicy(
      payload({
        checks: {
          off: { enabled: false, severity: "warn", autofix: false },
          unstated: { severity: "warn", autofix: false } as never,
        },
      }),
    );
    expect(p.checks.off!.enabled).toBe(false);
    expect(p.checks.unstated!.enabled).toBe(true);
  });
});
