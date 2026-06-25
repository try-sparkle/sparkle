import { describe, it, expect, afterEach } from "vitest";
import {
  usePromptHistoryStore,
  computeGhost,
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

describe("computeGhost", () => {
  it("returns the suffix of the most recent matching prompt", () => {
    const h = ["deploy the staging server", "delete old branches"];
    expect(computeGhost("de", h)).toBe("ploy the staging server");
  });

  it("is case-insensitive on the prefix but preserves stored casing in the suffix", () => {
    expect(computeGhost("De", ["Deploy Now"])).toBe("ploy Now");
  });

  // Pin the intended (and most surprising) tradeoff: the suffix keeps the STORED casing, so
  // when the typed prefix's case differs, accepting (`typed + ghost`) yields mixed casing —
  // e.g. "DE" + "ploy" = "DEploy". This is deliberate (we never rewrite what the user typed).
  it("preserves stored suffix casing even when the typed prefix case differs", () => {
    const ghost = computeGhost("DE", ["deploy"]);
    expect(ghost).toBe("ploy");
    expect("DE" + ghost).toBe("DEploy");
  });

  it("returns empty string when nothing matches", () => {
    expect(computeGhost("xyz", ["deploy", "delete"])).toBe("");
  });

  it("returns empty string for empty input (no ghost on an empty composer)", () => {
    expect(computeGhost("", ["anything"])).toBe("");
  });

  it("does not suggest an exact full match (nothing left to complete)", () => {
    expect(computeGhost("deploy", ["deploy"])).toBe("");
  });

  it("prefers the most recent entry given newest-first order", () => {
    // Newest-first: "deploy prod" was recorded after "deploy staging".
    expect(computeGhost("deploy ", ["deploy prod", "deploy staging"])).toBe("prod");
  });
});
