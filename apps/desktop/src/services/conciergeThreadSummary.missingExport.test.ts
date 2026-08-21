// THE CI RED THIS FILE EXISTS TO PIN, reproduced at its real seam.
//
// `maybeRefreshThreadSummary` used to read `chatOnce` in a DEFAULT PARAMETER
// (`deps = { chat: chatOnce }`). A default parameter is evaluated before the function body, so the
// read happened outside the body's `try` and nothing in the function could catch it. Vitest THROWS
// on access to an export a `vi.mock` factory omitted, and several ConciergeHost suites mock
// `../services/anthropic` for their own reasons without listing `chatOnce`. The throw escaped the
// fire-and-forget call site in `dispatchTurn` as an unhandled rejection — 4651 tests passing and the
// coverage shard still red, because the rejection belonged to no test.
//
// WHY THIS IS A SEPARATE FILE, and why the sibling suite could not host it: the bug is in the path
// taken when `deps` is OMITTED. A test that passes its own `deps` — even one whose getter throws —
// never evaluates the default and therefore proves nothing. That was the first attempt at this
// test, and it passed with the fix reverted. `vi.mock` is per-module-graph, so reproducing the real
// access needs a file whose whole graph has the partial mock installed.
import { describe, expect, it, beforeEach, vi } from "vitest";

// Deliberately PARTIAL and deliberately missing `chatOnce` — this is the shape the failing
// ConciergeHost suites happen to have, not a contrived one.
vi.mock("./anthropic", () => ({}));

import {
  maybeRefreshThreadSummary,
  _resetThreadSummaryForTests,
  SUMMARY_FAILURE_BACKOFF_MS,
} from "./conciergeThreadSummary";
import {
  useConciergeThreadSummaryStore,
  SUMMARY_REGEN_EVERY,
} from "../stores/conciergeThreadSummaryStore";
import { CONTINUITY_RECENT_MESSAGES } from "../engine/conciergeContinuity";
import type { ConciergeMessage } from "../components/Concierge/types";

const thread = (): ConciergeMessage[] =>
  Array.from(
    { length: CONTINUITY_RECENT_MESSAGES + SUMMARY_REGEN_EVERY },
    (_, i) => ({ id: `m${i}`, kind: "you", text: `text ${i}` }) as ConciergeMessage,
  );

// BOTH PIECES OF MODULE STATE, RESET (roborev 62012). The in-flight latch and the summary store
// are module-level, and neither vitest's `restoreMocks` nor a fresh `describe` touches them — so
// without this the two cases below are ORDER-DEPENDENT in the direction that hides the bug. The
// store one is the dangerous half: case 2 leaves `throughMessageId` at the newest message, so on a
// re-run in the other order case 1's `false` would mean "nothing pending" rather than "the throw
// was caught", and it would keep passing with the fix reverted.
beforeEach(() => {
  _resetThreadSummaryForTests();
  useConciergeThreadSummaryStore.getState().clear();
});

describe("a partially-mocked anthropic module", () => {
  it("RESOLVES false instead of rejecting, when called the way production calls it", async () => {
    // No `deps` — this is `dispatchTurn`'s exact call shape, and the only one that reaches the
    // module-binding read.
    await expect(maybeRefreshThreadSummary(thread())).resolves.toBe(false);
  });

  it("does not wedge the in-flight latch, so a later healthy call still runs", async () => {
    await maybeRefreshThreadSummary(thread(), { now: () => 0 });
    const ok = vi.fn(async () => "recovered");
    // THE POSITIVE CONTROL for the case above, and the reason the reset matters: the SAME fixture,
    // with a working dependency, must cross the threshold and reach the model. If it did not — a
    // wedged latch, or a store that already recorded these messages — then `false` above would be
    // satisfied by a summariser that never got near the throw, and would prove nothing.
    // Past the failure backoff the missing-binding throw arms, so a `true` here is evidence about
    // the latch rather than about the cooldown not having been set yet.
    await expect(
      maybeRefreshThreadSummary(thread(), { chat: ok, now: () => SUMMARY_FAILURE_BACKOFF_MS }),
    ).resolves.toBe(true);
    expect(ok).toHaveBeenCalledTimes(1);
    expect(useConciergeThreadSummaryStore.getState().text).toBe("recovered");
  });
});
