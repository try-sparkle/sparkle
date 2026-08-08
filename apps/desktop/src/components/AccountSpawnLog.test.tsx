// @vitest-environment jsdom
//
// The panel's job is to stop a CORRECT log from being read as a broken feature.
//
// A list of spawns that all name one account looks the same whether rotation is failing or whether
// there was never a second account to rotate to. These tests assert the rendered OUTPUT that tells
// those apart — not that the data was passed in, which would be true before the component existed.
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AccountSpawnLog } from "./AccountSpawnLog";
import type { SpawnLogEntry } from "../services/accountLedger";

function entry(over: Partial<SpawnLogEntry> = {}): SpawnLogEntry {
  return {
    at: Date.parse("2026-08-07T18:00:00Z"),
    key: "agent-abcdef123456",
    accountId: "personal",
    nickname: "DROdio Personal",
    configDir: "/home/.claude",
    email: "a@example.com",
    reason: "auto",
    tokens5h: 100,
    ceiling: 1000,
    fraction: 0.1,
    eligibleCount: 2,
    signedInCount: 2,
    candidateIds: ["personal", "second"],
    ...over,
  };
}

afterEach(cleanup);

describe("AccountSpawnLog", () => {
  it("names the account each spawn used by its AUTHENTICATED email, not the typed nickname", async () => {
    const read = vi.fn().mockResolvedValue([entry({ email: "real@example.com", nickname: "Misnamed" })]);
    render(<AccountSpawnLog read={read} />);

    expect(await screen.findByText("real@example.com")).toBeTruthy();
    // The nickname is user-typed and has no bearing on which login a config dir holds — on the real
    // machine one account is literally named for the wrong address.
    expect(screen.queryByText("Misnamed")).toBeNull();
  });

  it("says WHY rotation looked inert when there was only one signed-in account", async () => {
    const read = vi.fn().mockResolvedValue([entry({ signedInCount: 1, candidateIds: ["personal"] })]);
    render(<AccountSpawnLog read={read} />);

    // The whole point: a reader must not conclude "rotation is broken" from a unanimous log.
    expect(await screen.findByText(/only one account is signed in/i)).toBeTruthy();
  });

  it("stays SILENT when the pool was never measured, rather than inventing a one-account claim", async () => {
    // `signedInCount` is null when the accounts backend could not be read. JS coerces `null <= 1`
    // to true, so the obvious comparison announces a one-account pool on the strength of a reading
    // nobody took — in the panel whose entire job is telling a correct log from a broken feature.
    const read = vi.fn().mockResolvedValue([
      entry({ signedInCount: null, reason: "remembered", candidateIds: null, tokens5h: null, eligibleCount: null }),
    ]);
    render(<AccountSpawnLog read={read} />);

    await waitFor(() => expect(screen.getByText("a@example.com")).toBeTruthy());
    expect(screen.queryByText(/only one account is signed in/i)).toBeNull();
    expect(screen.queryByText(/no account is signed in/i)).toBeNull();
  });

  it("gives ZERO signed-in accounts its own sentence, not the one-account one", async () => {
    // 0 is a real reading but a different situation: "it is the only one signed in" names an
    // account that does not exist, and "sign in another" presumes there is already one.
    const read = vi.fn().mockResolvedValue([
      entry({ signedInCount: 0, reason: "none", accountId: null, email: null, nickname: null, candidateIds: [] }),
    ]);
    render(<AccountSpawnLog read={read} />);

    expect(await screen.findByText(/no account is signed in/i)).toBeTruthy();
    expect(screen.getByText(/did not get an account from/i)).toBeTruthy();
    // The panel cannot observe the registry, and the one place it renders is gated on there being
    // at least one account — so it must never claim none is registered.
    expect(screen.queryByText(/none is registered/i)).toBeNull();
    expect(screen.queryByText(/only one account is signed in/i)).toBeNull();
  });

  it("does NOT cry wolf once a second account is signed in", async () => {
    const read = vi.fn().mockResolvedValue([entry({ signedInCount: 2 })]);
    render(<AccountSpawnLog read={read} />);

    await waitFor(() => expect(screen.getByText("a@example.com")).toBeTruthy());
    // Paired with the test above on one fixture differing only in signedInCount — so the warning is
    // caused by that count and not by something upstream that happens to be true in both.
    expect(screen.queryByText(/only one account is signed in/i)).toBeNull();
  });

  it("renders an unlearned ceiling as unknown, never as 0% of its limit", async () => {
    const read = vi.fn().mockResolvedValue([entry({ ceiling: null, fraction: null })]);
    render(<AccountSpawnLog read={read} />);

    expect(await screen.findByText(/limit not learned yet/i)).toBeTruthy();
    // Coercing null to zero would make an unmeasured account look like the emptiest in the pool.
    expect(screen.queryByText(/0% of its limit/)).toBeNull();
  });

  it("shows how close the chosen account was to its limit", async () => {
    const read = vi.fn().mockResolvedValue([entry({ ceiling: 1000, fraction: 0.87 })]);
    render(<AccountSpawnLog read={read} />);
    expect(await screen.findByText("87% of its limit")).toBeTruthy();
  });

  it("distinguishes the least-bad fallback from an ordinary pick", async () => {
    const read = vi.fn().mockResolvedValue([entry({ reason: "fallback", candidateIds: [], eligibleCount: 0 })]);
    render(<AccountSpawnLog read={read} />);
    expect(await screen.findByText(/every account was near its limit/i)).toBeTruthy();
  });

  it("names the app-owned keys in the user's terms rather than as raw ids", async () => {
    const read = vi.fn().mockResolvedValue([
      entry({ key: "sparkle:concierge", at: Date.parse("2026-08-07T18:00:00Z") }),
      entry({ key: "__sparkle_self__", at: Date.parse("2026-08-07T17:00:00Z") }),
    ]);
    render(<AccountSpawnLog read={read} />);

    expect(await screen.findByText("Concierge")).toBeTruthy();
    expect(screen.getByText("Improve Sparkle")).toBeTruthy();
    expect(screen.queryByText("sparkle:concierge")).toBeNull();
  });

  it("ignores a slow response that lands after a newer one", async () => {
    // Clicking Refresh while a read is outstanding leaves two in flight. Without a generation
    // guard the SLOWER one wins by landing last, so the panel silently shows an OLDER snapshot
    // than one it already received — the worst available failure in a surface whose whole value is
    // being trusted as evidence.
    let releaseFirst: (v: SpawnLogEntry[]) => void = () => {};
    const first = new Promise<SpawnLogEntry[]>((r) => {
      releaseFirst = r;
    });
    const read = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce([entry({ email: "newer@example.com" })]);

    render(<AccountSpawnLog read={read} />);
    // The mount read is still hanging; fire a second one that resolves immediately.
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    expect(await screen.findByText("newer@example.com")).toBeTruthy();

    // Now let the FIRST read finish. It is superseded and must not overwrite what is on screen.
    releaseFirst([entry({ email: "stale@example.com" })]);
    await waitFor(() => expect(screen.getByText("newer@example.com")).toBeTruthy());
    expect(screen.queryByText("stale@example.com")).toBeNull();
  });

  it("reconciles a one-account-signed-in banner with rows that visibly show a rotation", async () => {
    // The newest row is a DIFFERENT account from the two below it — i.e. a rotation happened, and
    // then an account was signed out. This is the case a reader most needs a sentence for: without
    // one the panel says "only one account is signed in" over a list plainly showing two.
    const read = vi.fn().mockResolvedValue([
      entry({ signedInCount: 1, accountId: "b", email: "b@example.com" }),
      entry({ signedInCount: 1, accountId: "a", email: "a@example.com" }),
      entry({ signedInCount: 1, accountId: "a", email: "a@example.com" }),
    ]);
    render(<AccountSpawnLog read={read} />);

    expect(await screen.findByText(/only one account is signed in/i)).toBeTruthy();
    expect(screen.getByText(/entries below used 2 different accounts/i)).toBeTruthy();
  });

  it("stays quiet about multiple accounts when every row used the same one", async () => {
    // The paired negative: same shape, same one-signed-in banner, but the rows genuinely show one
    // account — so the reconciling sentence must NOT appear. Without this pair the clause could
    // render unconditionally and the positive test above would still pass.
    const read = vi.fn().mockResolvedValue([
      entry({ signedInCount: 1, accountId: "a", email: "a@example.com" }),
      entry({ signedInCount: 1, accountId: "a", email: "a@example.com" }),
    ]);
    render(<AccountSpawnLog read={read} />);

    expect(await screen.findByText(/only one account is signed in/i)).toBeTruthy();
    expect(screen.queryByText(/different accounts/i)).toBeNull();
  });

  it("does not claim Sparkle chose nothing when zero are signed in but an account WAS chosen", async () => {
    // `partitionAccounts` keeps the full account list when the signed-in filter would empty it, so
    // pickAccount still returns a real account and its config dir is still exported. Saying
    // "Sparkle is not choosing an account at all" would contradict the row directly below.
    const read = vi.fn().mockResolvedValue([
      entry({ signedInCount: 0, accountId: "personal", nickname: "DROdio Personal", email: null }),
    ]);
    render(<AccountSpawnLog read={read} />);

    expect(await screen.findByText(/no account is signed in/i)).toBeTruthy();
    expect(screen.getByText(/still being routed to/i)).toBeTruthy();
    expect(screen.queryByText(/did not get an account from/i)).toBeNull();
  });

  it("does not present an empty ledger as proof that rotation never happened", async () => {
    const read = vi.fn().mockResolvedValue([]);
    render(<AccountSpawnLog read={read} />);

    // An unreadable ledger and an empty one arrive identically (readSpawnLog never rejects), so the
    // copy has to be about the LOG, not about rotation.
    const msg = await screen.findByText(/nothing recorded yet/i);
    expect(msg.textContent).toMatch(/does not backfill/i);
    expect(screen.queryByText(/only one account is signed in/i)).toBeNull();
  });
});
