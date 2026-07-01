// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { aiEnhancementsEnabled, hasAiCredits, aiFeatureNow } from "./aiGate";
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
  useAuthStore.setState({ me: null, tokenPresent: false, loading: false });
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

describe("aiFeatureNow — credits × per-feature flag", () => {
  it("credits + flag on -> true", () => {
    account({ balanceCents: 500 });
    useSettingsStore.getState().setAllAiFeatures(true);
    expect(aiFeatureNow("brainstorm")).toBe(true);
  });
  it("credits + flag off -> false (feature toggled off in preferences)", () => {
    account({ balanceCents: 500 });
    useSettingsStore.getState().setAiFeature("brainstorm", false);
    expect(aiFeatureNow("brainstorm")).toBe(false);
  });
  it("out of credits + flag on -> false (even when entitled)", () => {
    account({ balanceCents: 0, entitled: true });
    useSettingsStore.getState().setAllAiFeatures(true);
    expect(aiFeatureNow("brainstorm")).toBe(false);
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
    expect(aiFeatureNow("brainstorm")).toBe(true);
    expect(aiFeatureNow("composer")).toBe(true);
    expect(aiFeatureNow("autoRename")).toBe(true);
  });
});
