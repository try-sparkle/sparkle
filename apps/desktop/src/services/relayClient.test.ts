import { describe, it, expect, beforeEach } from "vitest";
import { pushSuggestions, lookupSuggestionValue, stopRelayHost, subscriptionFate } from "./relayClient";

// roborev 40821. `onPtyOutput` awaits a real IPC round-trip, and a phone drilling in→out→in can
// complete a whole watch→unwatch→watch cycle inside that window. The original guard asked only
// "is the slot occupied?", which cannot tell OUR placeholder from a NEWER one — so the stale
// attempt stored its listener over the fresh attempt's slot, leaving both listeners live with only
// one tracked. The leaked one then double-emitted every PTY chunk to the phone forever.
describe("relayClient subscription ownership (watch/unwatch/watch race)", () => {
  const base = { socketIsCurrent: true, myGen: 2, currentGen: 2, slotOccupied: true };

  it("adopts when the socket, generation and slot are all still ours", () => {
    expect(subscriptionFate(base)).toBe("adopt");
  });

  it("DISCARDS WITHOUT CLEARING when a newer watch has claimed the slot", () => {
    // The exact leak: our gen is 2, but a later watch bumped it to 3 and installed its own
    // placeholder. The slot IS occupied — by someone else. Clearing it here would strand the
    // listener that attempt is about to install, so the fix must leave the slot alone.
    expect(subscriptionFate({ ...base, currentGen: 3 })).toBe("discard");
  });

  it("clears its own stale claim when the phone unwatched mid-subscribe", () => {
    expect(subscriptionFate({ ...base, slotOccupied: false })).toBe("discard-and-clear");
  });

  it("clears its own claim when the socket was swapped mid-subscribe", () => {
    expect(subscriptionFate({ ...base, socketIsCurrent: false })).toBe("discard-and-clear");
  });

  it("discards after teardown bumped the generation out from under it", () => {
    // stopRelayHost bumps rather than clears, so an in-flight subscribe cannot resolve and
    // re-populate the map that teardown just emptied.
    expect(subscriptionFate({ ...base, currentGen: 3, slotOccupied: false })).toBe("discard");
  });
});

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
