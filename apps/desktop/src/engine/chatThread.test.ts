// The pure half of the chat pane's thread (bead `sparkle-xnjil.10`).
//
// The two key builders are the whole file's reason to exist, and both are tested by asking what
// CHANGES them — not by pinning the string they happen to produce. A snapshot of `chatContentKey`'s
// output would pass for an implementation that folds in nothing, which is exactly the defect: the
// hook's contract is "a string that changes whenever the RENDERED CONTENT changes", so every test
// below is a pair of thread states that must NOT collide.
import { describe, it, expect } from "vitest";
import { chatContentKey, chatRearmKey, sendableBody, type ChatMessage } from "./chatThread";

const msg = (over: Partial<ChatMessage> & Pick<ChatMessage, "id">): ChatMessage => ({
  mine: false,
  author: "ada",
  body: "hello",
  createdAt: "2026-08-25T00:00:00.000Z",
  ...over,
});

describe("sendableBody", () => {
  it("returns the TRIMMED body, so a caller cannot send one string and test another", () => {
    expect(sendableBody("  hi  ")).toBe("hi");
  });

  it("refuses whitespace-only input — a blank line is not a message", () => {
    expect(sendableBody("")).toBeNull();
    expect(sendableBody("   \n\t ")).toBeNull();
  });

  it("keeps interior whitespace and newlines exactly", () => {
    expect(sendableBody("  a\n\n  b  ")).toBe("a\n\n  b");
  });
});

describe("chatContentKey — what must move it", () => {
  it("moves when a message is APPENDED", () => {
    const a = [msg({ id: "1" })];
    const b = [msg({ id: "1" }), msg({ id: "2" })];
    expect(chatContentKey(a)).not.toBe(chatContentKey(b));
  });

  // THE ONE THAT IS EASY TO OMIT. An optimistic echo replaced by the server's own flattening
  // changes neither the count nor the last id — a key built from those two alone is identical
  // across the swap and the follow silently strands the reader one bubble short.
  it("moves when a body is EDITED IN PLACE at the same count and id", () => {
    const a = [msg({ id: "1", body: "hi" })];
    const b = [msg({ id: "1", body: "hi there" })];
    expect(chatContentKey(a)).not.toBe(chatContentKey(b));
  });

  // A pending→settled ack can leave the body byte-identical: same id, same count, same text, only
  // the flag drops. The bubble repaints (the dimming lifts), so the key has to move.
  it("moves when a message SETTLES from pending, with the body unchanged", () => {
    const a = [msg({ id: "1", mine: true, pending: true })];
    const b = [msg({ id: "1", mine: true })];
    expect(chatContentKey(a)).not.toBe(chatContentKey(b));
  });

  it("moves when a message FAILS, with the body unchanged", () => {
    const a = [msg({ id: "1", mine: true })];
    const b = [msg({ id: "1", mine: true, failed: true })];
    expect(chatContentKey(a)).not.toBe(chatContentKey(b));
  });

  // The `pending`/`failed` bits are position-weighted for this: two messages exchanging states is a
  // repaint, and a naive count of set flags would cancel out and report no change.
  it("moves when two messages SWAP pending/failed between them", () => {
    const a = [msg({ id: "1", pending: true }), msg({ id: "2", failed: true })];
    const b = [msg({ id: "1", failed: true }), msg({ id: "2", pending: true })];
    expect(chatContentKey(a)).not.toBe(chatContentKey(b));
  });

  // THE NEGATIVE HALF, and it is what stops the key from being `Math.random()`. `useAutoFollow`'s
  // whole contract is that ARRAY IDENTITY must not drive it (bead `sparkle-y4ft`: a host rebuilding
  // its array every tick scrolled the column on every click), so equal content must give an equal
  // key across two distinct arrays.
  it("does NOT move for a fresh array holding the same content", () => {
    const a = [msg({ id: "1" }), msg({ id: "2", mine: true })];
    const b = [msg({ id: "1" }), msg({ id: "2", mine: true })];
    expect(a).not.toBe(b);
    expect(chatContentKey(a)).toBe(chatContentKey(b));
  });

  it("is stable for the empty thread", () => {
    expect(chatContentKey([])).toBe(chatContentKey([]));
  });
});

describe("chatRearmKey — only the VIEWER's own message re-arms the follow", () => {
  it("returns the newest message the viewer wrote", () => {
    const t = [
      msg({ id: "1", mine: true }),
      msg({ id: "2" }),
      msg({ id: "3", mine: true }),
      msg({ id: "4" }),
    ];
    expect(chatRearmKey(t)).toBe("3");
  });

  // THE SIDE EFFECT THAT MATTERS. A peer's message arriving must not change the re-arm key, or a
  // reader who scrolled up gets yanked to the bottom by somebody ELSE typing — the exact behaviour
  // the follow can be disarmed for.
  it("does NOT change when a PEER sends", () => {
    const before = [msg({ id: "1", mine: true })];
    const after = [...before, msg({ id: "2" }), msg({ id: "3" })];
    expect(chatRearmKey(after)).toBe(chatRearmKey(before));
  });

  it("DOES change when the viewer sends again — the one thing besides reaching the bottom", () => {
    const before = [msg({ id: "1", mine: true }), msg({ id: "2" })];
    const after = [...before, msg({ id: "3", mine: true })];
    expect(chatRearmKey(after)).not.toBe(chatRearmKey(before));
  });

  // `useAutoFollow` reads `""` as "nothing to re-arm on". A boolean-ish key here is the trap its own
  // docstring names: "Never pass a boolean 'a user message exists' — that re-arms on every tick".
  it("is empty when the viewer has said nothing", () => {
    expect(chatRearmKey([msg({ id: "1" }), msg({ id: "2" })])).toBe("");
    expect(chatRearmKey([])).toBe("");
  });
});
