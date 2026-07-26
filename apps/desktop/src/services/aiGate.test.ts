// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  aiEnhancementsEnabled,
  hasAiCredits,
  useHasAiCredits,
  aiFeatureNow,
  assertAiCredits,
} from "./aiGate";
import { OutOfCreditsError } from "./credits";
import { useAuthStore } from "../stores/authStore";
import { useSettingsStore } from "../stores/settingsStore";

/** Sign in a user with an explicit credit balance (and optionally entitlement). AI features gate on
 *  credits, so balanceCents is what matters for aiFeatureNow; entitled defaults on (past paywall). */
const account = (opts: { balanceCents: number; entitled?: boolean }) =>
  useAuthStore.setState({
    me: {
      clerkUserId: "u",
      entitled: opts.entitled ?? true,
      balanceCents: opts.balanceCents,
      tokenVersion: 1,
    },
    tokenPresent: true,
    loading: false,
  });

afterEach(() => {
  useAuthStore.setState({ me: null, tokenPresent: false, loading: false, creditFloorCents: 0 });
  useSettingsStore.getState().setAllAiFeatures(true);
});

describe("aiEnhancementsEnabled — entitlement (paywall + trial meter, NOT the feature gate)", () => {
  it("false when not entitled / no me", () => {
    expect(aiEnhancementsEnabled(null)).toBe(false);
    expect(aiEnhancementsEnabled({ clerkUserId: "u", entitled: false, balanceCents: 500, tokenVersion: 1 })).toBe(false);
  });
  it("true only when entitled (independent of balance)", () => {
    expect(aiEnhancementsEnabled({ clerkUserId: "u", entitled: true, balanceCents: 0, tokenVersion: 1 })).toBe(true);
  });
});

describe("hasAiCredits — the AI-feature unlock signal", () => {
  it("false with no me or a zero/negative balance", () => {
    expect(hasAiCredits(null)).toBe(false);
    expect(hasAiCredits({ clerkUserId: "u", entitled: true, balanceCents: 0, tokenVersion: 1 })).toBe(false);
    expect(hasAiCredits({ clerkUserId: "u", entitled: true, balanceCents: -1, tokenVersion: 1 })).toBe(false);
  });
  it("true with a positive balance — even if not entitled", () => {
    expect(hasAiCredits({ clerkUserId: "u", entitled: false, balanceCents: 1, tokenVersion: 1 })).toBe(true);
  });
});

describe("hasAiCredits — the credit floor (a balance the SERVER already refused)", () => {
  const me = (balanceCents: number) => ({
    clerkUserId: "u",
    entitled: true,
    balanceCents,
    tokenVersion: 1,
  });

  // The regression this exists for: the server reserves an ESTIMATE before running a call, so it
  // 402s at any balance under that estimate. A leftover cent passed the old `balance > 0` gate, so
  // every AI surface kept re-issuing a request that could only ever 402 — thousands per day.
  it("closes at a balance the server refused, even though it is positive", () => {
    expect(hasAiCredits(me(1), 0)).toBe(true); // no refusal recorded yet
    expect(hasAiCredits(me(1), 1)).toBe(false); // refused at 1c → 1c is not spendable
  });

  it("reopens once a top-up lifts the balance above the refused level", () => {
    expect(hasAiCredits(me(500), 1)).toBe(true);
  });

  it("still refuses a zero balance when no refusal has been recorded", () => {
    expect(hasAiCredits(me(0), 0)).toBe(false);
  });

  it("ignores a negative floor rather than treating it as permission to spend nothing", () => {
    expect(hasAiCredits(me(0), -100)).toBe(false);
  });

  it("defaults the floor from the auth store, so existing call sites gate on it", () => {
    account({ balanceCents: 1 });
    expect(hasAiCredits(useAuthStore.getState().me)).toBe(true);
    useAuthStore.getState().noteCreditsRefused(1);
    expect(hasAiCredits(useAuthStore.getState().me)).toBe(false);
    expect(aiFeatureNow("suggestedActions")).toBe(false);
  });

  // The known imprecision: the 402 reports the balance, not the unaffordable hold, so a pricey call
  // refused at a healthy balance closes the gate for the cheap calls that balance still covers.
  // Pinned here so the trade-off is visible, and bounded by refresh() clearing the floor
  // (authStore.test.ts) — not by anything in this function.
  it("an expensive refusal at a healthy balance DOES close the gate (bounded by refresh, not here)", () => {
    account({ balanceCents: 300 });
    useAuthStore.getState().noteCreditsRefused(300);
    expect(hasAiCredits(useAuthStore.getState().me)).toBe(false);
  });

  it("useHasAiCredits re-renders when ONLY the floor changes", () => {
    account({ balanceCents: 1 });
    const { result } = renderHook(() => useHasAiCredits());
    expect(result.current).toBe(true);
    // The balance is untouched — without the hook subscribing to the floor, this would not re-render
    // and every AI surface would keep firing until some unrelated auth change happened to land.
    act(() => useAuthStore.getState().noteCreditsRefused(1));
    expect(result.current).toBe(false);
  });
});

describe("assertAiCredits — the hard local gate", () => {
  it("throws OutOfCreditsError carrying the live balance at zero credits", () => {
    account({ balanceCents: 0, entitled: true });
    expect(() => assertAiCredits()).toThrow(OutOfCreditsError);
    const err = (() => {
      try {
        assertAiCredits();
      } catch (e) {
        return e as OutOfCreditsError;
      }
    })();
    expect(err).toBeInstanceOf(OutOfCreditsError);
    expect(err?.balanceCents).toBe(0);
  });

  // The thrown figure is asserted, not just the type: the `OutOfCreditsError.balanceCents` doc
  // names "0 for a null `me`" as one of two reasons not to render that field, and an unpinned
  // fallback would let a refactor make that doc quietly wrong. The other named hazard (the
  // fabricated 0) is pinned in anthropic.test.ts; this is its counterpart.
  it("throws when signed out (no me), reporting 0 — which is NOT a ledger balance", () => {
    useAuthStore.setState({ me: null, tokenPresent: false, loading: false });
    const err = (() => {
      try {
        assertAiCredits();
      } catch (e) {
        return e as OutOfCreditsError;
      }
    })();
    expect(err).toBeInstanceOf(OutOfCreditsError);
    expect(err?.balanceCents).toBe(0);
  });

  it("does NOT throw when the user has a positive balance", () => {
    account({ balanceCents: 500 });
    expect(() => assertAiCredits()).not.toThrow();
  });
});

describe("aiFeatureNow — credits × per-feature flag", () => {
  it("credits + flag on -> true", () => {
    account({ balanceCents: 500 });
    useSettingsStore.getState().setAllAiFeatures(true);
    expect(aiFeatureNow("autoRename")).toBe(true);
  });
  it("credits + flag off -> false (feature toggled off in preferences)", () => {
    account({ balanceCents: 500 });
    useSettingsStore.getState().setAiFeature("autoRename", false);
    expect(aiFeatureNow("autoRename")).toBe(false);
  });
  it("out of credits + flag on -> false (even when entitled)", () => {
    account({ balanceCents: 0, entitled: true });
    useSettingsStore.getState().setAllAiFeatures(true);
    expect(aiFeatureNow("autoRename")).toBe(false);
    expect(aiFeatureNow("suggestedActions")).toBe(false);
  });
  it("credits unlock the feature even for a non-entitled account", () => {
    // The founder's rule: credits — not the one-time entitlement — decide whether AI features run.
    account({ balanceCents: 500, entitled: false });
    useSettingsStore.getState().setAllAiFeatures(true);
    expect(aiFeatureNow("suggestedActions")).toBe(true);
  });

  it("denies the billable cloud-dictation guard for a user with no credits", () => {
    // The metered Deepgram guard is `aiFeatureNow("composer") && aiFeatureNow("voiceDictation")`.
    // A user with zero credits (or a free-trial user, me === null) must NOT pass it — else they'd be
    // billed with no balance to draw down. Guards against a FIELD-mapping / credits-AND regression.
    account({ balanceCents: 0 });
    useSettingsStore.getState().setAllAiFeatures(true);
    expect(aiFeatureNow("composer")).toBe(false);
    expect(aiFeatureNow("voiceDictation")).toBe(false);
    expect(aiFeatureNow("composer") && aiFeatureNow("voiceDictation")).toBe(false);
  });

  it("opens the cloud-dictation guard for a funded user with both flags on", () => {
    // Inverse of the no-credits case: a user with a positive balance must PASS the metered-stream
    // conjunction — guards against an inverted credits check wrongly denying paying customers.
    account({ balanceCents: 500 });
    useSettingsStore.getState().setAllAiFeatures(true);
    expect(aiFeatureNow("composer") && aiFeatureNow("voiceDictation")).toBe(true);
  });

  it("maps each key to its own settings field", () => {
    account({ balanceCents: 500 });
    useSettingsStore.getState().setAllAiFeatures(true);
    // voiceDictation -> cloudDictation: turning that one off must not affect the others.
    useSettingsStore.getState().setCloudDictation(false);
    expect(aiFeatureNow("voiceDictation")).toBe(false);
    expect(aiFeatureNow("composer")).toBe(true);
    expect(aiFeatureNow("autoRename")).toBe(true);
  });
});
