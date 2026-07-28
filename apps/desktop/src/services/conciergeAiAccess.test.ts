// @vitest-environment jsdom
//
// The concierge's AI-enhancements gate, and — the part that is easy to get wrong — WHICH remedy a
// blocked user is offered. There are three different reasons the concierge can be unavailable and
// three different fixes, and showing the wrong one is worse than showing none: an entitled user who
// has simply run their balance to zero must never be told to buy the app they already own.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const setAiFeature = vi.fn();
vi.mock("./configActions", () => ({
  setAiFeature: (...a: unknown[]) => setAiFeature(...a),
}));

import {
  CONCIERGE_AI_FEATURE_KEY,
  CONCIERGE_AI_SETTINGS_FIELD,
  conciergeAiAccessOf,
  conciergeAiFlagOf,
  turnOnConciergeAi,
} from "./conciergeAiAccess";
import { AI_FEATURE_FIELD } from "../stores/settingsStore";
import { useUiStore } from "../stores/uiStore";

/** The registry `stores/settingsStore` owns. Mutated (and restored) so both sides of the
 *  "has the concierge feature key landed yet?" fork are exercised on any base branch. */
const registry = AI_FEATURE_FIELD as unknown as Record<string, string>;
const hadKey = Object.prototype.hasOwnProperty.call(registry, CONCIERGE_AI_FEATURE_KEY);
const originalField: string = registry[CONCIERGE_AI_FEATURE_KEY] ?? CONCIERGE_AI_SETTINGS_FIELD;

function withConciergeKey(present: boolean) {
  if (present) registry[CONCIERGE_AI_FEATURE_KEY] = CONCIERGE_AI_SETTINGS_FIELD;
  else delete registry[CONCIERGE_AI_FEATURE_KEY];
}

beforeEach(() => {
  setAiFeature.mockClear();
  useUiStore.setState({ settingsRequest: null });
});

afterEach(() => {
  if (hadKey) registry[CONCIERGE_AI_FEATURE_KEY] = originalField;
  else delete registry[CONCIERGE_AI_FEATURE_KEY];
});

describe("the gate itself", () => {
  it("is open when the feature is on and the user has credits", () => {
    expect(conciergeAiAccessOf({ featureOn: true, entitled: true, hasCredits: true })).toEqual({
      enabled: true,
      remedy: null,
    });
  });

  it("stays open for a not-yet-entitled user who does have credits — credits are the usable gate", () => {
    // Mirrors services/aiGate: usable = flag && credits. Entitlement governs the paywall, not this.
    expect(conciergeAiAccessOf({ featureOn: true, entitled: false, hasCredits: true })).toEqual({
      enabled: true,
      remedy: null,
    });
  });
});

describe("which remedy a blocked user is offered", () => {
  it("offers the free fix first: the feature flag is off, so turn it on", () => {
    expect(conciergeAiAccessOf({ featureOn: false, entitled: true, hasCredits: true })).toEqual({
      enabled: false,
      remedy: "enable-setting",
    });
  });

  it("prefers turning the setting on even for a user who is also not entitled", () => {
    // Their own switch is the thing they can fix for free and in one click; the purchase state is
    // re-stated on the AI-features pane they land on.
    expect(conciergeAiAccessOf({ featureOn: false, entitled: false, hasCredits: false }).remedy).toBe(
      "enable-setting",
    );
  });

  it("sends a not-yet-entitled user to the $99 paywall", () => {
    expect(conciergeAiAccessOf({ featureOn: true, entitled: false, hasCredits: false })).toEqual({
      enabled: false,
      remedy: "buy-app",
    });
  });

  it("sends an ENTITLED user who is out of credits to top-up — never to the buy-the-app upsell", () => {
    // The bug this pins: selling the $99 app to somebody who already bought it.
    const access = conciergeAiAccessOf({ featureOn: true, entitled: true, hasCredits: false });
    expect(access).toEqual({ enabled: false, remedy: "top-up" });
    expect(access.remedy).not.toBe("buy-app");
  });

  it("names no remedy while the gate is open", () => {
    expect(conciergeAiAccessOf({ featureOn: true, entitled: true, hasCredits: true }).remedy).toBe(
      null,
    );
  });
});

describe("reading the concierge feature flag off a settings snapshot", () => {
  it("reads an explicit value", () => {
    expect(conciergeAiFlagOf({ [CONCIERGE_AI_SETTINGS_FIELD]: false })).toBe(false);
    expect(conciergeAiFlagOf({ [CONCIERGE_AI_SETTINGS_FIELD]: true })).toBe(true);
  });

  it("treats an ABSENT field as on, so a build without the flag never locks its own pane", () => {
    expect(conciergeAiFlagOf({})).toBe(true);
    expect(conciergeAiFlagOf(null)).toBe(true);
  });

  it("treats a non-boolean value as off — a flag we cannot read is not consent to spend", () => {
    expect(conciergeAiFlagOf({ [CONCIERGE_AI_SETTINGS_FIELD]: "yes" })).toBe(false);
  });
});

describe("turning the concierge feature on", () => {
  it("writes the flag through configActions when the feature key is registered", () => {
    withConciergeKey(true);
    turnOnConciergeAi();
    expect(setAiFeature).toHaveBeenCalledWith(CONCIERGE_AI_FEATURE_KEY, true);
    expect(useUiStore.getState().settingsRequest).toBe(null);
  });

  it("falls back to deep-opening the AI-features pane when the key is not registered", () => {
    // Writing an unregistered key would resolve no config path at all — routing the human to the
    // pane that owns the switch is the honest failure.
    withConciergeKey(false);
    turnOnConciergeAi();
    expect(setAiFeature).not.toHaveBeenCalled();
    expect(useUiStore.getState().settingsRequest).toBe("ai");
  });
});
