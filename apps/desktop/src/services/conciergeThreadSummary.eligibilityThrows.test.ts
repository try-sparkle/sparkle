// THE SECOND HALF OF THE SAME BUG (roborev 62012), pinned at its own seam.
//
// `ee03099` moved the `chatOnce` read out of a default parameter and into the body's `try`, because
// a read outside the try escapes a fire-and-forget call as an unhandled rejection — and an unhandled
// rejection fails a vitest shard even when every test in it passes. But the ELIGIBILITY work was
// still outside that try: the summary-store read, `messagesOutsideWindow(chat)` and `pendingSince`.
// Those are module bindings from two other modules, and this repo's own suites partially mock
// modules all the time, so the identical failure was one `vi.mock` away — while the function's
// doc comment promised "never throws" and `ConciergeHost.tsx` took it at its word with a bare `void`.
//
// WHY THIS FILE IS SEPARATE from `conciergeThreadSummary.test.ts`: `vi.mock` is per-module-graph, so
// a suite that wants the REAL `messagesOutsideWindow` for its other cases cannot also install a
// broken one. The sibling `missingExport.test.ts` exists for the same reason.
//
// WHY IT MOCKS `messagesOutsideWindow` AS A THROWING FN rather than omitting the export: both
// reproduce the bug (the call site was outside the try either way), and a throwing fn can also be
// switched to a WORKING one for the positive control below. Without that control, "resolves false"
// would be satisfied by a summariser that never got near the model at all.
import { describe, expect, it, beforeEach, vi } from "vitest";

const { outsideWindow } = vi.hoisted(() => ({ outsideWindow: vi.fn() }));

vi.mock("../engine/conciergeContinuity", async (importActual) => {
  const actual = await importActual<typeof import("../engine/conciergeContinuity")>();
  return { ...actual, messagesOutsideWindow: outsideWindow };
});

import {
  maybeRefreshThreadSummary,
  _resetThreadSummaryForTests,
} from "./conciergeThreadSummary";
import {
  useConciergeThreadSummaryStore,
  SUMMARY_REGEN_EVERY,
} from "../stores/conciergeThreadSummaryStore";
import type { ConciergeMessage } from "../components/Concierge/types";

/** Exactly enough out-of-window messages to cross the regeneration threshold. */
const outside = (): ConciergeMessage[] =>
  Array.from(
    { length: SUMMARY_REGEN_EVERY },
    (_, i) => ({ id: `m${i}`, kind: "you", text: `text ${i}` }) as ConciergeMessage,
  );

beforeEach(() => {
  _resetThreadSummaryForTests();
  useConciergeThreadSummaryStore.getState().clear();
  outsideWindow.mockReset();
});

describe("when the eligibility work itself throws", () => {
  it("RESOLVES false instead of rejecting, called the way ConciergeHost calls it", async () => {
    outsideWindow.mockImplementation(() => {
      throw new Error("[vitest] No \"messagesOutsideWindow\" export is defined on the mock");
    });
    // `.resolves` is the assertion, not a try/catch: a REJECTED promise here is precisely the
    // production failure — `void maybeRefreshThreadSummary(...)` at ConciergeHost.tsx:3609 has
    // nothing attached to it, so the rejection belongs to no test and reds the whole shard.
    await expect(maybeRefreshThreadSummary([])).resolves.toBe(false);
    expect(outsideWindow).toHaveBeenCalledTimes(1);
  });

  it("does not wedge the in-flight latch, so the next threshold still summarises", async () => {
    outsideWindow.mockImplementationOnce(() => {
      throw new Error("transient");
    });
    await maybeRefreshThreadSummary([]);

    // THE POSITIVE CONTROL, and the reason the case above is not vacuous: the same fixture, with a
    // working dependency, reaches the model and stores the result. If the latch had stayed set —
    // or if the threshold were never crossed — this would return false too, and "resolves false"
    // above would prove nothing about the throw.
    outsideWindow.mockReturnValue(outside());
    const chat = vi.fn(async () => "- recovered summary");
    await expect(maybeRefreshThreadSummary([], { chat })).resolves.toBe(true);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(useConciergeThreadSummaryStore.getState().text).toBe("- recovered summary");
  });
});
