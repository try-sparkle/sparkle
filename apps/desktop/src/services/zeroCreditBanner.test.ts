// Pure visibility rule for the "$0 balance" banner. Kept out of the component so the gating —
// which has four independent reasons to stay hidden — is testable without React.
import { describe, expect, it } from "vitest";
import { shouldRearmZeroCreditBanner, shouldShowZeroCreditBanner } from "./zeroCreditBanner";
import type { Me } from "./entitlement";

const me = (over: Partial<Me> = {}): Me => ({
  clerkUserId: "u1",
  entitled: true,
  balanceCents: 0,
  tokenVersion: 1,
  ...over,
});

describe("shouldShowZeroCreditBanner", () => {
  it("shows for an entitled user whose balance has run to zero", () => {
    expect(shouldShowZeroCreditBanner(me(), false)).toBe(true);
  });

  it("shows for a NEGATIVE balance too — the ledger may overdraw past zero", () => {
    expect(shouldShowZeroCreditBanner(me({ balanceCents: -25 }), false)).toBe(true);
  });

  it("stays hidden while the user still has credits", () => {
    expect(shouldShowZeroCreditBanner(me({ balanceCents: 1 }), false)).toBe(false);
    expect(shouldShowZeroCreditBanner(me({ balanceCents: 500 }), false)).toBe(false);
  });

  it("stays hidden when signed out / on the anonymous trial (no `me` at all)", () => {
    expect(shouldShowZeroCreditBanner(null, false)).toBe(false);
  });

  it("stays hidden for a signed-in-but-unpaid user — that is the paywall's job, not ours", () => {
    // aiGate's contract: an ENTITLED user at $0 is the credit flow's case; a non-entitled user is
    // sold the $99 app by the paywall/AiLockedNotice. This banner must never double up on that.
    expect(shouldShowZeroCreditBanner(me({ entitled: false }), false)).toBe(false);
  });

  it("stays hidden once dismissed", () => {
    expect(shouldShowZeroCreditBanner(me(), true)).toBe(false);
  });

  it("agrees with hasAiCredits — the banner can never claim features are off while they are on", async () => {
    const { hasAiCredits } = await import("./aiGate");
    for (const cents of [-100, -1, 0, 1, 100]) {
      const user = me({ balanceCents: cents });
      // Floor passed EXPLICITLY: aiGate's default reads useAuthStore.creditFloorCents, so leaving it
      // implicit would make this assertion depend on whatever a neighbouring test left in the store.
      expect(shouldShowZeroCreditBanner(user, false)).toBe(!hasAiCredits(user, 0));
    }
  });

  it("stays SILENT when only the credit FLOOR closed the gate — the balance is not $0", async () => {
    // The one deliberate divergence from the feature gate. aiGate's hasAiCredits also closes at a
    // positive balance the server has refused (authStore.creditFloorCents), so the AI extras can be
    // dark at, say, 3¢. This banner must not fire there: its copy states "Your Sparkle credit balance
    // is $0", and saying that to someone holding 3¢ is a false statement about their money on the
    // one surface that exists to be honest about it. The floor also self-heals within a refresh();
    // a false claim doesn't.
    const { hasAiCredits } = await import("./aiGate");
    const { useAuthStore } = await import("../stores/authStore");
    const user = me({ balanceCents: 3 });
    useAuthStore.setState({ creditFloorCents: 5 });
    try {
      expect(hasAiCredits(user)).toBe(false); // the gate IS closed
      expect(shouldShowZeroCreditBanner(user, false)).toBe(false); // …and we still say nothing
      expect(shouldRearmZeroCreditBanner("u1", user)).toBe(true); // a positive balance re-arms
    } finally {
      useAuthStore.setState({ creditFloorCents: 0 });
    }
  });
});

describe("shouldRearmZeroCreditBanner", () => {
  it("re-arms once credits arrive, so the NEXT zero warns again", () => {
    expect(shouldRearmZeroCreditBanner("u1", me({ balanceCents: 500 }))).toBe(true);
  });

  it("re-arms for a DIFFERENT identity — one user's dismissal must not silence another's", () => {
    expect(shouldRearmZeroCreditBanner("u1", me({ clerkUserId: "u2", balanceCents: 0 }))).toBe(true);
  });

  it("leaves the SAME user's dismissal alone while they are still at zero", () => {
    expect(shouldRearmZeroCreditBanner("u1", me({ balanceCents: 0 }))).toBe(false);
    expect(shouldRearmZeroCreditBanner("u1", me({ balanceCents: -25 }))).toBe(false);
  });

  it("does NOT re-arm on a null `me` — a network blip must not resurrect a dismissed banner", () => {
    // The regression (roborev 48271): `me` going null is indistinguishable here from a transient
    // fetchMe() failure past the grace window. A REAL sign-out clears the flag explicitly in
    // authStore.reset(), so nothing is lost by refusing to infer it from the null.
    expect(shouldRearmZeroCreditBanner("u1", null)).toBe(false);
  });

  it("is a no-op when nobody's dismissal is latched", () => {
    expect(shouldRearmZeroCreditBanner(null, me({ balanceCents: 0 }))).toBe(false);
    expect(shouldRearmZeroCreditBanner(null, null)).toBe(false);
  });

  it("agrees with the SHOW rule: whatever re-arms must be able to make the banner visible again", () => {
    // The two rules share `hasPositiveBalance` on purpose. If a refill re-armed but the show rule still
    // read the user as credited (or vice versa), the dismissal would clear with nothing to show.
    const refilled = me({ balanceCents: 500 });
    expect(shouldRearmZeroCreditBanner("u1", refilled)).toBe(true);
    expect(shouldShowZeroCreditBanner(refilled, false)).toBe(false);
    const spentAgain = me({ balanceCents: 0 });
    expect(shouldShowZeroCreditBanner(spentAgain, false)).toBe(true);
  });
});
