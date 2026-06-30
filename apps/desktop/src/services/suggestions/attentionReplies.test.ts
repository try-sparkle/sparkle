import { describe, it, expect } from "vitest";
import { suggestedRepliesFor } from "./attentionReplies";

describe("suggestedRepliesFor", () => {
  it("prefers real detected y/n buttons over the generic Approve/Deny", () => {
    const out = suggestedRepliesFor("Apply this change? (y/n) ", true);
    expect(out).toEqual([
      { label: "Approve", value: "y\n" },
      { label: "Deny", value: "n\n" },
    ]);
  });

  it("prefers detected numbered-menu choices", () => {
    const menu = ["1) keep", "2) discard", "Enter your choice: "].join("\n");
    expect(suggestedRepliesFor(menu, false)).toEqual([
      { label: "1", value: "1\n" },
      { label: "2", value: "2\n" },
    ]);
  });

  it("falls back to Approve/Deny for an approval with no detectable prompt", () => {
    expect(suggestedRepliesFor("doing work...\n$ ", true)).toEqual([
      { label: "Approve", value: "y\n" },
      { label: "Deny", value: "n\n" },
    ]);
  });

  it("returns no canned replies for a plain question with no detectable prompt", () => {
    expect(suggestedRepliesFor("what should I name this?\n", false)).toEqual([]);
  });
});
