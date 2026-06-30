import { describe, it, expect, beforeEach } from "vitest";
import { pushSuggestions, lookupSuggestionValue, stopRelayHost } from "./relayClient";

// These exercise the host-side id→value map lifecycle that gates phone suggestion clicks. The
// socket is never connected here (startRelayHost not called), so pushSuggestions only populates the
// map and emits nothing — exactly the lookup path authorizeSuggestionClick depends on.
describe("relayClient suggestion map", () => {
  // Reset the module-level map before each case so ordering/id reuse can't leak state.
  beforeEach(() => stopRelayHost());

  it("pushSuggestions populates the id→value map for a watched click-back", () => {
    pushSuggestions({ agent_id: "a1", buttons: [{ id: "btn1", label: "Approve", value: "y\n" }] });
    expect(lookupSuggestionValue("a1", "btn1")).toBe("y\n");
  });

  it("an empty set retires the agent's buttons (map entry dropped)", () => {
    pushSuggestions({ agent_id: "a2", buttons: [{ id: "x", label: "Cut DMG", value: "Cut a DMG." }] });
    expect(lookupSuggestionValue("a2", "x")).toBe("Cut a DMG.");
    pushSuggestions({ agent_id: "a2", buttons: [] });
    expect(lookupSuggestionValue("a2", "x")).toBeNull();
  });

  it("unknown agent/button resolves to null", () => {
    expect(lookupSuggestionValue("nope", "nope")).toBeNull();
  });

  it("stopRelayHost clears the whole map", () => {
    pushSuggestions({ agent_id: "a3", buttons: [{ id: "y", label: "Push", value: "Push." }] });
    stopRelayHost();
    expect(lookupSuggestionValue("a3", "y")).toBeNull();
  });
});
