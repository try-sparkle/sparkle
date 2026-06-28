import { describe, expect, it } from "vitest";
import { correlatePromptId, PROMPT_MATCH_TOLERANCE_MS } from "./promptCorrelate";
import type { PromptHistoryEntry } from "../types";

const e = (id: string, at: number): PromptHistoryEntry => ({ id, at, text: id });

describe("correlatePromptId", () => {
  const history = [e("p1", 1_000), e("p2", 5_000), e("p3", 9_000)];

  it("returns null for empty history", () => {
    expect(correlatePromptId({ kind: "prompt", createdAt: 5_000 }, [])).toBeNull();
  });

  it("PROMPT hit picks the nearest entry by time", () => {
    expect(correlatePromptId({ kind: "prompt", createdAt: 5_200 }, history)).toBe("p2");
    expect(correlatePromptId({ kind: "prompt", createdAt: 8_900 }, history)).toBe("p3");
  });

  it("PROMPT hit beyond tolerance returns null", () => {
    const far = { kind: "prompt" as const, createdAt: 9_000 + PROMPT_MATCH_TOLERANCE_MS + 1 };
    expect(correlatePromptId(far, history)).toBeNull();
    // …but just inside tolerance still resolves to the nearest (p3).
    const near = { kind: "prompt" as const, createdAt: 9_000 + PROMPT_MATCH_TOLERANCE_MS - 1 };
    expect(correlatePromptId(near, history)).toBe("p3");
  });

  it("RESPONSE hit picks the latest prompt at or before it (the turn that produced it)", () => {
    expect(correlatePromptId({ kind: "response", createdAt: 6_000 }, history)).toBe("p2");
    expect(correlatePromptId({ kind: "response", createdAt: 9_000 }, history)).toBe("p3");
  });

  it("RESPONSE hit before any prompt returns null", () => {
    expect(correlatePromptId({ kind: "response", createdAt: 500 }, history)).toBeNull();
  });

  it("RESPONSE correlation ignores the time tolerance (an old turn still resolves)", () => {
    const old = { kind: "response" as const, createdAt: 9_000 + PROMPT_MATCH_TOLERANCE_MS * 10 };
    expect(correlatePromptId(old, history)).toBe("p3");
  });

  it("PROMPT tie resolves to the later (more recent) equidistant prompt", () => {
    // 4_000 is exactly 1_000 from both p1 (5_000) and an earlier prompt at 3_000; prefer the later.
    const tied = [e("early", 3_000), e("late", 5_000)];
    expect(correlatePromptId({ kind: "prompt", createdAt: 4_000 }, tied)).toBe("late");
  });

  it("PROMPT: a strictly-nearer EARLIER prompt still wins over a later, farther one", () => {
    // Guards the `<=` tie-break from drifting into "always prefer the later prompt": here the
    // earlier entry is genuinely closer (delta 200 vs 1_800), so it must win regardless of order.
    const entries = [e("near", 4_800), e("far", 6_800)];
    expect(correlatePromptId({ kind: "prompt", createdAt: 5_000 }, entries)).toBe("near");
  });
});
