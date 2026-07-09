import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeSuggestions, deriveContextTags, SuggestionOfflineError } from "./engine";
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
  it("returns heuristic buttons (top-ranked first) and skips Haiku when a prompt is present", async () => {
    // A y/n prompt heuristically yields Approve/Deny; MAX_BUTTONS=3 keeps both, Approve first.
    const callHaiku = vi.fn();
    const set = await computeSuggestions({ ...base, scrollback: "Continue? (y/n) ", callHaiku });
    expect(set.buttons.length).toBeLessThanOrEqual(3);
    expect(set.buttons[0]?.label).toBe("Approve");
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

  it("throws SuggestionOfflineError and skips Haiku when offline (no doomed network call)", async () => {
    const callHaiku = vi.fn();
    await expect(
      computeSuggestions({ ...base, online: false, scrollback: "Done. Committed abc.", callHaiku }),
    ).rejects.toBeInstanceOf(SuggestionOfflineError);
    expect(callHaiku).not.toHaveBeenCalled();
  });

  it("still returns local heuristics when offline (they need no network)", async () => {
    const callHaiku = vi.fn();
    const set = await computeSuggestions({ ...base, online: false, scrollback: "Continue? (y/n) ", callHaiku });
    expect(set.buttons.map((b) => b.label)).toEqual(["Approve", "Deny"]);
    expect(callHaiku).not.toHaveBeenCalled();
  });

  it("rejects on malformed Haiku output so the caller's retry budget applies", async () => {
    const callHaiku = vi.fn().mockResolvedValue("not json at all");
    await expect(
      computeSuggestions({ ...base, scrollback: "Done. Committed abc.", callHaiku }),
    ).rejects.toThrow();
  });

  it("rejects (does not resolve empty) when the Haiku call itself fails", async () => {
    const callHaiku = vi.fn().mockRejectedValue(new Error("api down"));
    await expect(
      computeSuggestions({ ...base, scrollback: "Done. Committed abc.", callHaiku }),
    ).rejects.toThrow("api down");
  });

  it("caps learned buttons at AT MOST 3, keeping the most-likely-first order", async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ label: `act${i}`, value: `v${i}`, kind: "prompt" }));
    const callHaiku = vi.fn().mockResolvedValue(JSON.stringify(many));
    const set = await computeSuggestions({ ...base, scrollback: "Done. Committed abc.", callHaiku });
    expect(set.buttons.length).toBeLessThanOrEqual(3);
    expect(set.buttons).toHaveLength(3);
    // Ranking is unchanged: index [0] is the top-ranked (most-likely-first) entry.
    expect(set.buttons.map((b) => b.label)).toEqual(["act0", "act1", "act2"]);
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
