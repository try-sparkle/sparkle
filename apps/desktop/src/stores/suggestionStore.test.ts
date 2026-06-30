import { describe, it, expect, beforeEach } from "vitest";
import { useSuggestionStore, MAX_EVENTS } from "./suggestionStore";

const reset = () => useSuggestionStore.setState({ events: [] });

describe("suggestionStore", () => {
  beforeEach(reset);

  it("records events and returns them most-recent-first", () => {
    useSuggestionStore.getState().recordEvent({ contextTags: ["merge"], label: "Cut DMG", value: "Cut a test DMG.", kind: "prompt" });
    useSuggestionStore.getState().recordEvent({ contextTags: ["merge"], label: "Rebase+PR", value: "Rebase and PR.", kind: "prompt" });
    const recent = useSuggestionStore.getState().recentEvents();
    expect(recent[0]?.label).toBe("Rebase+PR");
    expect(recent).toHaveLength(2);
  });

  it("caps history at MAX_EVENTS, dropping oldest", () => {
    for (let i = 0; i < MAX_EVENTS + 25; i++) {
      useSuggestionStore.getState().recordEvent({ contextTags: ["x"], label: `e${i}`, value: "v", kind: "prompt" });
    }
    const all = useSuggestionStore.getState().events;
    expect(all).toHaveLength(MAX_EVENTS);
    expect(all[all.length - 1]?.label).toBe(`e${MAX_EVENTS + 24}`);
  });

  it("ranks by context-tag overlap then frequency", () => {
    const s = useSuggestionStore.getState();
    s.recordEvent({ contextTags: ["merge", "ci-green"], label: "A", value: "a", kind: "prompt" });
    s.recordEvent({ contextTags: ["merge", "ci-green"], label: "A", value: "a", kind: "prompt" });
    s.recordEvent({ contextTags: ["unrelated"], label: "B", value: "b", kind: "prompt" });
    const top = useSuggestionStore.getState().topByContext(["merge"], 3);
    expect(top[0]?.label).toBe("A");
  });

  it("weights overlap above raw frequency (rarer high-overlap beats frequent low-overlap)", () => {
    const s = useSuggestionStore.getState();
    // Frequent but zero overlap.
    s.recordEvent({ contextTags: ["other"], label: "Frequent", value: "f", kind: "prompt" });
    s.recordEvent({ contextTags: ["other"], label: "Frequent", value: "f", kind: "prompt" });
    s.recordEvent({ contextTags: ["other"], label: "Frequent", value: "f", kind: "prompt" });
    // Rare but matches the queried context.
    s.recordEvent({ contextTags: ["merge"], label: "Relevant", value: "r", kind: "prompt" });
    const top = useSuggestionStore.getState().topByContext(["merge"], 3);
    expect(top[0]?.label).toBe("Relevant");
  });

  it("respects the limit and does NOT collide distinct fields via a bare-space key", () => {
    const s = useSuggestionStore.getState();
    s.recordEvent({ contextTags: [], label: "a b", value: "c", kind: "prompt" });
    s.recordEvent({ contextTags: [], label: "a", value: "b c", kind: "prompt" });
    const top = useSuggestionStore.getState().topByContext([], 5);
    expect(top).toHaveLength(2); // would be 1 if "a b"+"c" collided with "a"+"b c"
  });

  it("recentEvents returns newest-first and honors the limit", () => {
    const s = useSuggestionStore.getState();
    s.recordEvent({ contextTags: [], label: "one", value: "1", kind: "prompt" });
    s.recordEvent({ contextTags: [], label: "two", value: "2", kind: "prompt" });
    s.recordEvent({ contextTags: [], label: "three", value: "3", kind: "prompt" });
    const recent = useSuggestionStore.getState().recentEvents(2);
    expect(recent.map((e) => e.label)).toEqual(["three", "two"]);
  });

  it("keeps the most-recent occurrence as a group's representative (fresh contextTags)", () => {
    const s = useSuggestionStore.getState();
    s.recordEvent({ contextTags: ["old"], label: "A", value: "a", kind: "prompt" });
    s.recordEvent({ contextTags: ["new"], label: "A", value: "a", kind: "prompt" });
    const top = useSuggestionStore.getState().topByContext([], 1);
    expect(top[0]?.contextTags).toEqual(["new"]);
  });
});
