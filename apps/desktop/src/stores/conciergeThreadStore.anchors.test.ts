// REPLY ANCHORS ACROSS A RESTART.
//
// `rehydrateThread` renames every restored message by POSITION, because the ids a fresh session mints
// collide with the persisted ones (see its header). A reply's anchors are the only field in the
// thread that REFERS to another message by id — so the rename has to reach them, or a restored
// thread's quoted stubs and every "Answered below" marker derived from them point at ids nothing
// holds, and the affordance silently dies at the first relaunch.
//
// Asserted through the store's own exported functions rather than through zustand's persist
// middleware, exactly as conciergeThreadStore.test.ts does for the caps.
import { describe, expect, it } from "vitest";
import { RESTORED_ID_PREFIX, persistableThread, rehydrateThread } from "./conciergeThreadStore";
import { answeredByIndex } from "../components/Concierge/replyAnchors";
import type { ConciergeMessage } from "../components/Concierge/types";

const thread: ConciergeMessage[] = [
  { id: "you-1", kind: "you", text: "check the retry logic", receipt: { target: "sparkle" } },
  { id: "you-2", kind: "you", text: "also the timeout", receipt: { target: "sparkle" } },
  {
    id: "brain-7",
    kind: "sparkle",
    text: "Both fine.",
    answers: [
      { id: "you-1", quote: "check the retry logic" },
      { id: "you-2", quote: "also the timeout" },
    ],
  },
];

describe("a restored reply still knows what it answered", () => {
  it("rewrites the anchor ids through the same rename the messages get", () => {
    const restored = rehydrateThread(thread);
    const reply = restored[2]!;
    expect(reply.kind === "sparkle" && reply.answers).toEqual([
      { id: `${RESTORED_ID_PREFIX}0`, quote: "check the retry logic" },
      { id: `${RESTORED_ID_PREFIX}1`, quote: "also the timeout" },
    ]);
  });

  it("keeps the marker resolvable end to end — the ids still name messages that exist", () => {
    // The assertion that would have caught a rename applied to messages but not to references: the
    // derived back-index must land on real restored ids, not on ids from the previous process.
    const restored = rehydrateThread(thread);
    const idx = answeredByIndex(restored);
    const present = new Set(restored.map((m) => m.id));
    for (const [answeredId, replyId] of idx) {
      expect(present.has(answeredId)).toBe(true);
      expect(present.has(replyId)).toBe(true);
    }
    expect(idx.size).toBe(2);
  });

  it("keeps the quote and drops only the jump when the answered message was trimmed away", () => {
    // `persistableThread` trims from the FRONT, so a long-lived thread routinely writes replies whose
    // targets did not survive. The stub must still say what was asked — it just can't scroll there.
    const restored = rehydrateThread(thread.slice(2));
    const reply = restored[0]!;
    expect(reply.kind === "sparkle" && reply.answers).toEqual([
      { id: "", quote: "check the retry logic" },
      { id: "", quote: "also the timeout" },
    ]);
  });

  it("survives the persist step itself, so what is restored is what was written", () => {
    const restored = rehydrateThread(persistableThread(thread));
    const reply = restored[2]!;
    expect(reply.kind === "sparkle" && reply.answers?.map((a) => a.quote)).toEqual([
      "check the retry logic",
      "also the timeout",
    ]);
  });

  it("still clears a restored receipt's redirect — the anchor branch must not skip that rule", () => {
    // The two rewrites live in the same `map`, and an early `return` for the anchor case is exactly
    // how the older rule would get quietly dropped for one kind of message.
    const restored = rehydrateThread([
      { id: "you-1", kind: "you", text: "hi", receipt: { target: "sparkle", redirectable: true } },
    ]);
    const you = restored[0]!;
    expect(you.kind === "you" && you.receipt?.redirectable).toBe(false);
  });
});
