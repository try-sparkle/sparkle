import { describe, it, expect, beforeEach } from "vitest";
import { useLibrarianStore, lanesFor, emptyLanes, type LibrarianItem } from "./librarianStore";

const item = (text: string, docRefs: string[] = []): LibrarianItem => ({ text, docRefs, ts: 1 });

describe("librarianStore", () => {
  beforeEach(() => useLibrarianStore.setState({ byAgent: {} }));

  it("starts with no agents and lanesFor returns empty lanes for an unknown agent", () => {
    expect(useLibrarianStore.getState().byAgent).toEqual({});
    expect(lanesFor("nope")).toEqual(emptyLanes());
    expect(lanesFor("nope").status).toBe("idle");
  });

  it("setLane populates a single lane, leaves the other empty, and stamps updatedAt", () => {
    useLibrarianStore.getState().setLane("a1", "grounding", [item("prior decision")]);
    const lanes = lanesFor("a1");
    expect(lanes.grounding).toEqual([item("prior decision")]);
    expect(lanes.challenges).toEqual([]);
    expect(lanes.updatedAt).toBeGreaterThan(0);
  });

  it("setLane on one lane preserves the other lane", () => {
    const { setLane } = useLibrarianStore.getState();
    setLane("a1", "grounding", [item("g")]);
    setLane("a1", "challenges", [item("c", ["doc"])]);
    const lanes = lanesFor("a1");
    expect(lanes.grounding).toEqual([item("g")]);
    expect(lanes.challenges).toEqual([item("c", ["doc"])]);
  });

  it("setStatus updates status without disturbing lanes", () => {
    const { setLane, setStatus } = useLibrarianStore.getState();
    setLane("a1", "grounding", [item("g")]);
    setStatus("a1", "thinking");
    expect(lanesFor("a1").status).toBe("thinking");
    expect(lanesFor("a1").grounding).toEqual([item("g")]);
    setStatus("a1", "error");
    expect(lanesFor("a1").status).toBe("error");
  });

  it("setStatus on an unseen agent seeds empty lanes", () => {
    useLibrarianStore.getState().setStatus("fresh", "thinking");
    const lanes = lanesFor("fresh");
    expect(lanes.status).toBe("thinking");
    expect(lanes.grounding).toEqual([]);
    expect(lanes.challenges).toEqual([]);
  });

  it("keeps agents isolated from one another", () => {
    const { setLane } = useLibrarianStore.getState();
    setLane("a1", "grounding", [item("one")]);
    setLane("a2", "grounding", [item("two")]);
    expect(lanesFor("a1").grounding).toEqual([item("one")]);
    expect(lanesFor("a2").grounding).toEqual([item("two")]);
  });

  it("clear removes an agent so lanesFor falls back to empty lanes", () => {
    const { setLane, clear } = useLibrarianStore.getState();
    setLane("a1", "grounding", [item("g")]);
    setLane("a2", "grounding", [item("g2")]);
    clear("a1");
    expect(useLibrarianStore.getState().byAgent.a1).toBeUndefined();
    expect(lanesFor("a1")).toEqual(emptyLanes());
    // unrelated agent untouched
    expect(lanesFor("a2").grounding).toEqual([item("g2")]);
  });
});
