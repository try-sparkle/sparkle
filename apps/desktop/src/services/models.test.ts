import { describe, it, expect } from "vitest";
import { CLAUDE_MODELS, DEFAULT_MODEL_ID, isDefaultModel, modelShortLabel } from "./models";

describe("models (per-agent Claude model list, sparkle-i6rw)", () => {
  it("leads with the Default sentinel so the dropdown's first entry is 'inherit'", () => {
    expect(CLAUDE_MODELS[0]!.id).toBe(DEFAULT_MODEL_ID);
  });

  it("isDefaultModel treats undefined, empty, and the sentinel as default", () => {
    expect(isDefaultModel(undefined)).toBe(true);
    expect(isDefaultModel("")).toBe(true);
    expect(isDefaultModel(DEFAULT_MODEL_ID)).toBe(true);
    expect(isDefaultModel("claude-opus-4-8")).toBe(false);
  });

  it("modelShortLabel maps known ids to their pill label", () => {
    expect(modelShortLabel("claude-opus-4-8")).toBe("Opus");
    expect(modelShortLabel(undefined)).toBe("Default");
    expect(modelShortLabel(DEFAULT_MODEL_ID)).toBe("Default");
  });

  it("modelShortLabel falls back to the raw id for an unknown model (stale persisted record)", () => {
    expect(modelShortLabel("claude-future-9")).toBe("claude-future-9");
  });
});
