import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the Tauri-backed service so the store is tested in isolation (no invoke).
vi.mock("../services/history", () => ({
  recordHistory: vi.fn(async () => {}),
  searchHistory: vi.fn(async () => []),
  pruneHistory: vi.fn(async () => 0),
}));
// And the credits stub, so entitlement is controllable per-test.
vi.mock("../services/credits", () => ({
  getRetentionEntitlement: vi.fn(async () => "24h"),
}));

import { recordHistory, searchHistory, pruneHistory, type HistoryHit } from "../services/history";
import { getRetentionEntitlement } from "../services/credits";
import { useHistoryStore, windowMsForTier } from "./historyStore";

const mockRecord = vi.mocked(recordHistory);
const mockSearch = vi.mocked(searchHistory);
const mockPrune = vi.mocked(pruneHistory);
const mockEntitlement = vi.mocked(getRetentionEntitlement);

const hit = (id: string): HistoryHit => ({
  id,
  kind: "prompt",
  source: "build",
  projectId: "p1",
  agentId: "a1",
  projectName: "Proj",
  agentName: "Agent",
  snippet: "a <b>hit</b>",
  createdAt: 1000,
});

const reset = () =>
  useHistoryStore.setState({ query: "", results: [], entitlement: "24h", searching: false });

beforeEach(() => {
  reset();
  mockRecord.mockReset().mockResolvedValue(undefined);
  mockSearch.mockReset().mockResolvedValue([]);
  mockPrune.mockReset().mockResolvedValue(0);
  mockEntitlement.mockReset().mockResolvedValue("24h");
});

describe("windowMsForTier", () => {
  it("maps each tier to its window in ms; indefinite → null", () => {
    expect(windowMsForTier("24h")).toBe(86_400_000);
    expect(windowMsForTier("7d")).toBe(604_800_000);
    expect(windowMsForTier("30d")).toBe(2_592_000_000);
    expect(windowMsForTier("90d")).toBe(7_776_000_000);
    expect(windowMsForTier("1y")).toBe(31_536_000_000);
    expect(windowMsForTier("indefinite")).toBeNull();
  });
});

describe("historyStore", () => {
  it("record() delegates to recordHistory", async () => {
    const entry = {
      id: "id1",
      kind: "prompt" as const,
      source: "brainstorm" as const,
      projectId: "p1",
      agentId: "a1",
      projectName: "Proj",
      agentName: "Think",
      text: "hello",
      createdAt: 42,
    };
    await useHistoryStore.getState().record(entry);
    expect(mockRecord).toHaveBeenCalledWith(entry);
  });

  it("search() populates results and clears the searching flag", async () => {
    mockSearch.mockResolvedValue([hit("h1"), hit("h2")]);
    await useHistoryStore.getState().search("rust");
    expect(mockSearch).toHaveBeenCalledWith("rust");
    const s = useHistoryStore.getState();
    expect(s.results.map((r) => r.id)).toEqual(["h1", "h2"]);
    expect(s.searching).toBe(false);
  });

  it("search() with a blank query clears results without calling the service", async () => {
    useHistoryStore.setState({ results: [hit("stale")] });
    await useHistoryStore.getState().search("   ");
    expect(mockSearch).not.toHaveBeenCalled();
    expect(useHistoryStore.getState().results).toEqual([]);
  });

  it("loadEntitlement() stores the tier from credits", async () => {
    mockEntitlement.mockResolvedValue("30d");
    await useHistoryStore.getState().loadEntitlement();
    expect(useHistoryStore.getState().entitlement).toBe("30d");
  });

  it("prune() on the 24h tier calls pruneHistory(now - 24h)", async () => {
    useHistoryStore.setState({ entitlement: "24h" });
    const now = 1_000_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    await useHistoryStore.getState().prune();
    expect(mockPrune).toHaveBeenCalledWith(now - 86_400_000);
    vi.restoreAllMocks();
  });

  it("prune() on the indefinite tier calls pruneHistory(null)", async () => {
    useHistoryStore.setState({ entitlement: "indefinite" });
    await useHistoryStore.getState().prune();
    expect(mockPrune).toHaveBeenCalledWith(null);
  });

  it("setQuery() updates query immediately and debounces a search", async () => {
    vi.useFakeTimers();
    mockSearch.mockResolvedValue([hit("d1")]);
    useHistoryStore.getState().setQuery("ru");
    expect(useHistoryStore.getState().query).toBe("ru");
    // Not searched synchronously.
    expect(mockSearch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(mockSearch).toHaveBeenCalledWith("ru");
    vi.useRealTimers();
  });
});
