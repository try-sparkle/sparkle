import { describe, it, expect } from "vitest";
import {
  cloudOptionVisible,
  deepLinkActionLabel,
  evaluateCloudGate,
  CLOUD_MIN_START_CENTS,
  type CloudBlockReason,
  type CloudGateInput,
} from "./gating";

// A fully-passing baseline; each test flips exactly one field to isolate that precondition.
const OK: CloudGateInput = {
  signedIn: true,
  authConfigured: true,
  balanceCents: 10_000,
};

describe("cloudOptionVisible", () => {
  // It used to also require a server-advertised capability, which hid every cloud surface from
  // everyone — and a hidden button cannot explain itself. Being visible-but-blocked is the whole
  // point: the gate below then names the one thing to fix.
  it("shows the option to any signed-in user", () => {
    expect(cloudOptionVisible({ signedIn: true })).toBe(true);
    expect(cloudOptionVisible({ signedIn: false })).toBe(false);
  });
});

describe("evaluateCloudGate", () => {
  it("allows a funded, authed, signed-in account (happy path)", () => {
    expect(evaluateCloudGate(OK)).toEqual({ ok: true });
  });

  // THE POLICY CHANGE. A paid account is no longer required — credits are the whole gate — and the
  // capability flag is gone from the client entirely. Neither input exists any more, so this asserts
  // the OUTCOME: an account that would previously have been refused twice over now passes.
  it("allows an account that is merely funded — no paid tier, no advertised capability", () => {
    expect(evaluateCloudGate({ signedIn: true, authConfigured: true, balanceCents: 1 })).toEqual({
      ok: true,
    });
  });

  it("blocks with signed_out (and offers sign-in) when there is no token", () => {
    const g = evaluateCloudGate({ ...OK, signedIn: false });
    expect(g.ok).toBe(false);
    if (!g.ok) {
      expect(g.reason).toBe("signed_out");
      expect(g.needsSignIn).toBe(true);
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
    // Everything wrong → signed_out wins, and that ordering is deliberate: every other input is read
    // from `/me` or a server-side credential, which a signed-out user has neither of. Any other
    // answer would be a claim about an account nobody looked at. This is the shape a signed-out
    // trial user hits.
    const all = evaluateCloudGate({ signedIn: false, authConfigured: false, balanceCents: 0 });
    expect(all.ok).toBe(false);
    if (!all.ok) expect(all.reason).toBe("signed_out");

    // Signed in but no auth + no credits → no_auth before credits: a credential is the thing you
    // cannot buy your way past, so it is the more fundamental of the two.
    const g2 = evaluateCloudGate({ signedIn: true, authConfigured: false, balanceCents: 0 });
    if (!g2.ok) expect(g2.reason).toBe("no_auth");
  });
});

// ── The guarantee this whole change exists to make ────────────────────────────────────────────────
describe("NO reason is a dead end", () => {
  // The founder clicked Cloud and got "Cloud agents aren't available on your account yet" with
  // nothing to click, because one reason shipped with neither a deepLink nor needsSignIn — by
  // design, since the thing it named was not self-serviceable. That reason is gone, and this test is
  // what stops a replacement from arriving unnoticed: it walks EVERY blocking input and demands a
  // way out, then pins the exact reason set so a sixth reason cannot be added without touching it.
  //
  // EXHAUSTIVE OVER THE UNION, not just over the inputs. The walk below can only reach reasons that
  // some entry in BLOCKING_INPUTS happens to produce, so a reason born of a NEW optional input
  // (`regionAllowed?`) would slip past it green. This `Record` makes that a COMPILE error instead.
  const WAY_OUT: Record<CloudBlockReason, "deepLink" | "signIn"> = {
    signed_out: "signIn",
    no_auth: "deepLink",
    insufficient_credits: "deepLink",
  };

  const BLOCKING_INPUTS: ReadonlyArray<{ label: string; input: CloudGateInput }> = [
    { label: "signed out", input: { ...OK, signedIn: false } },
    { label: "no Claude auth", input: { ...OK, authConfigured: false } },
    { label: "empty wallet", input: { ...OK, balanceCents: 0 } },
    {
      label: "everything wrong at once",
      input: { signedIn: false, authConfigured: false, balanceCents: 0 },
    },
    {
      label: "signed in, no auth, no credits",
      input: { signedIn: true, authConfigured: false, balanceCents: 0 },
    },
  ];

  it.each(BLOCKING_INPUTS)("offers a way out when $label", ({ input }) => {
    const g = evaluateCloudGate(input);
    expect(g.ok).toBe(false);
    if (!g.ok) {
      // A block must be actionable: either it deep-links to the Settings section that fixes it, or
      // it hands off to sign-in. Never neither — that is the dead end, and it is what shipped.
      const hasWayOut = g.deepLink !== undefined || g.needsSignIn === true;
      expect(hasWayOut, `"${g.message}" gives the user nothing to do`).toBe(true);
      // And it must be the way out this reason DECLARED above — the Record is the exhaustive half,
      // and this is what keeps the two from drifting into agreeing about nothing.
      expect(g.needsSignIn === true ? "signIn" : "deepLink").toBe(WAY_OUT[g.reason]);
      // A deep link must have a real button label, or the fix is unreachable in practice.
      if (g.deepLink) expect(deepLinkActionLabel(g.deepLink)).not.toBeNull();
    }
  });

  it("produces EXACTLY the reasons declared above — a new one must come here to be blessed", () => {
    const seen = new Set<CloudBlockReason>();
    for (const { input } of BLOCKING_INPUTS) {
      const g = evaluateCloudGate(input);
      if (!g.ok) seen.add(g.reason);
    }
    // Both directions: no reason is emitted that WAY_OUT never blessed, and none is blessed that no
    // input can actually reach — so adding a union member forces both a way out and an input here.
    expect([...seen].sort()).toEqual(Object.keys(WAY_OUT).sort());
  });
});

describe("deepLinkActionLabel", () => {
  it("names both destinations the gate can emit", () => {
    expect(deepLinkActionLabel("cloudauth")).toBe("Add Claude auth");
    expect(deepLinkActionLabel("credits")).toBe("Open credits");
  });

  // Null, not a guess: a button labelled "Open credits" that opens the notifications pane is worse
  // than no button, and the three call sites that used to inline this ternary did exactly that for
  // any destination other than cloudauth.
  it("returns null for a destination it has no copy for, rather than defaulting", () => {
    expect(deepLinkActionLabel("notifications")).toBeNull();
    expect(deepLinkActionLabel("appearance")).toBeNull();
  });
});

describe("the credit floor is OBVIOUSLY-EMPTY only — the server owns the real rule", () => {
  // The client said 50¢ while `canStartCloudAgent` requires 5 minutes × 0.9¢/min = 5¢, so every
  // balance from 5¢ to 49¢ was refused locally for a start the server would have accepted — and,
  // while CLOUD_MIN_CONTINUE_CENTS was ALIASED to this constant, a running agent's auto-continue
  // was abandoned in the same band. That alias no longer exists (engine/goalContinuation holds its
  // own literal), so this constant's blast radius is the START path only. A duplicated exact floor
  // is a second copy of a pricing rule that can drift from the one that decides.
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

// THE AMOUNT, WHEN THE SERVER STATED ONE. Feeding this gate the server's floor also SUPPRESSES the
// cost line that used to name it — the create dialog renders this block instead of the form — so a
// generic sentence here would drop the one number the user needs to act on. With no server floor
// there is no honest amount to quote (the 1¢ fallback is "obviously empty", not a price).
describe("the insufficient-credits sentence", () => {
  const blocked = (over: { balanceCents: number; minStartCents?: number }) =>
    evaluateCloudGate({ signedIn: true, authConfigured: true, ...over });

  it("names the server's floor when it was supplied", () => {
    const gate = blocked({ balanceCents: 50, minStartCents: 100 });
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.message).toBe(
      "You need $1.00 in credits to start a cloud agent. Add credits to continue.",
    );
    expect(gate.deepLink).toBe("credits");
  });

  it("follows the SERVER's number rather than one of its own", () => {
    const gate = blocked({ balanceCents: 300, minStartCents: 500 });
    if (gate.ok) return;
    expect(gate.message).toContain("$5.00");
  });

  it("stays generic when the server stated no floor — an amount we never received is not quotable", () => {
    const gate = blocked({ balanceCents: 0 });
    if (gate.ok) return;
    expect(gate.message).toBe(
      "You don't have enough credits to start a cloud agent. Add credits to continue.",
    );
  });
});
