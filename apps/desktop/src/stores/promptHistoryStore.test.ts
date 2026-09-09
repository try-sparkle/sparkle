import { describe, it, expect, afterEach } from "vitest";
import {
  usePromptHistoryStore,
  PROMPT_HISTORY_MAX,
  PROMPT_MAX_LEN,
} from "./promptHistoryStore";

describe("promptHistoryStore.record", () => {
  // Module-level singleton — reset between tests so entries don't leak across blocks.
  afterEach(() => {
    localStorage.clear();
    usePromptHistoryStore.setState({ history: [] });
  });

  const record = (p: string) => usePromptHistoryStore.getState().record(p);
  const history = () => usePromptHistoryStore.getState().history;

  it("prepends newest first", () => {
    record("first");
    record("second");
    expect(history()).toEqual(["second", "first"]);
  });

  it("trims whitespace and ignores empty/blank prompts", () => {
    record("  hello  ");
    record("   ");
    record("");
    expect(history()).toEqual(["hello"]);
  });

  it("dedupes by moving an existing prompt to the front", () => {
    record("a");
    record("b");
    record("a");
    expect(history()).toEqual(["a", "b"]);
  });

  it("ignores prompts longer than PROMPT_MAX_LEN (localStorage guard)", () => {
    record("a".repeat(PROMPT_MAX_LEN)); // exactly at the cap is allowed
    record("b".repeat(PROMPT_MAX_LEN + 1)); // one over is dropped
    expect(history().length).toBe(1);
    expect(history()[0]?.length).toBe(PROMPT_MAX_LEN);
  });

  it("caps the list at PROMPT_HISTORY_MAX", () => {
    for (let i = 0; i < PROMPT_HISTORY_MAX + 50; i++) record(`prompt ${i}`);
    expect(history().length).toBe(PROMPT_HISTORY_MAX);
    // Newest survives, oldest evicted.
    expect(history()[0]).toBe(`prompt ${PROMPT_HISTORY_MAX + 49}`);
  });
});
