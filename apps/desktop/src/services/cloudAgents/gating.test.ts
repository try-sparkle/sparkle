import { describe, it, expect } from "vitest";
import {
  cloudOptionVisible,
  evaluateCloudGate,
  CLOUD_MIN_START_CENTS,
  type CloudGateInput,
} from "./gating";

// A fully-passing baseline; each test flips exactly one field to isolate that precondition.
const OK: CloudGateInput = {
  featureEnabled: true,
  signedIn: true,
  entitled: true,
  authConfigured: true,
  balanceCents: 10_000,
};

describe("cloudOptionVisible", () => {
  it("shows the option only when the feature is enabled AND signed in", () => {
    expect(cloudOptionVisible({ featureEnabled: true, signedIn: true })).toBe(true);
    expect(cloudOptionVisible({ featureEnabled: false, signedIn: true })).toBe(false);
    expect(cloudOptionVisible({ featureEnabled: true, signedIn: false })).toBe(false);
    expect(cloudOptionVisible({ featureEnabled: false, signedIn: false })).toBe(false);
  });
});

describe("evaluateCloudGate", () => {
  it("allows a fully-configured, funded, paid, signed-in, feature-enabled account (happy path)", () => {
    expect(evaluateCloudGate(OK)).toEqual({ ok: true });
  });

  it("blocks with feature_disabled when the server hasn't advertised the capability", () => {
    const g = evaluateCloudGate({ ...OK, featureEnabled: false });
    expect(g.ok).toBe(false);
    if (!g.ok) {
      expect(g.reason).toBe("feature_disabled");
      // Not self-serviceable — no deep link.
      expect(g.deepLink).toBeUndefined();
    }
  });

  it("blocks with signed_out (and offers sign-in) when there is no token", () => {
    const g = evaluateCloudGate({ ...OK, signedIn: false });
    expect(g.ok).toBe(false);
    if (!g.ok) {
      expect(g.reason).toBe("signed_out");
      expect(g.needsSignIn).toBe(true);
    }
  });

  it("blocks with no_paid_account (deep-links to Credits) when unentitled", () => {
    const g = evaluateCloudGate({ ...OK, entitled: false });
    expect(g.ok).toBe(false);
    if (!g.ok) {
      expect(g.reason).toBe("no_paid_account");
      expect(g.deepLink).toBe("credits");
    }
  });

  it("blocks with no_auth (deep-links to cloudauth) when no Claude auth is saved", () => {
    const g = evaluateCloudGate({ ...OK, authConfigured: false });
    expect(g.ok).toBe(false);
    if (!g.ok) {
      expect(g.reason).toBe("no_auth");
      expect(g.deepLink).toBe("cloudauth");
    }
  });

  it("blocks with insufficient_credits (deep-links to Credits) when the balance is below the floor", () => {
    const g = evaluateCloudGate({ ...OK, balanceCents: CLOUD_MIN_START_CENTS - 1 });
    expect(g.ok).toBe(false);
    if (!g.ok) {
      expect(g.reason).toBe("insufficient_credits");
      expect(g.deepLink).toBe("credits");
    }
  });

  it("treats a balance exactly at the floor as affordable", () => {
    expect(evaluateCloudGate({ ...OK, balanceCents: CLOUD_MIN_START_CENTS })).toEqual({ ok: true });
  });

  it("honors a caller-supplied minimum start cost", () => {
    const g = evaluateCloudGate({ ...OK, balanceCents: 500, minStartCents: 1000 });
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toBe("insufficient_credits");
    expect(evaluateCloudGate({ ...OK, balanceCents: 1000, minStartCents: 1000 })).toEqual({
      ok: true,
    });
  });

  it("surfaces the MOST FUNDAMENTAL block first when several fail at once", () => {
    // Everything wrong → signed_out wins, and that ordering is deliberate: `featureEnabled` comes
    // from `/me`, which a signed-out user does not have, so "not available on your account" would
    // be a false claim about an account nobody looked at — and unactionable, when the real fix is
    // one click. This is the exact shape a signed-out trial user hits.
    const all = evaluateCloudGate({
      featureEnabled: false,
      signedIn: false,
      entitled: false,
      authConfigured: false,
      balanceCents: 0,
    });
    expect(all.ok).toBe(false);
    if (!all.ok) expect(all.reason).toBe("signed_out");

    // Signed in but the account genuinely lacks the capability → feature_disabled next.
    const g2 = evaluateCloudGate({
      featureEnabled: false,
      signedIn: true,
      entitled: false,
      authConfigured: false,
      balanceCents: 0,
    });
    if (!g2.ok) expect(g2.reason).toBe("feature_disabled");

    // Signed in but unpaid + no auth + no credits → no_paid_account next.
    const g3 = evaluateCloudGate({
      featureEnabled: true,
      signedIn: true,
      entitled: false,
      authConfigured: false,
      balanceCents: 0,
    });
    if (!g3.ok) expect(g3.reason).toBe("no_paid_account");

    // Paid but no auth + no credits → no_auth before credits.
    const g4 = evaluateCloudGate({
      featureEnabled: true,
      signedIn: true,
      entitled: true,
      authConfigured: false,
      balanceCents: 0,
    });
    if (!g4.ok) expect(g4.reason).toBe("no_auth");
  });
});

describe("the credit floor is OBVIOUSLY-EMPTY only — the server owns the real rule", () => {
  // The client said 50¢ while `canStartCloudAgent` requires 5 minutes × 0.9¢/min = 5¢, so every
  // balance from 5¢ to 49¢ was refused locally for a start the server would have accepted — and,
  // because CLOUD_MIN_CONTINUE_CENTS derives from this constant, a running agent's auto-continue
  // was abandoned in the same band. A duplicated exact floor is a second copy of a pricing rule
  // that can drift from the one that decides.
  it("allows a balance the SERVER accepts but the old 50¢ floor refused", () => {
    for (const balanceCents of [5, 10, 25, 49]) {
      expect(evaluateCloudGate({ ...OK, balanceCents })).toEqual({ ok: true });
    }
  });

  it("still refuses an empty wallet, which needs no pricing knowledge", () => {
    const g = evaluateCloudGate({ ...OK, balanceCents: 0 });
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toBe("insufficient_credits");
  });
});
