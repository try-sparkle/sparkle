import { describe, it, expect } from "vitest";
import {
  spaceScore,
  compareBySpace,
  orderBySpace,
  usageColor,
  formatResetCaption,
  relativeResetPhrase,
  absolutePtPhrase,
  collapsedRunningAgents,
  signInStalled,
  PENDING_NICKNAME,
  SIGN_IN_STALL_SECONDS,
  type AccountSpaceInput,
} from "./accountsView";

function inp(over: Partial<AccountSpaceInput> & { id: string }): AccountSpaceInput {
  return {
    alias: over.id,
    usable: true,
    sessionUsedPct: 0,
    weeklyUsedPct: 0,
    ...over,
  };
}

describe("spaceScore", () => {
  it("blends session/weekly FREE with weekly weighted higher (0.4/0.6)", () => {
    // Fully idle → 100; fully spent → 0.
    expect(spaceScore(0, 0)).toBe(100);
    expect(spaceScore(100, 100)).toBe(0);
    // Weekly is weighted more: the SAME 50% used hurts more on the weekly window than the session.
    // session 50% used (weekly 0) → 0.4*50 + 0.6*100 = 80. weekly 50% used (session 0) → 0.4*100 +
    // 0.6*50 = 70. So a half-spent weekly leaves LESS space than a half-spent session.
    expect(spaceScore(50, 0)).toBeCloseTo(80);
    expect(spaceScore(0, 50)).toBeCloseTo(70);
    expect(spaceScore(0, 50)).toBeLessThan(spaceScore(50, 0));
  });
});

describe("orderBySpace / compareBySpace — most space first", () => {
  it("orders known-usage accounts by descending space, unknown below, signed-out last", () => {
    // The SIDE EFFECT: the returned ORDER. Distinct scores so the ranking is unambiguous:
    //   roomy   : session 10 / weekly 10 → score 90 (most space)
    //   middle  : session 50 / weekly 50 → score 50
    //   tight   : session 90 / weekly 90 → score 10 (least space, but still has data)
    //   unknown : usable, but weekly usage unreadable → below ALL accounts that have data
    //   signedOut: unusable → dead last regardless of anything else
    const accounts = [
      inp({ id: "signedOut", usable: false, sessionUsedPct: 0, weeklyUsedPct: 0 }),
      inp({ id: "tight", sessionUsedPct: 90, weeklyUsedPct: 90 }),
      inp({ id: "unknown", sessionUsedPct: 5, weeklyUsedPct: null }),
      inp({ id: "roomy", sessionUsedPct: 10, weeklyUsedPct: 10 }),
      inp({ id: "middle", sessionUsedPct: 50, weeklyUsedPct: 50 }),
    ];
    const order = orderBySpace(accounts, (a) => a).map((a) => a.id);
    expect(order).toEqual(["roomy", "middle", "tight", "unknown", "signedOut"]);
  });

  it("tie-breaks equal scores by higher weekly-free, then alias", () => {
    // Same blended score (both = 60) but different weekly-free: A weekly-free 70, B weekly-free 50.
    // A: session 0/weekly 100? no — pick pairs with equal 0.4s+0.6w. A=(session 40, weekly 40)→60;
    // B=(session 10, weekly 60)→0.4*90+0.6*40=60. Weekly-free: A=60, B=40 → A first.
    const A = inp({ id: "A", sessionUsedPct: 40, weeklyUsedPct: 40 });
    const B = inp({ id: "B", sessionUsedPct: 10, weeklyUsedPct: 60 });
    expect(spaceScore(40, 40)).toBeCloseTo(spaceScore(10, 60)); // equal blended score
    expect(orderBySpace([B, A], (a) => a).map((a) => a.id)).toEqual(["A", "B"]);

    // Fully equal usage → fall through to alias localeCompare (stable, deterministic).
    const z = inp({ id: "zebra", alias: "zebra", sessionUsedPct: 20, weeklyUsedPct: 20 });
    const a = inp({ id: "apple", alias: "apple", sessionUsedPct: 20, weeklyUsedPct: 20 });
    expect(orderBySpace([z, a], (x) => x).map((x) => x.id)).toEqual(["apple", "zebra"]);
  });

  it("does not mutate the input array", () => {
    const list = [inp({ id: "b", sessionUsedPct: 90, weeklyUsedPct: 90 }), inp({ id: "a" })];
    const before = list.map((x) => x.id);
    orderBySpace(list, (x) => x);
    expect(list.map((x) => x.id)).toEqual(before);
  });

  it("compareBySpace returns a positive number when a has LESS space than b", () => {
    // Direct comparator check: 'tight' has less space than 'roomy', so it sorts AFTER (positive).
    const roomy = inp({ id: "roomy", sessionUsedPct: 10, weeklyUsedPct: 10 });
    const tight = inp({ id: "tight", sessionUsedPct: 90, weeklyUsedPct: 90 });
    expect(compareBySpace(tight, roomy)).toBeGreaterThan(0);
    expect(compareBySpace(roomy, tight)).toBeLessThan(0);
  });
});

describe("usageColor — traffic-light buckets by used percent", () => {
  it("maps each half-open bucket at its boundaries (lower bound inclusive)", () => {
    // <40 green, [40,60) blue, [60,80) yellow, [80,90) orange, >=90 red. Boundaries are where an
    // off-by-one in the mapping shows up, so pin each step's edge.
    expect(usageColor(0)).toBe("green");
    expect(usageColor(39)).toBe("green");
    expect(usageColor(40)).toBe("blue");
    expect(usageColor(59)).toBe("blue");
    expect(usageColor(60)).toBe("yellow");
    expect(usageColor(79)).toBe("yellow");
    expect(usageColor(80)).toBe("orange");
    expect(usageColor(89)).toBe("orange");
    expect(usageColor(90)).toBe("red");
    expect(usageColor(91)).toBe("red");
    expect(usageColor(100)).toBe("red");
  });
});

describe("formatResetCaption — relative countdown + absolute PT time", () => {
  // A fixed instant that renders as "Aug 17, 3:59am PT": 3:59 AM PDT (UTC-7 in August) = 10:59 UTC.
  const RESET = Date.parse("2026-08-17T10:59:00.000Z");
  const H = 3_600_000;
  const M = 60_000;

  it("renders the absolute half as (Mon D, h:mmam/pm PT), lowercase, no leading-zero hour", () => {
    expect(absolutePtPhrase(RESET)).toBe("Aug 17, 3:59am PT");
  });

  it("uses hours when < 48h — exactly 36h reads 'Resets in 36 hours'", () => {
    expect(relativeResetPhrase(RESET - 36 * H, RESET)).toBe("Resets in 36 hours");
    expect(formatResetCaption(RESET - 36 * H, RESET)).toBe(
      "Resets in 36 hours (Aug 17, 3:59am PT)",
    );
  });

  it("uses minutes when < 1h, and days at/above 48h; singular is handled", () => {
    expect(relativeResetPhrase(RESET - 45 * M, RESET)).toBe("Resets in 45 minutes");
    expect(relativeResetPhrase(RESET - 1 * M, RESET)).toBe("Resets in 1 minute");
    expect(relativeResetPhrase(RESET - 1 * H, RESET)).toBe("Resets in 1 hour");
    // 48h is the hours→days boundary (>=48h → days).
    expect(relativeResetPhrase(RESET - 48 * H, RESET)).toBe("Resets in 2 days");
    expect(relativeResetPhrase(RESET - 47 * H, RESET)).toBe("Resets in 47 hours");
  });

  it("rounds ACROSS a bucket boundary into the next bucket, never past its own edge", () => {
    // The bucket is picked from the rounded value, so rounding can't emit a phrase the bucketing
    // forbids. 59m40s rounds to 60 minutes → reads "1 hour" (not the impossible "60 minutes");
    // 47h50m rounds to 48 hours → reads "2 days" (not "48 hours"). Against the pre-fix code — which
    // chose the bucket off the raw diff and then rounded — both of these printed the out-of-range
    // phrase.
    expect(relativeResetPhrase(RESET - (59 * M + 40_000), RESET)).toBe("Resets in 1 hour");
    expect(relativeResetPhrase(RESET - (47 * H + 50 * M), RESET)).toBe("Resets in 2 days");
    // …and a value comfortably inside the minutes bucket still reads in minutes.
    expect(relativeResetPhrase(RESET - (59 * M + 10_000), RESET)).toBe("Resets in 59 minutes");
  });

  it("reads 'Resets now' when the reset is already past", () => {
    expect(relativeResetPhrase(RESET + 1000, RESET)).toBe("Resets now");
  });
});

describe("collapsedRunningAgents — one-line running-agents collapse (item 13)", () => {
  it("shows all when <= 3, else first 2 names + the remainder count", () => {
    expect(collapsedRunningAgents([])).toEqual({ shown: [], moreCount: 0 });
    expect(collapsedRunningAgents(["a"])).toEqual({ shown: ["a"], moreCount: 0 });
    // Exactly 3 → all inline, no "+ more" (a "+1 more" reads worse than the third name).
    expect(collapsedRunningAgents(["a", "b", "c"])).toEqual({ shown: ["a", "b", "c"], moreCount: 0 });
    // 4 → first 2 + "+2 more".
    expect(collapsedRunningAgents(["a", "b", "c", "d"])).toEqual({ shown: ["a", "b"], moreCount: 2 });
    // 38 → first 2 + "+36 more".
    const many = Array.from({ length: 38 }, (_, i) => `agent-${i}`);
    expect(collapsedRunningAgents(many)).toEqual({ shown: ["agent-0", "agent-1"], moreCount: 36 });
  });
});

// ── A SIGN-IN THAT NEVER FINISHED ────────────────────────────────────────────────────────────────
//
// The founder found an account still titled "Signing in…" long after the login was abandoned. The
// placeholder is the row's PERSISTED nickname (AccountLimitModal writes it before running the login,
// so the credential lands in that account's own dir), and only a CONFIRMED sign-in renames it — so
// nothing ever cleans it up. These pin the rule that calls it a failure.
describe("signInStalled", () => {
  const T0 = 1_000_000; // epoch seconds
  const ms = (sec: number) => sec * 1000;

  it("is false while the sign-in is still plausibly running", () => {
    expect(signInStalled(PENDING_NICKNAME, T0, ms(T0 + 1))).toBe(false);
    expect(signInStalled(PENDING_NICKNAME, T0, ms(T0 + 119))).toBe(false);
  });

  it("is false exactly ON the boundary, and true just past it", () => {
    // Pinned in both directions so an off-by-one cannot pass by only ever being checked far away
    // from the deadline — which is where a wrong comparison still looks right.
    expect(signInStalled(PENDING_NICKNAME, T0, ms(T0 + SIGN_IN_STALL_SECONDS))).toBe(false);
    expect(signInStalled(PENDING_NICKNAME, T0, ms(T0 + SIGN_IN_STALL_SECONDS + 1))).toBe(true);
  });

  it("treats the units correctly — seconds in, milliseconds for now", () => {
    // THE failure this function exists to prevent. If `nowMs` were compared to `createdAtSeconds`
    // directly, a row created 10 minutes ago reads as ~1000x in the future and NEVER stalls, which
    // presents exactly as the bug being fixed. A 10-minute-old pending row must be stalled.
    expect(signInStalled(PENDING_NICKNAME, T0, ms(T0 + 600))).toBe(true);
  });

  it("never stalls a row that is not a pending sign-in, however old", () => {
    expect(signInStalled("DROdio Storytell", T0, ms(T0 + 10_000_000))).toBe(false);
    expect(signInStalled("", T0, ms(T0 + 10_000_000))).toBe(false);
  });

  it("refuses to judge a row with no usable createdAt rather than declaring it stalled", () => {
    // Fail-closed: a missing/zero timestamp is "unknown", and titling a live sign-in "Trouble
    // signing in" the instant it starts would be worse than leaving the placeholder up.
    expect(signInStalled(PENDING_NICKNAME, 0, ms(T0))).toBe(false);
    expect(signInStalled(PENDING_NICKNAME, Number.NaN, ms(T0))).toBe(false);
  });

  it("honours an explicit stall window", () => {
    expect(signInStalled(PENDING_NICKNAME, T0, ms(T0 + 30), 60)).toBe(false);
    expect(signInStalled(PENDING_NICKNAME, T0, ms(T0 + 61), 60)).toBe(true);
  });
});
