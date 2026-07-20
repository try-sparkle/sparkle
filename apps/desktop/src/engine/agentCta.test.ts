import { describe, it, expect } from "vitest";
import { deriveCta } from "./agentCta";
import type { WorkflowState } from "../services/branchStatus";
import type { SuggestionButton } from "../services/suggestions/types";

const ws = (over: Partial<WorkflowState> = {}): WorkflowState => ({
  inLocalMain: false,
  inOriginMain: false,
  inParent: false,
  aheadOfBase: 0,
  prState: null,
  prNumber: null,
  prUrl: null,
  ...over,
});

const suggestion = (label: string): SuggestionButton => ({
  id: `s:${label}`,
  label,
  value: label,
  kind: "prompt",
  source: "learned",
});

describe("deriveCta", () => {
  it("building_unsaved has no CTA — nothing to land yet", () => {
    expect(deriveCta("building_unsaved", ws(), [])).toBeNull();
  });

  it("a planning-only stage has no CTA", () => {
    expect(deriveCta("planned", ws(), [])).toBeNull();
    expect(deriveCta("thought", ws(), [])).toBeNull();
  });

  it.each(["building_saved", "pushed", "pull_request"] as const)(
    "%s offers Land to Main",
    (stage) => {
      expect(deriveCta(stage, ws(), [])?.primary.label).toBe("Land to Main");
    },
  );

  it("an open PR still offers Land, not Merge PR — this repo lands directly", () => {
    const cta = deriveCta("pull_request", ws({ prState: "open" }), []);
    expect(cta?.primary.label).toBe("Land to Main");
  });

  // REGRESSION — founder screenshot 2, 2026-07-15: "Landed on main — local main now contains all
  // 9 roborev commits... Nothing is pushed yet." The app offered Close.
  it("merged_local WITH a remote offers Push to Origin Main", () => {
    const cta = deriveCta("merged_local", ws({ inLocalMain: true, hasRemote: true }), []);
    expect(cta?.primary.label).toBe("Push to Origin Main");
  });

  it("merged_local with NO remote is terminal and offers Close", () => {
    const cta = deriveCta("merged_local", ws({ inLocalMain: true, hasRemote: false }), []);
    expect(cta?.primary.label).toBe("Close Build Agent");
  });

  it("merged_local with UNKNOWN remote fails safe to Close", () => {
    // hasRemote absent (older Rust build, or a fast poll before any probing tick).
    const cta = deriveCta("merged_local", ws({ inLocalMain: true }), []);
    expect(cta?.primary.label).toBe("Close Build Agent");
  });

  it("a null/absent workflow state still yields a CTA rather than crashing", () => {
    expect(deriveCta("building_saved", null, [])?.primary.label).toBe("Land to Main");
    expect(deriveCta("merged_local", undefined, [])?.primary.label).toBe("Close Build Agent");
  });

  it.each(["merged", "shipped"] as const)("%s offers Close Build Agent", (stage) => {
    const cta = deriveCta(stage, ws({ inOriginMain: true, hasRemote: true }), []);
    expect(cta?.primary.label).toBe("Close Build Agent");
    expect(cta?.primary.kind).toBe("control");
  });

  it("Land/Push are prompts so the agent runs the project's contracts", () => {
    expect(deriveCta("building_saved", ws(), [])?.primary.kind).toBe("prompt");
    expect(
      deriveCta("merged_local", ws({ inLocalMain: true, hasRemote: true }), [])?.primary.kind,
    ).toBe("prompt");
  });

  it("computed suggestions become caret alternates", () => {
    const cta = deriveCta("building_saved", ws(), [suggestion("Cut a DMG")]);
    expect(cta?.alternates.map((b) => b.label)).toContain("Cut a DMG");
  });

  it("merged_local carries Close as its escape hatch alternate", () => {
    const cta = deriveCta("merged_local", ws({ inLocalMain: true, hasRemote: true }), []);
    expect(cta?.alternates.map((b) => b.label)).toContain("Close Build Agent");
  });

  it("no escape hatch is added when Close is already the primary", () => {
    const cta = deriveCta("merged_local", ws({ inLocalMain: true }), []);
    expect(cta?.primary.label).toBe("Close Build Agent");
    expect(cta?.alternates.filter((b) => b.id === cta.primary.id)).toHaveLength(0);
  });

  it("the primary is never duplicated in the alternates", () => {
    const cta = deriveCta("merged", ws({ inOriginMain: true, hasRemote: true }), []);
    expect(cta?.alternates.map((b) => b.id)).not.toContain(cta?.primary.id);
  });

  it("a computed suggestion colliding with the primary id is dropped", () => {
    const collide: SuggestionButton = { ...suggestion("x"), id: "cta:landToMain" };
    const cta = deriveCta("building_saved", ws(), [collide]);
    expect(cta?.alternates.filter((b) => b.id === "cta:landToMain")).toHaveLength(0);
  });

  it("caps the alternates so the caret menu stays glanceable", () => {
    const many = ["a", "b", "c", "d", "e", "f"].map(suggestion);
    const cta = deriveCta("building_saved", ws(), many);
    expect(cta?.alternates.length).toBeLessThanOrEqual(4);
  });

  it("the escape hatch survives the alternates cap", () => {
    // merged_local's Close is appended AFTER the cap, so a full computed set can't hide the only
    // way to close the agent.
    const many = ["a", "b", "c", "d", "e", "f"].map(suggestion);
    const cta = deriveCta("merged_local", ws({ inLocalMain: true, hasRemote: true }), many);
    expect(cta?.alternates.map((b) => b.label)).toContain("Close Build Agent");
  });
});
