import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeSuggestions, deriveContextTags } from "./engine";
import { useSuggestionStore } from "../../stores/suggestionStore";

const base = { agentId: "a1", aiEnabled: true, entitled: true };

beforeEach(() => useSuggestionStore.setState({ events: [] }));

describe("deriveContextTags", () => {
  it("tags a finished-but-unmerged state", () => {
    const tags = deriveContextTags("Done. Both changes committed (3a494cc). Nothing further to do.");
    expect(tags).toContain("committed");
  });
  it("does not tag a 7-letter English word as a commit hash", () => {
    expect(deriveContextTags("the wall was defaced overnight")).not.toContain("committed");
  });
});

describe("computeSuggestions", () => {
  it("returns heuristic buttons and skips Haiku when a prompt is present", async () => {
    const callHaiku = vi.fn();
    const set = await computeSuggestions({ ...base, scrollback: "Continue? (y/n) ", callHaiku });
    expect(set.buttons.map((b) => b.label)).toEqual(["Approve", "Deny"]);
    expect(callHaiku).not.toHaveBeenCalled();
  });

  it("calls Haiku for learned actions when no prompt and AI is on", async () => {
    const callHaiku = vi.fn().mockResolvedValue(
      JSON.stringify([{ label: "Rebase main, Issue PR, merge", value: "Rebase and PR and merge.", kind: "prompt" }]),
    );
    const set = await computeSuggestions({ ...base, scrollback: "Done. Committed abc123. Nothing further.", callHaiku });
    expect(callHaiku).toHaveBeenCalledOnce();
    expect(set.buttons[0]?.label).toContain("Rebase");
    expect(set.buttons[0]?.source).toBe("learned");
    expect(set.buttons.length).toBeLessThanOrEqual(3);
  });

  it("fails closed (no Haiku, no buttons) when AI disabled or unentitled", async () => {
    const callHaiku = vi.fn();
    const off = await computeSuggestions({ ...base, aiEnabled: false, scrollback: "Done. Committed abc.", callHaiku });
    const unent = await computeSuggestions({ ...base, entitled: false, scrollback: "Done. Committed abc.", callHaiku });
    expect(off.buttons).toEqual([]);
    expect(unent.buttons).toEqual([]);
    expect(callHaiku).not.toHaveBeenCalled();
  });

  it("ignores malformed Haiku output (fails closed to empty)", async () => {
    const callHaiku = vi.fn().mockResolvedValue("not json at all");
    const set = await computeSuggestions({ ...base, scrollback: "Done. Committed abc.", callHaiku });
    expect(set.buttons).toEqual([]);
  });

  it("caps learned buttons at 3", async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ label: `act${i}`, value: `v${i}`, kind: "prompt" }));
    const callHaiku = vi.fn().mockResolvedValue(JSON.stringify(many));
    const set = await computeSuggestions({ ...base, scrollback: "Done. Committed abc.", callHaiku });
    expect(set.buttons).toHaveLength(3);
  });

  it("parses a markdown-fenced JSON reply", async () => {
    const callHaiku = vi
      .fn()
      .mockResolvedValue("```json\n[{\"label\":\"Push\",\"value\":\"Push the branch.\"}]\n```");
    const set = await computeSuggestions({ ...base, scrollback: "Done. Committed abc.", callHaiku });
    expect(set.buttons[0]?.label).toBe("Push");
  });

  it("coerces an AI-supplied terminal kind to prompt (no raw keystrokes from Haiku)", async () => {
    const callHaiku = vi
      .fn()
      .mockResolvedValue(JSON.stringify([{ label: "Run tests", value: "rm -rf /\n", kind: "terminal" }]));
    const set = await computeSuggestions({ ...base, scrollback: "Done. Committed abc.", callHaiku });
    expect(set.buttons[0]?.kind).toBe("prompt");
  });

  it("truncates over-long label and value", async () => {
    const callHaiku = vi
      .fn()
      .mockResolvedValue(JSON.stringify([{ label: "L".repeat(100), value: "V".repeat(3000) }]));
    const set = await computeSuggestions({ ...base, scrollback: "Done. Committed abc.", callHaiku });
    expect(set.buttons[0]?.label.length).toBe(40);
    expect(set.buttons[0]?.value.length).toBe(2000);
  });
});
