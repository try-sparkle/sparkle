import { describe, it, expect } from "vitest";
import { afterSuccess, afterSendFailure, NO_STREAK, ESCAPE_THRESHOLD } from "./chiefEscape";

describe("afterSendFailure — strikes belong to the chat, and only the held chat is abandoned", () => {
  it("does not abandon on the first strike", () => {
    const { streak, abandon } = afterSendFailure({ streak: NO_STREAK, sentOn: "c1", heldChatId: "c1" });
    expect(streak).toEqual({ chatId: "c1", count: 1 });
    expect(abandon).toBe(false);
  });

  it("abandons on the second consecutive strike against the same held chat", () => {
    const first = afterSendFailure({ streak: NO_STREAK, sentOn: "c1", heldChatId: "c1" });
    const second = afterSendFailure({ streak: first.streak, sentOn: "c1", heldChatId: "c1" });
    expect(second.abandon).toBe(true);
    expect(second.streak).toEqual(NO_STREAK); // the verdict is spent
  });

  it("counts strikes per chat — a failure on another chat doesn't carry over", () => {
    const onC1 = afterSendFailure({ streak: NO_STREAK, sentOn: "c1", heldChatId: "c1" });
    // A superseded turn fails on c1 while c2 is held: c2 is on its FIRST strike, not its second.
    const onC2 = afterSendFailure({ streak: onC1.streak, sentOn: "c2", heldChatId: "c2" });
    expect(onC2.streak).toEqual({ chatId: "c2", count: 1 });
    expect(onC2.abandon).toBe(false);
  });

  it("does NOT abandon the held chat for strikes earned by a chat already replaced", () => {
    // Two failures on c1, but c2 is now held: c1's strikes are history and c2 is innocent.
    const first = afterSendFailure({ streak: NO_STREAK, sentOn: "c1", heldChatId: "c2" });
    const second = afterSendFailure({
      streak: { chatId: "c1", count: 1 },
      sentOn: "c1",
      heldChatId: "c2",
    });
    expect(first.abandon).toBe(false);
    expect(second.abandon).toBe(false);
  });

  it("does not leave an inert verdict about a chat that is gone", () => {
    // The abandon didn't fire (c1 is no longer held), so nothing else will clear the streak — it
    // must not keep asserting "c1 is doomed" about a chat that can never be sent on again.
    const { streak } = afterSendFailure({
      streak: { chatId: "c1", count: 1 },
      sentOn: "c1",
      heldChatId: "c2",
    });
    expect(streak).toEqual(NO_STREAK);
  });

  it("is threshold-driven, not hardcoded to two", () => {
    let streak = NO_STREAK;
    for (let i = 1; i < ESCAPE_THRESHOLD; i++) {
      const r = afterSendFailure({ streak: streak, sentOn: "c1", heldChatId: "c1" });
      expect(r.abandon).toBe(false);
      streak = r.streak;
    }
    expect(afterSendFailure({ streak: streak, sentOn: "c1", heldChatId: "c1" }).abandon).toBe(true);
  });
});

describe("afterSuccess — a live chat's strikes are void, but only its own", () => {
  it("clears the streak for the chat that succeeded", () => {
    expect(afterSuccess({ chatId: "c1", count: 1 }, "c1")).toEqual(NO_STREAK);
  });

  it("leaves another chat's streak alone", () => {
    // The interleaving: the escape abandoned c1, c2 is now held and has a strike, and c1's stale
    // turn finally resolves. It must not wipe c2's strike — that would let a genuinely dead c2
    // survive its second strike and keep the lane wedged.
    const c2Streak = { chatId: "c2", count: 1 };
    expect(afterSuccess(c2Streak, "c1")).toEqual(c2Streak);

    // ...so c2's next failure still abandons it.
    expect(
      afterSendFailure({ streak: afterSuccess(c2Streak, "c1"), sentOn: "c2", heldChatId: "c2" })
        .abandon,
    ).toBe(true);
  });

  it("a success on the suspect chat means its NEXT failure starts over", () => {
    // The evidence is about the chat, not the turn: a stopped turn's send still proved c1 alive.
    const cleared = afterSuccess({ chatId: "c1", count: 1 }, "c1");
    expect(afterSendFailure({ streak: cleared, sentOn: "c1", heldChatId: "c1" }).abandon).toBe(false);
  });

  it("is a no-op when nothing is under suspicion", () => {
    expect(afterSuccess(NO_STREAK, "c1")).toEqual(NO_STREAK);
  });
});
