// @vitest-environment jsdom
//
// Phase 2 (sparkle-i6rw): the DYNAMIC model catalog — merge strategy, fallback, cache, and the
// external-store refresh. The module keeps singleton state (the live catalog, TTL, in-flight
// promise), so each test loads a FRESH copy via vi.resetModules() + dynamic import to avoid
// cross-test bleed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

type ModelsModule = typeof import("./models");

async function freshModule(): Promise<ModelsModule> {
  vi.resetModules();
  return import("./models");
}

beforeEach(() => {
  invokeMock.mockReset();
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("mergeCatalog (dynamic → catalog)", () => {
  it("an empty/absent dynamic list keeps the curated list unchanged (by identity)", async () => {
    const m = await freshModule();
    expect(m.mergeCatalog([])).toBe(m.CLAUDE_MODELS);
    expect(m.mergeCatalog(null)).toBe(m.CLAUDE_MODELS);
    expect(m.mergeCatalog(undefined)).toBe(m.CLAUDE_MODELS);
  });

  it("dynamic list becomes the catalog with the Default sentinel always first", async () => {
    const m = await freshModule();
    const merged = m.mergeCatalog([
      { id: "claude-opus-4-8", display_name: "Claude Opus 4.8" },
      { id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5" },
    ]);
    expect(merged[0]!.id).toBe(m.DEFAULT_MODEL_ID);
    expect(merged.map((o) => o.id)).toEqual([
      "default",
      "claude-opus-4-8",
      "claude-haiku-4-5",
    ]);
  });

  it("preserves curated short/long labels for known ids", async () => {
    const m = await freshModule();
    const merged = m.mergeCatalog([{ id: "claude-opus-4-8", display_name: "Claude Opus 4.8 (dynamic)" }]);
    const opus = merged.find((o) => o.id === "claude-opus-4-8")!;
    expect(opus.short).toBe("Opus");
    expect(opus.label).toBe("Opus 4.8"); // curated label wins over the wire display_name
  });

  it("derives a short label from display_name for unknown ids", async () => {
    const m = await freshModule();
    const merged = m.mergeCatalog([
      { id: "claude-opus-9", display_name: "Claude Opus 9" },
      { id: "claude-mystery-1", display_name: "Mystery One" },
    ]);
    const opus9 = merged.find((o) => o.id === "claude-opus-9")!;
    expect(opus9.short).toBe("Opus"); // strips "Claude ", first word
    expect(opus9.label).toBe("Claude Opus 9"); // unknown → full display_name as the menu label
    const mystery = merged.find((o) => o.id === "claude-mystery-1")!;
    expect(mystery.short).toBe("Mystery");
  });

  it("dedupes by id (first wins) and drops a dynamic 'default' collision", async () => {
    const m = await freshModule();
    const merged = m.mergeCatalog([
      { id: "claude-opus-4-8", display_name: "Claude Opus 4.8" },
      { id: "claude-opus-4-8", display_name: "dup" },
      { id: "default", display_name: "not the sentinel" },
    ]);
    expect(merged.map((o) => o.id)).toEqual(["default", "claude-opus-4-8"]);
    // The sentinel is still the curated one, not the wire "default".
    expect(merged[0]!.label).toBe("Default (Claude Code setting)");
  });

  it("falls back to display_name (then id) when a derived short would be empty", async () => {
    const m = await freshModule();
    const merged = m.mergeCatalog([
      { id: "claude-x", display_name: "   " }, // blank → display becomes the id
    ]);
    const x = merged.find((o) => o.id === "claude-x")!;
    expect(x.label).toBe("claude-x");
    expect(x.short).toBe("claude-x");
  });
});

describe("refreshModelCatalog", () => {
  it("replaces the catalog and notifies subscribers when the fetch returns models", async () => {
    const m = await freshModule();
    invokeMock.mockResolvedValue([{ id: "claude-opus-9", display_name: "Claude Opus 9" }]);
    const notified = vi.fn();
    m.subscribeModelCatalog(notified);

    await m.refreshModelCatalog();

    expect(invokeMock).toHaveBeenCalledWith("list_claude_models");
    expect(notified).toHaveBeenCalled();
    expect(m.getModelCatalog().map((o) => o.id)).toEqual(["default", "claude-opus-9"]);
  });

  it("keeps the curated list (no notify) when the fetch returns an empty list", async () => {
    const m = await freshModule();
    invokeMock.mockResolvedValue([]);
    const notified = vi.fn();
    m.subscribeModelCatalog(notified);

    await m.refreshModelCatalog();

    expect(m.getModelCatalog()).toBe(m.CLAUDE_MODELS);
    expect(notified).not.toHaveBeenCalled();
  });

  it("keeps the current catalog when invoke rejects (no host / command error)", async () => {
    const m = await freshModule();
    invokeMock.mockRejectedValue(new Error("no tauri host"));

    await m.refreshModelCatalog();

    expect(m.getModelCatalog()).toBe(m.CLAUDE_MODELS);
  });

  it("dedupes concurrent refreshes into a single invoke", async () => {
    const m = await freshModule();
    invokeMock.mockResolvedValue([{ id: "claude-opus-9", display_name: "Claude Opus 9" }]);

    await Promise.all([m.refreshModelCatalog(), m.refreshModelCatalog()]);

    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("skips a second refresh within the TTL, but honors force", async () => {
    const m = await freshModule();
    invokeMock.mockResolvedValue([{ id: "claude-opus-9", display_name: "Claude Opus 9" }]);

    await m.refreshModelCatalog();
    await m.refreshModelCatalog(); // within TTL → skipped
    expect(invokeMock).toHaveBeenCalledTimes(1);

    await m.refreshModelCatalog({ force: true });
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("persists the merged catalog and seeds it on the next module load", async () => {
    const m1 = await freshModule();
    invokeMock.mockResolvedValue([{ id: "claude-opus-9", display_name: "Claude Opus 9" }]);
    await m1.refreshModelCatalog();
    expect(localStorage.getItem("sparkle.modelCatalog.v1")).toBeTruthy();

    // A fresh module load (new launch) seeds from the cache before any fetch returns.
    const m2 = await freshModule();
    expect(m2.getModelCatalog().map((o) => o.id)).toEqual(["default", "claude-opus-9"]);
  });

  it("ignores a corrupt cache and starts from the curated list", async () => {
    localStorage.setItem("sparkle.modelCatalog.v1", "{not valid json");
    const m = await freshModule();
    expect(m.getModelCatalog()).toBe(m.CLAUDE_MODELS);
  });

  it("discards a cache that does not lead with the Default sentinel", async () => {
    localStorage.setItem(
      "sparkle.modelCatalog.v1",
      JSON.stringify([{ id: "claude-opus-9", label: "Opus 9", short: "Opus" }]),
    );
    const m = await freshModule();
    expect(m.getModelCatalog()).toBe(m.CLAUDE_MODELS);
  });
});

describe("modelShortLabel over the live catalog", () => {
  it("resolves a dynamic-only id's short label once the catalog refreshes", async () => {
    const m = await freshModule();
    // Before refresh an unknown id shows as itself.
    expect(m.modelShortLabel("claude-mystery-1")).toBe("claude-mystery-1");
    invokeMock.mockResolvedValue([{ id: "claude-mystery-1", display_name: "Mystery One" }]);
    await m.refreshModelCatalog();
    expect(m.modelShortLabel("claude-mystery-1")).toBe("Mystery");
  });

  it("still maps curated ids and the default sentinel (Phase 1 behavior intact)", async () => {
    const m = await freshModule();
    expect(m.modelShortLabel("claude-opus-4-8")).toBe("Opus");
    expect(m.modelShortLabel(undefined)).toBe("Default");
    expect(m.modelShortLabel(m.DEFAULT_MODEL_ID)).toBe("Default");
  });
});
