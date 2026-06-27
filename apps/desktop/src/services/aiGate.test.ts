// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { aiEnhancementsEnabled, aiFeatureNow } from "./aiGate";
import { useAuthStore } from "../stores/authStore";
import { useSettingsStore } from "../stores/settingsStore";

const entitled = (on: boolean) =>
  useAuthStore.setState({
    me: { clerkUserId: "u", entitled: on, balanceCents: 0, tokenVersion: 1 },
    tokenPresent: true,
    loading: false,
  });

afterEach(() => {
  useAuthStore.setState({ me: null, tokenPresent: false, loading: false });
  useSettingsStore.getState().setAllAiFeatures(true);
});

describe("aiEnhancementsEnabled", () => {
  it("false when not entitled / no me", () => {
    expect(aiEnhancementsEnabled(null)).toBe(false);
    expect(aiEnhancementsEnabled({ clerkUserId: "u", entitled: false, balanceCents: 0, tokenVersion: 1 })).toBe(false);
  });
  it("true only when entitled", () => {
    expect(aiEnhancementsEnabled({ clerkUserId: "u", entitled: true, balanceCents: 0, tokenVersion: 1 })).toBe(true);
  });
});

describe("aiFeatureNow — entitlement × flag", () => {
  it("entitled + flag on -> true", () => {
    entitled(true);
    useSettingsStore.getState().setAllAiFeatures(true);
    expect(aiFeatureNow("brainstorm")).toBe(true);
  });
  it("entitled + flag off -> false", () => {
    entitled(true);
    useSettingsStore.getState().setAiFeature("brainstorm", false);
    expect(aiFeatureNow("brainstorm")).toBe(false);
  });
  it("not entitled + flag on -> false", () => {
    entitled(false);
    useSettingsStore.getState().setAllAiFeatures(true);
    expect(aiFeatureNow("brainstorm")).toBe(false);
  });
  it("denies the billable cloud-dictation guard for a non-entitled trial user", () => {
    // The metered Deepgram guard is `aiFeatureNow("composer") && aiFeatureNow("voiceDictation")`.
    // A free-trial user (entitlement off) with both flags ON must NOT pass it — else they'd be
    // billed. Guards against a FIELD-mapping / entitlement-AND regression re-billing trial users.
    entitled(false);
    useSettingsStore.getState().setAllAiFeatures(true);
    expect(aiFeatureNow("composer")).toBe(false);
    expect(aiFeatureNow("voiceDictation")).toBe(false);
    expect(aiFeatureNow("composer") && aiFeatureNow("voiceDictation")).toBe(false);
  });

  it("opens the cloud-dictation guard for an entitled user with both flags on", () => {
    // Inverse of the trial case: a paying user must PASS the metered-stream conjunction —
    // guards against an inverted entitlement check wrongly denying paying customers.
    entitled(true);
    useSettingsStore.getState().setAllAiFeatures(true);
    expect(aiFeatureNow("composer") && aiFeatureNow("voiceDictation")).toBe(true);
  });

  it("maps each key to its own settings field", () => {
    entitled(true);
    useSettingsStore.getState().setAllAiFeatures(true);
    // voiceDictation -> cloudDictation: turning that one off must not affect the others.
    useSettingsStore.getState().setCloudDictation(false);
    expect(aiFeatureNow("voiceDictation")).toBe(false);
    expect(aiFeatureNow("brainstorm")).toBe(true);
    expect(aiFeatureNow("composer")).toBe(true);
    expect(aiFeatureNow("autoRename")).toBe(true);
  });
});
