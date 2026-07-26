import { describe, it, expect } from "vitest";
import { pendingExhaustions, siblingMap } from "./limitSync";
import { SESSION_WINDOW_MS, type LimitEvent } from "./rateLimitWatch";
import type { Usage } from "./accountStore";

const AT = Date.parse("2026-07-26T15:55:24.145Z"); // 10:55:24 in Bogota
const NOW = AT + 1000;

/** The real event that stalled an agent: reset 2:20pm Bogota, ~3h25m after the event. */
const REAL: LimitEvent = {
  accountId: "gmail",
  at: AT,
  text: "You've hit your session limit · resets 2:20pm (America/Bogota)",
};

function usage(id: string, exhaustedUntil: number | null): Usage {
  return { id, tokens5h: 0, tokens7d: 0, exhaustedUntil };
}

describe("pendingExhaustions", () => {
  it("benches an account until the REAL reset instant, not a fixed backoff", () => {
    const [p] = pendingExhaustions([REAL], [], NOW);
    expect(p?.accountId).toBe("gmail");
    // ~3h25m out. The old code produced a blind 4h, sidelining the account ~35min too long.
    const outMs = (p?.until ?? 0) - AT;
    expect(outMs).toBeGreaterThan(3 * 3600_000);
    expect(outMs).toBeLessThan(3.5 * 3600_000);
    expect(p?.until).not.toBe(AT + 4 * 3600_000);
  });

  it("is idempotent — re-seeing the same event does not rewrite the flag", () => {
    const [first] = pendingExhaustions([REAL], [], NOW);
    expect(first).toBeDefined();
    // The event stays in the transcript for the whole lookback window, so the next poll sees it
    // again; with the flag already recorded there is nothing left to do.
    const second = pendingExhaustions([REAL], [usage("gmail", first!.until)], NOW);
    expect(second).toEqual([]);
  });

  it("extends the bench when a NEW limit resets later than the current flag", () => {
    const later: LimitEvent = { ...REAL, text: "You've hit your session limit · resets 8pm (America/Bogota)" };
    const existing = usage("gmail", AT + 60_000);
    const [p] = pendingExhaustions([later], [existing], NOW);
    expect(p).toBeDefined();
    expect(p!.until).toBeGreaterThan(existing.exhaustedUntil!);
  });

  it("ignores an event whose reset has already passed", () => {
    // Poll long after the reset — the account is healthy again and must not be re-benched.
    const wayLater = AT + 12 * 3600_000;
    expect(pendingExhaustions([REAL], [], wayLater)).toEqual([]);
  });

  it("only ever benches the account the event came from", () => {
    const pending = pendingExhaustions([REAL], [usage("storytell", null), usage("gmail", null)], NOW);
    expect(pending.map((p) => p.accountId)).toEqual(["gmail"]);
  });

  it("handles several accounts limited at once", () => {
    const other: LimitEvent = {
      accountId: "storytell",
      at: AT,
      text: "You've hit your session limit · resets 9pm (America/Los_Angeles)",
    };
    const pending = pendingExhaustions([REAL, other], [], NOW);
    expect(pending.map((p) => p.accountId).sort()).toEqual(["gmail", "storytell"]);
  });

  it("falls back to the 5h session window when the reset time is unparseable", () => {
    const vague: LimitEvent = { accountId: "gmail", at: AT, text: "You've hit your session limit" };
    const [p] = pendingExhaustions([vague], [], NOW);
    expect(p!.until).toBe(AT + SESSION_WINDOW_MS);
  });

  it("returns nothing when no account is limited", () => {
    expect(pendingExhaustions([], [usage("gmail", null)], NOW)).toEqual([]);
  });
});

describe("a limit benches EVERY registration of the same login", () => {
  // The scenario this branch exists for: two config dirs holding one Claude account (identical
  // accountUuid). The rate limit belongs to the LOGIN, but the event only lands in the transcripts
  // of whichever dir happened to be running. Benching that one alone leaves its twin looking
  // healthy — it wins auto-pick and re-hits the identical limit instantly, which is precisely the
  // "I log in again and it's immediately limited" loop.
  const UUID = "5fb3d67c-f4ed-417b-9bf2-f9156450eb73";
  const accounts = [
    { id: "storytell", nickname: "DROdio Storytell", configDir: "/a", isDefault: true, createdAt: 0 },
    { id: "gmail", nickname: "DROdio Gmail", configDir: "/b", isDefault: false, createdAt: 0 },
  ];
  const sameLogin = [
    { id: "storytell", email: "drodio@gmail.com", organization: null, accountUuid: UUID },
    { id: "gmail", email: "drodio@gmail.com", organization: null, accountUuid: UUID },
  ];

  it("fans the exhaustion across the duplicate group", () => {
    const siblings = siblingMap(accounts, sameLogin);
    const pending = pendingExhaustions([REAL], [], NOW, siblings);
    expect(pending.map((p) => p.accountId).sort()).toEqual(["gmail", "storytell"]);
    // Both benched to the SAME real reset instant.
    expect(new Set(pending.map((p) => p.until)).size).toBe(1);
  });

  it("does not fan out to genuinely different logins", () => {
    const distinct = [
      { id: "storytell", email: "drodio@storytell.ai", organization: null, accountUuid: "uuid-1" },
      { id: "gmail", email: "drodio@gmail.com", organization: null, accountUuid: "uuid-2" },
    ];
    const pending = pendingExhaustions([REAL], [], NOW, siblingMap(accounts, distinct));
    expect(pending.map((p) => p.accountId)).toEqual(["gmail"]);
  });

  it("skips a sibling that is already benched at least that long", () => {
    const siblings = siblingMap(accounts, sameLogin);
    const until = pendingExhaustions([REAL], [], NOW, siblings)[0]!.until;
    const pending = pendingExhaustions(
      [REAL],
      [{ id: "storytell", tokens5h: 0, tokens7d: 0, exhaustedUntil: until }],
      NOW,
      siblings,
    );
    expect(pending.map((p) => p.accountId)).toEqual(["gmail"]);
  });

  it("siblingMap is empty when there are no duplicates", () => {
    expect(siblingMap(accounts, [])).toEqual({});
  });
});
