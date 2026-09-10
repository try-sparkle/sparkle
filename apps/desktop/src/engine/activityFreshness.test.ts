import { describe, it, expect } from "vitest";
import {
  ACTIVITY_STALE_MS,
  activityAgeMs,
  formatActivityAge,
  isActivityStale,
  presentActivity,
} from "./activityFreshness";

const NOW = 1_800_000_000_000;

describe("activityAgeMs", () => {
  it("returns the elapsed ms for a past stamp", () => {
    expect(activityAgeMs(NOW - 5_000, NOW)).toBe(5_000);
  });

  it("is null for a MISSING stamp — unknown age, not zero", () => {
    // The distinction is load-bearing: 0 would read as 'just written', which is the exact
    // over-trust this module exists to remove. Unknown must stay unknown.
    expect(activityAgeMs(undefined, NOW)).toBeNull();
  });

  it("is null for a FUTURE stamp rather than a negative age", () => {
    expect(activityAgeMs(NOW + 10_000, NOW)).toBeNull();
  });

  it("is 0 exactly at the stamp instant", () => {
    expect(activityAgeMs(NOW, NOW)).toBe(0);
  });
});

describe("isActivityStale — a self-report too old (or too unknown) to read as current", () => {
  it("a fresh stamp within the window is NOT stale", () => {
    expect(isActivityStale(NOW - (ACTIVITY_STALE_MS - 1), NOW)).toBe(false);
  });

  it("a stamp past the window IS stale", () => {
    expect(isActivityStale(NOW - (ACTIVITY_STALE_MS + 1), NOW)).toBe(true);
  });

  it("exactly at the window boundary is NOT yet stale (strictly greater)", () => {
    expect(isActivityStale(NOW - ACTIVITY_STALE_MS, NOW)).toBe(false);
  });

  it("a MISSING stamp is STALE — the fail direction is distrust", () => {
    // This is the death the module is named for: an hours-old 'blocked on the outage' line with no
    // durable stamp (e.g. restored from persistence) must NOT be treated as a live self-report.
    expect(isActivityStale(undefined, NOW)).toBe(true);
  });

  it("a future stamp is treated as stale (unknown age), never as fresh", () => {
    expect(isActivityStale(NOW + 60_000, NOW)).toBe(true);
  });

  it("honours a custom staleMs", () => {
    expect(isActivityStale(NOW - 5_000, NOW, 10_000)).toBe(false);
    expect(isActivityStale(NOW - 15_000, NOW, 10_000)).toBe(true);
  });
});

describe("formatActivityAge — the coarse quote suffix", () => {
  it("reads 'just now' under ten seconds", () => {
    expect(formatActivityAge(NOW - 3_000, NOW)).toBe("just now");
  });

  it("counts seconds, then minutes, then hours, then days", () => {
    expect(formatActivityAge(NOW - 42_000, NOW)).toBe("42s ago");
    expect(formatActivityAge(NOW - 5 * 60_000, NOW)).toBe("5m ago");
    expect(formatActivityAge(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
    expect(formatActivityAge(NOW - 2 * 86_400_000, NOW)).toBe("2d ago");
  });

  it("is null for an unknown (missing/future) stamp so the caller shows no false age", () => {
    expect(formatActivityAge(undefined, NOW)).toBeNull();
    expect(formatActivityAge(NOW + 1_000, NOW)).toBeNull();
  });
});

describe("presentActivity — provenance (bead )", () => {
  const NOW = 10_000_000;
  const FRESH = NOW - 5_000; // well inside ACTIVITY_STALE_MS
  const OLD = NOW - 3 * 60_000; // 3m — comfortably stale

  it("shows a fresh line bare, whoever wrote it", () => {
    // Fresh, the two sources read identically ON PURPOSE: both are a present-tense description of
    // current work, and prefixing every row with a provenance badge would be noise on the surface
    // that was deliberately trimmed to one line. Provenance still reaches the reader via `title`.
    expect(presentActivity("Wiring the login screen", FRESH, "self", NOW).label).toBe(
      "Wiring the login screen",
    );
    expect(presentActivity("Wiring the login screen", FRESH, "narrated", NOW).label).toBe(
      "Wiring the login screen",
    );
  });

  it("a stale SELF-report reads as something the agent said", () => {
    const p = presentActivity("Wiring the login screen", OLD, "self", NOW);
    expect(p.stale).toBe(true);
    expect(p.label).toBe("said “Wiring the login screen” · 3m ago");
  });

  it("a stale NARRATION does not claim the agent said it", () => {
    // THE COPY BUG THIS PREVENTS: nobody "said" a narrated line — Sparkle summarized it from the
    // transcript. Rendering it as a quote attributes words to the agent it never wrote.
    const p = presentActivity("Wiring the login screen", OLD, "narrated", NOW);
    expect(p.stale).toBe(true);
    expect(p.label).toBe("as of 3m ago: Wiring the login screen");
    expect(p.label).not.toMatch(/said/);
  });

  it("never claims LIVENESS for a stale narration", () => {
    // A stale narration means no turn has ENDED recently, which is consistent with a long turn AND
    // with an agent that died mid-turn. Wording like "working for 3m" would assert the first; this
    // module cannot support that claim and must not make it (see engine header: liveness comes from
    // real tool activity, never from this prose).
    const p = presentActivity("Wiring the login screen", OLD, "narrated", NOW);
    expect(p.label).not.toMatch(/working|running|still|active/i);
  });

  it("titles state provenance in full, and disagree with each other", () => {
    const self = presentActivity("Wiring it", FRESH, "self", NOW).title;
    const narrated = presentActivity("Wiring it", FRESH, "narrated", NOW).title;
    expect(self).toMatch(/Self-reported/);
    expect(narrated).toMatch(/Summarized by Sparkle/);
    // The positive half alone would pass if BOTH titles said both things.
    expect(narrated).not.toMatch(/Self-reported/);
    expect(self).not.toMatch(/Summarized by Sparkle/);
  });

  it("treats an unknown source as self, which is what every legacy line was", () => {
    // Records written before provenance existed carry no source. They were all self-reports, so
    // defaulting to "narrated" would retroactively mislabel the entire persisted backlog.
    const p = presentActivity("Wiring it", OLD, undefined, NOW);
    expect(p.label).toBe("said “Wiring it” · 3m ago");
    expect(p.title).toMatch(/Self-reported/);
  });

  it("says the age is unknown rather than inventing one", () => {
    const p = presentActivity("Wiring it", undefined, "narrated", NOW);
    expect(p.stale).toBe(true); // unknown age folds to stale — the conservative direction
    expect(p.label).toBe("as of age unknown: Wiring it");
    expect(p.title).toMatch(/age unknown/);
  });
});
