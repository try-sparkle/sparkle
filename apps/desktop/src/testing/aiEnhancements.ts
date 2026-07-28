// Test-only precondition: put the auth store in the state where AI enhancements actually RUN.
//
// The concierge column locks its paid half — the chat with the `claude -p` brain and the composer —
// whenever the AI gate is shut (Concierge/conciergeAiLock). The gate's default in a fresh test is
// `me: null`, i.e. the anonymous trial: nothing bought, no credits, so LOCKED. That is the correct
// production behavior, and it means any suite whose subject is the concierge CONVERSATION has to
// state its precondition rather than inherit it.
//
// This exists so that precondition is one honest line in each such suite instead of a hand-rolled
// `me` literal per file — and so it is NOT installed globally in test-setup, which would silently
// entitle every suite in the repo and hide a real gate regression.
import { useAuthStore } from "../stores/authStore";

/** Bought the app, and holding a balance comfortably above any credit floor. */
export function enableAiEnhancementsForTests(): void {
  useAuthStore.setState({
    me: { clerkUserId: "test-user", entitled: true, balanceCents: 5_000, tokenVersion: 1 },
    // A floor is a balance the server has REFUSED at; a fresh, funded account has none.
    creditFloorCents: 0,
    // …and the seed has to SURVIVE the render. BalanceBadge — mounted in the concierge header —
    // calls `refresh()` on mount so the pill is current after a top-up; in a suite that doesn't
    // mock the network that round-trip fails and nulls `me` a microtask later, which shuts the gate
    // in the middle of the test. Stubbing refresh keeps the seeded identity put. No suite that uses
    // this helper asserts on refresh; one that needs to should seed the store itself.
    refresh: async () => {},
  });
}
